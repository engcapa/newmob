import type { ClipboardSourceEol } from "./workspaceEditorCommands";

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

const storesByWorkspace = new Map<string, WorkspaceClipboardStore>();
const refcountsByWorkspace = new Map<string, number>();
const storeRevisionsByWorkspace = new Map<string, number>();
const consumersByWorkspace = new Map<string, Set<string>>();
const listenersByWorkspace = new Map<string, Set<(snapshot: WorkspaceClipboardSnapshot) => void>>();
const permissionGenerationsByWorkspace = new Map<string, number>();

export interface WorkspaceClipboardSnapshot {
  revision: number;
  history: readonly EditorClipboardSession[];
  exclusion: ClipboardHistoryExclusion;
  isHistoryEnabled: boolean;
  limits: { maxItems: number; maxTotalBytes: number };
  consumerCount: number;
  permissionGeneration: number;
}

export interface WorkspaceClipboardHandle {
  readonly workspaceId: string;
  attachConsumer(consumerId?: string): () => void;
  getSnapshot(): WorkspaceClipboardSnapshot;
  subscribe(listener: (snapshot: WorkspaceClipboardSnapshot) => void): () => void;
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
}

/**
 * Acquire one handle for an editor host instance. Refcounted per workspace
 * instance: the last `release()` clears and deletes the slot immediately, so
 * closing a workspace cannot leak its clipboard payload (§8.18.4 lifecycle).
 */
export function acquireClipboardStore(workspaceInstanceId: string): WorkspaceClipboardHandle {
  let store = storesByWorkspace.get(workspaceInstanceId);
  if (!store) {
    store = new WorkspaceClipboardStore();
    storesByWorkspace.set(workspaceInstanceId, store);
    storeRevisionsByWorkspace.set(workspaceInstanceId, 0);
    consumersByWorkspace.set(workspaceInstanceId, new Set());
    listenersByWorkspace.set(workspaceInstanceId, new Set());
    permissionGenerationsByWorkspace.set(workspaceInstanceId, 1);
  }
  refcountsByWorkspace.set(workspaceInstanceId, (refcountsByWorkspace.get(workspaceInstanceId) ?? 0) + 1);

  const getSnapshot = (): WorkspaceClipboardSnapshot => {
    const current = storesByWorkspace.get(workspaceInstanceId) ?? store!;
    return {
      revision: storeRevisionsByWorkspace.get(workspaceInstanceId) ?? 0,
      history: current.historyEntries(),
      exclusion: current.historyExclusion(),
      isHistoryEnabled: current.isHistoryEnabled(),
      limits: current.historyLimits(),
      consumerCount: consumersByWorkspace.get(workspaceInstanceId)?.size ?? 0,
      permissionGeneration: permissionGenerationsByWorkspace.get(workspaceInstanceId) ?? 1,
    };
  };

  const notify = () => {
    const listeners = listenersByWorkspace.get(workspaceInstanceId);
    if (!listeners || listeners.size === 0) return;
    const snap = getSnapshot();
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {
        // ignore subscriber errors
      }
    }
  };

  const bump = () => {
    const next = (storeRevisionsByWorkspace.get(workspaceInstanceId) ?? 0) + 1;
    storeRevisionsByWorkspace.set(workspaceInstanceId, next);
    notify();
  };

  const live = (): WorkspaceClipboardStore => {
    const current = storesByWorkspace.get(workspaceInstanceId) ?? store!;
    return current;
  };

  const handle: WorkspaceClipboardHandle = {
    workspaceId: workspaceInstanceId,
    attachConsumer(consumerId?: string) {
      const id = consumerId || `anon-${Math.random().toString(36).slice(2, 9)}`;
      let consumers = consumersByWorkspace.get(workspaceInstanceId);
      if (!consumers) {
        consumers = new Set();
        consumersByWorkspace.set(workspaceInstanceId, consumers);
      }
      if (consumers.has(id)) {
        return () => {
          if (consumers?.has(id)) {
            consumers.delete(id);
            handle.release();
            notify();
          }
        };
      }
      consumers.add(id);
      refcountsByWorkspace.set(workspaceInstanceId, (refcountsByWorkspace.get(workspaceInstanceId) ?? 0) + 1);
      notify();
      return () => {
        if (consumers?.has(id)) {
          consumers.delete(id);
          handle.release();
          notify();
        }
      };
    },
    getSnapshot,
    subscribe(listener) {
      let listeners = listenersByWorkspace.get(workspaceInstanceId);
      if (!listeners) {
        listeners = new Set();
        listenersByWorkspace.set(workspaceInstanceId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
      };
    },
    write: (input) => {
      bump();
      return live().write(input);
    },
    read: () => live().read(),
    clear: (reason) => {
      bump();
      live().clear(reason);
    },
    release() {
      const next = (refcountsByWorkspace.get(workspaceInstanceId) ?? 1) - 1;
      if (next > 0) {
        refcountsByWorkspace.set(workspaceInstanceId, next);
        return;
      }
      refcountsByWorkspace.set(workspaceInstanceId, 0);
      // Deferred by a microtask so a synchronous view remount (cleanup →
      // setup in one commit) does not transiently wipe the payload; if no
      // re-acquire happens, the slot really is going away.
      queueMicrotask(() => {
        if ((refcountsByWorkspace.get(workspaceInstanceId) ?? 0) !== 0) return;
        refcountsByWorkspace.delete(workspaceInstanceId);
        storesByWorkspace.delete(workspaceInstanceId);
        storeRevisionsByWorkspace.delete(workspaceInstanceId);
        consumersByWorkspace.delete(workspaceInstanceId);
        listenersByWorkspace.delete(workspaceInstanceId);
        permissionGenerationsByWorkspace.delete(workspaceInstanceId);
        store!.clear("workspace-close");
      });
    },
    historyEntries: () => live().historyEntries(),
    pasteFromHistory(index) {
      return live().pasteFromHistory(index);
    },
    removeHistoryEntry: (index) => {
      const removed = live().removeHistoryEntry(index);
      if (removed) {
        bump();
      }
      return removed;
    },
    clearHistory: () => {
      bump();
      live().clearHistory();
    },
    setHistoryEnabled: (enabled) => {
      bump();
      live().setHistoryEnabled(enabled);
    },
    isHistoryEnabled: () => live().isHistoryEnabled(),
    setHistoryLimits: (maxItems, maxTotalBytes) => {
      bump();
      live().setHistoryLimits(maxItems, maxTotalBytes);
    },
    historyLimits: () => live().historyLimits(),
    historyExclusion: () => live().historyExclusion(),
  };

  return handle;
}

/**
 * Single-slot store accessor retained for non-lifecycle call sites (context
 * menus, tests). New editor hosts must use `acquireClipboardStore`.
 */
export function clipboardStoreForWorkspace(workspaceId: string): WorkspaceClipboardStore {
  let store = storesByWorkspace.get(workspaceId);
  if (!store) {
    store = new WorkspaceClipboardStore();
    storesByWorkspace.set(workspaceId, store);
  }
  return store;
}

/** Test/diagnostic reset of every workspace slot. */
export function resetWorkspaceClipboardStores(): void {
  storesByWorkspace.clear();
  refcountsByWorkspace.clear();
  storeRevisionsByWorkspace.clear();
  consumersByWorkspace.clear();
  listenersByWorkspace.clear();
  permissionGenerationsByWorkspace.clear();
}
