import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTemplateSettingsDialog } from "./FileTemplateSettingsDialog";
import {
  DEFAULT_FILE_TEMPLATE_PREFERENCES,
  loadJavaTemplatePreferences,
} from "../../../lib/fileTemplatePreferences";

describe("ED-TEMPLATE-001: FileTemplateSettingsDialog (ED-TEMPLATE-001-A4)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders with tabs for Class, Interface, Record, Enum, Annotation", () => {
    render(<FileTemplateSettingsDialog open={true} onClose={vi.fn()} />);

    expect(screen.getByTestId("file-template-settings-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("file-template-tab-class")).toBeInTheDocument();
    expect(screen.getByTestId("file-template-tab-interface")).toBeInTheDocument();
    expect(screen.getByTestId("file-template-tab-record")).toBeInTheDocument();
    expect(screen.getByTestId("file-template-tab-enum")).toBeInTheDocument();
    expect(screen.getByTestId("file-template-tab-annotation")).toBeInTheDocument();
  });

  it("edits template and persists to preferences on Save", () => {
    render(<FileTemplateSettingsDialog open={true} onClose={vi.fn()} />);

    const textarea = screen.getByTestId("file-template-editor-textarea");
    fireEvent.change(textarea, {
      target: { value: "package ${PACKAGE_NAME};\n\n// Custom Edited Class\npublic class ${NAME} {}" },
    });

    const saveBtn = screen.getByTestId("file-template-save-button");
    fireEvent.click(saveBtn);

    expect(screen.getByText("Saved!")).toBeInTheDocument();

    const loaded = loadJavaTemplatePreferences();
    expect(loaded.templates.class).toContain("// Custom Edited Class");
  });

  it("resets templates to default on Reset", () => {
    render(<FileTemplateSettingsDialog open={true} onClose={vi.fn()} />);

    const textarea = screen.getByTestId("file-template-editor-textarea");
    fireEvent.change(textarea, {
      target: { value: "// Mutated" },
    });
    fireEvent.click(screen.getByTestId("file-template-save-button"));
    expect(loadJavaTemplatePreferences().templates.class).toBe("// Mutated");

    const resetBtn = screen.getByTestId("file-template-reset-button");
    fireEvent.click(resetBtn);

    expect(loadJavaTemplatePreferences().templates.class).toEqual(
      DEFAULT_FILE_TEMPLATE_PREFERENCES.templates.class,
    );
  });
});
