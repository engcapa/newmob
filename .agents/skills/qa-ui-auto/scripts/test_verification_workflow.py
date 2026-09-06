"""Behavioral checks for truthful coverage, selection, reuse and bounded execution."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import native_build
import perf_baseline
from qa_ui_auto import audit, runner
from qa_ui_auto.deadline import CaseTimeout, Deadline, budget_time, using_deadline
from qa_ui_auto.feature_catalog import Feature
from qa_ui_auto.provenance import digest_file, input_digest, conditions_identity
from qa_ui_auto.runner_receipt import emit_runner_receipt
from qa_ui_auto.testcase import TestCase
from qa_ui_auto.verification import coverage_status, load_observations, native_support, plan


class VerificationTest(unittest.TestCase):
    def test_renderer_selection_retains_native_only_and_backend_change_broadens(self):
        features = [Feature(id="F1", title="UI", files=["src/components/View.tsx"])]
        cases = [TestCase(id="TC-ui", title="UI", covers=["F1"], modes=["browser", "native"]),
                 TestCase(id="TC-disk", title="Disk", covers=["F1"], modes=["native"]),
                 TestCase(id="TC-other", title="Other", covers=["F2"], modes=["browser"])]
        result = plan(cases, features, ["src/components/View.tsx"], "Windows")
        self.assertEqual(result["commands"][0]["cases"], ["TC-ui"])
        self.assertEqual(result["commands"][1]["cases"], ["TC-disk"])
        result = plan(cases, features, ["src-tauri/src/unknown.rs"], "Windows")
        self.assertIn("TC-other", result["commands"][0]["cases"])
        self.assertEqual(result["unmapped_source_files"], ["src-tauri/src/unknown.rs"])

    def test_platform_gap_is_not_silently_dropped(self):
        case = TestCase(id="TC-ime", title="IME", modes=["native"], steps=[{"native_ime_keys": {}}])
        self.assertIsNone(native_support(case, "Linux"))
        self.assertIn("Linux", native_support(case, "Windows"))
        result = plan([case], [], None, "macOS")
        self.assertFalse(result["commands"])
        self.assertEqual(result["native_gaps"][0]["case"], case.id)

    def test_native_pattern_requires_output_not_the_echoed_command(self):
        from qa_ui_auto import native_steps
        with tempfile.TemporaryDirectory() as directory:
            session = Mock()
            session.text.side_effect = ["PS> echo QA_READY", "PS> echo QA_READY\nQA_READY\nPS>"]
            ctx = native_steps.NativeStepContext(session, Path(directory), {})
            native_steps.VERBS["assert_pattern"](ctx, {"selector": "#terminal", "regex": "(?m)^QA_READY$"})
            self.assertEqual(session.text.call_count, 2)

    def test_browser_pattern_reads_terminal_text_attribute(self):
        from qa_ui_auto.steps import assertions
        page = Mock()
        locator = page.locator.return_value.first
        locator.text_content.return_value = ""
        locator.get_attribute.return_value = "PS> echo QA_READY\nQA_READY\nPS>"
        ctx = SimpleNamespace(page=page, dry_run=False)
        assertions.step_assert_pattern(ctx, {"selector": "#terminal", "regex": "(?m)^QA_READY$"})
        locator.get_attribute.assert_called_with("data-terminal-text")

    def test_status_requires_current_reviewed_case_and_does_not_mask_latest_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.yaml"
            path.write_text("current case")
            case = TestCase(id="TC-a", title="A", covers=["F1"], source_path=path)
            value = {"status": "passed", "current": True, "case_sha256": digest_file(path),
                     "finished_at": "2026-09-06T10:00:00Z", "report": "run/summary.json"}
            observations = {(case.id, "browser", "Windows"): value}
            self.assertTrue(coverage_status([case], [], observations, ["Windows"])["ok"])
            value["status"] = "failed"
            self.assertFalse(coverage_status([case], [], observations, ["Windows"])["ok"])
            value["status"] = "passed"
            case.tags = ["needs-review"]
            self.assertFalse(coverage_status([case], [], observations, ["Windows"])["ok"])
            case.tags = []
            path.write_text("changed case")
            row = coverage_status([case], [], observations, ["Windows"])["cases"][0]
            self.assertEqual(row["execution"]["browser:Windows"]["status"], "stale")

    def test_another_os_pass_cannot_hide_current_target_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.yaml"
            path.write_text("case")
            case = TestCase(id="TC-a", title="A", source_path=path)
            value = {"current": True, "case_sha256": input_digest(path), "report": "summary.json"}
            observations = {(case.id, "browser", "Windows"): dict(value, status="failed", finished_at="1"),
                            (case.id, "browser", "Linux"): dict(value, status="passed", finished_at="2")}
            result = coverage_status([case], [], observations, ["Windows"])
            self.assertFalse(result["ok"])
            self.assertEqual(result["cases"][0]["execution"]["browser:Windows"]["status"], "failed")

    def test_checkout_line_endings_do_not_invalidate_cross_platform_input_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.yaml"
            path.write_bytes(b"id: TC-a\ntitle: test\n")
            expected = input_digest(path)
            path.write_bytes(b"id: TC-a\r\ntitle: test\r\n")
            self.assertEqual(input_digest(path), expected)
            path.write_bytes(b"id: TC-b\r\ntitle: test\r\n")
            self.assertNotEqual(input_digest(path), expected)

    def test_changed_dual_mode_case_plans_both_modes(self):
        case = TestCase(id="TC-a", title="A", modes=["browser", "native"], source_path=Path("cases/a.yaml"))
        result = plan([case], [], ["cases/a.yaml"], "Windows")
        self.assertEqual([c["mode"] for c in result["commands"]], ["browser", "native"])

    def test_dry_run_legacy_and_modified_reports_cannot_prove_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / "run-test"
            report.mkdir()
            summary = report / "summary.json"
            for data in ({"dry_run": True}, {}):
                summary.write_text(json.dumps(data))
                observations, rejected = load_observations([root], {})
                self.assertFalse(observations)
                self.assertEqual(len(rejected), 1)
            identity = {"source_sha256": "source", "runner_sha256": "runner"}
            data = {"dry_run": False, "mode": "browser", "platform": "Windows", "identity": identity,
                    "conditions_sha256": conditions_identity({}, "browser"),
                    "identity_stable": True, "exit_code": 0, "cases": [
                        {"id": "TC-a", "status": "passed", "case_sha256": "case"}]}
            summary.write_text(json.dumps(data))
            emit_runner_receipt(report, "browser", ["runner"], "2026-09-06T10:00:00Z",
                                "2026-09-06T10:00:01Z", 1, 0)
            observations, rejected = load_observations([root], identity, {})
            self.assertFalse(rejected)
            self.assertTrue(observations[("TC-a", "browser", "Windows")]["current"])
            different = {"app": {"base_url": "http://other.invalid"}}
            self.assertFalse(load_observations([root], identity, different)[0][("TC-a", "browser", "Windows")]["current"])
            data["cases"][0]["status"] = "failed"
            summary.write_text(json.dumps(data))
            self.assertFalse(load_observations([root], identity)[0])

    def test_static_gate_does_not_require_release_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / "baseline.json"
            baseline.write_text('{"totals": {}}')
            with patch.object(audit, "build_coverage", return_value=([], [])), \
                 patch.object(audit, "_build_snapshot", return_value={"totals": {}}), \
                 patch.object(audit, "_render_gate_diff", return_value=([], [])):
                result = audit._gate(features_path=Path("unused"), cases_dir=Path("unused"), baseline_path=baseline)
            self.assertTrue(result["ok"])
            self.assertFalse(result["evidence_gate"]["required"])

    def test_isolated_java_fixture_mutations_leave_checkout_sample_unchanged(self):
        from qa_ui_auto.fixtures import java_sample_projects
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample"
            source.mkdir()
            (source / "pom.xml").write_text("sample project")
            ctx = SimpleNamespace(case_dir=root / "case", values={})
            with patch.object(java_sample_projects, "SAMPLES", {"maven_single_root": (source, "pom.xml")}):
                java_sample_projects.setup(ctx)
            isolated = Path(ctx.values["maven_single_root"])
            (isolated / "pom.xml").write_text("changed by native test")
            self.assertEqual((source / "pom.xml").read_text(), "sample project")

    def test_deadline_interrupts_poll_sleep(self):
        started = time.monotonic()
        with self.assertRaises(CaseTimeout), using_deadline(Deadline(0.02)):
            budget_time.sleep(5)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_native_failure_capture_uses_original_session_before_close(self):
        from qa_ui_auto import native_steps
        import tauri_webdriver
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case = TestCase(id="TC-fail", title="Failure", modes=["native"], steps=[{"click": "missing"}])
            session = Mock()
            session.console_entries.return_value = []
            session.execute.return_value = "<html>failure</html>"
            captured = []
            session.screenshot.side_effect = lambda path: captured.append(not session.close.called)
            harness = Mock()
            harness.__enter__ = Mock(return_value=harness)
            harness.__exit__ = Mock(return_value=False)
            harness.create_session.return_value = session
            with patch.object(tauri_webdriver, "NativeHarness", return_value=harness), \
                 patch.object(native_steps, "run_native_step", side_effect=RuntimeError("failure")):
                results = runner._native_run([case], {}, {}, root, False)
            self.assertEqual(captured, [True])
            harness.create_session.assert_called_once()
            session.close.assert_called_once()
            self.assertEqual(results[0]["failure"]["step_index"], 1)

    def test_build_cache_requires_matching_recipe_and_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "src-tauri/target/qa-ui-auto/debug/taomni.exe"
            output.parent.mkdir(parents=True)
            output.write_bytes(b"QA")
            inputs = {"source_sha256": "source", "recipe_sha256": "recipe"}
            native_build.identity_path(output).write_text(json.dumps({
                "identifier": native_build.QA_APP_ID, "binary_sha256": native_build.binary_digest(output),
                "build_inputs": inputs,
            }))
            with patch.object(native_build, "ROOT", root), \
                 patch.object(native_build.platform, "system", return_value="Windows"), \
                 patch.object(native_build.shutil, "which", return_value="pnpm"), \
                 patch.object(native_build, "build_inputs", return_value=inputs), \
                 patch.object(native_build.subprocess, "run") as build:
                self.assertEqual(native_build.build_qa(), output)
                build.assert_not_called()

    def test_performance_keeps_slow_samples_and_fails_regression_within_budget(self):
        metrics = perf_baseline.summarize([10] * 10 + [1500])
        self.assertIn(1500, metrics["samples_ms"])
        self.assertEqual(metrics["dropped_outliers_ge_1000ms"], 0)
        result = {name: perf_baseline.summarize([20] * 20) for name in (
            "normal_input_key_to_paint", "local_action_toggle_comment")}
        result["conditions"] = {"machine": "same"}
        baseline = {name: perf_baseline.summarize([10] * 20) for name in (
            "normal_input_key_to_paint", "local_action_toggle_comment")}
        baseline["conditions"] = result["conditions"]
        self.assertEqual(perf_baseline.assess(result, baseline, noise_ms=2)[0], 1)
        baseline["conditions"] = {"machine": "other"}
        self.assertEqual(perf_baseline.assess(result, baseline)[0], 2)


if __name__ == "__main__":
    unittest.main()
