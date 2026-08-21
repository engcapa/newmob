import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        content={{ title: "openFile", body: "**Opens** a file." }}
        onClose={onClose}
        onPin={onPin}
      />,
    );

    expect(screen.getByTestId("code-workspace-quick-doc")).toBeInTheDocument();
    expect(screen.getByText("openFile")).toBeInTheDocument();
    expect(screen.getByText("Opens")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(onPin).toHaveBeenCalledWith({ title: "openFile", body: "**Opens** a file." });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("is focusable and provides an interactive resize handle", () => {
    render(
      <QuickDocPopup
        open
        content={{ title: "Method", body: "Description" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );

    const dialog = screen.getByTestId("code-workspace-quick-doc");
    expect(dialog).toHaveAttribute("tabIndex", "0");

    const resizeHandle = screen.getByTestId("code-workspace-quick-doc-resize-handle");
    expect(resizeHandle).toBeInTheDocument();

    // Start resize drag
    fireEvent.mouseDown(resizeHandle, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 250 });
    fireEvent.mouseUp(window);

    expect(dialog.style.width).toBe("560px");
    expect(dialog.style.height).toBe("470px");
  });

  it("hides when closed", () => {
    const { container } = render(
      <QuickDocPopup
        open={false}
        content={{ title: "x", body: "y" }}
        onClose={() => {}}
        onPin={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

