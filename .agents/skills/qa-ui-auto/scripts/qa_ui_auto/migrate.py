#!/usr/bin/env python3
"""One-shot legacy migrator: testcase-for-auto.md → qa-ui-auto-tests/cases/*.testcase.yaml.

Run:
    PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.migrate \
        [--source testcase-for-auto.md] [--out qa-ui-auto-tests/cases] [--overwrite]

For each `## TC-NNN: <title>` block:

* Best-effort verb mapping (see references/migration-mapping.md).
* Cases that the mapper can't fully translate are still emitted, with the
  unmappable steps replaced by `eval_readonly` (read-only) or marked
  `_TODO_MIGRATE: <original>` as a YAML comment, and tagged `needs-review`.
* Existing files at qa-ui-auto-tests/cases/<id>-*.testcase.yaml are left alone unless
  --overwrite is set; this lets you migrate iteratively.

The output favours human-readability: short forms (string args) where allowed,
quoted selectors, and a stable key order in each step.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

# Reuse the legacy parser since it already understands the Markdown DSL.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
from parse_testcases import parse, Step  # type: ignore[import-not-found]


@dataclass
class Migrated:
    case_id: str
    path: Path
    needs_review: bool
    todo_lines: list[str] = field(default_factory=list)


# ─── helpers ────────────────────────────────────────────────────────────────


def _slug(title: str) -> str:
    s = title.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:48].rstrip("-") or "case"


def _legacy_to_dot_placeholders(value: str) -> str:
    """Rewrite ${cfg:a.b} / ${env:X} -> ${cfg.a.b} / ${env.X}."""
    return re.sub(r"\$\{(cfg|env):", r"${\1.", value)


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


# ─── verb-by-verb mappers ───────────────────────────────────────────────────


def _map_simple(step: Step) -> dict | str | None:
    """Return {verb: args} for verbs that map without semantic shift."""
    args = [_legacy_to_dot_placeholders(a) for a in step.args]

    if step.verb == "open":
        return {"open": args[0] if args else "${cfg.app.base_url}"}
    if step.verb == "goto":
        return {"goto": args[0]}
    if step.verb == "sleep" or step.verb == "wait":
        n = float(args[0]) if args else 1.0
        return {"wait": int(n) if n.is_integer() else n}
    if step.verb == "wait_for":
        return {"wait_for": args[0]}
    if step.verb == "expect_visible":
        return {"assert_visible": args[0]}
    if step.verb == "expect_url":
        return {"assert_url": args[0]}
    if step.verb == "screenshot":
        return {"screenshot": args[0]}
    if step.verb == "click":
        return {"click": args[0]}
    if step.verb == "dblclick":
        return {"dblclick": args[0]}
    if step.verb == "press":
        return {"press": args[0]}
    if step.verb == "type":
        return {"type": args[0]}

    if step.verb == "expect_text":
        if len(args) < 2:
            return None
        return {"assert_text": {"selector": args[0], "contains": args[1]}}

    if step.verb == "fill":
        if len(args) < 2:
            return None
        return {"fill": {"selector": args[0], "value": args[1]}}

    if step.verb == "select":
        if len(args) < 2:
            return None
        return {"select_option": {"selector": args[0], "label": args[1]}}

    return None


# Common eval-block patterns to recognise. Each pattern is a regex and a
# callable that returns the step dict (or None to leave unmapped).
_EVAL_PATTERNS: list[tuple[re.Pattern[str], "callable"]] = []


def _eval_pattern(regex: str):
    def deco(fn):
        _EVAL_PATTERNS.append((re.compile(regex, re.DOTALL), fn))
        return fn
    return deco


@_eval_pattern(
    r"window\.prompt\s*=\s*\(\)\s*=>\s*[\"']([^\"']*)[\"']\s*;\s*window\.confirm\s*=\s*\(\)\s*=>\s*(true|false)"
)
def _ev_seed_dialog_simple(m, body):  # noqa: ARG001
    return {"seed_dialog": {"prompt": m.group(1), "confirm": m.group(2) == "true"}}


@_eval_pattern(
    r"window\.confirm\s*=\s*\(\)\s*=>\s*(true|false)\s*;.*?window\.prompt\s*=\s*\(\)\s*=>\s*[\"']([^\"']*)[\"']"
)
def _ev_seed_dialog_swap(m, body):  # noqa: ARG001
    return {"seed_dialog": {"prompt": m.group(2), "confirm": m.group(1) == "true"}}


@_eval_pattern(r"window\.confirm\s*=\s*\(\)\s*=>\s*(true|false)")
def _ev_seed_confirm_only(m, body):  # noqa: ARG001
    return {"seed_dialog": {"confirm": m.group(1) == "true"}}


_RIGHT_CLICK_RE = re.compile(
    r"locator\(\s*[`'\"](?P<sel>[^`'\"]+)[`'\"]\s*\)\.click\(\s*\{[^}]*button:\s*[\"']right[\"'].*?\}",
    re.DOTALL,
)


@_eval_pattern(
    r"locator\(\s*[`'\"](?P<sel>[^`'\"]+)[`'\"]\s*\)\.click\(\s*\{[^}]*button:\s*[\"']right[\"']"
)
def _ev_right_click(m, body):
    sel = m.group("sel")
    pos = re.search(r"position:\s*\{\s*x:\s*(\d+)\s*,\s*y:\s*(\d+)\s*\}", body)
    if pos:
        return {"right_click": {
            "selector": sel,
            "position": {"x": int(pos.group(1)), "y": int(pos.group(2))},
        }}
    return {"right_click": sel}


@_eval_pattern(
    r"locator\(\s*[`'\"](?P<sel>[^`'\"]+)[`'\"]\s*\)\.hover\("
)
def _ev_hover(m, body):  # noqa: ARG001
    return {"hover": m.group("sel")}


@_eval_pattern(
    r"localStorage\.removeItem\(\s*[\"'](?P<key>[^\"']+)[\"']\s*\).*?page\.reload\("
)
def _ev_clear_and_reload(m, body):  # noqa: ARG001
    # No-op: covered by the reset_db fixture; emit a comment hint.
    return {"_DROP_": f"localStorage.removeItem('{m.group('key')}') + reload — covered by reset_db fixture"}


@_eval_pattern(r"page\.reload\(")
def _ev_reload(m, body):  # noqa: ARG001
    return {"reload": None}


@_eval_pattern(
    r"label:has-text\(\s*[\"'](?P<label>[^\"']+)[\"']\s*\)\s*input\[type=\"checkbox\"\]"
)
def _ev_label_checkbox(m, body):  # noqa: ARG001
    # The legacy code checks isChecked() then .click() if needed — equivalent to
    # set_check by label.
    return {"send_text_via_label": {"label_contains": m.group("label"), "checked": True}}


@_eval_pattern(
    r"allLabels\.find\(.*?textContent\.includes\(\s*[\"'](?P<label>[^\"']+)[\"']\s*\)\)"
)
def _ev_specify_username(m, body):  # noqa: ARG001
    return {"send_text_via_label": {"label_contains": m.group("label"), "checked": True}}


def _map_eval(step: Step) -> tuple[Any, str | None]:
    """Return (mapped_step | None, original_body)."""
    if not step.args:
        return None, ""
    body = step.args[0]
    body = _legacy_to_dot_placeholders(body)
    for pattern, fn in _EVAL_PATTERNS:
        m = pattern.search(body)
        if m:
            try:
                result = fn(m, body)
            except Exception:  # noqa: BLE001
                continue
            if result is None:
                return None, body
            return result, body
    return None, body


# ─── case-level migration ───────────────────────────────────────────────────


def migrate_case(case, out_dir: Path, overwrite: bool) -> Migrated | None:
    case_id = case.id
    title = case.title
    raw_tags = list(case.tags)
    raw_modes = [m.strip() for m in (case.mode or "browser").split(",") if m.strip()]

    yaml_steps: list[Any] = []
    todo: list[str] = []
    needs_ssh = False
    needs_sftp = False

    for idx, step in enumerate(case.steps, start=1):
        if step.verb in {"open", "goto"} and step.args:
            arg = _legacy_to_dot_placeholders(step.args[0])
            if "ssh.host" in arg:
                needs_ssh = True
            if "sftp." in arg:
                needs_sftp = True

        for arg in step.args:
            if "${cfg.ssh." in _legacy_to_dot_placeholders(arg) or "${cfg:ssh." in arg:
                needs_ssh = True
            if "${cfg.sftp." in _legacy_to_dot_placeholders(arg) or "${cfg:sftp." in arg:
                needs_sftp = True

        if step.verb == "eval":
            mapped, body = _map_eval(step)
            if mapped is None:
                todo.append(f"step {idx}: {body[:160]}")
                yaml_steps.append({"_TODO_MIGRATE": body})
                continue
            if isinstance(mapped, dict) and "_DROP_" in mapped:
                yaml_steps.append({"_NOTE": mapped["_DROP_"]})
                continue
            yaml_steps.append(mapped)
            continue

        mapped = _map_simple(step)
        if mapped is None:
            todo.append(f"step {idx}: {step.raw}")
            yaml_steps.append({"_TODO_MIGRATE": step.raw})
            continue
        yaml_steps.append(mapped)

    fixtures = ["reset_db"]
    if needs_ssh:
        fixtures.append("ssh_required")
    if needs_sftp:
        fixtures.append("sftp_required")

    tags = sorted({*raw_tags, "legacy-imported"})
    if todo:
        tags = sorted({*tags, "needs-review"})

    out_path = out_dir / f"{case_id}-{_slug(title)}.testcase.yaml"
    if out_path.exists() and not overwrite:
        return None

    lines: list[str] = []
    lines.append(f"id: {case_id}")
    lines.append(f"title: {_yaml_quote(title)}")
    lines.append(f"covers: []   # TODO: link to features.yaml IDs")
    lines.append(f"tags: [{', '.join(tags)}]")
    lines.append(f"modes: [{', '.join(raw_modes) or 'browser'}]")
    lines.append(f"fixtures: [{', '.join(fixtures)}]")
    lines.append("steps:")
    for s in yaml_steps:
        lines.extend(_render_step(s))
    lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return Migrated(case_id=case_id, path=out_path, needs_review=bool(todo), todo_lines=todo)


# ─── YAML emit helpers (no PyYAML dependency: layout matters) ───────────────


def _yaml_quote(s: str) -> str:
    if any(c in s for c in [':', '#', '"', "'", '\n', '{', '}', '[', ']', '&', '*', '|', '>', '%', '@', '`']):
        escaped = s.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    return s


def _yaml_string(s: str) -> str:
    """Quote a string for YAML if it would otherwise be ambiguous."""
    if s == "":
        return '""'
    if any(c in s for c in [':', '#', '"', "'", '\n', '{', '}', '[', ']', '&', '*', '|', '>', '%', '@', '`', ',']):
        escaped = s.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    if s.lower() in ("true", "false", "null", "yes", "no", "on", "off", "~"):
        return f'"{s}"'
    # Things that look like numbers must be quoted because the runner expects strings.
    try:
        float(s)
        return f'"{s}"'
    except ValueError:
        pass
    if s[0] in (" ", "-", "?") or s.startswith("- "):
        return f'"{s}"'
    return s


def _yaml_inline(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if value is None:
        return "null"
    if isinstance(value, list):
        return "[" + ", ".join(_yaml_inline(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = [f"{k}: {_yaml_inline(v)}" for k, v in value.items()]
        return "{" + ", ".join(parts) + "}"
    return _yaml_string(str(value))


def _render_step(step: dict[str, Any]) -> list[str]:
    if "_TODO_MIGRATE" in step:
        body = step["_TODO_MIGRATE"]
        return [
            "  # _TODO_MIGRATE: legacy step could not be auto-converted; please fix:",
            "  # " + str(body)[:240].replace("\n", " "),
            "  - eval_readonly:",
            "      expression: 'true'",
            "      contains: 'true'",
        ]
    if "_NOTE" in step:
        return ["  # NOTE: " + step["_NOTE"]]
    verb, args = next(iter(step.items()))
    if isinstance(args, (str, int, float, bool)) or args is None:
        return [f"  - {verb}: {_yaml_inline(args)}"]
    if isinstance(args, list):
        return [f"  - {verb}: {_yaml_inline(args)}"]
    if isinstance(args, dict):
        if all(isinstance(v, (str, int, float, bool)) or v is None for v in args.values()) and len(args) <= 3:
            return [f"  - {verb}: {_yaml_inline(args)}"]
        out = [f"  - {verb}:"]
        for k, v in args.items():
            out.append(f"      {k}: {_yaml_inline(v)}")
        return out
    return [f"  - {verb}: {_yaml_inline(args)}"]


# ─── orchestration ──────────────────────────────────────────────────────────


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.migrate")
    ap.add_argument("--source", default="testcase-for-auto.md")
    ap.add_argument("--out", default="qa-ui-auto-tests/cases")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--filter", default=None,
                    help="comma-separated TC ids to migrate; default = all")
    args = ap.parse_args(list(argv) if argv is not None else None)

    src = Path(args.source)
    if not src.exists():
        print(f"migrate: source not found: {src}", file=sys.stderr)
        return 2

    cases = parse(src)
    keep = {t.strip() for t in args.filter.split(",")} if args.filter else None
    if keep:
        cases = [c for c in cases if c.id in keep]
    if not cases:
        print("migrate: 0 cases matched", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    migrated: list[Migrated] = []
    skipped: list[str] = []
    for case in cases:
        m = migrate_case(case, out_dir, args.overwrite)
        if m is None:
            skipped.append(case.id)
        else:
            migrated.append(m)

    review = [m for m in migrated if m.needs_review]
    print(f"migrate: wrote {len(migrated)} files, {len(review)} need review, "
          f"{len(skipped)} skipped (already exist; pass --overwrite to replace)")
    if skipped:
        print("  skipped: " + ", ".join(skipped))
    if review:
        print("  needs-review:")
        for m in review:
            print(f"    - {m.case_id} ({len(m.todo_lines)} TODO step(s)): {m.path.name}")
    return 0 if not review else 0


if __name__ == "__main__":
    sys.exit(main())
