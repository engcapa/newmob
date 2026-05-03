import { useEffect, useMemo, useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { useAppTheme } from "../../lib/appTheme";
import { subscribeCwdHint, getLatestCwdHint } from "../../lib/sftpSync";

interface DetachedSftpParams {
  /**
   * Session id used by the detached window for its OWN SFTP attach. We
   * deliberately make this distinct from the parent window's session id
   * (see `parentSessionId`) so the backend opens a fresh SFTP channel and
   * the popup never contends with the sidebar / standalone tab for the
   * same `Mutex<SftpSession>` lock.
   */
  sessionId: string;
  /**
   * Original session id in the parent window. Used only so the detached
   * window can subscribe to the same OSC 7 cwd-hint broadcasts that the
   * main window publishes for the source tab. The detached window does
   * NOT attach SFTP under this id.
   */
  parentSessionId?: string;
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
 * Read the credential handoff for `sessionId` without deleting it. We
 * previously deleted the entry on first read for defence-in-depth, but
 * that broke React StrictMode double-mount and any browser/Tauri runtime
 * that re-renders the detached window before its `beforeunload` fires:
 * the second read came back `null` and the window stayed blank forever.
 *
 * The TTL check + `clearDetachedHandoff` on `pagehide`/`beforeunload`
 * still bound how long the credentials can sit on disk.
 *
 * We use `localStorage` instead of `sessionStorage` because Tauri's
 * `WebviewWindow` opened for a detached SFTP view runs as a fresh
 * WebContents — its `sessionStorage` is empty even though it shares the
 * origin.
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
  let parsed: HandoffEnvelope | DetachedSftpParams;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed entry — drop it so it doesn't linger.
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
    return null;
  }
  // Backwards-compat: tolerate a bare params blob (older builds).
  if ((parsed as HandoffEnvelope).createdAt === undefined) {
    return parsed as DetachedSftpParams;
  }
  const env = parsed as HandoffEnvelope;
  if (Date.now() - env.createdAt > HANDOFF_TTL_MS) {
    // Expired — wipe it.
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
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
 * Returns the SFTP session id if the page was opened as a detached SFTP
 * window, or null otherwise.
 *
 * Checks the URL fragment first (`#sftp=...`) — this is what the Tauri
 * backend writes via WebviewUrl::App so the path component never gets
 * percent-encoded. Falls back to the query string (`?sftp=...`) for
 * browser-mode window.open() and older builds.
 */
export function detectDetachedSftpRoute(): string | null {
  if (typeof window === "undefined") return null;
  try {
    // Fragment: #sftp=<sessionId>  (Tauri native window path)
    const hash = window.location.hash;
    console.log("[detectDetachedSftpRoute] hash:", hash);
    if (hash.startsWith("#sftp=")) {
      const id = hash.slice("#sftp=".length);
      console.log("[detectDetachedSftpRoute] Found session id in hash:", id);
      if (id) return id;
    }
    // Query string: ?sftp=<sessionId>  (browser window.open path)
    const url = new URL(window.location.href);
    const queryId = url.searchParams.get("sftp");
    console.log("[detectDetachedSftpRoute] query sftp param:", queryId);
    console.log("[detectDetachedSftpRoute] full URL:", window.location.href);
    return queryId;
  } catch {
    return null;
  }
}

export function SftpDetachedWindow({ sessionId }: { sessionId: string }) {
  const { mode, resolvedTheme } = useAppTheme();
  const [params, setParams] = useState<DetachedSftpParams | null>(() =>
    consumeDetachedHandoff(sessionId),
  );
  // Flip to true after a grace period if no handoff has arrived. Lets us
  // replace the indefinite "waiting…" spinner with an actionable error so
  // the popup never *looks* blank to the user.
  const [handoffTimedOut, setHandoffTimedOut] = useState(false);
  // Latest cwd hint broadcast by the parent window (terminal OSC 7). Lets
  // a detached SFTP view follow the live shell `cd` even though it can't
  // see the terminal directly. We subscribe under the PARENT session id
  // because the main window broadcasts under that id; fall back to the
  // detached id for older builds that didn't carry a parentSessionId.
  const cwdSubscriptionId = params?.parentSessionId ?? sessionId;
  const [cwdHint, setCwdHint] = useState<string | null>(() =>
    getLatestCwdHint(cwdSubscriptionId),
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
    // Flag a timeout after ~5s so the user sees an actionable message
    // instead of an indefinite "waiting…" line.
    const timeoutId = window.setTimeout(() => setHandoffTimedOut(true), 5_000);
    return () => {
      window.removeEventListener("storage", handler);
      window.clearInterval(id);
      window.clearTimeout(timeoutId);
    };
  }, [sessionId, params]);

  // Subscribe to live cwd updates from the main window so the panel
  // follows OSC 7 even though we don't host a terminal here.
  useEffect(() => {
    return subscribeCwdHint((sid, cwd) => {
      if (sid === cwdSubscriptionId) setCwdHint(cwd);
    });
  }, [cwdSubscriptionId]);

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
    // Use literal colours here (not CSS vars) so that even if the theme
    // stylesheet hasn't loaded the popup is visibly populated rather than
    // appearing as a blank white page.
    return (
      <div
        className="w-screen h-screen flex items-center justify-center p-6"
        style={{ background: "#1e2128", color: "#e6e6e6" }}
      >
        <div className="max-w-md text-center text-sm leading-relaxed">
          {handoffTimedOut ? (
            <>
              <div className="text-base font-semibold mb-2">
                Couldn't load SFTP connection
              </div>
              <p style={{ color: "#a0a0a0" }}>
                The parent window didn't hand over the connection details for
                <span className="font-mono"> {sessionId} </span>
                within 5&nbsp;seconds. This usually means the popup was opened
                directly (without going through the main window) or the main
                window was closed.
              </p>
              <p className="mt-3" style={{ color: "#a0a0a0" }}>
                Close this tab and click the detach button on the SFTP panel
                in the main window again.
              </p>
              <button
                type="button"
                className="mt-4 px-3 py-1.5 text-xs rounded"
                style={{ background: "#3a3f4a", color: "#e6e6e6" }}
                onClick={() => window.close()}
              >
                Close window
              </button>
            </>
          ) : (
            <>
              <div className="text-base font-semibold mb-2">
                Loading SFTP session…
              </div>
              <p style={{ color: "#a0a0a0" }}>
                Waiting for connection details from the parent window.
              </p>
            </>
          )}
        </div>
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
