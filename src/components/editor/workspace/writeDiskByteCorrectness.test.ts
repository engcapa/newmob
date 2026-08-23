import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceStyleController,
  type PreparedSaveCommitter,
  type SaveTransactionV2,
} from "./workspaceStyleController";
import { saveCommitResultFromError } from "./saveCommit";
import type { PreparedSave, SaveCommitResult } from "./saveCommit";
import type { WorkspaceFile } from "../../../lib/editor/workspace";

function fakeWrittenFile(hash: string): WorkspaceFile {
  return { path: "/workspace/src/test.txt", text: "", hash, size: 0, mtime: 0 };
}

/** Committer mock that records the frozen PreparedSave fields it receives. */
function writeDiskMock(
  impl: (path: string, text: string, hash: string | null, encoding: string, bom: boolean, eol: string) => Promise<SaveCommitResult>,
): PreparedSaveCommitter {
  // vi.fn keeps spy assertions working; the cast restores the committer type.
  return vi.fn(async (prepared: PreparedSave) => impl(
    prepared.filePath,
    prepared.text,
    prepared.expectedDiskHash,
    prepared.policy.encoding,
    prepared.policy.bom,
    prepared.policy.eol,
  )) as unknown as PreparedSaveCommitter;
}

/** Full-fact committed result a real commit core returns after bytes land. */
function committedCommitter(file: WorkspaceFile): PreparedSaveCommitter {
  return vi.fn(async (prepared: PreparedSave): Promise<SaveCommitResult> => ({
    kind: "saved-current",
    transactionId: prepared.transactionId,
    diskEffect: "committed",
    memoryEffect: "saved-current",
    providerEffect: "did-save",
    file,
  }));
}
import { applyWorkspaceEdit, type WorkspaceEditApplyHooks } from "./workspaceEditApply";
import {
  WorkspaceHashMismatchError,
  isWorkspaceHashMismatchError,
  parseWorkspaceWriteError,
} from "../../../lib/editor/workspace";
import codeWorkspaceTabSource from "../CodeWorkspaceTab.tsx?raw";

