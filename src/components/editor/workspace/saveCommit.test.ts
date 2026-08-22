import { describe, expect, it } from "vitest";
import {
  classifySaveWriteback,
  nextSaveTransactionId,
  normalizeSaveEol,
  resolveWritePolicy,
  saveCommitResultFromError,
  validatePreparedSaveBoundary,
  type PreparedSave,
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
