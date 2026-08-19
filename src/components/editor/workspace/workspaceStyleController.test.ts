import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceStyleController,
  createWorkspaceStyleController,
  type SaveTransactionV2,
} from "./workspaceStyleController";

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

    const writeDisk = vi.fn(async () => {});

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
      expect(outcome.retryable).toBe(true);
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
    const writeDisk = vi.fn(async (_path, text, _hash, _enc, _bom, eol) => {
      writtenText = text;
      writtenEol = eol ?? "";
      return { hash: "hash-saved-1" };
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

    expect(outcome.kind).toBe("saved");
    expect(writeDisk).toHaveBeenCalled();
    expect(writtenText).toBe("line1\r\nline2\r\n");
    expect(writtenEol).toBe("crlf");
    if (outcome.kind === "saved") {
      expect(outcome.hash).toBe("hash-saved-1");
    }
  });

  it("fails typed on unencodable characters for Latin-1 policy", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    const writeDisk = vi.fn(async () => ({ hash: "dummy" }));

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
      expect(outcome.retryable).toBe(false);
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
      expect(outcome1.retryable).toBe(true);
      expect(outcome1.reason).toContain("Disk hash conflict");
    }

    // 2. Missing hash from writer (no synthetic fallback)
    const writeDiskNoHash = vi.fn(async () => ({ hash: undefined }));
    const outcome2 = await ctrl.executeSaveTransaction(tx, writeDiskNoHash as any, {
      getLatestBufferVersion: () => 1,
    });
    expect(outcome2.kind).toBe("failed");
    if (outcome2.kind === "failed") {
      expect(outcome2.reason).toBe("writer returned no hash");
      expect(outcome2.retryable).toBe(false);
    }
  });
});
