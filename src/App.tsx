import { useEffect, type ReactNode } from "react";
import { MainLayout } from "./layouts/MainLayout";
import {
  SftpDetachedWindow,
  detectDetachedSftpRoute,
} from "./components/filebrowser/SftpDetachedWindow";
import DetachedSessionWindow from "./components/detached/DetachedSessionWindow";
import LanChatDetachedWindow from "./components/detached/LanChatDetachedWindow";
import { NotesDetachedWindow } from "./components/notes/NotesDetachedWindow";
import { ServersDialog } from "./components/servers/ServersDialog";
import { detectDetachedRoute } from "./lib/detachedSession";
import { useAppTheme } from "./lib/appTheme";
import { applyCodeViewProfile, loadCodeViewProfile } from "./lib/codeViewProfile";
import { attachSftpSync } from "./lib/sftpSync";
import { sweepExpiredHandoffs } from "./components/filebrowser/SftpDetachedWindow";
import { dispatchNativeFileDrop, isOsFileDrag } from "./lib/osFileDrop";
import { isTauriRuntime, getAppPlatform } from "./lib/runtime";
import { subscribeUiAppearanceStorage, useAppStore } from "./stores/appStore";
import { AppDialogProvider } from "./lib/appDialogs";
import { VaultGateProvider } from "./lib/vaultGate";
import { StartupVaultUnlockGate } from "./components/vault/StartupVaultUnlockGate";
import { DEFAULT_TERMINAL_PROFILE } from "./lib/terminalProfile";

function App() {
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
    root.dataset.appPlatform = getAppPlatform();
  }, [mode, resolvedTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--taomni-ui-font-family", uiFontFamily);
    root.style.setProperty("--taomni-ui-font-size", `${uiFontSize}px`);
  }, [uiFontFamily, uiFontSize]);

  useEffect(() => subscribeUiAppearanceStorage(), []);

  useEffect(() => {
    applyCodeViewProfile(loadCodeViewProfile(), DEFAULT_TERMINAL_PROFILE, {
      resolvedAppTheme: resolvedTheme,
    });
  }, [resolvedTheme]);

  // In production builds (the shipped binary, not `pnpm dev` / `tauri dev`),
  // suppress the WebView's native right-click menu. On WebView2/WKWebView that
  // menu exposes "Reload", which reloads the whole webview and tears down every
  // live terminal / SFTP / AI session — there is no real navigation in this SPA,
  // so a reload is always destructive. Editable fields keep their native
  // Cut/Copy/Paste menu (which never contains Reload), and the app's own custom
  // context menus call preventDefault themselves, so capture-phase here leaves
  // them intact (preventDefault does not stop propagation to React handlers).
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const suppressNativeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressNativeMenu, { capture: true });
    return () => window.removeEventListener("contextmenu", suppressNativeMenu, { capture: true });
  }, []);

  // Production builds: also block the WebView's reload shortcuts (F5 and
  // Ctrl/Cmd+R, including their Shift hard-reload variants). Like the native
  // Reload menu item, these reload the whole webview and tear down every live
  // session. We only preventDefault (never stopPropagation), so components that
  // legitimately use these keys still receive them: F5 still runs a query in
  // the SQL editor, Ctrl+R still reaches the terminal (bash reverse-search) and
  // RDP/VNC viewers forward the keys to the remote.
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const blockReloadKeys = (event: KeyboardEvent) => {
      const isReload =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "r");
      if (isReload) event.preventDefault();
    };
    window.addEventListener("keydown", blockReloadKeys, { capture: true });
    return () => window.removeEventListener("keydown", blockReloadKeys, { capture: true });
  }, []);

  // Mirror the transfer queue across same-origin windows so a user can see
  // the same uploads/downloads from both the main app and a detached SFTP
  // window. The cleanup tears the channel down on hot-reload too.
  useEffect(() => attachSftpSync(), []);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!isOsFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    window.addEventListener("dragover", preventFileNavigation, { capture: true });
    window.addEventListener("drop", preventFileNavigation, { capture: true });
    return () => {
      window.removeEventListener("dragover", preventFileNavigation, { capture: true });
      window.removeEventListener("drop", preventFileNavigation, { capture: true });
    };
  }, []);
  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/webview")
      .then(async ({ getCurrentWebview }) => {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type !== "drop" || payload.paths.length === 0) return;

          const scale = window.devicePixelRatio || 1;
          dispatchNativeFileDrop({
            paths: payload.paths,
            clientX: payload.position.x / scale,
            clientY: payload.position.y / scale,
          });
        });
        if (disposed) unlisten?.();
      })
      .catch((err) => {
        console.warn("[drag-drop] native file drop listener unavailable", err);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  // Drop any stale credential handoffs left over from a previous run
  // (e.g. window.open denied, app crashed mid-launch). Defence-in-depth
  // for the localStorage-based handoff used by detached SFTP windows.
  useEffect(() => {
    sweepExpiredHandoffs();
  }, []);

  let content: ReactNode;
  const detachedSftpId = detectDetachedSftpRoute();
  if (detachedSftpId) {
    content = <SftpDetachedWindow sessionId={detachedSftpId} />;
  } else {
    const detachedRoute = detectDetachedRoute();
    if (detachedRoute?.kind === "lan-chat") {
      content = <LanChatDetachedWindow id={detachedRoute.id} />;
    } else if (detachedRoute?.kind === "notes") {
      content = <NotesDetachedWindow />;
    } else if (detachedRoute?.kind === "servers") {
      content = <ServersDialog />;
    } else {
      content =
        detachedRoute && detachedRoute.kind !== "sftp"
          ? <DetachedSessionWindow kind={detachedRoute.kind} id={detachedRoute.id} />
          : <MainLayout />;
    }
  }

  return (
    <AppDialogProvider>
      <VaultGateProvider>
        <StartupVaultUnlockGate>{content}</StartupVaultUnlockGate>
      </VaultGateProvider>
    </AppDialogProvider>
  );
}

export default App;
