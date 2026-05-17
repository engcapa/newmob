#!/usr/bin/env python3
"""Deterministic feature × testcase coverage analyzer.

This is the data-fetcher behind the `audit` and `fix tests` commands of
qa-ui-auto. It does NOT generate testcases — it surfaces what's uncovered
so the parent agent (Claude Code) can read the relevant components and
draft new YAML.

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
from qa_ui_auto.control_coverage import build_coverage as _build_control_coverage  # noqa: E402


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
    # Control-level data, populated when feature has a `controls:` block.
    # When absent, all four are 0 and `controls_declared` is False — the
    # feature is reported via the legacy case-only path.
    controls_declared: bool = False
    control_total: int = 0
    control_required: int = 0
    control_covered: int = 0      # required controls with hit
    control_shallow: int = 0       # interactive controls only display-touched
    uncovered_required_controls: list[tuple[str, str, str]] = field(default_factory=list)
    # tuples are (control.id, control.kind, selector)

    @property
    def covered(self) -> bool:
        return bool(self.case_ids)

    @property
    def fully_reviewed(self) -> bool:
        """Strict reviewed: must have non-needs-review case AND, if controls
        are declared, every required control must have ≥1 case touching it.
        Features without a controls: block fall back to the old case-only
        rule so legacy entries don't regress.
        """
        if not self.covered:
            return False
        if not any(cid not in self.needs_review_case_ids for cid in self.case_ids):
            return False
        if self.controls_declared:
            return self.control_covered == self.control_required
        return True

    @property
    def control_coverage_pct(self) -> float:
        if self.control_required == 0:
            return 100.0
        return round(100 * self.control_covered / self.control_required, 1)


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

    # Layer in control-level coverage. The control_coverage module owns the
    # selector-derivation logic; we just consume its FeatureCoverage results
    # and merge into our FeatureRow records.
    try:
        ctrl_results, _orphans = _build_control_coverage(features_path, cases_dir)
    except Exception:  # noqa: BLE001 — coverage_report must keep working even
        ctrl_results = []                 # if control_coverage breaks
    for fc in ctrl_results:
        row = rows.get(fc.feature.id)
        if row is None:
            continue
        row.controls_declared = True
        row.control_total = fc.total
        row.control_required = fc.total_required
        row.control_covered = fc.covered_required
        row.control_shallow = fc.shallow_count
        row.uncovered_required_controls = [
            (cc.control.id, cc.control.kind, cc.control.selector)
            for cc in fc.controls
            if not cc.control.optional and not cc.covered
        ]

    return [rows[fid] for fid in rows]


def summary(rows: list[FeatureRow]) -> dict[str, Any]:
    total = len(rows)
    covered = sum(1 for r in rows if r.covered)
    fully = sum(1 for r in rows if r.fully_reviewed)
    declared = sum(1 for r in rows if r.controls_declared)
    ctrl_required = sum(r.control_required for r in rows)
    ctrl_covered = sum(r.control_covered for r in rows)
    ctrl_shallow = sum(r.control_shallow for r in rows)
    ctrl_pct = round(100 * ctrl_covered / ctrl_required, 1) if ctrl_required else 0.0
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
        # Control-level totals
        "features_with_controls": declared,
        "control_required": ctrl_required,
        "control_covered_required": ctrl_covered,
        "control_shallow": ctrl_shallow,
        "control_coverage_pct": ctrl_pct,
    }


def render_text(rows: list[FeatureRow], *, uncovered_only: bool = False) -> str:
    s = summary(rows)
    out: list[str] = []
    out.append(
        f"qa-ui-auto coverage: {s['covered_features']}/{s['total_features']} covered "
        f"({s['covered_pct']}%), {s['fully_reviewed_features']} fully reviewed "
        f"({s['fully_reviewed_pct']}%)"
    )
    if s["control_required"]:
        out.append(
            f"control coverage: {s['control_covered_required']}/{s['control_required']} "
            f"required controls touched ({s['control_coverage_pct']}%) across "
            f"{s['features_with_controls']} feature(s) with declared controls; "
            f"{s['control_shallow']} shallow"
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
        # Split by *why* the feature is in this bucket: needs-review tag, or
        # missing required control coverage. Keeps the report actionable.
        nr_tag: list[str] = []
        nr_ctrl: list[str] = []
        for fid in s["needs_review_only"]:
            r = next(x for x in rows if x.id == fid)
            non_nr = any(cid not in r.needs_review_case_ids for cid in r.case_ids)
            if not non_nr:
                nr_tag.append(fid)
            else:
                nr_ctrl.append(fid)
        if nr_tag:
            out.append(
                f"== Needs-review only ({len(nr_tag)}) — every covering case is tagged "
                "needs-review (auto-drafted, assertions are likely shallow)"
            )
            for fid in nr_tag:
                r = next(x for x in rows if x.id == fid)
                out.append(f"  ~ {r.id:<8} {r.title}  ({len(r.case_ids)} case(s))")
            out.append("")
        if nr_ctrl:
            out.append(
                f"== Partial control coverage ({len(nr_ctrl)}) — has reviewed cases, "
                "but at least one required `controls:` entry has no case touching it"
            )
            for fid in nr_ctrl:
                r = next(x for x in rows if x.id == fid)
                missing = ", ".join(c[0] for c in r.uncovered_required_controls[:5])
                tail = "…" if len(r.uncovered_required_controls) > 5 else ""
                out.append(
                    f"  ~ {r.id:<8} {r.title}  "
                    f"({r.control_covered}/{r.control_required} controls; "
                    f"missing: {missing}{tail})"
                )
            out.append("")

    if not uncovered_only:
        fully = [r for r in rows if r.fully_reviewed]
        out.append(f"== Fully reviewed ({len(fully)})")
        for r in fully:
            clean = [c for c in r.case_ids if c not in r.needs_review_case_ids]
            ctrl_note = (
                f"  [{r.control_required}/{r.control_required} controls]"
                if r.controls_declared else ""
            )
            out.append(f"  ✓ {r.id:<8} {r.title}{ctrl_note}  → {', '.join(clean)}")

    return "\n".join(out)


def render_uncovered_controls(rows: list[FeatureRow]) -> str:
    """List every required control that no case touches, grouped by feature.

    This is the actionable view for `fix tests <F.x>` — it tells the agent
    which specific controls need a new (or extended) testcase. Optional
    controls and shallow-only ones aren't listed here; shallow shows up in
    the main report's "Partial control coverage" section.
    """
    lines: list[str] = []
    rows_with_gaps = [r for r in rows if r.uncovered_required_controls]
    rows_with_gaps.sort(key=lambda r: -len(r.uncovered_required_controls))
    if not rows_with_gaps:
        return "no uncovered required controls — every declared control has at least one case touching it."
    total = sum(len(r.uncovered_required_controls) for r in rows_with_gaps)
    lines.append(
        f"{total} uncovered required control(s) across {len(rows_with_gaps)} feature(s):"
    )
    lines.append("")
    for r in rows_with_gaps:
        lines.append(f"== {r.id} {r.title}  "
                     f"({len(r.uncovered_required_controls)}/{r.control_required} missing)")
        for cid, kind, sel in r.uncovered_required_controls:
            lines.append(f"  - {cid:<28} [{kind:<11}] {sel}")
        lines.append("")
    return "\n".join(lines)


def render_feature_detail(row: FeatureRow) -> str:
    out: list[str] = [
        f"Feature: {row.id} — {row.title}",
        f"  status: {row.status}",
        f"  area:   {row.area}",
        f"  components: {', '.join(row.components) or '(none)'}",
        f"  files:      {', '.join(row.files) or '(none)'}",
        f"  covered:    {'yes' if row.covered else 'NO — needs a testcase'}",
        f"  fully_reviewed: {'yes' if row.fully_reviewed else 'no'}",
    ]
    if row.controls_declared:
        out.append(
            f"  controls:   "
            f"{row.control_covered}/{row.control_required} required covered "
            f"({row.control_coverage_pct}%), "
            f"{row.control_shallow} shallow, "
            f"{row.control_total - row.control_required} optional"
        )
        if row.uncovered_required_controls:
            out.append("  missing required controls:")
            for cid, kind, sel in row.uncovered_required_controls:
                out.append(f"    - {cid:<24} [{kind:<11}] {sel}")
    else:
        out.append("  controls:   (none declared — fill in via `fix controls`)")
    out.append(f"  cases ({len(row.case_ids)}):")
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
    ap.add_argument("--controls", action="store_true",
                    help="report uncovered required controls (control-level "
                         "actionable list — feeds `fix tests` drafting)")
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
                "controls_declared": row.controls_declared,
                "control_total": row.control_total,
                "control_required": row.control_required,
                "control_covered_required": row.control_covered,
                "control_shallow": row.control_shallow,
                "control_coverage_pct": row.control_coverage_pct,
                "uncovered_required_controls": [
                    {"id": cid, "kind": kind, "selector": sel}
                    for cid, kind, sel in row.uncovered_required_controls
                ],
            }, indent=2, ensure_ascii=False))
        else:
            print(render_feature_detail(row))
        return 0

    if args.controls:
        if args.json:
            payload = {
                "summary": summary(rows),
                "uncovered_required_controls": [
                    {
                        "feature_id": r.id,
                        "feature_title": r.title,
                        "controls": [
                            {"id": cid, "kind": kind, "selector": sel}
                            for cid, kind, sel in r.uncovered_required_controls
                        ],
                    }
                    for r in rows if r.uncovered_required_controls
                ],
            }
            print(json.dumps(payload, indent=2, ensure_ascii=False))
        else:
            print(render_uncovered_controls(rows))
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
                "controls_declared": r.controls_declared,
                "control_total": r.control_total,
                "control_required": r.control_required,
                "control_covered_required": r.control_covered,
                "control_shallow": r.control_shallow,
                "control_coverage_pct": r.control_coverage_pct,
                "uncovered_required_controls": [
                    {"id": cid, "kind": kind, "selector": sel}
                    for cid, kind, sel in r.uncovered_required_controls
                ],
            }
            for r in rows
        ]
        print(json.dumps(s, indent=2, ensure_ascii=False))
    else:
        print(render_text(rows, uncovered_only=args.uncovered_only))
    return 0


if __name__ == "__main__":
    sys.exit(main())
