"""ED-REL-003: Release plan, channel requirements, and evidence artifact root constraints.

Validates that release plans, channel definitions, required capabilities,
evidence layers, and artifact roots strictly conform to committed contracts.
Rejects path traversal, out-of-root files, absolute paths, and unknown channels.
Matches TypeScript releasePlanValidator.ts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any

DEFAULT_EVIDENCE_ROOTS: list[str] = [
    "qa-ui-auto-report",
    "evidence",
]

VALID_PLATFORMS = {"linux", "macos", "windows", "cross-platform"}
VALID_LAYERS = {"unit", "browser", "native", "integration", "perf"}


def validate_artifact_path(
    raw_path: str,
    allowed_roots: list[str] | None = None,
) -> dict[str, Any]:
    """Validates that an artifact path is strictly repo-relative and located under an approved root.

    Matches TypeScript validateArtifactPath.
    """
    roots = allowed_roots if allowed_roots is not None else DEFAULT_EVIDENCE_ROOTS

    if not raw_path or not isinstance(raw_path, str):
        return {
            "valid": False,
            "normalizedPath": "",
            "reason": "invalid-format",
            "message": "Artifact path must be a non-empty string",
        }

    # 1. Reject absolute paths (POSIX and Windows)
    if (
        raw_path.startswith("/")
        or raw_path.startswith("\\")
        or bool(re.match(r"^[A-Za-z]:[\\/]", raw_path))
    ):
        return {
            "valid": False,
            "normalizedPath": raw_path,
            "reason": "absolute-path-rejected",
            "message": f"Absolute artifact paths are forbidden: '{raw_path}'",
        }

    # 2. Normalize separators and reject path traversal / escapes
    normalized = raw_path.replace("\\", "/")
    segments = [seg for seg in normalized.split("/") if seg]

    if any(seg in ("..", ".") for seg in segments):
        return {
            "valid": False,
            "normalizedPath": normalized,
            "reason": "traversal-rejected",
            "message": f"Path traversal segments ('..' or '.') are forbidden: '{raw_path}'",
        }

    # 3. Verify that path starts with one of the allowed evidence roots
    normalized_roots = [r.replace("\\", "/").rstrip("/") for r in roots]
    matched_root = None
    for r in normalized_roots:
        if normalized == r or normalized.startswith(f"{r}/"):
            matched_root = r
            break

    if not matched_root:
        return {
            "valid": False,
            "normalizedPath": normalized,
            "reason": "disallowed-root",
            "message": f"Artifact path '{normalized}' is not within any allowed evidence roots ({', '.join(roots)})",
        }

    return {
        "valid": True,
        "normalizedPath": normalized,
    }


def load_release_plan(plan_path: Path) -> dict[str, Any]:
    """Loads and validates a release plan JSON file."""
    if not plan_path.is_file():
        raise FileNotFoundError(f"Release plan file not found: {plan_path}")

    data = json.loads(plan_path.read_text(encoding="utf-8"))
    version = data.get("version")
    if not isinstance(version, (int, float)) or version < 1:
        raise ValueError(f"Invalid plan version: {version}")

    channels = data.get("releaseChannels")
    if not isinstance(channels, dict) or not channels:
        raise ValueError("Release plan must contain non-empty 'releaseChannels' object")

    for ch_name, ch in channels.items():
        if not isinstance(ch, dict):
            raise ValueError(f"Channel '{ch_name}' must be an object")
        platform = ch.get("platform")
        if platform not in VALID_PLATFORMS:
            raise ValueError(f"Channel '{ch_name}' has invalid platform '{platform}'")
        if not isinstance(ch.get("requiredCapabilities"), list):
            raise ValueError(f"Channel '{ch_name}' missing requiredCapabilities list")
        if not isinstance(ch.get("requiredEvidenceLayers"), list):
            raise ValueError(f"Channel '{ch_name}' missing requiredEvidenceLayers list")
        for layer in ch["requiredEvidenceLayers"]:
            if layer not in VALID_LAYERS:
                raise ValueError(f"Channel '{ch_name}' has unknown evidence layer '{layer}'")

    return data


def resolve_channel_requirements(
    channel_name: str,
    plan: dict[str, Any],
) -> dict[str, Any]:
    """Resolves deterministic requirements for a channel from a release plan."""
    channels = plan.get("releaseChannels", {})
    channel = channels.get(channel_name)
    if not channel:
        raise ValueError(f"Release channel '{channel_name}' not found in release plan")

    evidence_roots = channel.get("evidenceRoots")
    if not evidence_roots:
        evidence_roots = list(DEFAULT_EVIDENCE_ROOTS)

    return {
        "platform": channel["platform"],
        "requiredCapabilities": list(channel["requiredCapabilities"]),
        "requiredEvidenceLayers": list(channel["requiredEvidenceLayers"]),
        "evidenceRoots": list(evidence_roots),
        "performanceBudget": channel.get("performanceBudget"),
    }


def evaluate_channel_compliance(
    channel_name: str,
    plan: dict[str, Any],
    verified_capabilities: list[str],
    verified_layers: list[str],
    artifacts: list[str],
) -> dict[str, Any]:
    """Evaluates whether verified capabilities and artifacts satisfy release channel requirements.

    Matches TypeScript evaluateChannelCompliance.
    """
    channels = plan.get("releaseChannels", {})
    channel = channels.get(channel_name)
    if not channel:
        return {
            "compliant": False,
            "channelName": channel_name,
            "missingCapabilities": [],
            "missingLayers": [],
            "invalidArtifacts": [{
                "path": "",
                "reason": f"Release channel '{channel_name}' not found in release plan",
            }],
        }

    verified_cap_set = set(verified_capabilities)
    missing_caps = [c for c in channel["requiredCapabilities"] if c not in verified_cap_set]

    verified_layer_set = set(verified_layers)
    missing_layers = [l for l in channel["requiredEvidenceLayers"] if l not in verified_layer_set]

    roots = channel.get("evidenceRoots") or DEFAULT_EVIDENCE_ROOTS
    invalid_artifacts: list[dict[str, Any]] = []

    for art in artifacts:
        check = validate_artifact_path(art, roots)
        if not check["valid"]:
            invalid_artifacts.append({
                "path": art,
                "reason": check.get("message") or "Invalid artifact path",
            })

    compliant = (
        len(missing_caps) == 0
        and len(missing_layers) == 0
        and len(invalid_artifacts) == 0
    )

    return {
        "compliant": compliant,
        "channelName": channel_name,
        "missingCapabilities": missing_caps,
        "missingLayers": missing_layers,
        "invalidArtifacts": invalid_artifacts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Release plan and channel artifact root validator (ED-REL-003)")
    parser.add_argument("--plan", required=True, type=Path, help="Path to release-evidence-plan.json")
    parser.add_argument("--channel", default="linux-daily-editor", help="Channel name to validate")
    parser.add_argument("--receipt", type=Path, help="Optional runner_receipt.json to check compliance against")

    args = parser.parse_args()

    try:
        plan = load_release_plan(args.plan)
        reqs = resolve_channel_requirements(args.channel, plan)
        print(f"OK: Validated release plan for channel '{args.channel}':")
        print(f"  Platform: {reqs['platform']}")
        print(f"  Required capabilities: {len(reqs['requiredCapabilities'])}")
        print(f"  Required layers: {reqs['requiredEvidenceLayers']}")
        print(f"  Allowed evidence roots: {reqs['evidenceRoots']}")

        if args.receipt:
            if not args.receipt.is_file():
                print(f"ERROR: Receipt file not found: {args.receipt}", file=sys.stderr)
                return 1
            receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
            artifacts = [a["path"] for a in receipt.get("artifacts", [])]
            # Prefix artifacts with runner report directory if repo-relative
            report_dir_name = args.receipt.parent.name
            full_art_paths = [f"qa-ui-auto-report/{report_dir_name}/{p}" for p in artifacts]

            # In this runner receipt, purpose tells which layer was executed
            runner_layer = "native" if receipt.get("purpose") == "native-runner" else "browser"
            # We check artifact paths against allowed roots
            invalid: list[str] = []
            for art in full_art_paths:
                chk = validate_artifact_path(art, reqs["evidenceRoots"])
                if not chk["valid"]:
                    invalid.append(f"{art}: {chk.get('message')}")

            if invalid:
                print(f"FAIL: {len(invalid)} artifacts violated evidence roots:", file=sys.stderr)
                for inv in invalid:
                    print(f"  - {inv}", file=sys.stderr)
                return 1

            print(f"OK: All {len(artifacts)} receipt artifacts are within approved roots.")
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
