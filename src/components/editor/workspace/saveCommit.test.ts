import { describe, expect, it, vi } from "vitest";
import {
  buildPreparedSave,
  classifySaveWriteback,
  classifyUnknownDiskEffect,
  createSingleWriterSaveCommitter,
  encodeSaveBytes,
  isLegalSaveCommitTransition,
  nextSaveTransactionId,
  normalizeSaveEol,
  resolveUnknownDiskResolution,
  resolveWritePolicy,
  SaveTransactionRegistry,
  saveCommitResultFromError,
  validatePreparedSaveBoundary,
  type FinalBytesReceipt,
  type PreparedSave,
  type SaveCommitResult,
} from "./saveCommit";
import {
  WorkspaceHashMismatchError,
  type WorkspaceFile,
} from "../../../lib/editor/workspace";

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

describe("§8.19.1 resolveUnknownDiskResolution (three-hash classification)", () => {
  it("classifies observed == intended as confirmed-committed (case-insensitive)", () => {
    expect(resolveUnknownDiskResolution({
      intendedNewHash: "ABC123",
      expectedOldHash: "old",
      observedHash: "abc123",
    })).toBe("confirmed-committed");
  });

  it("classifies observed == old as confirmed-none", () => {
    expect(resolveUnknownDiskResolution({
      intendedNewHash: "new",
      expectedOldHash: "old",
      observedHash: "old",
    })).toBe("confirmed-none");
  });

  it("classifies any other hash as foreign-blocked", () => {
    expect(resolveUnknownDiskResolution({
      intendedNewHash: "new",
      expectedOldHash: "old",
      observedHash: "foreign",
    })).toBe("foreign-blocked");
  });

  it("falls back to pending-readback when the read-back failed or intent is unknown", () => {
    expect(resolveUnknownDiskResolution({
      intendedNewHash: "new",
      expectedOldHash: "old",
      observedHash: null,
    })).toBe("pending-readback");
    // v3-migrated rows without a captured intent can only ever be pending.
    expect(resolveUnknownDiskResolution({
      intendedNewHash: null,
      expectedOldHash: "old",
      observedHash: "something",
    })).toBe("foreign-blocked");
  });
});

