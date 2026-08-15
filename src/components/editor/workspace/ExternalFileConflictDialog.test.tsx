import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExternalFileConflictDialog,
  initialExternalMergeText,
} from "./ExternalFileConflictDialog";

afterEach(() => cleanup());

describe("ExternalFileConflictDialog", () => {
  it("offers local, disk, and merge resolutions for concurrent edits", () => {
    const onKeepLocal = vi.fn();
    const onLoadDisk = vi.fn();
    const onApplyMerge = vi.fn();
    render(
      <ExternalFileConflictDialog
        path="/repo/src/Main.ts"
        baseText="const value = 1;"
        localText="const value = 2;"
        diskText="const value = 3;"
        onKeepLocal={onKeepLocal}
        onLoadDisk={onLoadDisk}
        onApplyMerge={onApplyMerge}
        onCancel={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load Disk" }));
    expect(onLoadDisk).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const result = screen.getByRole("textbox", { name: "Merge result" });
    expect((result as HTMLTextAreaElement).value).toContain("<<<<<<< LOCAL");
    fireEvent.change(result, { target: { value: "const value = 4;" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply Merge" }));
    expect(onApplyMerge).toHaveBeenCalledWith("const value = 4;");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep Local" }));
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
  });

  it("keeps a deleted dirty file recoverable instead of offering a missing disk version", () => {
    const onKeepLocal = vi.fn();
    render(
      <ExternalFileConflictDialog
        path="/repo/src/Main.ts"
        baseText="saved"
        localText="local"
        diskText={null}
        onKeepLocal={onKeepLocal}
        onLoadDisk={() => undefined}
        onApplyMerge={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByText(/deleted on disk/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close File" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load Disk" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep Local" }));
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
  });

  it("fast-forwards a merge result when only one side changed", () => {
    expect(initialExternalMergeText("base", "base", "disk")).toBe("disk");
    expect(initialExternalMergeText("base", "local", "base")).toBe("local");
    expect(initialExternalMergeText("base", "same", "same")).toBe("same");
  });
});
