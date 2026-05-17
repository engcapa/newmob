#!/usr/bin/env python3
"""qa-ui-auto fix — task-oriented dispatcher for the underlying gen-* tools.

`fix` is the agent-facing way to close a gap surfaced by `audit`. Each
target maps to one of the underlying playbooks; fix pre-fetches the data
the playbook needs and prints a step-by-step plan with concrete commands.

Targets:

  fix tests F1.6                draft a case for F1.6 closing its missing controls
  fix tests --diff [BASE]       patch existing cases broken by an in-progress diff
  fix controls F1.6             populate / update F1.6's `controls:` block
  fix features --range REF      backfill feature-list.md from a commit range
  fix catalog                   regenerate references/testid-catalog.md

The fix command does NOT modify YAML or run network actions on its own. It
prints a numbered playbook and the exact `python -m ...` calls the agent
should make as it works through the gap. The same playbook content lived
inside SKILL.md as `gen-*` step lists; fix surfaces them dynamically with
the relevant data already fetched.

Examples:

  $ qa_ui_auto.fix tests F1.6
    → reads coverage_report --feature F1.6, lists 3 missing controls,
      drafts a case template, suggests selectors

  $ qa_ui_auto.fix tests --diff origin/main
    → reads diff_impact, lists BROKEN cases with stale selectors,
      pairs each with `controls ADDED` from the new source

  $ qa_ui_auto.fix controls F8.2
    → runs control_extractor, diffs against existing controls block,
      shows reviewer the +/- list

Exit codes:
  0 — playbook printed (does not imply work was done)
  2 — bad target / missing data
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.feature_catalog import load_features  # noqa: E402

DEFAULT_FEATURES = Path("qa-ui-auto-tests/feature-list.md")
DEFAULT_CASES = Path("qa-ui-auto-tests/cases")
DEFAULT_BASELINE = Path("qa-ui-auto-tests/coverage-baseline.json")


# ---------------------------------------------------------------------------
# fix tests F.x  — draft a case closing missing controls
# ---------------------------------------------------------------------------

def _fix_tests_feature(feature_id: str) -> int:
    from qa_ui_auto.coverage_report import build_matrix
    rows = build_matrix(DEFAULT_FEATURES, DEFAULT_CASES)
    row = next((r for r in rows if r.id == feature_id), None)
    if row is None:
        print(f"fix tests: unknown feature {feature_id}", file=sys.stderr)
        return 2

    out: list[str] = [f"# fix tests {feature_id} — {row.title}", ""]
    out.append(f"area:       {row.area}")
    out.append(f"files:      {', '.join(row.files) or '(none)'}")
    out.append(f"covered:    {'yes' if row.covered else 'NO — never tested'}")
    out.append(
        f"controls:   {row.control_covered}/{row.control_required} required "
        f"({row.control_coverage_pct}%), {row.control_shallow} shallow"
        if row.controls_declared else
        "controls:   (none declared) — run `fix controls " + feature_id + "` first"
    )
    if not row.controls_declared:
        out.append("")
        out.append("ABORT: cannot draft a meaningful case without declared controls.")
        out.append(
            f"  run: python -m qa_ui_auto.fix controls {feature_id}"
        )
        print("\n".join(out))
        return 0

    out.append("")
    out.append("## Missing required controls")
    if not row.uncovered_required_controls and row.control_shallow == 0:
        out.append("  (none — feature is fully reviewed at the control level)")
        out.append("")
        out.append("Nothing to draft. Either widen the controls list "
                   "(`fix controls {fid}`), or pick a different feature.".format(fid=feature_id))
        print("\n".join(out))
        return 0
    for cid, kind, sel in row.uncovered_required_controls:
        verb_class = "click/fill/press/select_option" if kind == "interactive" else "wait_for/assert_visible/assert_text"
        out.append(f"  - {cid:<24} [{kind}]")
        out.append(f"      selector: {sel}")
        out.append(f"      use:      {verb_class}")

    # Surface shallow ones too — they need an interactive verb to graduate.
    if row.control_shallow:
        out.append("")
        out.append("## Shallow controls (need a real interactive verb)")
        # We only have IDs of uncovered, not shallow — do another pass via
        # control_coverage for shallow.
        from qa_ui_auto.control_coverage import build_coverage
        cc, _ = build_coverage(DEFAULT_FEATURES, DEFAULT_CASES)
        match = next((c for c in cc if c.feature.id == feature_id), None)
        if match:
            for ctrl in match.controls:
                if ctrl.shallow:
                    out.append(
                        f"  - {ctrl.control.id:<24} {ctrl.control.selector}"
                    )
                    out.append(
                        f"      currently only display-touched by: "
                        f"{', '.join(ctrl.display_cases) or '(none)'}"
                    )

    out.append("")
    out.append("## Playbook")
    out.append(
        f"  1. Read: python -m qa_ui_auto.feature_catalog --feature {feature_id} --json"
    )
    out.append(
        f"  2. Read source files (Read tool): {', '.join(row.files)}"
    )
    out.append("  3. Draft new YAML at qa-ui-auto-tests/cases/auto/")
    out.append(
        f"     filename: TC-auto-{feature_id.replace('.', '-')}-<slug>.testcase.yaml"
    )
    out.append(f"     covers: [{feature_id}]")
    out.append("     tags: [auto-generated, smoke, needs-review]")
    out.append("     fixtures: [reset_db]  # add ssh_required / sftp_required if needed")
    out.append(
        "     steps: touch every missing required control with the right verb class above."
    )
    out.append("     Use the EXACT selector strings — orphan reports flag rogue selectors.")
    out.append("  4. Validate: python -m qa_ui_auto.lint")
    out.append("  5. Dry-run:  python -m qa_ui_auto.runner --filter <id> --dry-run")
    out.append("  6. Real run: python -m qa_ui_auto.runner --filter <id> --workers 1")
    out.append(
        f"  7. Verify gap closed: python -m qa_ui_auto.audit --feature {feature_id}"
    )
    out.append(
        f"  8. Ratchet baseline:  python -m qa_ui_auto.control_coverage "
        f"--update-baseline {DEFAULT_BASELINE}"
    )
    print("\n".join(out))
    return 0


# ---------------------------------------------------------------------------
# fix tests --diff [BASE]  — patch broken cases
# ---------------------------------------------------------------------------

def _fix_tests_diff(base: str | None) -> int:
    from qa_ui_auto.diff_impact import analyze, _git_diff_names

    # Auto-detect base if not provided.
    if base is None:
        import subprocess
        for candidate in ("origin/main", "main", "HEAD~1"):
            try:
                subprocess.check_output(
                    ["git", "rev-parse", "--verify", candidate],
                    stderr=subprocess.DEVNULL,
                )
                base = candidate
                break
            except subprocess.CalledProcessError:
                continue
        if base is None:
            print("fix tests --diff: could not auto-detect a base; pass --diff <REF>",
                  file=sys.stderr)
            return 2

    try:
        changed = _git_diff_names(base, include_uncommitted=True)
    except Exception as e:  # noqa: BLE001
        print(f"fix tests --diff: {e}", file=sys.stderr)
        return 2

    feat_hits, case_hits = analyze(
        changed, features_path=DEFAULT_FEATURES, cases_dir=DEFAULT_CASES,
    )

    out: list[str] = [f"# fix tests --diff {base}", ""]
    out.append(f"changed files: {len(changed)}")
    out.append("")
    if not feat_hits:
        out.append("No features touched. Cases should still pass; "
                   "run a smoke sweep to confirm.")
        out.append("  python -m qa_ui_auto.runner --tag smoke --workers 4")
        print("\n".join(out))
        return 0

    out.append("## Impacted features")
    for f in feat_hits:
        out.append(f"  • {f.id}  {f.title}")
        if f.delta:
            if f.delta.added:
                out.append(f"      ADDED ({len(f.delta.added)}):")
                for s in f.delta.added[:8]:
                    out.append(f"        + {s}")
                if len(f.delta.added) > 8:
                    out.append(f"        ... +{len(f.delta.added) - 8} more")
            if f.delta.removed:
                out.append(f"      REMOVED ({len(f.delta.removed)}):")
                for s in f.delta.removed:
                    out.append(f"        - {s}")

    broken = [c for c in case_hits if c.broken_selectors]
    out.append("")
    out.append(f"## Cases needing patch ({len(broken)})")
    if not broken:
        out.append("  (no cases reference a removed selector — diff appears safe)")
    for c in broken:
        out.append(f"  • {c.id}  ({c.path})")
        out.append("      stale selectors:")
        for sel in c.broken_selectors:
            out.append(f"        ! {sel}")

    out.append("")
    out.append("## Playbook")
    out.append("  For each case in 'Cases needing patch':")
    out.append("    1. Read the case YAML and the changed component source.")
    out.append("    2. For each stale selector, find what replaced it (consult ADDED list).")
    out.append("    3. Show user the unified-diff before applying.")
    out.append("    4. Apply, then: python -m qa_ui_auto.runner --filter <id>")
    out.append(f"    5. Re-run: python -m qa_ui_auto.audit --diff {base}")
    out.append("       The BROKEN list should clear.")
    if any(f.delta and f.delta.added for f in feat_hits):
        out.append("")
        out.append("  ADDED selectors deserve declaration on the owning feature:")
        for f in feat_hits:
            if f.delta and f.delta.added:
                out.append(f"    python -m qa_ui_auto.fix controls {f.id}")
    out.append("")
    out.append("  After patching, regenerate the catalog:")
    out.append("    python -m qa_ui_auto.gen_testid_catalog")
    print("\n".join(out))
    return 0


# ---------------------------------------------------------------------------
# fix controls F.x  — populate or update a feature's controls block
# ---------------------------------------------------------------------------

def _fix_controls_feature(feature_id: str) -> int:
    feats = load_features(DEFAULT_FEATURES)
    feat = next((f for f in feats if f.id == feature_id), None)
    if feat is None:
        print(f"fix controls: unknown feature {feature_id}", file=sys.stderr)
        return 2

    out: list[str] = [f"# fix controls {feature_id} — {feat.title}", ""]
    out.append(f"area:       {feat.area}")
    out.append(f"files:      {', '.join(feat.files) or '(none)'}")
    out.append(
        f"controls:   {len(feat.controls)} declared "
        f"{'(declared empty: backend-only)' if not feat.controls and feat.controls_declared else ''}"
    )
    out.append("")

    tsx_files = [Path(f) for f in feat.files if f.endswith(".tsx") and Path(f).exists()]
    if not tsx_files:
        out.append("This feature has no .tsx files — extractor cannot help.")
        if feat.controls_declared:
            out.append("Already declared as `controls: []`. Nothing to do.")
        else:
            out.append(
                "Add `controls: []` to the feature's frontmatter to mark it "
                "backend-only, OR add a UI file to `files:` first."
            )
        print("\n".join(out))
        return 0

    # Run the extractor and diff
    from qa_ui_auto.control_extractor import extract_from_path, diff_against_feature, render_yaml

    out.append("## Extractor draft")
    out.append("```yaml")
    rep = extract_from_path(tsx_files[0]) if len(tsx_files) == 1 else None
    if rep is not None:
        out.append(render_yaml(rep).strip())
    else:
        # Multi-file: render each, then concatenate (not perfect but adequate)
        for p in tsx_files:
            r = extract_from_path(p)
            out.append(render_yaml(r).strip())
            out.append("")
    out.append("```")

    if feat.controls:
        out.append("")
        out.append("## Diff vs current controls block")
        out.append("```")
        # diff_against_feature accepts the *first* extractor report; do same
        diff = diff_against_feature(rep if rep is not None else extract_from_path(tsx_files[0]), feature_id)
        out.append(diff.strip())
        out.append("```")

    out.append("")
    out.append("## Playbook")
    out.append("  1. Review the extractor draft above:")
    out.append("     - drop decorative entries (e.g. aria-label on status icons)")
    out.append("     - confirm `kind` (interactive vs display)")
    out.append("     - mark conditional renders as `optional: true`")
    out.append("     - add a testid in source for any control extractor missed")
    out.append("  2. Edit the feature's frontmatter `controls:` block in feature-list.md.")
    out.append("  3. Lint:           python -m qa_ui_auto.lint")
    out.append("  4. Catalog:        python -m qa_ui_auto.gen_testid_catalog")
    out.append(f"  5. Verify:         python -m qa_ui_auto.audit --feature {feature_id}")
    out.append("  6. (Cases that follow) — run `fix tests {fid}` next.".format(fid=feature_id))
    print("\n".join(out))
    return 0


# ---------------------------------------------------------------------------
# fix features --range REF  — backfill feature-list.md
# ---------------------------------------------------------------------------

def _fix_features_range(since: str | None) -> int:
    if not since:
        print("fix features: pass --range <ref>  (e.g. --range origin/main, "
              "--range HEAD~5, --range v0.1.10)", file=sys.stderr)
        return 2
    out: list[str] = [f"# fix features --range {since}", ""]
    out.append("Run the range analyzer to inventory new / touched / deleted files:")
    out.append(
        f"  python -m qa_ui_auto.range_changes --since {since}"
    )
    out.append("")
    out.append("Then update feature-list.md following the four classifications:")
    out.append("  - Orphan NEW       → new feature OR extend an existing feature's `files`")
    out.append("  - Orphan MODIFIED  → same triage as Orphan NEW; leave alone if a private helper")
    out.append("  - Touched          → refresh description if observable capability changed")
    out.append("  - Deleted          → remove from owning feature's `files`; mark feature manually if it was the last one")
    out.append("")
    out.append("After editing feature-list.md:")
    out.append("  1. python -m qa_ui_auto.lint")
    out.append("  2. For each new feature: python -m qa_ui_auto.fix controls <F.x>")
    out.append("  3. For each new feature: python -m qa_ui_auto.fix tests <F.x>")
    out.append("  4. python -m qa_ui_auto.gen_testid_catalog")
    print("\n".join(out))
    return 0


# ---------------------------------------------------------------------------
# fix catalog  — regenerate testid-catalog.md
# ---------------------------------------------------------------------------

def _fix_catalog() -> int:
    from qa_ui_auto.gen_testid_catalog import main as catalog_main
    return catalog_main([])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="qa_ui_auto.fix",
        description="Task-oriented dispatcher for closing gaps surfaced by audit.",
    )
    sub = ap.add_subparsers(dest="target", required=True)

    p_tests = sub.add_parser("tests", help="draft new case OR patch broken case")
    p_tests.add_argument("feature", nargs="?", default=None,
                         help="feature ID to draft a case for (e.g. F1.6)")
    p_tests.add_argument("--diff", nargs="?", const=True, default=None,
                         help="patch cases broken by a diff; pass a base ref or rely on auto-detect")

    p_ctrl = sub.add_parser("controls", help="populate / update a feature's controls block")
    p_ctrl.add_argument("feature", help="feature ID (e.g. F1.6)")

    p_feat = sub.add_parser("features", help="backfill feature-list.md from a commit range")
    p_feat.add_argument("--range", dest="since", default=None,
                        help="git ref / tag / SHA (e.g. origin/main, v0.1.10, HEAD~5)")

    sub.add_parser("catalog", help="regenerate references/testid-catalog.md")

    args = ap.parse_args(argv)

    if args.target == "tests":
        if args.diff is not None:
            base = args.diff if isinstance(args.diff, str) else None
            return _fix_tests_diff(base)
        if not args.feature:
            print("fix tests: pass a feature ID or --diff [BASE]", file=sys.stderr)
            return 2
        return _fix_tests_feature(args.feature)

    if args.target == "controls":
        return _fix_controls_feature(args.feature)

    if args.target == "features":
        return _fix_features_range(args.since)

    if args.target == "catalog":
        return _fix_catalog()

    return 2


if __name__ == "__main__":
    sys.exit(main())
