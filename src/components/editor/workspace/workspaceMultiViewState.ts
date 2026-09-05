/**
 * §8.26 / ED-MULTIVIEW-003: Multi-View Shared Decoration & Per-View State Coordination.
 * Manages document resource leases, ensures document-level decorations (diagnostics,
 * breakpoints, bookmarks) synchronize across all views of a file, and guarantees
 * caret/selection/scroll/fold isolation per view.
 */

import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { DebugBreakpointMarker } from "./debugEditorChrome";
import type { WorkspaceBookmark } from "./todoBookmarks";

export interface DocumentSharedDecorations {
  readonly fileKey: string;
  readonly diagnostics: readonly LspDiagnostic[];
  readonly debugBreakpoints: readonly DebugBreakpointMarker[];
  readonly bookmarks: readonly WorkspaceBookmark[];
}

export interface ViewIsolatedState {
  readonly viewId: string;
  readonly fileKey: string;
  readonly caretLine: number;
  readonly caretCharacter: number;
  readonly selectionAnchor: number;
  readonly selectionHead: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly foldedLines: readonly number[];
}

export class WorkspaceDocumentLeaseTracker {
  private leases = new Map<string, Set<string>>();

  acquireLease(fileKey: string, viewId: string): number {
    let set = this.leases.get(fileKey);
    if (!set) {
      set = new Set();
      this.leases.set(fileKey, set);
    }
    set.add(viewId);
    return set.size;
  }

  releaseLease(fileKey: string, viewId: string): { leaseCount: number; isLast: boolean } {
    const set = this.leases.get(fileKey);
    if (!set) return { leaseCount: 0, isLast: true };
    set.delete(viewId);
    const count = set.size;
    if (count === 0) {
      this.leases.delete(fileKey);
      return { leaseCount: 0, isLast: true };
    }
    return { leaseCount: count, isLast: false };
  }

  getLeaseCount(fileKey: string): number {
    return this.leases.get(fileKey)?.size ?? 0;
  }

  getViewIds(fileKey: string): string[] {
    const set = this.leases.get(fileKey);
    return set ? Array.from(set) : [];
  }

  hasLease(fileKey: string, viewId: string): boolean {
    return this.leases.get(fileKey)?.has(viewId) ?? false;
  }

  clear(): void {
    this.leases.clear();
  }
}

/**
 * Validates that closing a split view preserves the underlying document
 * resource when another split view still leases the file.
 */
export function evaluateViewCloseResourceRetention(
  tracker: WorkspaceDocumentLeaseTracker,
  fileKey: string,
  closingViewId: string,
): { shouldReleaseDocumentResource: boolean; remainingLeaseCount: number } {
  const result = tracker.releaseLease(fileKey, closingViewId);
  return {
    shouldReleaseDocumentResource: result.isLast,
    remainingLeaseCount: result.leaseCount,
  };
}

/**
 * Coordinates document-level shared decorations and isolated per-view navigation states.
 */
export class WorkspaceMultiViewStateCoordinator {
  private viewStates = new Map<string, ViewIsolatedState>();
  private decorationsByFile = new Map<string, DocumentSharedDecorations>();
  readonly leaseTracker = new WorkspaceDocumentLeaseTracker();

  saveViewState(state: ViewIsolatedState): void {
    this.viewStates.set(`${state.fileKey}::${state.viewId}`, state);
  }

  getViewState(fileKey: string, viewId: string): ViewIsolatedState | null {
    return this.viewStates.get(`${fileKey}::${viewId}`) ?? null;
  }

  removeViewState(fileKey: string, viewId: string): void {
    this.viewStates.delete(`${fileKey}::${viewId}`);
  }

  setDocumentDecorations(decorations: DocumentSharedDecorations): void {
    this.decorationsByFile.set(decorations.fileKey, decorations);
  }

  getDocumentDecorations(fileKey: string): DocumentSharedDecorations | null {
    return this.decorationsByFile.get(fileKey) ?? null;
  }

  clear(): void {
    this.viewStates.clear();
    this.decorationsByFile.clear();
    this.leaseTracker.clear();
  }
}
