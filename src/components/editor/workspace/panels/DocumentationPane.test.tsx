import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentationPane } from "./DocumentationPane";

describe("DocumentationPane", () => {
  it("shows empty guidance when nothing is pinned", () => {
    render(<DocumentationPane content={null} />);
    expect(screen.getByTestId("code-workspace-documentation-pane")).toHaveTextContent(
      /No pinned documentation/,
    );
  });

  it("renders pinned content and clear/unpin/source actions", () => {
    const onClear = vi.fn();
    const onUnlock = vi.fn();
    const onOpenSource = vi.fn();
    const content = {
      title: "CodeWorkspaceTab",
      body: "Main shell component.",
      source: "TypeScript Language Server",
      sourceLocation: {
        uri: "file:///repo/src/CodeWorkspaceTab.tsx",
        path: "/repo/src/CodeWorkspaceTab.tsx",
        range: {
          start: { line: 752, character: 16 },
          end: { line: 752, character: 32 },
        },
      },
    };
    render(
      <DocumentationPane
        content={content}
        locked
        onClear={onClear}
        onUnlock={onUnlock}
        onOpenSource={onOpenSource}
      />,
    );
    expect(screen.getByText("CodeWorkspaceTab")).toBeInTheDocument();
    expect(screen.getByText("Main shell component.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear documentation" }));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unpin documentation" }));
    expect(onUnlock).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onOpenSource).toHaveBeenCalledWith(content);
  });
});
