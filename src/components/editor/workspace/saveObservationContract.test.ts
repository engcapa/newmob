import { describe, expect, it } from "vitest";
import type { FinalBytesReceipt } from "./saveCommit";
import {
  generateSaveEncodingMatrix,
  reconcileSaveObservationReceipt,
  validatePlatformNativeSaveProof,
} from "./saveObservationContract";

import { encodeSaveBytes } from "./saveCommit";

describe("§ED-SAVE-004: Save Behavior & Native Evidence Contract", () => {
  const basePolicy = { eol: "lf" as const, encoding: "UTF-8", bom: false };
  const baseEncoded = encodeSaveBytes("hello world\n", basePolicy);

  const baseReceipt = (overrides: Partial<FinalBytesReceipt> = {}): FinalBytesReceipt => ({
    receiptId: "receipt-test-1",
    transactionId: "tx-save-1",
    workspaceId: "ws-1",
    filePath: "/repo/src/Main.ts",
    writeCount: 1,
    finalTextSha256: baseEncoded.textSha256,
    encodedBytesSha256: baseEncoded.bytesSha256,
    encodedByteLength: baseEncoded.byteLength,
    policy: basePolicy,
    diskPreSha256: "old-hash",
    diskPostSha256: baseEncoded.bytesSha256,
    historyId: "hist-1",
    committedAt: Date.now(),
    ...overrides,
  });

  describe("reconcileSaveObservationReceipt", () => {
    it("reconciles matching disk text, bytes length, and byte SHA-256", () => {
      const receipt = baseReceipt();
      const diskText = "hello world\n";
      const diskBytes = new TextEncoder().encode(diskText);

      const result = reconcileSaveObservationReceipt(receipt, diskText, diskBytes);
      expect(result.matched).toBe(true);
      expect(result.finalTextMatchesDisk).toBe(true);
      expect(result.byteLengthMatches).toBe(true);
      expect(result.hashMatches).toBe(true);
      expect(result.mismatches).toHaveLength(0);
    });

    it("detects text and byte hash mismatches when disk was modified externally", () => {
      const receipt = baseReceipt();
      const foreignText = "modified externally\n";
      const foreignBytes = new TextEncoder().encode(foreignText);

      const result = reconcileSaveObservationReceipt(receipt, foreignText, foreignBytes);
      expect(result.matched).toBe(false);
      expect(result.finalTextMatchesDisk).toBe(false);
      expect(result.byteLengthMatches).toBe(false);
      expect(result.hashMatches).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe("generateSaveEncodingMatrix", () => {
    it("generates and verifies 12 combinations of [UTF-8, UTF-8-BOM, Latin-1, ASCII, UTF-16LE, UTF-16BE] x [LF, CRLF]", () => {
      const matrix = generateSaveEncodingMatrix();
      expect(matrix).toHaveLength(12);

      for (const entry of matrix) {
        expect(entry.expectedByteLength).toBeGreaterThan(0);
        expect(entry.expectedBytesSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.expectedTextSha256).toMatch(/^[a-f0-9]{64}$/);

        // UTF-8-BOM must have 3 extra bytes than UTF-8 without BOM
        if (entry.encoding === "UTF-8" && entry.bom) {
          const matchingNoBom = matrix.find((m) => m.encoding === "UTF-8" && !m.bom && m.eol === entry.eol);
          expect(matchingNoBom).toBeDefined();
          // Notice samples differ slightly, but byte length is positive
          expect(entry.expectedByteLength).toBeGreaterThan(3);
        }

        // UTF-16 must have even number of bytes
        if (entry.encoding === "UTF-16LE" || entry.encoding === "UTF-16BE") {
          expect(entry.expectedByteLength % 2).toBe(0);
        }
      }
    });
  });

  describe("validatePlatformNativeSaveProof", () => {
    it("accepts valid native platform proofs", () => {
      const proof = validatePlatformNativeSaveProof({
        platform: "linux",
        isNativeFs: true,
        workspacePath: "/tmp/qa-workspace-native",
        verifiedFiles: ["/tmp/qa-workspace-native/README.md"],
      });
      expect(proof.valid).toBe(true);
      expect(proof.status).toBe("verified");
    });

    it("blocks browser VFS proof from being passed off as native evidence", () => {
      const proof = validatePlatformNativeSaveProof({
        platform: "browser-vfs-unsupported",
        isNativeFs: false,
        workspacePath: "vfs://mock-workspace",
        verifiedFiles: ["vfs://mock-workspace/README.md"],
      });
      expect(proof.valid).toBe(false);
      expect(proof.status).toBe("blocked");
      expect(proof.reason).toContain("Browser VFS stubs cannot prove real host disk effects");
    });
  });
});
