import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  type WorkspaceTabPolicyV3,
} from "./workspaceTabPolicy";
import { WorkspaceTabPolicySettingsDialog } from "./WorkspaceTabPolicySettingsDialog";

afterEach(cleanup);

describe("WorkspaceTabPolicySettingsDialog", () => {
  it("renders all policy fields with default values", () => {
    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={DEFAULT_WORKSPACE_TAB_POLICY_V3}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-tab-policy-limit")).toHaveValue(12);
    expect(screen.getByTestId("workspace-tab-policy-order")).toHaveValue("open-order");
    expect(screen.getByTestId("workspace-tab-policy-open-position")).toHaveValue("end");
    expect(screen.getByTestId("workspace-tab-policy-activate-on-close")).toHaveValue("mru");
    expect(screen.getByTestId("workspace-tab-policy-pinned-row")).toHaveValue("same");
    expect(screen.getByTestId("workspace-tab-policy-preview-mode")).toBeChecked();
    expect(screen.getByTestId("workspace-tab-policy-reuse-preview")).toBeChecked();
  });

  it("edits fields and calls onApply with clamped limit", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={DEFAULT_WORKSPACE_TAB_POLICY_V3}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-tab-policy-limit"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByTestId("workspace-tab-policy-order"), {
      target: { value: "alphabetical" },
    });
    fireEvent.change(screen.getByTestId("workspace-tab-policy-open-position"), {
      target: { value: "after-active" },
    });
    fireEvent.change(screen.getByTestId("workspace-tab-policy-activate-on-close"), {
      target: { value: "left" },
    });
    fireEvent.change(screen.getByTestId("workspace-tab-policy-pinned-row"), {
      target: { value: "separate" },
    });
    fireEvent.click(screen.getByTestId("workspace-tab-policy-preview-mode"));

    fireEvent.click(screen.getByTestId("workspace-tab-policy-apply"));

    expect(onApply).toHaveBeenCalledWith({
      schemaVersion: 3,
      limitPerLeaf: 20,
      order: "alphabetical",
      openPosition: "after-active",
      activateOnClose: "left",
      pinnedRow: "separate",
      previewMode: false,
      reusePreview: true,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("previews candidate evictions when limit is reduced below open tabs", () => {
    const openTabs = [
      { key: "a.ts", title: "a.ts", dirty: false, pinned: false },
      { key: "b.ts", title: "b.ts", dirty: false, pinned: false },
      { key: "dirty.ts", title: "dirty.ts", dirty: true, pinned: false },
      { key: "pinned.ts", title: "pinned.ts", dirty: false, pinned: true },
    ];

    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={DEFAULT_WORKSPACE_TAB_POLICY_V3}
        openTabs={openTabs}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-tab-policy-limit"), {
      target: { value: "2" },
    });

    const preview = screen.getByTestId("workspace-tab-policy-eviction-preview");
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveTextContent("Tightening limit to 2 will evict 2 tab(s)");
    // b.ts is least recently used (lowest simulated timestamp based on index)
    expect(preview).toHaveTextContent("b.ts");
  });

  it("shows protected over-limit warning when all open tabs are protected", () => {
    const openTabs = [
      { key: "dirty1.ts", title: "dirty1.ts", dirty: true, pinned: false },
      { key: "pinned1.ts", title: "pinned1.ts", dirty: false, pinned: true },
    ];

    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={DEFAULT_WORKSPACE_TAB_POLICY_V3}
        openTabs={openTabs}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-tab-policy-limit"), {
      target: { value: "1" },
    });

    const warning = screen.getByTestId("workspace-tab-policy-over-limit-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent("Tab limit (1) reached with no closable tab");
  });

  it("resets to default policy when reset button is clicked", () => {
    const custom: WorkspaceTabPolicyV3 = {
      schemaVersion: 3,
      limitPerLeaf: 5,
      order: "mru",
      openPosition: "after-active",
      activateOnClose: "right",
      pinnedRow: "separate",
      previewMode: false,
      reusePreview: false,
    };

    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={custom}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("workspace-tab-policy-limit")).toHaveValue(5);
    fireEvent.click(screen.getByTestId("workspace-tab-policy-reset"));
    expect(screen.getByTestId("workspace-tab-policy-limit")).toHaveValue(12);
    expect(screen.getByTestId("workspace-tab-policy-order")).toHaveValue("open-order");
  });

  it("cancels without applying when cancel button is clicked", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();

    render(
      <WorkspaceTabPolicySettingsDialog
        open
        policy={DEFAULT_WORKSPACE_TAB_POLICY_V3}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-tab-policy-limit"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("workspace-tab-policy-cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
