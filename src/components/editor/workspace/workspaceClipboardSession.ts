import type { ClipboardSourceEol } from "./workspaceEditorCommands";

/**
 * Workspace-scoped clipboard session (§8.17.6 N9.3/N14.4 step 1).
 *
 * One single-slot session per workspace instance: copy/cut in ANY split view
 * writes it and paste in ANY split view reads it, so rectangular/multi-caret
 * payloads survive crossing editor leaves. The per-view WeakMap in
 * CodeMirrorHost remains only as a compat read for legacy call sites; this
 * store is the owner.
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
}

let sessionSequence = 0;

export class WorkspaceClipboardStore {
  private session: EditorClipboardSession | null = null;

  write(input: {
    sourceViewId: string | null;
    plainText: string;
    segments?: string[];
    rectangular: boolean;
    sourceEol: ClipboardSourceEol;
    systemClipboardUnavailable?: boolean;
  }): EditorClipboardSession {
    sessionSequence += 1;
    this.session = {
      sessionId: `clip-${Date.now().toString(36)}-${sessionSequence}`,
      sourceViewId: input.sourceViewId,
      segments: input.segments ? [...input.segments] : null,
      rectangular: input.rectangular,
      plainText: input.plainText,
      sourceEol: input.sourceEol,
      createdAt: Date.now(),
      ...(input.systemClipboardUnavailable ? { systemClipboardUnavailable: true } : {}),
    };
    return this.session;
  }

  read(): EditorClipboardSession | null {
    return this.session;
  }

  clear(): void {
    this.session = null;
  }
}

const storesByWorkspace = new Map<string, WorkspaceClipboardStore>();

/** Single-slot store for one workspace instance; shared by every split view. */
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
}
