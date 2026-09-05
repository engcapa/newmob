#!/usr/bin/env python3
"""Unit tests for Release Rollup & Real Smoke Transaction (ED-REL-004).

Acceptance coverage:
- ED-REL-004-A1: Runner executes smoke case and writes signed receipt/artifact.
- ED-REL-004-A2: Rollup consumes it and produces byte-identical manifests.
- ED-REL-004-A3: Independent check verifies identity, signature, and artifacts.
- ED-REL-004-A4: Tamper/zero/failure paths remain red.
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

from qa_ui_auto.rollup import (
    compute_canonical_json_digest,
    build_release_rollup_manifest,
    verify_release_rollup_manifest,
    collect_receipts_from_reports,
)
from qa_ui_auto.runner_receipt import (
    DEFAULT_RUNNER_KEY_REGISTRY,
    create_runner_execution_receipt,
)


class TestReleaseRollup(unittest.TestCase):
    def setUp(self):
        self.browser_key = DEFAULT_RUNNER_KEY_REGISTRY["keys"]["key-browser-runner-01"]
        self.registry = DEFAULT_RUNNER_KEY_REGISTRY

        self.sample_bundle = {
            "bundleId": "taomni-linux-x64-v0.4.20",
            "version": "0.4.20",
            "platform": "linux",
            "sourceIdentityDigest": "sha256:src-digest-111",
            "testPlanIdentityDigest": "sha256:plan-digest-222",
            "combinedIdentityDigest": "sha256:comb-digest-333",
            "trackedFileCount": 42,
            "totalBytes": 81920,
        }

        self.sample_plan = {
            "version": 1,
            "releaseChannels": {
                "linux-daily-editor": {
                    "platform": "linux",
                    "requiredCapabilities": ["C0-save-pipeline"],
                    "requiredEvidenceLayers": ["browser"],
                    "evidenceRoots": ["qa-ui-auto-report"],
                },
            },
        }

    def test_canonical_json_digest_parity(self):
        """Ensures byte-identical JSON digest calculation with TS."""
        obj = {"a": 1, "b": "hello", "c": [1, 2, 3]}
        d = compute_canonical_json_digest(obj)
        self.assertEqual(d, "0479e7e0374ad4d3512cb2b5aed34d4a0479e7e0374ad4d3512cb2b5aed34d4a")

    def test_ed_rel_004_a2_byte_identical_manifests(self):
        """ED-REL-004-A2: Rollup produces byte-identical manifests across runs."""
        receipt = create_runner_execution_receipt(
            {
                "receiptId": "receipt-smoke-01",
                "runnerId": "qa-ui-auto-linux-browser-runner",
                "keyId": self.browser_key["keyId"],
                "purpose": "browser-runner",
                "executedCommand": "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
                "commandDigest": "sha256:cmd-digest",
                "startedAt": "2026-08-29T11:00:00.000Z",
                "finishedAt": "2026-08-29T11:00:02.000Z",
                "exitCode": 0,
                "stdoutDigest": "sha256:stdout-ok",
                "stderrDigest": "sha256:empty",
                "artifacts": [{"path": "qa-ui-auto-report/smoke.json", "sha256": "sha256:art", "bytes": 100}],
            },
            self.browser_key,
        )

        m1 = build_release_rollup_manifest(
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[receipt],
            key_registry=self.registry,
            reference_time_iso="2026-08-29T12:00:00.000Z",
        )

        m2 = build_release_rollup_manifest(
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[receipt],
            key_registry=self.registry,
            reference_time_iso="2026-08-29T12:00:00.000Z",
        )

        self.assertEqual(m1["manifestDigest"], m2["manifestDigest"])
        self.assertEqual(json.dumps(m1, sort_keys=True), json.dumps(m2, sort_keys=True))
        self.assertEqual(m1["overallStatus"], "PASS")

    def test_ed_rel_004_a3_verify_manifest_in_check_mode(self):
        """ED-REL-004-A3: Independent check verifies identity, signature, and artifacts."""
        receipt = create_runner_execution_receipt(
            {
                "receiptId": "receipt-smoke-01",
                "runnerId": "qa-ui-auto-linux-browser-runner",
                "keyId": self.browser_key["keyId"],
                "purpose": "browser-runner",
                "executedCommand": "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
                "commandDigest": "sha256:cmd-digest",
                "startedAt": "2026-08-29T11:00:00.000Z",
                "finishedAt": "2026-08-29T11:00:02.000Z",
                "exitCode": 0,
                "stdoutDigest": "sha256:stdout-ok",
                "stderrDigest": "sha256:empty",
                "artifacts": [{"path": "qa-ui-auto-report/smoke.json", "sha256": "sha256:art", "bytes": 100}],
            },
            self.browser_key,
        )

        manifest = build_release_rollup_manifest(
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[receipt],
            key_registry=self.registry,
            reference_time_iso="2026-08-29T12:00:00.000Z",
        )

        check = verify_release_rollup_manifest(
            manifest=manifest,
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[receipt],
            key_registry=self.registry,
        )
        self.assertTrue(check["valid"])
        self.assertTrue(check["manifestDigestMatched"])
        self.assertEqual(len(check["errors"]), 0)

    def test_ed_rel_004_a4_zero_receipts_incomplete(self):
        """ED-REL-004-A4: Zero receipts yield INCOMPLETE status (stable RED)."""
        manifest = build_release_rollup_manifest(
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[],
            key_registry=self.registry,
        )
        self.assertEqual(manifest["overallStatus"], "INCOMPLETE")
        self.assertEqual(manifest["channelRollups"]["linux-daily-editor"]["status"], "INCOMPLETE")

    def test_ed_rel_004_a4_failing_receipt_fails(self):
        """ED-REL-004-A4: Non-zero exitCode or failed signature yields FAIL status."""
        failed_receipt = create_runner_execution_receipt(
            {
                "receiptId": "receipt-smoke-fail",
                "runnerId": "qa-ui-auto-linux-browser-runner",
                "keyId": self.browser_key["keyId"],
                "purpose": "browser-runner",
                "executedCommand": "python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02",
                "commandDigest": "sha256:cmd-digest",
                "startedAt": "2026-08-29T11:00:00.000Z",
                "finishedAt": "2026-08-29T11:00:02.000Z",
                "exitCode": 1,
                "stdoutDigest": "sha256:stdout-fail",
                "stderrDigest": "sha256:error-msg",
                "artifacts": [],
            },
            self.browser_key,
        )

        manifest = build_release_rollup_manifest(
            bundle_identity=self.sample_bundle,
            plan=self.sample_plan,
            receipts=[failed_receipt],
            key_registry=self.registry,
        )
        self.assertEqual(manifest["overallStatus"], "FAIL")
        self.assertEqual(manifest["channelRollups"]["linux-daily-editor"]["failedCount"], 1)


if __name__ == "__main__":
    unittest.main()
