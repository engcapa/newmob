#!/usr/bin/env python3
"""Unit tests for Editor Baseline Summary Receipt (ED-GATE-002 / BB0-C).

Verifies editor_baseline_summary.py behavior against:
- Subject extraction: commit, tree hash, source fingerprint, clean/dirty/untracked detection
- Output parsers: vitest, cargo test, pnpm build, qa_ui_auto audit
- Deterministic byte-identical output on identical inputs
- Non-release claim isolation (never writes to release evidence directory)
- Quarantine semantics (retains raw non-zero exit while attaching quarantine notes)
- Markdown report rendering
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys

# Ensure qa-ui-auto/scripts is on path
ROOT = Path(__file__).resolve().parents[4]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from editor_baseline_summary import (
    BaselineSubject,
    CommandRecord,
    EditorBaselineSummary,
    build_baseline_summary,
    get_baseline_subject,
    parse_cargo_test_output,
    parse_pnpm_build_output,
    parse_qa_audit_output,
    parse_vitest_output,
    render_markdown_summary,
    validate_output_path,
)


class EditorBaselineSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_get_baseline_subject_clean(self):
        with mock.patch("editor_baseline_summary.get_current_head", return_value="a" * 40), \
             mock.patch("editor_baseline_summary.get_git_tree_hash", return_value="b" * 40), \
             mock.patch("editor_baseline_summary.get_tested_source_fingerprint", return_value="c" * 64), \
             mock.patch("editor_baseline_summary.get_dirty_product_files", return_value=[]), \
             mock.patch("editor_baseline_summary.get_untracked_product_files", return_value=[]):
            subject = get_baseline_subject()
            self.assertEqual(subject.git_commit, "a" * 40)
            self.assertEqual(subject.git_tree_hash, "b" * 40)
            self.assertEqual(subject.source_tree_hash, "c" * 64)
            self.assertFalse(subject.source_dirty)
            self.assertEqual(subject.dirty_files, [])
            self.assertEqual(subject.untracked_files, [])
            self.assertTrue(subject.is_clean)

    def test_get_baseline_subject_dirty_and_untracked_explicitly_flagged(self):
        dirty = ["src/components/editor/CodeWorkspaceTab.tsx"]
        untracked = ["src/components/editor/new_file.ts"]
        with mock.patch("editor_baseline_summary.get_current_head", return_value="a" * 40), \
             mock.patch("editor_baseline_summary.get_git_tree_hash", return_value="b" * 40), \
             mock.patch("editor_baseline_summary.get_tested_source_fingerprint", return_value="c" * 64), \
             mock.patch("editor_baseline_summary.get_dirty_product_files", return_value=dirty), \
             mock.patch("editor_baseline_summary.get_untracked_product_files", return_value=untracked):
            subject = get_baseline_subject()
            self.assertTrue(subject.source_dirty)
            self.assertEqual(subject.dirty_files, dirty)
            self.assertEqual(subject.untracked_files, untracked)
            self.assertFalse(subject.is_clean)

    def test_parse_vitest_output_green(self):
        sample_stdout = """
 ✓ src/components/editor/workspace/useDeferredGitLineChanges.test.tsx (3 tests) 31ms
 ✓ src/components/settings/SettingsPanel.test.tsx (16 tests) 120ms

 Test Files  349 passed (349)
      Tests  3166 passed (3166)
   Start at  15:28:00
   Duration  332.10s (transform 4.12s, setup 2.05s, collect 45.10s, tests 280.93s, environment 0ms, prepare 1.20s)
"""
        cmd = parse_vitest_output(sample_stdout, exit_code=0)
        self.assertEqual(cmd.exit_code, 0)
        self.assertTrue(cmd.passed)
        self.assertEqual(cmd.test_files_total, 349)
        self.assertEqual(cmd.test_files_failed, 0)
        self.assertEqual(cmd.tests_total, 3166)
        self.assertEqual(cmd.tests_passed, 3166)
        self.assertEqual(cmd.tests_failed, 0)
        self.assertEqual(cmd.failed_tests, [])

    def test_parse_vitest_output_red(self):
        sample_stdout = """
 ❯ src/components/editor/Broken.test.tsx (2 tests | 1 failed) 45ms
   × Broken Suite > should not crash
     AssertionError: expected true to be false

 Test Files  1 failed | 348 passed (349)
      Tests  1 failed | 3165 passed (3166)
   Duration  10.50s
