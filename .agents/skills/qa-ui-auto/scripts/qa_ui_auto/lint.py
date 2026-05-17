"""qa-ui-auto lint — schema-validate testcase YAML and the features catalog.

Usage:

    python -m qa_ui_auto.lint                        # validate defaults
    python -m qa_ui_auto.lint --cases qa-ui-auto-tests/cases    # only testcases
    python -m qa_ui_auto.lint --features qa-ui-auto-tests/feature-list.md   # only features
    python -m qa_ui_auto.lint --strict-orphans       # fail on selector orphans

Exit codes:
    0 = all valid, 1 = at least one validation error, 2 = setup error.

Warnings (orphan selectors, missing controls coverage) print to stderr but
DO NOT fail by default. Pass `--strict-orphans` to make them fail. This is
the migration-mode default — once feature.controls are filled in across the
catalog, flip the default to strict.
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


def lint_features(features_path: Path) -> tuple[list[str], dict[str, int]]:
    """Validate feature-list.md by parsing its <!-- feature --> blocks.

    Returns (errors, stats) where stats describes feature/control counts.
    Cross-feature selector duplication is reported as an error: the same
    selector should appear in at most one feature's controls list, otherwise
    coverage attribution is ambiguous.
    """
    if not features_path.exists():
        return ([f"{features_path}: feature-list.md not found"], {})
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from qa_ui_auto.feature_catalog import load_features, FeatureCatalogError
    try:
        feats = load_features(features_path)
    except FeatureCatalogError as e:
        return ([str(e)], {})
    except Exception as e:  # noqa: BLE001
        return ([f"{features_path}: parse error: {e}"], {})

    errors: list[str] = []
    sel_to_owner: dict[str, tuple[str, str]] = {}      # selector → (feat_id, control_id)
    features_with_controls = 0
    features_explicitly_empty = 0       # backend-only: declared `controls: []`
    features_undeclared = 0             # never wrote `controls:` at all
    total_controls = 0
    interactive_controls = 0
    display_controls = 0
    optional_controls = 0
    for f in feats:
        if f.controls:
            features_with_controls += 1
        elif f.controls_declared:
            features_explicitly_empty += 1
        else:
            features_undeclared += 1
        for c in f.controls:
            total_controls += 1
            if c.kind == "interactive":
                interactive_controls += 1
            else:
                display_controls += 1
            if c.optional:
                optional_controls += 1
            key = c.selector.strip()
            if key in sel_to_owner:
                ofeat, octrl = sel_to_owner[key]
                errors.append(
                    f"{features_path}: selector {c.selector!r} listed by both "
                    f"{ofeat}.{octrl} and {f.id}.{c.id} — selectors must be "
                    "unique across feature.controls (move it to one place "
                    "or use a more specific selector)"
                )
            else:
                sel_to_owner[key] = (f.id, c.id)
    stats = {
        "features": len(feats),
        "features_with_controls": features_with_controls,
        "features_explicitly_empty": features_explicitly_empty,
        "features_undeclared": features_undeclared,
        "controls": total_controls,
        "interactive": interactive_controls,
        "display": display_controls,
        "optional": optional_controls,
    }
    return errors, stats


def warn_selector_orphans(
    features_path: Path, cases_dir: Path
) -> list[str]:
    """Compute selector orphans: case-step selectors not in any feature.controls.

    Returns a list of human-readable warning lines. Empty list = clean.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    try:
        from qa_ui_auto.control_coverage import build_coverage
    except Exception as e:  # noqa: BLE001
        return [f"warn: control_coverage import failed: {e}"]
    try:
        _, orphans = build_coverage(features_path, cases_dir)
    except Exception as e:  # noqa: BLE001
        return [f"warn: control_coverage build failed: {e}"]
    return orphans


def main() -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.lint")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases",
                    help="directory containing *.testcase.yaml")
    ap.add_argument("--features", default="qa-ui-auto-tests/feature-list.md",
                    help="features catalog YAML")
    ap.add_argument("--skip-cases", action="store_true")
    ap.add_argument("--skip-features", action="store_true")
    ap.add_argument("--skip-orphans", action="store_true",
                    help="don't compute selector orphans (skips control_coverage)")
    ap.add_argument("--strict-orphans", action="store_true",
                    help="treat orphan selectors as errors (default: warn only)")
    ap.add_argument("--max-orphans-shown", type=int, default=20,
                    help="cap how many orphans print to stderr (default 20)")
    args = ap.parse_args()

    total_errors: list[str] = []
    if not args.skip_cases:
        n, ok, errs = lint_cases(Path(args.cases))
        total_errors.extend(errs)
        print(f"[cases] {n} files, {ok} unique ids, {len(errs)} error(s)")

    feats_count = 0
    if not args.skip_features:
        errs, stats = lint_features(Path(args.features))
        total_errors.extend(errs)
        feats_count = stats.get("features", 0)
        if stats:
            print(
                f"[features] {feats_count} entries, "
                f"{stats['features_with_controls']} filled / "
                f"{stats['features_explicitly_empty']} backend-only / "
                f"{stats['features_undeclared']} undeclared "
                f"({stats['controls']} controls: "
                f"{stats['interactive']} interactive, "
                f"{stats['display']} display, "
                f"{stats['optional']} optional), "
                f"{len(errs)} error(s)"
            )
        else:
            print(f"[features] 0 entries, {len(errs)} error(s)")

    if not args.skip_orphans and not args.skip_cases and not args.skip_features:
        warns = warn_selector_orphans(Path(args.features), Path(args.cases))
        if warns:
            level = "error" if args.strict_orphans else "warn"
            stream = sys.stderr if args.strict_orphans else sys.stdout
            print(
                f"[orphans] {len(warns)} selector(s) used by cases but not "
                f"declared in any feature.controls ({level})",
                file=stream,
            )
            for line in warns[: args.max_orphans_shown]:
                print(f"  · {line}", file=stream)
            if len(warns) > args.max_orphans_shown:
                print(
                    f"  · ... and {len(warns) - args.max_orphans_shown} more "
                    "(run `python -m qa_ui_auto.control_coverage --orphans` "
                    "for the full list)",
                    file=stream,
                )
            if args.strict_orphans:
                total_errors.extend(f"orphan: {w}" for w in warns)
        else:
            print("[orphans] 0 (every case selector matches a feature.control)")

    if total_errors:
        print("\nErrors:")
        for e in total_errors:
            print(f"  - {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
