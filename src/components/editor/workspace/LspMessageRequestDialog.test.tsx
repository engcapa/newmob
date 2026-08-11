import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspMessageRequestDialog } from "./LspMessageRequestDialog";

afterEach(() => cleanup());

describe("LspMessageRequestDialog", () => {
  it("renders every server action and returns the selected index", () => {
    const onSelect = vi.fn();
    render(
      <LspMessageRequestDialog
        request={{
          requestId: "message-1",
          workspaceId: "workspace-a",
          serverLabel: "Java",
          messageType: 2,
          message: "The project model changed",
          actions: [
            { title: "Reload", command: "reload" },
            { title: "Ignore" },
            { title: "Open settings" },
          ],
        }}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId("lsp-message-request-message")).toHaveTextContent(
      "The project model changed",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("maps Escape, dismiss, and Cancel to a null response", () => {
    const onSelect = vi.fn();
    render(
      <LspMessageRequestDialog
        request={{
          requestId: "message-2",
          workspaceId: "workspace-a",
          serverLabel: "TypeScript",
          messageType: 3,
          message: "Continue?",
          actions: [],
        }}
        onSelect={onSelect}
      />,
    );

    fireEvent.keyDown(screen.getByTestId("lsp-message-request-dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss language server message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenNthCalledWith(1, null);
    expect(onSelect).toHaveBeenNthCalledWith(2, null);
    expect(onSelect).toHaveBeenNthCalledWith(3, null);
  });
});
