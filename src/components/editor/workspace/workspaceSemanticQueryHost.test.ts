import { describe, expect, it } from "vitest";
import {
  WorkspaceSemanticQueryHost,
  MAX_SEMANTIC_QUERY_ITEMS,
} from "./workspaceSemanticQueryHost";

describe("§8.22.9 U4 WorkspaceSemanticQueryHost", () => {
  it("executes successful query and returns typed result", async () => {
    const host = new WorkspaceSemanticQueryHost();
    const result = await host.execute(
      "references",
      "file:///repo/App.java",
      { line: 10, character: 5 },
      async () => ["item1", "item2", "item3"],
    );

    expect(result.status).toBe("success");
    expect(result.items).toEqual(["item1", "item2", "item3"]);
    expect(result.truncated).toBe(false);
    expect(result.totalCount).toBe(3);
  });

  it("handles provider unavailable (null) honestly without returning mock data", async () => {
    const host = new WorkspaceSemanticQueryHost();
    const result = await host.execute(
      "type-hierarchy",
      "file:///repo/App.java",
      { line: 5, character: 2 },
      async () => null,
    );

    expect(result.status).toBe("unavailable");
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.totalCount).toBe(0);
  });

  it("truncates result sets exceeding 1000 items and sets truncated flag", async () => {
    const host = new WorkspaceSemanticQueryHost();
    const largeList = Array.from({ length: 1500 }, (_, i) => `item_${i}`);
    const result = await host.execute(
      "call-hierarchy",
      "file:///repo/App.java",
      { line: 1, character: 1 },
      async () => largeList,
    );

    expect(result.status).toBe("success");
    expect(result.truncated).toBe(true);
    expect(result.items.length).toBe(MAX_SEMANTIC_QUERY_ITEMS);
    expect(result.totalCount).toBe(1500);
  });

  it("cancels prior in-flight query of the same kind when new query arrives", async () => {
    const host = new WorkspaceSemanticQueryHost();

    let firstAborted = false;
    const promise1 = host.execute(
      "references",
      "file:///repo/App.java",
      { line: 10, character: 5 },
      async (signal) => {
        return new Promise<string[]>((resolve) => {
          signal.addEventListener("abort", () => {
            firstAborted = true;
            resolve([]);
          });
        });
      },
    );

    // Immediate dispatch of second query
    const promise2 = host.execute(
      "references",
      "file:///repo/App.java",
      { line: 12, character: 8 },
      async () => ["second_result"],
    );

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(firstAborted).toBe(true);
    expect(res1.status).toBe("cancelled");
    expect(res2.status).toBe("success");
    expect(res2.items).toEqual(["second_result"]);
  });

  it("captures fetch errors honestly with error status", async () => {
    const host = new WorkspaceSemanticQueryHost();
    const result = await host.execute(
      "super-methods",
      "file:///repo/App.java",
      { line: 3, character: 4 },
      async () => {
        throw new Error("LSP server unreachable");
      },
    );

    expect(result.status).toBe("error");
    expect(result.items).toEqual([]);
    expect(result.error).toBe("LSP server unreachable");
  });

  it("§8.23.8 X7 returns 'stale' status when document generation changed before query completes", async () => {
    const host = new WorkspaceSemanticQueryHost();
    let currentGen = 5;

    const result = await host.execute(
      "definitions",
      "file:///repo/App.java",
      { line: 10, character: 2 },
      async () => ["def1"],
      {
        generation: 4, // Stale generation
        getLiveGeneration: () => currentGen,
      },
    );

    expect(result.status).toBe("stale");
    expect(result.items).toEqual([]);
  });

  it("§8.24.8 Y7 returns 'stale' when generation changes during async await fetch", async () => {
    const host = new WorkspaceSemanticQueryHost();
    let currentGen = 10;

    const result = await host.execute(
      "implementations",
      "file:///repo/App.java",
      { line: 20, character: 4 },
      async () => {
        // Mutate live generation while query is in-flight
        currentGen = 11;
        return ["impl1", "impl2"];
      },
      {
        generation: 10,
        getLiveGeneration: () => currentGen,
      },
    );

    expect(result.status).toBe("stale");
    expect(result.items).toEqual([]);
  });

  describe("§ED-QUERY-001: Semantic Query Envelope, Four-Phase Live Guards & Multi-Tier Cancel", () => {
    it("passes complete semantic query envelope context to fetcher", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let capturedContext: any = null;

      const result = await host.executeEnvelope({
        kind: "definitions",
        identity: {
          workspaceId: "ws-test",
          fileKey: "src/App.tsx",
          uri: "file:///workspace/src/App.tsx",
          position: { line: 15, character: 10 },
          documentRevision: 8,
          lspSessionGeneration: 3,
          projectGeneration: 2,
          requestId: "custom-req-42",
        },
        fetcher: async (ctx) => {
          capturedContext = ctx;
          return [{ targetUri: "file:///workspace/src/Target.tsx", targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }];
        },
      });

      expect(result.status).toBe("success");
      expect(result.queryId).toBe("custom-req-42");
      expect(result.identity?.workspaceId).toBe("ws-test");
      expect(result.identity?.fileKey).toBe("src/App.tsx");
      expect(result.identity?.documentRevision).toBe(8);
      expect(result.identity?.lspSessionGeneration).toBe(3);
      expect(result.identity?.projectGeneration).toBe(2);

      expect(capturedContext.workspaceId).toBe("ws-test");
      expect(capturedContext.fileKey).toBe("src/App.tsx");
      expect(capturedContext.position).toEqual({ line: 15, character: 10 });
      expect(capturedContext.signal).toBeDefined();
      expect(capturedContext.signal.aborted).toBe(false);
    });

    it("Phase 1 Pre-flight Guard: aborts before fetcher if revision or generation is already stale", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let fetcherCalled = false;

      const result = await host.executeEnvelope({
        kind: "typeDefinitions",
        identity: {
          uri: "file:///a.ts",
          position: { line: 1, character: 1 },
          documentRevision: 5,
          lspSessionGeneration: 2,
        },
        fetcher: async () => {
          fetcherCalled = true;
          return [];
        },
        guards: {
          getLiveDocumentRevision: () => 6, // Already at revision 6
          getLiveLspGeneration: () => 2,
        },
      });

      expect(fetcherCalled).toBe(false);
      expect(result.status).toBe("stale");
    });

    it("Phase 2 In-Flight Guard: aborts transport when cancelAll or cancelFile is invoked", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let aborted = false;

      const promise = host.executeEnvelope({
        kind: "references",
        identity: {
          workspaceId: "ws-alpha",
          fileKey: "a.ts",
          uri: "file:///a.ts",
          position: { line: 1, character: 1 },
        },
        fetcher: async (ctx) => {
          return new Promise<string[]>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve([]);
            });
          });
        },
      });

      // Cancel specifically by file
      host.cancelFile("ws-alpha", "a.ts");
      const result = await promise;

      expect(aborted).toBe(true);
      expect(result.status).toBe("cancelled");
    });

    it("Phase 3 Post-fetch Guard: dynamically queries live getters and detects staleness after await", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let liveRevision = 10;
      let liveSessionGen = 1;

      const result = await host.executeEnvelope({
        kind: "implementations",
        identity: {
          uri: "file:///b.ts",
          position: { line: 5, character: 2 },
          documentRevision: 10,
          lspSessionGeneration: 1,
        },
        fetcher: async () => {
          // User typed while network request was resolving!
          liveRevision = 11;
          return ["implA"];
        },
        guards: {
          getLiveDocumentRevision: () => liveRevision,
          getLiveLspGeneration: () => liveSessionGen,
        },
      });

      expect(result.status).toBe("stale");
      expect(result.items).toEqual([]);
    });

    it("Phase 4 Delivery Guard: blocks UI reveal if active tab changed or unmounted", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let isVisible = false;

      const result = await host.executeEnvelope({
        kind: "definitions",
        identity: {
          uri: "file:///c.ts",
          position: { line: 2, character: 4 },
        },
        fetcher: async () => ["defA"],
        guards: {
          guardDelivery: () => isVisible,
        },
      });

      expect(result.status).toBe("stale");
      expect(result.items).toEqual([]);
    });

    it("cancels multi-tier scopes: cancelSession and cancelAll", async () => {
      const host = new WorkspaceSemanticQueryHost();
      let q1Aborted = false;
      let q2Aborted = false;

      const p1 = host.executeEnvelope({
        kind: "definitions",
        identity: { workspaceId: "ws-1", uri: "file:///1.ts", position: { line: 0, character: 0 } },
        fetcher: async (ctx) => new Promise<string[]>((resolve) => ctx.signal.addEventListener("abort", () => { q1Aborted = true; resolve([]); })),
      });

      const p2 = host.executeEnvelope({
        kind: "references",
        identity: { workspaceId: "ws-2", uri: "file:///2.ts", position: { line: 0, character: 0 } },
        fetcher: async (ctx) => new Promise<string[]>((resolve) => ctx.signal.addEventListener("abort", () => { q2Aborted = true; resolve([]); })),
      });

      host.cancelWorkspace("ws-1");
      const r1 = await p1;
      expect(q1Aborted).toBe(true);
      expect(r1.status).toBe("cancelled");

      host.cancelAll();
      const r2 = await p2;
      expect(q2Aborted).toBe(true);
      expect(r2.status).toBe("cancelled");
    });
  });
});
