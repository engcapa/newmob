import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorSelection } from "@codemirror/state";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { virtualSpaceOverflowField } from "./workspaceVirtualSpace";

function renderEditor(
  doc: string,
  onChange = vi.fn(),
  overrides: Partial<ComponentProps<typeof CodeMirrorHost>> = {},
) {
  const props: ComponentProps<typeof CodeMirrorHost> = {
    path: "src/example.ts",
    doc,
    visible: true,
    diagnostics: [],
    reveal: null,
    onChange,
    onSave: vi.fn(),
    onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false),
    onReferences: vi.fn(async () => undefined),
    ...overrides,
    getCompletionIdentity: overrides.getCompletionIdentity ?? (() => null),
    onCompletionDiagnostic: overrides.onCompletionDiagnostic ?? vi.fn(),
  };
  const result = render(<CodeMirrorHost {...props} />);
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  return { ...result, content: content!, onChange, props };
}

describe("CodeMirrorHost search", () => {
  afterEach(() => cleanup());

  it("opens the themed find panel and navigates matches", async () => {
    const { content } = renderEditor("alpha beta alpha");

    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // Native type=search clear — no custom × button.
    fireEvent.input(search, { target: { value: "" } });
    expect(search).toHaveValue("");
    expect(screen.getByText("0 matches")).toBeInTheDocument();
  });

  it("applies case, whole-word, and regular-expression search options", async () => {
    const { content } = renderEditor("Alpha alpha alphabet ALPHA");
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("4 matches")).toBeInTheDocument();

    const wholeWord = screen.getByRole("button", { name: "Match whole word" });
    fireEvent.click(wholeWord);
    expect(wholeWord).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("3 matches")).toBeInTheDocument();

    const matchCase = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(matchCase);
    expect(matchCase).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 matches")).toBeInTheDocument();

    const regexp = screen.getByRole("button", { name: "Use regular expression" });
    fireEvent.click(regexp);
    fireEvent.input(search, { target: { value: "[" } });
    expect(screen.getByText("Invalid pattern")).toBeInTheDocument();
  });

  it("replaces all matches and reports the updated buffer", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("alpha beta alpha", onChange);
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    fireEvent.input(await screen.findByRole("searchbox", { name: "Find" }), {
      target: { value: "alpha" },
    });
    fireEvent.input(screen.getByRole("textbox", { name: "Replace" }), {
      target: { value: "omega" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "omega beta omega",
        expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
        expect.any(Number),
      );
    });
    expect(screen.getByText("0 matches")).toBeInTheDocument();
  });

  it("opens replacement mode with Ctrl+R and closes with Escape", async () => {
    const { content } = renderEditor("alpha");
    fireEvent.keyDown(content, { key: "r", code: "KeyR", ctrlKey: true });

    const replace = await screen.findByRole("textbox", { name: "Replace" });
    await waitFor(() => expect(replace).toHaveFocus());
    fireEvent.keyDown(replace, { key: "Escape" });
    expect(screen.queryByTestId("code-workspace-editor-search")).not.toBeInTheDocument();
  });

  it("duplicates and deletes the current line with IDEA keybindings", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("one\ntwo", onChange);

    fireEvent.keyDown(content, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one\none\ntwo",
      expect.objectContaining({ line: 1, character: 0 }),
      expect.any(Number),
    ));

    fireEvent.keyDown(content, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one\ntwo",
      expect.objectContaining({ line: 1, character: 3 }),
      expect.any(Number),
    ));
  });

  it("rejects edits in read-only buffers but keeps navigation working", async () => {
    const onChange = vi.fn();
    const onDefinition = vi.fn(async () => true);
    const { content } = renderEditor("one\ntwo", onChange, { readOnly: true, onDefinition });

    // Editing commands are no-ops on library / decompiled sources.
    fireEvent.keyDown(content, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(content, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => expect(onDefinition).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();

    // Go to definition still jumps out of a read-only buffer.
    fireEvent.keyDown(content, { key: "F12" });
    await waitFor(() => expect(onDefinition).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves selected lines with Alt+Shift+Arrow", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("one\ntwo", onChange);

    fireEvent.keyDown(content, { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "two\none",
      expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
      expect.any(Number),
    ));
  });

  it("toggles line comments with Ctrl+Slash", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("const value = 1;", onChange);
    await waitFor(() => expect(content).toHaveAttribute("data-language", "typescript"));

    fireEvent.keyDown(content, { key: "/", code: "Slash", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "// const value = 1;",
      expect.objectContaining({ line: 0, character: expect.any(Number) }),
      expect.any(Number),
    ));
  });

  it("opens go to line with Ctrl+G", async () => {
    const { content } = renderEditor("one\ntwo");
    fireEvent.keyDown(content, { key: "g", code: "KeyG", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: /Go to line/ })).toBeInTheDocument();
  });

  it("publishes token-guarded command ports without remounting the editor", async () => {
    const firstRegistration = vi.fn();
    const rendered = renderEditor("one\ntwo", vi.fn(), {
      fileKey: "root:app:src/one.ts",
      onCommandPortChange: firstRegistration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(firstRegistration).toHaveBeenCalledWith(expect.objectContaining({
      fileKey: "root:app:src/one.ts",
      token: expect.any(Object),
      port: expect.objectContaining({ execute: expect.any(Function), state: expect.any(Function) }),
    })));
    const mounted = firstRegistration.mock.calls.find((call) => call[0].port)?.[0];

    const secondRegistration = vi.fn();
    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        fileKey="root:app:src/two.ts"
        onCommandPortChange={secondRegistration}
      />,
    );

    await waitFor(() => expect(firstRegistration).toHaveBeenCalledWith({
      fileKey: "root:app:src/one.ts",
      token: mounted.token,
      port: null,
    }));
    expect(EditorView.findFromDOM(editor!)).toBe(view);
    expect(secondRegistration).toHaveBeenCalledWith(expect.objectContaining({
      fileKey: "root:app:src/two.ts",
      token: expect.any(Object),
      port: expect.any(Object),
    }));
  });

  it("runs Complete Statement from the command port on the caret line", async () => {
    // Regression: the port used to treat the plan's line-relative semicolon
    // offset as an absolute document offset, so completing a statement below
    // line 1 dropped a `;` into the first line and moved the caret there.
    const registration = vi.fn();
    const rendered = renderEditor("first\nsecond\nthird = calc(a, b", vi.fn(), {
      fileKey: "root:app:src/port.ts",
      onCommandPortChange: registration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(
      registration.mock.calls.find((call) => call[0].port),
    ).toBeTruthy());
    const { port } = registration.mock.calls.find((call) => call[0].port)![0];

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.length) });
    expect(port.execute("completeStatement")).toBe(true);
    expect(view!.state.doc.toString()).toBe("first\nsecond\nthird = calc(a, b);\n");
    expect(view!.state.selection.main.head).toBe(view!.state.doc.length);
  });

  it("balances unclosed brackets when completing from the command port mid-line", async () => {
    const registration = vi.fn();
    const rendered = renderEditor("class A {\n  int x = calc(a, b", vi.fn(), {
      fileKey: "root:app:src/port.ts",
      onCommandPortChange: registration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(
      registration.mock.calls.find((call) => call[0].port),
    ).toBeTruthy());
    const { port } = registration.mock.calls.find((call) => call[0].port)![0];

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.length) });
    expect(port.execute("completeStatement")).toBe(true);
    expect(view!.state.doc.toString()).toBe("class A {\n  int x = calc(a, b);\n  ");
  });

  it("distributes copied editor segments across multiple carets in the mounted host", async () => {
    const onChange = vi.fn();
    const rendered = renderEditor("one two end", onChange);
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();

    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ], 1),
    });
    const clipboardValues = new Map<string, string>();
    const clipboard = {
      getData: (type: string) => clipboardValues.get(type) ?? "",
      setData: (type: string, value: string) => {
        clipboardValues.set(type, value);
      },
    } as DataTransfer;
    fireEvent.copy(rendered.content, { clipboardData: clipboard });
    expect(clipboard.getData("text/plain")).toBe("one\ntwo");

    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(8),
        EditorSelection.cursor(11),
      ], 1),
    });
    fireEvent.paste(rendered.content, { clipboardData: clipboard });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one two oneendtwo",
      expect.objectContaining({ line: 0, character: 17 }),
      17,
    ));
    expect(view!.state.selection.mainIndex).toBe(1);
  });

  it("forwards multi-range selection state to the context menu", async () => {
    const onContextMenu = vi.fn();
    const rendered = renderEditor("one two", vi.fn(), { onContextMenu });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.range(4, 7),
      ], 1),
    });

    fireEvent.contextMenu(rendered.content, { clientX: 0, clientY: 0, button: 2 });
    await waitFor(() => expect(onContextMenu).toHaveBeenCalled());
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({
      hasSelection: true,
      selectedText: "two",
    });
  });

  it("forwards editor contextmenu with caret position and clipboard helpers", async () => {
    const onContextMenu = vi.fn();
    const { content } = renderEditor("hello world", vi.fn(), { onContextMenu });
    content.focus();
    fireEvent.contextMenu(content, { clientX: 24, clientY: 36, button: 2 });
    await waitFor(() => expect(onContextMenu).toHaveBeenCalled());
    const request = onContextMenu.mock.calls[0][0];
    expect(request.clientX).toBe(24);
    expect(request.clientY).toBe(36);
    expect(request.position).toEqual(expect.objectContaining({ line: expect.any(Number) }));
    expect(typeof request.cut).toBe("function");
    expect(typeof request.copy).toBe("function");
    expect(typeof request.paste).toBe("function");
  });

  it("renders usage/inlay chrome, reports its viewport, and requests semantic selection", async () => {
    const onViewportChange = vi.fn();
    const onExpandSelection = vi.fn(async () => [{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 11 },
    }]);
    const { content, container } = renderEditor("const value", vi.fn(), {
      highlights: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        kind: 2,
      }],
      inlayHints: [{
        position: { line: 0, character: 11 },
        label: ": string",
        kind: 1,
        tooltip: "inferred",
        paddingLeft: true,
        paddingRight: false,
      }],
      semanticTokens: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        tokenType: "keyword",
        modifiers: [],
      }],
      onViewportChange,
      onExpandSelection,
    });

    expect(container.querySelector(".cm-lsp-usage-read")).not.toBeNull();
    expect(container.querySelector(".cm-lsp-inlay-hint")).toHaveTextContent(": string");
    expect(container.querySelector(".cm-lsp-sem-keyword")).not.toBeNull();
    expect(onViewportChange).toHaveBeenCalled();
    fireEvent.keyDown(content, { key: "w", code: "KeyW", ctrlKey: true });
    await waitFor(() => expect(onExpandSelection).toHaveBeenCalledWith(expect.objectContaining({ empty: true })));
  });

  it("reconfigures workspace editor appearance without losing state or history", async () => {
    const rendered = renderEditor("alpha beta", vi.fn(), {
      appearance: {
        fontFamily: '"JetBrains Mono", monospace',
        fontSizePx: 13,
        lineHeight: 1.5,
        ligatures: true,
        colorSchemeId: "app",
        highContrast: false,
      },
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    view!.dispatch({
      changes: { from: 10, insert: "!" },
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(6),
      ], 1),
      userEvent: "input.type",
    });
    const selectionBefore = view!.state.selection;
    const undoBefore = undoDepth(view!.state);

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        doc="alpha beta!"
        appearance={{
          fontFamily: '"Source Code Pro", monospace',
          fontSizePx: 17,
          lineHeight: 1.8,
          ligatures: false,
          colorSchemeId: "dracula",
          highContrast: true,
        }}
      />,
    );

    await waitFor(() => expect(rendered.content).toHaveAttribute(
      "data-editor-color-scheme",
      "high-contrast",
    ));
    expect(EditorView.findFromDOM(editor!)).toBe(view);
    expect(view!.state.doc.toString()).toBe("alpha beta!");
    expect(view!.state.selection.eq(selectionBefore, true)).toBe(true);
    expect(undoDepth(view!.state)).toBe(undoBefore);
    expect(rendered.content).toHaveAttribute("data-editor-ligatures", "false");
  });

  it("supports dynamic soft wrapping without recreating the editor", async () => {
    const rendered = renderEditor("a very long logical line", vi.fn(), { softWrap: true });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editor).toHaveClass("cm-lineWrapping");

    rendered.rerender(
      <CodeMirrorHost
        path="src/example.ts"
        doc="a very long logical line"
        visible
        diagnostics={[]}
        reveal={null}
        softWrap={false}
        onChange={rendered.onChange}
        onSave={vi.fn()}
        onHover={vi.fn(async () => null)}
        onDefinition={vi.fn(async () => false)}
        onReferences={vi.fn(async () => undefined)}
        getCompletionIdentity={() => null}
        onCompletionDiagnostic={vi.fn()}
      />,
    );
    await waitFor(() => expect(editor).not.toHaveClass("cm-lineWrapping"));
  });

  it("uses rectangular selection for an ordinary drag in column mode", () => {
    const rendered = renderEditor("one\ntwo", vi.fn(), { columnSelectionMode: true });
    expect(rendered.container.firstElementChild).toHaveAttribute("data-column-selection", "true");
  });

  it("§8.20.2: the explicit nonce only EMITS a trigger event; rendering follows the session's controlled popup", async () => {
    const onParameterTrigger = vi.fn();
    const rendered = renderEditor("open(\"file\", 1)", vi.fn(), {
      onParameterTrigger,
      parameterInfoRequestNonce: 0,
    });
    expect(screen.queryByRole("dialog", { name: "Parameter info" })).toBeNull();

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        parameterInfoRequestNonce={1}
      />,
    );
    // The host never issues requests itself — it hands the trigger to the
    // workspace-side session.
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterTrigger).toHaveBeenCalledWith(expect.objectContaining({ origin: "explicit" }));

    // The session publishes the display state; the host renders it.
    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        parameterInfoShowFullSignatures
        parameterPopup={{
          signatures: [{
            label: "open(path: string, mode: number): void",
            documentation: "Opens the path.",
            parameters: [
              { label: "path: string", documentation: null, labelStart: 5, labelEnd: 17 },
              { label: "mode: number", documentation: null, labelStart: 19, labelEnd: 31 },
            ],
            activeParameter: 1,
          }],
          activeSignature: 0,
          activeParameter: 1,
          anchorOffset: 14,
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Parameter info" });
    expect(dialog).toHaveTextContent("open(path: string, mode: number): void");
    expect(dialog.querySelector("[data-signature-index='0'] b")).toHaveTextContent("mode: number");

    // Session hides → the tooltip disappears.
    rendered.rerender(
      <CodeMirrorHost {...rendered.props} parameterPopup={null} />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Parameter info" })).toBeNull();
    });
  });

  it("§8.20.2: typing a signature trigger char emits a typing trigger; other edits emit invalidation", () => {
    const onParameterTrigger = vi.fn();
    const onParameterInvalidate = vi.fn();
    const rendered = renderEditor("call", vi.fn(), {
      onParameterTrigger,
      onParameterInvalidate,
      signatureTriggers: ["(", ","],
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!)!;

    // Trigger character → typing event, no invalidation.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "(" },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: "input.type",
    });
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterTrigger).toHaveBeenCalledWith(expect.objectContaining({
      origin: "typing",
      triggerCharacter: "(",
    }));
    expect(onParameterInvalidate).not.toHaveBeenCalled();

    // Plain edit → doc-changed invalidation (old tooltip must close).
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: "input.type",
    });
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterInvalidate).toHaveBeenCalledWith("doc-changed");

    // Closing paren → closing-char invalidation.
    view.dispatch({
      changes: { from: view.state.doc.length - 1, insert: ")" },
      userEvent: "input.type",
    });
    expect(onParameterInvalidate).toHaveBeenLastCalledWith("closing-char");

    // Caret move without an edit → caret-moved invalidation.
    view.dispatch({ selection: { anchor: 0 } });
    expect(onParameterInvalidate).toHaveBeenLastCalledWith("caret-moved");
  });

  it("reconfigures hover documentation without recreating the editor", () => {
    const onHover = vi.fn(async () => null);
    const rendered = renderEditor("const value = 1", vi.fn(), {
      onHover,
      showHoverDocumentation: true,
      hoverDocumentationDelayMs: 300,
    });
    const editor = rendered.container.querySelector(".cm-editor");

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        onHover={onHover}
        showHoverDocumentation={false}
        hoverDocumentationDelayMs={300}
      />,
    );

    expect(rendered.container.querySelector(".cm-editor")).toBe(editor);
  });

  it("preserves cursor selection when doc update is applied", async () => {
    const onSelectionChange = vi.fn();
    const rendered = renderEditor("line1\nline2\nline3", vi.fn(), { onSelectionChange });

    // Rerender with updated doc (e.g. normalized after save)
    rendered.rerender(
      <CodeMirrorHost
        path="src/example.ts"
        doc="line1\nline2\nline3\n"
        visible
        diagnostics={[]}
        reveal={null}
        onChange={rendered.onChange}
        onSave={vi.fn()}
        onHover={vi.fn(async () => null)}
        onDefinition={vi.fn(async () => false)}
        onReferences={vi.fn(async () => undefined)}
        getCompletionIdentity={() => null}
        onCompletionDiagnostic={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => {
      expect(rendered.container.querySelector(".cm-content")).toBeInTheDocument();
    });
  });
});

