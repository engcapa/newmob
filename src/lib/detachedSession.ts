/**
 * Generic detach/reattach plumbing shared by every "detach to OS window"
 * tab kind (sftp, rdp, vnc, terminal, database). The original SFTP-only handoff
 * helpers in `components/filebrowser/SftpDetachedWindow.tsx` are now thin
 * wrappers around this module.
 *
 *   1. Main window writes a short-lived connection handoff to localStorage with
 *      `writeDetachedHandoff(kind, payload)`.
 *   2. Main window asks the backend (Tauri) — or the browser stub — to
 *      open a new window pointed at `index.html#<kind>=<id>`.
 *   3. The new window inspects its URL via `detectDetachedRoute()` to
 *      figure out which kind/id it is, then reads its handoff via
 *      `consumeDetachedHandoff(kind, id)`.
 *   4. The detached window can later request reattach by writing a
 *      *reattach* envelope and broadcasting on the shared
 *      `BroadcastChannel`. The main window reattaches the tab and the
 *      detached window calls `getCurrentWindow().close()`.
 *
 * Closing the detached window via the OS title-bar X is treated the same
 * as clicking Reattach — `attachDetachedCloseRequestedReattach` wires
 * the Tauri `close-requested` event up to the same path.
 *
 * We keep a 60s TTL on credential blobs so anything that fails midway
 * (popup blocker, OS prompt cancelled, app crashed) doesn't leave secrets
 * sitting in localStorage indefinitely.
 */

export type DetachedKind =
  | "sftp"
  | "rdp"
  | "vnc"
  | "terminal"
  | "database"
  | "lan-chat"
  | "notes"
  | "servers";

const STORAGE_PREFIX = "taomni.detached.";
const REATTACH_PREFIX = "taomni.reattach.";
export const HANDOFF_TTL_MS = 60_000;
const REATTACH_CHANNEL_NAME = "taomni.detach.sync";

// Legacy SFTP key; still consumed for back-compat with handoffs written by
// older builds before the generic prefix existed.
const LEGACY_SFTP_PREFIX = "taomni.sftp.detached.";

interface HandoffEnvelope<T> {
  payload: T;
  createdAt: number;
}

function handoffKey(kind: DetachedKind, id: string): string {
  return `${STORAGE_PREFIX}${kind}.${id}`;
}

function reattachKey(kind: DetachedKind, id: string): string {
  return `${REATTACH_PREFIX}${kind}.${id}`;
}

export function writeDetachedHandoff<T>(
  kind: DetachedKind,
  id: string,
  payload: T,
): void {
  try {
    const env: HandoffEnvelope<T> = {
      payload: sanitizeDetachedPayload(kind, payload),
      createdAt: Date.now(),
    };
    localStorage.setItem(handoffKey(kind, id), JSON.stringify(env));
    if (kind === "sftp") {
      // Mirror to the legacy key so older code paths still find it.
      localStorage.setItem(`${LEGACY_SFTP_PREFIX}${id}`, JSON.stringify(env));
    }
  } catch {
    /* quota / serialization — ignore */
  }
}

function sanitizeDetachedPayload<T>(kind: DetachedKind, payload: T): T {
  if (kind !== "vnc" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const safe = { ...(payload as Record<string, unknown>) };
  delete safe.password;
  if (typeof safe.credentialRef === "string" && !safe.credentialRef.startsWith("vault:")) {
    delete safe.credentialRef;
  }
  return safe as T;
}

export function consumeDetachedHandoff<T>(
  kind: DetachedKind,
  id: string,
): T | null {
  const keys =
    kind === "sftp"
      ? [handoffKey(kind, id), `${LEGACY_SFTP_PREFIX}${id}`]
      : [handoffKey(kind, id)];
  for (const key of keys) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    let parsed: HandoffEnvelope<T> | T;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        localStorage.removeItem(key);
      } catch {
        /* noop */
      }
      continue;
    }
    if ((parsed as HandoffEnvelope<T>).createdAt === undefined) {
      // Bare payload (very old builds).
      return parsed as T;
    }
    const env = parsed as HandoffEnvelope<T>;
    if (Date.now() - env.createdAt > HANDOFF_TTL_MS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* noop */
      }
      continue;
    }
    return env.payload;
  }
  return null;
}

