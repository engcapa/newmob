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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evidence_collect")
    ap.add_argument("--case", required=True)
    ap.add_argument("--gate", required=True,
                    choices=["G0", "G1", "perf", "a11y", "provider"])
    ap.add_argument("--platform", default=platform.system().lower(),
                    choices=["linux", "windows", "macos", "darwin"])
    ap.add_argument("--command", required=True)
    ap.add_argument("--result", required=True,
                    choices=["passed", "failed", "environment-blocked",
                             "platform-unverified", "provider-unverified"])
    ap.add_argument("--artifact", default="")
    ap.add_argument("--layout", default=None)
    ap.add_argument("--ime", default=None)
    ap.add_argument("--scale", default="100%")
    ap.add_argument("--fs-path", default=str(Path.home()))
    ap.add_argument("--jdk", default=None)
    ap.add_argument("--jdtls", default=None)
    ap.add_argument("--build-tool", default=None)
    ap.add_argument("--gap", action="append", default=[],
                    help="known gap; repeatable")
    ap.add_argument("--claim", default=None,
                    help="highest L0-L3 claim; collector never guesses one")
    ap.add_argument("--notes", default="")
    args = ap.parse_args(argv)

    binary = APP_BIN
    app_hash = sha256(binary) if binary.exists() else "binary-missing"

    entry = {
        "id": args.case,
        "gate": args.gate,
        "platform": {"darwin": "macos"}.get(args.platform, args.platform),
        "commit": git_commit(),
        "app_sha256": app_hash,
        "os": os_desc(),
        "webview": webkitgtk_version(),
        "arch": platform.machine(),
        "keyboard_layout": args.layout or keyboard_layout(),
        "ime": args.ime or ime(),
        "display_scale": args.scale,
        "filesystem": filesystem(Path(args.fs_path)),
        "jdk": args.jdk,
        "jdtls": args.jdtls,
        "build_tool": args.build_tool,
        "command": args.command,
        "result": args.result,
        "artifact": args.artifact or None,
        "artifact_sha256": sha256(Path(args.artifact)) if args.artifact and Path(args.artifact).exists() else None,
        "known_gaps": args.gap,
        "highest_claim": args.claim,
        "notes": args.notes,
        "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    # W7 layout: qa-ui-auto-report/evidence/<app-hash-short>/<platform>/
    out_dir = EVIDENCE_DIR / app_hash[:12] / entry["platform"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{args.case}-{time.strftime('%Y%m%d-%H%M%S')}.entry.yaml"
    out.write_text(yaml.safe_dump(entry, sort_keys=False, allow_unicode=True),
                   encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
