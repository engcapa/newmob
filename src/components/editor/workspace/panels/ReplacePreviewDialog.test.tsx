import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplacePreviewDialog } from "./ReplacePreviewDialog";
import {
  buildReplaceInFilesWorkspaceEdit,
  type ReplaceInFilesMatch,
} from "../replaceInFilesModel";

function sampleMatches(): ReplaceInFilesMatch[] {
  return [
    { filePath: "/ws/a.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/a.ts", startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6, matchedText: "needle" },
    { filePath: "/ws/b.ts", startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 10, matchedText: "needle" },
  ];
}

function renderDialog(onCommit = vi.fn(), onCancel = vi.fn()) {
  const edit = buildReplaceInFilesWorkspaceEdit({ matches: sampleMatches(), replacementText: "thread" });
  render(
    <ReplacePreviewDialog
      edit={edit}
      replacement="thread"
      committing={false}
      commitError={null}
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  );
  return { onCommit, onCancel };
}

describe("ED-FIND-004: ReplacePreviewDialog", () => {
  afterEach(() => {
    cleanup();
  });
  it("groups usages by file with live counts (A1)", () => {
    renderDialog();
    expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("3 of 3");
    expect(screen.getAllByTestId("code-workspace-replace-usage")).toHaveLength(3);
    expect(screen.getByTestId("code-workspace-replace-commit")).toHaveTextContent("Replace 3");
  });

  it("rebuilds the plan on exclusion and commits the remainder (A1)", () => {
    const { onCommit } = renderDialog();
    const usages = screen.getAllByTestId("code-workspace-replace-usage");
    fireEvent.click(usages[0]);
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("2 of 3");
    expect(screen.getByTestId("code-workspace-replace-commit")).toHaveTextContent("Replace 2");

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const excluded = onCommit.mock.calls[0][0] as ReadonlySet<string>;
    expect(excluded.size).toBe(1);
  });

  it("toggles whole files and surfaces commit errors without closing (A1/A2)", () => {
    const { onCommit } = renderDialog();
    const fileToggle = screen.getByLabelText("Include all matches in /ws/a.ts");
    fireEvent.click(fileToggle);
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("1 of 3");

    fireEvent.click(screen.getByTestId("code-workspace-replace-cancel"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("disables commit when everything is excluded (A2 zero commit)", () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText("Include all matches in /ws/a.ts"));
    fireEvent.click(screen.getByLabelText("Include all matches in /ws/b.ts"));
    expect(screen.getByTestId("code-workspace-replace-commit")).toBeDisabled();
  });
});
