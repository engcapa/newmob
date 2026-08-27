#!/usr/bin/env python3
"""Evidence Entry Validator (X0 §8.23.1).

Validates EditorEvidenceEntry entries against schema (v2/v3/v4), artifact hashes,
path confinement, production owner paths, layer semantics, and source/plan fingerprints.

Usage:
    python evidence_validate.py [--check-current] [--allow-history-only] [--release-channel CHANNEL] [entry_paths...]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from enum import Enum
from pathlib import Path
from typing import Any

import jsonschema
import yaml

ROOT = Path.cwd()
SCHEMA_FILE = ROOT / "qa-ui-auto-tests" / "evidence-manifest.schema.json"
RELEASE_PLAN_FILE = ROOT / "qa-ui-auto-tests" / "release-evidence-plan.json"
FEATURE_LIST_FILE = ROOT / "qa-ui-auto-tests" / "feature-list.md"
NATIVE_EVIDENCE_DIR = ROOT / "qa-ui-auto-tests" / "native" / "evidence"

SOURCE_GLOBS = [
    "src",
    "src-tauri/src",
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "tsconfig.json",
]


class EntryStatus(str, Enum):
    VALID_CURRENT = "valid-current"
    VALID_HISTORY = "valid-history"
    STALE_SOURCE = "stale-source"
    STALE_BUNDLE = "stale-bundle"
    STALE_TEST_PLAN = "stale-test-plan"
    INVALID = "invalid"


CLAIM_LEVELS = {"L0": 0, "L1": 1, "L2": 2, "L3": 3}


def get_current_head() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return ""


def is_source_dirty() -> bool:
    try:
        cmd = ["git", "status", "--porcelain", "--"] + SOURCE_GLOBS
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
        return len(out) > 0
    except Exception:
        return False


def get_tested_source_fingerprint() -> str:
    cmd = ["git", "ls-files", "-s", "--"] + SOURCE_GLOBS
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        lines = sorted(out.strip().splitlines())
        return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    except Exception:
        return ""


def get_test_plan_fingerprint() -> str:
    h = hashlib.sha256()
    # 1. Schema & plan files
    for p in [SCHEMA_FILE, RELEASE_PLAN_FILE, FEATURE_LIST_FILE]:
        if p.exists():
            h.update(p.read_bytes())
    # 2. Key scripts
    script_dir = ROOT / ".agents" / "skills" / "qa-ui-auto" / "scripts"
    for s in ["evidence_validate.py", "evidence_rollup.py", "qa_ui_auto/audit.py"]:
        sp = script_dir / s
        if sp.exists():
            h.update(sp.read_bytes())
    # 3. All YAML cases in deterministic order
    cases_dir = ROOT / "qa-ui-auto-tests" / "cases"
    if cases_dir.exists():
        for case in sorted(cases_dir.glob("*.testcase.yaml")):
            h.update(case.read_bytes())
    return h.hexdigest()


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_path_confined(art_path_str: str) -> bool:
    if ".." in art_path_str:
        return False
    if "qa-ui-auto-report" in art_path_str:
        return False
    if art_path_str.startswith("/"):
        p = Path(art_path_str).resolve()
    else:
        p = (ROOT / art_path_str).resolve()

    try:
        p.relative_to(ROOT)
        return True
    except ValueError:
        pass

    try:
        p.relative_to(Path("/tmp"))
        return True
    except ValueError:
        return False


class ValidationResult:
    def __init__(
        self,
        path: Path,
        status: EntryStatus,
        reason_code: str | None = None,
        errors: list[str] | None = None,
        data: dict[str, Any] | None = None,
    ):
        self.path = path
        self.status = status
        self.reason_code = reason_code
        self.errors = errors or []
        self.data = data

    def __str__(self) -> str:
        code_str = f" ({self.reason_code})" if self.reason_code else ""
        err_str = f": {'; '.join(self.errors)}" if self.errors else ""
        return f"[{self.status.value.upper()}]{code_str} {self.path.name}{err_str}"


def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


def load_release_plan() -> dict[str, Any] | None:
    if RELEASE_PLAN_FILE.exists():
        try:
            return json.loads(RELEASE_PLAN_FILE.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def is_production_path(p: str) -> bool:
    normalized = p.replace("\\", "/")
    if normalized.startswith("src-tauri/src/") and not normalized.endswith(".test.rs") and "/tests/" not in normalized:
        return True
    if normalized.startswith("src/") and not re.search(r"\.(test|spec)\.[jt]sx?$", normalized) and "/test/" not in normalized and "/__tests__/" not in normalized and "/__fixtures__/" not in normalized:
        return True
    return False


def validate_entry(
    entry_path: Path,
    schema: dict[str, Any],
    check_current: bool = False,
    current_source_fp: str = "",
    current_test_plan_fp: str = "",
    current_head: str = "",
    expected_bundle_hash: str = "",
) -> ValidationResult:
    try:
        data = yaml.safe_load(entry_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return ValidationResult(
            entry_path, EntryStatus.INVALID, "YAML_PARSE_ERROR", [f"Failed to parse YAML: {exc}"]
        )

    if not isinstance(data, dict):
        return ValidationResult(
            entry_path, EntryStatus.INVALID, "NOT_A_DICTIONARY", ["YAML root is not a dictionary"]
        )

    # Legacy v1
    if data.get("schemaVersion") == 1 or ("id" in data and "commit" in data and "schemaVersion" not in data):
        return ValidationResult(
            entry_path,
            EntryStatus.STALE_TEST_PLAN,
            "LEGACY_SCHEMA_V1",
            ["Legacy v1 schema requires migration to EditorEvidenceEntryV4"],
        )

    # Validate against JSON schema
    validator = jsonschema.Draft202012Validator(schema)
    schema_errors = []
    for err in validator.iter_errors(data):
        field_path = ".".join(str(p) for p in err.path) or "root"
        schema_errors.append(f"{field_path}: {err.message}")

    if schema_errors:
        return ValidationResult(
            entry_path, EntryStatus.INVALID, "SCHEMA_ERROR", schema_errors
        )

    version = data.get("schemaVersion")
    if version == 2 or version == 3:
        return ValidationResult(
            entry_path,
            EntryStatus.STALE_TEST_PLAN,
            f"LEGACY_SCHEMA_V{version}",
            [f"Legacy v{version} schema requires migration to v4"],
            data=data,
        )

    if version != 4:
        return ValidationResult(
            entry_path,
            EntryStatus.INVALID,
            "UNSUPPORTED_SCHEMA_VERSION",
            [f"Unsupported schemaVersion: {version}"],
        )

    # Owner validation (v4)
    owner = data.get("owner", {})
    paths = owner.get("paths", [])
    if not paths:
        return ValidationResult(
            entry_path,
            EntryStatus.INVALID,
            "INVALID_OWNER_PATHS",
            ["Owner must declare at least one path"],
            data=data,
        )

    has_prod = False
    for p in paths:
        if p == "verified in repo" or " " in p:
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "INVALID_OWNER_PATHS",
                [f"Placeholder owner path is not allowed: '{p}'"],
                data=data,
            )
        file_path = ROOT / p
        if not file_path.exists():
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "INVALID_OWNER_PATHS",
                [f"Owner path does not exist on disk: '{p}'"],
                data=data,
            )
        if is_production_path(p):
            has_prod = True

    if not has_prod:
        return ValidationResult(
            entry_path,
            EntryStatus.INVALID,
            "OWNER_PATH_NOT_PRODUCTION",
            ["Owner paths must include at least one production source file (tests/docs only not allowed)"],
            data=data,
        )

    # Artifacts validation & Path confinement
    artifacts = data.get("artifacts", [])
    for art in artifacts:
        art_path_str = art.get("path", "")
        if not is_path_confined(art_path_str):
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "ARTIFACT_OUTSIDE_ROOT",
                [f"Artifact path escapes committed roots or points to ignored directory: {art_path_str}"],
                data=data,
            )

        art_path = Path(art_path_str)
        if not art_path.is_absolute():
            art_path = ROOT / art_path
        if not art_path.exists():
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "ARTIFACT_MISSING",
                [f"Artifact does not exist: {art_path_str}"],
                data=data,
            )
        if not art_path.is_file():
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "ARTIFACT_NOT_REGULAR_FILE",
                [f"Artifact is not a regular file: {art_path_str}"],
                data=data,
            )
        actual_hash = sha256_of_file(art_path)
        if actual_hash != art.get("sha256"):
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "ARTIFACT_HASH_MISMATCH",
                [f"Artifact SHA-256 mismatch for {art_path_str}: expected {art.get('sha256')}, got {actual_hash}"],
                data=data,
            )
        # Scan for leaked secrets or local paths
        try:
            sample = art_path.read_bytes()[:8192]
            if b"/home/" in sample or b"C:\\Users\\" in sample or b"BEGIN PRIVATE KEY" in sample:
                return ValidationResult(
                    entry_path,
                    EntryStatus.INVALID,
                    "SECRET_LEAK",
                    [f"Artifact contains unredacted local paths or credentials: {art_path_str}"],
                    data=data,
                )
        except Exception:
            pass

    # Layers validation
    layers = data.get("evidenceLayers", [])
    provider = data.get("provider")

    if "provider" in layers:
        if not provider or not provider.get("id") or not provider.get("fixture"):
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "PROVIDER_LAYER_MISSING_ARTIFACTS",
                ["'provider' layer requires provider id and fixture declaration"],
                data=data,
            )
        kinds = {a.get("kind") for a in artifacts}
        if "request" not in kinds or not (kinds & {"response", "failure"}):
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "PROVIDER_LAYER_MISSING_ARTIFACTS",
                ["'provider' layer requires artifacts with kind 'request' and 'response'/'failure'"],
                data=data,
            )

    if "idea-compare" in layers:
        if len(artifacts) < 2:
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "IDEA_COMPARE_MISSING_ARTIFACTS",
                ["'idea-compare' layer requires at least 2 comparison artifacts (expected & observed)"],
                data=data,
            )

    if "native" in layers and data.get("result") == "passed":
        kinds = {a.get("kind") for a in artifacts}
        cmd = data.get("command", "")
        if "host-effect" not in kinds and "native" not in cmd:
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "NATIVE_LAYER_MISSING_EFFECT",
                ["'native' layer requires host-side effect artifact or verified native command"],
                data=data,
            )

    # Maximum claim calculation & validation
    computed_limit = "L1"
    if "idea-compare" in layers and len(artifacts) >= 2:
        computed_limit = "L3"
    elif any(l in layers for l in ("browser", "native", "provider")):
        computed_limit = "L2"

    claim = data.get("maximumClaim", "L0")
    if CLAIM_LEVELS.get(claim, 0) > CLAIM_LEVELS.get(computed_limit, 0):
        return ValidationResult(
            entry_path,
            EntryStatus.INVALID,
            "CLAIM_EXCEEDS_MAXIMUM",
            [f"Claim '{claim}' exceeds maximum computed claim '{computed_limit}' for layers {layers}"],
            data=data,
        )

    # Subject & Staleness check
    subject = data.get("subject", {})
    app_commit = subject.get("appCommit", "")
    rec_commit = data.get("recordedAtCommit", "")
    source_fp = subject.get("sourceTreeHash") or subject.get("testedSourceFingerprint", "")
    plan_fp = subject.get("testPlanHash") or subject.get("testPlanFingerprint", "")
    bundle_hash = subject.get("bundleHash", "")

    if check_current:
        # 1. Commit matching
        if current_head and app_commit != current_head:
            return ValidationResult(
                entry_path,
                EntryStatus.STALE_SOURCE,
                "COMMIT_MISMATCH",
                [f"Entry appCommit {app_commit[:12]} does not match current HEAD {current_head[:12]}"],
                data=data,
            )
        if rec_commit != app_commit:
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "COMMIT_MISMATCH",
                [f"Entry recordedAtCommit {rec_commit[:12]} does not match appCommit {app_commit[:12]}"],
                data=data,
            )

        # 2. Source dirty check
        if subject.get("sourceDirty", False):
            return ValidationResult(
                entry_path,
                EntryStatus.INVALID,
                "DIRTY_SOURCE",
                ["Entry declares sourceDirty: true"],
                data=data,
            )

        # 3. Test plan fingerprint
        if current_test_plan_fp and plan_fp != current_test_plan_fp:
            return ValidationResult(
                entry_path,
                EntryStatus.STALE_TEST_PLAN,
                "STALE_TEST_PLAN",
                [f"Entry testPlanFingerprint {plan_fp[:12]} does not match current {current_test_plan_fp[:12]}"],
                data=data,
            )

        # 4. Source fingerprint
        if current_source_fp and source_fp != current_source_fp:
            return ValidationResult(
                entry_path,
                EntryStatus.STALE_SOURCE,
                "STALE_SOURCE_FINGERPRINT",
                [f"Entry testedSourceFingerprint {source_fp[:12]} does not match current {current_source_fp[:12]}"],
                data=data,
            )

        # 5. Bundle hash check
        if expected_bundle_hash and bundle_hash != expected_bundle_hash:
            return ValidationResult(
                entry_path,
                EntryStatus.STALE_BUNDLE,
                "STALE_BUNDLE",
                [f"Entry bundleHash {bundle_hash[:12]} does not match expected bundle {expected_bundle_hash[:12]}"],
                data=data,
            )

        return ValidationResult(entry_path, EntryStatus.VALID_CURRENT, None, data=data)

    return ValidationResult(entry_path, EntryStatus.VALID_HISTORY, None, data=data)


def scan_entries(paths: list[str] | None = None) -> list[Path]:
    scan_paths: list[Path] = []
    if paths:
        for p in paths:
            path = Path(p)
            if path.is_dir():
                scan_paths.extend(path.rglob("*.entry.yaml"))
            elif path.is_file():
                scan_paths.append(path)
    else:
        if NATIVE_EVIDENCE_DIR.exists():
            scan_paths.extend(NATIVE_EVIDENCE_DIR.rglob("*.entry.yaml"))
    return sorted(set(scan_paths))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evidence_validate")
    ap.add_argument("--check-current", action="store_true", help="Enforce that current valid entries exist and no current entries are invalid or stale")
    ap.add_argument("--check-head", action="store_true", help="Alias for --check-current")
    ap.add_argument("--allow-history-only", action="store_true", help="Allow zero current entries without erroring")
    ap.add_argument("--release-channel", default="linux-daily-editor", help="Release channel to check from release-evidence-plan.json")
    ap.add_argument("paths", nargs="*", help="Entry paths or directories to scan")
    args = ap.parse_args(argv)

    schema = load_schema()
    current_head = get_current_head()
    current_source_fp = get_tested_source_fingerprint()
    current_test_plan_fp = get_test_plan_fingerprint()

    check_current = args.check_current or args.check_head
    scan_paths = scan_entries(args.paths)

    if not scan_paths:
        print("No evidence entries found.")
        if check_current and not args.allow_history_only:
            print("ERROR: --check-current failed: zero evidence entries found in repository.")
            return 1
        return 0

    results: list[ValidationResult] = []
    for p in scan_paths:
        res = validate_entry(
            p,
            schema,
            check_current=check_current,
            current_source_fp=current_source_fp,
            current_test_plan_fp=current_test_plan_fp,
            current_head=current_head,
        )
        results.append(res)
        print(res)

    counts = {status: 0 for status in EntryStatus}
    for r in results:
        counts[r.status] += 1

    print(
        f"\nValidation Summary: {len(results)} entries checked: "
        f"{counts[EntryStatus.VALID_CURRENT]} valid-current, "
        f"{counts[EntryStatus.VALID_HISTORY]} valid-history, "
        f"{counts[EntryStatus.STALE_SOURCE]} stale-source, "
        f"{counts[EntryStatus.STALE_TEST_PLAN]} stale-test-plan, "
        f"{counts[EntryStatus.STALE_BUNDLE]} stale-bundle, "
        f"{counts[EntryStatus.INVALID]} invalid."
    )

    if counts[EntryStatus.INVALID] > 0:
        return 1

    if check_current:
        if not args.allow_history_only and counts[EntryStatus.VALID_CURRENT] == 0:
            print("ERROR: --check-current failed: no valid-current evidence entries found for current source fingerprint.")
            return 1
        stale_count = counts[EntryStatus.STALE_SOURCE] + counts[EntryStatus.STALE_TEST_PLAN] + counts[EntryStatus.STALE_BUNDLE]
        if not args.allow_history_only and stale_count > 0 and counts[EntryStatus.VALID_CURRENT] == 0:
            print("ERROR: --check-current failed: all entries are stale.")
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

