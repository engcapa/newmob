"""Load and schema-validate testcase YAML files."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

try:
    import jsonschema  # type: ignore
except ImportError:  # pragma: no cover
    jsonschema = None  # type: ignore[assignment]

HERE = Path(__file__).resolve().parent
SCHEMA_DIR = HERE.parent.parent / "schema"
TESTCASE_SCHEMA_PATH = SCHEMA_DIR / "testcase.schema.json"


@dataclass
class TestCase:
    id: str
    title: str
    description: str = ""
    covers: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    modes: list[str] = field(default_factory=lambda: ["browser"])
    fixtures: list[str] = field(default_factory=list)
    timeout_sec: int = 90
    skip: str | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    source_path: Path | None = None

    def supports_mode(self, mode: str) -> bool:
        return mode in self.modes


def _load_schema(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator():
    if jsonschema is None:
        return None
    schema = _load_schema(TESTCASE_SCHEMA_PATH)
    return jsonschema.Draft202012Validator(schema)


def validate_doc(doc: dict, *, source: str) -> list[str]:
    """Return a list of human-readable validation errors (empty = ok)."""
    if jsonschema is None:
        return [f"{source}: jsonschema not installed; run `pip install jsonschema pyyaml`."]
    schema = _load_schema(TESTCASE_SCHEMA_PATH)
    validator = jsonschema.Draft202012Validator(schema)
    errors: list[str] = []
    for err in validator.iter_errors(doc):
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"{source}: {path}: {err.message}")
    return errors


def load_case(path: Path) -> TestCase:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: testcase must be a YAML mapping at the root")
    errors = validate_doc(raw, source=str(path))
    if errors:
        raise ValueError("\n".join(errors))
    raw.setdefault("modes", ["browser"])
    raw.setdefault("timeout_sec", 90)
    raw.setdefault("tags", [])
    raw.setdefault("covers", [])
    raw.setdefault("fixtures", [])
    return TestCase(
        id=raw["id"],
        title=raw["title"],
        description=raw.get("description", ""),
        covers=list(raw.get("covers", [])),
        tags=list(raw.get("tags", [])),
        modes=list(raw["modes"]),
        fixtures=list(raw.get("fixtures", [])),
        timeout_sec=int(raw["timeout_sec"]),
        skip=raw.get("skip"),
        steps=list(raw["steps"]),
        source_path=path,
    )


def discover(cases_dir: Path) -> list[TestCase]:
    """Return all *.testcase.yaml under cases_dir, sorted by id."""
    if not cases_dir.exists():
        return []
    cases: list[TestCase] = []
    for p in sorted(cases_dir.rglob("*.testcase.yaml")):
        cases.append(load_case(p))
    cases.sort(key=lambda c: c.id)
    return cases


def filter_cases(
    cases: list[TestCase],
    *,
    mode: str,
    tags: list[str] | None = None,
    ids: list[str] | None = None,
) -> list[TestCase]:
    out: list[TestCase] = []
    tag_set = set(tags or [])
    id_set = set(ids or [])
    for c in cases:
        if not c.supports_mode(mode):
            continue
        if id_set and c.id not in id_set:
            continue
        if tag_set and not (tag_set & set(c.tags)):
            continue
        out.append(c)
    return out


def step_verb_and_args(step: dict[str, Any]) -> tuple[str, Any]:
    """Each step is a single-key map; return (verb, args)."""
    if len(step) != 1:
        raise ValueError(
            f"step must be a single-key map; got keys: {sorted(step)}"
        )
    return next(iter(step.items()))
