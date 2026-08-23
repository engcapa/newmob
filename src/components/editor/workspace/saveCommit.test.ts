import { describe, expect, it } from "vitest";
import {
  buildPreparedSave,
  classifySaveWriteback,
  classifyUnknownDiskEffect,
  isLegalSaveCommitTransition,
  nextSaveTransactionId,
  normalizeSaveEol,
  resolveWritePolicy,
  SaveTransactionRegistry,
  saveCommitResultFromError,
  validatePreparedSaveBoundary,
  type PreparedSave,
  type SaveCommitResult,
} from "./saveCommit";
import { WorkspaceHashMismatchError } from "../../../lib/editor/workspace";

function preparedFixture(overrides: Partial<PreparedSave> = {}): PreparedSave {
  return {
    transactionId: "tx-1",
    workspaceId: "ws-1",
    fileKey: "root:app:a.ts",
    filePath: "/repo/app/a.ts",
    text: "hello\n",
    bufferRevision: 3,
    styleGeneration: 7,
    expectedDiskHash: "hash-1",
    policy: { eol: "lf", encoding: "UTF-8", bom: false },
    ...overrides,
  };
}

describe("P0-S3 saveCommit pure helpers", () => {
  it("resolveWritePolicy: explicit > replay > file metadata > defaults", () => {
    const explicitWins = resolveWritePolicy({
      explicit: { eol: "crlf", encoding: "GBK", bom: true },
      replay: { eol: "cr", encoding: "UTF-16LE", bom: false },
      file: { eol: "LF", encoding: "UTF-8", bom: false },
    });
    expect(explicitWins).toEqual({ eol: "crlf", encoding: "GBK", bom: true });

    const replayWins = resolveWritePolicy({
      replay: { eol: "cr", encoding: "UTF-16LE" },
      file: { eol: "LF", encoding: "UTF-8", bom: true },
    });
    expect(replayWins).toEqual({ eol: "cr", encoding: "UTF-16LE", bom: true });

    const fileFallback = resolveWritePolicy({ file: { eol: "CRLF", encoding: "windows-1252" } });
    expect(fileFallback).toEqual({ eol: "crlf", encoding: "windows-1252", bom: false });

    expect(resolveWritePolicy({})).toEqual({ eol: "lf", encoding: "UTF-8", bom: false });
  });

  it("normalizeSaveEol accepts OpenFileEol and lowercase forms, rejects garbage", () => {
    expect(normalizeSaveEol("CRLF")).toBe("crlf");
    expect(normalizeSaveEol("cr")).toBe("cr");
    expect(normalizeSaveEol(undefined)).toBeNull();
    expect(normalizeSaveEol("emoji" as "lf")).toBeNull();
  });

  it("nextSaveTransactionId is monotonic within a session", () => {
    const a = nextSaveTransactionId();
    const b = nextSaveTransactionId();
    expect(a).not.toBe(b);
  });

  it("validatePreparedSaveBoundary cancels on closed buffer, path change, revision and style generation", () => {
    const prepared = preparedFixture();
    expect(validatePreparedSaveBoundary(prepared, null)).toContain("closed");

    expect(
      validatePreparedSaveBoundary(prepared, {
        filePath: "/repo/app/moved.ts",
        documentRevision: 3,
        styleGeneration: 7,
      }),
    ).toContain("path changed");

    expect(
      validatePreparedSaveBoundary(prepared, {
        filePath: "/repo/app/a.ts",
        documentRevision: 4,
        styleGeneration: 7,
      }),
    ).toContain("revision changed");

    expect(
      validatePreparedSaveBoundary(prepared, {
        filePath: "/repo/app/a.ts",
        documentRevision: 3,
        styleGeneration: 8,
      }),
    ).toContain("Style generation changed");

    expect(
      validatePreparedSaveBoundary(prepared, {
        filePath: "/repo/app/a.ts",
        documentRevision: 3,
        styleGeneration: 7,
      }),
    ).toBeNull();
  });

  it("classifySaveWriteback: closed buffer discards, same revision is current, advanced is stale", () => {
    const prepared = preparedFixture();
    expect(classifySaveWriteback(prepared, null).kind).toBe("discarded");
    expect(classifySaveWriteback(prepared, { documentRevision: 3 }).kind).toBe("saved-current");
    const stale = classifySaveWriteback(prepared, { documentRevision: 9 });
    expect(stale.kind).toBe("saved-stale-snapshot");
    if (stale.kind === "saved-stale-snapshot") {
      expect(stale.currentRevision).toBe(9);
    }
  });

  it("saveCommitResultFromError maps hash mismatch to conflict and others to failed", () => {
    const conflict = saveCommitResultFromError(
      "tx-err-1",
      new WorkspaceHashMismatchError("hash-mismatch: File changed on disk; expected hash aaa, found bbb", "aaa", "bbb"),
    );
    expect(conflict.kind).toBe("conflict");
    expect(conflict.error.kind).toBe("hash-mismatch");
    expect(conflict.error.expectedHash).toBe("aaa");
    expect(conflict.error.actualHash).toBe("bbb");

    const failed = saveCommitResultFromError("tx-err-2", new Error("sync temp file: os error 5"));
    expect(failed.kind).toBe("failed");
    expect(failed.error.kind).toBe("io");
  });
});

