import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceIntelligenceSettingsDialog } from "./WorkspaceIntelligenceSettingsDialog";
import { DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES } from "./intelligencePreferences";

afterEach(cleanup);

describe("WorkspaceIntelligenceSettingsDialog", () => {
  it("applies normalized QuickDoc and Parameter Info preferences", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceIntelligenceSettingsDialog
        open
        preferences={DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-quick-doc-hover-enabled"));
    fireEvent.change(screen.getByTestId("workspace-quick-doc-hover-delay"), {
      target: { value: "750" },
    });
    fireEvent.change(screen.getByTestId("workspace-quick-doc-default-target"), {
      target: { value: "tool-window" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-auto-popup"));
    fireEvent.change(screen.getByTestId("workspace-parameter-info-delay"), {
      target: { value: "350" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-full-signatures"));
    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-apply"));

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 750,
        defaultTarget: "tool-window",
      },
      parameterInfo: {
        autoPopup: false,
        delayMs: 350,
        showFullSignatures: true,
      },
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("resets the draft without mutating until Apply", () => {
    const onApply = vi.fn();
    render(
      <WorkspaceIntelligenceSettingsDialog
        open
        preferences={{
          ...DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES,
          quickDoc: {
            showOnHover: false,
            hoverDelayMs: 900,
            defaultTarget: "tool-window",
          },
          parameterInfo: {
            autoPopup: false,
            delayMs: 400,
            showFullSignatures: true,
          },
        }}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-reset"));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-quick-doc-hover-enabled")).toBeChecked();
    expect(screen.getByTestId("workspace-quick-doc-hover-delay")).toHaveValue(300);
    expect(screen.getByTestId("workspace-parameter-info-auto-popup")).toBeChecked();
    expect(screen.getByTestId("workspace-parameter-info-delay")).toHaveValue(0);
  });
});
