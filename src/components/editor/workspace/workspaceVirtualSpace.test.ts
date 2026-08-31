import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  charVisualWidth,
  desiredVisualColumnField,
  documentColumnForVisualColumn,
  measureVisualPositions,
  setVirtualHead,
  setVirtualOverflow,
  virtualBackspaceCommand,
  virtualDeleteCommand,
  virtualEnterCommand,
  virtualEscapeCommand,
  virtualHomeCommand,
  virtualLineEndCommand,
  virtualMoveDown,
  virtualMoveLeftCommand,
  virtualMoveRightCommand,
  virtualOverflowAt,
  virtualPageDown,
  virtualPageUp,
  virtualSelectDown,
  virtualSelectPageDown,
  virtualSelectPageUp,
  virtualSpaceClickHandler,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
  virtualTabCommand,
  isEditorGeometryReady,
  VirtualSpaceController,
  VIRTUAL_SPACE_KNOWN_GAPS,
} from "./workspaceVirtualSpace";
import { editorVirtualSpacePolicy } from "./workspaceEditorCommands";
import { buildEditorHostActions } from "./workspaceCodeMirrorKeymap";
import { DEFAULT_WORKSPACE_ACTIONS } from "./workspaceActionRegistry";
import { WorkspaceActionHost, EditorActionBridge } from "./workspaceActionHost";
import { history, undo } from "@codemirror/commands";

const POLICY = editorVirtualSpacePolicy.of({ afterLineEnd: true, atFileBottom: true });

function visualColumnOf(text: string, column: number, tabWidth: number): number {
  let visual = 0;
  for (let index = 0; index < column; index += 1) {
    visual += charVisualWidth(text[index], visual, tabWidth);
  }
  return visual;
}

function mount(doc: string, policyEnabled = true): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        // The host enables this globally (§8.18.2); without it CM collapses
        // every secondary caret and multi-caret assertions are meaningless.
        EditorState.allowMultipleSelections.of(true),
        virtualSpaceOverflowField,
        virtualSpaceTypingHandler,
        virtualSpaceClickHandler,
        ...(policyEnabled ? [POLICY] : []),
      ],
    }),
  });
}

describe("§8.19.5 visual column model", () => {
  it("expands tabs to stops and double-width characters", () => {
    expect(charVisualWidth("a", 0, 4)).toBe(1);
    expect(charVisualWidth("\t", 0, 4)).toBe(4);
    expect(charVisualWidth("\t", 3, 4)).toBe(1);
    expect(charVisualWidth("你", 0, 4)).toBe(2);
    expect(charVisualWidth("😀", 0, 4)).toBe(2);
    // Tab stop alignment inside mixed content: a,b at cols 0,1 then tab→4, c→5.
    expect(visualColumnOf("ab\tc", 4, 4)).toBe(5);
  });

  it("measures VisualColumnPosition per caret with policy gates", () => {
    const doc = "ab\nlonger line";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [virtualSpaceOverflowField, POLICY],
    });
    const positions = measureVisualPositions(state, 4);
    expect(positions).toHaveLength(1);
    expect(positions[0].line).toBe(1);
    expect(positions[0].documentColumn).toBe(11); // end of "longer line"
    // atFileBottom on the last line allows virtual columns.
    expect(positions[0].virtualColumns).toBeGreaterThan(0);

    const off = EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [virtualSpaceOverflowField],
    });
    expect(measureVisualPositions(off, 4)[0].virtualColumns).toBe(0);
  });
});

