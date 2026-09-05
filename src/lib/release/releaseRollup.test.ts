import { describe, expect, it } from "vitest";
import {
  buildReleaseRollupManifest,
  verifyReleaseRollupManifest,
} from "./releaseRollup";
import { createRunnerExecutionReceipt, DEFAULT_RUNNER_KEY_REGISTRY } from "./runnerReceipt";
import type { ReleaseBundleIdentity } from "./bundleIdentity";
import type { ReleasePlan } from "./releasePlanValidator";

describe("ED-REL-004: releaseRollup byte-identical manifest & smoke verification", () => {
  const browserKey = DEFAULT_RUNNER_KEY_REGISTRY.keys["key-browser-runner-01"];
  const registry = DEFAULT_RUNNER_KEY_REGISTRY;

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

  it("ED-REL-004-A2: produces byte-identical rollup manifests across multiple invocations", () => {
    const receipt1 = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-01",
        runnerId: "qa-ui-auto-linux-browser-runner",
        keyId: browserKey.keyId,
        purpose: "browser-runner",
        executedCommand: "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
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

  it("ED-REL-004-A3: verifies manifest integrity in --check mode", () => {
    const receipt1 = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-01",
        runnerId: "qa-ui-auto-linux-browser-runner",
        keyId: browserKey.keyId,
        purpose: "browser-runner",
        executedCommand: "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
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

  it("ED-REL-004-A4: zero-entry receipt collection yields INCOMPLETE status (stable RED)", () => {
    const manifest = buildReleaseRollupManifest({
      bundleIdentity: sampleBundle,
      plan: samplePlan,
      receipts: [],
      keyRegistry: registry,
    });

    expect(manifest.overallStatus).toBe("INCOMPLETE");
    expect(manifest.channelRollups["linux-daily-editor"].status).toBe("INCOMPLETE");
  });

  it("ED-REL-004-A4: failing receipt (exitCode !== 0) yields FAIL status", () => {
    const failedReceipt = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-smoke-fail",
        runnerId: "qa-ui-auto-linux-browser-runner",
        keyId: browserKey.keyId,
        purpose: "browser-runner",
        executedCommand: "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
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
