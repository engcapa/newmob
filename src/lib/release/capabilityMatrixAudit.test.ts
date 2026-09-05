import { describe, expect, it } from "vitest";
import {
  computePerfMetrics,
  auditCapabilityMatrix,
  type CapabilityMatrixRecord,
} from "./capabilityMatrixAudit";

describe("ED-QA-003: capabilityMatrixAudit Linux packaged and cross-platform matrix", () => {
  const validLinuxRecord: CapabilityMatrixRecord = {
    capabilityId: "C0-save-pipeline",
    name: "Save Pipeline",
    platform: "linux",
    executionMode: "packaged",
    expectedBehavior: "Atomic disk write preserves normalization with exact receipt match",
    observedBehavior: "Save completed in 24ms; file bytes matched expected SHA256",
    effectReceipts: ["atomic-disk-write", "final-bytes-receipt-match"],
    undoVerified: true,
    a11y: {
      keyboardFocus: true,
      nameRoleState: true,
      zoom200Percent: true,
      screenReaderAnnouncements: true,
      imeComposition: true,
    },
    perf: computePerfMetrics([20, 22, 25, 24, 30]),
    ideaParityDelta: "exact-match",
    status: "PASS",
    origin: "synthetic-fixture",
  };

  const blockedWindowsRecord: CapabilityMatrixRecord = {
    capabilityId: "C0-save-pipeline",
    name: "Save Pipeline",
    platform: "windows",
    executionMode: "blocked-external",
    expectedBehavior: "Atomic disk write on NTFS/ReFS",
    observedBehavior: "No Windows runner available; marked independently blocked",
    effectReceipts: [],
    undoVerified: false,
    a11y: {
      keyboardFocus: false,
      nameRoleState: false,
      zoom200Percent: false,
      screenReaderAnnouncements: false,
      imeComposition: false,
    },
    perf: computePerfMetrics([]),
    ideaParityDelta: "acceptable-delta",
    status: "BLOCKED",
    blockedReason: "Windows host environment unavailable in CI matrix",
    origin: "synthetic-fixture",
  };

  const blockedMacosRecord: CapabilityMatrixRecord = {
    capabilityId: "C0-save-pipeline",
    name: "Save Pipeline",
    platform: "macos",
    executionMode: "blocked-external",
    expectedBehavior: "Atomic disk write on APFS",
    observedBehavior: "No macOS runner available; marked independently blocked",
    effectReceipts: [],
    undoVerified: false,
    a11y: {
      keyboardFocus: false,
      nameRoleState: false,
      zoom200Percent: false,
      screenReaderAnnouncements: false,
      imeComposition: false,
    },
    perf: computePerfMetrics([]),
    ideaParityDelta: "acceptable-delta",
    status: "BLOCKED",
    blockedReason: "macOS host environment unavailable in CI matrix",
    origin: "synthetic-fixture",
  };

  it("audits compliant matrix where Linux passes and Windows/macOS are independently blocked", () => {
    const summary = auditCapabilityMatrix([validLinuxRecord, blockedWindowsRecord, blockedMacosRecord]);

    expect(summary.compliant).toBe(true);
    expect(summary.linuxPassedCount).toBe(1);
    expect(summary.nonLinuxBlockedCount).toBe(2);
    expect(summary.p95Violations).toEqual([]);
    expect(summary.extrapolationViolations).toEqual([]);
  });

  it("detects and rejects illegal platform extrapolation (marking Windows PASS based on Linux)", () => {
    const extrapolatedRecord: CapabilityMatrixRecord = {
      ...blockedWindowsRecord,
      status: "PASS", // Extrapolated pass
      executionMode: "blocked-external",
      observedBehavior: "",
    };

    const summary = auditCapabilityMatrix([validLinuxRecord, extrapolatedRecord]);
    expect(summary.compliant).toBe(false);
    expect(summary.extrapolationViolations).toHaveLength(1);
    expect(summary.extrapolationViolations[0]).toContain("extrapolation forbidden");
  });

  it("detects performance budget violations (p95 > budgetMs)", () => {
    const slowRecord: CapabilityMatrixRecord = {
      ...validLinuxRecord,
      perf: computePerfMetrics([50, 80, 120, 150, 180]), // p95 is ~150ms > 100ms budget
    };

    const summary = auditCapabilityMatrix([slowRecord]);
    expect(summary.compliant).toBe(false);
    expect(summary.p95Violations).toHaveLength(1);
    expect(summary.p95Violations[0].p95Ms).toBeGreaterThan(100);
  });
});

describe("ED-QA-003: runner-artifact provenance labeling", () => {
  it("keeps uncompared IDEA deltas and browser-proxy modes neutral (no violation)", () => {
    const row = {
      capabilityId: "query-definition",
      name: "Definition reveal",
      platform: "linux",
      executionMode: "browser-proxy",
      expectedBehavior: "typed unavailable fallback",
      observedBehavior: "References dock fallback observed in stub preview",
      effectReceipts: ["browser-TC-IDE-C6-02.summary.json"],
      undoVerified: false,
      a11y: {
        keyboardFocus: true,
        nameRoleState: true,
        zoom200Percent: false,
        screenReaderAnnouncements: false,
        imeComposition: false,
      },
      perf: computePerfMetrics([]),
      ideaParityDelta: "uncompared",
      status: "PASS",
      origin: "runner-artifact",
      perfOrigin: null,
    } as const;

    const summary = auditCapabilityMatrix([row]);
    expect(summary.compliant).toBe(true);
    expect(summary.linuxPassedCount).toBe(1);
    expect(summary.extrapolationViolations).toEqual([]);
  });
});
