"""Config loading and ${cfg.x.y}/${env.X} placeholder substitution.

Note the syntax change from the legacy DSL:

    legacy:  ${cfg:ssh.host}   ${env:QA_SSH_PASSWORD}
    new:     ${cfg.ssh.host}   ${env.QA_SSH_PASSWORD}

Dot-only is consistent with how the rest of the YAML (`covers: [F4.1]`,
`assert_pattern: {regex: '...'}`) reads. The runner accepts both for now
so half-migrated trees keep working; the lint step normalizes to dots.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml

ROOT = Path.cwd()
PLACEHOLDER = re.compile(r"\$\{(cfg|env)[.:]([A-Za-z0-9_.\-]+)\}")


def _walk(value: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if isinstance(value, str):
        for m in PLACEHOLDER.finditer(value):
            out.append((m.group(1), m.group(2)))
    elif isinstance(value, dict):
        for v in value.values():
            out.extend(_walk(v))
    elif isinstance(value, list):
        for v in value:
            out.extend(_walk(v))
    return out


def load_config(path: Path | str = "qa-ui-auto-tests/qa-ui-auto.config.yaml") -> dict:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"qa-ui-auto.config.yaml not found at {p}. "
            "Copy .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml to qa-ui-auto-tests/."
        )
    cfg = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    cfg.setdefault("app", {}).setdefault("base_url", "http://localhost:5000")
    cfg["app"].setdefault("mode", "browser")
    cfg.setdefault("report", {}).setdefault("dir", "qa-ui-auto-report")
    cfg["report"].setdefault("keep_runs", 5)
    cfg.setdefault("worker", {}).setdefault("parallel", 4)
    return cfg


def resolve(value: Any, *, cfg: dict, env: dict[str, str] | None = None) -> Any:
    """Recursively replace ${cfg.x.y} and ${env.X} placeholders.

    Strict: missing keys raise KeyError so a half-configured run fails fast.
    """
    if env is None:
        env = dict(os.environ)
    if isinstance(value, str):
        def repl(m: re.Match[str]) -> str:
            kind, key = m.group(1), m.group(2)
            if kind == "cfg":
                cur: object = cfg
                for part in key.split("."):
                    if not isinstance(cur, dict) or part not in cur:
                        raise KeyError(f"config key not found: {key}")
                    cur = cur[part]
                return str(cur)
            if kind == "env":
                if key not in env:
                    raise KeyError(f"env var not set: {key}")
                return env[key]
            return m.group(0)
        return PLACEHOLDER.sub(repl, value)
    if isinstance(value, dict):
        return {k: resolve(v, cfg=cfg, env=env) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, cfg=cfg, env=env) for v in value]
    return value


def find_placeholders(value: Any) -> list[tuple[str, str]]:
    """Discover all (kind, key) pairs referenced inside a structure."""
    return _walk(value)
