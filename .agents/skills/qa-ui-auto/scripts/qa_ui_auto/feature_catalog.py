#!/usr/bin/env python3
"""Parse qa-ui-auto-tests/feature-list.md → in-memory feature catalog.

Replaces the old `tests/features.yaml`. The single source of truth is now
the human-authored `feature-list.md` with embedded HTML-comment YAML
frontmatter blocks of the form:

    ### 4.10 Z-modem 文件收发（rz / sz）

    <!-- feature
    id: F4.10
    status: done
    area: terminal/file-transfer
    components: [TerminalPanel, ZmodemConflictDialog]
    files:
      - src/lib/zmodem.ts
      - src/components/terminal/ZmodemConflictDialog.tsx
    -->

    - 基于 `zmodem.js` 的 `Sentry` 实现协议检测...

The frontmatter is invisible in rendered Markdown. Sections without a
frontmatter block are skipped (they are descriptive subsections, not
features in their own right).

Usage as a library:

    from qa_ui_auto.feature_catalog import load_features
    features = load_features()  # list[Feature]
    by_id = {f.id: f for f in features}

CLI:

    python -m qa_ui_auto.feature_catalog                    # text summary
    python -m qa_ui_auto.feature_catalog --json             # machine-readable
    python -m qa_ui_auto.feature_catalog --feature F4.10    # one entry detail
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any

import yaml


DEFAULT_PATH = Path("qa-ui-auto-tests/feature-list.md")
FEATURE_BLOCK = re.compile(r"<!--\s*feature\s*\n(.*?)-->", re.DOTALL)
ID_PATTERN = re.compile(r"^F[0-9]+(?:\.[0-9]+)*[a-z]?$")


@dataclass
class Feature:
    id: str
    title: str
    status: str = "done"           # done | partial | todo
    area: str = ""
    components: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    section_title: str = ""        # raw heading like "### 4.10 Z-modem ..."
    line: int = 0                  # 1-based line number of the heading

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class FeatureCatalogError(RuntimeError):
    """Raised on malformed feature-list.md (duplicate ids, bad YAML, etc.)."""


def _find_preceding_heading(lines: list[str], block_start: int) -> tuple[str, int]:
    """Walk back from block_start to find the nearest H2/H3/H4 heading."""
    for i in range(block_start - 1, -1, -1):
        line = lines[i].rstrip()
        if re.match(r"^#{2,4}\s+\S", line):
            return line, i + 1   # 1-based line number
    return "", 0


def _heading_title(heading: str) -> str:
    """'### 4.10 Z-modem 文件收发（rz / sz）✅' → 'Z-modem 文件收发（rz / sz）'.

    Strip leading hashes, an optional section number like '4.10' or '4.10.1',
    and trailing status emoji (✅/🟡/❌).
    """
    s = re.sub(r"^#+\s*", "", heading.strip())
    s = re.sub(r"^[\d.]+\s+", "", s)
    s = re.sub(r"\s*[✅🟡❌]+\s*$", "", s)
    return s.strip()


def parse(text: str, *, source: str = "<input>") -> list[Feature]:
    """Extract Feature entries from feature-list.md text."""
    lines = text.splitlines()
    # Build a map from absolute char offset → line index for fast lookup.
    char_to_line: list[int] = []
    pos = 0
    for i, line in enumerate(lines):
        char_to_line.extend([i] * (len(line) + 1))   # +1 for newline
        pos += len(line) + 1
    char_to_line.append(len(lines))   # safety pad

    features: list[Feature] = []
    seen_ids: dict[str, int] = {}

    for m in FEATURE_BLOCK.finditer(text):
        block_body = m.group(1)
        block_start_offset = m.start()
        block_start_line = (
            char_to_line[block_start_offset]
            if block_start_offset < len(char_to_line) else 0
        )
        try:
            doc = yaml.safe_load(block_body) or {}
        except yaml.YAMLError as e:
            raise FeatureCatalogError(
                f"{source}: malformed YAML in <!-- feature --> at line "
                f"{block_start_line + 1}: {e}"
            ) from e

        if not isinstance(doc, dict):
            raise FeatureCatalogError(
                f"{source}: <!-- feature --> at line {block_start_line + 1} "
                "must be a YAML mapping"
            )

        fid = doc.get("id")
        if not fid or not ID_PATTERN.match(str(fid)):
            raise FeatureCatalogError(
                f"{source}: missing/invalid `id` in <!-- feature --> at "
                f"line {block_start_line + 1}: {fid!r}"
            )

        if fid in seen_ids:
            raise FeatureCatalogError(
                f"{source}: duplicate feature id {fid!r} "
                f"(also at line {seen_ids[fid]})"
            )
        seen_ids[fid] = block_start_line + 1

        heading, heading_line = _find_preceding_heading(lines, block_start_line)
        title = doc.get("title") or _heading_title(heading) or fid

        feat = Feature(
            id=str(fid),
            title=str(title),
            status=str(doc.get("status", "done")),
            area=str(doc.get("area", "")),
            components=[str(x) for x in (doc.get("components") or [])],
            files=[str(x) for x in (doc.get("files") or [])],
            section_title=heading.strip(),
            line=heading_line,
        )
        features.append(feat)

    return features


def load_features(path: Path | str = DEFAULT_PATH) -> list[Feature]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"feature-list.md not found at {p}")
    return parse(p.read_text(encoding="utf-8"), source=str(p))


# Back-compat shim for code that previously did
#   yaml.safe_load(features_path)["features"]
# Returns a dict shaped like the old features.yaml.
def load_as_legacy_dict(path: Path | str = DEFAULT_PATH) -> dict[str, Any]:
    feats = load_features(path)
    return {
        "version": "0.2",
        "source": str(path),
        "features": [f.as_dict() for f in feats],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.feature_catalog")
    ap.add_argument("--features", default=str(DEFAULT_PATH))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--feature", default=None)
    args = ap.parse_args(argv)

    try:
        feats = load_features(args.features)
    except (FileNotFoundError, FeatureCatalogError) as e:
        print(f"feature_catalog: {e}", file=sys.stderr)
        return 2

    if args.feature:
        match = next((f for f in feats if f.id == args.feature), None)
        if not match:
            print(f"feature_catalog: not found: {args.feature}", file=sys.stderr)
            return 2
        print(json.dumps(match.as_dict(), indent=2, ensure_ascii=False)
              if args.json else _detail(match))
        return 0

    if args.json:
        print(json.dumps([f.as_dict() for f in feats], indent=2, ensure_ascii=False))
    else:
        print(f"qa-ui-auto-tests/feature-list.md → {len(feats)} feature(s)")
        for f in feats:
            print(f"  {f.id:<8} [{f.status:<7}] {f.title}  (area={f.area or '-'})")
    return 0


def _detail(f: Feature) -> str:
    out = [
        f"id:      {f.id}",
        f"title:   {f.title}",
        f"status:  {f.status}",
        f"area:    {f.area}",
        f"section: {f.section_title}",
        f"line:    {f.line}",
        f"components: {', '.join(f.components) or '(none)'}",
        f"files:",
    ]
    out += [f"  - {fp}" for fp in f.files] or ["  (none)"]
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(main())
