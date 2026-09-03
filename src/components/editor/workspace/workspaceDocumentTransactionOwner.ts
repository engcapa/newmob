import { Annotation, ChangeSet } from "@codemirror/state";

/**
 * §8.26 / ED-MULTIVIEW-002: Shared Document Transaction Owner.
 * Coordinates incremental change transactions across multiple EditorViews
 * observing the same workspace document without full-text replacement or
 * divergent per-view history.
 */

export const remoteTransactionAnnotation = Annotation.define<boolean>();

export interface DocumentChangeDelta {
  from: number;
  to: number;
  insert: string;
  /** Text removed from the canonical preimage, when the producer has it. */
  deleted?: string;
}

export type DocumentTransactionOrigin =
  | "user-input"
  | "remote-sync"
  | "undo"
  | "redo"
  | "format"
  | "completion"
  | "refactor"
  | "external-disk";

export interface DocumentTransaction {
  fileKey: string;
  sourceViewId: string;
  revision: number;
  changes: readonly DocumentChangeDelta[];
  origin: DocumentTransactionOrigin;
  timestamp: number;
}

export interface DocumentHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
}

export type DocumentTransactionListener = (transaction: DocumentTransaction) => void;

/** Metadata-only callbacks for the QA observation adapter. */
export interface WorkspaceDocumentOwnerTransactionObservation {
  readonly fileKey: string;
  readonly revision: number;
  readonly origin: DocumentTransactionOrigin;
}

export interface WorkspaceDocumentOwnerLeaseObservation {
  readonly fileKey: string;
  readonly viewId: string;
  readonly activeViewCount: number;
  readonly delta: 1 | -1;
}

export interface WorkspaceDocumentOwnerObserver {
  readonly onTransaction?: (observation: WorkspaceDocumentOwnerTransactionObservation) => void;
  readonly onHistoryReceipt?: (observation: WorkspaceDocumentOwnerTransactionObservation) => void;
  readonly onViewLeaseChanged?: (observation: WorkspaceDocumentOwnerLeaseObservation) => void;
}

interface HistoryEntry {
  beforeText: string;
  afterText: string;
  forward: readonly DocumentChangeDelta[];
  inverse: readonly DocumentChangeDelta[];
}

interface DocumentRecord {
  text: string;
  revision: number;
  views: Set<string>;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

interface AppliedChanges {
  text: string;
  changes: DocumentChangeDelta[];
  inverse: DocumentChangeDelta[];
}

/**
 * Apply a CodeMirror change set and retain both coordinate spaces. The
 * canonical text is the only source used to derive deleted text, so undo is
 * correct for replacements and multi-edit transactions alike.
 */
function applyChanges(text: string, changes: readonly DocumentChangeDelta[]): AppliedChanges | null {
  if (changes.length === 0) return null;

  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(
      changes.map(({ from, to, insert }) => ({ from, to, insert })),
      text.length,
    );
  } catch {
    return null;
  }

  const applied: DocumentChangeDelta[] = [];
  const inverse: DocumentChangeDelta[] = [];
  let nextText = "";
  let cursor = 0;

  changeSet.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const deleted = text.slice(fromA, toA);
    const insert = inserted.toString();
    nextText += text.slice(cursor, fromA);
    nextText += insert;
    cursor = toA;
    applied.push({
      from: fromA,
      to: toA,
      insert,
      ...(deleted ? { deleted } : {}),
    });
    inverse.push({
      from: fromB,
      to: toB,
      insert: deleted,
      ...(insert ? { deleted: insert } : {}),
    });
  });
  nextText += text.slice(cursor);

  return { text: nextText, changes: applied, inverse };
}

