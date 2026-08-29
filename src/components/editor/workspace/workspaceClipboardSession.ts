import { createContext, useContext } from "react";
import type { ClipboardSourceEol } from "./workspaceEditorCommands";
import { isTauriRuntime } from "../../../lib/runtime";
import {
  probeClipboardCapabilities,
  readTextResult,
  writeText,
  type ClipboardTextReadResult,
} from "../../../lib/clipboard";

/**
 * Workspace-scoped clipboard session (§8.17.6 N9.3/N14.4, upgraded §8.18.4 P0-C3).
 *
 * One single-slot session per workspace instance: copy/cut in ANY split view
 * writes it and paste in ANY split view reads it, so rectangular/multi-caret
 * payloads survive crossing editor leaves. The store is refcounted — every
 * editor host acquires a handle on mount and releases on unmount; when the
 * count reaches zero the payload is cleared immediately so closed workspaces
 * never leak clipboard state.
 */
export interface EditorClipboardSession {
  sessionId: string;
  /** View that produced the payload (informational; never used for routing). */
  sourceViewId: string | null;
  segments: string[] | null;
  rectangular: boolean;
  plainText: string;
  sourceEol: ClipboardSourceEol;
  createdAt: number;
  /**
   * True when the system clipboard write/read failed but the workspace
   * session still holds the full payload — surfaces stay "unavailable"
   * instead of silently degrading to plain full text.
   */
  systemClipboardUnavailable?: boolean;
  /**
   * §8.19.5: producers mark secret-like payloads (vault material, masked
   * fields); sensitive payloads fill the live slot but NEVER enter history.
   */
  sensitive?: boolean;
}

/** Why a written payload did not enter the history ring (§8.19.5). */
export type ClipboardHistoryExclusion =
  | "recorded"
  | "history-disabled"
  | "oversized-item"
  | "sensitive";

/** Why the session/history was cleared (typed for diagnostics). */
export type ClipboardClearReason = "workspace-close" | "user" | "privacy-policy";

let sessionSequence = 0;

function nextSessionId(): string {
  sessionSequence += 1;
  return `clip-${Date.now().toString(36)}-${sessionSequence}`;
}

// ---------------------------------------------------------------------------
// C3b clipboard history ring (session-only, never persisted)
// ---------------------------------------------------------------------------

export const CLIPBOARD_HISTORY_MAX_ITEMS = 50;
export const CLIPBOARD_HISTORY_MAX_ITEM_BYTES = 256 * 1024;
export const CLIPBOARD_HISTORY_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Paste plan produced before any dispatch (§8.18.4): selections, segments and
 * target facts are frozen so the single ChangeSet dispatch is deterministic
 * and one undo restores everything.
 */
export interface PastePlan {
  /** One entry per caret; `null` falls back to whole-text insert. */
  readonly perCaret: readonly (string | null)[];
  readonly rectangular: boolean;
  readonly sourceEol: ClipboardSourceEol;
  /** True when segments could not be mapped 1:1 and the documented fallback applies. */
  readonly degraded: false | "fewer-segments-cycled" | "extra-segments-dropped" | "whole-block";
}

/**
 * Documented segment/caret mapping (§8.18.4 paste plan):
 * - N segments × N carets map 1:1.
 * - Fewer segments than carets cycle deterministically (never implicit loss).
 * - More segments than carets: extra segments are DROPPED, but flagged
 *   (`extra-segments-dropped`) instead of silently ignored.
 * - No segments: the plain text inserts whole at every caret.
 */
