#!/usr/bin/env python3
"""Build an isolated QA app and bind its identifier to the produced binary."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
QA_APP_ID = "com.taomni.app.qa"
QA_CONFIG = Path(__file__).resolve().parent.parent / "assets" / "tauri.qa.conf.json"
BUILD_RECIPE = "python .agents/skills/qa-ui-auto/scripts/native_build.py"


def binary_digest(binary: Path) -> str:
    digest = hashlib.sha256()
    with binary.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def identity_path(binary: Path) -> Path:
    return binary.with_name(binary.name + ".qa-identity.json")


def verify_identity(binary: Path) -> dict:
    """Reject unrecorded, production, or replaced binaries without launching them."""
    try:
        record = json.loads(identity_path(binary).read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("identifier") != QA_APP_ID:
            raise ValueError("expected the independent QA application ID")
        if record.get("binary_sha256") != binary_digest(binary):
            raise ValueError("binary differs from its QA build record")
    except (OSError, ValueError) as exc:
        raise ValueError(f"Native QA identity check failed: {exc}. Build with: {BUILD_RECIPE}") from exc
    return record


def build_qa(*, release: bool = False) -> Path:
    overlay = json.loads(QA_CONFIG.read_text(encoding="utf-8"))
    if overlay.get("identifier") != QA_APP_ID or overlay.get("mainBinaryName") != "taomni":
        raise ValueError("QA overlay must declare the independent QA ID and taomni binary name")
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise ValueError("pnpm not found on PATH")
    target = ROOT / "src-tauri" / "target" / "qa-ui-auto"
    name = "taomni.exe" if platform.system() == "Windows" else "taomni"
    binary = target / ("release" if release else "debug") / name
    record_path = identity_path(binary)
    # A failed rebuild must not leave an old record authorizing a stale binary.
    record_path.unlink(missing_ok=True)
    env = dict(os.environ)
    env["CARGO_TARGET_DIR"] = str(target)
    env.pop("TAURI_CONFIG", None)
    command = [pnpm, "tauri", "build", "--no-bundle", "--config", str(QA_CONFIG)]
    if not release:
        command.append("--debug")
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    record = {
        "identifier": QA_APP_ID,
        "binary_sha256": binary_digest(binary),
        "platform": platform.system(),
        "profile": "release" if release else "debug",
        "command": command,
    }
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return binary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true", help="use release profile for measurements")
    args = parser.parse_args(argv)
    try:
        binary = build_qa(release=args.release)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"qa-ui-auto: QA build failed: {exc}", file=sys.stderr)
        return 2
    print(f"QA application: {binary}\nApplication ID: {QA_APP_ID}\nIdentity record: {identity_path(binary)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
