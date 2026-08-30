#!/usr/bin/env python3
"""Verify ED-PERF-001 raw browser samples and compare two runner artifacts."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def percentile_nearest_rank(samples: list[float], percentile: float) -> float:
    ordered = sorted(samples)
    rank = max(1, int((percentile / 100.0 * len(ordered)) + 0.999999))
    return round(ordered[rank - 1], 3)


def load_report(path: Path) -> dict:
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("taskId") != "ED-PERF-001":
        raise ValueError(f"{path}: unexpected task id")
    samples = report.get("measurement", {}).get("rawSamplesMs")
    if not isinstance(samples, list) or not samples:
        raise ValueError(f"{path}: measurement.rawSamplesMs is empty")
    expected_count = report["measurement"].get("count")
    if expected_count != len(samples):
        raise ValueError(f"{path}: count does not match raw sample length")
    measured = report["measurement"].get("typing", {})
    for key, percentile in (("p50_ms", 50), ("p95_ms", 95), ("p99_ms", 99)):
        if round(float(measured[key]), 3) != percentile_nearest_rank(samples, percentile):
            raise ValueError(f"{path}: {key} does not match raw samples")
    return report


def main(argv: list[str] | None = None) -> int:
    if not argv or len(argv) != 2:
        print("usage: verify_editor_performance.py BEFORE.json AFTER.json", file=sys.stderr)
        return 2
    before = load_report(Path(argv[0]))
    after = load_report(Path(argv[1]))
    before_fixture = before.get("fixture")
    after_fixture = after.get("fixture")
    same_fixture = before_fixture == after_fixture
    before_p95 = float(before["measurement"]["typing"]["p95_ms"])
    after_p95 = float(after["measurement"]["typing"]["p95_ms"])
    no_regression = same_fixture and after_p95 <= before_p95
    budget_passed = after_p95 <= 50
    result = {
        "taskId": "ED-PERF-001",
        "before": {
            "commit": before.get("commit"),
            "artifactFixture": before_fixture,
            "p95Ms": before_p95,
        },
        "after": {
            "commit": after.get("commit"),
            "artifactFixture": after_fixture,
            "p95Ms": after_p95,
        },
        "sameFixture": same_fixture,
        "noRegression": no_regression,
        "budget": {
            "typingP95Ms": 50,
            "passed": budget_passed,
        },
        "verdict": "passed" if no_regression and budget_passed else "failed",
    }
    print(json.dumps(result, indent=2))
    return 0 if result["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
