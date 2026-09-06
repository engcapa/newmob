"""Content identities for execution freshness and QA build reuse."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def repository_files(root: Path) -> list[str]:
    raw = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root,
    )
    return sorted(set(raw.decode("utf-8").split("\0")) - {""})


def input_digest(path: Path) -> str:
    """Canonical text identity across Git LF and Windows CRLF checkouts.

    This intentionally reads the file on every call. Windows timestamp
    granularity is not strong enough to safely cache same-size rewrites, and a
    false fresh identity would invalidate the execution gate.
    """
    path = path.resolve()
    if path.suffix.lower() in {".ts", ".tsx", ".rs", ".json", ".py", ".toml", ".yaml", ".yml",
                               ".md", ".sh", ".ps1", ".html", ".css", ".js", ".mjs", ".cjs",
                               ".lock", ".txt", ".svg"}:
        return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    return digest_file(path)


def source_input(name: str) -> bool:
    return (name.startswith(("src/", "src-tauri/", "vite-plugins/", "scripts/", "public/", ".cargo/"))
            and not name.startswith(("src-tauri/target/", "src-tauri/tests/"))) or (
        name in {"package.json", "pnpm-lock.yaml", "vite.config.ts", "index.html", "rust-toolchain.toml", "rust-toolchain"}
        or name.startswith("tsconfig")
    )


def fingerprint(root: Path, names: list[str]) -> str:
    entries = []
    for name in sorted(set(names)):
        path = root / name
        entries.append([name, input_digest(path) if path.is_file() else "deleted"])
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def source_identity(root: Path) -> str:
    return fingerprint(root, [name for name in repository_files(root) if source_input(name)])


def runner_identity(root: Path) -> str:
    prefix = ".agents/skills/qa-ui-auto/"
    return fingerprint(root, [name for name in repository_files(root)
                             if name.startswith((prefix + "scripts/", prefix + "schema/"))])


def execution_identity(root: Path) -> dict:
    return {"source_sha256": source_identity(root), "runner_sha256": runner_identity(root)}


def conditions_identity(cfg: dict, mode: str, env: dict | None = None) -> str:
    """Bind non-secret execution conditions, excluding scheduling/output locations."""
    environment = os.environ if env is None else env
    sensitive = re.compile(r"password|passphrase|secret|token|credential|private.key", re.I)

    def project(value):
        if isinstance(value, dict):
            return {key: "<secret>" if sensitive.search(key) else project(item)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [project(item) for item in value]
        if isinstance(value, str):
            def replace(match):
                key = match.group(1)
                return "<secret>" if sensitive.search(key) else environment.get(key, "<unset>")
            return re.sub(r"\$\{env[.:]([A-Za-z0-9_]+)\}", replace, value)
        return value

    selected = {key: value for key, value in cfg.items() if key not in {"report", "worker", "webdriver", "app"}}
    selected["app"] = {"mode": mode}
    if mode == "browser":
        selected["app"]["base_url"] = cfg.get("app", {}).get("base_url", "http://localhost:5000")
    return hashlib.sha256(json.dumps(project(selected), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