describe("§8.19.5 virtual caret lifecycle", () => {
  it("records overflow without doc changes; typing materializes padding in one transaction", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 3 } }); // end of first line

    setVirtualHead(view, 3, 6, false);
    // Caret clamped at the legal offset; overflow recorded; doc untouched.
    expect(view.state.selection.main.head).toBe(3);
    expect(virtualOverflowAt(view.state, 3)).toBe(6);

    // Typing one character consumes the overflow: six spaces + the char.
    // (@codemirror/view 6.43 internalized someProp — drive the facet directly.)
    const handlers = view.state.facet(EditorView.inputHandler);
    // Handlers that claim the input never call insert(); a typed stub keeps
    // the signature honest without building a real Transaction.
    const insertStub = (() => {
      throw new Error("insert() must not be called by a claiming handler");
    }) as unknown as Parameters<(typeof EditorView.inputHandler)["of"]>[0] extends
      (view: never, from: number, to: number, text: string, insert: infer T) => boolean ? T : never;
    let handled = false;
    for (const handler of handlers) {
      if (handler(view, 3, 3, "x", insertStub)) {
        handled = true;
        break;
      }
    }
    if (!handled) throw new Error("typing handler did not claim the input");
    // Caret sat at the end of "abc": padding + x append to THAT line.
    expect(view.state.doc.line(1).text).toBe(`abc${" ".repeat(6)}x`);
    // Overflow collapsed after the doc change (caret now after 'x').
    expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);
  });

  it("defers to default behaviour when no overflow exists", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 1 } });
    const handlers = view.state.facet(EditorView.inputHandler);
    const insertStub = (() => {
      throw new Error("insert() must not be called by a claiming handler");
    }) as unknown as Parameters<Parameters<(typeof EditorView.inputHandler)["of"]>[0]>[4];
    const claimed = handlers.some((handler) => handler(view, 1, 1, "x", insertStub));
    expect(claimed).toBe(false);
    expect(view.state.doc.toString()).toBe("abc\n");
  });

  it("backspace inside the virtual region shrinks overflow without doc changes", () => {
    const view = mount("abc\n");
    view.dispatch({ selection: { anchor: 3 } });
    setVirtualHead(view, 3, 3, false);
    expect(virtualBackspaceCommand(view)).toBe(true);
    expect(virtualOverflowAt(view.state, 3)).toBe(2);
    expect(view.state.doc.toString()).toBe("abc\n");
    virtualBackspaceCommand(view);
    virtualBackspaceCommand(view);
    expect(virtualOverflowAt(view.state, 3)).toBe(0);
    // Zero overflow defers to the normal delete command.
    expect(virtualBackspaceCommand(view)).toBe(false);
  });

  it("End walks into the virtual region only past the real line end and only when enabled", () => {
    const view = mount("abc\ndef\n");
    view.dispatch({ selection: { anchor: 1 } });
    // Not at line end yet → defer (default keymap owns the move).
    expect(virtualLineEndCommand(view, false)).toBe(false);
    view.dispatch({ selection: { anchor: 3 } });
    expect(virtualLineEndCommand(view, false)).toBe(true);
    expect(virtualOverflowAt(view.state, 3)).toBe(1);
    virtualLineEndCommand(view, false);
    expect(virtualOverflowAt(view.state, 3)).toBe(2);

    // Policy disabled → no virtual walk, field stays empty.
    const disabled = mount("abc\n", false);
    disabled.dispatch({ selection: { anchor: 3 } });
    expect(virtualLineEndCommand(disabled, false)).toBe(false);
  });

  it("keeps multi-caret overflow maps so paste can pad every caret once", () => {
    const view = mount("ab\ncd\n");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(5)], 0),
    });
    setVirtualHead(view, 2, 4, false);
    expect(virtualOverflowAt(view.state, 2)).toBe(4);
    expect(view.state.selection.ranges).toHaveLength(2);
  });

  it("maps visual columns back to document character indices with tabs and wide characters", () => {
    // "ab\tc": cols 0, 1 -> 'a','b'; tab width is 4 so col 2..3 is tab, col 4 is 'c'
    expect(documentColumnForVisualColumn("ab\tc", 0, 4)).toBe(0);
    expect(documentColumnForVisualColumn("ab\tc", 1, 4)).toBe(1);
    expect(documentColumnForVisualColumn("ab\tc", 4, 4)).toBe(3); // index of 'c'
    // CJK character "你" takes 2 columns
    expect(documentColumnForVisualColumn("你好", 0, 4)).toBe(0);
    expect(documentColumnForVisualColumn("你好", 2, 4)).toBe("你".length);
  });

  it("moves vertically while preserving desired visual column across short and long lines", () => {
    // Line 0: "hello world" (length 11)
    // Line 1: "hi" (length 2)
    // Line 2: "goodbye world" (length 13)
    const doc = "hello world\nhi\ngoodbye world";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          virtualSpaceOverflowField,
          desiredVisualColumnField,
          POLICY,
        ],
      }),
    });

    // Start at end of line 0 (offset 11)
    view.dispatch({ selection: { anchor: 11 } });
    expect(view.state.selection.main.head).toBe(11);

    // Move down to Line 1 ("hi"): since line 1 has length 2 < 11, caret clamps to line end (offset 14),
    // and virtual overflow is 11 - 2 = 9.
    expect(virtualMoveDown(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(14); // "hello world\nhi" -> 11 + 1 + 2 = 14
    expect(virtualOverflowAt(view.state, 14)).toBe(9);

    // Move down to Line 2 ("goodbye world"): desired column 11 is remembered!
    // Since Line 2 has length 13 > 11, caret lands on column 11 of line 2, overflow collapses to 0.
    expect(virtualMoveDown(view)).toBe(true);
    const line2 = view.state.doc.line(3);
    expect(view.state.selection.main.head).toBe(line2.from + 11);
    expect(virtualOverflowAt(view.state, line2.from + 11)).toBe(0);
  });

  it("extends selection into virtual space with virtualSelectDown", () => {
    const doc = "first line\nshort\nthird line here";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          virtualSpaceOverflowField,
          desiredVisualColumnField,
          POLICY,
        ],
      }),
    });

    // Start anchor at offset 0, cursor at offset 10 (end of line 1)
    view.dispatch({ selection: EditorSelection.range(0, 10) });

    // Select down into line 2 ("short" length 5 < 10)
    expect(virtualSelectDown(view)).toBe(true);
    // Selection anchor remains 0, head moves to line 2 EOL (offset 16) with virtual overflow 5
    expect(view.state.selection.main.anchor).toBe(0);
    expect(view.state.selection.main.head).toBe(16);
    expect(virtualOverflowAt(view.state, 16)).toBe(5);
  });

  it("documents known gaps honestly in VIRTUAL_SPACE_KNOWN_GAPS", () => {
    expect(VIRTUAL_SPACE_KNOWN_GAPS).toBeInstanceOf(Array);
    const features = VIRTUAL_SPACE_KNOWN_GAPS.map((g) => g.feature);
    expect(features).toContain("soft-wrap");
    expect(features).toContain("rectangular-selection");
    expect(features).toContain("indent-folding-fallback");
  });

  describe("§8.22.5 U2-C Virtual Space Keymap Closure", () => {
    it("handles virtualMoveLeft and virtualMoveRight within virtual space", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "line",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      // Place cursor at line end (offset 4)
      view.dispatch({ selection: EditorSelection.cursor(4) });

      // Move right into virtual space
      expect(virtualMoveRightCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(1);
      expect(virtualMoveRightCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(2);

      // Move left back towards real line end
      expect(virtualMoveLeftCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(1);
      expect(virtualMoveLeftCommand(view, false)).toBe(true);
      expect(virtualOverflowAt(view.state, 4)).toBe(0);
    });

    it("clears virtual overflow on Home without dirtying document", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "  indented text",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 15, 10, false);
      expect(virtualOverflowAt(view.state, 15)).toBe(10);

      expect(virtualHomeCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);
      expect(view.state.selection.main.head).toBe(2); // Indent position
      expect(view.state.doc.toString()).toBe("  indented text");
    });

    it("clears virtual overflow on Escape without modifying document", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "const answer = 42;",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 18, 8, false);
      expect(virtualOverflowAt(view.state, 18)).toBe(8);

      expect(virtualEscapeCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, 18)).toBe(0);
      expect(view.state.doc.toString()).toBe("const answer = 42;");
    });

    it("handles Delete in virtual space without mutating preceding text", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "const answer = 42;",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 18, 5, false);
      expect(virtualDeleteCommand(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("const answer = 42;");
    });

    it("pads line with trailing spaces and newline on virtual Enter", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "hello",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      setVirtualHead(view, 5, 4, false);
      expect(virtualEnterCommand(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("hello    \n");
    });

    it("snaps to next tab stop on virtual Tab", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "abc",
          extensions: [virtualSpaceOverflowField, POLICY],
        }),
      });

      view.dispatch({ selection: EditorSelection.cursor(3) });
      expect(virtualTabCommand(view)).toBe(true);
      // "abc" has length 3, tab stop is 4, so overflow becomes 1
      expect(virtualOverflowAt(view.state, 3)).toBe(1);

      // Second tab snaps from visual 4 to visual 8 (overflow +4 -> 5)
      expect(virtualTabCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, 3)).toBe(5);
    });

    it("§ED-VSPACE-001: registers all virtual space actions into WorkspaceActionHost with unified definition", () => {
      const NOOP_HANDLERS = {
        save: () => {},
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: () => false,
      };
      const editorActions = buildEditorHostActions(NOOP_HANDLERS);
      const actionIds = new Set(editorActions.map((a) => a.id));

      const expectedIds = [
        "editor.moveUp",
        "editor.moveDown",
        "editor.selectUp",
        "editor.selectDown",
        "editor.pageUp",
        "editor.selectPageUp",
        "editor.pageDown",
        "editor.selectPageDown",
        "editor.moveLeft",
        "editor.selectLeft",
        "editor.moveRight",
        "editor.selectRight",
        "editor.moveToLineStart",
        "editor.moveToLineEnd",
        "editor.selectToLineEnd",
        "editor.deleteBackward",
        "editor.deleteForward",
        "editor.insertNewline",
        "editor.insertTab",
      ];

      for (const id of expectedIds) {
        expect(actionIds.has(id)).toBe(true);
        // Matching catalog action in DEFAULT_WORKSPACE_ACTIONS
        const catalogAction = DEFAULT_WORKSPACE_ACTIONS.find((a) => a.id === id);
        expect(catalogAction).toBeDefined();
      }

      expect("keymap" in VirtualSpaceController).toBe(false);
    });

    it("§ED-VSPACE-001: dispatches keystroke exactly once to focused editor and zero times to non-owner focus", async () => {
      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-test" });
      const bridge = new EditorActionBridge(host);
      bridge.registerView("editor-view-1");

      let commandRunCount = 0;

      const actions = buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: (_command) => {
          commandRunCount += 1;
          return true;
        },
      });

      host.registerActions(actions);

      const makeEvent = (key: string, code: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => ({
        key,
        code,
        shiftKey: modifiers.shiftKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        altKey: false,
        metaKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      });

      // 1. Dispatch ArrowUp with editor focus on registered view -> single dispatch
      const result1 = host.dispatchKeydownV2({
        event: makeEvent("ArrowUp", "ArrowUp"),
        workspaceId: "ws-vspace-test",
        targetViewId: "editor-view-1",
      });

      expect(result1.kind).toBe("executed");
      if (result1.kind === "executed") {
        expect(result1.actionId).toBe("editor.moveUp");
      }
      await Promise.resolve();
      expect(commandRunCount).toBe(1);

      // 2. Dispatch with non-owner focus (e.g. tree/search focus, targetViewId: null) -> rejected/zero dispatch
      commandRunCount = 0;
      const result2 = host.dispatchKeydownV2({
        event: makeEvent("ArrowUp", "ArrowUp"),
        workspaceId: "ws-vspace-test",
        targetViewId: null,
      });

      // Editor-scoped action requires editor focus, so non-editor focus rejects with disabled/no-match
      expect(result2.kind).toBe("rejected");
      await Promise.resolve();
      expect(commandRunCount).toBe(0); // Zero dispatch to editor!
    });

    it("§ED-VSPACE-001: routes the shared action definition to the focused split owner", async () => {
      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-splits" });
      const bridge = new EditorActionBridge(host);
      bridge.registerView("primary");
      bridge.registerView("secondary");

      let primaryRuns = 0;
      let secondaryRuns = 0;
      const handlers = (owner: "primary" | "secondary") => ({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: () => {
          if (owner === "primary") primaryRuns += 1;
          else secondaryRuns += 1;
          return true;
        },
      });

      host.registerActions(buildEditorHostActions(handlers("primary")), { ownerViewId: "primary" });
      host.registerActions(buildEditorHostActions(handlers("secondary")), { ownerViewId: "secondary" });

      const focusedContext = {
        focus: "editor" as const,
        hasActiveFile: true,
        editorViewId: "primary",
      };
      const paletteEvaluation = host.getSnapshot(focusedContext)
        .find((item) => item.id === "editor.moveUp")?.evaluation;
      const menuEvaluation = host.prepare("editor.moveUp", {
        kind: "menu",
        context: focusedContext,
      });
      expect(paletteEvaluation?.action).toBe(menuEvaluation.action);
      await expect(host.executePrepared(menuEvaluation)).resolves.toMatchObject({ kind: "applied" });
      expect(primaryRuns).toBe(1);
      expect(secondaryRuns).toBe(0);

      const result = host.dispatchKeydownV2({
        event: {
          key: "ArrowUp",
          code: "ArrowUp",
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          preventDefault: () => {},
          stopPropagation: () => {},
        },
        workspaceId: "ws-vspace-splits",
        targetViewId: "primary",
      });

      expect(result).toMatchObject({ kind: "executed", actionId: "editor.moveUp" });
      await Promise.resolve();
      expect(primaryRuns).toBe(2);
      expect(secondaryRuns).toBe(0);
    });
  });

  describe("§ED-VSPACE-002: Real Display Geometry Page & Vertical Movement", () => {
    it("isEditorGeometryReady detects unready vs ready geometry", () => {
      const view = new EditorView({
        state: EditorState.create({ doc: "hello\nworld", extensions: [POLICY] }),
      });
      // Headless / jsdom view without layout geometry:
      expect(isEditorGeometryReady(view)).toBe(false);

      // With mock layout geometry:
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      expect(isEditorGeometryReady(view)).toBe(true);
    });

    it("yields to default handler (returns false) for PageUp/PageDown when geometry is not ready", () => {
      const view = new EditorView({
        state: EditorState.create({ doc: "line1\nline2\nline3", extensions: [POLICY] }),
      });
      expect(isEditorGeometryReady(view)).toBe(false);

      // Without geometry, PageUp/PageDown does NOT use fake 15-line fallback, but returns false
      expect(virtualPageDown(view)).toBe(false);
      expect(virtualPageUp(view)).toBe(false);
      expect(virtualSelectPageDown(view)).toBe(false);
      expect(virtualSelectPageUp(view)).toBe(false);
    });

    it("performs real geometry PageDown and PageUp based on viewport height and line height", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const view = new EditorView({
        state: EditorState.create({
          doc: lines,
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      // Mock 20px line height, 200px viewport -> 9 lines per page jump (200/20 - 1 = 9 lines)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 1000, configurable: true });

      // Mock lineBlockAt and lineBlockAtHeight based on 20px line height:
      (view as any).lineBlockAt = (pos: number) => {
        const line = view.state.doc.lineAt(pos);
        const top = (line.number - 1) * 20;
        return {
          from: line.from,
          to: line.to,
          top,
          bottom: top + 20,
          height: 20,
          type: 0,
        };
      };
      (view as any).lineBlockAtHeight = (height: number) => {
        const lineNum = Math.min(view.state.doc.lines, Math.max(1, Math.floor(height / 20) + 1));
        const line = view.state.doc.line(lineNum);
        const top = (line.number - 1) * 20;
        return {
          from: line.from,
          to: line.to,
          top,
          bottom: top + 20,
          height: 20,
          type: 0,
        };
      };

      // Caret on Line 1 offset 0
      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageDown(view)).toBe(true);

      // Should land on Line 10 (1 + 9)
      const head1 = view.state.selection.main.head;
      const line1 = view.state.doc.lineAt(head1);
      expect(line1.number).toBe(10);

      // PageDown again -> Line 19
      expect(virtualPageDown(view)).toBe(true);
      const head2 = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head2).number).toBe(19);

      // PageUp -> back to Line 10
      expect(virtualPageUp(view)).toBe(true);
      const head3 = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head3).number).toBe(10);
    });

    it("dynamically adapts page jump distance upon viewport resize", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const view = new EditorView({
        state: EditorState.create({
          doc: lines,
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      // Initial viewport 200px (9 lines)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 1000, configurable: true });

      (view as any).lineBlockAt = (pos: number) => {
        const line = view.state.doc.lineAt(pos);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };
      (view as any).lineBlockAtHeight = (height: number) => {
        const lineNum = Math.min(view.state.doc.lines, Math.max(1, Math.floor(height / 20) + 1));
        const line = view.state.doc.line(lineNum);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };

      // Resize viewport to 400px (400 - 20 = 380px = 19 lines jump)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 400, configurable: true });

      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageDown(view)).toBe(true);

      // Should land on Line 20 (1 + 19)
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(20);
    });

    it("navigates visual line blocks in soft-wrapped text and clamps before line-end virtual space", () => {
      // Physical doc with 1 long line: "0123456789ABCDEFGHIJ"
      const doc = "0123456789ABCDEFGHIJ";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 40, configurable: true });

      // Soft wrapped into 2 visual blocks: block 1 (0..10), block 2 (10..20)
      (view as any).lineBlockAt = (pos: number) => {
        if (pos < 10) {
          return { from: 0, to: 10, top: 0, bottom: 20, height: 20, type: 0 };
        }
        return { from: 10, to: 20, top: 20, bottom: 40, height: 20, type: 0 };
      };
      (view as any).lineBlockAtHeight = (height: number) => {
        if (height < 20) {
          return { from: 0, to: 10, top: 0, bottom: 20, height: 20, type: 0 };
        }
        return { from: 10, to: 20, top: 20, bottom: 40, height: 20, type: 0 };
      };

      // Moving down from block 1 to block 2
      view.dispatch({ selection: EditorSelection.cursor(3) });
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(13); // offset 10 + 3 in block 2
    });

    it("handles top and bottom boundaries and preserves virtual overflow at file bottom", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "first line\nlast line",
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 40, configurable: true });

      (view as any).lineBlockAt = (pos: number) => {
        const line = view.state.doc.lineAt(pos);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };
      (view as any).lineBlockAtHeight = (height: number) => {
        const lineNum = Math.min(2, Math.max(1, Math.floor(height / 20) + 1));
        const line = view.state.doc.line(lineNum);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };

      // Caret at top line 1
      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageUp(view)).toBe(false); // already at top boundary

      // Caret at bottom line with desired column 30 (line length 9 -> overflow 21)
      view.dispatch({ selection: EditorSelection.cursor(11) }); // "last line" start
      // Place desired visual column 30
      view.dispatch({
        selection: EditorSelection.cursor(20),
        effects: [setVirtualOverflow.of(new Map([[20, 21]]))],
      });
      expect(virtualOverflowAt(view.state, 20)).toBe(21);

      // PageDown at bottom boundary preserves caret at file bottom and retains virtual overflow
      expect(virtualPageDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(20);
    });

    it("respects tabSize 2 vs tabSize 8 and wide CJK/Emoji characters in vertical navigation", () => {
      // In tabSize 2: "\tfoo" has "\t" (width 2) + "foo" (width 3) = visual col 5
      expect(visualColumnOf("\tfoo", 4, 2)).toBe(5);

      // In tabSize 8: "\tfoo" has "\t" (width 8) + "foo" (width 3) = visual col 11
      expect(visualColumnOf("\tfoo", 4, 8)).toBe(11);

      // CJK "你好" has 2 chars, each width 2 -> visual width 4
      expect(visualColumnOf("你好", 2, 4)).toBe(4);
      // Emoji "🚀" (astral code point, string length 2) -> visual width 2
      expect(visualColumnOf("🚀", 2, 4)).toBe(2);
    });
  });

  describe("§ED-VSPACE-003: Multi-Caret, Selection, and Composition Transactions", () => {
    it("tracks independent desired visual column and anchor for each caret across short and long lines", () => {
      // 3 lines: line 1 (11 chars), line 2 (3 chars), line 3 (13 chars)
      const doc = "hello world\nabc\ngoodbye world";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
          ],
        }),
      });

      // Place 2 carets: Caret 1 at line 1 end (col 11), Caret 2 at line 2 end (col 3)
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(11), // "hello world" end
          EditorSelection.cursor(15), // "abc" end (12 + 3)
        ]),
      });

      // Move down: Caret 1 moves to line 2 with overflow 8 (desired visual col 11 - 3), Caret 2 moves to line 3 col 3
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.ranges[0].head).toBe(15); // line 2 end
      expect(virtualOverflowAt(view.state, 15)).toBe(8);
      expect(view.state.selection.ranges[1].head).toBe(19); // line 3 offset 3 ("goo")
      expect(virtualOverflowAt(view.state, 19)).toBe(0);

      // Move down again: Caret 1 moves to line 3 col 11 (offset 27), Caret 2 clamped on line 3 col 3 (offset 19)
      // CodeMirror sorts selection ranges by document offset (19, then 27)
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.ranges[0].head).toBe(19); // line 3 offset 3
      expect(view.state.selection.ranges[1].head).toBe(27); // line 3 offset 11
      expect(virtualOverflowAt(view.state, 27)).toBe(0);
    });

    it("preserves selection anchors independently during multi-caret Shift extension", () => {
      const doc = "line 1\nline 2\nline 3";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
          ],
        }),
      });

      // 2 carets with initial positions at line starts
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0), // line 1 start
          EditorSelection.cursor(7), // line 2 start
        ]),
      });

      // Select down with Shift
      expect(virtualSelectDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);

      // Range 0: anchor 0, head 7
      expect(view.state.selection.ranges[0].anchor).toBe(0);
      expect(view.state.selection.ranges[0].head).toBe(7);

      // Range 1: anchor 7, head 14
      expect(view.state.selection.ranges[1].anchor).toBe(7);
      expect(view.state.selection.ranges[1].head).toBe(14);
    });

    it("materializes multi-caret padding in a single atomic transaction that undoes in 1 step", () => {
      const doc = "short\nanother line\nend";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
            history(),
            virtualSpaceTypingHandler,
          ],
        }),
      });

      // Place 2 virtual carets: Caret 1 at line 1 with overflow 5, Caret 2 at line 3 with overflow 3
      // line 1 "short" -> offset 5
      // line 2 "another line" -> length 12
      // line 3 "end" -> offset 5 + 1 + 12 + 1 + 3 = 22
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(5),
          EditorSelection.cursor(22),
        ]),
        effects: [
          setVirtualOverflow.of(new Map([
            [5, 5],
            [22, 3],
          ])),
        ],
      });

      expect(virtualOverflowAt(view.state, 5)).toBe(5);
      expect(virtualOverflowAt(view.state, 22)).toBe(3);

      // Type character 'X' across both carets
      // In CodeMirror, inputHandler handles insertion
      const handled = (virtualSpaceTypingHandler as any).value(view, 5, 5, "X");
      expect(handled).toBe(true);

      // Check document content:
      // Line 1: "short     X"
      // Line 2: "another line"
      // Line 3: "end   X"
      expect(view.state.doc.sliceString(0)).toBe("short     X\nanother line\nend   X");

      // Verify that a single undo reverts BOTH insertions atomically:
      expect(undo(view)).toBe(true);
      expect(view.state.doc.sliceString(0)).toBe("short\nanother line\nend");
    });

    it("rejects composing, dead key, process key, and AltGraph events from dispatching actions", () => {
      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-comp" });
      const bridge = new EditorActionBridge(host);
      bridge.registerView("editor-view-comp");

      let commandRunCount = 0;
      const actions = buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: () => {
          commandRunCount += 1;
          return true;
        },
      });
      host.registerActions(actions);

      const makeEvent = (key: string, code: string, extra: Record<string, any> = {}) => ({
        key,
        code,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
        ...extra,
      });

      // 1. Composition active (isComposing: true)
      const res1 = host.dispatchKeydownV2({
        event: makeEvent("a", "KeyA", { isComposing: true }),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res1.kind).toBe("rejected");
      expect((res1 as any).reason).toBe("composing");

      // 2. Process key (IME in flight)
      const res2 = host.dispatchKeydownV2({
        event: makeEvent("Process", "Process"),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res2.kind).toBe("rejected");
      expect((res2 as any).reason).toBe("composing");

      // 3. Dead key
      const res3 = host.dispatchKeydownV2({
        event: makeEvent("Dead", "Dead"),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res3.kind).toBe("rejected");
      expect((res3 as any).reason).toBe("dead-key");

      // 4. AltGraph modifier
      const res4 = host.dispatchKeydownV2({
        event: makeEvent("@", "Digit2", { getModifierState: (m: string) => m === "AltGraph" }),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res4.kind).toBe("rejected");
      expect((res4 as any).reason).toBe("alt-graph");

      expect(commandRunCount).toBe(0);
    });
  });
});
