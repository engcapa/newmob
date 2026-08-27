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
});