describe("P0-S3 SaveTransactionRegistry (§8.17.1 step 4)", () => {
  it("keeps transactions active for their owner and settles them on completion", () => {
    const registry = new SaveTransactionRegistry();
    const owner = registry.begin("ws-1", "root:app:a.ts", "tx-a");
    expect(registry.check(owner)).toEqual({ active: true });

    registry.settle(owner);
    const settled = registry.check(owner);
    expect(settled.active).toBe(false);
    if (!settled.active) expect(settled.reason).toContain("already settled");
  });

  it("discardFile invalidates every transaction registered before the close", () => {
    const registry = new SaveTransactionRegistry();
    const stale = registry.begin("ws-1", "root:app:a.ts", "tx-stale");

    registry.discardFile("ws-1", "root:app:a.ts", `Buffer a.ts was closed`);

    const check = registry.check(stale);
    expect(check.active).toBe(false);
    if (!check.active) {
      expect(check.reason).toBe("Buffer a.ts was closed");
    }

    // A transaction begun after the discard is active again (same key reused).
    const fresh = registry.begin("ws-1", "root:app:a.ts", "tx-fresh");
    expect(registry.check(fresh)).toEqual({ active: true });
    // And the earlier stale owner stays discarded.
    expect(registry.check(stale).active).toBe(false);
  });

  it("discards are scoped per workspace and per file", () => {
    const registry = new SaveTransactionRegistry();
    const wsA = registry.begin("ws-a", "root:r:same.ts", "tx-wsA");
    const wsB = registry.begin("ws-b", "root:r:same.ts", "tx-wsB");
    const otherFile = registry.begin("ws-a", "root:r:other.ts", "tx-other");

    registry.discardFile("ws-a", "root:r:same.ts");

    expect(registry.check(wsA).active).toBe(false);
    expect(registry.check(wsB)).toEqual({ active: true });
    expect(registry.check(otherFile)).toEqual({ active: true });
  });

  it("discardWorkspace drops all live transactions without affecting other workspaces", () => {
    const registry = new SaveTransactionRegistry();
    const a1 = registry.begin("ws-a", "k1", "tx-a1");
    const a2 = registry.begin("ws-a", "k2", "tx-a2");
    const b1 = registry.begin("ws-b", "k1", "tx-b1");

    registry.discardWorkspace("ws-a");

    expect(registry.check(a1).active).toBe(false);
    expect(registry.check(a2).active).toBe(false);
    expect(registry.check(b1)).toEqual({ active: true });
    expect(registry.listActive("ws-a")).toHaveLength(0);
  });
});

describe("P0-S3 buildPreparedSave shared construction", () => {
  it("assembles the immutable record and copies the policy", () => {
    const policy = resolveWritePolicy({ explicit: { eol: "crlf" }, file: { encoding: "UTF-8", bom: false } as never });
    const prepared = buildPreparedSave({
      transactionId: nextSaveTransactionId(),
      workspaceId: "ws-1",
      fileKey: "root:app:a.ts",
      filePath: "/repo/app/a.ts",
      text: "x\n",
      bufferRevision: 2,
      styleGeneration: 4,
      expectedDiskHash: null,
      policy,
    });
    expect(prepared.policy).toEqual(policy);
    expect(prepared.policy).not.toBe(policy);
    expect(prepared.bufferRevision).toBe(2);
    expect(prepared.expectedDiskHash).toBeNull();
  });
});