describe("P0-A / N1.6 Write-Disk Byte Correctness Matrix", () => {
  const eolModes: Array<{ name: string; eol: "lf" | "crlf" | "cr"; sep: string }> = [
    { name: "LF", eol: "lf", sep: "\n" },
    { name: "CRLF", eol: "crlf", sep: "\r\n" },
    { name: "CR", eol: "cr", sep: "\r" },
  ];

  // 1. 9 EOL × 3 write paths = 9 byte equality test cases
  describe("9 EOL × 3 write paths matrix", () => {
    eolModes.forEach(({ name, eol, sep }) => {
      it(`Path A (Open Buffer Save): preserves ${name} line endings on disk write`, async () => {
        const ctrl = new WorkspaceStyleController({
          workspaceId: "ws-test",
          roots: [{ path: "/workspace" }],
          fileProvider: { readFile: async () => null },
        });

        let savedContent = "";
        let savedEol: string | undefined;
        let savedExpectedHash: string | null = null;
        const writeDisk = writeDiskMock(async (_path, text, expectedHash, _enc, _bom, eol) => {
          savedContent = text;
          savedEol = eol;
          savedExpectedHash = expectedHash;
          return {
            kind: "saved-current",
            transactionId: `tx-save`,
            diskEffect: "committed",
            memoryEffect: "saved-current",
            providerEffect: "did-save",
            file: fakeWrittenFile("new-disk-hash"),
          };
        });

        const tx: SaveTransactionV2 = {
          id: `tx-save-${eol}`,
          workspaceId: "ws-test",
          fileKey: "key-1",
          filePath: "/workspace/src/test.txt",
          bufferVersion: 1,
          styleGeneration: 0,
          expectedDiskHash: "old-hash",
          policy: { eol, encoding: "UTF-8", bom: false },
          text: `alpha\nbeta\ngamma`,
        };

        const outcome = await ctrl.executeSaveTransaction(tx, writeDisk, {
          getLatestBufferVersion: () => 1,
        });

        expect(outcome.kind).toBe("saved-current");
        expect(writeDisk).toHaveBeenCalledTimes(1);
        expect(savedEol).toBe(eol);
        expect(savedContent).toBe(`alpha${sep}beta${sep}gamma`);
        expect(savedExpectedHash).toBe("old-hash");
        if (outcome.kind === "saved-current") {
          expect(outcome.file.hash).toBe("new-disk-hash");
        }
      });

      it(`Path B (Open Clean Buffer WorkspaceEdit): preserves ${name} line endings`, async () => {
        let appliedText = "";
        let savedText = "";
        const hooks: WorkspaceEditApplyHooks = {
          resolvePath: (f) => f.path ?? "/workspace/src/open.txt",
          getOpenBuffer: () => ({
            key: "key-open",
            version: 1,
            dirty: false,
            lspSynced: true,
            text: `first${sep}second`,
          }),
          applyToOpenBuffer: (_key, next) => {
            appliedText = next;
          },
          saveOpenBuffer: async (_key, next) => {
            savedText = next;
          },
          readDisk: async () => null,
          writeDisk: async () => {},
        };

        const edit = {
          documentEdits: [
            {
              uri: "file:///workspace/src/open.txt",
              path: "/workspace/src/open.txt",
              edits: [
                {
                  range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                  newText: "_modified",
                },
              ],
            },
          ],
        };

        const outcomes = await applyWorkspaceEdit(edit, hooks);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("applied-open");
        expect(appliedText).toBe(`first_modified${sep}second`);
        expect(savedText).toBe(`first_modified${sep}second`);
      });

      it(`Path C (Closed File WorkspaceEdit): passes ${name} diskEol to writeDisk`, async () => {
        let writtenDiskText = "";
        let writtenDiskEol: string | undefined;
        const initialDiskText = `lineA${sep}lineB${sep}lineC`;

        const hooks: WorkspaceEditApplyHooks = {
          resolvePath: (f) => f.path ?? "/workspace/src/closed.txt",
          getOpenBuffer: () => null, // closed file
          applyToOpenBuffer: () => {},
          saveOpenBuffer: async () => {},
          readDisk: async () => ({
            text: initialDiskText,
            hash: "closed-hash-1",
            encoding: "UTF-8",
            bom: false,
            eol,
          }),
          writeDisk: async (_path, text, _expectedHash, _encoding, _bom, passedEol) => {
            writtenDiskText = text;
            writtenDiskEol = passedEol;
          },
        };

        const edit = {
          documentEdits: [
            {
              uri: "file:///workspace/src/closed.txt",
              path: "/workspace/src/closed.txt",
              edits: [
                {
                  range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                  newText: "lineB_updated",
                },
              ],
            },
          ],
        };

        const outcomes = await applyWorkspaceEdit(edit, hooks);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]?.status).toBe("applied-disk");
        expect(writtenDiskEol).toBe(eol);
        expect(writtenDiskText).toBe(`lineA${sep}lineB_updated${sep}lineC`);
      });
    });
  });

  // 2. Concurrent edits during save
  describe("Concurrent edit protection", () => {
    it("cancels save and makes zero disk writes when buffer version changed during normalization", async () => {
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: { readFile: async () => null },
      });

      const writeDisk = vi.fn(committedCommitter(fakeWrittenFile("should-not-write")));
      let version = 1;

      const tx: SaveTransactionV2 = {
        id: "tx-concurrent",
        workspaceId: "ws-test",
        fileKey: "key-1",
        filePath: "/workspace/src/doc.ts",
        bufferVersion: 1,
        styleGeneration: 0,
        expectedDiskHash: "h1",
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "function test() { return 1; }\n",
      };

      const outcome = await ctrl.executeSaveTransaction(
        tx,
        writeDisk,
        {
          formatOnSave: true,
          formatFn: async (text) => {
            // Concurrent edit occurs while formatting is in-flight:
            version = 2;
            return text;
          },
          getLatestBufferVersion: () => version,
        },
      );

      expect(outcome.kind).toBe("cancelled");
      if (outcome.kind === "cancelled") {
        expect(outcome.phase).toBe("prepare");
      }
      expect(writeDisk).not.toHaveBeenCalled();
    });

    it("cancels save with zero disk writes on same-length concurrent edit", async () => {
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: { readFile: async () => null },
      });

      const writeDisk = vi.fn(committedCommitter(fakeWrittenFile("should-not-write")));

      const tx: SaveTransactionV2 = {
        id: "tx-same-len",
        workspaceId: "ws-test",
        fileKey: "key-1",
        filePath: "/workspace/src/doc.ts",
        bufferVersion: 5,
        styleGeneration: 0,
        expectedDiskHash: "h1",
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "const a = 100;\n",
      };

      const outcome = await ctrl.executeSaveTransaction(
        tx,
        writeDisk,
        {
          getLatestBufferVersion: () => 6, // Version advanced from 5 -> 6 (e.g. edited to "const b = 200;\n")
        },
      );

      expect(outcome.kind).toBe("cancelled");
      expect(writeDisk).not.toHaveBeenCalled();
    });
  });

  // 3. Explicit Indentation Override in Save Transaction
  describe("Indentation override propagation", () => {
    it("applies status bar explicitOverride during save resolution", async () => {
      // EditorConfig specifies 2 spaces, but status bar overrides to tabs
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: {
          readFile: async () => "root = true\n[*]\nindent_style = space\nindent_size = 2\n",
        },
      });

      const tx: SaveTransactionV2 = {
        id: "tx-override",
        workspaceId: "ws-test",
        fileKey: "key-override",
        filePath: "/workspace/src/app.ts",
        bufferVersion: 1,
        styleGeneration: 0,
        expectedDiskHash: "h1",
        explicitOverride: { type: "tabs", size: 4 },
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "function main() {\n  return;\n}\n",
      };

      const writeDisk = vi.fn(committedCommitter(fakeWrittenFile("hash-saved")));

      const outcome = await ctrl.executeSaveTransaction(tx, writeDisk);
      expect(outcome.kind).toBe("saved-current");
      expect(writeDisk).toHaveBeenCalledTimes(1);

      // Verify explicitOverride was used in resolveForFile
      const resolved = await ctrl.resolveForFile({
        filePath: "/workspace/src/app.ts",
        explicitOverride: tx.explicitOverride,
      });
      expect(resolved.insertSpaces).toBe(false);
      expect(resolved.tabSize).toBe(4);
      expect(resolved.source).toBe("explicit-override");
    });
  });

  // 4. Typed Hash-Mismatch Conflict Detection
  describe("Typed hash-mismatch conflict detection", () => {
    it("identifies WorkspaceHashMismatchError and sets outcome to conflict", async () => {
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: { readFile: async () => null },
      });

      const writeDiskMismatch = vi.fn(async () => {
        throw new WorkspaceHashMismatchError(
          "hash-mismatch: Backend message with custom wording",
          "expected_aaa",
          "found_bbb",
        );
      });

      const tx: SaveTransactionV2 = {
        id: "tx-mismatch",
        workspaceId: "ws-test",
        fileKey: "key-1",
        filePath: "/workspace/src/file.ts",
        bufferVersion: 1,
        styleGeneration: 0,
        expectedDiskHash: "expected_aaa",
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "console.log('hi');\n",
      };

      // §8.18.1: the commit core (not the controller) is the classifier. A
      // raw throw from the committer propagates unclassified; the shared
      // classifier the core uses must map it to a typed conflict.
      await expect(ctrl.executeSaveTransaction(tx, writeDiskMismatch)).rejects.toThrow(
        "Backend message with custom wording",
      );
      const mapped = saveCommitResultFromError("tx-mismatch", new WorkspaceHashMismatchError(
        "hash-mismatch: Backend message with custom wording",
        "expected_aaa",
        "found_bbb",
      ));
      expect(mapped.kind).toBe("conflict");
      expect(mapped.diskEffect).toBeUndefined();
      expect(mapped.error.kind).toBe("hash-mismatch");
      expect(mapped.error.expectedHash).toBe("expected_aaa");
      expect(mapped.error.actualHash).toBe("found_bbb");
    });

    it("parses IPC string error with hash-mismatch prefix into WorkspaceHashMismatchError", () => {
      const rawError = new Error(
        "hash-mismatch: File changed on disk; expected hash a1b2c3d4, found e5f60718",
      );
      const parsed = parseWorkspaceWriteError(rawError);

      expect(isWorkspaceHashMismatchError(parsed)).toBe(true);
      if (parsed instanceof WorkspaceHashMismatchError) {
        expect(parsed.kind).toBe("hash-mismatch");
        expect(parsed.expected).toBe("a1b2c3d4");
        expect(parsed.actual).toBe("e5f60718");
      }
    });

    it("treats non-hash-mismatch disk errors as typed failures", async () => {
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: { readFile: async () => null },
      });

      const writeDiskPermissionDenied = vi.fn(async () => {
        throw new Error("Permission denied (EACCES)");
      });

      const tx: SaveTransactionV2 = {
        id: "tx-perm",
        workspaceId: "ws-test",
        fileKey: "key-1",
        filePath: "/workspace/src/file.ts",
        bufferVersion: 1,
        styleGeneration: 0,
        expectedDiskHash: null,
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "console.log('hi');\n",
      };

      // A raw throw propagates; the shared commit-core classifier maps it to
      // a typed zero-effect failure.
      await expect(ctrl.executeSaveTransaction(tx, writeDiskPermissionDenied)).rejects.toThrow(
        "Permission denied (EACCES)",
      );
      const mapped = saveCommitResultFromError("tx-perm", new Error("Permission denied (EACCES)"));
      expect(mapped.kind).toBe("failed");
      expect(mapped.error.kind).toBe("io");
    });
  });

  describe("Typed IPC write error normalization (P0-S3)", () => {
    it("normalizes by kind regardless of message wording", () => {
      const ioMessages = [
        "open temp file: os error 5",
        "mkdir parent: directory creation failed",
        "rename temp file: replace refused",
      ];
      for (const message of ioMessages) {
        expect(parseWorkspaceWriteError({ kind: "io", message }).kind).toBe("io");
      }
      expect(
        parseWorkspaceWriteError({ kind: "encoding", message: "unrelated wording" }).kind,
      ).toBe("encoding");
      expect(
        parseWorkspaceWriteError({ kind: "permission", message: "access check said no" }).kind,
      ).toBe("permission");
    });

    it("keeps expected/actual hashes from typed hash-mismatch payload", () => {
      const parsed = parseWorkspaceWriteError({
        kind: "hash-mismatch",
        message: "custom backend wording",
        expectedHash: "e1expected",
        actualHash: "a1actual",
      });
      expect(parsed.kind).toBe("hash-mismatch");
      expect(parsed.expectedHash).toBe("e1expected");
      expect(parsed.actualHash).toBe("a1actual");
    });

    it("still parses legacy string prefix errors from old backends", () => {
      const parsed = parseWorkspaceWriteError(
        new Error("hash-mismatch: File changed on disk; expected hash aaa, found bbb"),
      );
      expect(parsed.kind).toBe("hash-mismatch");
      if (parsed instanceof WorkspaceHashMismatchError) {
        expect(parsed.expected).toBe("aaa");
        expect(parsed.actual).toBe("bbb");
      }
    });

    it("maps typed cancelled writer result to cancelled outcome", async () => {
      const ctrl = new WorkspaceStyleController({
        workspaceId: "ws-test",
        roots: [{ path: "/workspace" }],
        fileProvider: { readFile: async () => null },
      });
      const tx: SaveTransactionV2 = {
        id: "tx-cancelled",
        workspaceId: "ws-test",
        fileKey: "key-1",
        filePath: "/workspace/src/file.ts",
        bufferVersion: 1,
        styleGeneration: 0,
        expectedDiskHash: null,
        policy: { eol: "lf", encoding: "UTF-8", bom: false },
        text: "body\n",
      };
      const writeDisk = vi.fn(async (prepared: PreparedSave): Promise<SaveCommitResult> => ({
        kind: "cancelled",
        transactionId: prepared.transactionId,
        diskEffect: "none",
        memoryEffect: "unchanged",
        providerEffect: "not-sent",
        phase: "pre-write",
        reason: "Buffer modified during save preparation",
      }));
      const outcome = await ctrl.executeSaveTransaction(tx, writeDisk);
      expect(outcome.kind).toBe("cancelled");
      if (outcome.kind === "cancelled") {
        expect(outcome.reason).toBe("Buffer modified during save preparation");
      }
    });
  });

  // 5. Grep guard test: writeTextSnapshot is the ONLY caller of workspaceWrite* in CodeWorkspaceTab.tsx
  describe("Grep guard test for single write path", () => {
    it("ensures workspaceWriteFileEncoded / workspaceWriteLooseFileEncoded are only called inside writeTextSnapshot", () => {
      const content = codeWorkspaceTabSource;

      // Extract the body of writeTextSnapshot
      const match = content.match(/const writeTextSnapshot = useCallback\(async \([\s\S]*?\n  \}, \[\]\);/);
      expect(match).not.toBeNull();
      const writeTextSnapshotBody = match![0];

      // Remove writeTextSnapshot body and import statement from content
      const contentWithoutWriteTextSnapshot = content
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'].*\/workspace["'];?/, "")
        .replace(writeTextSnapshotBody, "");

      // Assert no other calls to workspaceWriteFileEncoded or workspaceWriteLooseFileEncoded exist
      expect(contentWithoutWriteTextSnapshot).not.toContain("workspaceWriteFileEncoded(");
      expect(contentWithoutWriteTextSnapshot).not.toContain("workspaceWriteLooseFileEncoded(");
      expect(contentWithoutWriteTextSnapshot).not.toContain("workspaceWriteFile(");
      expect(contentWithoutWriteTextSnapshot).not.toContain("workspaceWriteLooseFile(");
    });
  });
});
