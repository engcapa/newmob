#!/usr/bin/env python3
"""Probe dependent services before running qa-ui-auto tests.

Checks (selected by mode):
  - browser : Vite dev server reachable at app.base_url
  - native  : Tauri binary built; on Linux, a display (DISPLAY/Xvfb/VNC)
  - ssh/sftp host:port TCP reachable (if any test references them)

Prints actionable, copy-pasteable instructions for whatever is missing,
then exits non-zero. When all required services are up, exits 0 silently.

Can be run standalone:
    python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tauri_webdriver import native_binary, native_tool_issues  # noqa: E402

ROOT = Path.cwd()
DEV_PROXY_ALLOW_PRIVATE = "DEV_PROXY_ALLOW_PRIVATE"
ALLOW_PRIVATE_TARGETS = "ALLOW_PRIVATE_TARGETS"


# ─── helpers ────────────────────────────────────────────────────────────────

def _http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status < 500
    except Exception:
        return False


def _tcp_ok(host: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _on_replit() -> bool:
    return bool(os.environ.get("REPL_ID") or os.environ.get("REPLIT_DEV_DOMAIN"))


# ─── individual probes ──────────────────────────────────────────────────────

def probe_dev_server(cfg: dict) -> list[str]:
    url = cfg["app"]["base_url"]
    if _http_ok(url):
        return []
    hints = [
        f"✗ Dev server not reachable at {url}.",
        f"  Start it with {DEV_PROXY_ALLOW_PRIVATE}=1 and {ALLOW_PRIVATE_TARGETS}=1 so SSH/SFTP tests can reach private and local hosts:",
        "    • PowerShell:  $env:DEV_PROXY_ALLOW_PRIVATE=\"1\"; $env:ALLOW_PRIVATE_TARGETS=\"1\"; pnpm run dev",
        "    • cmd.exe:     set DEV_PROXY_ALLOW_PRIVATE=1 && set ALLOW_PRIVATE_TARGETS=1 && pnpm run dev",
        "    • macOS/Linux: DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm run dev",
    ]
    if _on_replit():
        hints.append("    • In Replit: restart the workflow named "
                     "`Start application` after adding "
                     "`DEV_PROXY_ALLOW_PRIVATE=1` and `ALLOW_PRIVATE_TARGETS=1` to that workflow")
    hints += [
        "  Then wait until the page loads in a browser before re-running "
        "qa-ui-auto.",
    ]
    return hints


def probe_native(cfg: dict) -> list[str]:
    binary = native_binary(cfg)
    hints: list[str] = []
    if not binary.exists():
        hints += [
            f"✗ Tauri debug binary not found at {binary}.",
            "  Build it first:",
            "    pnpm tauri build --debug --no-bundle",
            "  or:",
            "    cargo tauri build --debug --no-bundle",
        ]
    hints += native_tool_issues(cfg)
    if platform.system() == "Linux" and not os.environ.get("DISPLAY"):
        hints += [
            "✗ No DISPLAY set — the native binary needs an X server.",
            "  Options:",
            "    • Start the `VNC Server` workflow (provides :0 via Xvfb+x11vnc).",
            "    • Or run headless:  Xvfb :99 & export DISPLAY=:99",
        ]
    return hints


def probe_ssh(cfg: dict, key: str) -> list[str]:
    sec = cfg.get(key) or {}
    host, port = sec.get("host"), sec.get("port")
    if not host or not port:
        return [f"✗ {key}.host / {key}.port not set in qa-ui-auto.config.yaml."]
    if _tcp_ok(host, port):
        return []
    fixtures = (cfg.get("fixtures") or {})
    auto = fixtures.get("start_local_sshd")
    hints = [f"✗ {key.upper()} server unreachable at {host}:{port}."]
    if auto:
        hints += [
            "  fixtures.start_local_sshd is true — the runner will try to "
            "start a Docker container. Make sure Docker is installed and "
            "the daemon is running:",
            "    docker info",
        ]
    else:
        hints += [
            "  Either set fixtures.start_local_sshd: true in "
            "qa-ui-auto.config.yaml (requires Docker), or start your own:",
            f"    docker run -d --rm --name qa-sshd -p {port}:2222 \\",
            f"      -e USER_NAME={sec.get('user', 'testuser')} \\",
            "      -e PASSWORD_ACCESS=true \\",
            f"      -e USER_PASSWORD=$QA_SSH_PASSWORD \\",
            "      linuxserver/openssh-server:latest",
            "  Or point the config at an existing reachable host.",
        ]
    return hints


def probe_browser_tooling() -> list[str]:
    hints: list[str] = []
    if not shutil.which("playwright-cli"):
        hints += [
            "✗ playwright-cli not found on PATH.",
            "  Install:  npm install -g @playwright/cli@latest",
            "  Then:     playwright-cli install chromium",
        ]
    if not shutil.which("pnpm"):
        hints += [
            "✗ pnpm not found.",
            "  Install:  npm install -g pnpm   (or `corepack enable`)",
        ]
    return hints


# ─── orchestration ──────────────────────────────────────────────────────────

def probe(cfg: dict, mode: str, *, need_ssh: bool = True,
          need_sftp: bool = True) -> list[str]:
    issues: list[str] = []
    if mode == "browser":
        issues += probe_browser_tooling()
        issues += probe_dev_server(cfg)
    elif mode == "native":
        issues += probe_native(cfg)
    if need_ssh:
        issues += probe_ssh(cfg, "ssh")
    if need_sftp:
        issues += probe_ssh(cfg, "sftp")
    return issues


def report(issues: list[str], mode: str = "browser") -> int:
    if not issues:
        return 0
    print("\nqa-ui-auto preflight: required services are not ready.\n")
    print("\n".join(issues))
    print("\nFix the items above and re-run. To re-probe only:")
    print(f"    python .agents/skills/qa-ui-auto/scripts/probe.py --mode {mode}")
    return 2


def _load_config(path: Path) -> dict:
    if not path.exists():
        print(f"qa-ui-auto: config not found at {path}.")
        print("Copy the example and edit it:")
        print(f"  cp .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml {path}")
        sys.exit(2)
    import yaml
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def main() -> int:
    os.environ.setdefault(DEV_PROXY_ALLOW_PRIVATE, "1")
    os.environ.setdefault(ALLOW_PRIVATE_TARGETS, "1")
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["browser", "native"], default="browser")
    ap.add_argument("--config", default="qa-ui-auto.config.yaml")
    ap.add_argument("--no-ssh", action="store_true")
    ap.add_argument("--no-sftp", action="store_true")
    args = ap.parse_args()
    cfg = _load_config(Path(args.config))
    cfg.setdefault("app", {}).setdefault("base_url", "http://localhost:5000")
    issues = probe(cfg, args.mode,
                   need_ssh=not args.no_ssh,
                   need_sftp=not args.no_sftp)
    return report(issues, args.mode)


if __name__ == "__main__":
    sys.exit(main())