export function planPaste(input: {
  segments: readonly string[] | null;
  plainText: string;
  caretCount: number;
  rectangular: boolean;
  sourceEol: ClipboardSourceEol;
}): PastePlan {
  const { segments, caretCount, rectangular, sourceEol } = input;
  void input.plainText;
  if (!segments || segments.length === 0 || caretCount <= 0) {
    return { perCaret: Array.from({ length: Math.max(caretCount, 0) }, () => null), rectangular, sourceEol, degraded: caretCount > 1 ? "whole-block" : false };
  }
  if (segments.length === caretCount) {
    return { perCaret: [...segments], rectangular, sourceEol, degraded: false };
  }
  if (segments.length < caretCount) {
    return {
      perCaret: Array.from({ length: caretCount }, (_, index) => segments[index % segments.length]),
      rectangular,
      sourceEol,
      degraded: "fewer-segments-cycled",
    };
  }
  return {
    perCaret: Array.from({ length: caretCount }, (_, index) => segments[index]),
    rectangular,
    sourceEol,
    degraded: "extra-segments-dropped",
  };
}

interface HistoryEntry {
  session: EditorClipboardSession;
  bytes: number;
}

export function detectSensitiveClipboardText(text: string): boolean {
  if (!text || text.length < 8) return false;
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i.test(text)) return true;
  if (/AKIA[0-9A-Z]{16}/.test(text)) return true;
  if (/(?:api[_-]?key|secret[_-]?key|password|token)\s*[:=]\s*['"][^\n'"]{8,}['"]/i.test(text)) return true;
  return false;
}

export class WorkspaceClipboardStore {
  private session: EditorClipboardSession | null = null;
  private history: HistoryEntry[] = [];
  private historyEnabled = true;
  private historyTotalBytes = 0;
  private historyMaxItems = CLIPBOARD_HISTORY_MAX_ITEMS;
  private historyMaxTotalBytes = CLIPBOARD_HISTORY_MAX_TOTAL_BYTES;
  private lastHistoryExclusion: ClipboardHistoryExclusion = "recorded";

  write(input: {
    sourceViewId: string | null;
    plainText: string;
    segments?: string[];
    rectangular: boolean;
    sourceEol: ClipboardSourceEol;
    systemClipboardUnavailable?: boolean;
    /** §8.19.5: secret-like payloads fill the slot but never the ring. */
    sensitive?: boolean;
    /** Oversized/binary payloads skip the C3b ring but still fill the slot. */
    historyEligible?: boolean;
  }): EditorClipboardSession {
    const isSensitive = Boolean(input.sensitive) || detectSensitiveClipboardText(input.plainText);
    const session: EditorClipboardSession = {
      sessionId: nextSessionId(),
      sourceViewId: input.sourceViewId,
      segments: input.segments ? [...input.segments] : null,
      rectangular: input.rectangular,
      plainText: input.plainText,
      sourceEol: input.sourceEol,
      createdAt: Date.now(),
      ...(input.systemClipboardUnavailable ? { systemClipboardUnavailable: true } : {}),
      ...(isSensitive ? { sensitive: true } : {}),
    };
    this.session = session;
    if (isSensitive) {
      this.lastHistoryExclusion = "sensitive";
    } else {
      this.recordHistory(session, input.historyEligible !== false);
    }
    return session;
  }

  read(): EditorClipboardSession | null {
    return this.session;
  }

  clear(reason: ClipboardClearReason = "workspace-close"): void {
    void reason;
    this.session = null;
    this.history = [];
    this.historyTotalBytes = 0;
  }

  // -- C3b history ----------------------------------------------------------

  setHistoryEnabled(enabled: boolean): void {
    this.historyEnabled = enabled;
    if (!enabled) {
      this.history = [];
      this.historyTotalBytes = 0;
    }
  }

  isHistoryEnabled(): boolean {
    return this.historyEnabled;
  }

  /** §8.19.5 Settings: item cap clamped to 1–50, total bytes user-settable. */
  setHistoryLimits(maxItems: number, maxTotalBytes: number): void {
    this.historyMaxItems = Math.min(50, Math.max(1, Math.floor(maxItems)));
    this.historyMaxTotalBytes = Math.max(1024, Math.floor(maxTotalBytes));
    this.evictOverflow();
  }

  historyLimits(): { maxItems: number; maxTotalBytes: number } {
    return { maxItems: this.historyMaxItems, maxTotalBytes: this.historyMaxTotalBytes };
  }

  /** Outcome of the most recent write's history admission (non-blocking). */
  historyExclusion(): ClipboardHistoryExclusion {
    return this.lastHistoryExclusion;
  }

