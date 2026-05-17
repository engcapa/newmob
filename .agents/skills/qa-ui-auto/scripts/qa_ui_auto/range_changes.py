#!/usr/bin/env python3
"""Classify file changes across a git commit range, for `fix features --range`.

This is the data-fetcher behind the `fix features --range` command of
qa-ui-auto. It does NOT modify feature-list.md — it tells the parent agent
which files were added / modified / deleted across a range and which
existing features those files belong to, so the agent can decide what to
add or update.

Usage:
    python -m qa_ui_auto.range_changes                                  # vs origin/main..HEAD
    python -m qa_ui_auto.range_changes --since v0.1.10                  # vs a tag
    python -m qa_ui_auto.range_changes --since HEAD~5                   # last 5 commits
    python -m qa_ui_auto.range_changes --since 2026-04-01               # via --since=YYYY-MM-DD
    python -m qa_ui_auto.range_changes --since A --until B              # explicit window
    python -m qa_ui_auto.range_changes --commits abc,def                # explicit commit set
    python -m qa_ui_auto.range_changes --json

Classification:
  * NEW:     files added in the range that no existing feature lists in `files`
  * TOUCHED: files modified in the range AND already listed by some feature
  * DELETED: files deleted in the range AND listed by some feature
  * ORPHAN_MODIFIED: files modified in the range but no feature claims them

NEW + ORPHAN_MODIFIED are candidates for new feature entries (or extending
an existing one). TOUCHED hints at status / files / description updates.
DELETED hints at status downgrade or section removal.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS_DIR = HERE.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from qa_ui_auto.feature_catalog import load_features  # noqa: E402


@dataclass
class CommitInfo:
    sha: str
    short_sha: str
    author_date: str
    subject: str
    body: str = ""
    files_added: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    files_deleted: list[str] = field(default_factory=list)
    files_renamed: list[tuple[str, str]] = field(default_factory=list)


def _git(*args: str) -> str:
    return subprocess.check_output(
        ["git", *args], stderr=subprocess.DEVNULL
    ).decode("utf-8", errors="replace")


def _resolve_ref(ref: str) -> str | None:
    try:
        return _git("rev-parse", "--verify", ref).strip()
    except subprocess.CalledProcessError:
        return None


def _auto_since() -> str:
    """Try origin/main, main, then HEAD~1 in that order."""
    for r in ("origin/main", "main", "HEAD~1"):
        if _resolve_ref(r):
            return r
    raise RuntimeError("could not auto-detect a base; pass --since")


def _list_commits(since: str, until: str) -> list[str]:
    out = _git("log", "--pretty=%H", "--reverse", f"{since}..{until}")
    return [line.strip() for line in out.splitlines() if line.strip()]


def _commit_meta(sha: str) -> CommitInfo:
    info = _git("show", "--no-patch",
                "--pretty=%H%n%h%n%aI%n%s%n%b", sha)
    parts = info.split("\n", 4)
    full = parts[0] if len(parts) > 0 else sha
    short = parts[1] if len(parts) > 1 else sha[:7]
    date = parts[2] if len(parts) > 2 else ""
    subject = parts[3] if len(parts) > 3 else ""
    body = parts[4].strip() if len(parts) > 4 else ""
    ci = CommitInfo(sha=full, short_sha=short, author_date=date,
                    subject=subject, body=body)
    raw = _git("show", "--name-status", "--format=", sha)
    for line in raw.splitlines():
        line = line.rstrip()
        if not line:
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith("R") and len(parts) >= 3:
            ci.files_renamed.append((parts[1], parts[2]))
        elif status == "A" and len(parts) >= 2:
            ci.files_added.append(parts[1])
        elif status == "M" and len(parts) >= 2:
            ci.files_modified.append(parts[1])
        elif status == "D" and len(parts) >= 2:
            ci.files_deleted.append(parts[1])
    return ci


@dataclass
class RangeChangeReport:
    since: str
    until: str
    commits: list[CommitInfo] = field(default_factory=list)
    new_files: list[str] = field(default_factory=list)
    modified_files: list[str] = field(default_factory=list)
    deleted_files: list[str] = field(default_factory=list)
    renamed_files: list[tuple[str, str]] = field(default_factory=list)
    touched_features: list[dict] = field(default_factory=list)
    orphan_modified: list[str] = field(default_factory=list)
    orphan_new: list[str] = field(default_factory=list)
    deleted_in_features: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = {
            "since": self.since,
            "until": self.until,
            "commits": [asdict(c) for c in self.commits],
            "new_files": self.new_files,
            "modified_files": self.modified_files,
            "deleted_files": self.deleted_files,
            "renamed_files": [list(r) for r in self.renamed_files],
            "touched_features": self.touched_features,
            "orphan_modified": self.orphan_modified,
            "orphan_new": self.orphan_new,
            "deleted_in_features": self.deleted_in_features,
        }
        return d


def _normalize(p: str) -> str:
    return p.replace("\\", "/").lstrip("./")


def _file_matches(feature_file: str, changed: str) -> bool:
    f = _normalize(feature_file)
    c = _normalize(changed)
    if f.endswith("/"):
        return c.startswith(f)
    return c == f or c.startswith(f.rstrip("/") + "/")


def analyze(since: str, until: str,
            *, commits_override: list[str] | None = None,
            features_path: Path = Path("qa-ui-auto-tests/feature-list.md")
            ) -> RangeChangeReport:
    if commits_override is not None:
        commit_shas = commits_override
    else:
        commit_shas = _list_commits(since, until)

    commits = [_commit_meta(sha) for sha in commit_shas]

    # Collapse all per-commit changes into 4 buckets, latest wins:
    #   added → set, removed if later modified+deleted = deleted, etc.
    added: set[str] = set()
    modified: set[str] = set()
    deleted: set[str] = set()
    renamed: list[tuple[str, str]] = []
    for c in commits:
        for f in c.files_added:
            added.add(f); deleted.discard(f)
        for f in c.files_modified:
            if f not in added:
                modified.add(f)
        for f in c.files_deleted:
            added.discard(f); modified.discard(f); deleted.add(f)
        renamed.extend(c.files_renamed)

    feats = load_features(features_path)

    touched_features: list[dict] = []
    deleted_in_features: list[dict] = []
    matched_files_by_feature: dict[str, list[str]] = {}
    feature_files_set: set[str] = set()

    for f in feats:
        feature_files_set.update(f.files)
        modified_hits = [c for c in modified if any(_file_matches(ff, c) for ff in f.files)]
        added_hits = [c for c in added if any(_file_matches(ff, c) for ff in f.files)]
        deleted_hits = [c for c in deleted if any(_file_matches(ff, c) for ff in f.files)]
        if modified_hits or added_hits:
            touched_features.append({
                "id": f.id, "title": f.title, "status": f.status,
                "matching_modified": sorted(modified_hits),
                "matching_added": sorted(added_hits),
            })
            matched_files_by_feature[f.id] = sorted(modified_hits + added_hits)
        if deleted_hits:
            deleted_in_features.append({
                "id": f.id, "title": f.title, "status": f.status,
                "matching_deleted": sorted(deleted_hits),
            })

    claimed_files = {c for hits in matched_files_by_feature.values() for c in hits}
    orphan_new = sorted(c for c in added if c not in claimed_files
                        and not any(_file_matches(ff, c) for ff in feature_files_set))
    orphan_modified = sorted(c for c in modified if c not in claimed_files
                             and not any(_file_matches(ff, c) for ff in feature_files_set))

    return RangeChangeReport(
        since=since, until=until, commits=commits,
        new_files=sorted(added),
        modified_files=sorted(modified),
        deleted_files=sorted(deleted),
        renamed_files=renamed,
        touched_features=touched_features,
        orphan_modified=orphan_modified,
        orphan_new=orphan_new,
        deleted_in_features=deleted_in_features,
    )


def render_text(r: RangeChangeReport) -> str:
    out: list[str] = []
    out.append(f"range: {r.since}..{r.until}")
    out.append(f"commits: {len(r.commits)}")
    for c in r.commits:
        out.append(f"  {c.short_sha} {c.author_date[:10]} {c.subject[:80]}")
    out.append("")
    out.append(f"== Touched features ({len(r.touched_features)})")
    if not r.touched_features:
        out.append("  (none)")
    for t in r.touched_features:
        out.append(f"  • {t['id']}  [{t['status']}]  {t['title']}")
        for f in t["matching_added"]:
            out.append(f"      A {f}")
        for f in t["matching_modified"]:
            out.append(f"      M {f}")
    out.append("")
    out.append(f"== Orphan NEW files ({len(r.orphan_new)}) — likely new features to add")
    for f in r.orphan_new:
        out.append(f"  + {f}")
    out.append("")
    out.append(f"== Orphan MODIFIED files ({len(r.orphan_modified)}) — features may need extending")
    for f in r.orphan_modified:
        out.append(f"  ~ {f}")
    out.append("")
    out.append(f"== DELETED files in known features ({len(r.deleted_in_features)})")
    for d in r.deleted_in_features:
        out.append(f"  • {d['id']}  {d['title']}")
        for f in d["matching_deleted"]:
            out.append(f"      D {f}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.range_changes")
    ap.add_argument("--since", default=None,
                    help="git ref (commit/tag/date) to start from; "
                         "default tries origin/main → main → HEAD~1")
    ap.add_argument("--until", default="HEAD",
                    help="end of the range (default HEAD)")
    ap.add_argument("--commits", default=None,
                    help="comma-separated commit SHAs to analyze instead of a range")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if args.commits:
        commit_set = [c.strip() for c in args.commits.split(",") if c.strip()]
        for sha in commit_set:
            if not _resolve_ref(sha):
                print(f"range_changes: cannot resolve commit {sha}",
                      file=sys.stderr)
                return 2
        report = analyze(since=f"<commits {len(commit_set)}>",
                         until="<explicit>",
                         commits_override=commit_set,
                         features_path=Path(args.features))
    else:
        try:
            since = args.since or _auto_since()
        except RuntimeError as e:
            print(f"range_changes: {e}", file=sys.stderr)
            return 2
        if not _resolve_ref(since):
            # Maybe a date string; let git log handle it via --since flag.
            # Fall through: _list_commits will fail with a clear message.
            pass
        if not _resolve_ref(args.until):
            print(f"range_changes: cannot resolve --until {args.until}",
                  file=sys.stderr)
            return 2
        try:
            report = analyze(since=since, until=args.until,
                             features_path=Path(args.features))
        except subprocess.CalledProcessError as e:
            print(f"range_changes: git log failed: {e}", file=sys.stderr)
            return 2

    if args.json:
        print(json.dumps(report.as_dict(), indent=2, ensure_ascii=False))
    else:
        print(render_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
