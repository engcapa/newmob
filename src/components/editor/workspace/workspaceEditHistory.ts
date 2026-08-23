import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";

/**
 * A bounded, serially-executed history for editor-level transactions.
 *
 * CodeMirror already owns character-level undo. This model is intentionally
 * separate: one LSP WorkspaceEdit may touch several documents and must be
 * undone as one user-visible action. The callbacks are supplied by the shell
 * because only the shell knows how to restore buffers, disk state, and tabs.
 */

export interface WorkspaceEditHistoryEntry {
  id: string;
  label: string;
  affectedPaths: string[];
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface WorkspaceEditHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  busy: boolean;
}

export type WorkspaceEditHistoryAction = "undo" | "redo";

export interface WorkspaceEditHistoryResult {
  action: WorkspaceEditHistoryAction;
  entry: WorkspaceEditHistoryEntry;
}

const DEFAULT_HISTORY_LIMIT = 100;

/**
 * Keeps the two stacks consistent even when a callback rejects. A failed undo
 * remains on its original stack so the user can fix the conflict and retry.
 */
export class WorkspaceEditHistory {
  private readonly limit: number;
  private undoStack: WorkspaceEditHistoryEntry[] = [];
  private redoStack: WorkspaceEditHistoryEntry[] = [];
  private running = false;

  constructor(limit = DEFAULT_HISTORY_LIMIT) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  clear(): void {
    if (this.running) return;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(entry: WorkspaceEditHistoryEntry): void {
    if (this.running) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) {
      this.undoStack.splice(0, this.undoStack.length - this.limit);
    }
    this.redoStack = [];
  }

  state(): WorkspaceEditHistoryState {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      busy: this.running,
    };
  }

  async undo(): Promise<WorkspaceEditHistoryResult | null> {
    if (this.running || this.undoStack.length === 0) return null;
    const entry = this.undoStack[this.undoStack.length - 1]!;
    this.running = true;
    try {
      await entry.undo();
      this.undoStack.pop();
      this.redoStack.push(entry);
      return { action: "undo", entry };
    } finally {
      this.running = false;
    }
  }

  async redo(): Promise<WorkspaceEditHistoryResult | null> {
    if (this.running || this.redoStack.length === 0) return null;
    const entry = this.redoStack[this.redoStack.length - 1]!;
    this.running = true;
    try {
      await entry.redo();
      this.redoStack.pop();
      this.undoStack.push(entry);
      return { action: "redo", entry };
    } finally {
      this.running = false;
    }
  }
}

/** Test/helper factory for a complete-document replacement edit. */
export interface WorkspaceEditTextSnapshot {
  path: string;
  text: string;
}

export interface WorkspaceEditPathSnapshot {
  path: string;
  exists: boolean;
  /** Present only for files. Directory/special resources are not history-safe. */
  text: string | null;
  /** Charset metadata used by the shell when replay writes a closed file. */
  encoding?: string;
  bom?: boolean;
  eol?: "lf" | "crlf" | "cr";
}

function fullDocumentEnd(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    line: Math.max(0, lines.length - 1),
    character: lines.at(-1)?.length ?? 0,
  };
}

/**
 * Build a normalized LSP WorkspaceEdit that replaces each captured document in
 * order. The caller uses it for history inversion, never for server requests.
 */
export function buildWorkspaceTextSnapshotEdit(
  currentSnapshots: readonly WorkspaceEditTextSnapshot[],
  targetSnapshots: readonly WorkspaceEditTextSnapshot[],
): LspWorkspaceEdit {
  const currentByPath = new Map(currentSnapshots.map((snapshot) => [snapshot.path, snapshot.text]));
  const documents = targetSnapshots.map((snapshot) => {
    const currentText = currentByPath.get(snapshot.path);
    if (currentText === undefined) {
      throw new Error(`Cannot replace missing workspace history path: ${snapshot.path}`);
    }
    const document = {
      uri: "",
      path: snapshot.path,
      version: null,
      edits: [{
        range: {
          start: { line: 0, character: 0 },
          end: fullDocumentEnd(currentText),
        },
        newText: snapshot.text,
      }],
    };
    return document;
  });
  return {
    documentEdits: documents,
    operations: documents.map((document) => ({ kind: "text" as const, document })),
  };
}

/**
 * Reconcile a set of file paths to a captured before/after state. Resource
 * removals run before creates so rename chains and path swaps cannot collide;
 * file contents are restored only after the target path set exists.
 */
export function buildWorkspacePathSnapshotEdit(
  currentSnapshots: readonly WorkspaceEditPathSnapshot[],
  targetSnapshots: readonly WorkspaceEditPathSnapshot[],
): LspWorkspaceEdit {
  const currentByPath = new Map(currentSnapshots.map((snapshot) => [snapshot.path, snapshot]));
  const operations: NonNullable<LspWorkspaceEdit["operations"]> = [];
  const documentEdits: LspWorkspaceEdit["documentEdits"] = [];

  for (const target of targetSnapshots) {
    const current = currentByPath.get(target.path);
    if (!current) throw new Error(`Missing current workspace history state for ${target.path}`);
    if (current.exists && !target.exists) {
      operations.push({
        kind: "delete",
        uri: "",
        path: target.path,
        recursive: false,
        ignoreIfNotExists: false,
        annotationId: null,
      });
    }
  }

  for (const target of targetSnapshots) {
    const current = currentByPath.get(target.path)!;
    if (!current.exists && target.exists) {
      operations.push({
        kind: "create",
        uri: "",
        path: target.path,
        overwrite: false,
        ignoreIfExists: false,
        annotationId: null,
      });
    }
  }

  for (const target of targetSnapshots) {
    if (!target.exists) continue;
    if (target.text === null) {
      throw new Error(`Workspace history cannot restore a non-file resource: ${target.path}`);
    }
    const current = currentByPath.get(target.path)!;
    const currentText = current.exists ? current.text : "";
    if (currentText === null) {
      throw new Error(`Workspace history cannot replace a non-file resource: ${target.path}`);
    }
    if (currentText === target.text) continue;
    const document = {
      uri: "",
      path: target.path,
      version: null,
      edits: [{
        range: {
          start: { line: 0, character: 0 },
          end: fullDocumentEnd(currentText),
        },
        newText: target.text,
      }],
    };
    documentEdits.push(document);
    operations.push({ kind: "text", document });
  }

  return { documentEdits, operations };
}
