import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_RECOVERY_MAX_ENTRIES,
  WORKSPACE_RECOVERY_STORAGE_PREFIX,
  hasUnverifiedUnknownDiskEffect,
  listDiskEffectLedgerEntries,
  readWorkspaceRecoveryEntries,
  reconcileWorkspaceRecoveryEntries,
  recordDiskEffectLedgerEntry,
  removeWorkspaceRecoveryEntry,
  resolveDiskEffectLedgerEntry,
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

describe("§8.18.1 disk-effect recovery ledger (v3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("records, scopes and clears unknown-effect rows per workspace/path", () => {
    recordDiskEffectLedgerEntry({
      workspaceId: "ws-ledger",
      transactionId: "tx-u1",
      path: "/repo/app/a.ts",
      fileIdentity: "root:app:a.ts",
      expectedOldHash: "old",
      intendedNewHash: null,
      observedHash: null,
      diskEffect: "unknown",
      createdAt: 1,
      lastVerifiedAt: null,
    });
    recordDiskEffectLedgerEntry({
      workspaceId: "ws-ledger",
      transactionId: "tx-u2",
      path: "/repo/app/b.ts",
      fileIdentity: "root:app:b.ts",
      expectedOldHash: "old2",
      intendedNewHash: null,
      observedHash: "zzz",
      diskEffect: "unknown",
      createdAt: 2,
      lastVerifiedAt: 3,
    });

    expect(listDiskEffectLedgerEntries("ws-ledger")).toHaveLength(2);
    // Unverified unknown blocks auto-retry only for the exact path.
    expect(hasUnverifiedUnknownDiskEffect("ws-ledger", "/repo/app/a.ts")).toBe(true);
    expect(hasUnverifiedUnknownDiskEffect("ws-ledger", "/repo/app/b.ts")).toBe(false);
    expect(hasUnverifiedUnknownDiskEffect("ws-ledger", "/repo/other/a.ts")).toBe(false);

    // Clearing one transaction/path never touches the other row.
    resolveDiskEffectLedgerEntry("ws-ledger", "tx-u1", "/repo/app/a.ts");
    const rest = listDiskEffectLedgerEntries("ws-ledger");
    expect(rest).toHaveLength(1);
    expect(rest[0].transactionId).toBe("tx-u2");

    // Other workspaces are untouched by either operation.
    expect(listDiskEffectLedgerEntries("ws-other")).toHaveLength(0);
  });

  it("normalizes legacy rows without an effect fact as unknown (v2 migration)", () => {
    window.localStorage.setItem(
      `${WORKSPACE_RECOVERY_STORAGE_PREFIX.replace(/recovery\.v1$/, "recovery.diskEffects.v3")}:ws-mig`,
      JSON.stringify([{ transactionId: "tx-legacy", path: "/p/f.txt" }]),
    );
    const entries = listDiskEffectLedgerEntries("ws-mig");
    expect(entries).toHaveLength(1);
    expect(entries[0].diskEffect).toBe("unknown");
    expect(entries[0].lastVerifiedAt).toBeNull();
  });
});
