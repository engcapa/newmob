#!/usr/bin/env python3
"""Control-level coverage analyzer.

Walks every testcase in `qa-ui-auto-tests/cases/**/*.testcase.yaml`, extracts
the selector / text / aria-label literals each step touches, and compares
them against `controls:` blocks in feature-list.md.

For every feature with a `controls:` block, classify each control as:
  - covered_interactive: at least one case touches it via an interactive verb
                         (click, fill, press, select_option, ...).
  - covered_display:     at least one case touches it via a display verb
                         (wait_for, assert_visible, assert_text, screenshot, ...).
  - uncovered:           no case mentions its selector at all.

A control with `kind: interactive` requires at least covered_interactive.
A control with `kind: display` requires at least covered_display.
`optional: true` controls are reported separately (informational gap).

Selector matching has two stages:

1. **Exact match** on the normalized form. Quote style is folded so that
   `[k='v']` and `[k="v"]` are equal; otherwise selectors are compared
   verbatim.
2. **Derivation match** when no exact entry hits. A case selector counts as
   touching the control whose declared selector it starts with — provided
   the next character is a CSS boundary (`[`, ` `, `:`, `>`, `,`). This
   handles common refinements that don't deserve their own control entry:
     - attribute filter:    `[tid="row"][data-name="X"]`
     - descendant chain:    `[tid="pane"] button[title="…"]`
     - Playwright pipe:     `[tid="menu"] >> text=…`
     - has-text predicate:  `[tid="row"]:has-text("…")`
   Longest matching control wins, so a case targeting a more specific
   container is attributed to that container, not its parent.

`aliases` on a control let multiple stable selector forms point to the same
DOM element — both the base selector and every alias participate in the
match. Use this when an item is reachable by both a `text="…"` literal and a
generated `[data-testid="…"]`. Coverage attribution still rolls up to the
control id, not to a specific selector form.

Usage:
  python -m qa_ui_auto.control_coverage                   # full text report
  python -m qa_ui_auto.control_coverage --feature F1.6    # one feature
  python -m qa_ui_auto.control_coverage --json            # machine-readable
  python -m qa_ui_auto.control_coverage --orphans         # selectors used by
                                                          # cases but not in
                                                          # any feature.controls
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

from qa_ui_auto.feature_catalog import load_features, Feature, Control  # noqa: E402
from qa_ui_auto.testcase import discover, step_verb_and_args  # noqa: E402


INTERACTIVE_VERBS = {
    "click", "dblclick", "right_click", "hover", "drag_to",
    "fill", "type", "send_keys", "press", "select_option", "upload_file",
    "set_check", "send_text_via_label", "open_session", "click_menu",
    "quick_connect", "auth", "attach_sftp", "set_remote_path",
}
DISPLAY_VERBS = {
    "wait_for", "assert_visible", "assert_not_visible", "assert_text",
    "assert_pattern", "assert_count", "assert_attribute", "assert_disabled",
    "assert_enabled", "screenshot", "assert_menu_items",
}
SELECTOR_KEYS = {"selector", "from", "to", "path"}   # path is for screenshot fname; filtered below


@dataclass
class Touch:
    """One (selector, kind, case_id) tuple — case touched selector via verb."""
    case_id: str
    selector: str
    kind: str   # "interactive" | "display"


def _normalize_selector(s: str) -> str:
    """Make two literally-equivalent selectors compare equal.

    Conservative: strip outer whitespace and convert single ↔ double quotes
    only when they wrap the *whole* attribute value. We do NOT lowercase
    or restructure CSS — that's beyond static comparison. We DO add quotes
    around bare `text=Word`-style locators so they compare equal to
    `text="Word"` — Playwright accepts both forms.
    """
    s = s.strip()
    # Symmetric quote swap: `[k="v"]` and `[k='v']` should compare equal.
    # Only swap when the string contains exactly one quote style.
    if '"' in s and "'" not in s:
        s_alt = s.replace('"', "'")
    elif "'" in s and '"' not in s:
        s_alt = s.replace("'", '"')
    else:
        s_alt = s
    # Canonicalize toward double quotes for comparison.
    s_alt = s_alt.replace("'", '"')
    # Quote bare `text=Word` / `text=Word with spaces` to match `text="Word…"`
    # form that authors typically write.
    if s_alt.startswith("text=") and not s_alt.startswith('text="'):
        s_alt = 'text="' + s_alt[len("text="):] + '"'
    return s_alt


# Boundary characters that mean a case selector is *deriving* from a control
# selector rather than naming a different element. If `case[len(control):0]`
# starts with one of these, the case is targeting a refined version of the
# control (an instance of session-tree-item, a child node inside sftp-pane,
# a Playwright pipe operator, etc.) and should count as touching the control.
#
#   "[data-testid='session-tree-item'][data-session-name='X']"  → '[' boundary
#   "[data-testid='sftp-remote-pane'] >> text='qa-ui-auto-x'"   → ' >>' boundary
#   "[data-testid='menu-bar'] button:has-text('Sessions')"      → ' '  boundary
#   "[data-testid='sftp-pane']:has-text('foo')"                 → ':'  boundary
#
# Bare `text=...` or `button[...]` selectors (no leading control selector) do
# NOT match — those are real orphans, surfaced to recommend adding a testid.
_DERIVATION_BOUNDARY = (" ", "[", ":", ">", ",", "\t", "\n")


def _is_derived_match(case_sel: str, control_sel: str) -> bool:
    """True if `case_sel` is the same element as `control_sel` plus refinement.

    Both selectors are pre-normalized. We require:
      - case_sel starts with control_sel (literal prefix)
      - the next character is a known boundary (so we don't match
        `[data-testid="sftp-x"]` as a prefix of `[data-testid="sftp-xyz"]`)
    """
    if case_sel == control_sel:
        return True
    if not case_sel.startswith(control_sel):
        return False
    # Guard against false-prefix matches like
    #   control: '[data-testid="sftp"]'
    #   case:    '[data-testid="sftp-remote-pane"]'
    # Inside a `[k="v"]`, the next character after the closing `]` is
    # always one of the boundary chars below.
    return case_sel[len(control_sel):][:1] in _DERIVATION_BOUNDARY


def _selectors_in_step(verb: str, args: Any) -> list[str]:
    """Return the literal selector strings this step touches.

    Returns selector strings WITHOUT the kind tagging — caller maps verb→kind.
    `screenshot` only touches a selector when given the `selector:` key in
    rich form; the path key is a filename and must NOT be reported.
    """
    out: list[str] = []
    # Short form: `click: '[data-testid="x"]'` → args is a string.
    if isinstance(args, str):
        # `type`/`send_keys`/`press` short-forms take a literal string that is
        # NOT a selector — it's typed text or a key chord. Excluding here keeps
        # orphan reporting honest.
        if verb in ("click", "dblclick", "right_click", "hover",
                    "wait_for", "assert_visible", "assert_not_visible",
                    "assert_disabled", "assert_enabled"):
            out.append(args)
        return out
    if not isinstance(args, dict):
        return out
    # Rich form: pluck known selector-bearing keys.
    if "selector" in args and isinstance(args["selector"], str):
        # `screenshot: {path: ..., selector: ...}` is OK; selector here means
        # screenshot-of-element, which we count as a display touch.
        out.append(args["selector"])
    if verb == "drag_to":
        for k in ("from", "to"):
            v = args.get(k)
            if isinstance(v, str):
                out.append(v)
    if verb == "press":
        # press: {key: ..., selector?: ...}
        sel = args.get("selector")
        if isinstance(sel, str):
            out.append(sel)
    return out


def _touches_for_case(case) -> list[Touch]:  # case: TestCase
    out: list[Touch] = []
    for step in case.steps:
        if not isinstance(step, dict) or len(step) != 1:
            continue
        verb, args = step_verb_and_args(step)
        if verb in INTERACTIVE_VERBS:
            kind = "interactive"
        elif verb in DISPLAY_VERBS:
            kind = "display"
        else:
            # navigation / setup / escape-hatch verbs don't bind to controls
            continue
        for sel in _selectors_in_step(verb, args):
            out.append(Touch(case_id=case.id, selector=sel, kind=kind))
    return out


@dataclass
class ControlCoverage:
    control: Control
    interactive_cases: list[str] = field(default_factory=list)
    display_cases: list[str] = field(default_factory=list)

    @property
    def covered(self) -> bool:
        if self.control.kind == "interactive":
            return bool(self.interactive_cases)
        return bool(self.interactive_cases or self.display_cases)

    @property
    def shallow(self) -> bool:
        """Display-only cases on an interactive control = shallow coverage."""
        return (
            self.control.kind == "interactive"
            and not self.interactive_cases
            and bool(self.display_cases)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.control.id,
            "selector": self.control.selector,
            "kind": self.control.kind,
            "optional": self.control.optional,
            "covered": self.covered,
            "shallow": self.shallow,
            "interactive_cases": self.interactive_cases,
            "display_cases": self.display_cases,
        }


@dataclass
class FeatureCoverage:
    feature: Feature
    controls: list[ControlCoverage] = field(default_factory=list)

    @property
    def has_controls(self) -> bool:
        return bool(self.feature.controls)

    @property
    def total(self) -> int:
        return len(self.controls)

    @property
    def covered_required(self) -> int:
        return sum(
            1 for c in self.controls
            if c.covered and not c.control.optional
        )

    @property
    def total_required(self) -> int:
        return sum(1 for c in self.controls if not c.control.optional)

    @property
    def shallow_count(self) -> int:
        return sum(1 for c in self.controls if c.shallow)

    @property
    def coverage_pct(self) -> float:
        if self.total_required == 0:
            return 100.0
        return round(100 * self.covered_required / self.total_required, 1)


def build_coverage(
    features_path: Path = Path("qa-ui-auto-tests/feature-list.md"),
    cases_dir: Path = Path("qa-ui-auto-tests/cases"),
) -> tuple[list[FeatureCoverage], list[str]]:
    """Compute (per-feature coverage, orphan-selectors-from-cases).

    An orphan selector is any selector literal a case touches that doesn't
    match ANY control in feature-list.md. Orphans are a strong signal the
    case is using a selector that should be promoted to a control entry, OR
    the test is reaching into UI not yet documented as a feature.
    """
    feats = load_features(features_path)
    cases = discover(cases_dir)

    # Per-feature normalized selector index. Each entry is
    #   (normalized_selector, feature_id, control_id)
    # We keep a flat list (not a dict) because matching is now PREFIX-aware,
    # not exact: a case selector like
    #   '[data-testid="session-tree-item"][data-session-name="X"]'
    # should match the control whose selector is
    #   '[data-testid="session-tree-item"]'
    # so we walk all entries and pick the BEST (longest) prefix match.
    # `aliases` flatten alongside the base selector — they share the same
    # (feature, control) destination.
    catalog: list[tuple[str, str, str]] = []
    for f in feats:
        for c in f.controls:
            for sel in c.all_selectors():
                catalog.append((_normalize_selector(sel), f.id, c.id))
    # Sort by selector length descending so the first matching entry is the
    # most specific one (longest prefix wins). Ties in length stay in source
    # order, which is deterministic across runs.
    catalog.sort(key=lambda e: -len(e[0]))

    # Tally touches.
    interactive_hits: dict[tuple[str, str], list[str]] = {}
    display_hits: dict[tuple[str, str], list[str]] = {}
    orphans: dict[str, list[str]] = {}   # selector → [case_id, ...]

    for case in cases:
        for t in _touches_for_case(case):
            key = _normalize_selector(t.selector)
            # First try exact match (still wins; preserves prior behaviour
            # for cases that copied a selector verbatim).
            matched: tuple[str, str] | None = None
            for ctrl_sel, fid, cid in catalog:
                if ctrl_sel == key:
                    matched = (fid, cid)
                    break
            if matched is None:
                # Fall back to derivation: case selector starts with control
                # selector + a CSS boundary character. This catches
                #   [tid="row"][data-x="y"]   (attribute filter)
                #   [tid="pane"] >> text=...  (Playwright pipe)
                #   [tid="bar"] button:has(.) (descendant)
                # without false-matching `[tid="x"]` to `[tid="xyz"]`.
                for ctrl_sel, fid, cid in catalog:
                    if _is_derived_match(key, ctrl_sel):
                        matched = (fid, cid)
                        break
            if matched is None:
                orphans.setdefault(t.selector, []).append(case.id)
                continue
            fid, cid = matched
            bucket = interactive_hits if t.kind == "interactive" else display_hits
            bucket.setdefault((fid, cid), []).append(case.id)

    # Assemble FeatureCoverage rows.
    results: list[FeatureCoverage] = []
    for f in feats:
        if not f.controls:
            continue
        rows: list[ControlCoverage] = []
        for c in f.controls:
            row = ControlCoverage(control=c)
            row.interactive_cases = sorted(set(
                interactive_hits.get((f.id, c.id), [])
            ))
            row.display_cases = sorted(set(
                display_hits.get((f.id, c.id), [])
            ))
            rows.append(row)
        results.append(FeatureCoverage(feature=f, controls=rows))

    # Filter orphans: dedupe case lists.
    orphans_clean = sorted(
        ((sel, sorted(set(cs))) for sel, cs in orphans.items()),
        key=lambda x: x[0],
    )
    orphan_lines = [f"{sel}    (cases: {', '.join(cs)})" for sel, cs in orphans_clean]
    return results, orphan_lines


def render_text(results: list[FeatureCoverage]) -> str:
    if not results:
        return "no features have a `controls:` block yet."
    out: list[str] = []
    total_ctrls = sum(r.total for r in results)
    total_required = sum(r.total_required for r in results)
    total_covered = sum(r.covered_required for r in results)
    total_shallow = sum(r.shallow_count for r in results)
    pct = round(100 * total_covered / total_required, 1) if total_required else 0.0
    out.append(
        f"control coverage: {total_covered}/{total_required} required "
        f"({pct}%) across {len(results)} feature(s) with controls; "
        f"{total_shallow} shallow"
    )
    out.append("")

    for r in results:
        out.append(f"== {r.feature.id} {r.feature.title}  "
                   f"({r.covered_required}/{r.total_required} required, "
                   f"{r.coverage_pct}%)")
        for cc in r.controls:
            tag = cc.control.kind
            if cc.control.optional:
                tag += " optional"
            if cc.covered:
                if cc.shallow:
                    mark = "~"
                    detail = (f"display-only: {', '.join(cc.display_cases)}")
                else:
                    mark = "✓"
                    cases = cc.interactive_cases or cc.display_cases
                    detail = ", ".join(cases)
            else:
                mark = "✗"
                detail = "(no case touches this selector)"
            out.append(f"  {mark} {cc.control.id:<28} [{tag:<22}] {cc.control.selector}")
            out.append(f"      → {detail}")
        out.append("")
    return "\n".join(out)


def render_feature_detail(r: FeatureCoverage) -> str:
    out = [
        f"Feature: {r.feature.id} — {r.feature.title}",
        f"  controls: {r.total} (required: {r.total_required}, "
        f"covered required: {r.covered_required}, shallow: {r.shallow_count})",
        f"  coverage: {r.coverage_pct}%",
        "",
    ]
    for cc in r.controls:
        out.append(f"  - {cc.control.id} [{cc.control.kind}"
                   f"{', optional' if cc.control.optional else ''}]")
        out.append(f"      selector: {cc.control.selector}")
        out.append(f"      interactive_cases: {', '.join(cc.interactive_cases) or '(none)'}")
        out.append(f"      display_cases:     {', '.join(cc.display_cases) or '(none)'}")
        if cc.shallow:
            out.append("      ⚠ shallow: only display-level coverage on an interactive control")
        if not cc.covered and not cc.control.optional:
            out.append("      ✗ uncovered (required)")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Coverage gate: ratchet against a baseline JSON file.
# ---------------------------------------------------------------------------

def _build_snapshot(
    results: list[FeatureCoverage], orphans: list[str]
) -> dict[str, Any]:
    """Compact, comparable view of current coverage state.

    Per-feature numbers are kept so the gate can pinpoint which feature
    regressed. Globals are derived totals — they exist for fast top-line
    comparison and as a sanity check on the per-feature roll-up.
    """
    features: dict[str, dict[str, int]] = {}
    for r in results:
        features[r.feature.id] = {
            "required": r.total_required,
            "covered_required": r.covered_required,
            "shallow": r.shallow_count,
        }
    total_required = sum(f["required"] for f in features.values())
    total_covered = sum(f["covered_required"] for f in features.values())
    total_shallow = sum(f["shallow"] for f in features.values())
    return {
        "version": 1,
        "totals": {
            "features_with_controls": len(features),
            "required": total_required,
            "covered_required": total_covered,
            "shallow": total_shallow,
            "orphans": len(orphans),
        },
        "features": features,
    }


def _render_gate_diff(baseline: dict[str, Any], current: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Compare baseline to current. Returns (regressions, improvements).

    Each entry is a human-readable line. Regressions are anything strictly
    worse than baseline (covered_required ↓, shallow ↑, orphans ↑, OR a
    new uncovered required control on a feature that was fully covered).
    """
    regressions: list[str] = []
    improvements: list[str] = []
    bt = baseline.get("totals", {})
    ct = current["totals"]
    if ct["covered_required"] < bt.get("covered_required", 0):
        regressions.append(
            f"global covered_required regressed: {bt['covered_required']} → "
            f"{ct['covered_required']} (Δ {ct['covered_required'] - bt['covered_required']})"
        )
    elif ct["covered_required"] > bt.get("covered_required", 0):
        improvements.append(
            f"global covered_required improved: {bt.get('covered_required', 0)} → "
            f"{ct['covered_required']}"
        )
    if ct["shallow"] > bt.get("shallow", 0):
        regressions.append(
            f"global shallow grew: {bt['shallow']} → {ct['shallow']} "
            f"(Δ +{ct['shallow'] - bt['shallow']})"
        )
    elif ct["shallow"] < bt.get("shallow", 0):
        improvements.append(
            f"global shallow shrank: {bt.get('shallow', 0)} → {ct['shallow']}"
        )
    if ct["orphans"] > bt.get("orphans", 0):
        regressions.append(
            f"global orphans grew: {bt['orphans']} → {ct['orphans']} "
            f"(Δ +{ct['orphans'] - bt['orphans']})"
        )
    elif ct["orphans"] < bt.get("orphans", 0):
        improvements.append(
            f"global orphans shrank: {bt.get('orphans', 0)} → {ct['orphans']}"
        )
    # Per-feature checks. New features in current that weren't in baseline
    # don't fail the gate (they can only help). Features removed from
    # current also pass (caller may have intentionally collapsed feature).
    for fid, cur_f in current["features"].items():
        base_f = baseline.get("features", {}).get(fid)
        if not base_f:
            improvements.append(f"new feature with controls: {fid} "
                                f"({cur_f['covered_required']}/{cur_f['required']})")
            continue
        if cur_f["covered_required"] < base_f["covered_required"]:
            regressions.append(
                f"{fid}: covered_required {base_f['covered_required']} → "
                f"{cur_f['covered_required']}"
            )
        if cur_f["shallow"] > base_f["shallow"]:
            regressions.append(
                f"{fid}: shallow {base_f['shallow']} → {cur_f['shallow']}"
            )
    return regressions, improvements


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.control_coverage")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases")
    ap.add_argument("--feature", default=None)
    ap.add_argument("--orphans", action="store_true",
                    help="list selectors used by cases that don't match any "
                         "feature.controls entry")
    ap.add_argument("--gate", default=None,
                    help="compare current coverage against the baseline JSON "
                         "at this path. Exit 1 if any required-control count "
                         "regressed, shallow grew, or orphan count grew.")
    ap.add_argument("--update-baseline", default=None,
                    help="write the current coverage snapshot to this path "
                         "(overwrites). Use to ratchet up after legitimate "
                         "improvements. Refuses to write a baseline that "
                         "would regress an existing one — pair with --force.")
    ap.add_argument("--force", action="store_true",
                    help="allow --update-baseline to write a snapshot worse "
                         "than the existing one. Only for legitimate scope "
                         "reductions, e.g. removing a feature.")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    results, orphans = build_coverage(Path(args.features), Path(args.cases))

    if args.feature:
        match = next((r for r in results if r.feature.id == args.feature), None)
        if not match:
            print(f"feature has no controls block (or unknown id): {args.feature}",
                  file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps({
                "id": match.feature.id,
                "title": match.feature.title,
                "coverage_pct": match.coverage_pct,
                "controls": [c.as_dict() for c in match.controls],
            }, indent=2, ensure_ascii=False))
        else:
            print(render_feature_detail(match))
        return 0

    if args.orphans:
        if args.json:
            print(json.dumps({"orphans": orphans}, indent=2, ensure_ascii=False))
        else:
            print(f"orphan selectors ({len(orphans)}):")
            for line in orphans:
                print(f"  {line}")
        return 0

    if args.update_baseline:
        snap = _build_snapshot(results, orphans)
        target = Path(args.update_baseline)
        if target.exists() and not args.force:
            try:
                old = json.loads(target.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                old = None
            if old:
                regs, _ = _render_gate_diff(old, snap)
                if regs:
                    print(
                        f"refuse to write baseline {target}: would regress vs "
                        f"existing baseline ({len(regs)} regression(s)). "
                        f"Pass --force if this is intentional.",
                        file=sys.stderr,
                    )
                    for line in regs[:20]:
                        print(f"  - {line}", file=sys.stderr)
                    return 2
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(snap, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(
            f"wrote baseline → {target}: "
            f"{snap['totals']['covered_required']}/{snap['totals']['required']} "
            f"required, {snap['totals']['shallow']} shallow, "
            f"{snap['totals']['orphans']} orphans"
        )
        return 0

    if args.gate:
        path = Path(args.gate)
        if not path.exists():
            print(
                f"gate baseline not found: {path}. "
                "Bootstrap one with `--update-baseline {path}`.",
                file=sys.stderr,
            )
            return 2
        try:
            baseline = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"gate baseline {path}: parse error: {e}", file=sys.stderr)
            return 2
        snap = _build_snapshot(results, orphans)
        regressions, improvements = _render_gate_diff(baseline, snap)
        if args.json:
            print(json.dumps({
                "baseline_path": str(path),
                "regressions": regressions,
                "improvements": improvements,
                "current": snap["totals"],
                "baseline": baseline.get("totals", {}),
            }, indent=2, ensure_ascii=False))
        else:
            bt = baseline.get("totals", {})
            ct = snap["totals"]
            print(
                f"gate vs {path}:\n"
                f"  required:        {bt.get('required', '?')} → {ct['required']}\n"
                f"  covered_required:{bt.get('covered_required', '?')} → "
                f"{ct['covered_required']}\n"
                f"  shallow:         {bt.get('shallow', '?')} → {ct['shallow']}\n"
                f"  orphans:         {bt.get('orphans', '?')} → {ct['orphans']}"
            )
            if improvements:
                print(f"\nimprovements ({len(improvements)}):")
                for line in improvements[:20]:
                    print(f"  + {line}")
            if regressions:
                print(f"\nregressions ({len(regressions)}):")
                for line in regressions:
                    print(f"  - {line}")
                print(
                    "\nFAILED. Either fix the regression or, if the change is "
                    "intentional (e.g. you split a feature, scoped down a "
                    "control list), update the baseline with "
                    f"`--update-baseline {path}` (use --force if it counts as "
                    "a regression vs the old baseline)."
                )
            else:
                print("\nOK — no regressions vs baseline.")
        return 1 if regressions else 0

    if args.json:
        print(json.dumps({
            "features": [
                {
                    "id": r.feature.id,
                    "title": r.feature.title,
                    "coverage_pct": r.coverage_pct,
                    "covered_required": r.covered_required,
                    "total_required": r.total_required,
                    "shallow": r.shallow_count,
                    "controls": [c.as_dict() for c in r.controls],
                }
                for r in results
            ],
            "orphans": orphans,
        }, indent=2, ensure_ascii=False))
    else:
        print(render_text(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
