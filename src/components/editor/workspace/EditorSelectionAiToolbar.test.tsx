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

  it("shows the answer language and routes the cycle click", () => {
    const onCycleAnswerLanguage = vi.fn();
    render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="zh-CN"
        onAction={vi.fn()}
        onCycleAnswerLanguage={onCycleAnswerLanguage}
        onDismiss={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId("code-workspace-ai-answer-language");
    expect(toggle.textContent).toContain("中文");
    fireEvent.click(toggle);
    expect(onCycleAnswerLanguage).toHaveBeenCalledTimes(1);
  });

  it("labels auto and English preferences", () => {
    const { rerender } = render(
      <EditorSelectionAiToolbar
        visible
        rect={{ top: 40, left: 20, right: 120, bottom: 60 }}
        selectionText="const value = 1;"
        answerLanguage="auto"
        onAction={vi.fn()}
        onCycleAnswerLanguage={vi.fn()}
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
        onCycleAnswerLanguage={vi.fn()}
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
