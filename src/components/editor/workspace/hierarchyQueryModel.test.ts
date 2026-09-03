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
  filePath: "/app/src/App.java",
  languageId: "java",
};

const mockItem: LspHierarchyItem = {
  name: "computeData",
  detail: "void computeData()",
  kind: 6, // Method
  uri: "file:///app/src/App.java",
  path: "/app/src/App.java",
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

  it("ED-QUERY-003-A1: call and type prepare use host envelope and attach root metadata", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const position = { line: 10, character: 15 };
    const spy = vi.spyOn(queryHost, "executeEnvelope").mockImplementation(async (request): Promise<any> => ({
      queryId: request.identity.requestId ?? "req-1",
      kind: request.kind,
      status: "success",
      truncated: false,
      totalCount: 1,
      durationMs: 2,
      identity: {
        workspaceId: request.identity.workspaceId ?? "ws-1",
        fileKey: request.identity.fileKey ?? "src/App.java",
        uri: request.identity.uri,
        position: request.identity.position,
        documentRevision: request.identity.documentRevision ?? 0,
        lspSessionGeneration: request.identity.lspSessionGeneration ?? 0,
        requestId: request.identity.requestId ?? "req-1",
      },
      items: [mockItem],
    }));

    // Test call prepare
    const callRes = await executeHierarchyPrepare(
      queryHost,
      mockDescriptor,
      position,
      "call",
      {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 2,
        lspSessionGeneration: 3,
        projectFingerprint: "fp-java",
        requestId: "call-prep-1",
      },
    );
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "call-hierarchy",
      identity: expect.objectContaining({
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 2,
        lspSessionGeneration: 3,
        requestId: "call-prep-1",
      }),
    }));
    expect(callRes.cancelled).toBe(false);
    expect(callRes.root).toMatchObject({
      fileKey: "src/App.java",
      documentRevision: 2,
      providerGeneration: 3,
      projectFingerprint: "fp-java",
      rootQueryId: "call-prep-1",
    });

    // Test type prepare
    const typeRes = await executeHierarchyPrepare(
      queryHost,
      mockDescriptor,
      position,
      "type",
      {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 4,
        lspSessionGeneration: 5,
        projectFingerprint: "fp-java",
        requestId: "type-prep-1",
      },
    );
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "type-hierarchy",
      identity: expect.objectContaining({
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        documentRevision: 4,
        lspSessionGeneration: 5,
        requestId: "type-prep-1",
      }),
    }));
    expect(typeRes.cancelled).toBe(false);
    expect(typeRes.root).toMatchObject({
      fileKey: "src/App.java",
      documentRevision: 4,
      providerGeneration: 5,
      projectFingerprint: "fp-java",
      rootQueryId: "type-prep-1",
    });
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
      queryId: "req-callers-1",
      kind: "call-hierarchy",
      status: "success",
      truncated: false,
      totalCount: 1,
      durationMs: 5,
      identity: {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        uri: "file:///app/src/App.java",
        position: { line: 10, character: 15 },
        documentRevision: 1,
        lspSessionGeneration: 1,
        requestId: "req-callers-1",
      },
      items: [
        {
          item: {
            name: "main",
            detail: "void main(String[] args)",
            kind: 6,
            uri: "file:///app/src/Main.java",
            path: "/app/src/Main.java",
            range: { start: { line: 5, character: 0 }, end: { line: 8, character: 1 } },
            selectionRange: { start: { line: 5, character: 12 }, end: { line: 5, character: 16 } },
            raw: {},
          },
          callRanges: [{ start: { line: 6, character: 4 }, end: { line: 6, character: 15 } }],
          callSiteItem: mockItem,
        },
      ],
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

  it("ED-QUERY-003-A2: callers, callees, supertypes, and subtypes expand through the host", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const rootNode = createHierarchyRootNode(mockItem, {
      descriptor: mockDescriptor,
      item: mockItem,
      providerGeneration: 1,
    });
    const spy = vi.spyOn(queryHost, "executeEnvelope").mockImplementation(async (request): Promise<any> => ({
      queryId: request.identity.requestId ?? "req-1",
      kind: request.kind,
      status: "success",
      truncated: false,
      totalCount: 1,
      durationMs: 2,
      identity: {
        workspaceId: request.identity.workspaceId ?? "ws-1",
        fileKey: request.identity.fileKey ?? "src/App.java",
        uri: request.identity.uri,
        position: request.identity.position,
        documentRevision: request.identity.documentRevision ?? 0,
        lspSessionGeneration: request.identity.lspSessionGeneration ?? 0,
        requestId: request.identity.requestId ?? "req-1",
      },
      items: [
        {
          item: { ...mockItem, name: "related" },
          callRanges: [],
          callSiteItem: mockItem,
        },
      ],
    }));

    const directions: Array<{ mode: "call" | "type"; direction: any; expectedKind: string }> = [
      { mode: "call", direction: "callers", expectedKind: "call-hierarchy" },
      { mode: "call", direction: "callees", expectedKind: "call-hierarchy" },
      { mode: "type", direction: "supertypes", expectedKind: "type-hierarchy" },
      { mode: "type", direction: "subtypes", expectedKind: "type-hierarchy" },
    ];

    for (const { mode, direction, expectedKind } of directions) {
      const res = await executeHierarchyExpand(
        queryHost,
        mockDescriptor,
        rootNode,
        mode,
        direction,
        {
          workspaceId: "ws-1",
          fileKey: "src/App.java",
          documentRevision: 1,
          lspSessionGeneration: 1,
          liveLspGeneration: () => 1,
          requestId: `${mode}-${direction}-req`,
        },
      );
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: expectedKind,
        identity: expect.objectContaining({
          workspaceId: "ws-1",
          fileKey: "src/App.java",
          requestId: `${mode}-${direction}-req`,
        }),
      }));
      expect(res.children).toHaveLength(1);
      expect(res.children[0].item.name).toBe("related");
    }
  });

  it("ED-QUERY-003-A3: stale and superseded expansion returns no children and makes zero tree effect", async () => {
    const queryHost = new WorkspaceSemanticQueryHost();
    const rootNode = createHierarchyRootNode(mockItem, {
      descriptor: mockDescriptor,
      item: mockItem,
      providerGeneration: 1,
    });

    // 1. Stale envelope status
    vi.spyOn(queryHost, "executeEnvelope").mockResolvedValueOnce({
      queryId: "stale-req",
      kind: "call-hierarchy",
      status: "stale",
      truncated: false,
      totalCount: 0,
      durationMs: 1,
      identity: {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        uri: "file:///app/src/App.java",
        position: { line: 10, character: 15 },
        documentRevision: 1,
        lspSessionGeneration: 1,
        requestId: "stale-req",
      },
      items: [],
    } as any);

    const staleRes = await executeHierarchyExpand(
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
    expect(staleRes.stale).toBe(true);
    expect(staleRes.cancelled).toBe(false);
    expect(staleRes.children).toHaveLength(0);

    // 2. Cancelled envelope status (superseded request)
    vi.spyOn(queryHost, "executeEnvelope").mockResolvedValueOnce({
      queryId: "cancelled-req",
      kind: "call-hierarchy",
      status: "cancelled",
      truncated: false,
      totalCount: 0,
      durationMs: 1,
      identity: {
        workspaceId: "ws-1",
        fileKey: "src/App.java",
        uri: "file:///app/src/App.java",
        position: { line: 10, character: 15 },
        documentRevision: 1,
        lspSessionGeneration: 1,
        requestId: "cancelled-req",
      },
      items: [],
    } as any);

    const cancelledRes = await executeHierarchyExpand(
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
    expect(cancelledRes.cancelled).toBe(true);
    expect(cancelledRes.stale).toBe(false);
    expect(cancelledRes.children).toHaveLength(0);
  });
});
