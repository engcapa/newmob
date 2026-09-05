#!/usr/bin/env python3
"""Unit tests for matrix_from_artifacts.py (ED-QA-003).

Verifies fail-closed builder behavior against synthetic temp trees:
- missing artifacts never become PASS (BLOCKED with named reason);
- failing gate runs become FAIL rows, never PASS;
- a complete synthetic tree builds PASS rows marked runner-artifact;
- Windows/macOS rows are independently BLOCKED (no extrapolation).
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "qa_ui_auto"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from matrix_from_artifacts import main as matrix_main


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def passing_summary(case_id: str, mode: str = "native") -> dict:
    return {
        "started_at": "2026-09-04T00:00:00+08:00",
        "finished_at": "2026-09-04T00:01:00+08:00",
        "duration_sec": 6.0,
        "mode": mode,
        "workers": 1,
        "totals": {"failed": 0, "passed": 1, "skipped": 0, "total": 1},
        "cases": [{
            "id": case_id, "title": case_id, "status": "passed",
            "tags": [], "covers": ["F25.5"], "modes": [mode],
            "duration_sec": 6.0, "step_count": 10, "worker_id": 0,
            "failure": None, "fixtures_skipped": None,
        }],
        "schema": "qa-ui-auto.summary.v1",
    }


class MatrixBuilderTest(unittest.TestCase):
    def make_tree(self, root: Path) -> tuple[Path, Path]:
        ev = root / "evidence"
        traces = root / "traces"
        ev.mkdir(parents=True)
        traces.mkdir(parents=True)
        return ev, traces

    def run_builder(self, ev: Path, traces: Path, out: Path) -> dict:
        code = matrix_main([
            "--evidence-dir", str(ev),
            "--traces-dir", str(traces),
            "--out", str(out),
        ])
        self.assertEqual(code, 0)
        return json.loads(out.read_text(encoding="utf-8"))

    def test_missing_everything_yields_blocked_never_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            ev, traces = self.make_tree(Path(tmp))
            matrix = self.run_builder(ev, traces, Path(tmp) / "matrix.json")
            statuses = {row["status"] for row in matrix["records"]}
            self.assertNotIn("PASS", statuses)
            self.assertNotIn("FAIL", statuses)
            self.assertEqual(statuses, {"BLOCKED"})
            self.assertTrue(matrix["gaps"])

    def test_failing_gate_run_becomes_fail_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            ev, traces = self.make_tree(Path(tmp))
            summary = passing_summary(
                "TC-IDE-C7-04-maven-tooling-ingestion-native", "native")
            summary["cases"][0]["status"] = "failed"
            summary["cases"][0]["failure"] = {"message": "synthetic failure"}
            write_json(ev / "run-x.summary.json", summary)
            write_json(ev / "run-x.runner_receipt.json", {"exitCode": 1})
            matrix = self.run_builder(ev, traces, Path(tmp) / "matrix.json")
            maven_rows = [r for r in matrix["records"]
                          if r["capabilityId"] == "project.maven-ingest"
                          and r["platform"] == "linux"]
            self.assertEqual(len(maven_rows), 1)
            self.assertEqual(maven_rows[0]["status"], "FAIL")

    def test_complete_synthetic_tree_builds_pass_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            ev, traces = self.make_tree(Path(tmp))
            write_json(
                ev / "run-s.summary.json",
                passing_summary("TC-IDE-C7-04-maven-tooling-ingestion-native", "native"))
            write_json(ev / "run-s.runner_receipt.json", {"exitCode": 0})
            matrix = self.run_builder(ev, traces, Path(tmp) / "matrix.json")
            maven_rows = [r for r in matrix["records"]
                          if r["capabilityId"] == "project.maven-ingest"
                          and r["platform"] == "linux"]
            self.assertEqual(len(maven_rows), 1)
            self.assertEqual(maven_rows[0]["status"], "PASS")
            self.assertEqual(maven_rows[0]["origin"], "runner-artifact")

    def test_platform_rows_are_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            ev, traces = self.make_tree(Path(tmp))
            matrix = self.run_builder(ev, traces, Path(tmp) / "matrix.json")
            platforms = {(r["capabilityId"], r["platform"]) for r in matrix["records"]}
            self.assertIn(("query.definition", "windows"), platforms)
            self.assertIn(("query.definition", "macos"), platforms)
            for row in matrix["records"]:
                if row["platform"] in ("windows", "macos"):
                    self.assertEqual(row["status"], "BLOCKED")
                    self.assertTrue(row["blockedReason"])


if __name__ == "__main__":
    unittest.main()
