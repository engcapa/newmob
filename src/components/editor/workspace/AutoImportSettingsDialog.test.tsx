import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoImportSettingsDialog } from "./AutoImportSettingsDialog";
import {
  loadAutoImportPreferences,
  resetAutoImportPreferences,
} from "../../../lib/autoImportPreferences";

describe("ED-IMPORT-001: AutoImportSettingsDialog component", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAutoImportPreferences();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders when open and displays current settings", () => {
    render(<AutoImportSettingsDialog open={true} onClose={vi.fn()} />);

    expect(screen.getByTestId("auto-import-settings-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("auto-import-on-the-fly-checkbox")).toBeChecked();
    expect(screen.getByTestId("auto-import-paste-mode-select")).toHaveValue("ask");
    expect(screen.getByTestId("auto-import-excluded-packages-input")).toHaveValue(
      "com.sun.*\nsun.*\njdk.internal.*",
    );
  });

  it("persists updated settings on Save (ED-IMPORT-001-A2)", () => {
    const onClose = vi.fn();
    render(<AutoImportSettingsDialog open={true} onClose={onClose} />);

    // Toggle on-the-fly off
    const onTheFlyCheckbox = screen.getByTestId("auto-import-on-the-fly-checkbox");
    fireEvent.click(onTheFlyCheckbox);
    expect(onTheFlyCheckbox).not.toBeChecked();

    // Change paste mode to "all"
    const pasteSelect = screen.getByTestId("auto-import-paste-mode-select");
    fireEvent.change(pasteSelect, { target: { value: "all" } });
    expect(pasteSelect).toHaveValue("all");

    // Add custom excluded package
    const excludedInput = screen.getByTestId("auto-import-excluded-packages-input");
    fireEvent.change(excludedInput, { target: { value: "org.internal.*" } });

    // Click Save
    const saveBtn = screen.getByTestId("auto-import-save-button");
    fireEvent.click(saveBtn);

    const saved = loadAutoImportPreferences();
    expect(saved.addUnambiguousImportsOnTheFly).toBe(false);
    expect(saved.pasteImportMode).toBe("all");
    expect(saved.excludedPackages).toEqual(["org.internal.*"]);
  });

  it("resets to defaults on Reset Defaults button click", () => {
    render(<AutoImportSettingsDialog open={true} onClose={vi.fn()} />);

    // First change something
    const pasteSelect = screen.getByTestId("auto-import-paste-mode-select");
    fireEvent.change(pasteSelect, { target: { value: "none" } });

    const resetBtn = screen.getByTestId("auto-import-reset-button");
    fireEvent.click(resetBtn);

    expect(pasteSelect).toHaveValue("ask");
    const prefs = loadAutoImportPreferences();
    expect(prefs.pasteImportMode).toBe("ask");
  });
});
