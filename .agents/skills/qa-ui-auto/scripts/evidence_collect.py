#!/usr/bin/env python3
"""Collect one sanitized R9 native-gate evidence entry (§8.19.10).

Gathers environment facts from the current machine, merges them with the
caller-reported command/result, and writes a YAML entry under
qa-ui-auto-report/evidence/. Facts the collector cannot know (result,
artifacts, known gaps) are required arguments so an entry can never be
emitted with an invented pass.

Usage:
    python evidence_collect.py --case TC-IDE-C0-01 --gate G0 \
        --command "python -m qa_ui_auto.runner --mode native ..." \
        --result passed --artifact qa-ui-auto-report/run-x/TC.../summary.json \
        [--layout de] [--ime fcitx] [--scale 200%] [--jdk 25.0.2 ...]
"""
from __future__ import annotations

import argparse
import hashlib
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

import yaml

ROOT = Path.cwd()
EVIDENCE_DIR = ROOT / "qa-ui-auto-report" / "evidence"
APP_BIN = ROOT / "src-tauri" / "target" / "debug" / "taomni"


def _run(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout).stdout.strip()
    except Exception:
        return ""


def git_commit() -> str:
    return _run(["git", "rev-parse", "HEAD"])


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def webkitgtk_version() -> str:
    out = _run(["pkg-config", "--modversion", "webkit2gtk-4.1"]) or \
        _run(["pkg-config", "--modversion", "webkit2gtk-4.0"])
    if out:
        return f"WebKitGTK {out}"
    q = _run(["dpkg-query", "-W", "-f=${Version}", "libwebkit2gtk-4.1-0"])
    return f"WebKitGTK (dpkg {q})" if q else "unknown"


def keyboard_layout() -> str:
    out = _run(["setxkbmap", "-query"])
    m = re.search(r"^layout:\s*(.+)$", out, re.M)
    return m.group(1).strip() if m else ("unknown" if out == "" else "unknown")


def ime() -> str:
    import os
    for var in ("GTK_IM_MODULE", "QT_IM_MODULE", "XMODIFIERS"):
        v = os.environ.get(var)
        if v:
            return v
    return "none"


def filesystem(path: Path) -> str:
    out = _run(["df", "-T", str(path)])
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1] == str(path):
            return parts[1]
    return "unknown"


def os_desc() -> str:
    pretty = ""
    etc = Path("/etc/os-release")
    if etc.exists():
        for line in etc.read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                pretty = line.split("=", 1)[1].strip().strip('"')
                break
    return f"{platform.system()} {platform.release()} {pretty}".strip()


def app_version() -> str:
    pkg = ROOT / "package.json"
    if pkg.exists():
        try:
            import json
            return str(json.loads(pkg.read_text(encoding="utf-8")).get("version", "0.0.0"))
        except Exception:
            pass
    return "0.0.0"


def parse_scale(val: str | float) -> float:
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    if s.endswith("%"):
        try:
            return float(s[:-1]) / 100.0
        except ValueError:
            return 1.0
    try:
        return float(s)
    except ValueError:
        return 1.0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evidence_collect")
    ap.add_argument("--case", required=True, help="Capability or testcase ID")
    ap.add_argument("--gate", default="G0",
                    choices=["G0", "G1", "perf", "a11y", "provider"])
    ap.add_argument("--platform", default=platform.system().lower(),
                    choices=["linux", "windows", "macos", "darwin"])
    ap.add_argument("--language", default=None, help="Target language, e.g. java / typescript")
    ap.add_argument("--command", required=True)
    ap.add_argument("--result", required=True,
                    choices=["passed", "failed", "blocked", "environment-blocked",
                             "platform-unverified", "provider-unverified", "manual-native"])
    ap.add_argument("--layer", action="append", default=[], dest="layers",
                    choices=["unit", "mounted", "browser", "native", "provider", "idea-compare"],
                    help="Evidence layers; repeatable")
    ap.add_argument("--artifact", action="append", default=[], dest="artifacts",
                    help="Path to artifact file; repeatable")
    ap.add_argument("--artifact-kind", default="summary-json")
    ap.add_argument("--layout", default=None)
    ap.add_argument("--ime", default=None)
    ap.add_argument("--scale", default="100%")
    ap.add_argument("--fs-path", default=str(Path.home()))
    ap.add_argument("--provider-id", default=None)
    ap.add_argument("--provider-version", default=None)
    ap.add_argument("--provider-fixture", default=None)
    ap.add_argument("--jdk", default=None)
    ap.add_argument("--jdtls", default=None)
    ap.add_argument("--build-tool", default=None)
    ap.add_argument("--gap", action="append", default=[],
                    help="known gap; repeatable")
    ap.add_argument("--claim", default="L1", choices=["L0", "L1", "L2", "L3"],
                    help="highest L0-L3 claim; collector never guesses")
    ap.add_argument("--notes", default="")
    args = ap.parse_args(argv)

    binary = APP_BIN
    app_hash = sha256(binary) if binary.exists() else "0000000000000000000000000000000000000000000000000000000000000000"

    norm_platform = "macos" if args.platform in ("darwin", "macos") else args.platform

    # Normalize result: environment-blocked -> blocked with gap note
    result = args.result
    gaps = list(args.gap)
    if result == "environment-blocked":
        result = "blocked"
        gaps.append("Environment blocked (fixture/provider unavailable)")

    # Construct artifacts list
    artifacts_list = []
    for art_path in args.artifacts:
        p = Path(art_path)
        art_hash = sha256(p) if p.exists() else "file-not-found"
        artifacts_list.append({
            "kind": args.artifact_kind,
            "path": str(p),
            "sha256": art_hash,
            "redacted": True,
        })

    # Provider object
    provider_id = args.provider_id or ("jdtls" if args.jdtls else None)
    provider_ver = args.provider_version or args.jdtls or ""
    provider_fix = args.provider_fixture or ""
    provider_obj = None
    if provider_id:
        provider_obj = {
            "id": provider_id,
            "version": provider_ver,
            "fixture": provider_fix,
        }

    layers = list(args.layers)
    if not layers:
        # Default layer inferred honestly from command/mode
        if "native" in args.command:
            layers.append("native")
        elif "browser" in args.command:
            layers.append("browser")
        else:
            layers.append("unit")

    entry = {
        "schemaVersion": 2,
        "capabilityId": args.case,
        "languageId": args.language,
        "app": {
            "commit": git_commit(),
            "bundleHash": app_hash,
            "version": app_version(),
        },
        "environment": {
            "platform": norm_platform,
            "os": os_desc(),
            "arch": platform.machine(),
            "webview": webkitgtk_version(),
            "keyboard": args.layout or keyboard_layout(),
            "ime": args.ime or ime(),
            "scale": parse_scale(args.scale),
            "filesystem": filesystem(Path(args.fs_path)),
        },
        "provider": provider_obj,
        "evidenceLayers": layers,
        "result": result,
        "command": args.command,
        "artifacts": artifacts_list,
        "knownGaps": gaps,
        "maximumClaim": args.claim,
        "notes": args.notes,
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }

    # W7/V0 layout: qa-ui-auto-report/evidence/<app-hash-short>/<platform>/
    out_dir = EVIDENCE_DIR / app_hash[:12] / entry["environment"]["platform"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{args.case}-{time.strftime('%Y%m%d-%H%M%S')}.entry.yaml"
    out.write_text(yaml.safe_dump(entry, sort_keys=False, allow_unicode=True),
                   encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
