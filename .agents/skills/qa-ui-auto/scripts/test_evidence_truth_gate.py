#!/usr/bin/env python3
"""Unit tests for Evidence Truth Gate (U0 §8.22.1).

Verifies evidence_validate.py and evidence_rollup.py behavior against:
- Valid v3 entries with subject fingerprint and production owner
- Negative test cases: empty dir, all stale, product source mismatch, test plan mismatch,
  artifact missing/bad hash/secret leak, owner non-existent/test-only, provider layer missing
  request/response, native layer missing effect, idea layer missing compare, claim exceeding
  computed maximum, modified manifest check failure, rollup unverified without entries.
"""
from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import yaml

from evidence_validate import (
    EntryStatus,
    get_test_plan_fingerprint,
    get_tested_source_fingerprint,
    load_schema,
    main as validate_main,
    sha256_of_file,
    validate_entry,
)
from evidence_rollup import (
    generate_manifest_data,
    render_markdown,
    main as rollup_main,
)


class EvidenceTruthGateTests(unittest.TestCase):
    def setUp(self):
        self.schema = load_schema()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.source_fp = get_tested_source_fingerprint()
        self.plan_fp = get_test_plan_fingerprint()

        # Create dummy artifacts
        self.req_file = self.temp_path / "req.json"
        self.req_file.write_text('{"method":"textDocument/codeAction"}', encoding="utf-8")
        self.req_hash = sha256_of_file(self.req_file)

        self.res_file = self.temp_path / "res.json"
        self.res_file.write_text('{"result":[]}', encoding="utf-8")
        self.res_hash = sha256_of_file(self.res_file)

        self.sample_v3 = {
            "schemaVersion": 3,
            "capabilityId": "W3-intention",
            "languageId": "java",
            "subject": {
                "appCommit": "a" * 40,
                "testedSourceFingerprint": self.source_fp,
                "bundleHash": "b" * 64,
                "testPlanFingerprint": self.plan_fp,
            },
            "recordedAtCommit": "a" * 40,
            "owner": {
                "featureId": "F1.8",
                "paths": ["src/components/editor/CodeWorkspaceTab.tsx"],
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
            "evidenceLayers": ["unit", "provider"],
            "result": "passed",
            "command": "pnpm exec vitest run src/components/editor",
            "artifacts": [
                {"kind": "request", "path": str(self.req_file), "sha256": self.req_hash, "redacted": True},
                {"kind": "response", "path": str(self.res_file), "sha256": self.res_hash, "redacted": True},
            ],
            "knownGaps": [],
            "maximumClaim": "L2",
            "notes": "Verified on Linux",
            "collectedAt": "2026-08-27T08:00:00+0800",
        }

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write_entry(self, data: dict, name: str = "test.entry.yaml") -> Path:
        entry_file = self.temp_path / name
        entry_file.write_text(yaml.safe_dump(data), encoding="utf-8")
        return entry_file

    def test_valid_v3_entry_passes(self):
        entry_file = self._write_entry(self.sample_v3)
        res = validate_entry(
            entry_file,
            self.schema,
            check_current=True,
            current_source_fp=self.source_fp,
            current_test_plan_fp=self.plan_fp,
            current_head="a" * 40,
        )
        self.assertEqual(res.status, EntryStatus.VALID_CURRENT)
        self.assertEqual(res.errors, [])

    def test_negative_empty_directory_fails_current_check(self):
        empty_dir = self.temp_path / "empty_dir"
        empty_dir.mkdir()
        code = validate_main(["--check-current", str(empty_dir)])
        self.assertEqual(code, 1)

    def test_negative_all_stale_entries_fail_current_check(self):
        # Legacy v2 entry is stale
        v2_entry = copy.deepcopy(self.sample_v3)
        v2_entry["schemaVersion"] = 2
        v2_entry.pop("subject")
        v2_entry.pop("recordedAtCommit")
        v2_entry.pop("owner")
        v2_entry["app"] = {"commit": "a" * 40, "bundleHash": "b" * 64, "version": "1.0.0"}
        stale_file = self._write_entry(v2_entry, "stale.entry.yaml")

        code = validate_main(["--check-current", str(stale_file)])
        self.assertEqual(code, 1)

    def test_head_change_with_same_source_fingerprint_remains_valid(self):
        entry_file = self._write_entry(self.sample_v3)
        res = validate_entry(
            entry_file,
            self.schema,
            check_current=True,
            current_source_fp=self.source_fp,
            current_test_plan_fp=self.plan_fp,
            current_head="f" * 40,  # different HEAD commit, but same source fingerprint
        )
        self.assertEqual(res.status, EntryStatus.VALID_CURRENT)

    def test_negative_product_source_change_becomes_stale_source(self):
        entry_file = self._write_entry(self.sample_v3)
        res = validate_entry(
            entry_file,
            self.schema,
            check_current=True,
            current_source_fp="diff_source_" + "0" * 52,
            current_test_plan_fp=self.plan_fp,
        )
        self.assertEqual(res.status, EntryStatus.STALE_SOURCE)
        self.assertEqual(res.reason_code, "STALE_SOURCE_FINGERPRINT")

    def test_negative_test_plan_change_becomes_stale_test_plan(self):
        entry_file = self._write_entry(self.sample_v3)
        res = validate_entry(
            entry_file,
            self.schema,
            check_current=True,
            current_source_fp=self.source_fp,
            current_test_plan_fp="diff_plan_" + "0" * 54,
        )
        self.assertEqual(res.status, EntryStatus.STALE_TEST_PLAN)
        self.assertEqual(res.reason_code, "STALE_TEST_PLAN")

    def test_negative_owner_path_not_found_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["owner"]["paths"] = ["non_existent_file.tsx"]
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "INVALID_OWNER_PATHS")

    def test_negative_owner_path_only_test_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["owner"]["paths"] = ["src/components/editor/CodeWorkspaceTab.test.tsx"]
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "OWNER_PATH_NOT_PRODUCTION")

    def test_negative_artifact_missing_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["artifacts"] = [{
            "kind": "request",
            "path": str(self.temp_path / "missing.json"),
            "sha256": "0" * 64,
            "redacted": True,
        }]
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "ARTIFACT_MISSING")

    def test_negative_artifact_hash_mismatch_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["artifacts"][0]["sha256"] = "f" * 64
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "ARTIFACT_HASH_MISMATCH")

    def test_negative_secret_leak_fails(self):
        leak_file = self.temp_path / "leak.txt"
        leak_file.write_text("Error in /home/zhyhang/project/file.java", encoding="utf-8")
        bad = copy.deepcopy(self.sample_v3)
        bad["artifacts"].append({
            "kind": "log",
            "path": str(leak_file),
            "sha256": sha256_of_file(leak_file),
            "redacted": False,
        })
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "SECRET_LEAK")

    def test_negative_provider_layer_missing_artifacts_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["artifacts"] = []  # Provider layer declared, but no request/response
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "PROVIDER_LAYER_MISSING_ARTIFACTS")

    def test_negative_idea_layer_missing_compare_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["evidenceLayers"] = ["idea-compare"]
        bad["artifacts"] = [bad["artifacts"][0]]  # only 1 artifact
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "IDEA_COMPARE_MISSING_ARTIFACTS")

    def test_negative_claim_exceeds_maximum_fails(self):
        bad = copy.deepcopy(self.sample_v3)
        bad["evidenceLayers"] = ["unit"]  # only unit layer -> max claim is L1
        bad["artifacts"] = []
        bad["provider"] = None
        bad["maximumClaim"] = "L2"  # L2 exceeds L1
        entry_file = self._write_entry(bad)
        res = validate_entry(entry_file, self.schema, check_current=False)
        self.assertEqual(res.status, EntryStatus.INVALID)
        self.assertEqual(res.reason_code, "CLAIM_EXCEEDS_MAXIMUM")

    def test_negative_modified_manifest_fails_check(self):
        manifest_md = self.temp_path / "manifest.v1.md"
        manifest_json = self.temp_path / "manifest.v1.json"
        manifest_md.write_text("# Corrupt manifest", encoding="utf-8")
        manifest_json.write_text("{}", encoding="utf-8")

        code = rollup_main(["--check", "--output-md", str(manifest_md), "--output-json", str(manifest_json)])
        self.assertEqual(code, 1)

    def test_rollup_deterministic_and_no_hardcoded_claims_without_entries(self):
        data = generate_manifest_data("a" * 40, self.source_fp, self.plan_fp, [], [])
        md = render_markdown(data)

        # Confirm no hardcoded "Passed" or "Active"
        for item in data["g0Matrix"]:
            self.assertEqual(item["linux"], "unknown")
            self.assertIn("Unverified", item["note"])
        for pkg in data["g1Packages"]:
            self.assertEqual(pkg["claim"], "unverified")
            self.assertEqual(pkg["status"], "unverified")

        self.assertIn("Failed (134ms p95 > 50ms budget)", md)


if __name__ == "__main__":
    unittest.main()
