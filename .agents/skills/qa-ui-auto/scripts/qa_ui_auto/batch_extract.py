#!/usr/bin/env python3
"""Batch-extract control drafts for every feature in feature-list.md.

For each feature:
  - if any of its `files:` is a .tsx, run control_extractor on the union and
    emit a draft `controls:` block.
  - if the feature has only non-.tsx files (.rs, .ts without JSX, .json), it
    is treated as backend-only and the draft is `controls: []` with a comment
    explaining why a human should confirm.
  - the draft is written to:
        qa-ui-auto-tests/controls-drafts/<chapter>/<feature_id>.md
    where <chapter> is the first segment of the feature's `area:` (or
    `_misc` for features without one).
  - a top-level MANIFEST.md is produced summarising every feature: source
    file count, extracted control count, and a triage hint.

This script is part of the **gen-controls** workflow's "batch fill" mode.
It DOES NOT modify feature-list.md. Reviewers paste accepted draft blocks
into the feature's frontmatter manually.

Usage:
    python -m qa_ui_auto.batch_extract
    python -m qa_ui_auto.batch_extract --out qa-ui-auto-tests/controls-drafts
    python -m qa_ui_auto.batch_extract --chapter terminal       # only one chapter
    python -m qa_ui_auto.batch_extract --feature F1.7           # only one feature
    python -m qa_ui_auto.batch_extract --skip-already-filled    # don't redraft
                                                                # features that
                                                                # already have
                                                                # controls
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.feature_catalog import load_features, Feature  # noqa: E402
from qa_ui_auto.control_extractor import (  # noqa: E402
    extract_from_text, render_yaml, ExtractReport,
)


def _chapter_of(feat: Feature) -> str:
    if not feat.area:
        return "_misc"
    return feat.area.split("/", 1)[0] or "_misc"


def _classify_files(files: list[str]) -> tuple[list[Path], list[Path], list[Path]]:
    """Return (.tsx files, other source files, missing files)."""
    tsx: list[Path] = []
    other: list[Path] = []
    missing: list[Path] = []
    for f in files:
        p = Path(f)
        if not p.exists():
            missing.append(p)
            continue
        if p.suffix == ".tsx":
            tsx.append(p)
        else:
            other.append(p)
    return tsx, other, missing


@dataclass
class DraftRow:
    feature: Feature
    chapter: str
    tsx_files: list[Path]
    other_files: list[Path]
    missing_files: list[Path]
    extracted_count: int
    draft_path: Path
    triage: str    # "extracted" | "backend-only" | "no-source" | "already-filled"


def _draft_for_feature(
    feat: Feature, out_root: Path, *, skip_already_filled: bool
) -> DraftRow:
    chapter = _chapter_of(feat)
    out_dir = out_root / chapter
    out_dir.mkdir(parents=True, exist_ok=True)
    draft_path = out_dir / f"{feat.id}.md"

    tsx, other, missing = _classify_files(feat.files)
    triage: str
    body: list[str] = []
    body.append(f"# {feat.id} — {feat.title}")
    body.append("")
    body.append(f"- area: `{feat.area or '(none)'}`")
    body.append(f"- chapter: `{chapter}`")
    body.append(f"- status: {feat.status}")
    body.append(f"- components: {', '.join(feat.components) or '(none)'}")
    body.append(f"- existing controls: {len(feat.controls)}")
    body.append("")
    body.append("**source files**")
    if tsx:
        body.append("")
        body.append("_.tsx (extractor input)_")
        for p in tsx:
            body.append(f"- `{p}`")
    if other:
        body.append("")
        body.append("_other (not extractor input — .rs / .ts without JSX / .json)_")
        for p in other:
            body.append(f"- `{p}`")
    if missing:
        body.append("")
        body.append("_⚠ MISSING (file no longer exists; feature.files is stale)_")
        for p in missing:
            body.append(f"- `{p}`")
    body.append("")

    if feat.controls and skip_already_filled:
        body.append("## skipped: feature already has a `controls:` block")
        body.append("")
        body.append("Re-run without `--skip-already-filled` to redraft.")
        triage = "already-filled"
        extracted_count = len(feat.controls)
    elif tsx:
        merged = "\n\n// === FILE BREAK ===\n\n".join(
            p.read_text(encoding="utf-8") for p in tsx
        )
        rep = extract_from_text(merged, source=" + ".join(str(p) for p in tsx))
        # patch ExtractReport.file to reflect the merge
        rep.file = Path(" + ".join(str(p) for p in tsx))
        body.append("## extractor draft")
        body.append("")
        body.append(
            "Paste the block below into the feature's `<!-- feature ... -->` "
            "frontmatter under `files:`. Review every entry: drop decorative "
            "elements, fix `kind` (interactive vs display), confirm `optional` "
            "flags. Where the extractor missed a control (text-only buttons, "
            "items inside `.map(...)`), add it manually OR add a `data-testid` "
            "to the source first."
        )
        body.append("")
        body.append("```yaml")
        body.append(render_yaml(rep).strip())
        body.append("```")
        triage = "extracted" if rep.controls else "no-controls-found"
        extracted_count = len(rep.controls)
    elif other and not missing:
        body.append("## backend-only (no .tsx files)")
        body.append("")
        body.append(
            "This feature lists no .tsx files. Either it's a pure backend / "
            "non-UI feature, or its UI files aren't recorded in `files:`. "
            "Decide which:"
        )
        body.append("")
        body.append("- **backend-only**: paste `controls: []` under `files:` "
                    "with a comment, e.g. `# no UI surface — backend feature`.")
        body.append("- **missing UI file(s)**: extend `files:` to include the "
                    "frontend component(s) that surface this feature, then "
                    "re-run `batch_extract --feature " + feat.id + "`.")
        body.append("")
        body.append("```yaml")
        body.append("controls: []   # confirm backend-only or add UI files")
        body.append("```")
        triage = "backend-only"
        extracted_count = 0
    elif missing and not other:
        # All declared files are missing. The feature.files is stale and the
        # extractor has nothing to scan. Don't pretend this is backend-only —
        # surface the real issue: file paths are wrong.
        body.append("## ⚠ stale file paths — extractor has nothing to scan")
        body.append("")
        body.append(
            "Every file declared by this feature is missing from disk. The "
            "feature was probably moved or renamed without updating "
            "`feature-list.md`. Fix the `files:` list first (use "
            "`/qa-ui-auto gen-diff` if the change is recent, or grep for the "
            "component name to find its new home), then re-run "
            f"`batch_extract --feature {feat.id}`."
        )
        triage = "stale-files"
        extracted_count = 0
    elif other and missing:
        body.append("## partial: some files missing, others non-.tsx")
        body.append("")
        body.append(
            "Mix of missing paths and non-.tsx source files. Fix the missing "
            "paths first, decide if any of them should have been .tsx, then "
            f"re-run `batch_extract --feature {feat.id}`."
        )
        triage = "stale-files"
        extracted_count = 0
    else:
        body.append("## no source files declared")
        body.append("")
        body.append(
            "This feature has an empty `files:` list. Add at least one file "
            "before extracting controls."
        )
        triage = "no-source"
        extracted_count = 0

    body.append("")
    draft_path.write_text("\n".join(body) + "\n", encoding="utf-8")

    return DraftRow(
        feature=feat,
        chapter=chapter,
        tsx_files=tsx,
        other_files=other,
        missing_files=missing,
        extracted_count=extracted_count,
        draft_path=draft_path,
        triage=triage,
    )


def _write_manifest(out_root: Path, rows: list[DraftRow]) -> None:
    rows = sorted(rows, key=lambda r: (r.chapter, r.feature.id))
    by_chapter: dict[str, list[DraftRow]] = {}
    for r in rows:
        by_chapter.setdefault(r.chapter, []).append(r)

    counts = {
        "total": len(rows),
        "extracted": sum(1 for r in rows if r.triage == "extracted"),
        "no_controls_found": sum(1 for r in rows if r.triage == "no-controls-found"),
        "backend_only": sum(1 for r in rows if r.triage == "backend-only"),
        "stale_files": sum(1 for r in rows if r.triage == "stale-files"),
        "no_source": sum(1 for r in rows if r.triage == "no-source"),
        "already_filled": sum(1 for r in rows if r.triage == "already-filled"),
    }

    out: list[str] = []
    out.append("# controls draft manifest")
    out.append("")
    out.append(
        f"Generated by `python -m qa_ui_auto.batch_extract`. "
        f"Reviewers: pick a chapter, walk through each draft .md, "
        f"copy the accepted controls block into `feature-list.md`, "
        f"then run `python -m qa_ui_auto.lint` and "
        f"`python -m qa_ui_auto.control_coverage --feature F.x` to verify."
    )
    out.append("")
    out.append("## summary")
    out.append("")
    out.append(f"- total features:       {counts['total']}")
    out.append(f"- extracted draft:      {counts['extracted']}    "
               "(.tsx scanned, ≥1 control found — review and trim)")
    out.append(f"- no controls found:    {counts['no_controls_found']}    "
               "(.tsx scanned, 0 testid/aria-label — likely needs testids "
               "added at source)")
    out.append(f"- backend-only:         {counts['backend_only']}    "
               "(no .tsx — confirm and accept `controls: []`)")
    out.append(f"- stale files:          {counts['stale_files']}    "
               "(declared paths missing — fix files: list first)")
    out.append(f"- no source:            {counts['no_source']}    "
               "(empty files: list — fix feature first)")
    out.append(f"- already filled:       {counts['already_filled']}    "
               "(skipped this run)")
    out.append("")
    out.append("## by chapter")
    out.append("")
    for chap in sorted(by_chapter):
        cs = by_chapter[chap]
        out.append(f"### `{chap}` ({len(cs)})")
        out.append("")
        out.append("| feature | title | triage | tsx | other | extracted |")
        out.append("|---|---|---|---|---|---|")
        for r in cs:
            tsx_n = len(r.tsx_files)
            other_n = len(r.other_files) + len(r.missing_files)
            title = r.feature.title.replace("|", "\\|")
            out.append(
                f"| [{r.feature.id}]({chap}/{r.feature.id}.md) "
                f"| {title} "
                f"| {r.triage} "
                f"| {tsx_n} "
                f"| {other_n} "
                f"| {r.extracted_count} |"
            )
        out.append("")

    out.append("## suggested review order")
    out.append("")
    out.append(
        "Start with chapters that have many `extracted` rows but few `tsx` "
        "files per feature (small surface = quick wins). Tackle the big ones "
        "(`terminal`, `sftp`, `sessions`) last. Suggested order:"
    )
    out.append("")
    # Suggest: chapters sorted by total extracted count ascending, but only
    # those with at least one extracted row.
    rank = sorted(by_chapter.items(),
                  key=lambda kv: sum(r.extracted_count for r in kv[1]))
    for chap, cs in rank:
        n_extr = sum(1 for r in cs if r.triage == "extracted")
        n_total = len(cs)
        n_ctrls = sum(r.extracted_count for r in cs)
        out.append(f"1. `{chap}` — {n_extr}/{n_total} need review, ~{n_ctrls} controls")
    out.append("")
    (out_root / "MANIFEST.md").write_text("\n".join(out), encoding="utf-8")


def run(
    out_root: Path,
    *,
    chapter_filter: str | None = None,
    feature_filter: str | None = None,
    skip_already_filled: bool = True,
) -> int:
    feats = load_features()
    if feature_filter:
        feats = [f for f in feats if f.id == feature_filter]
        if not feats:
            print(f"batch_extract: feature not found: {feature_filter}",
                  file=sys.stderr)
            return 2
    out_root.mkdir(parents=True, exist_ok=True)
    rows: list[DraftRow] = []
    for f in feats:
        if chapter_filter and _chapter_of(f) != chapter_filter:
            continue
        rows.append(_draft_for_feature(
            f, out_root, skip_already_filled=skip_already_filled
        ))
    if not chapter_filter and not feature_filter:
        _write_manifest(out_root, rows)
    print(f"batch_extract: wrote {len(rows)} draft(s) under {out_root}")
    if not chapter_filter and not feature_filter:
        print(f"  → MANIFEST.md: {out_root / 'MANIFEST.md'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.batch_extract")
    ap.add_argument("--out", default="qa-ui-auto-tests/controls-drafts",
                    help="output directory (default: qa-ui-auto-tests/controls-drafts)")
    ap.add_argument("--chapter", default=None,
                    help="only process features in this chapter "
                         "(e.g. terminal, sftp, main)")
    ap.add_argument("--feature", default=None,
                    help="only process this feature id (e.g. F1.7)")
    ap.add_argument("--include-already-filled", action="store_true",
                    help="re-draft even features that already have a "
                         "non-empty controls block (default: skip)")
    args = ap.parse_args(argv)

    return run(
        Path(args.out),
        chapter_filter=args.chapter,
        feature_filter=args.feature,
        skip_already_filled=not args.include_already_filled,
    )


if __name__ == "__main__":
    sys.exit(main())
