import { describe, expect, it } from "vitest";
// @ts-expect-error node builtin without DOM+node merged globals
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
import {
  auditCapabilityMatrix,
  type CapabilityMatrixRecord,
} from "./capabilityMatrixAudit";

function evidenceDir(): string {
  const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
  const candidates = [
    join(cwd, "qa-ui-auto-tests", "evidence"),
    join(cwd, "..", "..", "..", "qa-ui-auto-tests", "evidence"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, "linux-matrix.2026-09-04.json")));
  if (!found) throw new Error("linux matrix artifact not found");
  return found;
}

interface LinuxMatrixFile {
  schema: string;
  generated_at: string;
  provider_traces_satisfied: boolean;
  gaps: string[];
  records: CapabilityMatrixRecord[];
}

function loadMatrix(): LinuxMatrixFile {
  const raw = readFileSync(join(evidenceDir(), "linux-matrix.2026-09-04.json"), "utf8");
  return JSON.parse(raw) as LinuxMatrixFile;
}

describe("ED-QA-003: committed Linux matrix artifact", () => {
  it("is built from real artifacts with zero builder gaps", () => {
    const matrix = loadMatrix();
    expect(matrix.schema).toBe("taomni.linux-matrix.v1");
    expect(matrix.provider_traces_satisfied).toBe(true);
    expect(matrix.gaps).toEqual([]);
    expect(matrix.records).toHaveLength(25);
  });

  it("audits to the exact bounded claim: 10 PASS / 1 budget FAIL / 14 platform BLOCKED", () => {
    const matrix = loadMatrix();
    const summary = auditCapabilityMatrix(matrix.records);
    expect(summary.passedCount).toBe(10);
    expect(summary.failedCount).toBe(1);
    expect(summary.blockedCount).toBe(14);
    expect(summary.linuxPassedCount).toBe(10);
    expect(summary.nonLinuxBlockedCount).toBe(14);
    expect(summary.extrapolationViolations).toEqual([]);
    // The single FAIL is the measured key-to-paint budget miss, not a
    // functional failure: the matrix stays honest instead of compliant.
    expect(summary.compliant).toBe(false);
    expect(summary.p95Violations).toEqual([]);
  });

  it("marks every Linux PASS row as runner-artifact with committed receipts on disk", () => {
    const matrix = loadMatrix();
    const passed = matrix.records.filter(
      (record) => record.platform === "linux" && record.status === "PASS",
    );
    expect(passed.length).toBe(10);
    for (const record of passed) {
      expect(record.origin).toBe("runner-artifact");
      for (const receipt of record.effectReceipts) {
        expect(existsSync(join(evidenceDir(), receipt))).toBe(true);
      }
    }
  });

  it("keeps Windows/macOS independently blocked with reasons (no extrapolation)", () => {
    const matrix = loadMatrix();
    const blocked = matrix.records.filter((record) => record.status === "BLOCKED");
    expect(blocked.length).toBe(14);
    for (const record of blocked) {
      expect(["windows", "macos"]).toContain(record.platform);
      expect(record.executionMode).toBe("blocked-external");
      expect(record.blockedReason).toBeTruthy();
    }
  });
});