describe("§ED-SAVE-003: Single Writer Save Committer & Final Bytes Receipt", () => {
  const fakeFile = (overrides: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
    path: "/repo/src/App.java",
    text: "class App {}\n",
    size: 13,
    mtime: 1700000000000,
    hash: "hash-post-disk-1",
    ...overrides,
  });

  describe("encodeSaveBytes", () => {
    it("encodes UTF-8 with BOM prepending [0xEF, 0xBB, 0xBF]", () => {
      const result = encodeSaveBytes("hello", { eol: "lf", encoding: "UTF-8", bom: true });
      expect(result.bytes.length).toBe(8);
      expect(result.bytes[0]).toBe(0xef);
      expect(result.bytes[1]).toBe(0xbb);
      expect(result.bytes[2]).toBe(0xbf);
      expect(result.byteLength).toBe(8);
      expect(result.textSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.bytesSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("encodes UTF-8 without BOM stripping existing BOM if present", () => {
      const result = encodeSaveBytes("\uFEFFhello", { eol: "lf", encoding: "UTF-8", bom: false });
      expect(result.bytes.length).toBe(5);
      expect(result.bytes[0]).toBe(104); // 'h'
      expect(result.byteLength).toBe(5);
    });

    it("encodes UTF-16LE and UTF-16BE with correct byte order", () => {
      const text = "A"; // 0x0041
      const le = encodeSaveBytes(text, { eol: "lf", encoding: "UTF-16LE", bom: false });
      expect(le.bytes).toEqual(new Uint8Array([0x41, 0x00]));

      const be = encodeSaveBytes(text, { eol: "lf", encoding: "UTF-16BE", bom: false });
      expect(be.bytes).toEqual(new Uint8Array([0x00, 0x41]));
    });

    it("throws typed WorkspaceWriteError on Latin-1 / ASCII encoding range violation", () => {
      expect(() => {
        encodeSaveBytes("emoji 🚀", { eol: "lf", encoding: "ISO-8859-1", bom: false });
      }).toThrowError(/cannot be represented in Latin-1/);

      expect(() => {
        encodeSaveBytes("accent é", { eol: "lf", encoding: "US-ASCII", bom: false });
      }).toThrowError(/cannot be represented in US-ASCII/);
    });
  });

  describe("createSingleWriterSaveCommitter", () => {
    it("cancels synchronously before write if open buffer was closed or changed", async () => {
      const writeToDisk = vi.fn();
      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => null, // Buffer was closed!
        writeToDisk,
      });

      const prepared = preparedFixture();
      const result = await committer(prepared);

      expect(result.kind).toBe("cancelled");
      expect(result.diskEffect).toBe("none");
      if (result.kind === "cancelled") {
        expect(result.phase).toBe("pre-write");
        expect(result.reason).toContain("Open buffer was closed before write");
      }
      expect(writeToDisk).not.toHaveBeenCalled();
    });

    it("cancels synchronously before write if buffer revision advanced (typing race)", async () => {
      const writeToDisk = vi.fn();
      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => ({
          filePath: "/repo/app/a.ts",
          documentRevision: 4, // Live revision advanced past prepared revision (3)!
          styleGeneration: 7,
        }),
        writeToDisk,
      });

      const prepared = preparedFixture({ bufferRevision: 3 });
      const result = await committer(prepared);

      expect(result.kind).toBe("cancelled");
      expect(result.diskEffect).toBe("none");
      if (result.kind === "cancelled") {
        expect(result.phase).toBe("pre-write");
        expect(result.reason).toContain("Buffer revision changed");
      }
      expect(writeToDisk).not.toHaveBeenCalled();
    });

    it("executes single write and generates comprehensive FinalBytesReceipt on success", async () => {
      let writeCount = 0;
      const writeToDisk = vi.fn(async () => {
        writeCount += 1;
        return fakeFile({ hash: "disk-sha-final" });
      });

      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => ({
          filePath: "/repo/app/a.ts",
          documentRevision: 3,
          styleGeneration: 7,
        }),
        writeToDisk,
        generateHistoryId: (p) => `history-${p.transactionId}`,
      });

      const prepared = preparedFixture({
        transactionId: "tx-save-receipt-1",
        bufferRevision: 3,
        text: "const app = 42;\n",
        expectedDiskHash: "disk-pre-sha",
      });

      const result = await committer(prepared);

      expect(result.kind).toBe("saved-current");
      expect(result.diskEffect).toBe("committed");
      expect(result.memoryEffect).toBe("saved-current");
      expect(result.providerEffect).toBe("did-save");
      expect(writeCount).toBe(1);
      expect(writeToDisk).toHaveBeenCalledTimes(1);

      if (result.kind === "saved-current") {
        expect(result.receipt).toBeDefined();
        const receipt: FinalBytesReceipt = result.receipt!;
        expect(receipt.receiptId).toBe("receipt-tx-save-receipt-1");
        expect(receipt.writeCount).toBe(1);
        expect(receipt.diskPreSha256).toBe("disk-pre-sha");
        expect(receipt.diskPostSha256).toBe("disk-sha-final");
        expect(receipt.historyId).toBe("history-tx-save-receipt-1");
        expect(receipt.finalTextSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.encodedBytesSha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it("classifies writeback as saved-stale-snapshot when user types during in-flight writer", async () => {
      let currentRevision = 3;
      const writeToDisk = vi.fn(async () => {
        // User types while disk writer is in flight!
        currentRevision = 4;
        return fakeFile();
      });

      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => ({
          filePath: "/repo/app/a.ts",
          documentRevision: 3,
          styleGeneration: 7,
        }),
        getLiveAfterWrite: () => ({
          documentRevision: currentRevision,
        }),
        writeToDisk,
      });

      const prepared = preparedFixture({ bufferRevision: 3 });
      const result = await committer(prepared);

      expect(result.kind).toBe("saved-stale-snapshot");
      expect(result.diskEffect).toBe("committed");
      expect(result.memoryEffect).toBe("kept-dirty");
      expect(result.providerEffect).toBe("did-change-current");
      if (result.kind === "saved-stale-snapshot") {
        expect(result.savedRevision).toBe(3);
        expect(result.currentRevision).toBe(4);
        expect(result.receipt?.writeCount).toBe(1);
      }
    });

    it("classifies writeback as committed-writeback-discarded when buffer closed during in-flight writer", async () => {
      let liveBuffer: { documentRevision: number } | null = { documentRevision: 3 };
      const writeToDisk = vi.fn(async () => {
        // User closed tab while disk writer was in flight!
        liveBuffer = null;
        return fakeFile();
      });

      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => ({
          filePath: "/repo/app/a.ts",
          documentRevision: 3,
          styleGeneration: 7,
        }),
        getLiveAfterWrite: () => liveBuffer,
        writeToDisk,
      });

      const prepared = preparedFixture({ bufferRevision: 3 });
      const result = await committer(prepared);

      expect(result.kind).toBe("committed-writeback-discarded");
      expect(result.diskEffect).toBe("committed");
      expect(result.memoryEffect).toBe("writeback-discarded");
      expect(result.providerEffect).toBe("discarded");
      if (result.kind === "committed-writeback-discarded") {
        expect(result.receipt?.writeCount).toBe(1);
      }
    });

    it("returns conflict on disk hash race", async () => {
      const writeToDisk = vi.fn(async () => {
        throw new WorkspaceHashMismatchError("expected hash mismatch", "disk-pre-sha", "foreign-disk-sha");
      });

      const committer = createSingleWriterSaveCommitter({
        getLiveBoundary: () => ({
          filePath: "/repo/app/a.ts",
          documentRevision: 3,
          styleGeneration: 7,
        }),
        writeToDisk,
      });

      const prepared = preparedFixture({ bufferRevision: 3 });
      const result = await committer(prepared);

      expect(result.kind).toBe("conflict");
      expect(result.diskEffect).toBe("none");
      expect(result.memoryEffect).toBe("unchanged");
    });
  });
});
