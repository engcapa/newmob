#!/usr/bin/env python3
"""Parse `testcase-for-auto.md` into structured test cases.

File format (see SKILL.md for the spec):

    ## TC-<id>: <title>
    - tags: smoke, p0
    - mode: browser

    1. open http://localhost:5000
    2. click role=button[name="Connect"]
    3. expect_visible text="Connected"
    4. screenshot connected.png

A blank line and the next `## TC-` header end a case.
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

VERBS = {
    "open", "goto", "click", "dblclick", "type", "press", "fill", "select",
    "wait", "wait_for", "expect_visible", "expect_text", "expect_url",
    "screenshot", "eval", "sleep",
}

TC_HEADER = re.compile(r"^##\s+(TC-[\w\-]+)\s*:\s*(.+?)\s*$")
META_LINE = re.compile(r"^-\s*(\w+)\s*:\s*(.+?)\s*$")
STEP_LINE = re.compile(r"^\d+\.\s+(.+?)\s*$")


@dataclass
class Step:
    verb: str
    args: list[str] = field(default_factory=list)
    raw: str = ""

    def __str__(self) -> str:
        return self.raw


@dataclass
class TestCase:
    id: str
    title: str
    tags: list[str] = field(default_factory=list)
    mode: str = "browser"
    steps: list[Step] = field(default_factory=list)


def _parse_step(line: str) -> Step:
    parts = shlex.split(line, posix=True)
    if not parts:
        raise ValueError(f"empty step: {line!r}")
    verb = parts[0]
    if verb not in VERBS:
        raise ValueError(f"unknown verb {verb!r} in step: {line!r}")
    return Step(verb=verb, args=parts[1:], raw=line)


def parse(path: Path) -> list[TestCase]:
    text = path.read_text(encoding="utf-8")
    cases: list[TestCase] = []
    current: TestCase | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        m = TC_HEADER.match(line)
        if m:
            if current is not None:
                cases.append(current)
            current = TestCase(id=m.group(1), title=m.group(2))
            continue
        if current is None:
            continue
        m = META_LINE.match(line)
        if m:
            key, val = m.group(1).lower(), m.group(2)
            if key == "tags":
                current.tags = [t.strip() for t in val.split(",") if t.strip()]
            elif key == "mode":
                current.mode = val.strip()
            continue
        m = STEP_LINE.match(line)
        if m:
            current.steps.append(_parse_step(m.group(1)))
            continue
        # Free-form prose between steps is ignored.
    if current is not None:
        cases.append(current)
    return cases


def substitute(value: str, cfg: dict, env: dict) -> str:
    """Resolve ${cfg:a.b.c} and ${env:VAR} placeholders inside a single arg."""
    def cfg_get(path: str) -> str:
        cur: object = cfg
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                raise KeyError(f"config key not found: {path}")
            cur = cur[part]
        return str(cur)

    def repl(m: re.Match[str]) -> str:
        kind, key = m.group(1), m.group(2)
        if kind == "cfg":
            return cfg_get(key)
        if kind == "env":
            if key not in env:
                raise KeyError(f"env var not set: {key}")
            return env[key]
        return m.group(0)

    return re.sub(r"\$\{(cfg|env):([^}]+)\}", repl, value)


def resolve_step(step: Step, cfg: dict, env: dict) -> Step:
    return Step(verb=step.verb,
                args=[substitute(a, cfg, env) for a in step.args],
                raw=step.raw)


if __name__ == "__main__":
    import json, sys
    cases = parse(Path(sys.argv[1] if len(sys.argv) > 1 else "testcase-for-auto.md"))
    print(json.dumps([{
        "id": c.id, "title": c.title, "tags": c.tags, "mode": c.mode,
        "steps": [s.raw for s in c.steps]
    } for c in cases], indent=2, ensure_ascii=False))
