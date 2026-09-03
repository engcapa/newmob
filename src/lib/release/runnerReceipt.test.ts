import { describe, expect, it } from "vitest";
import {
  createRunnerExecutionReceipt,
  verifyRunnerReceipt,
  type RunnerKeyRecord,
  type RunnerKeyRegistry,
} from "./runnerReceipt";

describe("ED-REL-001: runnerReceipt execution receipt & signature boundary", () => {
  const activeNativeKey: RunnerKeyRecord = {
    keyId: "key-native-linux-01",
    issuer: "taomni-linux-native-runner",
    purpose: "native-runner",
    secretOrPublicKey: "secret-key-native-42",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-31T23:59:59Z",
    revoked: false,
  };

  const revokedKey: RunnerKeyRecord = {
    keyId: "key-compromised-02",
    issuer: "taomni-compromised-runner",
    purpose: "native-runner",
    secretOrPublicKey: "secret-key-revoked",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-31T23:59:59Z",
    revoked: true,
    revokedAt: "2026-06-01T12:00:00Z",
    revocationReason: "Key leak security event",
  };

  const registry: RunnerKeyRegistry = {
    keys: {
      "key-native-linux-01": activeNativeKey,
      "key-compromised-02": revokedKey,
    },
  };

  const validReceiptParams = {
    receiptId: "receipt-run-101",
    runnerId: "runner-vm-ubuntu-2404",
    keyId: "key-native-linux-01",
    purpose: "native-runner" as const,
    executedCommand: "cargo test --test integration",
    commandDigest: "sha256:cmd-digest-abc123",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:00:05.500Z",
    exitCode: 0,
    stdoutDigest: "sha256:out-digest-def456",
    stderrDigest: "sha256:empty-err-789",
    artifacts: [
      { path: "target/junit.xml", sha256: "sha256:junit-xml-hash", bytes: 1024 },
      { path: "target/coverage.lcov", sha256: "sha256:coverage-hash", bytes: 2048 },
    ],
  };

  it("verifies legitimate runner-created execution receipt", () => {
    const receipt = createRunnerExecutionReceipt(validReceiptParams, activeNativeKey);
    expect(receipt.durationMs).toBe(5500);
    expect(receipt.signature).toHaveLength(64);

    const verification = verifyRunnerReceipt(receipt, registry, "2026-08-29T12:00:00Z");
    expect(verification.valid).toBe(true);
    expect(verification.key?.keyId).toBe("key-native-linux-01");
  });

  it("fails closed on unknown or unapproved issuer keyId", () => {
    const receipt = createRunnerExecutionReceipt(
      { ...validReceiptParams, keyId: "key-unknown-rogue" },
      { ...activeNativeKey, keyId: "key-unknown-rogue" },
    );

    const verification = verifyRunnerReceipt(receipt, registry, "2026-08-29T12:00:00Z");
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("unknown-issuer");
  });

  it("fails closed on revoked key", () => {
    const receipt = createRunnerExecutionReceipt(
      { ...validReceiptParams, keyId: "key-compromised-02" },
      revokedKey,
    );

    const verification = verifyRunnerReceipt(receipt, registry, "2026-08-29T12:00:00Z");
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("revoked-key");
    expect(verification.message).toContain("Key leak security event");
  });

  it("fails closed on expired key or not-yet-valid key", () => {
    const receipt = createRunnerExecutionReceipt(validReceiptParams, activeNativeKey);

    // Verified after expiration date
    const expiredVerif = verifyRunnerReceipt(receipt, registry, "2027-01-01T00:00:00Z");
    expect(expiredVerif.valid).toBe(false);
    expect(expiredVerif.reason).toBe("expired-key");

    // Verified before validFrom
    const notYetValidVerif = verifyRunnerReceipt(receipt, registry, "2025-12-31T23:59:59Z");
    expect(notYetValidVerif.valid).toBe(false);
    expect(notYetValidVerif.reason).toBe("not-yet-valid-key");
  });

  it("fails closed on purpose mismatch", () => {
    const receipt = createRunnerExecutionReceipt(
      { ...validReceiptParams, purpose: "browser-runner" }, // mismatch against native-runner key
      activeNativeKey,
    );

    const verification = verifyRunnerReceipt(receipt, registry, "2026-08-29T12:00:00Z");
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("purpose-mismatch");
  });

  it("fails closed when caller tampers with exit code or stdout digest", () => {
    const receipt = createRunnerExecutionReceipt(validReceiptParams, activeNativeKey);

    // Tamper exit code: change 0 to 1
    const tamperedExit = { ...receipt, exitCode: 1 };
    const resExit = verifyRunnerReceipt(tamperedExit, registry, "2026-08-29T12:00:00Z");
    expect(resExit.valid).toBe(false);
    expect(resExit.reason).toBe("signature-mismatch");

    // Tamper stdout digest
    const tamperedDigest = { ...receipt, stdoutDigest: "sha256:forged-digest" };
    const resDigest = verifyRunnerReceipt(tamperedDigest, registry, "2026-08-29T12:00:00Z");
    expect(resDigest.valid).toBe(false);
    expect(resDigest.reason).toBe("signature-mismatch");
  });

  it("fails closed when caller tampers with duration or timing", () => {
    const receipt = createRunnerExecutionReceipt(validReceiptParams, activeNativeKey);

    // Tamper durationMs without changing timestamps
    const tamperedDuration = { ...receipt, durationMs: 1000 };
    const resDur = verifyRunnerReceipt(tamperedDuration, registry, "2026-08-29T12:00:00Z");
    expect(resDur.valid).toBe(false);
    expect(resDur.reason).toBe("timing-tampered");
  });

  it("ED-REL-001-A1: supports DEFAULT_RUNNER_KEY_REGISTRY for official runners", () => {
    import("./runnerReceipt").then(({ DEFAULT_RUNNER_KEY_REGISTRY }) => {
      expect(DEFAULT_RUNNER_KEY_REGISTRY.keys["key-native-linux-01"]).toBeDefined();
      expect(DEFAULT_RUNNER_KEY_REGISTRY.keys["key-browser-runner-01"]).toBeDefined();
      expect(DEFAULT_RUNNER_KEY_REGISTRY.keys["key-perf-runner-01"]).toBeDefined();
      expect(DEFAULT_RUNNER_KEY_REGISTRY.keys["key-audit-runner-01"]).toBeDefined();

      const browserKey = DEFAULT_RUNNER_KEY_REGISTRY.keys["key-browser-runner-01"];
      const receipt = createRunnerExecutionReceipt(
        {
          ...validReceiptParams,
          keyId: browserKey.keyId,
          purpose: "browser-runner",
          runnerId: "qa-ui-auto-browser-runner",
        },
        browserKey,
      );

      const verification = verifyRunnerReceipt(receipt, DEFAULT_RUNNER_KEY_REGISTRY, "2026-08-29T12:00:00Z");
      expect(verification.valid).toBe(true);
      expect(verification.key?.keyId).toBe("key-browser-runner-01");
    });
  });

  it("ED-REL-001-A3: prevents application and test code from self-attesting a release run", () => {
    // Application or test code attempting to forge a receipt using an unauthorized secret key
    const forgedReceipt = createRunnerExecutionReceipt(
      { ...validReceiptParams, keyId: "key-native-linux-01" },
      { ...activeNativeKey, secretOrPublicKey: "attacker-forged-secret" },
    );

    // Verifying against official registry fails with signature-mismatch
    const verif = verifyRunnerReceipt(forgedReceipt, registry, "2026-08-29T12:00:00Z");
    expect(verif.valid).toBe(false);
    expect(verif.reason).toBe("signature-mismatch");
  });

  it("ED-REL-001-A2: artifact tampering fails cryptographic verification", () => {
    const receipt = createRunnerExecutionReceipt(validReceiptParams, activeNativeKey);

    // Tamper artifact sha256
    const tamperedArtifacts = {
      ...receipt,
      artifacts: [
        { path: "target/junit.xml", sha256: "sha256:corrupted-hash", bytes: 1024 },
        receipt.artifacts[1],
      ],
    };
    const res = verifyRunnerReceipt(tamperedArtifacts, registry, "2026-08-29T12:00:00Z");
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("signature-mismatch");
  });
});
