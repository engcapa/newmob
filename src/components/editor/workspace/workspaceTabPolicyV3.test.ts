import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  migrateWorkspaceTabPolicy,
} from "./workspaceTabPolicy";

describe("§8.19.6 Tab Policy V3 migration", () => {
  it("passes a valid v3 payload through without repairs", () => {
    const raw = { ...DEFAULT_WORKSPACE_TAB_POLICY_V3, limitPerLeaf: 7 };
    const result = migrateWorkspaceTabPolicy(raw);
    expect(result.policy).toEqual({ ...raw });
    expect(result.repairedFields).toEqual([]);
    expect(result.backup).toBeNull();
  });

  it("migrates v2 defaults into v3 (previewEnabled → previewMode)", () => {
    const v2 = {
      schemaVersion: 2,
      limitPerLeaf: 10,
      order: "mru",
      openPosition: "after-active",
      activateOnClose: "right",
      pinnedRow: "separate",
      previewEnabled: false,
      reusePreview: false,
    };
    const result = migrateWorkspaceTabPolicy(v2);
    expect(result.policy).toMatchObject({
      schemaVersion: 3,
      limitPerLeaf: 10,
      order: "mru",
      previewMode: false,
      reusePreview: false,
    });
    // The schema bump is an expected part of migration, not silent corruption.
    expect(result.repairedFields).toContain("previewMode(migrated-from-v2)");
  });

  it("repairs corrupt fields individually and backs up the raw payload", () => {
    const corrupt = {
      schemaVersion: "three",
      limitPerLeaf: -5,
      order: "chronological",
      openPosition: "end",
      activateOnClose: 7,
      pinnedRow: true,
      previewMode: "yes",
      reusePreview: true,
    };
    const result = migrateWorkspaceTabPolicy(corrupt);
    // Wrong-TYPE fields fall back to defaults; wrong-RANGE numbers are
    // clamped into the legal domain (-5 → 1).
    expect(result.policy).toEqual({ ...DEFAULT_WORKSPACE_TAB_POLICY_V3, reusePreview: true, limitPerLeaf: 1 });
    expect(result.repairedFields).toEqual(expect.arrayContaining([
      "schemaVersion", "limitPerLeaf", "order", "activateOnClose", "pinnedRow", "previewMode",
    ]));
    expect(result.backup).toEqual(corrupt);
  });

  it("falls back to full defaults for non-object payloads", () => {
    for (const garbage of [null, undefined, "policy", 42, []]) {
      const result = migrateWorkspaceTabPolicy(garbage);
      expect(result.policy).toEqual(DEFAULT_WORKSPACE_TAB_POLICY_V3);
      expect(result.backup).toEqual(garbage ?? null);
    }
  });

  it("clamps out-of-range numeric limits instead of rejecting them", () => {
    const result = migrateWorkspaceTabPolicy({
      ...DEFAULT_WORKSPACE_TAB_POLICY_V3,
      limitPerLeaf: 5000,
    });
    expect(result.policy.limitPerLeaf).toBe(100);
    expect(result.repairedFields).toContain("limitPerLeaf");
    expect(result.backup).not.toBeNull();
  });
});
