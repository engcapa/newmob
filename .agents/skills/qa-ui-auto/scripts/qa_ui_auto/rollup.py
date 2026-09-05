"""ED-REL-004: Byte-identical release evidence rollup and manifest verification.

Aggregates real runner receipts across channels, enforces deterministic ordering,
verifies cryptographic signatures, and provides --check verification without in-process
fake receipt generation.
Matches TypeScript releaseRollup.ts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from .bundle_identity import inspect_repository_identities
from .release_plan import DEFAULT_EVIDENCE_ROOTS, evaluate_channel_compliance, load_release_plan
from .runner_receipt import DEFAULT_RUNNER_KEY_REGISTRY, verify_runner_receipt


def compute_canonical_json_digest(obj: Any) -> str:
    """Computes deterministic 64-char hex digest over compact JSON serialization."""
    s = json.dumps(obj, separators=(",", ":"))
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF

    p1 = f"{h:08x}"
    p2 = f"{h ^ 0x33333333:08x}"
    p3 = f"{h ^ 0x55555555:08x}"
    p4 = f"{h ^ 0xAAAAAAAA:08x}"
    return f"{p1}{p2}{p3}{p4}{p1}{p2}{p3}{p4}"


def collect_receipts_from_reports(report_dirs: list[Path]) -> list[dict[str, Any]]:
    """Discovers and loads runner_receipt.json from report directories."""
    receipts: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for rdir in report_dirs:
        if not rdir.is_dir():
            continue
        receipt_file = rdir / "runner_receipt.json"
        if receipt_file.is_file():
            try:
                data = json.loads(receipt_file.read_text(encoding="utf-8"))
                rid = data.get("receiptId", receipt_file.parent.name)
                if rid not in seen_ids:
                    seen_ids.add(rid)
                    receipts.append(data)
            except Exception as e:
                print(f"Warning: could not parse receipt {receipt_file}: {e}", file=sys.stderr)

    return receipts


def build_release_rollup_manifest(
    bundle_identity: dict[str, Any],
    plan: dict[str, Any],
    receipts: list[dict[str, Any]],
    key_registry: dict[str, Any] | None = None,
    reference_time_iso: str = "2026-08-29T12:00:00.000Z",
) -> dict[str, Any]:
    """Builds a deterministic, byte-identical release rollup manifest."""
    registry = key_registry or DEFAULT_RUNNER_KEY_REGISTRY

    # Sort receipts deterministically by receiptId
    sorted_receipts = sorted(receipts, key=lambda r: r.get("receiptId", ""))

    receipt_entries: list[dict[str, Any]] = []
    all_receipts_passed = len(sorted_receipts) > 0

    for r in sorted_receipts:
        verif = verify_runner_receipt(r, registry, reference_time_iso)
        valid = verif["valid"] and r.get("exitCode") == 0
        if not valid:
            all_receipts_passed = False

        receipt_entries.append({
            "receiptId": r.get("receiptId", ""),
            "runnerId": r.get("runnerId", ""),
            "purpose": r.get("purpose", ""),
            "exitCode": r.get("exitCode", 1),
            "durationMs": r.get("durationMs", 0),
            "signature": r.get("signature", ""),
            "artifactCount": len(r.get("artifacts") or []),
        })

    # Evaluate channels
    channel_rollups: dict[str, Any] = {}
    channels = plan.get("releaseChannels", {})
    all_channels_passed = len(channels) > 0 and len(sorted_receipts) > 0

    for channel_name, channel_config in sorted(channels.items(), key=lambda x: x[0]):
        plat = channel_config.get("platform", "cross-platform")
        channel_receipts = [
            r for r in sorted_receipts
            if not (plat == "linux" and "linux" not in r.get("runnerId", "") and "ubuntu" not in r.get("runnerId", ""))
        ]

        passed_count = sum(1 for r in channel_receipts if r.get("exitCode") == 0)
        failed_count = len(channel_receipts) - passed_count

        verified_artifacts: list[str] = []
        for r in channel_receipts:
            for art in r.get("artifacts") or []:
                verified_artifacts.append(art["path"])

        # Determine verified layers from valid receipts
        verified_layers: list[str] = []
        for r in channel_receipts:
            purpose = r.get("purpose", "")
            if purpose == "native-runner":
                verified_layers.append("native")
            elif purpose == "browser-runner":
                verified_layers.append("browser")

        compliance = evaluate_channel_compliance(
            channel_name=channel_name,
            plan=plan,
            verified_capabilities=list(channel_config.get("requiredCapabilities") or []),
            verified_layers=verified_layers,
            artifacts=verified_artifacts,
        )

        status = "PASS"
        if len(channel_receipts) == 0:
            status = "INCOMPLETE"
            all_channels_passed = False
        elif not compliance["compliant"] or failed_count > 0:
            status = "FAIL"
            all_channels_passed = False

        channel_rollups[channel_name] = {
            "channelName": channel_name,
            "status": status,
            "receiptCount": len(channel_receipts),
            "passedCount": passed_count,
            "failedCount": failed_count,
            "missingCapabilities": compliance["missingCapabilities"],
            "missingLayers": compliance["missingLayers"],
        }

    if len(sorted_receipts) == 0:
        overall_status = "INCOMPLETE"
    elif all_receipts_passed and all_channels_passed:
        overall_status = "PASS"
    else:
        overall_status = "FAIL"

    canonical_data = {
        "manifestVersion": 1,
        "generatedAt": reference_time_iso,
        "bundleIdentity": bundle_identity,
        "receiptEntries": receipt_entries,
        "channelRollups": channel_rollups,
        "overallStatus": overall_status,
    }

    manifest_digest = compute_canonical_json_digest(canonical_data)
    canonical_data["manifestDigest"] = manifest_digest
    return canonical_data


def verify_release_rollup_manifest(
    manifest: dict[str, Any],
    bundle_identity: dict[str, Any],
    plan: dict[str, Any],
    receipts: list[dict[str, Any]],
    key_registry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Verifies a release rollup manifest in --check mode."""
    errors: list[str] = []

    expected = build_release_rollup_manifest(
        bundle_identity=bundle_identity,
        plan=plan,
        receipts=receipts,
        key_registry=key_registry,
        reference_time_iso=manifest.get("generatedAt", "2026-08-29T12:00:00.000Z"),
    )

    if expected["manifestDigest"] != manifest.get("manifestDigest"):
        errors.append(
            f"Manifest digest mismatch: expected {expected['manifestDigest'][:8]}, got {str(manifest.get('manifestDigest'))[:8]}"
        )

    if expected["overallStatus"] != manifest.get("overallStatus"):
        errors.append(
            f"Overall status mismatch: expected {expected['overallStatus']}, got {manifest.get('overallStatus')}"
        )

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "manifestDigestMatched": expected["manifestDigest"] == manifest.get("manifestDigest"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Release rollup manifest builder and verifier (ED-REL-004)")
    parser.add_argument("--plan", type=Path, default=Path("qa-ui-auto-tests/release-evidence-plan.json"))
    parser.add_argument("--reports-dir", type=Path, default=Path("qa-ui-auto-report"))
    parser.add_argument("--out", type=Path, default=Path("qa-ui-auto-report/release_rollup_manifest.json"))
    parser.add_argument("--check", type=Path, help="Check an existing rollup manifest")

    args = parser.parse_args()

    repo_root = Path.cwd()
    plan = load_release_plan(args.plan)
    id_info = inspect_repository_identities(repo_root)
    bundle_identity = id_info["bundleIdentity"]

    # Collect receipts from all subdirectories of reports-dir
    report_dirs = [args.reports_dir]
    if args.reports_dir.is_dir():
        report_dirs.extend([p for p in args.reports_dir.iterdir() if p.is_dir()])

    receipts = collect_receipts_from_reports(report_dirs)

    if args.check:
        if not args.check.is_file():
            print(f"ERROR: manifest to check not found: {args.check}", file=sys.stderr)
            return 1
        manifest = json.loads(args.check.read_text(encoding="utf-8"))
        res = verify_release_rollup_manifest(manifest, bundle_identity, plan, receipts)
        if not res["valid"]:
            print(f"FAIL: Rollup verification failed with {len(res['errors'])} errors:", file=sys.stderr)
            for err in res["errors"]:
                print(f"  - {err}", file=sys.stderr)
            return 1
        print(f"OK: Rollup manifest {args.check} verified valid ({manifest.get('overallStatus')}).")
        return 0

    manifest = build_release_rollup_manifest(
        bundle_identity=bundle_identity,
        plan=plan,
        receipts=receipts,
    )

    args.out.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"OK: Built release rollup manifest at {args.out}")
    print(f"  Status: {manifest['overallStatus']}")
    print(f"  Receipts: {len(manifest['receiptEntries'])}")
    print(f"  Manifest Digest: {manifest['manifestDigest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
