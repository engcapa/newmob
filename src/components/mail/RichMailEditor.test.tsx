import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichMailEditor } from "./RichMailEditor";

describe("RichMailEditor", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the Thunderbird-style compose toolbar and editable body", () => {
    render(
      <RichMailEditor
        html="<p>Hello <strong>team</strong></p>"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mail-compose-format-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-format-block")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-font-family")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-font-size")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-text-color")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-bold")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-bullet-list")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-link")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-editor")).toHaveTextContent("Hello team");
  });

  it("emits sanitized HTML and plain text when the contenteditable body changes", () => {
    const onChange = vi.fn();
    render(<RichMailEditor html="<p><br></p>" onChange={onChange} />);

    const editor = screen.getByTestId("mail-compose-editor");
    editor.innerHTML = "<p>Hello<br>World</p>";
    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith("<p>Hello<br>World</p>", "Hello\nWorld");
  });

  it("executes toolbar commands and marks the draft as rich text", () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const onChange = vi.fn();
    const onRichFormatUsed = vi.fn();

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={onChange}
        onRichFormatUsed={onRichFormatUsed}
      />,
    );

    fireEvent.click(screen.getByTestId("mail-compose-bold"));

    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(onRichFormatUsed).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("<p>Hello</p>", "Hello");
  });

  it("opens the Thunderbird-style emoticon menu and inserts the selected emoticon", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<RichMailEditor html="<p>Hello</p>" onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId("mail-compose-emoji"));
    fireEvent.click(await screen.findByTestId("mail-compose-emoji-laugh"));

    expect(execCommand).toHaveBeenCalledWith("insertHTML", false, "😂");
  });

  it("inserts inline CID image HTML returned by the parent compose window", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={vi.fn()}
        onInlineImage={vi.fn(async () => "<img src=\"data:image/png;base64,aa\" data-taomni-cid=\"logo-1@inline.local\" alt=\"logo\">")}
      />,
    );

    fireEvent.click(screen.getByTestId("mail-compose-insert-menu"));
    fireEvent.click(await screen.findByTestId("mail-compose-insert-image"));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith(
        "insertHTML",
        false,
        "<img src=\"data:image/png;base64,aa\" data-taomni-cid=\"logo-1@inline.local\" alt=\"logo\">",
      );
    });
  });

  it("pastes clipboard images via the parent handler", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const onPasteImages = vi.fn(async () => [
      "<img src=\"data:image/png;base64,aa\" data-taomni-cid=\"paste@inline.local\" alt=\"pasted\">",
    ]);
    const file = new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={vi.fn()}
        onPasteImages={onPasteImages}
      />,
    );

    const editor = screen.getByTestId("mail-compose-editor");
    const clipboardData = {
      items: [{
        type: "image/png",
        getAsFile: () => file,
      }],
      files: [file],
      getData: () => "",
    };
    fireEvent.paste(editor, { clipboardData });

    await waitFor(() => {
      expect(onPasteImages).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledWith(
        "insertHTML",
        false,
        "<img src=\"data:image/png;base64,aa\" data-taomni-cid=\"paste@inline.local\" alt=\"pasted\">",
      );
    });
  });

  it("asks parent for native clipboard images when paste event has no image items", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const onPasteImages = vi.fn(async (files: File[]) => {
      expect(files).toEqual([]);
      return [
        "<img src=\"data:image/png;base64,bb\" data-taomni-cid=\"native@inline.local\" alt=\"native\">",
      ];
    });

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={vi.fn()}
        onPasteImages={onPasteImages}
      />,
    );

    const editor = screen.getByTestId("mail-compose-editor");
    // Linux WebKitGTK paste of a screenshot: no image/* items, no text.
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(onPasteImages).toHaveBeenCalledWith([]);
      expect(execCommand).toHaveBeenCalledWith(
        "insertHTML",
        false,
        "<img src=\"data:image/png;base64,bb\" data-taomni-cid=\"native@inline.local\" alt=\"native\">",
      );
    });
  });

  it("opens a full editing context menu with Markdown and plain-text paste", () => {
    render(<RichMailEditor html="<p>Hello</p>" onChange={vi.fn()} />);

    fireEvent.contextMenu(screen.getByTestId("mail-compose-editor"));

    expect(screen.getByTestId("mail-compose-context-undo")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-context-copy")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-context-paste")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-paste-plain-text")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-paste-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-context-select-all")).toBeInTheDocument();
  });

  it("pastes clipboard text as Markdown from the context menu", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "# Heading\n\n**bold**") },
    });
    const onChange = vi.fn();
    const onRichFormatUsed = vi.fn();
    render(<RichMailEditor html="<p>Hello</p>" onChange={onChange} onRichFormatUsed={onRichFormatUsed} />);

    fireEvent.contextMenu(screen.getByTestId("mail-compose-editor"));
    fireEvent.click(screen.getByTestId("mail-compose-paste-markdown"));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("insertHTML", false, expect.stringContaining("<h1>Heading</h1>"));
    });
    expect(onRichFormatUsed).toHaveBeenCalledTimes(1);
  });

  it("pastes clipboard text as plain text without marking rich format", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => "<not html>\nnext") },
    });
    const onRichFormatUsed = vi.fn();
    render(<RichMailEditor html="<p>Hello</p>" onChange={vi.fn()} onRichFormatUsed={onRichFormatUsed} />);

    fireEvent.contextMenu(screen.getByTestId("mail-compose-editor"));
    fireEvent.click(screen.getByTestId("mail-compose-paste-plain-text"));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("insertHTML", false, "&lt;not html&gt;<br>next");
    });
    expect(onRichFormatUsed).not.toHaveBeenCalled();
  });

  it("does not call native image paste when plain text is present", async () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const onPasteImages = vi.fn(async () => []);

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={vi.fn()}
        onPasteImages={onPasteImages}
      />,
    );

    fireEvent.paste(screen.getByTestId("mail-compose-editor"), {
      clipboardData: {
        items: [],
        files: [],
        getData: (type: string) => (type === "text/plain" ? "hello from clipboard" : ""),
      },
    });

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith(
        "insertHTML",
        false,
        "hello from clipboard",
      );
    });
    expect(onPasteImages).not.toHaveBeenCalled();
  });
});
