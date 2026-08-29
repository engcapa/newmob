import { describe, expect, it, vi } from "vitest";
import {
  executeBoundedAsyncQueue,
  getLineDiffCacheKey,
  planWorkspaceRestore,
} from "./workspaceRestoreModel";
import type { WorkspaceLayoutSnapshot } from "./workspaceLayoutSnapshot";
import { createSingleLeafLayout } from "./recursiveLayoutTree";

describe("ED-PERF-003: workspaceRestoreModel", () => {
  it("prioritizes active files per leaf group over background tabs", () => {
    const snapshot: WorkspaceLayoutSnapshot = {
      schemaVersion: 2,
      savedAt: Date.now(),
      tabPolicy: null,
      bottomDockOpen: false,
      bottomDockTab: "terminal",
      rightPaneOpen: false,
      rightPaneTab: "outline",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      expandedRootIds: [],
      expandedDirKeys: [],
      layoutTreeV2: createSingleLeafLayout("primary", ["root:r1:src/A.ts", "root:r1:src/B.ts", "root:r1:src/C.ts"], "root:r1:src/B.ts"),
      editorGroups: {
        primary: {
          id: "primary",
          openOrder: ["root:r1:src/A.ts", "root:r1:src/B.ts", "root:r1:src/C.ts"],
          activeKey: "root:r1:src/B.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          id: "secondary",
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

    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
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
