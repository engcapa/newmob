import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelectionAiToolbar } from "./EditorSelectionAiToolbar";

describe("EditorSelectionAiToolbar", () => {
  afterEach(() => cleanup());

  it("renders actions and routes clicks", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        onAction={onAction}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText("Explain"));
    fireEvent.click(screen.getByText("Syntax"));
    fireEvent.click(screen.getByText("Fix"));
    fireEvent.click(screen.getByText("Ask AI"));
    fireEvent.click(screen.getByTitle("Dismiss AI toolbar"));
    expect(onAction).toHaveBeenCalledWith("explain", "const value = 1;");
    expect(onAction).toHaveBeenCalledWith("syntax", "const value = 1;");
    expect(onAction).toHaveBeenCalledWith("fix", "const value = 1;");
    expect(onAction).toHaveBeenCalledWith("rewrite", "const value = 1;");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides when selection is too short", () => {
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="a"
        onAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("code-workspace-ai-selection-toolbar")).toBeNull();
  });

  it("shows the current answer language on the picker", () => {
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="zh-CN"
        onAction={vi.fn()}
        onSetAnswerLanguage={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("code-workspace-ai-answer-language").textContent).toContain("中文");
    // Collapsed until asked for, so it does not crowd the action buttons.
    expect(screen.queryByTestId("code-workspace-ai-answer-language-menu")).toBeNull();
  });

  it("opens a picker listing every language, marking the current one", () => {
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="en"
        onAction={vi.fn()}
        onSetAnswerLanguage={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("code-workspace-ai-answer-language"));

    // A dropdown rather than a cycle button: the options are visible, which is
    // what makes the setting discoverable at all.
    expect(screen.getByTestId("code-workspace-ai-answer-language-menu")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-ai-answer-language-inherit")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-ai-answer-language-auto")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-ai-answer-language-zh-CN")).toBeInTheDocument();
    expect(
      screen.getByTestId("code-workspace-ai-answer-language-en").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("code-workspace-ai-answer-language-auto").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reports the picked language and closes the picker", () => {
    const onSetAnswerLanguage = vi.fn();
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="inherit"
        onAction={vi.fn()}
        onSetAnswerLanguage={onSetAnswerLanguage}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("code-workspace-ai-answer-language"));
    fireEvent.click(screen.getByTestId("code-workspace-ai-answer-language-zh-CN"));

    expect(onSetAnswerLanguage).toHaveBeenCalledWith("zh-CN");
    expect(screen.queryByTestId("code-workspace-ai-answer-language-menu")).toBeNull();
  });

  it("labels the inherit and auto preferences distinctly", () => {
    const { rerender } = render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="inherit"
        onAction={vi.fn()}
        onSetAnswerLanguage={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("code-workspace-ai-answer-language").textContent).toContain("Default");

    rerender(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="auto"
        onAction={vi.fn()}
        onSetAnswerLanguage={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("code-workspace-ai-answer-language").textContent).toContain("Auto");

    rerender(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="en"
        onAction={vi.fn()}
        onSetAnswerLanguage={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("code-workspace-ai-answer-language").textContent).toContain("EN");
  });

  it("omits the language toggle when the host does not handle it", () => {
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        onAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("code-workspace-ai-answer-language")).toBeNull();
  });
});
