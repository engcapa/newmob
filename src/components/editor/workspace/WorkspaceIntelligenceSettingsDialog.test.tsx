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

    // Code completion fields
    fireEvent.click(screen.getByTestId("workspace-completion-auto-trigger"));
    fireEvent.change(screen.getByTestId("workspace-completion-trigger-delay"), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByTestId("workspace-completion-min-prefix"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByTestId("workspace-completion-max-items"), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByTestId("workspace-completion-show-doc"));
    fireEvent.change(screen.getByTestId("workspace-completion-doc-delay"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByTestId("workspace-completion-case-matching"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByTestId("workspace-completion-sort-mode"), {
      target: { value: "alphabetical" },
    });
    fireEvent.click(screen.getByTestId("workspace-completion-auto-insert-single"));
    fireEvent.change(screen.getByTestId("workspace-completion-excluded-symbols"), {
      target: { value: "java.awt.*, com.sun.*" },
    });
    fireEvent.change(screen.getByTestId("workspace-completion-prioritized-symbols"), {
      target: { value: "java.util.*" },
    });

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
      completion: {
        autoTrigger: false,
        triggerDelayMs: 150,
        minPrefixLength: 3,
        maxItems: 100,
        showDocumentation: false,
        documentationDelayMs: 500,
        caseMatching: "all",
        sortMode: "alphabetical",
        autoInsertSingle: true,
        excludedSymbols: [
          { pattern: "java.awt.*", scope: "project" },
          { pattern: "com.sun.*", scope: "project" },
        ],
        prioritizedSymbols: [
          { pattern: "java.util.*", scope: "project" },
        ],
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
          completion: {
            autoTrigger: false,
            triggerDelayMs: 400,
            minPrefixLength: 4,
            maxItems: 120,
            showDocumentation: false,
            documentationDelayMs: 600,
            caseMatching: "first-letter",
            sortMode: "provider-relevance",
            autoInsertSingle: false,
            excludedSymbols: [],
            prioritizedSymbols: [],
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
    expect(screen.getByTestId("workspace-completion-auto-trigger")).toBeChecked();
    expect(screen.getByTestId("workspace-completion-trigger-delay")).toHaveValue(50);
    expect(screen.getByTestId("workspace-completion-min-prefix")).toHaveValue(1);
    expect(screen.getByTestId("workspace-completion-max-items")).toHaveValue(50);
    expect(screen.getByTestId("workspace-completion-show-doc")).toBeChecked();
    expect(screen.getByTestId("workspace-completion-doc-delay")).toHaveValue(250);
  });
});
