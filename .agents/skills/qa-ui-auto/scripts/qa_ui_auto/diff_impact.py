#!/usr/bin/env python3
"""Map a git diff to impacted features and testcases.

This is the data-fetcher behind `audit --diff` and `fix tests --diff`.
It does NOT modify YAML — it tells the parent agent which features and
cases a code change touches, so the agent can decide what to patch.

Usage:

    python -m qa_ui_auto.diff_impact                    # diff vs origin/main (or main)
    python -m qa_ui_auto.diff_impact --base HEAD~5      # diff vs an explicit ref
    python -m qa_ui_auto.diff_impact --files a.tsx b.tsx  # treat these as the change set
    python -m qa_ui_auto.diff_impact --json             # machine-readable

The matching logic:
  * Compute changed file list from `git diff --name-only <base>...HEAD` plus
    uncommitted changes (--include-uncommitted, on by default).
  * For each feature in qa-ui-auto-tests/feature-list.md, mark it impacted if any of its
    `files` is a path-prefix of any changed file.
  * For each case in qa-ui-auto-tests/cases/, mark it impacted if any of its `covers` is
    impacted, OR if its YAML file itself was changed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
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
from qa_ui_auto.control_extractor import extract_from_path  # noqa: E402
from qa_ui_auto.control_coverage import (  # noqa: E402
    _normalize_selector, _is_derived_match, _touches_for_case,
)


@dataclass
class ControlDelta:
    """Per-feature delta of declared controls vs current source.

    `added`:   selectors the extractor sees in the new source that aren't in
               the feature's `controls:` list. Likely new testid that the
               feature should declare so future cases can target it.
    `removed`: selectors the feature declares but the extractor no longer
               finds in source. Likely a renamed/deleted testid; cases using
               it will fail.
    `unchanged`: selectors present in both — sanity checkpoint, used to
               distinguish "the diff didn't really touch UI" from "it
               renamed everything".
    """

    feature_id: str
    feature_title: str
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)


@dataclass
class FeatureImpact:
    id: str
    title: str
    files: list[str] = field(default_factory=list)
    matching_changed_files: list[str] = field(default_factory=list)
    delta: ControlDelta | None = None    # populated when controls were declared


@dataclass
class CaseImpact:
    id: str
    title: str
    path: str
    via_features: list[str] = field(default_factory=list)
    yaml_changed: bool = False
    tags: list[str] = field(default_factory=list)
    # Selectors this case touches that match a `removed` control of an
    # impacted feature. These are the spots that almost certainly need
    # patching after the diff lands.
    broken_selectors: list[str] = field(default_factory=list)


def _git_diff_names(base: str, *, include_uncommitted: bool) -> list[str]:
    """List changed paths between base and HEAD, plus optional uncommitted."""
    paths: set[str] = set()
    try:
        committed = subprocess.check_output(
            ["git", "diff", "--name-only", f"{base}...HEAD"],
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace")
        paths.update(line.strip() for line in committed.splitlines() if line.strip())
    except subprocess.CalledProcessError:
        # Fallback: maybe shallow clone or unreachable base. Try two-dot form.
        try:
            committed = subprocess.check_output(
                ["git", "diff", "--name-only", base, "HEAD"],
                stderr=subprocess.DEVNULL,
            ).decode("utf-8", errors="replace")
            paths.update(line.strip() for line in committed.splitlines() if line.strip())
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"git diff failed for base={base!r}; "
                "pass an explicit --base or use --files."
            ) from e
    if include_uncommitted:
        for cmd in (
            ["git", "diff", "--name-only"],                      # unstaged
            ["git", "diff", "--name-only", "--cached"],          # staged
            ["git", "ls-files", "--others", "--exclude-standard"],  # untracked
        ):
            try:
                out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode(
                    "utf-8", errors="replace"
                )
                paths.update(line.strip() for line in out.splitlines() if line.strip())
            except subprocess.CalledProcessError:
                pass
    return sorted(paths)


def _normalize(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")


def _file_matches(feature_file: str, changed: str) -> bool:
    """`feature_file` may be a file path or a directory prefix (ends with /)."""
    f = _normalize(feature_file)
    c = _normalize(changed)
    if f.endswith("/"):
        return c.startswith(f)
    return c == f or c.startswith(f.rstrip("/") + "/")


def _compute_delta(feat) -> ControlDelta | None:  # feat: Feature
    """Re-scan the feature's .tsx files and diff against declared controls.

    Two passes:
      - extractor pass → finds all *literal* testid/aria selectors the new
        source declares; these populate `unchanged` (and `added` if not yet
        in feature.controls).
      - source-text pass → for declared selectors that the extractor misses
        (because the testid is dispatched via a child component prop, e.g.
        `<IconBtn testId="x" />`), check whether the *string literal* still
        appears anywhere in the merged source. If it does, the control is
        still wired up; if it doesn't, mark `removed` — that's the case
        that almost certainly breaks tests.
    Returns None when the feature has no .tsx files (backend-only / mixed).
    """
    tsx_files = [Path(f) for f in feat.files if f.endswith(".tsx") and Path(f).exists()]
    if not tsx_files:
        return None

    # Extractor pass.
    found_selectors: set[str] = set()
    for p in tsx_files:
        rep = extract_from_path(p)
        for c in rep.controls:
            found_selectors.add(_normalize_selector(c.selector))

    # Concatenated source for the substring fallback.
    merged_source = "\n".join(p.read_text(encoding="utf-8") for p in tsx_files)

    declared_selectors: set[str] = set()
    for c in feat.controls:
        for sel in c.all_selectors():
            declared_selectors.add(_normalize_selector(sel))

    # `extractor_visible` filters which declared selectors we even attempt
    # to validate. Pure text=, role=, button[title=...] selectors aren't
    # something static analysis can prove the existence of, so we don't
    # flag them either way.
    def _selector_signature(s: str) -> str | None:
        """Pull out the literal *value* worth substring-searching for.

        Returns the inner attribute value (e.g. `welcome-panel` for
        `[data-testid="welcome-panel"]`). None when the selector form is
        too loose to validate via substring search.
        """
        for prefix in (
            '[data-testid="', '[aria-label="',
            'button[aria-label="', 'input[aria-label="',
            'select[aria-label="', 'textarea[aria-label="',
            'button[data-testid="', 'input[data-testid="',
        ):
            if s.startswith(prefix):
                rest = s[len(prefix):]
                end = rest.find('"')
                if end > 0:
                    return rest[:end]
        return None

    added = sorted(found_selectors - declared_selectors)
    removed: list[str] = []
    for s in declared_selectors - found_selectors:
        sig = _selector_signature(s)
        if sig is None:
            continue   # too loose to validate; skip
        if sig in merged_source:
            # Selector is still wired up indirectly (e.g. <Comp testId="x">
            # → renders data-testid="x"). Keep it as "unchanged".
            continue
        removed.append(s)
    removed.sort()
    unchanged = sorted(declared_selectors & found_selectors)
    return ControlDelta(
        feature_id=feat.id,
        feature_title=feat.title,
        added=added,
        removed=removed,
        unchanged=unchanged,
    )


def _broken_selectors_for_case(case, removed_selectors: set[str]) -> list[str]:
    """Selectors a case touches that derive from a removed control."""
    out: list[str] = []
    for t in _touches_for_case(case):
        key = _normalize_selector(t.selector)
        for rem in removed_selectors:
            if key == rem or _is_derived_match(key, rem):
                out.append(t.selector)
                break
    # Dedupe while preserving order.
    seen: set[str] = set()
    return [s for s in out if not (s in seen or seen.add(s))]


def analyze(
    changed_files: list[str],
    *,
    features_path: Path = Path("qa-ui-auto-tests/feature-list.md"),
    cases_dir: Path = Path("qa-ui-auto-tests/cases"),
) -> tuple[list[FeatureImpact], list[CaseImpact]]:
    feats = load_features(features_path)

    feature_hits: list[FeatureImpact] = []
    impacted_feat_objs: dict[str, Any] = {}
    for f in feats:
        files = list(f.files)
        matches = [c for c in changed_files if any(_file_matches(ff, c) for ff in files)]
        if matches:
            delta = _compute_delta(f)
            feature_hits.append(FeatureImpact(
                id=f.id, title=f.title,
                files=files, matching_changed_files=matches,
                delta=delta,
            ))
            impacted_feat_objs[f.id] = f

    impacted_feature_ids = {f.id for f in feature_hits}

    # Aggregate every removed selector across impacted features → set
    removed_selectors: set[str] = set()
    for fh in feature_hits:
        if fh.delta:
            for sel in fh.delta.removed:
                removed_selectors.add(sel)

    case_hits: list[CaseImpact] = []
    cases = discover(cases_dir)
    changed_set = {_normalize(p) for p in changed_files}
    for c in cases:
        via = [fid for fid in c.covers if fid in impacted_feature_ids]
        case_path_norm = _normalize(str(c.source_path)) if c.source_path else ""
        yaml_changed = case_path_norm in changed_set
        if not (via or yaml_changed):
            continue
        broken = _broken_selectors_for_case(c, removed_selectors) if removed_selectors else []
        case_hits.append(CaseImpact(
            id=c.id, title=c.title,
            path=str(c.source_path) if c.source_path else "",
            via_features=via, yaml_changed=yaml_changed, tags=c.tags,
            broken_selectors=broken,
        ))

    return feature_hits, case_hits


def render_text(
    changed_files: list[str],
    feature_hits: list[FeatureImpact],
    case_hits: list[CaseImpact],
    *,
    base: str | None = None,
) -> str:
    out: list[str] = []
    if base:
        out.append(f"diff vs {base}: {len(changed_files)} changed file(s)")
    else:
        out.append(f"explicit file set: {len(changed_files)} file(s)")

    if not changed_files:
        out.append("(no changes detected)")
        return "\n".join(out)

    out.append("")
    out.append(f"== Impacted features ({len(feature_hits)})")
    if not feature_hits:
        out.append("  (none — change does not touch any feature's `files`)")
    for f in feature_hits:
        out.append(f"  • {f.id}  {f.title}")
        for c in f.matching_changed_files:
            out.append(f"      via {c}")
        if f.delta is None:
            continue
        if f.delta.added:
            out.append(f"      controls ADDED ({len(f.delta.added)}) — declare in feature.controls:")
            for sel in f.delta.added[:10]:
                out.append(f"        + {sel}")
            if len(f.delta.added) > 10:
                out.append(f"        + ... and {len(f.delta.added) - 10} more")
        if f.delta.removed:
            out.append(f"      controls REMOVED ({len(f.delta.removed)}) — cases using these will fail:")
            for sel in f.delta.removed:
                out.append(f"        - {sel}")

    out.append("")
    out.append(f"== Impacted testcases ({len(case_hits)})")
    if not case_hits:
        out.append("  (none — none of the existing cases cover these features, "
                   "consider `fix tests <F.x>` to add one)")
    needs_new = [
        f.id for f in feature_hits
        if not any(f.id in c.via_features for c in case_hits)
    ]
    for c in case_hits:
        flags = []
        if c.yaml_changed:
            flags.append("yaml-changed")
        if "needs-review" in c.tags:
            flags.append("needs-review")
        if c.broken_selectors:
            flags.append(f"BROKEN x{len(c.broken_selectors)}")
        flag_s = f" [{', '.join(flags)}]" if flags else ""
        out.append(f"  • {c.id}  {c.title[:60]}{flag_s}")
        if c.via_features:
            out.append(f"      covers: {', '.join(c.via_features)}")
        if c.path:
            out.append(f"      file:   {c.path}")
        if c.broken_selectors:
            out.append(f"      stale selectors:")
            for sel in c.broken_selectors:
                out.append(f"        ! {sel}")

    if needs_new:
        out.append("")
        out.append(
            "== Features with NO testcase touching the change "
            f"({len(needs_new)})"
        )
        for fid in needs_new:
            out.append(f"  ✗ {fid}  — consider drafting a new case via `fix tests {fid}`")

    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.diff_impact")
    ap.add_argument("--base", default=None,
                    help="git ref to diff against; default tries origin/main then main")
    ap.add_argument("--files", nargs="+", default=None,
                    help="explicit file list instead of git diff")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases")
    ap.add_argument("--no-uncommitted", action="store_true",
                    help="exclude staged/unstaged/untracked files")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.files:
        changed = [_normalize(f) for f in args.files]
        base_label = "<explicit>"
    else:
        base = args.base
        if not base:
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
        if not base:
            print("could not auto-detect a base; pass --base", file=sys.stderr)
            return 2
        try:
            changed = _git_diff_names(base, include_uncommitted=not args.no_uncommitted)
        except RuntimeError as e:
            print(f"diff_impact: {e}", file=sys.stderr)
            return 2
        base_label = base

    feat_hits, case_hits = analyze(
        changed,
        features_path=Path(args.features),
        cases_dir=Path(args.cases),
    )

    if args.json:
        print(json.dumps({
            "base": base_label,
            "changed_files": changed,
            "impacted_features": [
                {"id": f.id, "title": f.title, "files": f.files,
                 "matching_changed_files": f.matching_changed_files,
                 "control_delta": (
                     {
                         "added": f.delta.added,
                         "removed": f.delta.removed,
                         "unchanged": f.delta.unchanged,
                     }
                     if f.delta else None
                 )}
                for f in feat_hits
            ],
            "impacted_cases": [
                {"id": c.id, "title": c.title, "path": c.path,
                 "via_features": c.via_features, "yaml_changed": c.yaml_changed,
                 "tags": c.tags,
                 "broken_selectors": c.broken_selectors}
                for c in case_hits
            ],
        }, indent=2, ensure_ascii=False))
    else:
        print(render_text(changed, feat_hits, case_hits, base=base_label))
    return 0


if __name__ == "__main__":
    sys.exit(main())
