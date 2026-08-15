import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRecoveryDialog } from "./WorkspaceRecoveryDialog";
import type { WorkspaceRecoveryEntry } from "./workspaceRecovery";

afterEach(() => cleanup());

const recovery: WorkspaceRecoveryEntry = {
  workspaceId: "ws",
  key: "root:root:src/Main.ts",
  ref: { kind: "root", rootId: "root", path: "src/Main.ts" },
  path: "/repo/src/Main.ts",
  text: "const value = 2;",
  savedText: "const value = 1;",
  eol: "LF",
  hash: "hash",
  mtime: 1,
  size: 16,
  capturedAt: Date.now(),
};

describe("WorkspaceRecoveryDialog", () => {
  it("recovers or discards the selected buffer", () => {
    const onRecover = vi.fn();
    const onDiscard = vi.fn();
    render(
      <WorkspaceRecoveryDialog
        entries={[recovery]}
        onRecover={onRecover}
        onDiscard={onDiscard}
        onRecoverAll={() => undefined}
        onDiscardAll={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("const value = 2;")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover selected" }));
    expect(onRecover).toHaveBeenCalledWith(recovery);
    fireEvent.click(screen.getByRole("button", { name: "Discard selected" }));
    expect(onDiscard).toHaveBeenCalledWith(recovery);
  });

  it("offers bulk actions and decide-later close", () => {
    const onRecoverAll = vi.fn();
    const onDiscardAll = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceRecoveryDialog
        entries={[recovery]}
        onRecover={() => undefined}
        onDiscard={() => undefined}
        onRecoverAll={onRecoverAll}
        onDiscardAll={onDiscardAll}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    fireEvent.click(screen.getByRole("button", { name: "Recover all" }));
    fireEvent.click(screen.getByRole("button", { name: "Decide later" }));
    expect(onRecoverAll).toHaveBeenCalledTimes(1);
    expect(onDiscardAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
