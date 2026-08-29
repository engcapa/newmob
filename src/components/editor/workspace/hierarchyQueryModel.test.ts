import { describe, expect, it, vi } from "vitest";
import {
  createHierarchyRootNode,
  executeHierarchyExpand,
  executeHierarchyPrepare,
  hierarchyItemKey,
} from "./hierarchyQueryModel";
import { WorkspaceSemanticQueryHost } from "./workspaceSemanticQueryHost";
import type { LspDocumentDescriptor, LspHierarchyItem } from "../../../lib/editor/lsp";

const mockDescriptor: LspDocumentDescriptor = {
  workspaceId: "ws-1",
  fileKey: "src/App.java",
  uri: "file:///app/src/App.java",
  languageId: "java",
};

const mockItem: LspHierarchyItem = {
  name: "computeData",
  kind: 6, // Method
  uri: "file:///app/src/App.java",
  range: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
  selectionRange: { start: { line: 10, character: 15 }, end: { line: 10, character: 26 } },
  raw: { detail: "void computeData()" },
};

describe("§8.20.5 / ED-QUERY-003: hierarchyQueryModel", () => {
  it("generates stable hierarchy item keys and root nodes", () => {
    const key = hierarchyItemKey(mockItem);
    expect(key).toBe("file:///app/src/App.java:10:15:computeData");

    const root = createHierarchyRootNode(mockItem, {
      descriptor: mockDescriptor,
      item: mockItem,
      rootQueryId: "req-1",
      providerGeneration: 1,
      projectFingerprint: "fp-123",
    });

    expect(root.id).toBe(key);
    expect(root.depth).toBe(0);
    expect(root.pathKeys).toEqual([key]);
    expect(root.cycle).toBe(false);
    expect(root.rootQueryId).toBe("req-1");
  });

  it("prepares call hierarchy through WorkspaceSemanticQueryHost", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const position = { line: 10, character: 15 };

    const res = await executeHierarchyPrepare(
      queryHost,
      mockDescriptor,
      position,
      "call",
      {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 1,
        lspSessionGeneration: 1,
        projectFingerprint: "fp-1",
      },
    );

    // Default mock returns 0 items in Node/vitest environment unless mocked
    expect(res.cancelled).toBe(false);
  });

  it("blocks expanding nodes with stale providerGeneration", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const rootNode = createHierarchyRootNode(mockItem, {
      descriptor: mockDescriptor,
      item: mockItem,
      providerGeneration: 1,
    });

    const res = await executeHierarchyExpand(
      queryHost,
      mockDescriptor,
      rootNode,
      "call",
      "callers",
      {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 1,
        lspSessionGeneration: 2,
        liveLspGeneration: () => 2, // generation moved from 1 to 2
      },
    );

    expect(res.stale).toBe(true);
    expect(res.children).toHaveLength(0);
    expect(res.error).toContain("stale");
  });

  it("retains node identity, depth, and cycle detection when children are expanded", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const rootNode = createHierarchyRootNode(mockItem, {
      descriptor: mockDescriptor,
      item: mockItem,
      providerGeneration: 1,
    });

    // Mock queryHost executeEnvelope to return simulated callers
    vi.spyOn(queryHost, "executeEnvelope").mockResolvedValueOnce({
      status: "completed",
      identity: {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        uri: mockDescriptor.uri,
        position: { line: 10, character: 15 },
        documentRevision: 1,
        lspSessionGeneration: 1,
        requestId: "req-callers-1",
      },
      result: {
        status: { languageId: "java", syncing: false, queueLength: 0 },
        entries: [
          {
            item: {
              name: "main",
              kind: 6,
              uri: "file:///app/src/Main.java",
              range: { start: { line: 5, character: 0 }, end: { line: 8, character: 1 } },
              selectionRange: { start: { line: 5, character: 12 }, end: { line: 5, character: 16 } },
              raw: {},
            },
            fromRanges: [{ start: { line: 6, character: 4 }, end: { line: 6, character: 15 } }],
          },
        ],
      },
    });

    const res = await executeHierarchyExpand(
      queryHost,
      mockDescriptor,
      rootNode,
      "call",
      "callers",
      {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 1,
        lspSessionGeneration: 1,
        liveLspGeneration: () => 1,
      },
    );

    expect(res.stale).toBe(false);
    expect(res.cancelled).toBe(false);
    expect(res.children).toHaveLength(1);
    expect(res.children[0].depth).toBe(1);
    expect(res.children[0].item.name).toBe("main");
    expect(res.children[0].cycle).toBe(false);
  });
});
