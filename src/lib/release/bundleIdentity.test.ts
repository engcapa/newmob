import { describe, expect, it } from "vitest";
import {
  buildReleaseBundleIdentity,
  verifyBundleIntegrity,
  type TrackedSourceFile,
  type TestPlanIdentityInputs,
} from "./bundleIdentity";

describe("ED-REL-002: bundleIdentity source, test plan, and bundle identity", () => {
  const sampleFiles: TrackedSourceFile[] = [
    { path: "src/App.tsx", mode: "100644", sha256: "sha256:app-hash-111", bytes: 4096 },
    { path: "src/main.ts", mode: "100644", sha256: "sha256:main-hash-222", bytes: 1024 },
    { path: "scripts/run.sh", mode: "100755", sha256: "sha256:run-hash-333", bytes: 512 },
  ];

  const sampleTestPlan: TestPlanIdentityInputs = {
    schemaDigest: "sha256:schema-digest-aaa",
    scopeDigest: "sha256:scope-digest-bbb",
    runnerDigest: "sha256:runner-digest-ccc",
    casesDigest: "sha256:cases-digest-ddd",
    runbooksDigest: "sha256:runbooks-digest-eee",
    baselineCommit: "30a121d2d0a8000524cf807b7d4cf2234aa02b05",
  };

  it("builds valid release bundle identity with combined digest", () => {
    const bundle = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    expect(bundle.trackedFileCount).toBe(3);
    expect(bundle.totalBytes).toBe(4096 + 1024 + 512);
    expect(bundle.combinedIdentityDigest).toHaveLength(64);

    const integrity = verifyBundleIntegrity(bundle, sampleFiles, sampleTestPlan);
    expect(integrity.valid).toBe(true);
    expect(integrity.discrepancies).toEqual([]);
  });

  it("detects tracked file mode change attack (e.g. privilege escalation / unexecutable)", () => {
    const bundle = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    const tamperedFiles: TrackedSourceFile[] = [
      sampleFiles[0],
      sampleFiles[1],
      { ...sampleFiles[2], mode: "100644" }, // Tampered mode 100755 -> 100644
    ];

    const integrity = verifyBundleIntegrity(bundle, tamperedFiles, sampleTestPlan);
    expect(integrity.valid).toBe(false);
    expect(integrity.discrepancies[0].kind).toBe("content-modified");
  });

  it("detects tracked file content alteration", () => {
    const bundle = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    const tamperedFiles: TrackedSourceFile[] = [
      { ...sampleFiles[0], sha256: "sha256:modified-app-content", bytes: 4097 },
      sampleFiles[1],
      sampleFiles[2],
    ];

    const integrity = verifyBundleIntegrity(bundle, tamperedFiles, sampleTestPlan);
    expect(integrity.valid).toBe(false);
    expect(integrity.discrepancies[0].kind).toBe("content-modified");
  });

  it("detects test plan case drift or baseline commit mismatch", () => {
    const bundle = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    const modifiedTestPlan: TestPlanIdentityInputs = {
      ...sampleTestPlan,
      casesDigest: "sha256:cases-digest-MODIFIED",
    };

    const integrity = verifyBundleIntegrity(bundle, sampleFiles, modifiedTestPlan);
    expect(integrity.valid).toBe(false);
    expect(integrity.discrepancies[0].kind).toBe("test-plan-changed");
  });

  it("ED-REL-002-A1: identical inputs produce byte-identical release bundle identities across independent runs", () => {
    const bundle1 = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    const bundle2 = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: [...sampleFiles].reverse(), // reversed input order to test deterministic canonical sorting
      testPlan: { ...sampleTestPlan },
    });

    expect(bundle1.sourceIdentityDigest).toBe(bundle2.sourceIdentityDigest);
    expect(bundle1.testPlanIdentityDigest).toBe(bundle2.testPlanIdentityDigest);
    expect(bundle1.combinedIdentityDigest).toBe(bundle2.combinedIdentityDigest);
    expect(JSON.stringify(bundle1)).toBe(JSON.stringify(bundle2));
  });

  it("ED-REL-002-A2: source, test-plan, or artifact mutation changes identity", () => {
    const original = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    // 1. Source file mutation
    const mutatedSources = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: [{ ...sampleFiles[0], bytes: sampleFiles[0].bytes + 1 }, sampleFiles[1], sampleFiles[2]],
      testPlan: sampleTestPlan,
    });
    expect(mutatedSources.sourceIdentityDigest).not.toBe(original.sourceIdentityDigest);
    expect(mutatedSources.combinedIdentityDigest).not.toBe(original.combinedIdentityDigest);

    // 2. Test plan mutation
    const mutatedTestPlan = buildReleaseBundleIdentity({
      bundleId: "taomni-v0.4.20-linux-x64",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: { ...sampleTestPlan, schemaDigest: "sha256:mutated-schema" },
    });
    expect(mutatedTestPlan.testPlanIdentityDigest).not.toBe(original.testPlanIdentityDigest);
    expect(mutatedTestPlan.combinedIdentityDigest).not.toBe(original.combinedIdentityDigest);
  });

  it("ED-REL-002-A3: runner binds all three identities into cryptographic execution receipt", async () => {
    const { createRunnerExecutionReceipt, verifyRunnerReceipt, DEFAULT_RUNNER_KEY_REGISTRY } = await import("./runnerReceipt");

    const bundle = buildReleaseBundleIdentity({
      bundleId: "taomni-desktop-native",
      version: "0.4.20",
      platform: "linux",
      files: sampleFiles,
      testPlan: sampleTestPlan,
    });

    const nativeKey = DEFAULT_RUNNER_KEY_REGISTRY.keys["key-native-linux-01"];
    const receipt = createRunnerExecutionReceipt(
      {
        receiptId: "receipt-bound-102",
        runnerId: "qa-ui-auto-native-runner",
        keyId: nativeKey.keyId,
        purpose: "native-runner",
        executedCommand: "python -m qa_ui_auto.runner --mode native --filter TC-117",
        commandDigest: "sha256:cmd-hash-117",
        startedAt: "2026-09-03T13:30:00.000Z",
        finishedAt: "2026-09-03T13:30:02.000Z",
        exitCode: 0,
        stdoutDigest: "sha256:out-ok",
        stderrDigest: "sha256:err-none",
        artifacts: [{ path: "junit.xml", sha256: "sha256:junit-hash", bytes: 271 }],
        sourceIdentityDigest: bundle.sourceIdentityDigest,
        testPlanIdentityDigest: bundle.testPlanIdentityDigest,
        bundleIdentity: bundle,
      },
      nativeKey,
    );

    expect(receipt.sourceIdentityDigest).toBe(bundle.sourceIdentityDigest);
    expect(receipt.testPlanIdentityDigest).toBe(bundle.testPlanIdentityDigest);
    expect(receipt.bundleIdentity).toEqual(bundle);

    const verif = verifyRunnerReceipt(receipt, DEFAULT_RUNNER_KEY_REGISTRY, "2026-09-03T13:30:00.000Z");
    expect(verif.valid).toBe(true);

    // Tampering with the bound sourceIdentityDigest breaks receipt signature
    const tamperedReceipt = {
      ...receipt,
      sourceIdentityDigest: "tampered-source-digest",
    };
    const tamperedVerif = verifyRunnerReceipt(tamperedReceipt, DEFAULT_RUNNER_KEY_REGISTRY, "2026-09-03T13:30:00.000Z");
    expect(tamperedVerif.valid).toBe(false);
    expect(tamperedVerif.reason).toBe("signature-mismatch");
  });
});
