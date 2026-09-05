#!/usr/bin/env python3
"""Unit tests for Buffer Authority Migration ADR & Baseline Evidence (ED-PERF-004).

Acceptance coverage:
- ED-PERF-004-A1: 1 MB and 5 MB current baselines are reproducible with raw samples.
- ED-PERF-004-A2: ADR labels measured vs target values.
- ED-PERF-004-A3: Each phase has correctness/performance gates and rollback triggers.
"""

from __future__ import annotations

import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_PATH = ROOT / "evidence" / "perf-buffer-authority-baseline-20260903.json"
ADR_PATH = ROOT / "claudedocs" / "adr-buffer-authority-migration.md"


def percentile_nearest_rank(samples: list[float], percentile: float) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    rank = max(1, int((percentile / 100.0 * len(ordered)) + 0.999999))
    return round(ordered[rank - 1], 3)


class TestBufferAuthorityBenchmark(unittest.TestCase):
    def test_ed_perf_004_a1_baseline_artifact_exists_and_valid(self):
        """ED-PERF-004-A1: 1 MB and 5 MB current baselines are reproducible with raw samples."""
        self.assertTrue(ARTIFACT_PATH.is_file(), f"Artifact missing: {ARTIFACT_PATH}")
        data = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))

        self.assertIn("recordedAt", data)
        self.assertIn("results", data)
        self.assertEqual(len(data["results"]), 2, "Expected 2 buffer benchmark results (1MB and 5MB)")

        labels = {r["bufferSizeLabel"] for r in data["results"]}
        self.assertEqual(labels, {"1MB", "5MB"})

        for res in data["results"]:
            label = res["bufferSizeLabel"]
            byte_size = res["byteSize"]
            if label == "1MB":
                self.assertGreaterEqual(byte_size, 1024 * 1024)
            else:
                self.assertGreaterEqual(byte_size, 5 * 1024 * 1024)

            # Check Zustand baseline raw samples
            zustand = res["zustandBaseline"]
            raw_samples = zustand["rawSamplesMs"]
            self.assertEqual(len(raw_samples), 200, f"{label} expected 200 raw samples")
            typing = zustand["typing"]
            self.assertEqual(typing["n"], 200)

            # Verify percentiles match nearest rank calculation
            for key, pct in [("p50_ms", 50), ("p95_ms", 95), ("p99_ms", 99)]:
                expected_val = percentile_nearest_rank(raw_samples, pct)
                self.assertEqual(
                    round(float(typing[key]), 3),
                    expected_val,
                    f"{label} {key} does not match nearest rank calculation",
                )

            # Check CodeMirror rope target raw samples
            cm = res["codeMirrorRope"]
            cm_samples = cm["rawSamplesMs"]
            self.assertEqual(len(cm_samples), 200)
            self.assertLess(cm["typing"]["p95_ms"], typing["p95_ms"])
            self.assertGreater(res["speedupP95Ratio"], 1.0)
            self.assertGreater(res["ipcPayloadReductionRatio"], 10.0)

    def test_ed_perf_004_a2_adr_labels_measured_vs_target_values(self):
        """ED-PERF-004-A2: ADR clearly labels measured vs target values."""
        self.assertTrue(ADR_PATH.is_file(), f"ADR missing: {ADR_PATH}")
        content = ADR_PATH.read_text(encoding="utf-8")

        self.assertIn("[MEASURED BASELINE]", content)
        self.assertIn("[MEASURED PROTOTYPE]", content)
        self.assertIn("[TARGET INVARIANT / ESTIMATE]", content)
        self.assertIn("perf-buffer-authority-baseline-20260903.json", content)
        self.assertIn("node --experimental-strip-types scripts/buffer_authority_benchmark.ts", content)

    def test_ed_perf_004_a3_adr_defines_invariants_and_phased_gates(self):
        """ED-PERF-004-A3: Each phase has correctness/performance gates, rollback triggers, and invariants."""
        content = ADR_PATH.read_text(encoding="utf-8")

        # Invariants
        self.assertIn("Shared-Document", content)
        self.assertIn("Save", content)
        self.assertIn("LSP", content)
        self.assertIn("Git Diff", content)
        self.assertIn("Undo / Redo", content)
        self.assertIn("Crash Recovery", content)
        self.assertIn("Snapshot", content)

        # Phased gates
        self.assertIn("Phase 1: Throttled Snapshot Emission & Store Decoupling", content)
        self.assertIn("Phase 2: Transaction-Driven Incremental LSP Synchronization", content)
        self.assertIn("Phase 3: Headless Shared Buffer & Worker Offloading", content)

        # Rollback & Feature Gate
        self.assertIn("workspace.incrementalBufferAuthority", content)
        self.assertIn("Rollback Trigger", content)


if __name__ == "__main__":
    unittest.main()
