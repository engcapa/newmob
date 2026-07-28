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
});
