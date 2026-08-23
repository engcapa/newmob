import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceStyleController,
  createWorkspaceStyleController,
  type SaveByteWriterResult,
  type SaveTransactionV2,
} from "./workspaceStyleController";
import type { PreparedSave } from "./saveCommit";
import type { WorkspaceFile } from "../../../lib/editor/workspace";

function fakeWrittenFile(hash: string): WorkspaceFile {
  return { path: "/project/app.ts", text: "", hash, size: 0, mtime: 0 };
}

/** Adapter: legacy positional writer mock -> typed byte-writer contract. */
function writeDiskMock(
  impl: (path: string, text: string, hash: string | null, encoding: string, bom: boolean, eol: string) => Promise<SaveByteWriterResult>,
): (prepared: PreparedSave) => Promise<SaveByteWriterResult> {
  // vi.fn keeps spy assertions working; the cast restores the writer type.
  return vi.fn(async (prepared: PreparedSave) => impl(
    prepared.filePath,
    prepared.text,
    prepared.expectedDiskHash,
    prepared.policy.encoding,
    prepared.policy.bom,
    prepared.policy.eol,
  )) as unknown as (prepared: PreparedSave) => Promise<SaveByteWriterResult>;
}

describe("WorkspaceStyleController (N1.1)", () => {
  it("isolates styles and caches between separate workspace instances", async () => {
    const readFileA = vi.fn(async () => "root = true\n[*]\nindent_size = 2\n");
    const readFileB = vi.fn(async () => "root = true\n[*]\nindent_size = 4\n");

    const ctrlA = createWorkspaceStyleController({
      workspaceId: "ws-a",
      roots: [{ id: "root-1", path: "/project-a" }],
      fileProvider: { readFile: readFileA },
    });

    const ctrlB = createWorkspaceStyleController({
      workspaceId: "ws-b",
      roots: [{ id: "root-1", path: "/project-b" }],
      fileProvider: { readFile: readFileB },
    });

    const styleA = await ctrlA.resolveForFile({ filePath: "/project-a/src/main.ts" });
    const styleB = await ctrlB.resolveForFile({ filePath: "/project-b/src/main.ts" });

    expect(styleA.tabSize).toBe(2);
    expect(styleB.tabSize).toBe(4);
    expect(readFileA).toHaveBeenCalled();
    expect(readFileB).toHaveBeenCalled();
  });

  it("increments generation on invalidation and cache clear", async () => {
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider: { readFile: async () => null },
    });

    const gen0 = ctrl.getGeneration();
    ctrl.invalidate("/project/.editorconfig");
    expect(ctrl.getGeneration()).toBe(gen0 + 1);

    ctrl.clearCache();
    expect(ctrl.getGeneration()).toBe(gen0 + 2);
  });

  it("cancels save transaction if buffer version advanced concurrently", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    const writeDisk = vi.fn(async () => ({ kind: "written", hash: "unused", file: fakeWrittenFile("unused") } as const));

    let currentVersion = 1;
    const tx: SaveTransactionV2 = {
      id: "tx-1",
      workspaceId: "ws-1",
      fileKey: "key-1",
      filePath: "/project/app.ts",
      bufferVersion: 1,
      styleGeneration: 0,
      expectedDiskHash: null,
      policy: { eol: "lf", encoding: "UTF-8", bom: false },
      text: "hello world\n",
    };

    // Buffer edited concurrently
    currentVersion = 2;
    const outcome = await ctrl.executeSaveTransaction(tx, writeDisk, {
      getLatestBufferVersion: () => currentVersion,
    });

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind === "cancelled") {
      expect(outcome.phase).toBe("pre-write");
      expect(outcome.reason).toContain("revision changed");
    }
    expect(writeDisk).not.toHaveBeenCalled();
  });

  it("executes save transaction successfully and normalizes line endings", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    let writtenText = "";
    let writtenEol = "";
    let preparedHash: string | null = null;
    const writeDisk = writeDiskMock(async (_path, text, expectedHash, _enc, _bom, eol) => {
      writtenText = text;
      writtenEol = eol;
      preparedHash = expectedHash;
      return { kind: "written", hash: "hash-saved-1", file: fakeWrittenFile("hash-saved-1") };
    });

    const tx: SaveTransactionV2 = {
      id: "tx-2",
      workspaceId: "ws-1",
      fileKey: "key-2",
      filePath: "/project/app.ts",
      bufferVersion: 1,
      styleGeneration: 0,
      expectedDiskHash: null,
      policy: { eol: "crlf", encoding: "UTF-8", bom: false },
      text: "line1\nline2\n",
    };

    const outcome = await ctrl.executeSaveTransaction(tx, writeDisk, {
      getLatestBufferVersion: () => 1,
    });

    expect(outcome.kind).toBe("saved-current");
    expect(writtenText).toBe("line1\r\nline2\r\n");
    expect(writtenEol).toBe("crlf");
    expect(preparedHash).toBeNull();
    if (outcome.kind === "saved-current") {
      expect(outcome.transactionId).toBe(tx.id);
      expect(outcome.file.hash).toBe("hash-saved-1");
    }
  });

  it("fails typed on unencodable characters for Latin-1 policy", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    const writeDisk = vi.fn(async () => ({ kind: "written", hash: "dummy", file: fakeWrittenFile("dummy") } as const));

    const tx: SaveTransactionV2 = {
      id: "tx-3",
      workspaceId: "ws-1",
      fileKey: "key-3",
      filePath: "/project/app.txt",
      bufferVersion: 1,
      styleGeneration: 0,
      expectedDiskHash: null,
      policy: { eol: "lf", encoding: "ISO-8859-1", bom: false },
      text: "hello 你好\n",
    };

    const outcome = await ctrl.executeSaveTransaction(tx, writeDisk);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.kind).toBe("encoding");
    }
    expect(writeDisk).not.toHaveBeenCalled();
  });

  it("handles structured hash mismatch and missing hash from writer (N1.5)", async () => {
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider: { readFile: async () => null },
    });

    // 1. Structured hash mismatch
    const writeDiskConflict = vi.fn(async () => {
      throw new Error("hash-mismatch: File changed on disk; expected hash aaa, found bbb");
    });
    const tx: SaveTransactionV2 = {
      id: "tx-4",
      workspaceId: "ws-1",
      fileKey: "key-4",
      filePath: "/project/app.ts",
      bufferVersion: 1,
      styleGeneration: 0,
      expectedDiskHash: "aaa",
      policy: { eol: "lf", encoding: "UTF-8", bom: false },
      text: "test content\n",
    };

    const outcome1 = await ctrl.executeSaveTransaction(tx, writeDiskConflict, {
      getLatestBufferVersion: () => 1,
    });
    expect(outcome1.kind).toBe("conflict");
    if (outcome1.kind === "conflict") {
      expect(outcome1.transactionId).toBe(tx.id);
      expect(outcome1.error.message).toContain("Disk hash conflict");
      expect(outcome1.error.kind).toBe("hash-mismatch");
      expect(outcome1.error.expectedHash).toBe("aaa");
      expect(outcome1.error.actualHash).toBe("bbb");
    }

    // 2. Non-write IO error maps to failed with a typed payload
    const writeDiskIoError = vi.fn(async () => {
      throw new Error("sync temp file: os error 5");
    });
    const outcome2 = await ctrl.executeSaveTransaction(tx, writeDiskIoError, {
      getLatestBufferVersion: () => 1,
    });
    expect(outcome2.kind).toBe("failed");
    if (outcome2.kind === "failed") {
      expect(outcome2.error.message).toContain("Disk write failed: sync temp file: os error 5");
      expect(outcome2.error.kind).toBe("io");
    }
  });

  it("rejects transactions whose workspaceId does not match the controller", async () => {
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider: { readFile: async () => null },
    });
    const tx: SaveTransactionV2 = {
      id: "tx-other",
      workspaceId: "ws-OTHER",
      fileKey: "key-x",
      filePath: "/project/app.ts",
      bufferVersion: 1,
      styleGeneration: 0,
      expectedDiskHash: null,
      policy: { eol: "lf", encoding: "UTF-8", bom: false },
      text: "x\n",
    };
    const outcome = await ctrl.executeSaveTransaction(tx, writeDiskMock(async () => ({
      kind: "written",
      hash: "h",
      file: fakeWrittenFile("h"),
    })));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.message).toContain("workspaceId mismatch");
    }
  });

  it("maps style generation change to a pre-write cancellation without invoking the writer", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-gen",
      roots: [{ path: "/project" }],
      fileProvider,
    });
    const writeDisk = vi.fn(async () => ({ kind: "written", hash: "h", file: fakeWrittenFile("h") } as const));
    const gen = ctrl.getGeneration();
    const tx: SaveTransactionV2 = {
      id: "tx-gen",
      workspaceId: "ws-gen",
      fileKey: "key-gen",
      filePath: "/project/app.ts",
      bufferVersion: 1,
      styleGeneration: gen,
      expectedDiskHash: null,
      policy: { eol: "lf", encoding: "UTF-8", bom: false },
      text: "x\n",
    };

    const promise = ctrl.executeSaveTransaction(tx, writeDisk, {
      getLatestBufferVersion: () => 1,
    });
    // Style invalidation races between prepare and pre-write.
    ctrl.invalidate("/project/.editorconfig");
    const outcome = await promise;

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind === "cancelled") {
      expect(outcome.phase).toBe("pre-write");
      expect(outcome.reason).toContain("style generation");
    }
    expect(writeDisk).not.toHaveBeenCalled();
  });
});
