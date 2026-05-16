#!/usr/bin/env python3
"""Map a git diff to impacted features and testcases.

This is the data-fetcher behind the `gen-diff` subcommand of qa-ui-auto.
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


@dataclass
class FeatureImpact:
    id: str
    title: str
    files: list[str] = field(default_factory=list)
    matching_changed_files: list[str] = field(default_factory=list)


@dataclass
class CaseImpact:
    id: str
    title: str
    path: str
    via_features: list[str] = field(default_factory=list)
    yaml_changed: bool = False
    tags: list[str] = field(default_factory=list)


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


def analyze(
    changed_files: list[str],
    *,
    features_path: Path = Path("qa-ui-auto-tests/feature-list.md"),
    cases_dir: Path = Path("qa-ui-auto-tests/cases"),
) -> tuple[list[FeatureImpact], list[CaseImpact]]:
    feats = load_features(features_path)

    feature_hits: list[FeatureImpact] = []
    for f in feats:
        files = list(f.files)
        matches = [c for c in changed_files if any(_file_matches(ff, c) for ff in files)]
        if matches:
            feature_hits.append(FeatureImpact(
                id=f.id, title=f.title,
                files=files, matching_changed_files=matches,
            ))

    impacted_feature_ids = {f.id for f in feature_hits}

    case_hits: list[CaseImpact] = []
    cases = discover(cases_dir)
    changed_set = {_normalize(p) for p in changed_files}
    for c in cases:
        via = [fid for fid in c.covers if fid in impacted_feature_ids]
        case_path_norm = _normalize(str(c.source_path)) if c.source_path else ""
        yaml_changed = case_path_norm in changed_set
        if via or yaml_changed:
            case_hits.append(CaseImpact(
                id=c.id, title=c.title,
                path=str(c.source_path) if c.source_path else "",
                via_features=via, yaml_changed=yaml_changed, tags=c.tags,
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

    out.append("")
    out.append(f"== Impacted testcases ({len(case_hits)})")
    if not case_hits:
        out.append("  (none — none of the existing cases cover these features, "
                   "consider gen-coverage to add new ones)")
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
        flag_s = f" [{', '.join(flags)}]" if flags else ""
        out.append(f"  • {c.id}  {c.title[:60]}{flag_s}")
        if c.via_features:
            out.append(f"      covers: {', '.join(c.via_features)}")
        if c.path:
            out.append(f"      file:   {c.path}")

    if needs_new:
        out.append("")
        out.append(
            "== Features with NO testcase touching the change "
            f"({len(needs_new)})"
        )
        for fid in needs_new:
            out.append(f"  ✗ {fid}  — consider drafting a new case via gen-coverage")

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
                 "matching_changed_files": f.matching_changed_files}
                for f in feat_hits
            ],
            "impacted_cases": [
                {"id": c.id, "title": c.title, "path": c.path,
                 "via_features": c.via_features, "yaml_changed": c.yaml_changed,
                 "tags": c.tags}
                for c in case_hits
            ],
        }, indent=2, ensure_ascii=False))
    else:
        print(render_text(changed, feat_hits, case_hits, base=base_label))
    return 0


if __name__ == "__main__":
    sys.exit(main())