describe("§8.18.1 six-kind SaveCommitResult taxonomy", () => {
  const txId = "tx-taxonomy";

  it("carries the three effect axes on every committed kind", () => {
    const file = { path: "/p/a.ts", text: "", size: 0, mtime: 0, hash: "h" };
    const savedCurrent: SaveCommitResult = {
      kind: "saved-current",
      transactionId: txId,
      diskEffect: "committed",
      memoryEffect: "saved-current",
      providerEffect: "did-save",
      file,
    };
    const stale: SaveCommitResult = {
      kind: "saved-stale-snapshot",
      transactionId: txId,
      diskEffect: "committed",
      memoryEffect: "kept-dirty",
      providerEffect: "did-change-current",
      file,
      savedRevision: 3,
      currentRevision: 4,
    };
    const discarded: SaveCommitResult = {
      kind: "committed-writeback-discarded",
      transactionId: txId,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      file,
      reason: "tab closed",
    };
    for (const result of [savedCurrent, stale, discarded]) {
      expect(result.diskEffect).toBe("committed");
    }
  });

  it("keeps cancelled/conflict/failed at zero disk effect and not-sent provider", () => {
    const cancelled: SaveCommitResult = {
      kind: "cancelled",
      transactionId: txId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      phase: "pre-write",
      reason: "revision changed",
    };
    const conflict: SaveCommitResult = {
      kind: "conflict",
      transactionId: txId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      error: { kind: "hash-mismatch", message: "mismatch" },
    };
    const failed: SaveCommitResult = {
      kind: "failed",
      transactionId: txId,
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      error: { kind: "io", message: "bridge dropped" },
      recoveryId: txId,
    };
    expect(cancelled.diskEffect).toBe("none");
    expect(conflict.providerEffect).toBe("not-sent");
    // Only `failed` may carry an unknown/uncertain effect with a recovery id.
    expect(failed.recoveryId).toBe(txId);
  });

  it("rejects a transition from a committed kind back to cancelled/conflict", () => {
    expect(isLegalSaveCommitTransition(
      "saved-current",
      { kind: "cancelled", transactionId: txId, diskEffect: "none", memoryEffect: "unchanged", providerEffect: "not-sent", phase: "pre-write", reason: "late" },
    )).toBe(false);
    expect(isLegalSaveCommitTransition(
      "committed-writeback-discarded",
      { kind: "conflict", transactionId: txId, diskEffect: "none", memoryEffect: "unchanged", providerEffect: "not-sent", error: { kind: "hash-mismatch", message: "m" } },
    )).toBe(false);
    expect(isLegalSaveCommitTransition(null, {
      kind: "cancelled",
      transactionId: txId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      phase: "prepare",
      reason: "ok",
    })).toBe(true);
  });
});

describe("§8.18.1 unknown disk-effect verification", () => {
  it("classifies observed==written as committed", () => {
    expect(classifyUnknownDiskEffect({
      writtenHash: "NEW",
      expectedOldHash: "old",
      observedHash: "new",
    })).toEqual({ outcome: "committed" });
  });

  it("classifies observed==old as none (nothing was written)", () => {
    expect(classifyUnknownDiskEffect({
      writtenHash: null,
      expectedOldHash: "old-hash",
      observedHash: "OLD-HASH",
    })).toEqual({ outcome: "none" });
  });

  it("classifies foreign content and unreadable files as unresolved", () => {
    expect(classifyUnknownDiskEffect({
      writtenHash: "a",
      expectedOldHash: "b",
      observedHash: "c",
    })).toEqual({ outcome: "foreign", observedHash: "c" });
    expect(classifyUnknownDiskEffect({
      writtenHash: "a",
      expectedOldHash: null,
      observedHash: null,
    })).toEqual({ outcome: "foreign", observedHash: "" });
  });

  it("maps typed native errors through saveCommitResultFromError with their effect fact", () => {
    const err = Object.assign(new Error("invoke bridge dropped"), {
      kind: "io",
      effect: "unknown",
      writtenHash: "abc",
      writtenByteLength: 12,
    });
    const mapped = saveCommitResultFromError("tx-x", err);
    expect(mapped.kind).toBe("failed");
    expect(mapped.diskEffect).toBe("unknown");
    expect(mapped.providerEffect).toBe("unknown");
    expect(mapped.error.effect).toBe("unknown");
    expect(mapped.error.writtenHash).toBe("abc");

    // A raw Error without a structured payload falls back to io with no
    // effect fact; the commit core then verifies by re-reading.
    const untyped = saveCommitResultFromError("tx-y", new Error("sync temp file: os error 5"));
    expect(untyped.error.kind).toBe("io");
    expect(untyped.diskEffect).toBeUndefined();
  });
});
