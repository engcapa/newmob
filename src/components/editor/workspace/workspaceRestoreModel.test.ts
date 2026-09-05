import { describe, expect, it } from "vitest";
import {
  executeBoundedAsyncQueue,
  getLineDiffCacheKey,
  planWorkspaceRestore,
} from "./workspaceRestoreModel";
import type { WorkspaceLayoutSnapshot } from "./workspaceLayoutPersistence";
import { createSingleLeafLayout } from "./recursiveLayoutTree";

describe("ED-PERF-003: workspaceRestoreModel", () => {
  it("prioritizes active files per leaf group over background tabs", () => {
    const snapshot: WorkspaceLayoutSnapshot = {
      version: 2,
      bottomDockOpen: false,
      bottomDockTab: "terminal",
      rightPaneOpen: false,
      rightPaneTab: "outline",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      expandedRootIds: [],
      expandedDirKeys: [],
      layoutTreeV2: {
        type: "split",
        id: "split-root",
        orientation: "vertical",
        ratios: [0.5, 0.5],
        children: [
          createSingleLeafLayout(
            "primary",
            ["root:r1:src/A.ts", "root:r1:src/B.ts", "root:r1:src/C.ts"],
            "root:r1:src/B.ts",
          ),
          createSingleLeafLayout(
            "secondary",
            ["root:r1:src/D.ts", "root:r1:src/E.ts"],
            "root:r1:src/D.ts",
          ),
        ],
      },
      editorGroups: {
        primary: {
          openOrder: ["root:r1:src/A.ts", "root:r1:src/B.ts", "root:r1:src/C.ts"],
          activeKey: "root:r1:src/B.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:r1:src/D.ts", "root:r1:src/E.ts"],
          activeKey: "root:r1:src/D.ts",
          previewKey: "root:r1:src/D.ts",
          pinnedKeys: [],
        },
      },
    };

    const plan = planWorkspaceRestore(snapshot, []);

    // Active targets for each leaf (B.ts for primary, D.ts for secondary)
    expect(plan.activeTargets).toHaveLength(2);
    expect(plan.activeTargets.map((t) => t.key)).toEqual(["root:r1:src/B.ts", "root:r1:src/D.ts"]);
    expect(plan.activeTargets[0].active).toBe(true);
    expect(plan.activeTargets[1].preview).toBe(true);

    // Background targets are the remaining open files
    expect(plan.backgroundTargets).toHaveLength(3);
    expect(plan.backgroundTargets.map((t) => t.key)).toEqual([
      "root:r1:src/A.ts",
      "root:r1:src/C.ts",
      "root:r1:src/E.ts",
    ]);
  });

  it("executes async queue with bounded concurrency", async () => {
    let activeWorkers = 0;
    let maxConcurrent = 0;

    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const worker = async (item: number) => {
      activeWorkers++;
      maxConcurrent = Math.max(maxConcurrent, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeWorkers--;
      return item * 2;
    };

    const results = await executeBoundedAsyncQueue(items, worker, 3);

    expect(results.map((result) => result.status === "fulfilled" ? result.value : null))
      .toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("continues restoring later items when one background read fails", async () => {
    const worker = async (item: number) => {
      if (item === 2) throw new Error("read failed");
      return item * 2;
    };

    const results = await executeBoundedAsyncQueue([1, 2, 3, 4], worker, 2);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: 2 });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: 6 });
    expect(results[3]).toMatchObject({ status: "fulfilled", value: 8 });
  });

  it("keeps the worker pool inside the documented two-to-four window", async () => {
    let activeWorkers = 0;
    let maxConcurrent = 0;

    await executeBoundedAsyncQueue(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async () => {
        activeWorkers += 1;
        maxConcurrent = Math.max(maxConcurrent, activeWorkers);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWorkers -= 1;
        return true;
      },
      99,
    );

    expect(maxConcurrent).toBe(4);
  });

  it("computes line diff cache key stably", () => {
    const key1 = getLineDiffCacheKey("/repo/src/A.ts", "abc1234", 1);
    const key2 = getLineDiffCacheKey("/repo/src/A.ts", "abc1234", 1);
    const key3 = getLineDiffCacheKey("/repo/src/A.ts", "abc1234", 2);
    const keyUntracked = getLineDiffCacheKey("/repo/src/A.ts", null, 1);

    expect(key1).toBe("/repo/src/A.ts@abc1234:1");
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(keyUntracked).toBe("/repo/src/A.ts@untracked:1");
  });
});
