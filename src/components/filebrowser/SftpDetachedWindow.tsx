import { useEffect, useMemo, useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { useAppTheme } from "../../lib/appTheme";
import { subscribeCwdHint, getLatestCwdHint } from "../../lib/sftpSync";

interface DetachedSftpParams {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  initialPath?: string;
  title?: string;
}

interface HandoffEnvelope {
  payload: DetachedSftpParams;
  /** Wall-clock time the handoff was written (ms). */
  createdAt: number;
}

const STORAGE_PREFIX = "newmob.sftp.detached.";
/**
 * Maximum age of a credential handoff before we refuse to consume it.
 * 60 s is comfortably long enough for any realistic
 * `window.open` / `WebviewWindowBuilder` round-trip but short enough that
 * a stranded entry (window blocked, user cancelled, app crashed) does not
 * leave SFTP credentials sitting in `localStorage` indefinitely.
 */
const HANDOFF_TTL_MS = 60_000;

/**
 * Read the credential handoff for `sessionId` and **delete it immediately**.
 * Entries older than `HANDOFF_TTL_MS` are treated as expired and discarded
 * to keep stale credentials from lingering on disk.
 *
 * We use `localStorage` instead of `sessionStorage` because Tauri's
 * `WebviewWindow` opened for a detached SFTP view runs as a fresh
 * WebContents — its `sessionStorage` is empty even though it shares the
 * origin. The compensating control is the one-shot delete + TTL below.
 */
export function consumeDetachedHandoff(sessionId: string): DetachedSftpParams | null {
  const key = STORAGE_PREFIX + sessionId;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Always remove first so the secret is on disk for the shortest possible
  // window even if parsing throws.
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
  let parsed: HandoffEnvelope | DetachedSftpParams;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Backwards-compat: tolerate a bare params blob (older builds).
  if ((parsed as HandoffEnvelope).createdAt === undefined) {
    return parsed as DetachedSftpParams;
  }
  const env = parsed as HandoffEnvelope;
  if (Date.now() - env.createdAt > HANDOFF_TTL_MS) {
    return null;
  }
  return env.payload;
}

export function writeDetachedHandoff(params: DetachedSftpParams): void {
  try {
    const env: HandoffEnvelope = { payload: params, createdAt: Date.now() };
    localStorage.setItem(STORAGE_PREFIX + params.sessionId, JSON.stringify(env));
  } catch {
    /* noop */
  }
}

export function clearDetachedHandoff(sessionId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + sessionId);
  } catch {
    /* noop */
  }
}

/**
 * Sweep any expired handoff entries on app start.
 *
 * If a window-open attempt failed midway (browser blocked the popup, user
 * dismissed an OS prompt, etc.) the credential blob would otherwise stay
 * in `localStorage` forever. This belt-and-braces pass keeps that from
 * happening across restarts.
 */
export function sweepExpiredHandoffs(): void {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.createdAt && now - parsed.createdAt > HANDOFF_TTL_MS) {
          localStorage.removeItem(key);
        }
      } catch {
        // Malformed entry — drop it so it doesn't stay forever.
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* noop */
  }
}

export function detachedWindowUrl(sessionId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("sftp", sessionId);
  url.hash = "";
  return url.toString();
}

/**
 * Returns the SFTP session id requested via `?sftp=...` if the page was
 * opened as a detached SFTP window, or null otherwise.
 */
export function detectDetachedSftpRoute(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("sftp");
  } catch {
    return null;
  }
}

export function SftpDetachedWindow({ sessionId }: { sessionId: string }) {
  const { mode, resolvedTheme } = useAppTheme();
  const [params, setParams] = useState<DetachedSftpParams | null>(() =>
    consumeDetachedHandoff(sessionId),
  );
  // Latest cwd hint broadcast by the parent window (terminal OSC 7). Lets
  // a detached SFTP view follow the live shell `cd` even though it can't
  // see the terminal directly.
  const [cwdHint, setCwdHint] = useState<string | null>(() =>
    getLatestCwdHint(sessionId),
  );

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  useEffect(() => {
    if (params) return;
    const handler = (event: StorageEvent) => {
      if (event.key === STORAGE_PREFIX + sessionId && event.newValue) {
        // Re-consume so we delete the entry and apply TTL. Don't trust the
        // raw `event.newValue` directly.
        const next = consumeDetachedHandoff(sessionId);
        if (next) setParams(next);
      }
    };
    window.addEventListener("storage", handler);
    // Poll as a fallback for runtimes where the storage event doesn't fire
    // reliably between webviews (e.g. some Tauri builds).
    const id = window.setInterval(() => {
      const next = consumeDetachedHandoff(sessionId);
      if (next) {
        setParams(next);
        window.clearInterval(id);
      }
    }, 250);
    return () => {
      window.removeEventListener("storage", handler);
      window.clearInterval(id);
    };
  }, [sessionId, params]);

  // Subscribe to live cwd updates from the main window so the panel
  // follows OSC 7 even though we don't host a terminal here.
  useEffect(() => {
    return subscribeCwdHint((sid, cwd) => {
      if (sid === sessionId) setCwdHint(cwd);
    });
  }, [sessionId]);

  // Belt-and-braces: if the window is closed before we ever consumed the
  // handoff (e.g. user cancelled mid-load), wipe it from `localStorage`
  // so the secret doesn't sit on disk waiting for a future read.
  useEffect(() => {
    const onUnload = () => {
      clearDetachedHandoff(sessionId);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [sessionId]);

  const title = useMemo(
    () => `${params?.title ?? `SFTP ${sessionId}`}`,
    [params?.title, sessionId],
  );

  useEffect(() => {
    document.title = `${title} • newmob`;
  }, [title]);

  if (!params) {
    return (
      <div
        className="w-screen h-screen flex items-center justify-center text-sm"
        style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
      >
        Waiting for connection details from the parent window…
      </div>
    );
  }

  return (
    <div
      className="w-screen h-screen flex flex-col"
      style={{ background: "var(--moba-chrome-bg)", color: "var(--moba-text)" }}
    >
      <div
        className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
      >
        <span className="truncate">{title}</span>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser
          sessionId={params.sessionId}
          host={params.host}
          port={params.port}
          username={params.username}
          authMethod={params.authMethod}
          authData={params.authData}
          initialPath={params.initialPath}
          cwdHint={cwdHint}
          detachable={false}
        />
      </div>
    </div>
  );
}