"""
        cmd = parse_vitest_output(sample_stdout, exit_code=1)
        self.assertEqual(cmd.exit_code, 1)
        self.assertFalse(cmd.passed)
        self.assertEqual(cmd.test_files_total, 349)
        self.assertEqual(cmd.test_files_failed, 1)
        self.assertEqual(cmd.tests_total, 3166)
        self.assertEqual(cmd.tests_passed, 3165)
        self.assertEqual(cmd.tests_failed, 1)
        self.assertEqual(len(cmd.failed_tests), 1)
        self.assertIn("Broken Suite > should not crash", cmd.failed_tests[0]["name"])

    def test_parse_cargo_test_output_green(self):
        sample_stdout = """
running 1302 tests
test auth::tests::test_token ... ok
test editor::tests::test_split ... ok

test result: ok. 1302 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.15s
"""
        cmd = parse_cargo_test_output(sample_stdout, exit_code=0)
        self.assertEqual(cmd.exit_code, 0)
        self.assertTrue(cmd.passed)
        self.assertEqual(cmd.tests_total, 1302)
        self.assertEqual(cmd.tests_passed, 1302)
        self.assertEqual(cmd.tests_failed, 0)
        self.assertEqual(cmd.failed_tests, [])

    def test_parse_cargo_test_output_red(self):
        sample_stdout = """
running 1302 tests
test editor::tests::test_failed ... FAILED

failures:

---- editor::tests::test_failed stdout ----
thread 'editor::tests::test_failed' panicked at 'assertion failed: false'

failures:
    editor::tests::test_failed

test result: FAILED. 1301 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.80s
"""
        cmd = parse_cargo_test_output(sample_stdout, exit_code=101)
        self.assertEqual(cmd.exit_code, 101)
        self.assertFalse(cmd.passed)
        self.assertEqual(cmd.tests_total, 1302)
        self.assertEqual(cmd.tests_passed, 1301)
        self.assertEqual(cmd.tests_failed, 1)
        self.assertEqual(cmd.failed_tests, [{"name": "editor::tests::test_failed", "file": "src-tauri/src"}])

    def test_parse_pnpm_build_output(self):
        green_stdout = "vite v6.2.0 building for production...\n✓ 4629 modules transformed.\ndist/index.html   0.45 kB\n"
        cmd = parse_pnpm_build_output(green_stdout, exit_code=0)
        self.assertEqual(cmd.exit_code, 0)
        self.assertTrue(cmd.passed)

        red_stdout = "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'.\n"
        cmd_err = parse_pnpm_build_output(red_stdout, exit_code=2)
        self.assertEqual(cmd_err.exit_code, 2)
        self.assertFalse(cmd_err.passed)
        self.assertTrue(len(cmd_err.failed_tests) > 0)

    def test_parse_qa_audit_output(self):
        green_stdout = """
# qa-ui-auto audit

## Health
  cases:    142 files, 142 unique ids, 0 error(s)
  features: 80 entries — 66 filled / 14 backend-only / 0 undeclared (1071 controls: 787 interactive, 284 display, 700 optional)
  orphans:  0 selector(s) used by cases not in any feature.controls
  catalog:  up to date

## Gaps
  ── Missing required controls (18) — control not touched by any case
"""
        cmd = parse_qa_audit_output(green_stdout, exit_code=0)
        self.assertEqual(cmd.exit_code, 0)
        self.assertTrue(cmd.passed)
        self.assertEqual(cmd.test_files_total, 142)
        self.assertEqual(cmd.tests_total, 142)
        self.assertEqual(cmd.tests_passed, 142)
        self.assertEqual(cmd.failed_tests, [])

        red_stdout = """
