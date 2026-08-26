#!/usr/bin/env python3
"""Unit tests for Evidence Truth Gate (V0 §8.21.1).

Verifies evidence_validate.py and evidence_rollup.py behavior against
valid entries, negative test cases (bad hash, fake layers, schema mismatch),
and deterministic rollup.
"""
from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import yaml

from evidence_validate import load_schema, validate_entry
from evidence_rollup import generate_manifest_content


SAMPLE_VALID_V2 = {
    "schemaVersion": 2,
    "capabilityId": "TC-IDE-C0-01",
    "languageId": "java",
    "app": {
        "commit": "a" * 40,
        "bundleHash": "b" * 64,
        "version": "1.0.0",
    },
    "environment": {
        "platform": "linux",
        "os": "Linux 6.14 Ubuntu",
        "arch": "x86_64",
        "webview": "WebKitGTK 2.52",
        "keyboard": "us",
        "ime": "none",
        "scale": 1.0,
        "filesystem": "ext4",
    },
    "provider": {
        "id": "jdtls",
        "version": "1.61.0",
        "fixture": "java-simple",
    },
    "evidenceLayers": ["unit", "native", "provider"],
    "result": "passed",
    "command": "python -m qa_ui_auto.runner --mode native --filter TC-IDE-C0-01",
    "artifacts": [],
    "knownGaps": [],
    "maximumClaim": "L2",
    "notes": "Verified on Linux",
    "collectedAt": "2026-08-27T08:00:00+0800",
}


class EvidenceTruthGateTests(unittest.TestCase):
    def setUp(self):
        self.schema = load_schema()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write_entry(self, data: dict) -> Path:
        entry_file = self.temp_path / "test.entry.yaml"
        entry_file.write_text(yaml.safe_dump(data), encoding="utf-8")
        return entry_file

    def test_valid_v2_entry_passes(self):
        entry_file = self._write_entry(SAMPLE_VALID_V2)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertEqual(errors, [])

    def test_negative_invalid_commit_fails(self):
        bad_data = copy.deepcopy(SAMPLE_VALID_V2)
        bad_data["app"]["commit"] = "not-a-sha"
        entry_file = self._write_entry(bad_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertTrue(any("Invalid git commit hash" in str(e) for e in errors))

    def test_negative_fake_provider_layer_fails(self):
        bad_data = copy.deepcopy(SAMPLE_VALID_V2)
        bad_data["provider"] = None  # Claimed provider layer but no provider
        entry_file = self._write_entry(bad_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertTrue(any("provider" in str(e) and "missing" in str(e) for e in errors))

    def test_negative_fake_idea_compare_layer_fails(self):
        bad_data = copy.deepcopy(SAMPLE_VALID_V2)
        bad_data["evidenceLayers"].append("idea-compare")
        bad_data["artifacts"] = []  # No idea-compare artifacts
        entry_file = self._write_entry(bad_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertTrue(any("idea-compare" in str(e) for e in errors))

    def test_negative_bad_artifact_hash_fails(self):
        art_file = self.temp_path / "dummy_art.json"
        art_file.write_text("{}", encoding="utf-8")

        bad_data = copy.deepcopy(SAMPLE_VALID_V2)
        bad_data["artifacts"] = [{
            "kind": "summary",
            "path": str(art_file),
            "sha256": "0" * 64,  # Intentionally wrong sha256
            "redacted": True,
        }]
        entry_file = self._write_entry(bad_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertTrue(any("mismatch" in str(e) for e in errors))

    def test_negative_l3_claim_without_idea_compare_fails(self):
        bad_data = copy.deepcopy(SAMPLE_VALID_V2)
        bad_data["maximumClaim"] = "L3"
        # evidenceLayers lacks idea-compare
        entry_file = self._write_entry(bad_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertTrue(any("Claim L3 requires 'idea-compare'" in str(e) for e in errors))

    def test_legacy_v1_entry_reports_stale_migration(self):
        v1_data = {
            "id": "TC-IDE-C0-01",
            "gate": "G0",
            "platform": "linux",
            "commit": "a" * 40,
        }
        entry_file = self._write_entry(v1_data)
        errors = validate_entry(entry_file, self.schema, check_head=False)
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].is_stale)
        self.assertIn("Legacy entry format", errors[0].message)

    def test_check_head_flags_stale_commit(self):
        entry_file = self._write_entry(SAMPLE_VALID_V2)
        errors = validate_entry(entry_file, self.schema, check_head=True, current_head="f" * 40)
        self.assertTrue(any(e.is_stale and "does not match HEAD" in e.message for e in errors))

    def test_rollup_generation_is_deterministic(self):
        content1 = generate_manifest_content("a" * 40, [SAMPLE_VALID_V2], [], {"src/components/editor/workspace/useWorkspaceTreeData.ts"})
        content2 = generate_manifest_content("a" * 40, [SAMPLE_VALID_V2], [], {"src/components/editor/workspace/useWorkspaceTreeData.ts"})
        self.assertEqual(content1, content2)
        self.assertIn("useWorkspaceTreeData.ts", content1)


if __name__ == "__main__":
    unittest.main()
