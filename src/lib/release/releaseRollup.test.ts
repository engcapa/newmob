import { describe, expect, it } from "vitest";
import {
  buildReleaseRollupManifest,
  verifyReleaseRollupManifest,
} from "./releaseRollup";
import { createRunnerExecutionReceipt, type RunnerKeyRecord, type RunnerKeyRegistry } from "./runnerReceipt";
import type { ReleaseBundleIdentity } from "./bundleIdentity";
import type { ReleasePlan } from "./releasePlanValidator";

describe("ED-REL-004: releaseRollup byte-identical manifest & smoke verification", () => {
  const browserKey: RunnerKeyRecord = {
    keyId: "key-browser-01",
    issuer: "taomni-linux-browser-runner",
    purpose: "browser-runner",
    secretOrPublicKey: "secret-key-browser-123",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-31T23:59:59Z",
    revoked: false,
  };

  const registry: RunnerKeyRegistry = {
    keys: {
      "key-browser-01": browserKey,
    },
  };

  const sampleBundle: ReleaseBundleIdentity = {
    bundleId: "taomni-linux-x64-v0.4.20",
    version: "0.4.20",
    platform: "linux",
    sourceIdentityDigest: "sha256:src-digest-111",
    testPlanIdentityDigest: "sha256:plan-digest-222",
    combinedIdentityDigest: "sha256:comb-digest-333",
    trackedFileCount: 42,
    totalBytes: 81920,
  };

  const samplePlan: ReleasePlan = {
    version: 1,
    releaseChannels: {
      "linux-daily-editor": {
        platform: "linux",
        requiredCapabilities: ["C0-save-pipeline"],
        requiredEvidenceLayers: ["browser"],
        evidenceRoots: ["qa-ui-auto-report"],
      },
    },
  };

  it("produces byte-identical rollup manifests across multiple invocations", () => {
    const receipt1 = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-01",
        runnerId: "runner-linux-node20",
        keyId: "key-browser-01",
        purpose: "browser-runner",
        executedCommand: "pnpm test qa-ui-auto",
        commandDigest: "sha256:cmd-digest",
        startedAt: "2026-08-29T11:00:00.000Z",
        finishedAt: "2026-08-29T11:00:02.000Z",
        exitCode: 0,
        stdoutDigest: "sha256:stdout-ok",
        stderrDigest: "sha256:empty",
        artifacts: [{ path: "qa-ui-auto-report/smoke.json", sha256: "sha256:art", bytes: 100 }],
      },
      browserKey,
    );

    const m1 = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [receipt1],
      keyRegistry: registry,
      referenceTimeIso: "2026-08-29T12:00:00.000Z",
    });

    const m2 = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [receipt1],
      keyRegistry: registry,
      referenceTimeIso: "2026-08-29T12:00:00.000Z",
    });

    expect(m1.manifestDigest).toBe(m2.manifestDigest);
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
    expect(m1.overallStatus).toBe("PASS");
  });

  it("verifies manifest integrity in --check mode", () => {
    const receipt1 = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-01",
        runnerId: "runner-linux-node20",
        keyId: "key-browser-01",
        purpose: "browser-runner",
        executedCommand: "pnpm test qa-ui-auto",
        commandDigest: "sha256:cmd-digest",
        startedAt: "2026-08-29T11:00:00.000Z",
        finishedAt: "2026-08-29T11:00:02.000Z",
        exitCode: 0,
        stdoutDigest: "sha256:stdout-ok",
        stderrDigest: "sha256:empty",
        artifacts: [{ path: "qa-ui-auto-report/smoke.json", sha256: "sha256:art", bytes: 100 }],
      },
      browserKey,
    );

    const manifest = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [receipt1],
      keyRegistry: registry,
      referenceTimeIso: "2026-08-29T12:00:00.000Z",
    });

    const check = verifyReleaseRollupManifest(manifest, {
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [receipt1],
      keyRegistry: registry,
    });

    expect(check.valid).toBe(true);
    expect(check.manifestDigestMatched).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it("zero-entry receipt collection yields INCOMPLETE status (stable RED)", () => {
    const manifest = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [],
      keyRegistry: registry,
    });

    expect(manifest.overallStatus).toBe("INCOMPLETE");
    expect(manifest.channelRollups["linux-daily-editor"].status).toBe("INCOMPLETE");
  });

  it("failing receipt (exitCode !== 0) yields FAIL status", () => {
    const failedReceipt = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-fail",
        runnerId: "runner-linux-node20",
        keyId: "key-browser-01",
        purpose: "browser-runner",
        executedCommand: "pnpm test qa-ui-auto",
        commandDigest: "sha256:cmd-digest",
        startedAt: "2026-08-29T11:00:00.000Z",
        finishedAt: "2026-08-29T11:00:02.000Z",
        exitCode: 1, // Non-zero exit code
        stdoutDigest: "sha256:stdout-fail",
        stderrDigest: "sha256:error-msg",
        artifacts: [],
      },
      browserKey,
    );

    const manifest = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [failedReceipt],
      keyRegistry: registry,
    });

    expect(manifest.overallStatus).toBe("FAIL");
    expect(manifest.channelRollups["linux-daily-editor"].failedCount).toBe(1);
  });
});
