import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_DISK_EFFECT_LEDGER_PREFIX,
  WORKSPACE_RECOVERY_MAX_ENTRIES,
  WORKSPACE_RECOVERY_STORAGE_PREFIX,
  hasBlockingDiskEffectResolution,
  listDiskEffectLedgerEntries,
  migrateDiskEffectLedgerRow,
  readWorkspaceRecoveryEntries,
  reconcileWorkspaceRecoveryEntries,
  recordDiskEffectLedgerEntry,
  removeWorkspaceRecoveryEntry,
  resolveDiskEffectLedgerEntry,
  writeWorkspaceRecoveryEntries,
  type WorkspaceDiskEffectLedgerEntryV4,
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

function unknownRow(overrides: Partial<WorkspaceDiskEffectLedgerEntryV4>): WorkspaceDiskEffectLedgerEntryV4 {
  return {
    schemaVersion: 4,
    workspaceId: "ws-ledger",
    transactionId: "tx-u",
    operationId: "save",
    path: "/repo/app/a.ts",
    fileIdentity: "root:app:a.ts",
    expectedOldHash: "old",
    intendedNewHash: "new",
    observedHash: null,
    diskEffect: "unknown",
    memoryEffect: "unchanged",
    providerEffect: "unknown",
    resolution: "pending-readback",
    createdAt: 1,
    verifiedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe("§8.19.1 disk-effect recovery ledger (v4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("blocks retry by resolution only and scopes records per workspace/path", () => {
    // Pending read-back blocks.
    recordDiskEffectLedgerEntry(unknownRow({ transactionId: "tx-u1" }));
    // Foreign observed hash blocks even with a verified timestamp (v3 bug).
    recordDiskEffectLedgerEntry(unknownRow({
      transactionId: "tx-u2",
      path: "/repo/app/b.ts",
      fileIdentity: "root:app:b.ts",
      observedHash: "zzz",
      resolution: "foreign-blocked",
      verifiedAt: 3,
    }));
    // Confirmed-committed never blocks.
    recordDiskEffectLedgerEntry(unknownRow({
      transactionId: "tx-c1",
      path: "/repo/app/c.ts",
      fileIdentity: "root:app:c.ts",
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      observedHash: "new",
      verifiedAt: 4,
    }));

    expect(listDiskEffectLedgerEntries("ws-ledger")).toHaveLength(3);
    expect(hasBlockingDiskEffectResolution("ws-ledger", "/repo/app/a.ts")).toBe(true);
    expect(hasBlockingDiskEffectResolution("ws-ledger", "/repo/app/b.ts")).toBe(true);
    expect(hasBlockingDiskEffectResolution("ws-ledger", "/repo/app/c.ts")).toBe(false);
    expect(hasBlockingDiskEffectResolution("ws-ledger", "/repo/other/a.ts")).toBe(false);

    // Clearing one transaction/path never touches the other row. Newest
    // records are kept first.
    resolveDiskEffectLedgerEntry("ws-ledger", "tx-u1", "/repo/app/a.ts");
    const rest = listDiskEffectLedgerEntries("ws-ledger");
    expect(rest.map((row) => row.transactionId)).toEqual(["tx-c1", "tx-u2"]);

    // Other workspaces are untouched by either operation.
    expect(listDiskEffectLedgerEntries("ws-other")).toHaveLength(0);
  });

  it("round-trips committed-writeback-discarded rows for the recovery center", () => {
    const recorded = unknownRow({
      transactionId: "tx-d1",
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      intendedNewHash: "abc",
      observedHash: "abc",
      expectedOldHash: "old",
      createdAt: 10,
      verifiedAt: 11,
    });
    recordDiskEffectLedgerEntry(recorded);
    const [stored] = listDiskEffectLedgerEntries("ws-ledger");
    expect(stored).toMatchObject({
      schemaVersion: 4,
      transactionId: "tx-d1",
      operationId: "save",
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      intendedNewHash: "abc",
      observedHash: "abc",
      verifiedAt: 11,
      resolvedAt: null,
    });
    expect(hasBlockingDiskEffectResolution("ws-ledger", stored.path)).toBe(false);
  });

  it("migrates v3 unknown rows without an intended hash to pending-readback", () => {
    const migrated = migrateDiskEffectLedgerRow({
      transactionId: "tx-v3a",
      path: "/p/f.txt",
      diskEffect: "unknown",
      expectedOldHash: "old",
      intendedNewHash: null,
      observedHash: null,
      lastVerifiedAt: null,
      createdAt: 5,
    }, "ws-mig");
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      resolution: "pending-readback",
      diskEffect: "unknown",
      intendedNewHash: null,
      verifiedAt: null,
    });
  });

  it("migrates v3 foreign-hash rows to foreign-blocked even when lastVerifiedAt was set", () => {
    const migrated = migrateDiskEffectLedgerRow({
      transactionId: "tx-v3b",
      path: "/p/f.txt",
      diskEffect: "unknown",
      expectedOldHash: "old",
      intendedNewHash: "intended",
      observedHash: "foreign",
      lastVerifiedAt: 99,
      createdAt: 5,
    }, "ws-mig");
    expect(migrated).toMatchObject({
      resolution: "foreign-blocked",
      verifiedAt: null,
      observedHash: "foreign",
    });
  });

  it("migrates v3 rows whose hashes already prove the outcome without blocking", () => {
    const committed = migrateDiskEffectLedgerRow({
      transactionId: "tx-v3c",
      path: "/p/g.txt",
      diskEffect: "unknown",
      expectedOldHash: "old",
      intendedNewHash: "intended",
      observedHash: "intended",
      lastVerifiedAt: 42,
      createdAt: 5,
    }, "ws-mig");
    expect(committed).toMatchObject({
      resolution: "confirmed-committed",
      verifiedAt: 42,
    });
    expect(hasBlockingDiskEffectResolution("ws-mig", committed!.path)).toBe(false);
  });

  it("migrates legacy rows without any effect fact as pending-readback (v2)", () => {
    const migrated = migrateDiskEffectLedgerRow(
      { transactionId: "tx-legacy", path: "/p/h.txt" },
      "ws-mig2",
    );
    expect(migrated).toMatchObject({
      resolution: "pending-readback",
      diskEffect: "unknown",
    });
  });

  it("performs a one-shot v3 storage migration on first read", () => {
    const legacyKey = `${WORKSPACE_DISK_EFFECT_LEDGER_PREFIX.replace(/\.v4$/, ".v3")}:ws-one`;
    window.localStorage.setItem(legacyKey, JSON.stringify([
      { transactionId: "tx-old1", path: "/p/x.txt", diskEffect: "unknown", intendedNewHash: null },
      { transactionId: "tx-old2", path: "/p/y.txt", diskEffect: "committed-discarded", intendedNewHash: "i2", observedHash: "i2" },
    ]));
    const entries = listDiskEffectLedgerEntries("ws-one");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ resolution: "pending-readback", schemaVersion: 4 });
    expect(entries[1]).toMatchObject({ resolution: "confirmed-committed", memoryEffect: "writeback-discarded" });
    // Migration is one-shot: resolving then re-reading must not resurrect it.
    resolveDiskEffectLedgerEntry("ws-one", entries[0].transactionId, entries[0].path);
    expect(listDiskEffectLedgerEntries("ws-one")).toHaveLength(1);
  });
});
