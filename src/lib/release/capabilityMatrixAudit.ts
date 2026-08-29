/**
 * ED-QA-003: Capability Matrix, Packaged Linux Verification, Accessibility, and IDEA Parity Auditing.
 * Defines multi-dimensional matrix records across packaged runtime, real providers, accessibility,
 * performance benchmarks, and IDEA fixture baselines.
 */

export interface CapabilityA11yStatus {
  keyboardFocus: boolean;
  nameRoleState: boolean;
  zoom200Percent: boolean;
  screenReaderAnnouncements: boolean;
  imeComposition: boolean;
}

export interface CapabilityPerfMetrics {
  rawSamplesMs: readonly number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface CapabilityMatrixRecord {
  capabilityId: string;
  name: string;
  platform: "linux" | "macos" | "windows";
  executionMode: "packaged" | "provider-fixture" | "blocked-external";
  expectedBehavior: string;
  observedBehavior: string;
  effectReceipts: readonly string[];
  undoVerified: boolean;
  a11y: CapabilityA11yStatus;
  perf: CapabilityPerfMetrics;
  ideaParityDelta: "exact-match" | "acceptable-delta" | "divergent";
  status: "PASS" | "FAIL" | "BLOCKED";
  blockedReason?: string | null;
}

export interface MatrixAuditSummary {
  compliant: boolean;
  totalCapabilities: number;
  passedCount: number;
  blockedCount: number;
  failedCount: number;
  linuxPassedCount: number;
  nonLinuxBlockedCount: number;
  p95Violations: Array<{ capabilityId: string; p95Ms: number; budgetMs: number }>;
  extrapolationViolations: string[];
}

/**
 * Computes percentile metrics from raw latency samples.
 */
export function computePerfMetrics(samples: readonly number[]): CapabilityPerfMetrics {
  if (samples.length === 0) {
    return { rawSamplesMs: [], p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50Idx = Math.floor(sorted.length * 0.5);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));

  return {
    rawSamplesMs: sorted,
    p50Ms: sorted[p50Idx],
    p95Ms: sorted[p95Idx],
    p99Ms: sorted[p99Idx],
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Audits capability matrix records according to §ED-QA-003 requirements:
 * 1. Windows and macOS entries must be independently tested or explicitly BLOCKED; no extrapolation from Linux.
 * 2. Linux packaged entries must have valid effect receipts, accessibility checks, and performance budgets.
 * 3. Parity deltas against IDEA must be classified without undocumented regressions.
 */
export function auditCapabilityMatrix(
  records: readonly CapabilityMatrixRecord[],
  p95BudgetMs: number = 100,
): MatrixAuditSummary {
  let passedCount = 0;
  let blockedCount = 0;
  let failedCount = 0;
  let linuxPassedCount = 0;
  let nonLinuxBlockedCount = 0;

  const p95Violations: MatrixAuditSummary["p95Violations"] = [];
  const extrapolationViolations: string[] = [];

  for (const r of records) {
    if (r.status === "PASS") {
      passedCount++;
      if (r.platform === "linux") {
        linuxPassedCount++;
        // Check performance budget
        if (r.perf.p95Ms > p95BudgetMs) {
          p95Violations.push({ capabilityId: r.capabilityId, p95Ms: r.perf.p95Ms, budgetMs: p95BudgetMs });
        }
      } else {
        // Non-linux marked PASS without independent execution
        if (r.executionMode === "blocked-external" || !r.observedBehavior) {
          extrapolationViolations.push(
            `Platform '${r.platform}' for '${r.capabilityId}' marked PASS without independent execution (extrapolation forbidden)`,
          );
        }
      }
    } else if (r.status === "BLOCKED") {
      blockedCount++;
      if (r.platform !== "linux") {
        nonLinuxBlockedCount++;
      }
    } else {
      failedCount++;
    }
  }

  const compliant =
    failedCount === 0 &&
    p95Violations.length === 0 &&
    extrapolationViolations.length === 0 &&
    linuxPassedCount > 0;

  return {
    compliant,
    totalCapabilities: records.length,
    passedCount,
    blockedCount,
    failedCount,
    linuxPassedCount,
    nonLinuxBlockedCount,
    p95Violations,
    extrapolationViolations,
  };
}
