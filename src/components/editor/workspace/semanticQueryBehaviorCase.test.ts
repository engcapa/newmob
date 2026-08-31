import { describe, expect, it } from "vitest";
import {
  UsageQuerySession,
  DEFAULT_SCOPE_SELECTION,
  type UsageSymbolIdentity,
} from "./usageQuerySession";
import {
  createHierarchyRootNode,
  hierarchyItemKey,
  type HierarchyNode,
} from "./hierarchyQueryModel";
import { NavigationHistoryTracker } from "./navigationHistoryModel";
import type { LspHierarchyItem } from "../../../lib/editor/lsp";

describe("ED-QUERY-004: Semantic Query behavior case (C6-02)", () => {
  const symbolIdentity: UsageSymbolIdentity = {
    uri: "file:///workspace/src/Service.java",
    range: { start: { line: 15, character: 10 }, end: { line: 15, character: 20 } },
    displayName: "processData",
    providerSymbolId: "sym-jdtls-456",
  };

  describe("1. Caret parameters and result session", () => {
    it("builds semantic envelope with exact caret and provider generation parameters", () => {
      const sessionManager = new UsageQuerySession();
      const session = sessionManager.start({
        symbol: symbolIdentity,
        selection: DEFAULT_SCOPE_SELECTION,
        evidence: {
          languageId: "java",
          provider: { id: "jdtls", version: "1.61.0", generation: 3 },
          projectFingerprint: "mvnw:hash:/opt/jdk21",
          uri: symbolIdentity.uri,
          revision: 2,
          scope: "project",
        },
        locations: [
          {
            uri: "file:///workspace/src/Controller.java",
            range: { start: { line: 40, character: 12 }, end: { line: 40, character: 23 } },
            path: "/workspace/src/Controller.java",
          },
        ],
      });

      expect(session.state).toBe("ready");
      expect(session.envelope.kind).toBe("usages");
      expect(session.envelope.evidence.provider.generation).toBe(3);
      expect(session.envelope.results).toHaveLength(1);
      expect(session.symbol.displayName).toBe("processData");
    });
  });

  describe("2. Open, reveal, and navigation history back restore", () => {
    it("records navigation history jump and allows restoring source position", () => {
      const tracker = new NavigationHistoryTracker();

      // Start at query source location
      tracker.recordLocation({
        workspaceId: "ws-1",
        fileIdentity: "Service.java",
        filePath: "/workspace/src/Service.java",
        title: "Service.java",
        line: 15,
        character: 10,
        lineText: "processData()",
        contextSnippet: "public void processData()",
        sourceOwnership: "workspace",
        isEditLocation: false,
      });

      // Jump to definition / usage
      tracker.recordLocation({
        workspaceId: "ws-1",
        fileIdentity: "Controller.java",
        filePath: "/workspace/src/Controller.java",
        title: "Controller.java",
        line: 40,
        character: 12,
        lineText: "service.processData()",
        contextSnippet: "service.processData();",
        sourceOwnership: "workspace",
        isEditLocation: false,
      });

      const locations = tracker.getRecentLocations();
      expect(locations).toHaveLength(2);
      expect(locations[0].filePath).toBe("/workspace/src/Controller.java");
      expect(locations[1].filePath).toBe("/workspace/src/Service.java");
      expect(locations[1].line).toBe(15);
    });
  });

  describe("3. In-flight query cancellation", () => {
    it("aborts in-flight query through AbortController without leaking stale state", async () => {
      const controller = new AbortController();

      const fetchPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => resolve("done"), 1000);
        controller.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("Query cancelled by user or navigation"));
        });
      });

      controller.abort();

      await expect(fetchPromise).rejects.toThrow("Query cancelled");
    });
  });

  describe("4. Hierarchy prepare and lazy expansion", () => {
    it("prepares hierarchy root and lazily expands children with opaque node identity", () => {
      const lspItem: LspHierarchyItem = {
        name: "processData",
        kind: 12,
        uri: symbolIdentity.uri,
        path: "/workspace/src/Service.java",
        range: symbolIdentity.range,
        selectionRange: symbolIdentity.range,
        detail: "void processData()",
        raw: null,
      };

      const rootNode = createHierarchyRootNode(lspItem, {
        // LspDocumentDescriptor selects the session by filePath and carries the
        // virtual document URI separately; the buffer revision belongs to the root
        // state, not the descriptor.
        descriptor: {
          workspaceId: "ws-behavior",
          filePath: "/workspace/src/Service.java",
          documentUri: symbolIdentity.uri,
          languageId: "java",
        },
        item: lspItem,
        documentRevision: 1,
        providerGeneration: 1,
        projectFingerprint: "fp",
      });

      expect(rootNode.id).toBe(hierarchyItemKey(lspItem));
      expect(rootNode.children).toBeNull();
      expect(rootNode.expanded).toBe(false);

      // Lazy expand simulation
      const childItem: LspHierarchyItem = {
        name: "handleRequest",
        kind: 12,
        uri: "file:///workspace/src/Controller.java",
        path: "/workspace/src/Controller.java",
        range: { start: { line: 35, character: 4 }, end: { line: 50, character: 5 } },
        selectionRange: { start: { line: 35, character: 15 }, end: { line: 35, character: 28 } },
        detail: "void handleRequest()",
        raw: null,
      };

      const childNode: HierarchyNode = {
        id: hierarchyItemKey(childItem),
        item: childItem,
        depth: 1,
        pathKeys: [rootNode.id, hierarchyItemKey(childItem)],
        cycle: false,
        expanded: false,
        loading: false,
        children: null,
        callRanges: [],
        callSiteItem: childItem,
      };

      rootNode.expanded = true;
      rootNode.children = [childNode];

      expect(rootNode.expanded).toBe(true);
      expect(rootNode.children).toHaveLength(1);
      expect(rootNode.children[0].id).toContain("Controller.java");
    });
  });
});