  /** Remove ONE entry (Delete key in the popup); false when index invalid. */
  removeHistoryEntry(index: number): boolean {
    const entry = this.history[index];
    if (!entry) return false;
    this.history.splice(index, 1);
    this.historyTotalBytes -= entry.bytes;
    return true;
  }

  historyEntries(): readonly EditorClipboardSession[] {
    return this.history.map((entry) => entry.session);
  }

  pasteFromHistory(index: number): EditorClipboardSession | null {
    // Pasting from history promotes the entry back to the live slot so the
    // regular paste path (and its plan) can be reused unchanged.
    const entry = this.history[index];
    if (!entry) return null;
    this.session = entry.session;
    return entry.session;
  }

  clearHistory(): void {
    this.history = [];
    this.historyTotalBytes = 0;
  }

  private recordHistory(session: EditorClipboardSession, eligible: boolean): void {
    if (!this.historyEnabled || !eligible) {
      this.lastHistoryExclusion = "history-disabled";
      return;
    }
    // UTF-16 length is the closest WebView proxy for the byte budget; the
    // conservative estimate keeps quota math from undercounting.
    const bytes = session.plainText.length * 2 + (session.segments?.reduce((sum, segment) => sum + segment.length * 2, 0) ?? 0);
    if (bytes > CLIPBOARD_HISTORY_MAX_ITEM_BYTES) {
      this.lastHistoryExclusion = "oversized-item";
      return;
    }
    this.lastHistoryExclusion = "recorded";
    const existing = this.history.findIndex((entry) => entry.session.plainText === session.plainText);
    if (existing >= 0) {
      const [moved] = this.history.splice(existing, 1);
      this.historyTotalBytes -= moved.bytes;
    }
    this.history.unshift({ session, bytes });
    this.historyTotalBytes += bytes;
    this.evictOverflow();
  }

  private evictOverflow(): void {
    while (
      this.history.length > 0
      && (this.history.length > this.historyMaxItems
        || this.historyTotalBytes > this.historyMaxTotalBytes)
    ) {
      const dropped = this.history.pop();
      if (dropped) this.historyTotalBytes -= dropped.bytes;
    }
  }
}

export interface ClipboardConsumerLease {
  (): "detached" | "already-detached";
  readonly token: string;
  readonly consumerId: string;
  readonly kind: string;
  detach(): "detached" | "already-detached";
}

export type ClipboardPermissionState = "unknown" | "granted" | "denied";

export interface ClipboardPermissionAdapter {
  queryPermission(): Promise<ClipboardPermissionState>;
  subscribe?(listener: (permission: ClipboardPermissionState) => void): () => void;
}

export interface GuardedClipboardIO {
  writeText?: (text: string) => Promise<void>;
  readTextResult?: () => Promise<ClipboardTextReadResult>;
}

export type GuardedSystemWriteResult =
  | { outcome: "success"; systemEffect: 1 }
  | { outcome: "denied"; systemEffect: 0 }
  | { outcome: "stale-generation"; baseGeneration: number; currentGeneration: number; systemEffect: 0 }
  | { outcome: "unavailable" | "error"; error?: string; systemEffect: 0 };

export type GuardedSystemReadResult =
  | { outcome: "success"; text: string; systemEffect: 1 }
  | { outcome: "denied"; systemEffect: 0; fallbackSession: EditorClipboardSession | null }
  | { outcome: "stale-generation"; baseGeneration: number; currentGeneration: number; systemEffect: 0; fallbackSession: EditorClipboardSession | null }
  | { outcome: "unavailable" | "error"; error?: string; systemEffect: 0; fallbackSession: EditorClipboardSession | null };

