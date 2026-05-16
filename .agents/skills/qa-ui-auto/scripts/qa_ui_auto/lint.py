"""qa-ui-auto lint — schema-validate testcase YAML and the features catalog.

Usage:

    python -m qa_ui_auto.lint                        # validate defaults
    python -m qa_ui_auto.lint --cases qa-ui-auto-tests/cases    # only testcases
    python -m qa_ui_auto.lint --features qa-ui-auto-tests/feature-list.md   # only features

Exit codes:
    0 = all valid, 1 = at least one validation error, 2 = setup error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

try:
    import jsonschema
except ImportError:
    print(
        "qa-ui-auto.lint: jsonschema not installed.\n"
        "Run: pip install jsonschema pyyaml",
        file=sys.stderr,
    )
    sys.exit(2)

HERE = Path(__file__).resolve().parent
SCHEMA_DIR = HERE.parent.parent / "schema"
TESTCASE_SCHEMA = SCHEMA_DIR / "testcase.schema.json"


def _validate(doc: object, schema_path: Path, source: str) -> list[str]:
    if not schema_path.exists():
        return [f"{source}: schema not found at {schema_path}"]
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    errors: list[str] = []
    for err in validator.iter_errors(doc):
        path = "/".join(str(p) for p in err.absolute_path) or "<root>"
        errors.append(f"{source}: {path}: {err.message}")
    return errors


def lint_cases(cases_dir: Path) -> tuple[int, int, list[str]]:
    files = sorted(cases_dir.rglob("*.testcase.yaml")) if cases_dir.exists() else []
    all_errors: list[str] = []
    seen_ids: dict[str, str] = {}
    for path in files:
        try:
            doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            all_errors.append(f"{path}: YAML parse error: {e}")
            continue
        errs = _validate(doc, TESTCASE_SCHEMA, str(path))
        all_errors.extend(errs)
        if errs:
            continue
        case_id = doc.get("id") if isinstance(doc, dict) else None
        if case_id:
            if case_id in seen_ids:
                all_errors.append(
                    f"{path}: duplicate id {case_id!r} (also in {seen_ids[case_id]})"
                )
            else:
                seen_ids[case_id] = str(path)
    return len(files), len(seen_ids), all_errors


def lint_features(features_path: Path) -> list[str]:
    """Validate feature-list.md by parsing its <!-- feature --> blocks."""
    if not features_path.exists():
        return [f"{features_path}: feature-list.md not found"]
    # Late import keeps lint usable even if jsonschema-only checks are wanted.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from qa_ui_auto.feature_catalog import load_features, FeatureCatalogError
    try:
        load_features(features_path)
    except FeatureCatalogError as e:
        return [str(e)]
    except Exception as e:  # noqa: BLE001
        return [f"{features_path}: parse error: {e}"]
    return []


def main() -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.lint")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases",
                    help="directory containing *.testcase.yaml")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md",
                    help="features catalog YAML")
    ap.add_argument("--skip-cases", action="store_true")
    ap.add_argument("--skip-features", action="store_true")
    args = ap.parse_args()

    total_errors: list[str] = []
    if not args.skip_cases:
        n, ok, errs = lint_cases(Path(args.cases))
        total_errors.extend(errs)
        print(f"[cases] {n} files, {ok} unique ids, {len(errs)} error(s)")
    if not args.skip_features:
        errs = lint_features(Path(args.features))
        total_errors.extend(errs)
        feats_ok = 0
        try:
            from qa_ui_auto.feature_catalog import load_features
            feats_ok = len(load_features(Path(args.features)))
        except Exception:  # noqa: BLE001
            pass
        print(f"[features] {feats_ok} entries, {len(errs)} error(s)")

    if total_errors:
        print("\nErrors:")
        for e in total_errors:
            print(f"  - {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