export function clearDetachedHandoff(kind: DetachedKind, id: string): void {
  try {
    localStorage.removeItem(handoffKey(kind, id));
    if (kind === "sftp") {
      localStorage.removeItem(`${LEGACY_SFTP_PREFIX}${id}`);
    }
  } catch {
    /* noop */
  }
}

/** Sweep expired handoff blobs across every kind on app start. */
export function sweepExpiredHandoffs(): void {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (
        !key.startsWith(STORAGE_PREFIX) &&
        !key.startsWith(LEGACY_SFTP_PREFIX) &&
        !key.startsWith(REATTACH_PREFIX)
      ) {
        continue;
      }
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed?.createdAt && now - parsed.createdAt > HANDOFF_TTL_MS) {
          localStorage.removeItem(key);
        }
      } catch {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* noop */
  }
}

/**
 * URL the detached window should be launched at when running in
 * browser mode (where we have no Tauri command and just `window.open`).
 * Tauri native windows use the same scheme via `WebviewUrl::App`.
 */
export function detachedWindowUrl(kind: DetachedKind, id: string): string {
  const url = new URL(window.location.href);
  // Browsers honor `?` query strings reliably across `window.open` paths;
  // Tauri's `WebviewUrl::App` percent-encodes `?` so the native side uses
  // `#` (see `detectDetachedRoute`).
  url.searchParams.set(kind, id);
  url.hash = "";
  return url.toString();
}

/**
 * Inspect the current window's URL to determine whether it was opened as
 * a detached session window. Checks the URL fragment first (Tauri native
 * windows keep `#kind=id` intact) then falls back to the query string
 * (browser-mode `window.open`). Returns null on the main window.
 */
export function detectDetachedRoute():
  | { kind: DetachedKind; id: string }
  | null {
  if (typeof window === "undefined") return null;
  try {
    const hash = window.location.hash;
    if (hash.startsWith("#")) {
      const eq = hash.indexOf("=");
      if (eq > 1) {
        const key = hash.slice(1, eq);
        const value = hash.slice(eq + 1);
        if (isDetachedKind(key) && value) return { kind: key, id: value };
      }
    }
    const url = new URL(window.location.href);
    for (const kind of [
      "sftp",
      "rdp",
      "vnc",
      "terminal",
      "database",
      "lan-chat",
      "notes",
      "servers",
    ] as const) {
      const value = url.searchParams.get(kind);
      if (value) return { kind, id: value };
    }
  } catch {
    /* noop */
  }
  return null;
}

function isDetachedKind(value: string): value is DetachedKind {
  return (
    value === "sftp" ||
    value === "rdp" ||
    value === "vnc" ||
    value === "terminal" ||
    value === "database" ||
    value === "lan-chat" ||
    value === "notes" ||
    value === "servers"
  );
}

/* ── Reattach round-trip ─────────────────────────────────────────────── */

export interface ReattachMessage<T = unknown> {
  type: "reattach";
  kind: DetachedKind;
  id: string;
  payload: T;
  /** Sender id so we can ignore our own echoes. */
  from: string;
  /** Monotonic counter so duplicate broadcasts are easy to dedupe. */
  seq: number;
}

const senderId = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

let reattachChannel: BroadcastChannel | null = null;
let reattachSeq = 0;
const reattachListeners = new Set<(msg: ReattachMessage) => void>();
const seenReattach = new Map<string, number>();

function ensureChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (reattachChannel) return reattachChannel;
  try {
    reattachChannel = new BroadcastChannel(REATTACH_CHANNEL_NAME);
    reattachChannel.onmessage = (event: MessageEvent<ReattachMessage>) => {
      const msg = event.data;
      if (!msg || msg.type !== "reattach" || msg.from === senderId) return;
      const dedupeKey = `${msg.kind}.${msg.id}.${msg.seq}`;
      const lastSeq = seenReattach.get(`${msg.kind}.${msg.id}`) ?? -1;
      if (msg.seq <= lastSeq) return;
      seenReattach.set(`${msg.kind}.${msg.id}`, msg.seq);
      seenReattach.set(dedupeKey, msg.seq);
      reattachListeners.forEach((fn) => {
        try {
          fn(msg);
        } catch (err) {
          console.warn("[detached-session] reattach listener threw:", err);
        }
      });
    };
  } catch {
    return null;
  }
  return reattachChannel;
}

/**
 * Persist the reattach payload to localStorage and broadcast a reattach
 * message so the main window can pick it up. Both paths are used because
 * BroadcastChannel can't always fire synchronously from a `close-requested`
 * handler — the localStorage entry is a backstop for the receiver.
 */
export function broadcastReattach<T>(
  kind: DetachedKind,
  id: string,
  payload: T,
): void {
  try {
    const env: HandoffEnvelope<T> = { payload, createdAt: Date.now() };
    localStorage.setItem(reattachKey(kind, id), JSON.stringify(env));
  } catch {
    /* noop */
  }
  const channel = ensureChannel();
  reattachSeq += 1;
  const msg: ReattachMessage<T> = {
    type: "reattach",
    kind,
    id,
    payload,
    from: senderId,
    seq: reattachSeq,
  };
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel may be closing; localStorage backstop will pick this up */
  }
}

/** Subscribe the main window to incoming reattach requests. */
export function subscribeReattach(
  fn: (msg: ReattachMessage) => void,
): () => void {
  ensureChannel();
  reattachListeners.add(fn);

  const onStorage = (event: StorageEvent) => {
    if (!event.key || !event.key.startsWith(REATTACH_PREFIX) || !event.newValue) {
      return;
    }
    const key = event.key;
    const rest = key.slice(REATTACH_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) return;
    const kindStr = rest.slice(0, dot);
    const id = rest.slice(dot + 1);
    if (!isDetachedKind(kindStr)) return;

    try {
      const parsed = JSON.parse(event.newValue) as HandoffEnvelope<unknown>;
      if (parsed?.createdAt && Date.now() - parsed.createdAt > HANDOFF_TTL_MS) {
        return;
      }

      // Clean up the key so we don't process it again
      try {
        localStorage.removeItem(key);
      } catch {
        /* noop */
      }

      fn({
        type: "reattach",
        kind: kindStr,
        id,
        payload: parsed.payload,
        from: "storage",
        seq: 0,
      });
    } catch {
      /* ignore */
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    reattachListeners.delete(fn);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/**
 * Drain any reattach envelopes that landed in localStorage before the
 * subscriber attached (or while the channel was unreachable). Returns
 * the list of messages found, in insertion order.
 */
export function drainPendingReattach(): ReattachMessage[] {
  const out: ReattachMessage[] = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(REATTACH_PREFIX)) continue;
      const rest = key.slice(REATTACH_PREFIX.length);
      const dot = rest.indexOf(".");
      if (dot <= 0) {
        localStorage.removeItem(key);
        continue;
      }
      const kindStr = rest.slice(0, dot);
      const id = rest.slice(dot + 1);
      if (!isDetachedKind(kindStr)) {
        localStorage.removeItem(key);
        continue;
      }
      const raw = localStorage.getItem(key);
      localStorage.removeItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as HandoffEnvelope<unknown>;
        if (
          parsed?.createdAt &&
          Date.now() - parsed.createdAt > HANDOFF_TTL_MS
        ) {
          continue;
        }
        out.push({
          type: "reattach",
          kind: kindStr,
          id,
          payload: parsed.payload,
          from: "storage",
          seq: 0,
        });
      } catch {
        /* malformed — already removed */
      }
    }
  } catch {
    /* noop */
  }
  return out;
}

export function clearReattachHandoff(kind: DetachedKind, id: string): void {
  try {
    localStorage.removeItem(reattachKey(kind, id));
  } catch {
    /* noop */
  }
}