export function createWebClipboardPermissionAdapter(): ClipboardPermissionAdapter {
  return {
    async queryPermission(): Promise<ClipboardPermissionState> {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) {
        return "unknown";
      }
      try {
        const status = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
        if (status.state === "granted") return "granted";
        if (status.state === "denied") return "denied";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
    subscribe(listener: (permission: ClipboardPermissionState) => void): () => void {
      if (typeof navigator === "undefined" || !navigator.permissions?.query) {
        return () => {};
      }
      let active = true;
      let cleanup: (() => void) | null = null;
      navigator.permissions
        .query({ name: "clipboard-read" as PermissionName })
        .then((status) => {
          if (!active) return;
          const handler = () => {
            if (status.state === "granted") listener("granted");
            else if (status.state === "denied") listener("denied");
            else listener("unknown");
          };
          status.addEventListener("change", handler);
          cleanup = () => status.removeEventListener("change", handler);
        })
        .catch(() => {});
      return () => {
        active = false;
        cleanup?.();
      };
    },
  };
}

export function createNativeClipboardPermissionAdapter(): ClipboardPermissionAdapter {
  return {
    async queryPermission(): Promise<ClipboardPermissionState> {
      if (!isTauriRuntime()) return "unknown";
      try {
        const caps = await probeClipboardCapabilities();
        if (caps) return "granted";
        return "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}

export function createDefaultClipboardPermissionAdapter(): ClipboardPermissionAdapter {
  if (isTauriRuntime()) {
    return createNativeClipboardPermissionAdapter();
  }
  return createWebClipboardPermissionAdapter();
}

export interface WorkspaceClipboardSnapshotV3 {
  readonly payloadRevision: number;
  readonly historyRevision: number;
  readonly policyRevision: number;
  readonly permissionGeneration: number;
  readonly lifecycleRevision: number;
  readonly permission: ClipboardPermissionState;
  readonly consumers: readonly { token: string; id: string; kind: string }[];
  /** Backwards-compatibility alias for payloadRevision */
  readonly revision: number;
  readonly history: readonly EditorClipboardSession[];
  readonly exclusion: ClipboardHistoryExclusion;
  readonly isHistoryEnabled: boolean;
  readonly limits: { maxItems: number; maxTotalBytes: number };
  readonly consumerCount: number;
}

export type WorkspaceClipboardSnapshot = WorkspaceClipboardSnapshotV3;

export interface WorkspaceClipboardHandle {
  readonly workspaceId: string;
  attachConsumer(consumerId?: string, kind?: string): ClipboardConsumerLease;
  getSnapshot(): WorkspaceClipboardSnapshotV3;
  subscribe(listener: (snapshot: WorkspaceClipboardSnapshotV3) => void): () => void;
  write(input: Parameters<WorkspaceClipboardStore["write"]>[0]): EditorClipboardSession;
  read(): EditorClipboardSession | null;
  clear(reason?: ClipboardClearReason): void;
  release(): void;
  historyEntries(): readonly EditorClipboardSession[];
  pasteFromHistory(index: number): EditorClipboardSession | null;
  removeHistoryEntry(index: number): boolean;
  clearHistory(): void;
  setHistoryEnabled(enabled: boolean): void;
  isHistoryEnabled(): boolean;
  setHistoryLimits(maxItems: number, maxTotalBytes: number): void;
  historyLimits(): { maxItems: number; maxTotalBytes: number };
  historyExclusion(): ClipboardHistoryExclusion;
  setPermission(permission: ClipboardPermissionState): void;
  permission(): ClipboardPermissionState;
  attachPermissionAdapter(adapter: ClipboardPermissionAdapter): () => void;
  syncPermission(adapter?: ClipboardPermissionAdapter): Promise<ClipboardPermissionState>;
  writeSystemClipboard(text: string, io?: GuardedClipboardIO): Promise<GuardedSystemWriteResult>;
  readSystemClipboard(io?: GuardedClipboardIO): Promise<GuardedSystemReadResult>;
}

export const WorkspaceClipboardSessionContext = createContext<WorkspaceClipboardHandle | null>(null);

export function useWorkspaceClipboardSession(): WorkspaceClipboardHandle | null {
  return useContext(WorkspaceClipboardSessionContext);
}

interface WorkspaceSlotState {
  store: WorkspaceClipboardStore;
  payloadRevision: number;
  historyRevision: number;
  policyRevision: number;
  permissionGeneration: number;
  lifecycleRevision: number;
  permission: "unknown" | "granted" | "denied";
  consumers: Map<string, { token: string; id: string; kind: string }>;
  listeners: Set<(snapshot: WorkspaceClipboardSnapshotV3) => void>;
  rootAcquisitions: number;
  leaseSeq: number;
  cachedSnapshot: WorkspaceClipboardSnapshotV3 | null;
  cachedRevision: string;
}

const slotStatesByWorkspace = new Map<string, WorkspaceSlotState>();

function getOrCreateSlot(workspaceInstanceId: string): WorkspaceSlotState {
  let slot = slotStatesByWorkspace.get(workspaceInstanceId);
  if (!slot) {
    slot = {
      store: new WorkspaceClipboardStore(),
      payloadRevision: 0,
      historyRevision: 0,
      policyRevision: 0,
      permissionGeneration: 1,
      lifecycleRevision: 0,
      permission: "unknown",
      consumers: new Map(),
      listeners: new Set(),
      rootAcquisitions: 0,
      leaseSeq: 0,
      cachedSnapshot: null,
      cachedRevision: "",
    };
    slotStatesByWorkspace.set(workspaceInstanceId, slot);
  }
  return slot;
}

/**
 * Acquire one handle for an editor host instance. Refcounted per workspace
 * instance: the last `release()` clears and deletes the slot immediately, so
 * closing a workspace cannot leak its clipboard payload (§8.18.4/§8.27.2 lifecycle).
 */
export function acquireClipboardStore(
  workspaceInstanceId: string,
  options?: { permissionAdapter?: ClipboardPermissionAdapter },
): WorkspaceClipboardHandle {
  const slot = getOrCreateSlot(workspaceInstanceId);
  slot.rootAcquisitions += 1;
  let handleReleased = false;

  const getSnapshot = (): WorkspaceClipboardSnapshotV3 => {
    const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
    const combinedRevision = `${current.payloadRevision}:${current.historyRevision}:${current.policyRevision}:${current.permissionGeneration}:${current.lifecycleRevision}:${current.consumers.size}`;
    if (!current.cachedSnapshot || current.cachedRevision !== combinedRevision) {
      current.cachedSnapshot = buildWorkspaceClipboardSnapshot(current);
      current.cachedRevision = combinedRevision;
    }
    return current.cachedSnapshot;
  };

  const notify = () => {
    const current = slotStatesByWorkspace.get(workspaceInstanceId);
    if (!current || current.listeners.size === 0) return;
    const snap = getSnapshot();
    for (const listener of current.listeners) {
      try {
        listener(snap);
      } catch {
        // ignore subscriber errors (§8.27.2 subscriber throw isolation)
      }
    }
  };

  const handle: WorkspaceClipboardHandle = {
    workspaceId: workspaceInstanceId,
    attachConsumer(consumerId?: string, kind: string = "editor"): ClipboardConsumerLease {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      current.leaseSeq += 1;
      const token = `lease-${workspaceInstanceId}-${current.leaseSeq}-${Math.random().toString(36).slice(2, 7)}`;
      const id = consumerId || `anon-${current.leaseSeq}`;

      const entry = { token, id, kind };
      current.consumers.set(token, entry);
      current.lifecycleRevision += 1;
      notify();

      let active = true;
      const detachFn = function () {
        if (!active) return "already-detached";
        active = false;
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        if (liveSlot && liveSlot.consumers.has(token)) {
          liveSlot.consumers.delete(token);
          liveSlot.lifecycleRevision += 1;
          notify();
          return "detached";
        }
        return "already-detached";
      };

      const lease = Object.assign(detachFn, {
        token,
        consumerId: id,
        kind,
        detach: detachFn,
      }) as ClipboardConsumerLease;
      return lease;
    },
    getSnapshot,
    subscribe(listener) {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      current.listeners.add(listener);
      return () => {
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        liveSlot?.listeners.delete(listener);
      };
    },
    write: (input) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const session = current.store.write(input);
      current.payloadRevision += 1;
      if (current.store.historyExclusion() === "recorded") {
        current.historyRevision += 1;
      }
      notify();
      return session;
    },
    read: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.read();
    },
    clear: (reason) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.read() !== null || current.store.historyEntries().length > 0) {
        current.payloadRevision += 1;
        current.historyRevision += 1;
        current.store.clear(reason);
        notify();
      }
    },
    release() {
      if (handleReleased) return;
      handleReleased = true;
      const current = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!current) return;
      current.rootAcquisitions = Math.max(0, current.rootAcquisitions - 1);
      current.lifecycleRevision += 1;
      notify();
      if (current.rootAcquisitions > 0) {
        return;
      }
      // Deferred by a microtask so a synchronous view remount (cleanup →
      // setup in one commit) does not transiently wipe the payload; if no
      // re-acquire happens, the slot really is going away.
      queueMicrotask(() => {
        const liveSlot = slotStatesByWorkspace.get(workspaceInstanceId);
        if (!liveSlot || liveSlot.rootAcquisitions > 0) return;
        slotStatesByWorkspace.delete(workspaceInstanceId);
        liveSlot.store.clear("workspace-close");
        liveSlot.consumers.clear();
        liveSlot.listeners.clear();
      });
    },
    historyEntries: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyEntries();
    },
    pasteFromHistory(index) {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const session = current.store.pasteFromHistory(index);
      if (session) {
        current.payloadRevision += 1;
        notify();
      }
      return session;
    },
    removeHistoryEntry: (index) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const removed = current.store.removeHistoryEntry(index);
      if (removed) {
        current.historyRevision += 1;
        notify();
      }
      return removed;
    },
    clearHistory: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.historyEntries().length > 0) {
        current.historyRevision += 1;
        current.store.clearHistory();
        notify();
      }
    },
    setHistoryEnabled: (enabled) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.store.isHistoryEnabled() !== enabled) {
        current.policyRevision += 1;
        current.store.setHistoryEnabled(enabled);
        if (!enabled) {
          current.historyRevision += 1;
        }
        notify();
      }
    },
    isHistoryEnabled: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.isHistoryEnabled();
    },
    setHistoryLimits: (maxItems, maxTotalBytes) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      const oldLimits = current.store.historyLimits();
      const nextItems = Math.min(50, Math.max(1, Math.floor(maxItems)));
      const nextBytes = Math.max(1024, Math.floor(maxTotalBytes));
      if (oldLimits.maxItems !== nextItems || oldLimits.maxTotalBytes !== nextBytes) {
        current.policyRevision += 1;
        current.store.setHistoryLimits(nextItems, nextBytes);
        notify();
      }
    },
    historyLimits: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyLimits();
    },
    historyExclusion: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.store.historyExclusion();
    },
    setPermission: (permission) => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission !== permission) {
        current.permission = permission;
        current.permissionGeneration += 1;
        notify();
      }
    },
    permission: () => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      return current.permission;
    },
    attachPermissionAdapter: (adapter: ClipboardPermissionAdapter) => {
      void handle.syncPermission(adapter);
      if (typeof adapter.subscribe === "function") {
        return adapter.subscribe((perm) => {
          handle.setPermission(perm);
        });
      }
      return () => {};
    },
    syncPermission: async (adapter?: ClipboardPermissionAdapter) => {
      const activeAdapter = adapter ?? createDefaultClipboardPermissionAdapter();
      try {
        const perm = await activeAdapter.queryPermission();
        handle.setPermission(perm);
        return perm;
      } catch {
        return handle.permission();
      }
    },
    writeSystemClipboard: async (text: string, io?: GuardedClipboardIO): Promise<GuardedSystemWriteResult> => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission === "denied") {
        return { outcome: "denied", systemEffect: 0 };
      }
      const baseGeneration = current.permissionGeneration;
      const writeFn = io?.writeText ?? writeText;
      try {
        await writeFn(text);
      } catch (err) {
        return {
          outcome: "unavailable",
          error: err instanceof Error ? err.message : String(err),
          systemEffect: 0,
        };
      }
      const postSlot = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!postSlot || postSlot.permissionGeneration !== baseGeneration) {
        return {
          outcome: "stale-generation",
          baseGeneration,
          currentGeneration: postSlot ? postSlot.permissionGeneration : -1,
          systemEffect: 0,
        };
      }
      if (postSlot.permission === "denied") {
        return { outcome: "denied", systemEffect: 0 };
      }
      return { outcome: "success", systemEffect: 1 };
    },
    readSystemClipboard: async (io?: GuardedClipboardIO): Promise<GuardedSystemReadResult> => {
      const current = slotStatesByWorkspace.get(workspaceInstanceId) ?? slot;
      if (current.permission === "denied") {
        return { outcome: "denied", systemEffect: 0, fallbackSession: current.store.read() };
      }
      const baseGeneration = current.permissionGeneration;
      const readFn = io?.readTextResult ?? readTextResult;
      let res: ClipboardTextReadResult;
      try {
        res = await readFn();
      } catch (err) {
        const postSlot = slotStatesByWorkspace.get(workspaceInstanceId) ?? current;
        return {
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          systemEffect: 0,
          fallbackSession: postSlot.store.read(),
        };
      }
      const postSlot = slotStatesByWorkspace.get(workspaceInstanceId);
      if (!postSlot || postSlot.permissionGeneration !== baseGeneration) {
        return {
          outcome: "stale-generation",
          baseGeneration,
          currentGeneration: postSlot ? postSlot.permissionGeneration : -1,
          systemEffect: 0,
          fallbackSession: postSlot ? postSlot.store.read() : null,
        };
      }
      if (postSlot.permission === "denied") {
        return { outcome: "denied", systemEffect: 0, fallbackSession: postSlot.store.read() };
      }
      if (!res.ok) {
        return { outcome: "unavailable", systemEffect: 0, fallbackSession: postSlot.store.read() };
      }
      return { outcome: "success", text: res.text, systemEffect: 1 };
    },
  };

  if (options?.permissionAdapter) {
    handle.attachPermissionAdapter(options.permissionAdapter);
  }

  return handle;
}

