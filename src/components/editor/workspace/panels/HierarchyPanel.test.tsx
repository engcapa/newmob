import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentStatus, LspHierarchyItem } from "../../../../lib/editor/lsp";
import { HierarchyPanel, hierarchyItemKey, updateHierarchyNode } from "./HierarchyPanel";

const lspMocks = vi.hoisted(() => ({
  lspCallHierarchyIncoming: vi.fn(),
  lspCallHierarchyOutgoing: vi.fn(),
  lspTypeHierarchySupertypes: vi.fn(),
  lspTypeHierarchySubtypes: vi.fn(),
}));

vi.mock("../../../../lib/editor/lsp", () => lspMocks);

const status: LspDocumentStatus = {
  path: "/repo/src/a.ts",
  uri: "file:///repo/src/a.ts",
  presetId: "typescript-javascript",
  languageId: "typescript",
  displayName: "TypeScript / JavaScript",
  available: true,
  active: true,
  selectedCommandId: "typescript-language-server",
  selectedCommand: "typescript-language-server --stdio",
  installHint: null,
  error: null,
};

function item(name: string, line: number, data = name): LspHierarchyItem {
  return {
    name,
    detail: "container",
    kind: 12,
    uri: `file:///repo/src/${name}.ts`,
    path: `/repo/src/${name}.ts`,
    range: {
      start: { line, character: 0 },
      end: { line: line + 2, character: 1 },
    },
    selectionRange: {
      start: { line, character: 4 },
      end: { line, character: 4 + name.length },
    },
    raw: { name, data },
  };
}

const descriptor = {
  workspaceId: "workspace",
  rootPath: "/repo",
  filePath: "src/a.ts",
};

describe("HierarchyPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lspMocks.lspCallHierarchyIncoming.mockResolvedValue({ status, entries: [] });
    lspMocks.lspCallHierarchyOutgoing.mockResolvedValue({ status, entries: [] });
    lspMocks.lspTypeHierarchySupertypes.mockResolvedValue({ status, items: [] });
    lspMocks.lspTypeHierarchySubtypes.mockResolvedValue({ status, items: [] });
  });

  afterEach(cleanup);

  it("loads incoming calls lazily and opens individual call sites", async () => {
    const root = item("root", 1);
    const caller = item("caller", 10);
    lspMocks.lspCallHierarchyIncoming.mockResolvedValue({
      status,
      entries: [{
        item: caller,
        fromRanges: [{
          start: { line: 14, character: 2 },
          end: { line: 14, character: 8 },
        }],
      }],
    });
    const onOpenLocation = vi.fn();
    render(
      <HierarchyPanel
        mode="call"
        root={{ descriptor, item: root }}
        active
        onOpenLocation={onOpenLocation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand root" }));
    expect(await screen.findByText("caller")).toBeInTheDocument();
    expect(lspMocks.lspCallHierarchyIncoming).toHaveBeenCalledWith(descriptor, root.raw);

    fireEvent.click(screen.getByRole("button", { name: "Expand caller" }));
    fireEvent.click(screen.getAllByText("15:3")[0].closest("button")!);
    expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({
      uri: caller.uri,
      range: expect.objectContaining({ start: { line: 14, character: 2 } }),
    }));
  });

  it("switches type hierarchy direction and preserves opaque items", async () => {
    const root = item("Base", 2, "opaque-root");
    const child = item("Child", 8, "opaque-child");
    lspMocks.lspTypeHierarchySubtypes.mockResolvedValue({ status, items: [child] });
    render(
      <HierarchyPanel
        mode="type"
        root={{ descriptor, item: root }}
        active
        onOpenLocation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "subtypes" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Base" }));
    expect(await screen.findByText("Child")).toBeInTheDocument();
    expect(lspMocks.lspTypeHierarchySubtypes).toHaveBeenCalledWith(descriptor, root.raw);
  });

  it("uses stable keys and updates only the addressed tree branch", () => {
    const root = item("root", 1);
    expect(hierarchyItemKey(root)).toContain("file:///repo/src/root.ts");
    const tree = {
      id: "root",
      item: root,
      depth: 0,
      pathKeys: ["root"],
      cycle: false,
      expanded: false,
      loading: false,
      children: null,
      callRanges: [],
      callSiteItem: root,
    };
    const updated = updateHierarchyNode(tree, "root", (node) => ({ ...node, expanded: true }));
    expect(updated.expanded).toBe(true);
    expect(updated.item).toBe(root);
  });

  it("renders stale banner and triggers onRerunStale", () => {
    const root = item("root", 1);
    const onRerunStale = vi.fn();
    render(
      <HierarchyPanel
        mode="call"
        root={{ descriptor, item: root }}
        active
        staleReason="Provider restarted since this hierarchy was prepared"
        onRerunStale={onRerunStale}
        onOpenLocation={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("hierarchy-stale-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("Provider restarted since this hierarchy was prepared");

    const rerunBtn = screen.getByTestId("hierarchy-stale-rerun");
    fireEvent.click(rerunBtn);
    expect(onRerunStale).toHaveBeenCalledTimes(1);
  });

  it("prohibits expanding stale nodes until rerun", () => {
    const root = item("root", 1);
    render(
      <HierarchyPanel
        mode="call"
        root={{ descriptor, item: root, rootQueryId: "qid-1", providerGeneration: 1, projectFingerprint: "fp-1" }}
        active
        staleReason="Provider restarted"
        onOpenLocation={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand root" }));
    expect(lspMocks.lspCallHierarchyIncoming).not.toHaveBeenCalled();
  });
});
