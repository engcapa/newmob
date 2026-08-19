import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_RECOVERY_MAX_ENTRIES,
  WORKSPACE_RECOVERY_STORAGE_PREFIX,
  readWorkspaceRecoveryEntries,
  reconcileWorkspaceRecoveryEntries,
  removeWorkspaceRecoveryEntry,
  writeWorkspaceRecoveryEntries,
  type WorkspaceRecoveryEntry,
} from "./workspaceRecovery";

function entry(key: string, text = "local"): WorkspaceRecoveryEntry {
  return {
    workspaceId: "ws",
    key,
    ref: { kind: "root", rootId: "root", path: `${key}.ts` },
    path: `/repo/${key}.ts`,
    text,
    savedText: "disk",
    eol: "LF",
    hash: "hash",
    mtime: 1,
    size: text.length,
    capturedAt: Date.now(),
  };
}

function file(key: string, dirty: boolean, text = "local") {
  return {
    key,
    ref: { kind: "root" as const, rootId: "root", path: `${key}.ts` },
    path: `/repo/${key}.ts`,
    title: `${key}.ts`,
    subtitle: `${key}.ts`,
    languagePath: `${key}.ts`,
    text,
    savedText: "disk",
    eol: "LF" as const,
    hash: "hash",
    mtime: 1,
    size: text.length,
    loading: false,
    saving: false,
    dirty,
    documentRevision: 0,
    error: null,
  };
}

describe("workspace recovery persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips entries and removes malformed or clean buffers", () => {
    writeWorkspaceRecoveryEntries("ws", [entry("main")]);
    const stored = JSON.parse(window.localStorage.getItem(`${WORKSPACE_RECOVERY_STORAGE_PREFIX}:ws`) ?? "[]");
    stored.push({ bad: true }, { ...entry("clean"), text: "disk", savedText: "disk" });
    window.localStorage.setItem(`${WORKSPACE_RECOVERY_STORAGE_PREFIX}:ws`, JSON.stringify(stored));
    expect(readWorkspaceRecoveryEntries("ws").map((item) => item.key)).toEqual(["main"]);
  });

  it("preserves older crash entries while reconciling currently open buffers", () => {
    writeWorkspaceRecoveryEntries("ws", [entry("old")]);
    const next = reconcileWorkspaceRecoveryEntries("ws", {
      current: file("current", true, "new local"),
      clean: file("clean", false),
    });
    expect(next.map((item) => item.key).sort()).toEqual(["current", "old"]);
    expect(next.find((item) => item.key === "current")?.text).toBe("new local");
  });

  it("does not remove a clean buffer while recovery is still awaiting a decision", () => {
    writeWorkspaceRecoveryEntries("ws", [entry("current")]);
    const next = reconcileWorkspaceRecoveryEntries(
      "ws",
      { current: file("current", false, "disk") },
      new Set(["current"]),
    );
    expect(next.map((item) => item.key)).toEqual(["current"]);
  });

  it("caps entry count and removes one snapshot independently", () => {
    writeWorkspaceRecoveryEntries("ws", Array.from({ length: WORKSPACE_RECOVERY_MAX_ENTRIES + 5 }, (_, index) => entry(`f-${index}`)));
    expect(readWorkspaceRecoveryEntries("ws")).toHaveLength(WORKSPACE_RECOVERY_MAX_ENTRIES);
    const next = removeWorkspaceRecoveryEntry("ws", "f-0");
    expect(next.some((item) => item.key === "f-0")).toBe(false);
  });
});
