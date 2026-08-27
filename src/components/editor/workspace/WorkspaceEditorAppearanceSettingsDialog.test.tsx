import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_APPEARANCE_PROFILE,
  type EditorAppearanceProfile,
} from "./editorAppearanceProfile";
import { WorkspaceEditorAppearanceSettingsDialog } from "./WorkspaceEditorAppearanceSettingsDialog";

const customProfile: EditorAppearanceProfile = {
  ...DEFAULT_EDITOR_APPEARANCE_PROFILE,
  fontFamily: "Fira Code, monospace",
  fontSizePx: 17,
  lineHeight: 1.7,
  ligatures: false,
  colorSchemeId: "night-owl",
  highContrast: true,
  zoomScope: "active-editor",
  softWrap: {
    patterns: ["**/*.md"],
    useOriginalIndent: false,
    additionalIndent: 3,
    showMarkers: true,
  },
  virtualSpace: {
    afterLineEnd: true,
    atFileBottom: true,
  },
  breadcrumbs: {
    visible: false,
    placement: "bottom",
    languages: ["typescript"],
  },
};

afterEach(cleanup);

describe("WorkspaceEditorAppearanceSettingsDialog", () => {
  it("applies every edited field and closes without persisting itself", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceEditorAppearanceSettingsDialog
        open
        profile={DEFAULT_EDITOR_APPEARANCE_PROFILE}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-editor-appearance-font-family"), {
      target: { value: "Fira Code" },
    });
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-font-size-px"), {
      target: { value: "18" },
    });
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-line-height"), {
      target: { value: "1.8" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-ligatures"));
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-color-scheme-id"), {
      target: { value: "night-owl" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-high-contrast"));
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-zoom-scope"), {
      target: { value: "active-editor" },
    });
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-soft-wrap-patterns"), {
      target: { value: "**/*.md, src/**/*.tsx" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-soft-wrap-use-original-indent"));
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-soft-wrap-additional-indent"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-soft-wrap-show-markers"));
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-virtual-space-after-line-end"));
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-virtual-space-at-file-bottom"));
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-breadcrumbs-visible"));
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-breadcrumbs-placement"), {
      target: { value: "bottom" },
    });
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-breadcrumbs-languages"), {
      target: { value: "typescript\njavascript" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: "Fira Code",
      fontSizePx: 18,
      lineHeight: 1.8,
      ligatures: false,
      colorSchemeId: "night-owl",
      highContrast: true,
      zoomScope: "active-editor",
      softWrap: {
        patterns: ["**/*.md", "src/**/*.tsx"],
        useOriginalIndent: false,
        additionalIndent: 4,
        showMarkers: true,
      },
      virtualSpace: { afterLineEnd: true, atFileBottom: true },
      breadcrumbs: { visible: false, placement: "bottom", languages: ["typescript", "javascript"] },
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels draft changes without applying them", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkspaceEditorAppearanceSettingsDialog
        open
        profile={DEFAULT_EDITOR_APPEARANCE_PROFILE}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByTestId("workspace-editor-appearance-font-size-px"), {
      target: { value: "24" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-cancel"));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("resets only the draft and applies defaults when explicitly applied", () => {
    const onApply = vi.fn();
    render(
      <WorkspaceEditorAppearanceSettingsDialog
        open
        profile={customProfile}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-editor-appearance-reset"));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-editor-appearance-font-size-px")).toHaveValue(13);
    expect(screen.getByTestId("workspace-editor-appearance-ligatures")).toBeChecked();
    expect(screen.getByTestId("workspace-editor-appearance-breadcrumbs-visible")).toBeChecked();
    expect(screen.getByTestId("workspace-editor-appearance-breadcrumbs-placement")).toHaveValue("top");

    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));
    expect(onApply).toHaveBeenCalledWith(DEFAULT_EDITOR_APPEARANCE_PROFILE);
  });

  it("does not render while closed", () => {
    render(
      <WorkspaceEditorAppearanceSettingsDialog
        open={false}
        profile={DEFAULT_EDITOR_APPEARANCE_PROFILE}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("workspace-editor-appearance-settings-dialog")).toBeNull();
  });

  it("edits clipboard history settings and confirms clear history", () => {
    const onApply = vi.fn();
    const onClearClipboardHistory = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <WorkspaceEditorAppearanceSettingsDialog
        open
        profile={DEFAULT_EDITOR_APPEARANCE_PROFILE}
        onApply={onApply}
        onClose={vi.fn()}
        onClearClipboardHistory={onClearClipboardHistory}
      />,
    );

    fireEvent.click(screen.getByTestId("workspace-editor-appearance-clipboard-history-enabled"));
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-clipboard-max-items"), {
      target: { value: "40" },
    });
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-clipboard-max-bytes"), {
      target: { value: "2097152" },
    });

    fireEvent.click(screen.getByTestId("workspace-editor-appearance-clipboard-clear"));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onClearClipboardHistory).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        clipboard: {
          historyEnabled: false,
          historyMaxItems: 40,
          historyMaxTotalBytes: 2097152,
        },
      }),
    );

    confirmSpy.mockRestore();
  });
});
