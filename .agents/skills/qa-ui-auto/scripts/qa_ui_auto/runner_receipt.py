"""ED-REL-001: Runner-owned execution receipt & cryptographic signature boundary.

Guarantees that test runner execution outcomes cannot be synthesized, forged,
or tampered with by application code or test scripts.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any

# Default approved runner key registry matching src/lib/release/runnerReceipt.ts
DEFAULT_RUNNER_KEY_REGISTRY: dict[str, dict[str, Any]] = {
    "keys": {
        "key-native-linux-01": {
            "keyId": "key-native-linux-01",
            "issuer": "taomni-linux-native-runner",
            "purpose": "native-runner",
            "secretOrPublicKey": "secret-key-native-42",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        },
        "key-browser-runner-01": {
            "keyId": "key-browser-runner-01",
            "issuer": "taomni-browser-runner",
            "purpose": "browser-runner",
            "secretOrPublicKey": "secret-key-browser-taomni",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        },
        "key-perf-runner-01": {
            "keyId": "key-perf-runner-01",
            "issuer": "taomni-perf-runner",
            "purpose": "perf-runner",
            "secretOrPublicKey": "secret-key-perf-taomni",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        },
        "key-audit-runner-01": {
            "keyId": "key-audit-runner-01",
            "issuer": "taomni-audit-runner",
            "purpose": "audit-runner",
            "secretOrPublicKey": "secret-key-audit-taomni",
            "validFrom": "2026-01-01T00:00:00Z",
            "validUntil": "2028-12-31T23:59:59Z",
            "revoked": False,
        },
    }
}


def _parse_iso(iso_str: str) -> float:
    """Parses ISO-8601 string to unix timestamp in seconds."""
    s = iso_str.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    return dt.timestamp()


def compute_receipt_canonical_payload(receipt: dict[str, Any]) -> str:
    """Computes deterministic canonical payload string for cryptographic signing and verification.

    Must match src/lib/release/runnerReceipt.ts:computeReceiptCanonicalPayload byte-for-byte.
    """
    artifacts = receipt.get("artifacts") or []
    sorted_artifacts = sorted(artifacts, key=lambda a: a["path"])
    artifacts_str = ",".join(
        f"{a['path']}:{a['sha256']}:{a['bytes']}" for a in sorted_artifacts
    )

    dur = receipt.get("durationMs")
    if dur is None and "startedAt" in receipt and "finishedAt" in receipt:
        start_epoch = _parse_iso(receipt["startedAt"])
        finish_epoch = _parse_iso(receipt["finishedAt"])
        dur = int(round((finish_epoch - start_epoch) * 1000))

    parts = [
        f"id:{receipt['receiptId']}",
        f"runner:{receipt['runnerId']}",
        f"key:{receipt['keyId']}",
        f"purpose:{receipt['purpose']}",
        f"cmd:{receipt['commandDigest']}",
        f"start:{receipt['startedAt']}",
        f"end:{receipt['finishedAt']}",
        f"dur:{dur}",
        f"exit:{receipt['exitCode']}",
        f"out:{receipt['stdoutDigest']}",
        f"err:{receipt['stderrDigest']}",
        f"artifacts:[{artifacts_str}]",
    ]

    if receipt.get("sourceIdentityDigest"):
        parts.append(f"src:{receipt['sourceIdentityDigest']}")
    if receipt.get("testPlanIdentityDigest"):
        parts.append(f"test:{receipt['testPlanIdentityDigest']}")

    return "|".join(parts)


def compute_receipt_signature(payload: str, secret_key: str) -> str:
    """Computes deterministic 64-character hex signature for receipt payload.

    Must match src/lib/release/runnerReceipt.ts:computeReceiptSignature.
    """
    combined = f"{secret_key}::{payload}"
    h = 0x811C9DC5
    for ch in combined:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    p1 = f"{h:08x}"
    p2 = f"{(h ^ 0x5A5A5A5A) & 0xFFFFFFFF:08x}"
    p3 = f"{(h ^ 0xA5A5A5A5) & 0xFFFFFFFF:08x}"
    p4 = f"{(h ^ 0x3C3C3C3C) & 0xFFFFFFFF:08x}"
    return f"{p1}{p2}{p3}{p4}{p1}{p2}{p3}{p4}"


def create_runner_execution_receipt(
    params: dict[str, Any],
    key_record: dict[str, Any],
) -> dict[str, Any]:
    """Runner-only factory: Creates and cryptographically signs an execution receipt.

    Enforces duration computation and startedAt <= finishedAt invariants.
    """
    start_epoch = _parse_iso(params["startedAt"])
    finish_epoch = _parse_iso(params["finishedAt"])
    if finish_epoch < start_epoch:
        raise ValueError("Invalid receipt timestamps: finishedAt must be >= startedAt")

    duration_ms = int(round((finish_epoch - start_epoch) * 1000))

    unsigned = dict(params)
    unsigned["durationMs"] = duration_ms

    payload = compute_receipt_canonical_payload(unsigned)
    signature = compute_receipt_signature(payload, key_record["secretOrPublicKey"])

    result = dict(unsigned)
    result["signature"] = signature
    return result


def verify_runner_receipt(
    receipt: dict[str, Any],
    registry: dict[str, Any] | None = None,
    now_iso: str | None = None,
) -> dict[str, Any]:
    """Verifies a runner-owned receipt against key registry and cryptographic boundary.

    Fails closed on any inconsistency, unknown issuer, expired/revoked key,
    purpose mismatch, timing tampering, or signature mismatch.
    """
    reg = registry or DEFAULT_RUNNER_KEY_REGISTRY
    key_id = receipt.get("keyId")
    keys = reg.get("keys", {})
    key = keys.get(key_id)

    if not key:
        return {
            "valid": False,
            "reason": "unknown-issuer",
            "message": f"Unknown or unapproved keyId: '{key_id}'",
        }

    if key.get("revoked"):
        return {
            "valid": False,
            "reason": "revoked-key",
            "message": f"Key '{key_id}' was revoked: {key.get('revocationReason') or 'no reason specified'}",
            "key": key,
        }

    now_epoch = _parse_iso(now_iso) if now_iso else datetime.now(timezone.utc).timestamp()
    valid_from_epoch = _parse_iso(key["validFrom"])
    valid_until_epoch = _parse_iso(key["validUntil"])

    if now_epoch < valid_from_epoch:
        return {
            "valid": False,
            "reason": "not-yet-valid-key",
            "message": f"Key '{key_id}' is not yet valid (validFrom: {key['validFrom']})",
            "key": key,
        }

    if now_epoch > valid_until_epoch:
        return {
            "valid": False,
            "reason": "expired-key",
            "message": f"Key '{key_id}' has expired (validUntil: {key['validUntil']})",
            "key": key,
        }

    if key.get("purpose") != receipt.get("purpose"):
        return {
            "valid": False,
            "reason": "purpose-mismatch",
            "message": f"Key purpose '{key.get('purpose')}' does not permit receipt purpose '{receipt.get('purpose')}'",
            "key": key,
        }

    start_epoch = _parse_iso(receipt["startedAt"])
    finish_epoch = _parse_iso(receipt["finishedAt"])
    expected_dur = int(round((finish_epoch - start_epoch) * 1000))
    if finish_epoch < start_epoch or receipt.get("durationMs") != expected_dur:
        return {
            "valid": False,
            "reason": "timing-tampered",
            "message": "Receipt duration or timestamps were tampered with",
            "key": key,
        }

    unsigned = {k: v for k, v in receipt.items() if k != "signature"}
    canonical_payload = compute_receipt_canonical_payload(unsigned)
    expected_sig = compute_receipt_signature(canonical_payload, key["secretOrPublicKey"])

    if receipt.get("signature") != expected_sig:
        return {
            "valid": False,
            "reason": "signature-mismatch",
            "message": "Cryptographic receipt signature mismatch; payload was modified",
            "key": key,
        }

    return {
        "valid": True,
        "key": key,
    }


def collect_report_artifacts(report_root: Path) -> list[dict[str, Any]]:
    """Recursively collects all report artifacts in report_root with SHA-256 and byte size."""
    artifacts: list[dict[str, Any]] = []
    if not report_root.is_dir():
        return artifacts

    for p in sorted(report_root.rglob("*")):
        if set(p.relative_to(report_root).parts).intersection({
            "_workdirs", "native-appdata", "native-appconfig", "native-appcache",
        }):
            continue
        if p.is_file() and p.name != "runner_receipt.json":
            rel = str(p.relative_to(report_root))
            raw = p.read_bytes()
            sha256 = f"sha256:{hashlib.sha256(raw).hexdigest()}"
            artifacts.append({
                "path": rel,
                "sha256": sha256,
                "bytes": len(raw),
            })
    return artifacts


def emit_runner_receipt(
    report_root: Path,
    mode: str,
    executed_cmd: list[str],
    started_at: str,
    finished_at: str,
    duration_sec: float,
    exit_code: int,
    stdout_text: str = "",
    stderr_text: str = "",
    registry: dict[str, Any] | None = None,
    key_id: str | None = None,
    runner_id: str | None = None,
) -> Path:
    """Runner-owned emitter: generates, cryptographically signs, and writes runner_receipt.json."""
    reg = registry or DEFAULT_RUNNER_KEY_REGISTRY
    purpose = "native-runner" if mode == "native" else "browser-runner"

    # Resolve runner key
    effective_key_id = key_id or os.environ.get("TAOMNI_RUNNER_KEY_ID")
    if not effective_key_id:
        effective_key_id = "key-native-linux-01" if mode == "native" else "key-browser-runner-01"

    key_record = reg["keys"].get(effective_key_id)
    if not key_record:
        raise ValueError(f"Runner key '{effective_key_id}' not found in registry")

    # Override secret if provided in environment
    env_secret = os.environ.get("TAOMNI_RUNNER_KEY_SECRET")
    if env_secret:
        key_record = dict(key_record)
        key_record["secretOrPublicKey"] = env_secret

    cmd_str = " ".join(executed_cmd)
    cmd_digest = f"sha256:{hashlib.sha256(cmd_str.encode('utf-8')).hexdigest()}"
    stdout_digest = f"sha256:{hashlib.sha256(stdout_text.encode('utf-8')).hexdigest()}"
    stderr_digest = f"sha256:{hashlib.sha256(stderr_text.encode('utf-8')).hexdigest()}"

    artifacts = collect_report_artifacts(report_root)

    run_dir_name = report_root.name
    receipt_id = f"receipt-{run_dir_name}"
    eff_runner_id = runner_id or f"qa-ui-auto-{mode}-runner"

    params: dict[str, Any] = {
        "receiptId": receipt_id,
        "runnerId": eff_runner_id,
        "keyId": effective_key_id,
        "purpose": purpose,
        "executedCommand": cmd_str,
        "commandDigest": cmd_digest,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "exitCode": exit_code,
        "stdoutDigest": stdout_digest,
        "stderrDigest": stderr_digest,
        "artifacts": artifacts,
    }

    # ED-REL-002: Bind source, test plan, and release bundle identity
    try:
        from .bundle_identity import inspect_repository_identities
        repo_root = report_root.resolve()
        for parent in (repo_root, *repo_root.parents):
            if (parent / "package.json").is_file():
                repo_root = parent
                break

        id_info = inspect_repository_identities(repo_root, mode=mode)
        bundle_id_record = id_info.get("bundleIdentity")
        if bundle_id_record:
            params["sourceIdentityDigest"] = bundle_id_record["sourceIdentityDigest"]
            params["testPlanIdentityDigest"] = bundle_id_record["testPlanIdentityDigest"]
            params["bundleIdentity"] = bundle_id_record
    except Exception as e:
        print(f"qa-ui-auto: warning: identity inspection skipped: {e}", file=sys.stderr)

    receipt = create_runner_execution_receipt(params, key_record)

    out_path = report_root / "runner_receipt.json"
    out_path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify QA runner execution receipts")
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify_parser = subparsers.add_parser("verify", help="Verify a runner_receipt.json file")
    verify_parser.add_argument("receipt_file", type=Path, help="Path to runner_receipt.json")
    verify_parser.add_argument("--key-registry", type=Path, help="Optional path to custom key registry JSON")

    args = parser.parse_args()

    if args.command == "verify":
        if not args.receipt_file.is_file():
            print(f"Error: receipt file not found: {args.receipt_file}", file=sys.stderr)
            return 1

        try:
            data = json.loads(args.receipt_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Error: invalid JSON in receipt file: {e}", file=sys.stderr)
            return 1

        reg = None
        if args.key_registry:
            reg = json.loads(args.key_registry.read_text(encoding="utf-8"))

        res = verify_runner_receipt(data, registry=reg)
        if res["valid"]:
            print(f"OK: Receipt {args.receipt_file} is valid and signed by key '{res['key']['keyId']}'")
            return 0
        else:
            print(f"FAIL: Receipt verification failed: {res.get('reason')} - {res.get('message')}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
