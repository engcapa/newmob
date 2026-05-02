/**
 * Cross-window mirror for the SFTP UI.
 *
 * Each NewMob window — main app or detached SFTP window — runs its own
 * `transferStore` and own `sftpStore`. When the user opens an SFTP browser
 * in its own window we want both windows to stay in sync:
 *
 *   1. The transfer queue (uploads/downloads kicked off in either window)
 *   2. The terminal cwd hint that drives "follow OSC 7" — only the main
 *      window observes the terminal, so a detached SFTP window has to be
 *      told what `cwd` the user just `cd`-ed into.
 *
 * We use a single `BroadcastChannel` so messages stay scoped to same-origin
 * windows and never round-trip through the disk. Each broadcast is tagged
 * with a sender id and we ignore our own echoes to keep the loop
 * terminating.
 */
import { useTransferStore } from "../stores/transferStore";
import type { TransferItem } from "./sftp";

const CHANNEL = "newmob.sftp.sync";
const senderId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type ItemsMessage = {
  type: "items";
  from: string;
  items: TransferItem[];
};

type CwdMessage = {
  type: "cwd";
  from: string;
  sessionId: string;
  cwd: string | null;
};

type RequestSnapshotMessage = {
  type: "request-snapshot";
  from: string;
};

type SyncMessage = ItemsMessage | CwdMessage | RequestSnapshotMessage;

type CwdListener = (sessionId: string, cwd: string | null) => void;

let channel: BroadcastChannel | null = null;
let unsubscribeStore: (() => void) | null = null;
let lastBroadcast = "";
let suppressNextBroadcast = false;
const cwdListeners = new Set<CwdListener>();
const lastCwd = new Map<string, string | null>();

function snapshot(items: TransferItem[]): string {
  return items
    .map(
      (it) =>
        `${it.id}|${it.state}|${it.bytes}|${it.size}|${it.error ?? ""}|${it.finishedAt ?? 0}`,
    )
    .join(";");
}

function dispatch(msg: SyncMessage): void {
  if (!channel) return;
  try {
    channel.postMessage(msg);
  } catch {
    /* channel may have been closed */
  }
}

export function attachSftpSync(): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  if (channel) return detachSftpSync;

  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => {};
  }

  channel.onmessage = (event: MessageEvent<SyncMessage>) => {
    const msg = event.data;
    if (!msg || msg.from === senderId) return;
    if (msg.type === "items") {
      suppressNextBroadcast = true;
      useTransferStore.setState({ items: msg.items });
      return;
    }
    if (msg.type === "cwd") {
      lastCwd.set(msg.sessionId, msg.cwd);
      cwdListeners.forEach((fn) => {
        try {
          fn(msg.sessionId, msg.cwd);
        } catch (err) {
          console.warn("[sftp-sync] cwd listener threw:", err);
        }
      });
      return;
    }
    if (msg.type === "request-snapshot") {
      // A peer just woke up and wants our current state. Push items and
      // any cwd hints we've cached locally so it can populate immediately.
      dispatch({
        type: "items",
        from: senderId,
        items: useTransferStore.getState().items,
      });
      lastCwd.forEach((cwd, sessionId) => {
        dispatch({ type: "cwd", from: senderId, sessionId, cwd });
      });
      return;
    }
  };

  unsubscribeStore = useTransferStore.subscribe((state) => {
    if (suppressNextBroadcast) {
      suppressNextBroadcast = false;
      lastBroadcast = snapshot(state.items);
      return;
    }
    const sig = snapshot(state.items);
    if (sig === lastBroadcast) return;
    lastBroadcast = sig;
    dispatch({ type: "items", from: senderId, items: state.items });
  });

  // Ask peers for any state they already have (transfer rows + cwd hints)
  // so a freshly-opened detached window catches up without waiting for the
  // next user action.
  dispatch({ type: "request-snapshot", from: senderId });

  return detachSftpSync;
}

export function detachSftpSync(): void {
  unsubscribeStore?.();
  unsubscribeStore = null;
  try {
    channel?.close();
  } catch {
    /* noop */
  }
  channel = null;
}

/** Broadcast that the terminal driving `sessionId` just changed cwd. */
export function broadcastCwdHint(sessionId: string, cwd: string | null): void {
  if (lastCwd.get(sessionId) === cwd) return;
  lastCwd.set(sessionId, cwd);
  dispatch({ type: "cwd", from: senderId, sessionId, cwd });
}

/** Subscribe to cwd-hint updates broadcast by other windows. */
export function subscribeCwdHint(fn: CwdListener): () => void {
  cwdListeners.add(fn);
  return () => {
    cwdListeners.delete(fn);
  };
}

/** Most-recent cwd we've seen for `sessionId` (from any window). */
export function getLatestCwdHint(sessionId: string): string | null {
  return lastCwd.get(sessionId) ?? null;
}
