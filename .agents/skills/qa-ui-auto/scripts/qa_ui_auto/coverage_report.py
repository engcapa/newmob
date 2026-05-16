#!/usr/bin/env python3
"""Deterministic feature × testcase coverage analyzer.

This is the data-fetcher behind the `gen-coverage` subcommand of qa-ui-auto.
It does NOT generate testcases — it surfaces what's uncovered so the parent
agent (Claude Code) can read the relevant components and draft new YAML.

Usage:

    python -m qa_ui_auto.coverage_report                    # human summary
    python -m qa_ui_auto.coverage_report --json             # machine-readable
    python -m qa_ui_auto.coverage_report --uncovered-only   # only gap list
    python -m qa_ui_auto.coverage_report --feature F4.10    # detail for one feature

Reads:
  qa-ui-auto-tests/feature-list.md
  qa-ui-auto-tests/cases/**/*.testcase.yaml
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.testcase import discover  # noqa: E402
from qa_ui_auto.feature_catalog import load_features  # noqa: E402


@dataclass
class FeatureRow:
    id: str
    title: str
    status: str
    area: str
    components: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    case_ids: list[str] = field(default_factory=list)
    needs_review_case_ids: list[str] = field(default_factory=list)

    @property
    def covered(self) -> bool:
        return bool(self.case_ids)

    @property
    def fully_reviewed(self) -> bool:
        # Covered AND not all covering cases are needs-review.
        return self.covered and any(
            cid not in self.needs_review_case_ids for cid in self.case_ids
        )


def build_matrix(
    features_path: Path = Path("qa-ui-auto-tests/feature-list.md"),
    cases_dir: Path = Path("qa-ui-auto-tests/cases"),
) -> list[FeatureRow]:
    if not features_path.exists():
        raise FileNotFoundError(f"feature-list.md not found at {features_path}")
    feats = load_features(features_path)
    rows: dict[str, FeatureRow] = {
        f.id: FeatureRow(
            id=f.id,
            title=f.title,
            status=f.status,
            area=f.area,
            components=list(f.components),
            files=list(f.files),
        )
        for f in feats
    }

    for case in discover(cases_dir):
        is_needs_review = "needs-review" in case.tags
        for fid in case.covers:
            if fid in rows:
                rows[fid].case_ids.append(case.id)
                if is_needs_review:
                    rows[fid].needs_review_case_ids.append(case.id)

    return [rows[fid] for fid in rows]


def summary(rows: list[FeatureRow]) -> dict[str, Any]:
    total = len(rows)
    covered = sum(1 for r in rows if r.covered)
    fully = sum(1 for r in rows if r.fully_reviewed)
    return {
        "total_features": total,
        "covered_features": covered,
        "fully_reviewed_features": fully,
        "covered_pct": round(100 * covered / total, 1) if total else 0.0,
        "fully_reviewed_pct": round(100 * fully / total, 1) if total else 0.0,
        "uncovered": [r.id for r in rows if not r.covered],
        "needs_review_only": [
            r.id for r in rows if r.covered and not r.fully_reviewed
        ],
    }


def render_text(rows: list[FeatureRow], *, uncovered_only: bool = False) -> str:
    s = summary(rows)
    out: list[str] = []
    out.append(
        f"qa-ui-auto coverage: {s['covered_features']}/{s['total_features']} covered "
        f"({s['covered_pct']}%), {s['fully_reviewed_features']} fully reviewed "
        f"({s['fully_reviewed_pct']}%)"
    )
    out.append("")

    if s["uncovered"]:
        out.append(f"== Uncovered ({len(s['uncovered'])}) — no testcase references these")
        for fid in s["uncovered"]:
            r = next(x for x in rows if x.id == fid)
            out.append(f"  ✗ {r.id:<8} {r.title}  (area={r.area})")
            if r.files:
                out.append(f"      files: {', '.join(r.files[:3])}{'…' if len(r.files) > 3 else ''}")
        out.append("")

    if s["needs_review_only"] and not uncovered_only:
        out.append(
            f"== Needs-review only ({len(s['needs_review_only'])}) — covered "
            "only by auto-migrated cases that still have _TODO_MIGRATE steps"
        )
        for fid in s["needs_review_only"]:
            r = next(x for x in rows if x.id == fid)
            out.append(f"  ~ {r.id:<8} {r.title}  ({len(r.case_ids)} case(s))")
        out.append("")

    if not uncovered_only:
        fully = [r for r in rows if r.fully_reviewed]
        out.append(f"== Fully reviewed ({len(fully)})")
        for r in fully:
            clean = [c for c in r.case_ids if c not in r.needs_review_case_ids]
            out.append(f"  ✓ {r.id:<8} {r.title}  → {', '.join(clean)}")

    return "\n".join(out)


def render_feature_detail(row: FeatureRow) -> str:
    out: list[str] = [
        f"Feature: {row.id} — {row.title}",
        f"  status: {row.status}",
        f"  area:   {row.area}",
        f"  components: {', '.join(row.components) or '(none)'}",
        f"  files:      {', '.join(row.files) or '(none)'}",
        f"  covered:    {'yes' if row.covered else 'NO — needs a testcase'}",
        f"  fully_reviewed: {'yes' if row.fully_reviewed else 'no'}",
        f"  cases ({len(row.case_ids)}):",
    ]
    for cid in row.case_ids:
        flag = " (needs-review)" if cid in row.needs_review_case_ids else ""
        out.append(f"    - {cid}{flag}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.coverage_report")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases")
    ap.add_argument("--json", action="store_true",
                    help="emit machine-readable JSON")
    ap.add_argument("--uncovered-only", action="store_true",
                    help="print only the uncovered list (text mode)")
    ap.add_argument("--feature", default=None,
                    help="show detail for one feature ID, e.g. F4.10")
    args = ap.parse_args(argv)

    rows = build_matrix(Path(args.features), Path(args.cases))

    if args.feature:
        row = next((r for r in rows if r.id == args.feature), None)
        if not row:
            print(f"feature not found: {args.feature}", file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps({
                "id": row.id, "title": row.title, "status": row.status,
                "area": row.area, "components": row.components, "files": row.files,
                "covered": row.covered, "fully_reviewed": row.fully_reviewed,
                "cases": row.case_ids,
                "needs_review_cases": row.needs_review_case_ids,
            }, indent=2, ensure_ascii=False))
        else:
            print(render_feature_detail(row))
        return 0

    if args.json:
        s = summary(rows)
        s["features"] = [
            {
                "id": r.id, "title": r.title, "status": r.status, "area": r.area,
                "components": r.components, "files": r.files,
                "covered": r.covered, "fully_reviewed": r.fully_reviewed,
                "cases": r.case_ids,
                "needs_review_cases": r.needs_review_case_ids,
            }
            for r in rows
        ]
        print(json.dumps(s, indent=2, ensure_ascii=False))
    else:
        print(render_text(rows, uncovered_only=args.uncovered_only))
    return 0


if __name__ == "__main__":
    sys.exit(main())
