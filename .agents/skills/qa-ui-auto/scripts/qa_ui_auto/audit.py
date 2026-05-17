#!/usr/bin/env python3
"""qa-ui-auto audit — single diagnostic entry point.

This module is the agent-facing replacement for the cluster of underlying
data-fetcher modules (lint / coverage_report / control_coverage / diff_impact /
gen_testid_catalog). Audit reads the project state, aggregates everything into
one prioritized report, and tells the parent agent which `fix` command to run
next for each gap. The underlying modules are still callable directly for
power users; audit is the default entry point for "what's the state of UI
tests right now?"-style questions.

Sections (in priority order):

  1. Health       — pass/fail of lint, catalog freshness, gate vs baseline
  2. Gaps         — feature-level + control-level + (optionally) diff impact;
                    each gap is paired with the `fix` command that closes it
  3. Diff impact  — only present when --diff was given; lists impacted cases
                    with `BROKEN xN` flags

Modes:

  python -m qa_ui_auto.audit                     # full project diagnostic
  python -m qa_ui_auto.audit --feature F1.6      # focus on one feature
  python -m qa_ui_auto.audit --diff              # include diff vs origin/main
  python -m qa_ui_auto.audit --diff origin/main  # explicit base
  python -m qa_ui_auto.audit --gate              # CI mode: exit 1 on regression
  python -m qa_ui_auto.audit --json              # machine-readable

Exit codes:
  0 — clean (or non-gate run with surfaced gaps; surfacing gaps isn't failure)
  1 — gate failed (regression vs baseline) OR lint errors
  2 — setup error (missing files, malformed YAML, etc.)
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.feature_catalog import load_features  # noqa: E402
from qa_ui_auto.lint import (  # noqa: E402
    lint_cases, lint_features, warn_selector_orphans,
)
from qa_ui_auto.coverage_report import build_matrix, summary as cov_summary  # noqa: E402
from qa_ui_auto.control_coverage import (  # noqa: E402
    build_coverage, _build_snapshot, _render_gate_diff,
)
from qa_ui_auto.diff_impact import analyze as diff_analyze, _git_diff_names, _normalize  # noqa: E402
from qa_ui_auto.gen_testid_catalog import render as render_catalog  # noqa: E402

DEFAULT_FEATURES = Path("qa-ui-auto-tests/feature-list.md")
DEFAULT_CASES = Path("qa-ui-auto-tests/cases")
DEFAULT_BASELINE = Path("qa-ui-auto-tests/coverage-baseline.json")
DEFAULT_CATALOG = Path(".agents/skills/qa-ui-auto/references/testid-catalog.md")


@dataclass
class Gap:
    """One actionable item the agent should address.

    `priority`: lower is more urgent. We bucket as
        10 — feature has zero cases (uncovered)
        20 — required control with no case touching its selector at all
        30 — required interactive control covered only by display verbs (shallow)
        40 — case selector that doesn't match any feature.controls (orphan)
        50 — feature.controls undeclared (informational; current backlog)
    """
    priority: int
    feature_id: str
    feature_title: str
    kind: str            # uncovered | missing-control | shallow | orphan | undeclared
    detail: str          # one-line human description
    fix_command: str     # exact CLI to run next

    def as_dict(self) -> dict[str, Any]:
        return {
            "priority": self.priority,
            "feature_id": self.feature_id,
            "feature_title": self.feature_title,
            "kind": self.kind,
            "detail": self.detail,
            "fix_command": self.fix_command,
        }


@dataclass
class AuditReport:
    health: dict[str, Any] = field(default_factory=dict)
    gaps: list[Gap] = field(default_factory=list)
    diff: dict[str, Any] | None = None
    gate: dict[str, Any] | None = None     # populated when --gate ran

    def as_dict(self) -> dict[str, Any]:
        return {
            "health": self.health,
            "gaps": [g.as_dict() for g in self.gaps],
            "diff": self.diff,
            "gate": self.gate,
        }


# ---------------------------------------------------------------------------
# Health checks
# ---------------------------------------------------------------------------

def _check_health(
    *, features_path: Path, cases_dir: Path, catalog_path: Path,
) -> dict[str, Any]:
    """Aggregate lint + catalog freshness into one structured report."""
    case_n, case_ids, case_errors = lint_cases(cases_dir)
    feat_errors, feat_stats = lint_features(features_path)
    orphans = warn_selector_orphans(features_path, cases_dir)
    # Catalog freshness: render expected output, compare to disk.
    catalog_stale = False
    catalog_reason: str | None = None
    try:
        feats = load_features(features_path)
        expected = render_catalog(feats)
        if not catalog_path.exists():
            catalog_stale = True
            catalog_reason = "file does not exist"
        elif catalog_path.read_text(encoding="utf-8") != expected:
            catalog_stale = True
            catalog_reason = "content differs from feature.controls"
    except Exception as e:  # noqa: BLE001
        catalog_stale = True
        catalog_reason = f"check failed: {e}"
    return {
        "lint_cases": {
            "files": case_n,
            "unique_ids": case_ids,
            "errors": case_errors,
        },
        "lint_features": {
            "stats": feat_stats,
            "errors": feat_errors,
        },
        "orphan_count": len(orphans),
        "orphan_sample": orphans[:5],
        "catalog_stale": catalog_stale,
        "catalog_reason": catalog_reason,
    }


# ---------------------------------------------------------------------------
# Gap collection
# ---------------------------------------------------------------------------

def _collect_gaps(
    *, features_path: Path, cases_dir: Path, focus_feature: str | None,
) -> list[Gap]:
    rows = build_matrix(features_path, cases_dir)
    ctrl_results, _orphans = build_coverage(features_path, cases_dir)
    ctrl_by_fid = {r.feature.id: r for r in ctrl_results}
    feats_by_fid = {f.id: f for f in load_features(features_path)}

    gaps: list[Gap] = []
    for row in rows:
        if focus_feature and row.id != focus_feature:
            continue
        if not row.covered:
            gaps.append(Gap(
                priority=10,
                feature_id=row.id,
                feature_title=row.title,
                kind="uncovered",
                detail=f"no testcase references this feature",
                fix_command=f"fix tests {row.id}",
            ))
            # Don't also enumerate every uncovered control — the whole
            # feature is one big gap. Drafting a case will populate them.
            continue
        cc = ctrl_by_fid.get(row.id)
        if cc is None:
            # Feature didn't declare a controls block. Surface only when the
            # user is focusing on a single feature; otherwise it's noise.
            feat = feats_by_fid.get(row.id)
            if focus_feature and feat is not None and not feat.controls_declared:
                gaps.append(Gap(
                    priority=50,
                    feature_id=row.id,
                    feature_title=row.title,
                    kind="undeclared",
                    detail="feature has no `controls:` block — UI surface unclassified",
                    fix_command=f"fix controls {row.id}",
                ))
            continue
        for ctrl_cov in cc.controls:
            ctrl = ctrl_cov.control
            if ctrl.optional:
                continue
            if not ctrl_cov.covered:
                gaps.append(Gap(
                    priority=20,
                    feature_id=row.id,
                    feature_title=row.title,
                    kind="missing-control",
                    detail=f"required control `{ctrl.id}` ({ctrl.kind}) untouched: {ctrl.selector}",
                    fix_command=f"fix tests {row.id}",
                ))
            elif ctrl_cov.shallow:
                gaps.append(Gap(
                    priority=30,
                    feature_id=row.id,
                    feature_title=row.title,
                    kind="shallow",
                    detail=f"interactive control `{ctrl.id}` only display-touched: {ctrl.selector}",
                    fix_command=f"fix tests {row.id}",
                ))
    gaps.sort(key=lambda g: (g.priority, g.feature_id))
    return gaps


def _collect_orphan_gaps(
    *, features_path: Path, cases_dir: Path, focus_feature: str | None,
) -> list[Gap]:
    """Orphan selectors live alongside other gaps but at lower priority.

    We surface them only when no focus_feature is set, to keep --feature
    output focused. Each orphan recommends `fix controls` because the cure
    is almost always declaring the selector on its owning feature."""
    if focus_feature:
        return []
    orphans = warn_selector_orphans(features_path, cases_dir)
    return [
        Gap(
            priority=40,
            feature_id="-",
            feature_title="(orphan selector)",
            kind="orphan",
            detail=line,
            fix_command="fix controls <owning-feature>",
        )
        for line in orphans
    ]


# ---------------------------------------------------------------------------
# Diff section
# ---------------------------------------------------------------------------

def _detect_base() -> str | None:
    import subprocess
    for candidate in ("origin/main", "main", "HEAD~1"):
        try:
            subprocess.check_output(
                ["git", "rev-parse", "--verify", candidate],
                stderr=subprocess.DEVNULL,
            )
            return candidate
        except subprocess.CalledProcessError:
            continue
    return None


def _diff_section(
    base: str | None, *, features_path: Path, cases_dir: Path,
) -> dict[str, Any]:
    if base is None:
        base = _detect_base()
    if base is None:
        return {"error": "could not auto-detect a git base; pass --diff <REF>"}
    try:
        changed = _git_diff_names(base, include_uncommitted=True)
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    feat_hits, case_hits = diff_analyze(
        changed, features_path=features_path, cases_dir=cases_dir,
    )
    broken_cases = [c for c in case_hits if c.broken_selectors]
    return {
        "base": base,
        "changed_file_count": len(changed),
        "impacted_features": [
            {
                "id": f.id,
                "title": f.title,
                "added": f.delta.added if f.delta else [],
                "removed": f.delta.removed if f.delta else [],
            }
            for f in feat_hits
        ],
        "impacted_cases": [
            {
                "id": c.id,
                "broken_selectors": c.broken_selectors,
                "via_features": c.via_features,
                "yaml_changed": c.yaml_changed,
            }
            for c in case_hits
        ],
        "broken_count": len(broken_cases),
        "fix_command": (
            "fix tests --diff" if broken_cases or feat_hits else None
        ),
    }


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------

def _gate(
    *, features_path: Path, cases_dir: Path, baseline_path: Path,
) -> dict[str, Any]:
    """Compare current snapshot against baseline. Returns dict with regs/imps."""
    if not baseline_path.exists():
        return {
            "ok": False,
            "error": f"baseline missing: {baseline_path}",
            "hint": (
                f"bootstrap with: python -m qa_ui_auto.control_coverage "
                f"--update-baseline {baseline_path}"
            ),
        }
    try:
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"baseline parse: {e}"}
    results, orphans = build_coverage(features_path, cases_dir)
    snap = _build_snapshot(results, orphans)
    regressions, improvements = _render_gate_diff(baseline, snap)
    return {
        "ok": not regressions,
        "baseline_path": str(baseline_path),
        "baseline": baseline.get("totals", {}),
        "current": snap["totals"],
        "regressions": regressions,
        "improvements": improvements,
    }


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------

def build_audit(
    *,
    features_path: Path = DEFAULT_FEATURES,
    cases_dir: Path = DEFAULT_CASES,
    catalog_path: Path = DEFAULT_CATALOG,
    baseline_path: Path | None = None,
    focus_feature: str | None = None,
    diff_base: str | None | object = None,   # None = skip; True/str = run
) -> AuditReport:
    rep = AuditReport()
    rep.health = _check_health(
        features_path=features_path,
        cases_dir=cases_dir,
        catalog_path=catalog_path,
    )
    rep.gaps = _collect_gaps(
        features_path=features_path,
        cases_dir=cases_dir,
        focus_feature=focus_feature,
    ) + _collect_orphan_gaps(
        features_path=features_path,
        cases_dir=cases_dir,
        focus_feature=focus_feature,
    )
    if diff_base is not None and diff_base is not False:
        base_arg = diff_base if isinstance(diff_base, str) else None
        rep.diff = _diff_section(
            base_arg, features_path=features_path, cases_dir=cases_dir,
        )
    if baseline_path is not None:
        rep.gate = _gate(
            features_path=features_path,
            cases_dir=cases_dir,
            baseline_path=baseline_path,
        )
    return rep


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _render_health(h: dict[str, Any]) -> list[str]:
    lines = ["## Health"]
    fc = h["lint_features"]["stats"]
    cc = h["lint_cases"]
    lines.append(
        f"  cases:    {cc['files']} files, {cc['unique_ids']} unique ids, "
        f"{len(cc['errors'])} error(s)"
    )
    if fc:
        lines.append(
            f"  features: {fc['features']} entries — "
            f"{fc['features_with_controls']} filled / "
            f"{fc['features_explicitly_empty']} backend-only / "
            f"{fc['features_undeclared']} undeclared "
            f"({fc['controls']} controls: "
            f"{fc['interactive']} interactive, "
            f"{fc['display']} display, "
            f"{fc['optional']} optional)"
        )
    lines.append(f"  orphans:  {h['orphan_count']} selector(s) used by cases not in any feature.controls")
    if h["catalog_stale"]:
        lines.append(f"  catalog:  STALE ({h['catalog_reason']}) — run `fix catalog`")
    else:
        lines.append("  catalog:  up to date")
    if h["lint_cases"]["errors"] or h["lint_features"]["errors"]:
        lines.append("")
        lines.append("  ! lint errors:")
        for e in h["lint_cases"]["errors"] + h["lint_features"]["errors"]:
            lines.append(f"    - {e}")
    return lines


def _render_gaps(gaps: list[Gap], focus_feature: str | None) -> list[str]:
    lines = ["", "## Gaps"]
    if not gaps:
        lines.append("  (no actionable gaps)" if focus_feature else "  (none)")
        return lines
    # Group by priority bucket for readability.
    buckets = {
        10: ("Uncovered features", "no testcase at all"),
        20: ("Missing required controls", "control not touched by any case"),
        30: ("Shallow controls", "interactive control only display-touched"),
        40: ("Orphan selectors", "case selector not in any feature.controls"),
        50: ("Undeclared features", "no controls block yet"),
    }
    by_prio: dict[int, list[Gap]] = {}
    for g in gaps:
        by_prio.setdefault(g.priority, []).append(g)
    for prio in sorted(by_prio):
        title, hint = buckets.get(prio, (f"priority {prio}", ""))
        rows = by_prio[prio]
        lines.append("")
        lines.append(f"  ── {title} ({len(rows)}) — {hint}")
        for g in rows[:30]:
            head = (
                f"    [{g.feature_id:<5}] {g.feature_title}"
                if g.feature_id != "-" else f"    [orphan]"
            )
            lines.append(head)
            lines.append(f"        {g.detail}")
            lines.append(f"        → {g.fix_command}")
        if len(rows) > 30:
            lines.append(f"    ... and {len(rows) - 30} more (use --json for the full list)")
    return lines


def _render_diff(d: dict[str, Any]) -> list[str]:
    lines = ["", "## Diff impact"]
    if "error" in d:
        lines.append(f"  ! {d['error']}")
        return lines
    lines.append(f"  base: {d['base']}, {d['changed_file_count']} changed file(s)")
    if not d["impacted_features"]:
        lines.append("  (change does not touch any feature's `files`)")
        return lines
    for f in d["impacted_features"]:
        lines.append(f"  • {f['id']}  {f['title']}")
        if f["added"]:
            lines.append(f"      added: {len(f['added'])} testid/aria → run `fix controls {f['id']}`")
        if f["removed"]:
            lines.append(f"      REMOVED: {', '.join(f['removed'])}")
    if d["broken_count"]:
        lines.append("")
        lines.append(f"  Broken cases ({d['broken_count']}):")
        for c in d["impacted_cases"]:
            if c["broken_selectors"]:
                lines.append(f"    {c['id']} touches: {', '.join(c['broken_selectors'])}")
        lines.append(f"  → fix tests --diff {d['base']}")
    elif d.get("fix_command"):
        lines.append(f"  → {d['fix_command']}")
    return lines


def _render_gate(g: dict[str, Any]) -> list[str]:
    lines = ["", "## Gate"]
    if "error" in g:
        lines.append(f"  ! {g['error']}")
        if "hint" in g:
            lines.append(f"  hint: {g['hint']}")
        return lines
    bt = g["baseline"]
    ct = g["current"]
    lines.append(f"  baseline: {g['baseline_path']}")
    lines.append(
        f"  required:        {bt.get('required', '?')} → {ct.get('required', '?')}"
    )
    lines.append(
        f"  covered_required:{bt.get('covered_required', '?')} → {ct.get('covered_required', '?')}"
    )
    lines.append(
        f"  shallow:         {bt.get('shallow', '?')} → {ct.get('shallow', '?')}"
    )
    lines.append(
        f"  orphans:         {bt.get('orphans', '?')} → {ct.get('orphans', '?')}"
    )
    if g["improvements"]:
        lines.append("")
        lines.append(f"  improvements ({len(g['improvements'])}):")
        for line in g["improvements"][:10]:
            lines.append(f"    + {line}")
    if g["regressions"]:
        lines.append("")
        lines.append(f"  REGRESSIONS ({len(g['regressions'])}):")
        for line in g["regressions"]:
            lines.append(f"    - {line}")
        lines.append("")
        lines.append(
            "  Either fix the regression or, if the change is intentional, "
            "ratchet the baseline:"
        )
        lines.append(
            f"    python -m qa_ui_auto.control_coverage --update-baseline "
            f"{g['baseline_path']}"
        )
    else:
        lines.append("  OK — no regressions vs baseline")
    return lines


def render_text(rep: AuditReport, *, focus_feature: str | None = None) -> str:
    out: list[str] = ["# qa-ui-auto audit"]
    if focus_feature:
        out.append(f"  focus: {focus_feature}")
    out.append("")
    out.extend(_render_health(rep.health))
    out.extend(_render_gaps(rep.gaps, focus_feature))
    if rep.diff is not None:
        out.extend(_render_diff(rep.diff))
    if rep.gate is not None:
        out.extend(_render_gate(rep.gate))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.audit")
    ap.add_argument("--features", default=str(DEFAULT_FEATURES))
    ap.add_argument("--cases", default=str(DEFAULT_CASES))
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    ap.add_argument("--feature", default=None,
                    help="focus on one feature ID (e.g. F1.6)")
    ap.add_argument("--diff", nargs="?", const=True, default=None,
                    help="include diff vs git base; pass a ref to override "
                         "auto-detect (origin/main → main → HEAD~1)")
    ap.add_argument("--gate", nargs="?", const=str(DEFAULT_BASELINE),
                    default=None,
                    help="compare against a coverage baseline; exit 1 on "
                         "regression. Omit value to use default baseline path.")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    rep = build_audit(
        features_path=Path(args.features),
        cases_dir=Path(args.cases),
        catalog_path=Path(args.catalog),
        baseline_path=Path(args.gate) if args.gate else None,
        focus_feature=args.feature,
        diff_base=args.diff,
    )

    if args.json:
        print(json.dumps(rep.as_dict(), indent=2, ensure_ascii=False))
    else:
        print(render_text(rep, focus_feature=args.feature))

    # Exit code policy:
    #   0 — clean run
    #   1 — lint errors OR (gate enabled AND regression OR catalog stale)
    #   2 — setup error (e.g. missing baseline when --gate set)
    if rep.gate and "error" in rep.gate:
        return 2
    if (rep.health["lint_cases"]["errors"]
            or rep.health["lint_features"]["errors"]):
        return 1
    if rep.gate is not None:
        # Strict CI mode: also fail on stale catalog or regressions.
        if not rep.gate["ok"]:
            return 1
        if rep.health["catalog_stale"]:
            print(
                "\n[gate] testid-catalog stale — run "
                "`python -m qa_ui_auto.gen_testid_catalog`",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
