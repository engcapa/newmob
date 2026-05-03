#!/usr/bin/env python3
"""Preflight environment check for qa-ui-auto.

Verifies / installs:
  - node >= 18, pnpm
  - project node_modules (pnpm install if missing)
  - playwright-cli (npm i -g @playwright/cli@latest if absent)
  - chromium browser (playwright-cli install chromium)
  - python yaml package

Exits 0 on success, non-zero on unrecoverable error.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3].parent if False else Path.cwd()


def run(cmd: list[str], check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    print(f"$ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def have(bin_name: str) -> bool:
    return shutil.which(bin_name) is not None


def ensure_node() -> None:
    if not have("node"):
        sys.exit("node is not installed. Install Node.js >= 18 and retry.")
    out = run(["node", "--version"], capture=True).stdout.strip()
    major = int(out.lstrip("v").split(".")[0])
    if major < 18:
        sys.exit(f"node >= 18 required, found {out}")


def ensure_pnpm() -> None:
    if not have("pnpm"):
        # Try corepack
        if have("corepack"):
            run(["corepack", "enable"])
        else:
            run(["npm", "install", "-g", "pnpm"])


def ensure_project_deps() -> None:
    if not (Path.cwd() / "node_modules").exists():
        run(["pnpm", "install"])


def ensure_playwright_cli() -> None:
    try:
        run(["playwright-cli", "--version"], capture=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        run(["npm", "install", "-g", "@playwright/cli@latest"])
    # Install chromium browser (idempotent)
    try:
        run(["playwright-cli", "install", "chromium"])
    except subprocess.CalledProcessError:
        # Some versions use `npx playwright install`; fall back.
        run(["npx", "--yes", "playwright", "install", "chromium"])


def ensure_python_deps() -> None:
    try:
        import yaml  # noqa: F401
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "--quiet", "pyyaml"])


def main() -> int:
    ensure_node()
    ensure_pnpm()
    ensure_project_deps()
    ensure_playwright_cli()
    ensure_python_deps()
    print("qa-ui-auto: environment OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
