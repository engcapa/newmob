"""ED-REL-002: Source, Test Plan, and Release Bundle Identity Integrity.

Computes deterministic, byte-identical identity digests across tracked sources,
test plan schemas/cases, and release bundles. Matches TypeScript bundleIdentity.ts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from typing import Any


def _imul(a: int, b: int) -> int:
    """32-bit signed integer multiplication (matching JavaScript Math.imul)."""
    res = (a * b) & 0xFFFFFFFF
    if res >= 0x80000000:
        res -= 0x100000000
    return res


def compute_simple_hex_digest(content: str) -> str:
    """Computes deterministic 64-character hex digest matching TypeScript computeSimpleHexDigest."""
    h1 = -559038737  # 0xDEADBEEF as signed 32-bit
    h2 = 0x41C6CE57
    for ch in content:
        c = ord(ch)
        h1 = _imul(h1 ^ c, 2654435761)
        h2 = _imul(h2 ^ c, 1597334677)

    u_h1 = h1 & 0xFFFFFFFF
    u_h2 = h2 & 0xFFFFFFFF
    h1 = _imul(h1 ^ (u_h1 >> 16), 2246822507) ^ _imul(h2 ^ (u_h2 >> 13), 3266489909)
    u_h1 = h1 & 0xFFFFFFFF
    h2 = _imul(h2 ^ (u_h2 >> 16), 2246822507) ^ _imul(h1 ^ (u_h1 >> 13), 3266489909)

    u1 = h1 & 0xFFFFFFFF
    u2 = h2 & 0xFFFFFFFF
    hex1 = f"{u1:08x}"
    hex2 = f"{u2:08x}"
    hex3 = f"{u1 ^ 0x55555555:08x}"
    hex4 = f"{u2 ^ 0xAAAAAAAA:08x}"
    return f"{hex1}{hex2}{hex3}{hex4}{hex1}{hex2}{hex3}{hex4}"


def compute_source_identity_digest(files: list[dict[str, Any]]) -> tuple[str, int]:
    """Computes deterministic canonical hash string from tracked source files.

    Matches TypeScript computeSourceIdentityDigest.
    """
    sorted_files = sorted(files, key=lambda f: f["path"])
    total_bytes = 0
    lines: list[str] = []

    for f in sorted_files:
        if f.get("isDeleted"):
            lines.append(f"DEL:{f['path']}")
            continue

        total_bytes += int(f.get("bytes", 0))
        flags = [
            "symlink" if f.get("isSymlink") else "",
            "submodule" if f.get("isSubmodule") else "",
        ]
        flags_str = ",".join(filter(None, flags))

        line = f"{f['path']}:{f['mode']}:{f['sha256']}:{f['bytes']}"
        if flags_str:
            line += f":{flags_str}"
        lines.append(line)

    raw = "\n".join(lines)
    digest = compute_simple_hex_digest(f"source::{raw}")
    return digest, total_bytes


def compute_test_plan_identity_digest(inputs: dict[str, Any]) -> str:
    """Computes deterministic canonical hash string for test plan inputs.

    Matches TypeScript computeTestPlanIdentityDigest.
    """
    raw = "|".join([
        f"schema:{inputs['schemaDigest']}",
        f"scope:{inputs['scopeDigest']}",
        f"runner:{inputs['runnerDigest']}",
        f"cases:{inputs['casesDigest']}",
        f"runbooks:{inputs['runbooksDigest']}",
        f"baseline:{inputs['baselineCommit']}",
    ])
    return compute_simple_hex_digest(f"testplan::{raw}")


def build_release_bundle_identity(
    bundle_id: str,
    version: str,
    platform: str,
    files: list[dict[str, Any]],
    test_plan: dict[str, Any],
) -> dict[str, Any]:
    """Builds complete Release Bundle Identity descriptor.

    Matches TypeScript buildReleaseBundleIdentity.
    """
    source_digest, total_bytes = compute_source_identity_digest(files)
    test_plan_digest = compute_test_plan_identity_digest(test_plan)

    combined_raw = "|".join([
        f"bundle:{bundle_id}",
        f"ver:{version}",
        f"plat:{platform}",
        f"src:{source_digest}",
        f"test:{test_plan_digest}",
        f"files:{len(files)}",
        f"bytes:{total_bytes}",
    ])
    combined_digest = compute_simple_hex_digest(combined_raw)

    return {
        "bundleId": bundle_id,
        "version": version,
        "platform": platform,
        "sourceIdentityDigest": source_digest,
        "testPlanIdentityDigest": test_plan_digest,
        "combinedIdentityDigest": combined_digest,
        "trackedFileCount": len(files),
        "totalBytes": total_bytes,
    }


def verify_bundle_integrity(
    expected_bundle: dict[str, Any],
    current_files: list[dict[str, Any]],
    current_test_plan: dict[str, Any],
) -> dict[str, Any]:
    """Audits a release bundle manifest against current source tree and test plan.

    Matches TypeScript verifyBundleIntegrity.
    """
    discrepancies: list[dict[str, Any]] = []

    current_test_plan_digest = compute_test_plan_identity_digest(current_test_plan)
    if current_test_plan_digest != expected_bundle.get("testPlanIdentityDigest"):
        discrepancies.append({
            "kind": "test-plan-changed",
            "details": f"Test plan identity digest mismatch: expected {str(expected_bundle.get('testPlanIdentityDigest'))[:8]}, got {current_test_plan_digest[:8]}",
        })

    current_source_digest, _ = compute_source_identity_digest(current_files)
    if current_source_digest != expected_bundle.get("sourceIdentityDigest"):
        discrepancies.append({
            "kind": "content-modified",
            "details": f"Source tree identity digest mismatch: expected {str(expected_bundle.get('sourceIdentityDigest'))[:8]}, got {current_source_digest[:8]}",
        })

    return {
        "valid": len(discrepancies) == 0,
        "discrepancies": discrepancies,
    }


def compute_file_sha256(path: Path) -> str:
    """Computes sha256:hex digest of file bytes."""
    raw = path.read_bytes()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def inspect_repository_identities(
    repo_root: Path,
    mode: str = "browser",
) -> dict[str, Any]:
    """Inspects tracked sources, test plan inputs, and bundle facts from current repo."""
    # 1. Resolve baseline commit
    try:
        head_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_root),
            text=True,
        ).strip()
    except Exception:
        head_commit = "0000000000000000000000000000000000000000"

    # 2. Collect tracked source files
    source_files: list[dict[str, Any]] = []
    try:
        ls_out = subprocess.check_output(
            ["git", "ls-files", "-s"],
            cwd=str(repo_root),
            text=True,
        )
        for line in ls_out.splitlines():
            line = line.strip()
            if not line:
                continue
            # format: <mode> <sha> <stage>\t<path>
            parts = line.split(None, 3)
            if len(parts) < 4:
                continue
            mode_str = parts[0]
            stage_path = parts[3].split("\t", 1)
            fpath = stage_path[-1]

            # Only inspect release-critical prefixes to remain fast
            if not (fpath.startswith("src") or fpath.startswith("src-tauri/src") or
                    fpath in ("package.json", "tsconfig.json", "Cargo.toml")):
                continue

            full_p = repo_root / fpath
            if full_p.is_file():
                raw = full_p.read_bytes()
                sha256 = f"sha256:{hashlib.sha256(raw).hexdigest()}"
                source_files.append({
                    "path": fpath,
                    "mode": mode_str,
                    "sha256": sha256,
                    "bytes": len(raw),
                })
    except Exception as e:
        print(f"Warning: could not inspect git tracked files: {e}", file=sys.stderr)

    # 3. Collect test plan digests
    cases_dir = repo_root / "qa-ui-auto-tests" / "cases"
    case_hashes: list[str] = []
    if cases_dir.is_dir():
        for cp in sorted(cases_dir.glob("*.testcase.yaml")):
            raw = cp.read_bytes()
            case_hashes.append(hashlib.sha256(raw).hexdigest())
    cases_digest = f"sha256:{hashlib.sha256(''.join(case_hashes).encode()).hexdigest()}"

    schema_file = repo_root / ".agents" / "skills" / "qa-ui-auto" / "schema" / "testcase.schema.json"
    schema_digest = compute_file_sha256(schema_file) if schema_file.is_file() else "sha256:missing"

    scope_file = repo_root / "claudedocs" / "code-workspace-idea-specs" / "daily-editor-linux.scope.json"
    scope_digest = compute_file_sha256(scope_file) if scope_file.is_file() else "sha256:missing"

    runner_file = repo_root / ".agents" / "skills" / "qa-ui-auto" / "scripts" / "qa_ui_auto" / "runner.py"
    runner_digest = compute_file_sha256(runner_file) if runner_file.is_file() else "sha256:missing"

    test_plan = {
        "schemaDigest": schema_digest,
        "scopeDigest": scope_digest,
        "runnerDigest": runner_digest,
        "casesDigest": cases_digest,
        "runbooksDigest": "sha256:none",
        "baselineCommit": head_commit,
    }

    # 4. Resolve package/bundle identity
    bundle_id = f"taomni-desktop-{mode}"
    version = "0.4.20"
    pkg_json = repo_root / "package.json"
    if pkg_json.is_file():
        try:
            pj = json.loads(pkg_json.read_text(encoding="utf-8"))
            version = pj.get("version", version)
        except Exception:
            pass

    bundle_identity = build_release_bundle_identity(
        bundle_id=bundle_id,
        version=version,
        platform="linux" if mode == "native" else "cross-platform",
        files=source_files,
        test_plan=test_plan,
    )

    return {
        "sourceFiles": source_files,
        "testPlan": test_plan,
        "bundleIdentity": bundle_identity,
    }