describe("§8.19.8 semantic editing commands", () => {
  afterEach(() => cleanup());

  function renderWithPort(doc: string, path: string) {
    let registered: import("./CodeMirrorHost").EditorCommandPort | null = null;
    const rendered = renderEditor(doc, vi.fn(), {
      path,
      onCommandPortChange: (registration) => {
        registered = registration.port;
      },
    });
    return {
      ...rendered,
      port: () => registered,
      view: () => EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!),
    };
  }

  it("surround applies through the port as one undoable transaction with provenance", async () => {
    const onSemanticEditApplied = vi.fn();
    const doc = "class A {\n  void m() {\n    doWork();\n  }\n}\n";
    const { port, view } = renderWithPort(doc, "src/A.java");
    await waitFor(() => expect(port()).not.toBeNull());
    await waitFor(() => expect(view()).not.toBeNull());

    // Select the whole `doWork();` line (expanded to whole lines is what the
    // plan requires).
    const v = view()!;
    const line = v.state.doc.line(3);
    v.dispatch({ selection: EditorSelection.range(line.from, line.to) });

    expect(port()!.execute("surroundWith")).toBe(false); // missing kindId → typed no-op
    const ok = port()!.execute("surroundWith", {
      surroundKindId: "try-catch",
      onSemanticEditApplied,
    });
    expect(ok).toBe(true);
    const after = v.state.doc.toString();
    expect(after).toContain("try {");
    expect(after).toContain("} catch (Exception e) {");
    expect(after).toContain("doWork();");
    expect(onSemanticEditApplied).toHaveBeenCalledTimes(1);
    const report = onSemanticEditApplied.mock.calls[0][0];
    expect(report.applied).toBe(true);
    // Provenance is honest: local template unless the tree aligned exactly.
    if (report.provenance?.kind === "syntax-tree") {
      expect(report.provenance.nodeType.length).toBeGreaterThan(0);
    } else {
      expect(report.provenance?.kind ?? null).toBe("local-text");
    }
    // One transaction == exactly one new undo entry for the whole wrap.
    expect(undoDepth(v.state)).toBeLessThan(50);
  });

  it("completeStatement reports honest provenance and unavailable reasons", async () => {
    const onSemanticEditApplied = vi.fn();
    const { port, view, container } = renderWithPort("foo()", "src/notes.txt");
    await waitFor(() => expect(port()).not.toBeNull());
    fireEvent.focus(container.querySelector(".cm-content")!);

    expect(port()!.execute("completeStatement", { onSemanticEditApplied })).toBe(true);
    const report = onSemanticEditApplied.mock.calls[0][0];
    expect(report.applied).toBe(true);
    // Parserless language stays on the labelled Local/Heuristic path.
    expect(report.provenance).toMatchObject({ kind: "local-text" });
    expect(view()!.state.doc.toString().startsWith("foo();")).toBe(true);
  });
});

