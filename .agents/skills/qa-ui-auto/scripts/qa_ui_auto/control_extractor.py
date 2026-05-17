#!/usr/bin/env python3
"""Static extractor: scan a .tsx/.ts(x) file and emit a `controls:` draft.

For a given component file (or a directory), produce a YAML block that can
be pasted under a feature's frontmatter in `qa-ui-auto-tests/feature-list.md`.
The output is *always a draft* — humans review which entries to keep, mark
optional/conditional ones, drop noise (decorative aria-labels, internal
state-only testids), and decide kind (interactive vs display).

Detection heuristics, in priority order (first match wins per element):

1. `data-testid="x"`
   selector: `[data-testid="x"]`
   id slug:  derived from x (drop `welcome-` prefix duplicates etc. is left
             to the human reviewer; we keep x literally).

2. `aria-label="X"` on a `<button>`/`<select>`/`<input>`
   selector: `<tag>[aria-label="X"]`

3. Bare `<button>` / `<select>` / `<input>` with stable inner text or `title=`
   selector: prefer `text="..."` when an obvious string literal child exists,
             otherwise emit a TODO so the reviewer fixes it.

Output structure:

    controls:
      - id: <slug>
        selector: '<selector>'
        kind: interactive   # or display, reviewer decides
        # source: WelcomePanel.tsx:312
        # raw: <button data-testid="welcome-open-local-terminal" ...>

Calling:

    python -m qa_ui_auto.control_extractor src/components/WelcomePanel.tsx
    python -m qa_ui_auto.control_extractor src/components/WelcomePanel.tsx --merge F1.6
        # prints a unified-diff-style suggestion against the current frontmatter

This module performs NO LLM calls. It is deterministic regex/AST-lite work.
JSX is parsed with a forgiving tag-finder, not a full TypeScript parser.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

# Tags whose children we treat as UI controls by default. Plain <div>/<span>
# are excluded — they are containers; only flag them if they carry a testid.
INTERACTIVE_TAGS = {"button", "select", "input", "textarea", "a"}
DISPLAY_HINT_TAGS = {"ul", "ol", "table", "section", "header", "footer", "nav", "h1", "h2", "h3"}

# Match <Tag ...> ... </Tag> (single-line attrs only — JSX in this repo wraps
# attributes across lines, so we glue lines together before matching).
TAG_OPEN_RE = re.compile(
    r"<(?P<tag>[A-Za-z][A-Za-z0-9]*)\b(?P<attrs>[^>]*?)(?P<self>/)?>",
    re.DOTALL,
)
ATTR_RE = re.compile(
    r"""(?P<key>[A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""",
    re.DOTALL,
)


@dataclass
class ExtractedControl:
    id: str
    selector: str
    kind: str = "interactive"     # interactive | display
    optional: bool = False
    source_line: int = 0
    raw_tag: str = ""
    note: str = ""

    def to_yaml_lines(self, indent: str = "  ") -> list[str]:
        lines = [
            f"{indent}- id: {self.id}",
            f"{indent}  selector: '{self.selector}'",
            f"{indent}  kind: {self.kind}",
        ]
        if self.optional:
            lines.append(f"{indent}  optional: true")
        if self.source_line:
            lines.append(f"{indent}  # source: {self.source_line}")
        return lines


@dataclass
class ExtractReport:
    file: Path
    controls: list[ExtractedControl] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _slugify(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s or "control"


def _parse_attrs(attrs_text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in ATTR_RE.finditer(attrs_text):
        out[m.group("key")] = m.group("val")
    return out


def _is_conditional_render(text: str, tag_offset: int) -> bool:
    """Quick heuristic: if the immediately preceding non-whitespace context
    is `&&` or a ternary `?`, treat the element as conditional → optional.

    Walks back ~120 chars to find a `&&` or `?` not inside a string literal.
    Cheap, occasionally wrong; reviewer adjusts.
    """
    window = text[max(0, tag_offset - 120):tag_offset]
    # Strip JSX braces' inner content roughly to avoid false positives from
    # template strings — good enough for this static heuristic.
    return bool(re.search(r"(\{[^}]*\?[^}]*$)|(&&\s*$)", window))


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _emit_for_testid(testid: str, tag: str, line: int, raw: str,
                    optional: bool) -> ExtractedControl:
    selector = f'[data-testid="{testid}"]'
    kind = "interactive" if tag.lower() in INTERACTIVE_TAGS else "display"
    return ExtractedControl(
        id=_slugify(testid),
        selector=selector,
        kind=kind,
        optional=optional,
        source_line=line,
        raw_tag=raw,
    )


def _emit_for_aria(label: str, tag: str, line: int, raw: str,
                   optional: bool) -> ExtractedControl:
    tag_l = tag.lower()
    selector = f'{tag_l}[aria-label="{label}"]'
    kind = "interactive" if tag_l in INTERACTIVE_TAGS else "display"
    return ExtractedControl(
        id=_slugify(label),
        selector=selector,
        kind=kind,
        optional=optional,
        source_line=line,
        raw_tag=raw,
    )


def extract_from_text(text: str, source: str = "<input>") -> ExtractReport:
    rep = ExtractReport(file=Path(source))
    seen_ids: set[str] = set()

    for m in TAG_OPEN_RE.finditer(text):
        tag = m.group("tag")
        attrs_text = m.group("attrs") or ""
        # Restrict to lowercase HTML-ish tags AND custom tags that contain
        # interesting attrs. Skip pure component tags (PascalCase) unless
        # they carry data-testid / aria-label.
        attrs = _parse_attrs(attrs_text)
        testid = attrs.get("data-testid")
        aria = attrs.get("aria-label")
        if not testid and not aria:
            continue
        # PascalCase components (e.g. <ActionCard>) without a testid we skip
        # because their final DOM element is unknowable from static text.
        if tag[0].isupper() and not testid:
            continue

        line = _line_of(text, m.start())
        optional = _is_conditional_render(text, m.start())
        raw = m.group(0).strip()
        if len(raw) > 120:
            raw = raw[:117] + "..."

        ctrl: ExtractedControl
        if testid:
            ctrl = _emit_for_testid(testid, tag, line, raw, optional)
        else:
            ctrl = _emit_for_aria(aria or "", tag, line, raw, optional)

        # de-dup on (id, selector); first occurrence wins, drop dupes silently
        key = (ctrl.id, ctrl.selector)
        if key in seen_ids:
            continue
        seen_ids.add(key)
        rep.controls.append(ctrl)

    rep.controls.sort(key=lambda c: c.source_line)
    return rep


def extract_from_path(path: Path) -> ExtractReport:
    if path.is_dir():
        # join all .tsx files in the dir
        chunks = []
        for p in sorted(path.rglob("*.tsx")):
            chunks.append(p.read_text(encoding="utf-8"))
        text = "\n".join(chunks)
    else:
        text = path.read_text(encoding="utf-8")
    return extract_from_text(text, source=str(path))


def render_yaml(rep: ExtractReport) -> str:
    if not rep.controls:
        return f"# extractor: no testid/aria-label found in {rep.file}\ncontrols: []\n"
    lines = [f"# extractor draft from {rep.file} ({len(rep.controls)} controls)",
             "# review: drop noise, fix kind (interactive vs display), confirm `optional`.",
             "controls:"]
    for c in rep.controls:
        lines.extend(c.to_yaml_lines())
    return "\n".join(lines) + "\n"


def diff_against_feature(rep: ExtractReport, feature_id: str) -> str:
    """Compare extracted controls vs the feature's recorded controls.

    Outputs a triage report:
      + extractor found something not in feature.controls
      - feature.controls has something the extractor didn't find (deleted? renamed?)
      = matched
    """
    from qa_ui_auto.feature_catalog import load_features
    feats = load_features()
    feat = next((f for f in feats if f.id == feature_id), None)
    if not feat:
        return f"# feature {feature_id} not found in feature-list.md\n"

    extractor_keys = {c.selector for c in rep.controls}
    feature_keys = {c.selector for c in feat.controls}
    only_extractor = sorted(extractor_keys - feature_keys)
    only_feature = sorted(feature_keys - extractor_keys)
    matched = sorted(extractor_keys & feature_keys)

    out: list[str] = [
        f"# diff for {feature_id} ({feat.title})",
        f"#   extractor: {len(extractor_keys)} controls",
        f"#   feature:   {len(feature_keys)} controls",
        f"#   matched:   {len(matched)}",
    ]
    if only_extractor:
        out.append("")
        out.append("# only in extractor (consider adding to feature.controls):")
        for sel in only_extractor:
            ctrl = next(c for c in rep.controls if c.selector == sel)
            out.append(f"+ {ctrl.id:<28} {sel}")
    if only_feature:
        out.append("")
        out.append("# only in feature.controls (extractor didn't find — renamed/deleted/text-based?):")
        for sel in only_feature:
            ctrl = next(c for c in feat.controls if c.selector == sel)
            out.append(f"- {ctrl.id:<28} {sel}")
    if not (only_extractor or only_feature):
        out.append("")
        out.append("# selector sets agree.")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.control_extractor")
    ap.add_argument("path", help="path to .tsx file or directory")
    ap.add_argument("--merge", default=None,
                    help="diff extractor output against feature ID's controls "
                         "(e.g. --merge F1.6)")
    args = ap.parse_args(argv)

    p = Path(args.path)
    if not p.exists():
        print(f"control_extractor: not found: {p}", file=sys.stderr)
        return 2

    rep = extract_from_path(p)
    if args.merge:
        sys.stdout.write(diff_against_feature(rep, args.merge))
    else:
        sys.stdout.write(render_yaml(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