function singleReplacement(text: string, nextText: string): DocumentChangeDelta {
  let prefix = 0;
  const maxPrefix = Math.min(text.length, nextText.length);
  while (prefix < maxPrefix && text[prefix] === nextText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(text.length - prefix, nextText.length - prefix);
  while (
    suffix < maxSuffix
    && text[text.length - suffix - 1] === nextText[nextText.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: text.length - suffix,
    insert: nextText.slice(prefix, nextText.length - suffix),
    deleted: text.slice(prefix, text.length - suffix),
  };
}

function canRecordHistory(origin: DocumentTransactionOrigin): boolean {
  return origin !== "remote-sync";
}

function isHistoryReplay(origin: DocumentTransactionOrigin): boolean {
  return origin === "undo" || origin === "redo";
}

export class WorkspaceDocumentTransactionOwner {
  private listenersByFile = new Map<string, Set<DocumentTransactionListener>>();
  private documentsByFile = new Map<string, DocumentRecord>();

  constructor(private readonly observer: WorkspaceDocumentOwnerObserver = {}) {}

  /** Create the document record once; later views never overwrite its text. */
  initializeDocument(fileKey: string, text: string, revision = 0): string {
    const existing = this.documentsByFile.get(fileKey);
    if (existing) {
      existing.revision = Math.max(existing.revision, revision);
      return existing.text;
    }
    this.documentsByFile.set(fileKey, {
      text,
      revision: Math.max(0, revision),
      views: new Set(),
      undo: [],
      redo: [],
    });
    return text;
  }

  /** Acquire a view lease and return the current canonical document text. */
  acquireView(fileKey: string, viewId: string, text: string, revision = 0): string {
    const canonical = this.initializeDocument(fileKey, text, revision);
    const record = this.documentsByFile.get(fileKey)!;
    if (!record.views.has(viewId)) {
      record.views.add(viewId);
      this.notifyLeaseChanged({
        fileKey,
        viewId,
        activeViewCount: record.views.size,
        delta: 1,
      });
    }
    return canonical;
  }

  /** Release one view; the document/history is evicted only at the final lease. */
  releaseView(fileKey: string, viewId: string): boolean {
    const record = this.documentsByFile.get(fileKey);
    if (!record || !record.views.delete(viewId)) return false;
    this.notifyLeaseChanged({
      fileKey,
      viewId,
      activeViewCount: record.views.size,
      delta: -1,
    });
    if (record.views.size > 0) return false;
    this.documentsByFile.delete(fileKey);
    this.listenersByFile.delete(fileKey);
    return true;
  }

  getDocument(fileKey: string): string | null {
    return this.documentsByFile.get(fileKey)?.text ?? null;
  }

  getRevision(fileKey: string): number {
    return this.documentsByFile.get(fileKey)?.revision ?? 0;
  }

  setRevision(fileKey: string, revision: number): void {
    const existing = this.documentsByFile.get(fileKey);
    if (existing) {
      existing.revision = Math.max(existing.revision, revision);
      return;
    }
    this.initializeDocument(fileKey, "", revision);
  }

  getHistoryState(fileKey: string): DocumentHistoryState {
    const record = this.documentsByFile.get(fileKey);
    return {
      canUndo: (record?.undo.length ?? 0) > 0,
      canRedo: (record?.redo.length ?? 0) > 0,
      undoDepth: record?.undo.length ?? 0,
      redoDepth: record?.redo.length ?? 0,
    };
  }

  subscribe(fileKey: string, listener: DocumentTransactionListener): () => void {
    let set = this.listenersByFile.get(fileKey);
    if (!set) {
      set = new Set();
      this.listenersByFile.set(fileKey, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.listenersByFile.delete(fileKey);
      }
    };
  }

  private publish(
    fileKey: string,
    sourceViewId: string,
    record: DocumentRecord,
    changes: readonly DocumentChangeDelta[],
    origin: DocumentTransactionOrigin,
  ): DocumentTransaction {
    record.revision += 1;
    const transaction: DocumentTransaction = {
      fileKey,
      sourceViewId,
      revision: record.revision,
      changes,
      origin,
      timestamp: Date.now(),
    };

    const listeners = this.listenersByFile.get(fileKey);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(transaction);
        } catch (err) {
          console.error("DocumentTransactionListener error:", err);
        }
      }
    }
    return transaction;
  }

  dispatchTransaction(
    fileKey: string,
    sourceViewId: string,
    changes: readonly DocumentChangeDelta[],
    origin: DocumentTransactionOrigin = "user-input",
  ): DocumentTransaction | null {
    const record = this.documentsByFile.get(fileKey);
    if (!record || changes.length === 0) return null;

    const beforeText = record.text;
    const applied = applyChanges(beforeText, changes);
    if (!applied) return null;
    for (const [index, change] of changes.entries()) {
      const expectedDeleted = applied.changes[index]?.deleted;
      if (change.deleted !== undefined && change.deleted !== expectedDeleted) return null;
    }

    record.text = applied.text;
    if (canRecordHistory(origin) && !isHistoryReplay(origin)) {
      record.undo.push({
        beforeText,
        afterText: applied.text,
        forward: applied.changes,
        inverse: applied.inverse,
      });
      record.redo = [];
    }
    const transaction = this.publish(fileKey, sourceViewId, record, applied.changes, origin);
    const observation = {
      fileKey,
      revision: transaction.revision,
      origin: transaction.origin,
    } satisfies WorkspaceDocumentOwnerTransactionObservation;
    this.notifyObserver(this.observer.onTransaction, observation);
    if (canRecordHistory(origin) || isHistoryReplay(origin)) {
      this.notifyObserver(this.observer.onHistoryReceipt, observation);
    }
    return transaction;
  }

  /** Reconcile an external/store snapshot through the same incremental channel. */
  replaceDocument(
    fileKey: string,
    sourceViewId: string,
    text: string,
    origin: DocumentTransactionOrigin = "external-disk",
  ): DocumentTransaction | null {
    const record = this.documentsByFile.get(fileKey);
    if (!record || record.text === text) return null;
    return this.dispatchTransaction(fileKey, sourceViewId, [singleReplacement(record.text, text)], origin);
  }

  undo(fileKey: string, sourceViewId: string): DocumentTransaction | null {
    const record = this.documentsByFile.get(fileKey);
    const entry = record?.undo[record.undo.length - 1];
    if (!record || !entry || record.text !== entry.afterText) return null;
    const applied = applyChanges(record.text, entry.inverse);
    if (!applied || applied.text !== entry.beforeText) return null;
    record.undo.pop();
    record.redo.push(entry);
    record.text = applied.text;
    const transaction = this.publish(fileKey, sourceViewId, record, applied.changes, "undo");
    const observation = {
      fileKey,
      revision: transaction.revision,
      origin: transaction.origin,
    } satisfies WorkspaceDocumentOwnerTransactionObservation;
    this.notifyObserver(this.observer.onTransaction, observation);
    this.notifyObserver(this.observer.onHistoryReceipt, observation);
    return transaction;
  }

  redo(fileKey: string, sourceViewId: string): DocumentTransaction | null {
    const record = this.documentsByFile.get(fileKey);
    const entry = record?.redo[record.redo.length - 1];
    if (!record || !entry || record.text !== entry.beforeText) return null;
    const applied = applyChanges(record.text, entry.forward);
    if (!applied || applied.text !== entry.afterText) return null;
    record.redo.pop();
    record.undo.push(entry);
    record.text = applied.text;
    const transaction = this.publish(fileKey, sourceViewId, record, applied.changes, "redo");
    const observation = {
      fileKey,
      revision: transaction.revision,
      origin: transaction.origin,
    } satisfies WorkspaceDocumentOwnerTransactionObservation;
    this.notifyObserver(this.observer.onTransaction, observation);
    this.notifyObserver(this.observer.onHistoryReceipt, observation);
    return transaction;
  }

  clear(fileKey?: string): void {
    if (fileKey) {
      const record = this.documentsByFile.get(fileKey);
      if (record) {
        for (const viewId of record.views) {
          this.notifyLeaseChanged({
            fileKey,
            viewId,
            activeViewCount: 0,
            delta: -1,
          });
        }
      }
      this.listenersByFile.delete(fileKey);
      this.documentsByFile.delete(fileKey);
    } else {
      for (const [currentFileKey, record] of this.documentsByFile) {
        for (const viewId of record.views) {
          this.notifyLeaseChanged({
            fileKey: currentFileKey,
            viewId,
            activeViewCount: 0,
            delta: -1,
          });
        }
      }
      this.listenersByFile.clear();
      this.documentsByFile.clear();
    }
  }

  private notifyLeaseChanged(observation: WorkspaceDocumentOwnerLeaseObservation): void {
    this.notifyObserver(this.observer.onViewLeaseChanged, observation);
  }

  private notifyObserver<T>(
    callback: ((observation: T) => void) | undefined,
    observation: T,
  ): void {
    try {
      callback?.(observation);
    } catch {
      // Observation must never change or interrupt the document owner.
    }
  }
}
