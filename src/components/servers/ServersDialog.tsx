import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  SERVER_ORDER,
  saveServerConfig,
  listenServerOutput,
  listenServerStatus,
  type ServerType,
} from "../../lib/servers";
import { useServersStore } from "../../stores/serversStore";
import { useT } from "../../lib/i18n";
import { confirmAppDialog } from "../../lib/appDialogs";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { isTauriRuntime } from "../../lib/runtime";
import { ensureVaultReady } from "../../lib/vaultGate";
import { ServerList } from "./ServerList";
import { ServerSettings } from "./ServerSettings";

function timestampLine(line: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `[${stamp}] ${line}`;
}

/**
 * Local servers manager — intended to run as a **standalone OS window** with
 * native title bar / borders (opened via `open_detached_window` kind
 * `"servers"`). The shell fills the webview; move/resize come from the OS.
 *
 * Subscribes to output + status events for every server type while mounted,
 * hydrates configs from the backend, and confirms discard on close when dirty.
 */
export function ServersDialog() {
  const t = useT();
  const appendLog = useServersStore((s) => s.appendLog);
  const clearDirty = useServersStore((s) => s.clearDirty);
  const loadAll = useServersStore((s) => s.loadAll);

  // Snapshot of the port each server was last saved with, so Apply can warn
  // when a running server's port changed (it won't take effect until restart).
  const appliedPorts = useRef<Partial<Record<ServerType, number>>>({});

  useEffect(() => {
    document.title = t("servers.dialogTitle");
  }, [t]);

  // Hydrate configs + live statuses when the window mounts.
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Subscribe to output + status events for every server type while open.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    for (const type of SERVER_ORDER) {
      void listenServerOutput(type, (line) => {
        useServersStore.getState().appendLog(type, line);
      }).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
      void listenServerStatus(type, (status) => {
        useServersStore.getState().setStatus(type, status);
      }).then((un) => {
        if (cancelled) un();
        else unlisteners.push(un);
      });
    }

    // Seed the applied-port snapshot from current configs.
    const configs = useServersStore.getState().configs;
    for (const type of SERVER_ORDER) {
      appliedPorts.current[type] = configs[type].port;
    }

    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, []);

  const closeWindow = useCallback(() => {
    void closeCurrentDetachedWindow().catch(() => {
      window.close();
    });
  }, []);

  const attemptClose = useCallback(async () => {
    if (useServersStore.getState().dirty) {
      const confirmed = await confirmAppDialog({
        message: t("servers.confirmDiscard"),
      });
      if (!confirmed) return;
    }
    clearDirty();
    closeWindow();
  }, [clearDirty, closeWindow, t]);

  // Escape closes (confirming when there are unsaved edits).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void attemptClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [attemptClose]);

  // OS title-bar close: same discard confirm as Cancel.
  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!useServersStore.getState().dirty) return;
        event.preventDefault();
        void (async () => {
          const confirmed = await confirmAppDialog({
            message: t("servers.confirmDiscard"),
          });
          if (!confirmed) return;
          clearDirty();
          closeWindow();
        })();
      })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch(() => {
        /* close hook unavailable in some stubs */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearDirty, closeWindow, t]);

  const handleApply = async () => {
    const { configs, runtimes } = useServersStore.getState();
    for (const type of SERVER_ORDER) {
      let cfg = configs[type];
      try {
        if (
          type === "rdp" &&
          !(await ensureVaultReady(t("servers.notes.rdpVaultReason")))
        ) {
          appendLog(type, timestampLine(t("servers.notes.rdpVaultCancelled")));
          continue;
        }
        cfg = await saveServerConfig(type, cfg);
        useServersStore.getState().setConfig(type, cfg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendLog(type, timestampLine(message));
        continue;
      }
      // Warn when a running server's port changed: the live process keeps the
      // old port until it is restarted.
      const prevPort = appliedPorts.current[type];
      if (
        runtimes[type]?.status === "running" &&
        prevPort !== undefined &&
        prevPort !== cfg.port
      ) {
        appendLog(type, timestampLine(t("servers.restartForPort")));
      }
      appliedPorts.current[type] = cfg.port;
    }
    clearDirty();
  };

  return (
    <div
      role="dialog"
      aria-labelledby="servers-dialog-title"
      data-testid="servers-dialog"
      className="h-screen min-h-0 w-screen flex flex-col overflow-hidden"
      style={{
        background: "var(--taomni-panel-bg)",
        color: "var(--taomni-text)",
      }}
    >
      {/* Visually quiet page header — OS window title carries the real name */}
      <div
        className="h-8 flex items-center px-3 shrink-0 border-b text-[12px] font-semibold"
        style={{
          background: "var(--taomni-quick-bg)",
          borderColor: "var(--taomni-divider)",
        }}
      >
        <span id="servers-dialog-title">{t("servers.dialogTitle")}</span>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-row">
        <ServerList />
        <ServerSettings />
      </div>

      {/* Footer */}
      <div
        className="h-9 flex items-center justify-end gap-2 px-3 border-t shrink-0"
        style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}
      >
        <button
          type="button"
          data-testid="servers-dialog-cancel"
          className="taomni-btn"
          onClick={() => void attemptClose()}
        >
          {t("servers.cancel")}
        </button>
        <button
          type="button"
          data-testid="servers-dialog-apply"
          className="taomni-btn"
          data-primary="true"
          onClick={() => void handleApply()}
        >
          {t("servers.apply")}
        </button>
      </div>
    </div>
  );
}
