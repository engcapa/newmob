import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceStyleController,
  createWorkspaceStyleController,
  type PreparedSaveCommitter,
  type SaveTransactionV2,
} from "./workspaceStyleController";
import {
  buildPreparedSave,
  resolveWritePolicy,
  type PreparedSave,
  type SaveCommitResult,
} from "./saveCommit";
import type { WorkspaceFile } from "../../../lib/editor/workspace";

function fakeWrittenFile(hash: string): WorkspaceFile {
  return { path: "/project/app.ts", text: "", hash, size: 0, mtime: 0 };
}

/** Full-fact committed result as a real commit core would return it. */
function savedCurrentCommitter(file: WorkspaceFile = fakeWrittenFile("hash-saved-1")): PreparedSaveCommitter {
  return vi.fn(async (prepared: PreparedSave): Promise<SaveCommitResult> => ({
    kind: "saved-current",
    transactionId: prepared.transactionId,
    diskEffect: "committed",
    memoryEffect: "saved-current",
    providerEffect: "did-save",
    file,
  }));
}

describe("WorkspaceStyleController (§8.18.1)", () => {
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

    // A committer that would report committed bytes if ever invoked.
    const commit = vi.fn(savedCurrentCommitter());

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
    const outcome = await ctrl.executeSaveTransaction(tx, commit, {
      getLatestBufferVersion: () => currentVersion,
    });

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind === "cancelled") {
      // Prepare-phase cancellation is provably zero-effect on every axis.
      expect(outcome.phase).toBe("pre-write");
      expect(outcome.diskEffect).toBe("none");
      expect(outcome.memoryEffect).toBe("unchanged");
      expect(outcome.providerEffect).toBe("not-sent");
      expect(outcome.reason).toContain("revision changed");
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("freezes normalized bytes/policy into one PreparedSave and hands it to the single committer", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    let writtenText = "";
    let writtenEol = "";
    let preparedHash: string | null = null;
    const commit: PreparedSaveCommitter = vi.fn(async (prepared): Promise<SaveCommitResult> => {
      writtenText = prepared.text;
      writtenEol = prepared.policy.eol;
      preparedHash = prepared.expectedDiskHash;
      return {
        kind: "saved-stale-snapshot",
        transactionId: prepared.transactionId,
        diskEffect: "committed",
        memoryEffect: "kept-dirty",
        providerEffect: "did-change-current",
        file: fakeWrittenFile("hash-saved-1"),
        savedRevision: prepared.bufferRevision,
        currentRevision: prepared.bufferRevision + 1,
      };
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

    const outcome = await ctrl.executeSaveTransaction(tx, commit, {
      getLatestBufferVersion: () => 1,
    });

    expect(writtenText).toBe("line1\r\nline2\r\n");
    expect(writtenEol).toBe("crlf");
    expect(preparedHash).toBeNull();
    // The controller returns the committer's classification verbatim: a
    // stale-snapshot save stays stale instead of being relabelled.
    expect(outcome.kind).toBe("saved-stale-snapshot");
    if (outcome.kind === "saved-stale-snapshot") {
      expect(outcome.transactionId).toBe(tx.id);
      expect(outcome.file.hash).toBe("hash-saved-1");
      expect(outcome.savedRevision).toBe(1);
      expect(outcome.currentRevision).toBe(2);
    }
  });

  it("fails typed on unencodable characters for Latin-1 policy before any write", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider,
    });

    const commit = vi.fn(savedCurrentCommitter(fakeWrittenFile("dummy")));

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

    const outcome = await ctrl.executeSaveTransaction(tx, commit);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.kind).toBe("encoding");
      expect(outcome.diskEffect).toBe("none");
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("returns the commit core's typed conflict/failed verbatim without reinterpreting them", async () => {
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-1",
      roots: [{ path: "/project" }],
      fileProvider: { readFile: async () => null },
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

    // 1. Committer reports a hash conflict with zero disk effect.
    const commitConflict: PreparedSaveCommitter = vi.fn(async (prepared): Promise<SaveCommitResult> => ({
      kind: "conflict",
      transactionId: prepared.transactionId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      error: {
        kind: "hash-mismatch",
        message: "Disk hash conflict: expected aaa found bbb",
        expectedHash: "aaa",
        actualHash: "bbb",
      },
    }));
    const outcome1 = await ctrl.executeSaveTransaction(tx, commitConflict, {
      getLatestBufferVersion: () => 1,
    });
    expect(outcome1).toEqual(await Promise.resolve(outcome1));
    expect(outcome1.kind).toBe("conflict");

    // 2. Committer reports an unknown disk effect with a recovery id; the
    // controller must not downgrade it to a plain failed/none result.
    const commitUnknown: PreparedSaveCommitter = vi.fn(async (prepared): Promise<SaveCommitResult> => ({
      kind: "failed",
      transactionId: prepared.transactionId,
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      error: { kind: "io", message: "invoke bridge dropped" },
      recoveryId: prepared.transactionId,
    }));
    const outcome2 = await ctrl.executeSaveTransaction(tx, commitUnknown, {
      getLatestBufferVersion: () => 1,
    });
    expect(outcome2.kind).toBe("failed");
    if (outcome2.kind === "failed") {
      expect(outcome2.diskEffect).toBe("unknown");
      expect(outcome2.recoveryId).toBe(tx.id);
    }

    // 3. Committer reports committed-but-discarded after close/unmount; the
    // controller must never map that back to cancelled or saved-current.
    const commitDiscarded: PreparedSaveCommitter = vi.fn(async (prepared): Promise<SaveCommitResult> => ({
      kind: "committed-writeback-discarded",
      transactionId: prepared.transactionId,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      file: fakeWrittenFile("h"),
      reason: "Open buffer closed while writer was in flight",
    }));
    const outcome3 = await ctrl.executeSaveTransaction(tx, commitDiscarded);
    expect(outcome3.kind).toBe("committed-writeback-discarded");
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
    const commit = vi.fn(savedCurrentCommitter(fakeWrittenFile("h")));
    const outcome = await ctrl.executeSaveTransaction(tx, commit);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.message).toContain("workspaceId mismatch");
      expect(outcome.diskEffect).toBe("none");
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("maps style generation change to a pre-write cancellation without invoking the committer", async () => {
    const fileProvider = { readFile: vi.fn(async () => null) };
    const ctrl = new WorkspaceStyleController({
      workspaceId: "ws-gen",
      roots: [{ path: "/project" }],
      fileProvider,
    });
    const commit = vi.fn(savedCurrentCommitter(fakeWrittenFile("h")));
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

    const promise = ctrl.executeSaveTransaction(tx, commit, {
      getLatestBufferVersion: () => 1,
    });
    // Style invalidation races between prepare and pre-write.
    ctrl.invalidate("/project/.editorconfig");
    const outcome = await promise;

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind === "cancelled") {
      expect(outcome.phase).toBe("pre-write");
      expect(outcome.diskEffect).toBe("none");
      expect(outcome.reason).toContain("style generation");
    }
    expect(commit).not.toHaveBeenCalled();
  });

  it("builds a PreparedSave through the shared builder with resolved policy", () => {
    const prepared = buildPreparedSave({
      transactionId: "tx-b",
      workspaceId: "ws-b",
      fileKey: "k",
      filePath: "/p/f.txt",
      text: "a\r\nb\r\n",
      bufferRevision: 3,
      styleGeneration: 7,
      expectedDiskHash: "abc",
      policy: resolveWritePolicy({ explicit: { eol: "crlf", encoding: "UTF-8", bom: true } }),
    });
    expect(prepared.policy).toEqual({ eol: "crlf", encoding: "UTF-8", bom: true });
    expect(prepared.bufferRevision).toBe(3);
    expect(prepared.styleGeneration).toBe(7);
  });
});
