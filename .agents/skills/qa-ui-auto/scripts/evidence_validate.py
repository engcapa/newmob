#!/usr/bin/env python3
"""Evidence Entry Validator (V0 §8.21.1).

Validates EditorEvidenceEntryV2 entries against schema, artifact hashes,
commit freshness, and layer consistency.

Usage:
    python evidence_validate.py [--check-head] [entry_paths_or_dirs...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import jsonschema
import yaml

ROOT = Path.cwd()
SCHEMA_FILE = ROOT / "qa-ui-auto-tests" / "evidence-manifest.schema.json"
EVIDENCE_DIR = ROOT / "qa-ui-auto-report" / "evidence"


def get_current_head() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return ""


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ValidationError:
    def __init__(self, path: Path, message: str, is_stale: bool = False):
        self.path = path
        self.message = message
        self.is_stale = is_stale

    def __str__(self) -> str:
        prefix = "STALE" if self.is_stale else "ERROR"
        return f"[{prefix}] {self.path.name}: {self.message}"


def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


def validate_entry(
    entry_path: Path,
    schema: dict[str, Any],
    check_head: bool = False,
    current_head: str = "",
) -> list[ValidationError]:
    errors: list[ValidationError] = []

    try:
        data = yaml.safe_load(entry_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [ValidationError(entry_path, f"Failed to parse YAML: {exc}")]

    if not isinstance(data, dict):
        return [ValidationError(entry_path, "YAML root is not a dictionary")]

    # Check schema version
    if data.get("schemaVersion") != 2:
        # Check if legacy v1
        if "id" in data and "commit" in data:
            return [
                ValidationError(
                    entry_path,
                    "Legacy entry format (schemaVersion 1); requires migration to EditorEvidenceEntryV2",
                    is_stale=True,
                )
            ]
        return [
            ValidationError(
                entry_path,
                f"Unsupported schemaVersion: {data.get('schemaVersion')}, expected 2",
            )
        ]

    # JSONSchema validation
    validator = jsonschema.Draft202012Validator(schema)
    for err in validator.iter_errors(data):
        field = ".".join(str(p) for p in err.path) or "root"
        errors.append(ValidationError(entry_path, f"Schema error at '{field}': {err.message}"))

    if errors:
        return errors

    # Check commit format
    commit = data["app"]["commit"]
    if not re.match(r"^[0-9a-f]{40}$", commit):
        errors.append(ValidationError(entry_path, f"Invalid git commit hash: '{commit}'"))

    # Check bundleHash format
    bundle_hash = data["app"]["bundleHash"]
    if not re.match(r"^[0-9a-f]{64}$", bundle_hash):
        errors.append(ValidationError(entry_path, f"Invalid bundleHash: '{bundle_hash}'"))

    # Check head freshness if requested
    if check_head and current_head:
        if commit != current_head:
            errors.append(
                ValidationError(
                    entry_path,
                    f"Entry commit {commit[:12]} does not match HEAD {current_head[:12]}",
                    is_stale=True,
                )
            )

    # Validate artifacts
    for art in data.get("artifacts", []):
        art_path = Path(art["path"])
        if not art_path.is_absolute():
            art_path = ROOT / art_path
        if not art_path.exists():
            errors.append(ValidationError(entry_path, f"Artifact does not exist: {art['path']}"))
        else:
            actual_hash = sha256_of_file(art_path)
            if actual_hash != art["sha256"]:
                errors.append(
                    ValidationError(
                        entry_path,
                        f"Artifact SHA-256 mismatch for {art['path']}: expected {art['sha256']}, got {actual_hash}",
                    )
                )

    # Layer and Provider Consistency
    layers = data.get("evidenceLayers", [])
    provider = data.get("provider")

    if "provider" in layers:
        if not provider or not provider.get("id") or not provider.get("fixture"):
            errors.append(
                ValidationError(
                    entry_path,
                    "'provider' evidence layer declared, but provider id/fixture is missing",
                )
            )

    if "idea-compare" in layers:
        artifacts = data.get("artifacts", [])
        if len(artifacts) < 2:
            errors.append(
                ValidationError(
                    entry_path,
                    "'idea-compare' layer requires at least 2 comparison artifacts (expected & observed)",
                )
            )

    if "native" in layers and data.get("result") == "passed":
        if not data.get("artifacts") and "native" not in data.get("command", ""):
            errors.append(
                ValidationError(
                    entry_path,
                    "'native' layer passed requires artifact evidence or verified native command",
                )
            )

    # Maximum claim validation
    claim = data.get("maximumClaim")
    if claim == "L3":
        if "idea-compare" not in layers:
            errors.append(
                ValidationError(
                    entry_path,
                    "Claim L3 requires 'idea-compare' evidence layer",
                )
            )
    elif claim == "L2":
        if not any(layer in layers for layer in ("browser", "native", "provider")):
            errors.append(
                ValidationError(
                    entry_path,
                    "Claim L2 requires at least 'browser', 'native', or 'provider' evidence layer",
                )
            )

    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evidence_validate")
    ap.add_argument("--check-head", action="store_true", help="Reject entries not from current HEAD")
    ap.add_argument("paths", nargs="*", help="Entry paths or directories to scan")
    args = ap.parse_args(argv)

    schema = load_schema()
    current_head = get_current_head()

    scan_paths: list[Path] = []
    if args.paths:
        for p in args.paths:
            path = Path(p)
            if path.is_dir():
                scan_paths.extend(path.rglob("*.entry.yaml"))
            elif path.is_file():
                scan_paths.append(path)
    else:
        if EVIDENCE_DIR.exists():
            scan_paths.extend(EVIDENCE_DIR.rglob("*.entry.yaml"))

    if not scan_paths:
        print("No evidence entries found to validate.")
        return 0

    total = len(scan_paths)
    valid_count = 0
    stale_count = 0
    error_count = 0

    for path in sorted(scan_paths):
        errs = validate_entry(path, schema, check_head=args.check_head, current_head=current_head)
        if not errs:
            valid_count += 1
        else:
            for e in errs:
                print(e)
                if e.is_stale:
                    stale_count += 1
                else:
                    error_count += 1

    print(f"\nValidation Summary: {total} entries checked, {valid_count} valid, {stale_count} stale, {error_count} errors.")
    return 1 if error_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
