import { describe, expect, it } from "vitest";
import { EditorState, ChangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  WorkspaceDocumentTransactionOwner,
  remoteTransactionAnnotation,
  type DocumentChangeDelta,
  type DocumentTransaction,
} from "./workspaceDocumentTransactionOwner";

describe("§8.26 / ED-MULTIVIEW-002: WorkspaceDocumentTransactionOwner", () => {
  it("manages subscriptions and increments document revision monotonically", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    expect(owner.getRevision("file-1")).toBe(0);

    const received: DocumentTransaction[] = [];
    const unsubscribe = owner.subscribe("file-1", (tr) => {
      received.push(tr);
    });

    const tr1 = owner.dispatchTransaction(
      "file-1",
      "primary",
      [{ from: 0, to: 0, insert: "hello" }],
      "user-input",
    );

    expect(tr1.revision).toBe(1);
    expect(owner.getRevision("file-1")).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].sourceViewId).toBe("primary");
    expect(received[0].changes).toEqual([{ from: 0, to: 0, insert: "hello" }]);

    unsubscribe();
    owner.dispatchTransaction(
      "file-1",
      "primary",
      [{ from: 5, to: 5, insert: " world" }],
      "user-input",
    );

    expect(owner.getRevision("file-1")).toBe(2);
    // Listener was unsubscribed, so received count unchanged
    expect(received).toHaveLength(1);
  });

  it("coordinates incremental delta between two simulated CodeMirror views with echo suppression", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const initialText = "function hello() {\n  return 42;\n}\n";

    // Setup View 1 (Primary Split)
    const state1 = EditorState.create({ doc: initialText });
    const view1 = new EditorView({ state: state1 });

    // Setup View 2 (Secondary Split)
    const state2 = EditorState.create({ doc: initialText });
    const view2 = new EditorView({ state: state2 });

    // Wire up View 2 to receive remote transactions from owner
    owner.subscribe("main.ts", (tr) => {
      if (tr.sourceViewId === "secondary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view2.state.doc.length);
      const mappedSelection = view2.state.selection.map(changeSet);
      view2.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // Wire up View 1 to receive remote transactions from owner
    owner.subscribe("main.ts", (tr) => {
      if (tr.sourceViewId === "primary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view1.state.doc.length);
      const mappedSelection = view1.state.selection.map(changeSet);
      view1.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // View 1 types "async " before "function"
    const deltas1: DocumentChangeDelta[] = [{ from: 0, to: 0, insert: "async " }];
    view1.dispatch({ changes: deltas1 });
    owner.dispatchTransaction("main.ts", "primary", deltas1, "user-input");

    // Both views match text identically without resetting View 2's document
    expect(view1.state.doc.toString()).toBe("async function hello() {\n  return 42;\n}\n");
    expect(view2.state.doc.toString()).toBe("async function hello() {\n  return 42;\n}\n");

    // View 2 edits the return value 42 -> 100
    // "async function hello() {\n  return " length is 32
    const returnValPos = view2.state.doc.toString().indexOf("42");
    const deltas2: DocumentChangeDelta[] = [{ from: returnValPos, to: returnValPos + 2, insert: "100" }];
    view2.dispatch({ changes: deltas2 });
    owner.dispatchTransaction("main.ts", "secondary", deltas2, "user-input");

    expect(view1.state.doc.toString()).toBe("async function hello() {\n  return 100;\n}\n");
    expect(view2.state.doc.toString()).toBe("async function hello() {\n  return 100;\n}\n");

    // Total document revision incremented exactly twice
    expect(owner.getRevision("main.ts")).toBe(2);

    view1.destroy();
    view2.destroy();
  });

  it("handles multi-split multi-edit completion without corrupting sibling caret mapping", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const doc = "import java.util.List;\n\nclass App {\n  List items;\n}\n";

    const view1 = new EditorView({ state: EditorState.create({ doc }) });
    const view2 = new EditorView({ state: EditorState.create({ doc }) });

    // Place caret in View 2 at end of App class
    const caretPosView2 = doc.indexOf("List items;");
    view2.dispatch({ selection: { anchor: caretPosView2 } });

    owner.subscribe("App.java", (tr) => {
      if (tr.sourceViewId === "secondary") return;
      const changes = tr.changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      const changeSet = ChangeSet.of(changes, view2.state.doc.length);
      const mappedSelection = view2.state.selection.map(changeSet);
      view2.dispatch({
        changes,
        selection: mappedSelection,
        annotations: [remoteTransactionAnnotation.of(true)],
      });
    });

    // Multi-edit in View 1: auto-import Map at line 0 + change items type to Map
    const autoImportDelta: DocumentChangeDelta = { from: 0, to: 0, insert: "import java.util.Map;\n" };
    const typeChangeDelta: DocumentChangeDelta = { from: doc.indexOf("List items;"), to: doc.indexOf("List items;") + 4, insert: "Map" };

    view1.dispatch({ changes: [autoImportDelta, typeChangeDelta] });
    owner.dispatchTransaction("App.java", "primary", [autoImportDelta, typeChangeDelta], "completion");

    // View 2 document matches View 1 exactly
    expect(view2.state.doc.toString()).toBe(view1.state.doc.toString());

    // View 2 caret mapped forward past the inserted import line
    const importLen = "import java.util.Map;\n".length;
    expect(view2.state.selection.main.head).toBe(caretPosView2 + importLen);

    view1.destroy();
    view2.destroy();
  });
});
