import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEverywhere, type GoToFileItem } from "./SearchEverywhere";
import type { WorkspaceCommand } from "./workspaceCommands";
import { createWorkspaceSemanticIndexSnapshot } from "./workspaceSemanticIndex";

const items: GoToFileItem[] = [
  { rootId: "root-1", rootName: "app", path: "src/components/editor/CodeWorkspaceTab.tsx" },
  { rootId: "root-1", rootName: "app", path: "src/lib/editor/workspace.ts" },
  { rootId: "root-2", rootName: "tools", path: "scripts/deploy.sh" },
];
const commands: WorkspaceCommand[] = [
  {
    id: "workspace.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    keywords: ["content", "grep"],
    run: vi.fn(),
  },
];

function renderPopup(overrides: Partial<Parameters<typeof SearchEverywhere>[0]> = {}) {
  const onOpenFile = vi.fn();
  const onClose = vi.fn();
  const onRunCommand = vi.fn();
  render(
    <SearchEverywhere
      open
      items={items}
      loading={false}
      commands={commands}
      onClose={onClose}
      onOpenFile={onOpenFile}
      onRunCommand={onRunCommand}
      {...overrides}
    />,
  );
  return { onOpenFile, onClose, onRunCommand };
}

describe("SearchEverywhere", () => {
  afterEach(() => cleanup());

  it("renders nothing while closed", () => {
    renderPopup({ open: false });
    expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
  });

  it("filters files with camelCase abbreviations and opens the selection", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "cwt" } });
    expect(screen.getByText("CodeWorkspaceTab.tsx")).toBeInTheDocument();
    expect(screen.queryByText("deploy.sh")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(screen.getByText("deploy.sh")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "cwt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith(items[0]);
  });

  it("moves the selection with arrow keys before opening", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "editor" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    const opened = onOpenFile.mock.calls[0][0] as GoToFileItem;
    const shown = screen.getAllByRole("button").map((button) => button.textContent);
    expect(shown.some((text) => text?.includes(opened.path.split("/").pop() ?? ""))).toBe(true);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("requests a split open with Ctrl+Enter", () => {
    const { onOpenFile } = renderPopup();
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Enter", ctrlKey: true });
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ rootId: expect.any(String) }), { split: true });
  });

  it("closes on Escape and on backdrop clicks", () => {
    const { onClose } = renderPopup();
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("code-workspace-search-everywhere"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reports the index size and truncation", () => {
    renderPopup({ truncated: true });
    expect(screen.getByText(/file index truncated · 3 files/)).toBeInTheDocument();
  });

  it("shows an indexing hint while loading with no results", () => {
    renderPopup({ items: [], loading: true });
    expect(screen.getByText("Indexing workspace files...")).toBeInTheDocument();
  });

  it("searches and runs commands from the Actions tab", () => {
    const { onRunCommand } = renderPopup();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    const input = screen.getByLabelText("Search actions");
    fireEvent.change(input, { target: { value: "grep" } });
    expect(screen.getByText("Find in Files")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Shift+F")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRunCommand).toHaveBeenCalledWith("workspace.findInFiles");
  });

  it("shows Classes/Symbols when available and routes Text into Find in Files", async () => {
    const onSearchText = vi.fn();
    const onOpenSymbol = vi.fn();
    const fetchSymbols = vi.fn(async () => ({
      symbols: [{
        name: "CodeWorkspaceTab",
        kind: 5,
        containerName: "editor",
        path: "src/CodeWorkspaceTab.tsx",
        uri: "file:///repo/src/CodeWorkspaceTab.tsx",
        line: 10,
        character: 0,
      }],
      semanticGeneration: 3,
      semanticRevision: 4,
    }));
    renderPopup({
      symbolsAvailable: true,
      semanticIndex: createWorkspaceSemanticIndexSnapshot(),
      fetchSymbols,
      onSearchText,
      onOpenSymbol,
      initialMode: "classes",
    });
    expect(screen.getByRole("tab", { name: "Classes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Symbols" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Go to class"), { target: { value: "CWT" } });
    expect(await screen.findByText("CodeWorkspaceTab")).toBeInTheDocument();
    expect(screen.getByTestId("search-everywhere-semantic-index")).toHaveTextContent("Stale · result generation 3");
    fireEvent.keyDown(screen.getByLabelText("Go to class"), { key: "Enter" });
    expect(onOpenSymbol).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    fireEvent.change(screen.getByLabelText("Find in files"), { target: { value: "needle" } });
    fireEvent.keyDown(screen.getByLabelText("Find in files"), { key: "Enter" });
    expect(onSearchText).toHaveBeenCalledWith("needle");
  });
});
