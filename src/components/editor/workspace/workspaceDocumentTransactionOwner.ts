import { Annotation } from "@codemirror/state";

/**
 * §8.26 / ED-MULTIVIEW-002: Shared Document Transaction Owner.
 * Coordinates incremental change transactions across multiple EditorViews
 * observing the same workspace document without full-text replacement or history loss.
 */

export const remoteTransactionAnnotation = Annotation.define<boolean>();

export interface DocumentChangeDelta {
  from: number;
  to: number;
  insert: string;
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

export type DocumentTransactionListener = (transaction: DocumentTransaction) => void;

export class WorkspaceDocumentTransactionOwner {
  private listenersByFile = new Map<string, Set<DocumentTransactionListener>>();
  private revisionsByFile = new Map<string, number>();

  getRevision(fileKey: string): number {
    return this.revisionsByFile.get(fileKey) ?? 0;
  }

  setRevision(fileKey: string, revision: number): void {
    this.revisionsByFile.set(fileKey, revision);
  }

  subscribe(fileKey: string, listener: DocumentTransactionListener): () => void {
    let set = this.listenersByFile.get(fileKey);
    if (!set) {
      set = new Set();
      this.listenersByFile.set(fileKey, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listenersByFile.delete(fileKey);
      }
    };
  }

  dispatchTransaction(
    fileKey: string,
    sourceViewId: string,
    changes: readonly DocumentChangeDelta[],
    origin: DocumentTransactionOrigin = "user-input",
  ): DocumentTransaction {
    const nextRevision = (this.revisionsByFile.get(fileKey) ?? 0) + 1;
    this.revisionsByFile.set(fileKey, nextRevision);

    const transaction: DocumentTransaction = {
      fileKey,
      sourceViewId,
      revision: nextRevision,
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

  clear(fileKey?: string): void {
    if (fileKey) {
      this.listenersByFile.delete(fileKey);
      this.revisionsByFile.delete(fileKey);
    } else {
      this.listenersByFile.clear();
      this.revisionsByFile.clear();
    }
  }
}
