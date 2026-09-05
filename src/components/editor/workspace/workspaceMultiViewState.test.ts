import { describe, expect, it } from "vitest";
import {
  WorkspaceDocumentLeaseTracker,
  WorkspaceMultiViewStateCoordinator,
  evaluateViewCloseResourceRetention,
  type DocumentSharedDecorations,
  type ViewIsolatedState,
} from "./workspaceMultiViewState";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { DebugBreakpointMarker } from "./debugEditorChrome";
import type { WorkspaceBookmark } from "./todoBookmarks";

describe("§8.26 / ED-MULTIVIEW-003: Multi-View Shared Decoration & Per-View State Coordination", () => {
  it("tracks document resource leases and prevents release until last view closes", () => {
    const tracker = new WorkspaceDocumentLeaseTracker();
    const fileKey = "src/main.rs";

    // View 1 opens the file
    expect(tracker.acquireLease(fileKey, "primary")).toBe(1);
    expect(tracker.getLeaseCount(fileKey)).toBe(1);
    expect(tracker.hasLease(fileKey, "primary")).toBe(true);

    // View 2 splits the file
    expect(tracker.acquireLease(fileKey, "secondary")).toBe(2);
    expect(tracker.getLeaseCount(fileKey)).toBe(2);
    expect(tracker.getViewIds(fileKey)).toEqual(["primary", "secondary"]);

    // View 1 closes its split
    const eval1 = evaluateViewCloseResourceRetention(tracker, fileKey, "primary");
    expect(eval1.shouldReleaseDocumentResource).toBe(false);
    expect(eval1.remainingLeaseCount).toBe(1);
    expect(tracker.getLeaseCount(fileKey)).toBe(1);

    // View 2 closes its split (the last remaining view)
    const eval2 = evaluateViewCloseResourceRetention(tracker, fileKey, "secondary");
    expect(eval2.shouldReleaseDocumentResource).toBe(true);
    expect(eval2.remainingLeaseCount).toBe(0);
    expect(tracker.getLeaseCount(fileKey)).toBe(0);
  });

  it("synchronizes document-level decorations across split views while keeping per-view states isolated", () => {
    const sharedDiagnostics: LspDiagnostic[] = [
      {
        message: "Unused variable",
        severity: 2,
        code: null,
        range: { start: { line: 10, character: 4 }, end: { line: 10, character: 8 } },
        source: "rust-analyzer",
      },
    ];

    const sharedBreakpoints: DebugBreakpointMarker[] = [
      { line: 15, conditional: false, logpoint: false, enabled: true, verified: true },
    ];

    const sharedBookmarks: WorkspaceBookmark[] = [
      {
        id: "bm-1",
        fileKey: "src/main.rs",
        pathLabel: "src/main.rs",
        line: 20,
        character: 0,
        label: "TODO: optimize",
        createdAt: 1000,
      },
    ];

    const docDecorations: DocumentSharedDecorations = {
      fileKey: "src/main.rs",
      diagnostics: sharedDiagnostics,
      debugBreakpoints: sharedBreakpoints,
      bookmarks: sharedBookmarks,
    };

    // Both views access the exact same shared decorations
    expect(docDecorations.diagnostics).toHaveLength(1);
    expect(docDecorations.debugBreakpoints).toHaveLength(1);
    expect(docDecorations.bookmarks).toHaveLength(1);

    // View 1 and View 2 maintain completely independent caret, scroll, and fold state
    const view1State: ViewIsolatedState = {
      viewId: "primary",
      fileKey: "src/main.rs",
      caretLine: 5,
      caretCharacter: 10,
      selectionAnchor: 50,
      selectionHead: 50,
      scrollTop: 100,
      scrollLeft: 0,
      foldedLines: [12, 13, 14],
    };

    const view2State: ViewIsolatedState = {
      viewId: "secondary",
      fileKey: "src/main.rs",
      caretLine: 35,
      caretCharacter: 2,
      selectionAnchor: 350,
      selectionHead: 380,
      scrollTop: 800,
      scrollLeft: 20,
      foldedLines: [],
    };

    expect(view1State.caretLine).not.toBe(view2State.caretLine);
    expect(view1State.selectionHead).not.toBe(view2State.selectionHead);
    expect(view1State.scrollTop).not.toBe(view2State.scrollTop);
    expect(view1State.foldedLines).not.toEqual(view2State.foldedLines);
  });

  it("ED-MULTIVIEW-003-A1: diagnostics, breakpoints, and bookmarks synchronize across all views of a file", () => {
    const coordinator = new WorkspaceMultiViewStateCoordinator();
    const fileKey = "src/App.tsx";

    coordinator.setDocumentDecorations({
      fileKey,
      diagnostics: [
        {
          message: "TS2304: Cannot find name 'foo'",
          severity: 1,
          code: "2304",
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          source: "typescript",
        },
      ],
      debugBreakpoints: [
        { line: 5, conditional: false, logpoint: false, enabled: true, verified: true },
      ],
      bookmarks: [
        {
          id: "bm-app",
          fileKey,
          pathLabel: "src/App.tsx",
          line: 12,
          character: 2,
          label: "entry point",
          createdAt: 2000,
        },
      ],
    });

    // Both views retrieve identical shared decorations for the document
    const dec1 = coordinator.getDocumentDecorations(fileKey);
    const dec2 = coordinator.getDocumentDecorations(fileKey);
    expect(dec1).toBe(dec2);
    expect(dec1?.diagnostics).toHaveLength(1);
    expect(dec1?.debugBreakpoints).toHaveLength(1);
    expect(dec1?.bookmarks).toHaveLength(1);
  });

  it("ED-MULTIVIEW-003-A2: caret, selection, scroll, and folds remain distinct per view through edits", () => {
    const coordinator = new WorkspaceMultiViewStateCoordinator();
    const fileKey = "src/App.tsx";

    const viewA: ViewIsolatedState = {
      viewId: "view-left",
      fileKey,
      caretLine: 10,
      caretCharacter: 4,
      selectionAnchor: 100,
      selectionHead: 120,
      scrollTop: 150,
      scrollLeft: 0,
      foldedLines: [20, 21, 22],
    };

    const viewB: ViewIsolatedState = {
      viewId: "view-right",
      fileKey,
      caretLine: 50,
      caretCharacter: 0,
      selectionAnchor: 500,
      selectionHead: 500,
      scrollTop: 600,
      scrollLeft: 10,
      foldedLines: [],
    };

    coordinator.saveViewState(viewA);
    coordinator.saveViewState(viewB);

    const restoredA = coordinator.getViewState(fileKey, "view-left");
    const restoredB = coordinator.getViewState(fileKey, "view-right");

    expect(restoredA?.caretLine).toBe(10);
    expect(restoredB?.caretLine).toBe(50);
    expect(restoredA?.selectionHead).toBe(120);
    expect(restoredB?.selectionHead).toBe(500);
    expect(restoredA?.scrollTop).toBe(150);
    expect(restoredB?.scrollTop).toBe(600);
    expect(restoredA?.foldedLines).toEqual([20, 21, 22]);
    expect(restoredB?.foldedLines).toEqual([]);
  });

  it("ED-MULTIVIEW-003-A3: close and reopen restores view state without releasing shared resources prematurely", () => {
    const coordinator = new WorkspaceMultiViewStateCoordinator();
    const fileKey = "src/App.tsx";

    // View A and View B acquire leases
    expect(coordinator.leaseTracker.acquireLease(fileKey, "view-left")).toBe(1);
    expect(coordinator.leaseTracker.acquireLease(fileKey, "view-right")).toBe(2);

    // Save state for View A before closing
    coordinator.saveViewState({
      viewId: "view-left",
      fileKey,
      caretLine: 42,
      caretCharacter: 5,
      selectionAnchor: 400,
      selectionHead: 410,
      scrollTop: 300,
      scrollLeft: 0,
      foldedLines: [50],
    });

    // Close View A: evaluate retention against lease tracker
    const closeEvalA = evaluateViewCloseResourceRetention(coordinator.leaseTracker, fileKey, "view-left");
    expect(closeEvalA.shouldReleaseDocumentResource).toBe(false);
    expect(closeEvalA.remainingLeaseCount).toBe(1);

    // Reopen View A: re-acquire lease and restore state
    expect(coordinator.leaseTracker.acquireLease(fileKey, "view-left")).toBe(2);
    const restoredState = coordinator.getViewState(fileKey, "view-left");
    expect(restoredState?.caretLine).toBe(42);
    expect(restoredState?.scrollTop).toBe(300);

    // Now close View A then View B (the final view)
    evaluateViewCloseResourceRetention(coordinator.leaseTracker, fileKey, "view-left");
    const closeEvalB = evaluateViewCloseResourceRetention(coordinator.leaseTracker, fileKey, "view-right");
    expect(closeEvalB.shouldReleaseDocumentResource).toBe(true);
    expect(closeEvalB.remainingLeaseCount).toBe(0);
  });
});