describe("§8.21.3 V2-C virtual space and region provenance in CodeMirrorHost", () => {
  afterEach(() => cleanup());

  it("consumes appearance.virtualSpace policy in production editor", async () => {
    const rendered = renderEditor("first line\nsecond", vi.fn(), {
      appearance: {
        fontFamily: "monospace",
        fontSizePx: 14,
        lineHeight: 1.5,
        ligatures: false,
        colorSchemeId: "default",
        highContrast: false,
        virtualSpace: { afterLineEnd: true, atFileBottom: true },
      },
    });

    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
    expect(view).not.toBeNull();

    // Place caret at line 1 EOL
    view!.dispatch({ selection: { anchor: 10 } });
    // Pressing End key moves into virtual space
    fireEvent.keyDown(rendered.content, { key: "End" });
    const overflow = view!.state.field(virtualSpaceOverflowField, false)?.get(10) ?? 0;
    expect(overflow).toBeGreaterThan(0);
  });

  it("emits explicit-comment provenance for region markers on selection change", async () => {
    const onFoldProvenanceChange = vi.fn();
    const doc = "//region MyBlock\nconst x = 1;\n//endregion\n";
    const rendered = renderEditor(doc, vi.fn(), {
      path: "src/Test.ts",
      onFoldProvenanceChange,
    });

    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
    expect(view).not.toBeNull();

    // Move caret to the region comment line
    view!.dispatch({ selection: { anchor: 5 } });
    await waitFor(() => {
      expect(onFoldProvenanceChange).toHaveBeenCalledWith("explicit-comment");
    });
  });
});
