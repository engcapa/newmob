#!/usr/bin/env python3
"""Unit tests for Runner-Owned Receipt & Cryptographic Signature Boundary (ED-REL-001).

Acceptance coverage:
- ED-REL-001-A1: Real runner emits receipt after execution with valid signature and structure.
- ED-REL-001-A2: Mutation/tampering of exit code, stdout, timing, or artifacts fails;
                 wrong purpose, expired, or revoked key fails closed.
- ED-REL-001-A3: Application and test code cannot self-attest a release run without
                 registered runner private key.
"""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import sys

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.runner_receipt import (
    DEFAULT_RUNNER_KEY_REGISTRY,
    compute_receipt_canonical_payload,
    compute_receipt_signature,
    create_runner_execution_receipt,
    verify_runner_receipt,
    emit_runner_receipt,
    collect_report_artifacts,
)


class TestRunnerReceipt(unittest.TestCase):
    def setUp(self):
        self.active_native_key = {
            "keyId": "key-native-linux-01",
            "issuer": "taomni-linux-native-runner",
            "purpose": "native-runner",
            "secretOrPublicKey": "secret-key-native-42",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        }
        self.active_browser_key = {
            "keyId": "key-browser-runner-01",
            "issuer": "taomni-browser-runner",
            "purpose": "browser-runner",
            "secretOrPublicKey": "secret-key-browser-taomni",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        }
        self.revoked_key = {
            "keyId": "key-compromised-02",
            "issuer": "taomni-compromised-runner",
            "purpose": "native-runner",
            "secretOrPublicKey": "secret-key-revoked",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": True,
            "revokedAt": "2026-06-01T12:00:00Z",
            "revocationReason": "Key leak security event",
        }
        self.registry = {
            "keys": {
                "key-native-linux-01": self.active_native_key,
                "key-browser-runner-01": self.active_browser_key,
                "key-compromised-02": self.revoked_key,
            }
        }
        self.valid_receipt_params = {
            "receiptId": "receipt-run-101",
            "runnerId": "runner-vm-ubuntu-2404",
            "keyId": "key-native-linux-01",
            "purpose": "native-runner",
            "executedCommand": "cargo test --test integration",
            "commandDigest": "sha256:cmd-digest-abc123",
            "startedAt": "2026-08-29T10:00:00.000Z",
            "finishedAt": "2026-08-29T10:00:05.500Z",
            "exitCode": 0,
            "stdoutDigest": "sha256:out-digest-def456",
            "stderrDigest": "sha256:empty-err-789",
            "artifacts": [
                {"path": "target/junit.xml", "sha256": "sha256:junit-xml-hash", "bytes": 1024},
                {"path": "target/coverage.lcov", "sha256": "sha256:coverage-hash", "bytes": 2048},
            ],
        }

    def test_canonical_payload_matches_ts(self):
        """Ensures byte-for-byte canonical payload format matching TypeScript."""
        payload = compute_receipt_canonical_payload(self.valid_receipt_params)
        expected = (
            "id:receipt-run-101|runner:runner-vm-ubuntu-2404|key:key-native-linux-01|"
            "purpose:native-runner|cmd:sha256:cmd-digest-abc123|start:2026-08-29T10:00:00.000Z|"
            "end:2026-08-29T10:00:05.500Z|dur:5500|exit:0|out:sha256:out-digest-def456|"
            "err:sha256:empty-err-789|artifacts:[target/coverage.lcov:sha256:coverage-hash:2048,target/junit.xml:sha256:junit-xml-hash:1024]"
        )
        self.assertEqual(payload, expected)

    def test_signature_deterministic_64_hex(self):
        """Ensures 64-char hex signature computation matches TS implementation."""
        payload = "test-payload"
        secret = "test-secret"
        sig = compute_receipt_signature(payload, secret)
        self.assertEqual(len(sig), 64)
        self.assertEqual(sig, "608f1edb3ad54481c52abb7e5cb322e7608f1edb3ad54481c52abb7e5cb322e7")

    def test_ed_rel_001_a1_valid_execution_receipt(self):
        """ED-REL-001-A1: Real runner emits valid signed execution receipt."""
        receipt = create_runner_execution_receipt(self.valid_receipt_params, self.active_native_key)
        self.assertEqual(receipt["durationMs"], 5500)
        self.assertEqual(len(receipt["signature"]), 64)

        verif = verify_runner_receipt(receipt, self.registry, "2026-08-29T12:00:00Z")
        self.assertTrue(verif["valid"])
        self.assertEqual(verif["key"]["keyId"], "key-native-linux-01")

    def test_ed_rel_001_a2_fails_closed_on_unknown_key(self):
        """ED-REL-001-A2: Unknown key fails closed."""
        receipt = create_runner_execution_receipt(
            {**self.valid_receipt_params, "keyId": "key-unknown-rogue"},
            {**self.active_native_key, "keyId": "key-unknown-rogue"},
        )
        verif = verify_runner_receipt(receipt, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(verif["valid"])
        self.assertEqual(verif["reason"], "unknown-issuer")

    def test_ed_rel_001_a2_fails_closed_on_revoked_key(self):
        """ED-REL-001-A2: Revoked key fails closed."""
        receipt = create_runner_execution_receipt(
            {**self.valid_receipt_params, "keyId": "key-compromised-02"},
            self.revoked_key,
        )
        verif = verify_runner_receipt(receipt, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(verif["valid"])
        self.assertEqual(verif["reason"], "revoked-key")
        self.assertIn("Key leak", verif["message"])

    def test_ed_rel_001_a2_fails_closed_on_expired_or_not_yet_valid(self):
        """ED-REL-001-A2: Expired or not-yet-valid key fails closed."""
        receipt = create_runner_execution_receipt(self.valid_receipt_params, self.active_native_key)

        # Expired
        verif_exp = verify_runner_receipt(receipt, self.registry, "2029-01-01T00:00:00Z")
        self.assertFalse(verif_exp["valid"])
        self.assertEqual(verif_exp["reason"], "expired-key")

        # Not yet valid
        verif_nyv = verify_runner_receipt(receipt, self.registry, "2025-12-31T23:59:59Z")
        self.assertFalse(verif_nyv["valid"])
        self.assertEqual(verif_nyv["reason"], "not-yet-valid-key")

    def test_ed_rel_001_a2_fails_closed_on_purpose_mismatch(self):
        """ED-REL-001-A2: Key purpose mismatch fails closed."""
        receipt = create_runner_execution_receipt(
            {**self.valid_receipt_params, "purpose": "browser-runner"},
            self.active_native_key,
        )
        verif = verify_runner_receipt(receipt, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(verif["valid"])
        self.assertEqual(verif["reason"], "purpose-mismatch")

    def test_ed_rel_001_a2_tampered_payload_fails_signature(self):
        """ED-REL-001-A2: Any payload tampering breaks signature verification."""
        receipt = create_runner_execution_receipt(self.valid_receipt_params, self.active_native_key)

        # Tampered exit code
        tampered_exit = dict(receipt, exitCode=1)
        res = verify_runner_receipt(tampered_exit, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(res["valid"])
        self.assertEqual(res["reason"], "signature-mismatch")

        # Tampered stdout digest
        tampered_stdout = dict(receipt, stdoutDigest="sha256:forged")
        res = verify_runner_receipt(tampered_stdout, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(res["valid"])
        self.assertEqual(res["reason"], "signature-mismatch")

        # Tampered durationMs
        tampered_dur = dict(receipt, durationMs=1000)
        res = verify_runner_receipt(tampered_dur, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(res["valid"])
        self.assertEqual(res["reason"], "timing-tampered")

    def test_ed_rel_001_a3_self_attestation_fails(self):
        """ED-REL-001-A3: Application/test code cannot self-attest a release run."""
        # Non-runner caller forging a receipt using unauthorized secret key
        forged = create_runner_execution_receipt(
            self.valid_receipt_params,
            {**self.active_native_key, "secretOrPublicKey": "rogue-secret"},
        )
        verif = verify_runner_receipt(forged, self.registry, "2026-08-29T12:00:00Z")
        self.assertFalse(verif["valid"])
        self.assertEqual(verif["reason"], "signature-mismatch")

    def test_emit_runner_receipt_end_to_end(self):
        """ED-REL-001-A1: emit_runner_receipt produces valid runner_receipt.json in report directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            report_dir = Path(tmpdir) / "run-20260903-test"
            report_dir.mkdir(parents=True)
            (report_dir / "summary.json").write_text('{"status": "passed"}')
            (report_dir / "summary.md").write_text("# Report")
            (report_dir / "junit.xml").write_text("<testsuite></testsuite>")

            receipt_file = emit_runner_receipt(
                report_root=report_dir,
                mode="browser",
                executed_cmd=["python", "-m", "qa_ui_auto.runner", "--mode", "browser"],
                started_at="2026-08-29T10:00:00.000Z",
                finished_at="2026-08-29T10:00:05.000Z",
                duration_sec=5.0,
                exit_code=0,
                stdout_text="all passed",
                stderr_text="",
            )

            self.assertTrue(receipt_file.is_file())
            content = json.loads(receipt_file.read_text())
            self.assertEqual(content["purpose"], "browser-runner")
            self.assertEqual(content["keyId"], "key-browser-runner-01")
            self.assertEqual(content["exitCode"], 0)
            self.assertEqual(len(content["artifacts"]), 3)

            verif = verify_runner_receipt(content, now_iso="2026-08-29T12:00:00Z")
            self.assertTrue(verif["valid"])
            self.assertEqual(verif["key"]["keyId"], "key-browser-runner-01")


if __name__ == "__main__":
    unittest.main()
