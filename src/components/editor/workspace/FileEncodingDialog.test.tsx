import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEncodingDialog } from "./FileEncodingDialog";

afterEach(cleanup);

describe("FileEncodingDialog", () => {
  it("converts the active buffer to a selected legacy encoding without a BOM", () => {
    const onConvert = vi.fn();
    const onClose = vi.fn();
    render(
      <FileEncodingDialog
        path="src/main.txt"
        currentEncoding="UTF-8"
        currentBom
        dirty
        onReload={vi.fn()}
        onConvert={onConvert}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "GBK" } });
    const bom = screen.getByRole("checkbox", { name: "Write byte-order marker (BOM)" });
    expect(bom).toBeDisabled();
    expect(bom).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Convert on Save" }));

    expect(onConvert).toHaveBeenCalledWith("GBK", false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reloads the disk bytes using the selected encoding", async () => {
    const onReload = vi.fn(async () => undefined);
    render(
      <FileEncodingDialog
        path="notes.txt"
        currentEncoding="windows-1252"
        currentBom={false}
        dirty={false}
        onReload={onReload}
        onConvert={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "UTF-16LE" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload from Disk" }));
    await waitFor(() => expect(onReload).toHaveBeenCalledWith("UTF-16LE"));
  });
});
