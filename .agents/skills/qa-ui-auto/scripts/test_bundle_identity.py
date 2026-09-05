#!/usr/bin/env python3
"""Unit tests for Source, Test Plan, and Bundle Identity (ED-REL-002).

Acceptance coverage:
- ED-REL-002-A1: Identical inputs are byte-identical.
- ED-REL-002-A2: Source/test/artifact mutation changes identity.
- ED-REL-002-A3: Real runner binds all three identities into execution receipt.
"""

from __future__ import annotations

import json
from pathlib import Path
import unittest
import sys

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.bundle_identity import (
    compute_simple_hex_digest,
    compute_source_identity_digest,
    compute_test_plan_identity_digest,
    build_release_bundle_identity,
    verify_bundle_integrity,
    inspect_repository_identities,
)
from qa_ui_auto.runner_receipt import (
    DEFAULT_RUNNER_KEY_REGISTRY,
    create_runner_execution_receipt,
    verify_runner_receipt,
)


class TestBundleIdentity(unittest.TestCase):
    def setUp(self):
        self.sample_files = [
            {"path": "src/App.tsx", "mode": "100644", "sha256": "sha256:app-hash-111", "bytes": 4096},
            {"path": "src/main.ts", "mode": "100644", "sha256": "sha256:main-hash-222", "bytes": 1024},
            {"path": "scripts/run.sh", "mode": "100755", "sha256": "sha256:run-hash-333", "bytes": 512},
        ]
        self.sample_test_plan = {
            "schemaDigest": "sha256:schema-digest-aaa",
            "scopeDigest": "sha256:scope-digest-bbb",
            "runnerDigest": "sha256:runner-digest-ccc",
            "casesDigest": "sha256:cases-digest-ddd",
            "runbooksDigest": "sha256:runbooks-digest-eee",
            "baselineCommit": "30a121d2d0a8000524cf807b7d4cf2234aa02b05",
        }

    def test_digest_parity_with_ts(self):
        """Ensures compute_simple_hex_digest produces byte-identical hash with TS."""
        d = compute_simple_hex_digest("test-input-string")
        self.assertEqual(d, "b2a06f7e401e88d4e7f53a2beab4227eb2a06f7e401e88d4e7f53a2beab4227e")

    def test_ed_rel_002_a1_identical_inputs_byte_identical(self):
        """ED-REL-002-A1: Identical inputs produce byte-identical release bundle identities."""
        b1 = build_release_bundle_identity(
            bundle_id="taomni-v0.4.20-linux-x64",
            version="0.4.20",
            platform="linux",
            files=self.sample_files,
            test_plan=self.sample_test_plan,
        )

        b2 = build_release_bundle_identity(
            bundle_id="taomni-v0.4.20-linux-x64",
            version="0.4.20",
            platform="linux",
            files=list(reversed(self.sample_files)),
            test_plan=dict(self.sample_test_plan),
        )

        self.assertEqual(b1["sourceIdentityDigest"], b2["sourceIdentityDigest"])
        self.assertEqual(b1["testPlanIdentityDigest"], b2["testPlanIdentityDigest"])
        self.assertEqual(b1["combinedIdentityDigest"], b2["combinedIdentityDigest"])
        self.assertEqual(json.dumps(b1, sort_keys=True), json.dumps(b2, sort_keys=True))

    def test_ed_rel_002_a2_mutation_changes_identity(self):
        """ED-REL-002-A2: Source file or test plan mutation changes identity."""
        original = build_release_bundle_identity(
            bundle_id="taomni-v0.4.20-linux-x64",
            version="0.4.20",
            platform="linux",
            files=self.sample_files,
            test_plan=self.sample_test_plan,
        )

        mutated_files = [
            dict(self.sample_files[0], bytes=self.sample_files[0]["bytes"] + 1),
            self.sample_files[1],
            self.sample_files[2],
        ]
        mutated_b = build_release_bundle_identity(
            bundle_id="taomni-v0.4.20-linux-x64",
            version="0.4.20",
            platform="linux",
            files=mutated_files,
            test_plan=self.sample_test_plan,
        )
        self.assertNotEqual(original["sourceIdentityDigest"], mutated_b["sourceIdentityDigest"])
        self.assertNotEqual(original["combinedIdentityDigest"], mutated_b["combinedIdentityDigest"])

        integrity = verify_bundle_integrity(original, mutated_files, self.sample_test_plan)
        self.assertFalse(integrity["valid"])
        self.assertEqual(integrity["discrepancies"][0]["kind"], "content-modified")

    def test_ed_rel_002_a3_runner_receipt_binds_identities(self):
        """ED-REL-002-A3: Runner execution receipt cryptographically binds all three identities."""
        b = build_release_bundle_identity(
            bundle_id="taomni-desktop-native",
            version="0.4.20",
            platform="linux",
            files=self.sample_files,
            test_plan=self.sample_test_plan,
        )

        native_key = DEFAULT_RUNNER_KEY_REGISTRY["keys"]["key-native-linux-01"]
        receipt = create_runner_execution_receipt(
            {
                "receiptId": "receipt-test-bind-001",
                "runnerId": "qa-ui-auto-native-runner",
                "keyId": native_key["keyId"],
                "purpose": "native-runner",
                "executedCommand": "python -m qa_ui_auto.runner --mode native --filter TC-117",
                "commandDigest": "sha256:cmd-hash-117",
                "startedAt": "2026-09-03T13:30:00.000Z",
                "finishedAt": "2026-09-03T13:30:02.000Z",
                "exitCode": 0,
                "stdoutDigest": "sha256:out-ok",
                "stderrDigest": "sha256:err-none",
                "artifacts": [{"path": "junit.xml", "sha256": "sha256:junit-hash", "bytes": 271}],
                "sourceIdentityDigest": b["sourceIdentityDigest"],
                "testPlanIdentityDigest": b["testPlanIdentityDigest"],
                "bundleIdentity": b,
            },
            native_key,
        )

        self.assertEqual(receipt["sourceIdentityDigest"], b["sourceIdentityDigest"])
        self.assertEqual(receipt["testPlanIdentityDigest"], b["testPlanIdentityDigest"])

        verif = verify_runner_receipt(receipt, DEFAULT_RUNNER_KEY_REGISTRY, "2026-09-03T13:30:00.000Z")
        self.assertTrue(verif["valid"])

        # Tampering with source identity fails signature verification
        tampered = dict(receipt, sourceIdentityDigest="tampered-hash")
        tampered_verif = verify_runner_receipt(tampered, DEFAULT_RUNNER_KEY_REGISTRY, "2026-09-03T13:30:00.000Z")
        self.assertFalse(tampered_verif["valid"])
        self.assertEqual(tampered_verif["reason"], "signature-mismatch")


if __name__ == "__main__":
    unittest.main()
