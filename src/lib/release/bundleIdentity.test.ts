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
});