# qa-ui-auto audit
## Health
  cases:    142 files, 142 unique ids, 2 error(s)
  ERROR: TC-001 syntax error
"""
        cmd_err = parse_qa_audit_output(red_stdout, exit_code=1)
        self.assertEqual(cmd_err.exit_code, 1)
        self.assertFalse(cmd_err.passed)
        self.assertEqual(len(cmd_err.failed_tests), 1)

    def test_byte_identical_reproducibility(self):
        subject = BaselineSubject(
            git_commit="7c5b6bf55cec53200e62d70807f1d943b1dc85b2",
            git_tree_hash="3491f24d7756fbc8d3f6a74c5d80d2ef65e903f5",
            source_tree_hash="180a427702f35d5e90bf88dcbeaa7440401bca0c8f182e0ad3d1c19bcf8681e5",
            source_dirty=False,
            dirty_files=[],
            untracked_files=[],
            is_clean=True,
        )

        cmd1 = CommandRecord(
            name="pnpm test",
            command="pnpm test",
            category="frontend_unit_test",
            exit_code=0,
            passed=True,
            test_files_total=349,
            test_files_failed=0,
            tests_total=3166,
            tests_passed=3166,
            tests_failed=0,
            tests_skipped=0,
            failed_tests=[],
        )
        cmd2 = CommandRecord(
            name="cargo test --lib",
            command="cargo test --lib",
            category="backend_unit_test",
            exit_code=0,
            passed=True,
            test_files_total=1,
            test_files_failed=0,
            tests_total=1302,
            tests_passed=1302,
            tests_failed=0,
            tests_skipped=0,
            failed_tests=[],
        )

        summary1 = build_baseline_summary(subject, [cmd1, cmd2], deterministic=True)
        summary2 = build_baseline_summary(subject, [cmd1, cmd2], deterministic=True)

        json1 = summary1.to_json()
        json2 = summary2.to_json()

        self.assertEqual(json1, json2)
        self.assertEqual(json1.encode("utf-8"), json2.encode("utf-8"))

    def test_non_release_claim_isolation(self):
        subject = BaselineSubject(
            git_commit="a" * 40,
            git_tree_hash="b" * 40,
            source_tree_hash="c" * 64,
            source_dirty=False,
            dirty_files=[],
            untracked_files=[],
            is_clean=True,
        )
        summary = build_baseline_summary(subject, [], deterministic=True)
        data = summary.to_dict()

        # Must explicitly mark non-release claim
        self.assertEqual(data["claimStatus"], "non_release_claim")
        self.assertFalse(data["isReleaseClaim"])
        self.assertEqual(data["schemaVersion"], "editor-baseline-summary/v1")

        # Must disallow output to release evidence directories
        bad_path = ROOT / "qa-ui-auto-tests" / "native" / "evidence" / "entry.yaml"
        with self.assertRaises(ValueError):
            validate_output_path(bad_path)

        manifest_path = ROOT / "qa-ui-auto-tests" / "native" / "manifest.v1.json"
        with self.assertRaises(ValueError):
            validate_output_path(manifest_path)

    def test_quarantine_semantics(self):
        subject = BaselineSubject(
            git_commit="a" * 40,
            git_tree_hash="b" * 40,
            source_tree_hash="c" * 64,
            source_dirty=False,
            dirty_files=[],
            untracked_files=[],
            is_clean=True,
        )
        failed_cmd = CommandRecord(
            name="pnpm test",
            command="pnpm test",
            category="frontend_unit_test",
            exit_code=1,
            passed=False,
            test_files_total=349,
            test_files_failed=1,
            tests_total=3166,
            tests_passed=3165,
            tests_failed=1,
            tests_skipped=0,
            failed_tests=[{"name": "NonEditorPanel > flaky", "file": "src/components/other/Flaky.test.tsx"}],
            quarantined=[
                {
                    "test_name": "NonEditorPanel > flaky",
                    "adr": "ADR-042",
                    "reason": "Terminal panel timing issue tracked in issue #123",
                    "expires": "2026-09-15",
                }
            ],
        )

        summary = build_baseline_summary(subject, [failed_cmd], deterministic=True)
        data = summary.to_dict()

        # Exit code and failure counts remain faithful to actual run (non-zero / failed)
        self.assertFalse(data["overall"]["allPassed"])
        self.assertEqual(data["overall"]["failedCommands"], 1)
        self.assertEqual(data["overall"]["failedTests"], 1)
        self.assertEqual(data["overall"]["quarantinedFailures"], 1)
        self.assertEqual(len(data["quarantine"]), 1)
        self.assertEqual(data["quarantine"][0]["adr"], "ADR-042")

    def test_markdown_rendering(self):
        subject = BaselineSubject(
            git_commit="7c5b6bf55cec53200e62d70807f1d943b1dc85b2",
            git_tree_hash="3491f24d7756fbc8d3f6a74c5d80d2ef65e903f5",
            source_tree_hash="180a427702f35d5e90bf88dcbeaa7440401bca0c8f182e0ad3d1c19bcf8681e5",
            source_dirty=False,
            dirty_files=[],
            untracked_files=[],
            is_clean=True,
        )
        cmd = CommandRecord(
            name="pnpm test",
            command="pnpm test",
            category="frontend_unit_test",
            exit_code=0,
            passed=True,
            test_files_total=349,
            test_files_failed=0,
            tests_total=3166,
            tests_passed=3166,
            tests_failed=0,
            tests_skipped=0,
            failed_tests=[],
        )
        summary = build_baseline_summary(subject, [cmd], deterministic=True)
        md = render_markdown_summary(summary)
        self.assertIn("# Editor Regression Baseline Receipt", md)
        self.assertIn("7c5b6bf55cec53200e62d70807f1d943b1dc85b2", md)
        self.assertIn("NON-RELEASE CLAIM", md)
        self.assertIn("pnpm test", md)
        self.assertIn("3166 passed", md)

    def test_check_receipt_valid(self):
        from editor_baseline_summary import check_receipt
        valid_json = self.temp_path / "valid_receipt.json"
        subject = BaselineSubject(
            git_commit="a" * 40,
            git_tree_hash="b" * 40,
            source_tree_hash="c" * 64,
            source_dirty=False,
            dirty_files=[],
            untracked_files=[],
            is_clean=True,
        )
        summary = build_baseline_summary(subject, [], deterministic=True)
        valid_json.write_text(summary.to_json(), encoding="utf-8")

        ok, errors = check_receipt(valid_json)
        self.assertTrue(ok)
        self.assertEqual(errors, [])

    def test_check_receipt_invalid(self):
        from editor_baseline_summary import check_receipt
        bad_json = self.temp_path / "bad_receipt.json"
        bad_json.write_text('{"schemaVersion": "v999", "isReleaseClaim": true}', encoding="utf-8")

        ok, errors = check_receipt(bad_json)
        self.assertFalse(ok)
        self.assertTrue(len(errors) > 0)

    def test_run_and_parse_command(self):
        from editor_baseline_summary import run_and_parse_command
        with mock.patch("editor_baseline_summary._run_cmd", return_value=(0, "Test Files  349 passed (349)\nTests  3166 passed (3166)", "")):
            rec = run_and_parse_command(
                name="pnpm test",
                cmd=["pnpm", "test"],
                category="frontend_unit_test",
                parser_fn=parse_vitest_output,
            )
            self.assertEqual(rec.exit_code, 0)
            self.assertTrue(rec.passed)
            self.assertEqual(rec.tests_total, 3166)
            self.assertIsNotNone(rec.duration_sec)

    def test_cli_generate_to_file_and_check(self):
        from editor_baseline_summary import main as summary_main
        out_file = self.temp_path / "receipt.json"
        code = summary_main(["generate", "--output", str(out_file), "--deterministic"])
        self.assertEqual(code, 0)
        self.assertTrue(out_file.exists())

        check_code = summary_main(["check", str(out_file)])
        self.assertEqual(check_code, 0)

    def test_cli_verify_deterministic(self):
        from editor_baseline_summary import main as summary_main
        code = summary_main(["verify-deterministic"])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
