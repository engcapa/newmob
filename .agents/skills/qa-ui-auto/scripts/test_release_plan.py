#!/usr/bin/env python3
"""Unit tests for Release Plan Validator (ED-REL-003).

Acceptance coverage:
- ED-REL-003-A1: Valid plan resolves deterministic requirements.
- ED-REL-003-A2: Unknown, path-escape, or cross-channel input fails.
- ED-REL-003-A3: Runner / rollup uses validated plan without alternate roots.
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

from qa_ui_auto.release_plan import (
    DEFAULT_EVIDENCE_ROOTS,
    validate_artifact_path,
    load_release_plan,
    resolve_channel_requirements,
    evaluate_channel_compliance,
)


class TestReleasePlan(unittest.TestCase):
    def setUp(self):
        self.sample_plan = {
            "version": 1,
            "releaseChannels": {
                "linux-daily-editor": {
                    "platform": "linux",
                    "requiredCapabilities": ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
                    "requiredEvidenceLayers": ["unit", "browser", "native"],
                    "evidenceRoots": ["qa-ui-auto-report", "evidence"],
                    "performanceBudget": {
                        "typingP95Ms": 50,
                        "localActionP95Ms": 100,
                    },
                },
            },
        }

    def test_ed_rel_003_a1_resolves_deterministic_requirements(self):
        """ED-REL-003-A1: Valid plan resolves deterministic requirements."""
        reqs = resolve_channel_requirements("linux-daily-editor", self.sample_plan)
        self.assertEqual(reqs["platform"], "linux")
        self.assertEqual(reqs["requiredCapabilities"], ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"])
        self.assertEqual(reqs["requiredEvidenceLayers"], ["unit", "browser", "native"])
        self.assertEqual(reqs["evidenceRoots"], ["qa-ui-auto-report", "evidence"])
        self.assertEqual(reqs["performanceBudget"]["typingP95Ms"], 50)

    def test_ed_rel_003_a2_unknown_channel_fails(self):
        """ED-REL-003-A2: Unknown channel or cross-channel input fails closed."""
        with self.assertRaises(ValueError):
            resolve_channel_requirements("unknown-channel", self.sample_plan)

        comp = evaluate_channel_compliance(
            "unknown-channel",
            self.sample_plan,
            ["C0-save-pipeline"],
            ["unit"],
            ["qa-ui-auto-report/summary.json"],
        )
        self.assertFalse(comp["compliant"])
        self.assertIn("not found in release plan", comp["invalidArtifacts"][0]["reason"])

    def test_ed_rel_003_a2_path_escapes_rejected(self):
        """ED-REL-003-A2: Path traversal, absolute paths, and escapes fail closed."""
        # Absolute path (POSIX)
        res1 = validate_artifact_path("/etc/passwd")
        self.assertFalse(res1["valid"])
        self.assertEqual(res1["reason"], "absolute-path-rejected")

        # Absolute path (Windows)
        res2 = validate_artifact_path("C:\\Users\\admin\\secret.txt")
        self.assertFalse(res2["valid"])
        self.assertEqual(res2["reason"], "absolute-path-rejected")

        # Traversal segment (..)
        res3 = validate_artifact_path("qa-ui-auto-report/../../etc/passwd")
        self.assertFalse(res3["valid"])
        self.assertEqual(res3["reason"], "traversal-rejected")

        # Traversal segment (.)
        res4 = validate_artifact_path("qa-ui-auto-report/./bad.json")
        self.assertFalse(res4["valid"])
        self.assertEqual(res4["reason"], "traversal-rejected")

    def test_ed_rel_003_a3_alternate_roots_rejected(self):
        """ED-REL-003-A3: Out-of-root and alternate root artifacts are rejected."""
        # Outside allowed roots
        res1 = validate_artifact_path("src/secret.ts", ["qa-ui-auto-report", "evidence"])
        self.assertFalse(res1["valid"])
        self.assertEqual(res1["reason"], "disallowed-root")

        # In unapproved directory
        res2 = validate_artifact_path("dist/bundle.js", ["qa-ui-auto-report", "evidence"])
        self.assertFalse(res2["valid"])
        self.assertEqual(res2["reason"], "disallowed-root")

        # Approved root succeeds
        res3 = validate_artifact_path("qa-ui-auto-report/run-01/summary.json", ["qa-ui-auto-report", "evidence"])
        self.assertTrue(res3["valid"])

    def test_channel_compliance_evaluation(self):
        """Validates channel compliance with missing caps/layers."""
        comp = evaluate_channel_compliance(
            "linux-daily-editor",
            self.sample_plan,
            ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
            ["unit", "browser", "native"],
            ["qa-ui-auto-report/run-01/summary.json", "evidence/runs/summary.md"],
        )
        self.assertTrue(comp["compliant"])
        self.assertEqual(len(comp["missingCapabilities"]), 0)
        self.assertEqual(len(comp["missingLayers"]), 0)
        self.assertEqual(len(comp["invalidArtifacts"]), 0)

        # Missing native layer
        comp_missing = evaluate_channel_compliance(
            "linux-daily-editor",
            self.sample_plan,
            ["C0-save-pipeline", "C3-clipboard-session", "C4-tab-policy"],
            ["unit", "browser"],  # missing native
            ["qa-ui-auto-report/run-01/summary.json"],
        )
        self.assertFalse(comp_missing["compliant"])
        self.assertIn("native", comp_missing["missingLayers"])


if __name__ == "__main__":
    unittest.main()
