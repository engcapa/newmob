import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickDocPopup } from "./QuickDocPopup";

afterEach(cleanup);

describe("QuickDocPopup", () => {
  it("renders markdown body and supports pin / close / Escape", () => {
    const onClose = vi.fn();
    const onPin = vi.fn();
    render(
      <QuickDocPopup
        open
        content={{ title: "openFile", body: "**Opens** a file.", source: "TypeScript Language Server" }}
        onClose={onClose}
        onPin={onPin}
      />,
    );

    expect(screen.getByTestId("code-workspace-quick-doc")).toBeInTheDocument();
    expect(screen.getByText("openFile")).toBeInTheDocument();
    expect(screen.getByText("Opens")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(onPin).toHaveBeenCalledWith({
      title: "openFile",
      body: "**Opens** a file.",
      source: "TypeScript Language Server",
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("is focusable and provides interactive 4-corner resize handles", () => {
    render(
      <QuickDocPopup
        open
        content={{ title: "Method", body: "Description", source: "Language Server" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );

    const dialog = screen.getByTestId("code-workspace-quick-doc");
    expect(dialog).toHaveAttribute("tabIndex", "0");

    const resizeHandleSE = screen.getByTestId("code-workspace-quick-doc-resize-handle");
    expect(resizeHandleSE).toBeInTheDocument();

    // Start resize drag from SE (bottom-right)
    fireEvent.mouseDown(resizeHandleSE, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 250 });
    fireEvent.mouseUp(window);

    expect(dialog.style.width).toBe("560px");
    expect(dialog.style.height).toBe("470px");
  });

  it("disposes resize listeners when unmounted during a drag", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const result = render(
      <QuickDocPopup
        open
        content={{ title: "Method", body: "Description", source: "Language Server" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId("code-workspace-quick-doc-resize-handle"), {
      clientX: 100,
      clientY: 100,
    });
    result.unmount();
    expect(removeSpy.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["mousemove", "mouseup", "blur", "pointercancel"]),
    );
  });

  it("renders source metadata and drives Back and Forward controls", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const onOpenSource = vi.fn();
    const content = {
      title: "Method",
      body: "Description",
      source: "TypeScript Language Server",
      uri: "file:///repo/src/main.ts",
      sourceLocation: {
        uri: "file:///repo/src/main.ts",
        path: "/repo/src/main.ts",
        range: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 8 },
        },
      },
      revision: 4,
      generation: 2,
    };
    render(
      <QuickDocPopup
        open
        content={content}
        canGoBack
        canGoForward
        onBack={onBack}
        onForward={onForward}
        onOpenSource={onOpenSource}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );
    expect(screen.getByText("TypeScript Language Server")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous documentation" }));
    fireEvent.click(screen.getByRole("button", { name: "Next documentation" }));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
    expect(onOpenSource).toHaveBeenCalledWith(content);
  });

  it("does not offer source navigation for a provider document URI without a range", () => {
    render(
      <QuickDocPopup
        open
        content={{
          title: "Method",
          body: "Description",
          source: "TypeScript Language Server",
          uri: "file:///repo/src/main.ts",
        }}
        onOpenSource={vi.fn()}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Source" })).not.toBeInTheDocument();
  });

  it("restores the previous focus owner after Escape", async () => {
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Editor focus owner";
    document.body.appendChild(focusOwner);
    focusOwner.focus();
    const onClose = vi.fn();
    render(
      <QuickDocPopup
        open
        content={{ title: "Method", body: "Description", source: "Language Server" }}
        onClose={onClose}
        onPin={() => {}}
      />,
    );
    expect(screen.getByTestId("code-workspace-quick-doc")).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(focusOwner).toHaveFocus());
    focusOwner.remove();
  });

  it("hides when closed", () => {
    const { container } = render(
      <QuickDocPopup
        open={false}
        content={{ title: "x", body: "y", source: "Language Server" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

