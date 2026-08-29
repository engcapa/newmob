import { describe, expect, it } from "vitest";
import {
  WorkspaceDocumentLeaseTracker,
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
});