/**
 * Single-slot store accessor retained for non-lifecycle call sites (context
 * menus, tests). New editor hosts must use `acquireClipboardStore`.
 */
export function clipboardStoreForWorkspace(workspaceId: string): WorkspaceClipboardStore {
  const slot = getOrCreateSlot(workspaceId);
  return slot.store;
}

/** Test/diagnostic reset of every workspace slot. */
export function resetWorkspaceClipboardStores(): void {
  slotStatesByWorkspace.clear();
}

function buildWorkspaceClipboardSnapshot(slot: WorkspaceSlotState): WorkspaceClipboardSnapshot {
  return {
    payloadRevision: slot.payloadRevision,
    historyRevision: slot.historyRevision,
    policyRevision: slot.policyRevision,
    permissionGeneration: slot.permissionGeneration,
    lifecycleRevision: slot.lifecycleRevision,
    permission: slot.permission,
    consumers: Array.from(slot.consumers.values()),
    revision: slot.payloadRevision,
    history: slot.store.historyEntries(),
    exclusion: slot.store.historyExclusion(),
    isHistoryEnabled: slot.store.isHistoryEnabled(),
    limits: slot.store.historyLimits(),
    consumerCount: slot.consumers.size,
  };
}

if (typeof window !== "undefined") {
  (window as unknown as { __taomniClipboardObserve?: (workspaceInstanceId?: string) => unknown }).__taomniClipboardObserve = (
    workspaceInstanceId?: string,
  ) => {
    if (!workspaceInstanceId) {
      const all: Record<string, WorkspaceClipboardSnapshot> = {};
      for (const [id, slot] of slotStatesByWorkspace) {
        all[id] = buildWorkspaceClipboardSnapshot(slot);
      }
      return all;
    }
    const slot = slotStatesByWorkspace.get(workspaceInstanceId);
    return slot ? buildWorkspaceClipboardSnapshot(slot) : null;
  };
}

