"""Provision a reproducible Git repository for the diff viewport gate.

The repository is created below the current QA report root so native runs can
keep the fixture and its manifest beside screenshots and execution receipts.
The fixture never changes the developer repository or global Git settings.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any


LONG_LINE_LENGTH = 2_000
LONG_LINE_NUMBERS = (20, 120, 220)
LONG_LINE_MARKER_COLUMN = 1_700
RELEVANT_FILES = (
    "long-lines.txt",
    "short.txt",
    "same-size.txt",
    "deleted.txt",
    "new-empty.txt",
    "new-file.txt",
)


def _run(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout.strip()


def _write_bytes(repo: Path, relative: str, content: bytes) -> None:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _long_line(number: int, marker: str) -> str:
    prefix = f"LINE{number:03d}:"
    body_length = LONG_LINE_LENGTH - len(prefix)
    body = ("abcdefghijklmnopqrstuvwxyz0123456789" * 64)[:body_length]
    line = prefix + body
    if number in LONG_LINE_NUMBERS:
        line = line[:LONG_LINE_MARKER_COLUMN] + marker + line[LONG_LINE_MARKER_COLUMN + 1:]
    return line


def _long_lines(marker: str) -> bytes:
    return ("\n".join(_long_line(number, marker) for number in range(1, 241)) + "\n").encode("utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _commit(repo: Path, message: str, *paths: str) -> str:
    _run(repo, "add", *paths)
    _run(repo, "commit", "--no-gpg-sign", "-m", message)
    return _run(repo, "rev-parse", "HEAD")


def create_fixture(output_root: Path) -> tuple[Path, Path]:
    output_root = output_root.resolve()
    repo_parent = output_root / "git-diff-repos"
    repo_parent.mkdir(parents=True, exist_ok=True)
    repo = Path(tempfile.mkdtemp(prefix="git-diff-", dir=str(repo_parent))).resolve()

    _run(repo, "init")
    _run(repo, "config", "user.name", "Taomni QA")
    _run(repo, "config", "user.email", "taomni-qa@example.invalid")
    _run(repo, "config", "core.autocrlf", "false")
    _run(repo, "config", "commit.gpgsign", "false")
    hooks = repo / ".qa-hooks"
    hooks.mkdir()
    _run(repo, "config", "core.hooksPath", ".qa-hooks")

    _write_bytes(repo, "long-lines.txt", _long_lines("A"))
    _write_bytes(repo, "short.txt", b"short-001\nshort-002\nshort-003\n")
    _write_bytes(repo, "same-size.txt", b"same-size-A\n")
    _write_bytes(repo, "deleted.txt", b"this file is removed in qa diff B\n")
    commit_a = _commit(repo, "qa diff A", *RELEVANT_FILES[:4])

    _write_bytes(repo, "long-lines.txt", _long_lines("B"))
    _write_bytes(repo, "same-size.txt", b"same-size-B\n")
    (repo / "deleted.txt").unlink()
    _write_bytes(repo, "new-empty.txt", b"")
    _write_bytes(repo, "new-file.txt", b"new file in qa diff B\n")
    commit_b = _commit(repo, "qa diff B", "-A")

    lines = _long_lines("B").decode("utf-8").splitlines()
    lines[29] = lines[29][:LONG_LINE_MARKER_COLUMN] + "W" + lines[29][LONG_LINE_MARKER_COLUMN + 1:]
    _write_bytes(repo, "long-lines.txt", ("\n".join(lines) + "\n").encode("utf-8"))
    _write_bytes(repo, "short.txt", b"short-001\nshort-002\nshort-staged\n")
    _run(repo, "add", "short.txt")
    status = _run(repo, "status", "--porcelain=v1").splitlines()

    manifest = {
        "repo": str(repo),
        "commitA": commit_a,
        "commitB": commit_b,
        "messages": ["qa diff A", "qa diff B"],
        "longLines": {
            "path": "long-lines.txt",
            "lineCount": 240,
            "changedLineNumbers": list(LONG_LINE_NUMBERS),
            "markerColumn": LONG_LINE_MARKER_COLUMN,
            "prefixes": [f"LINE{number:03d}:" for number in LONG_LINE_NUMBERS],
        },
        "fileSha256": {
            relative: _sha256(repo / relative)
            for relative in RELEVANT_FILES
            if (repo / relative).is_file()
        },
        "startingStatusPorcelain": status,
    }
    manifest_path = repo / "git-diff-fixture-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return repo, manifest_path


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("git_diff_repo requires native mode so Git IPC reads the host fixture")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    repo, manifest = create_fixture(report_root)
    values: dict[str, str] = getattr(ctx, "values")
    # YAML cases interpolate this path into JSON localStorage payloads. Use
    # slash-separated paths so Windows drive paths do not become JSON escapes.
    values["git_diff_repo"] = repo.as_posix()
    values["git_diff_commit_a"] = str(json.loads(manifest.read_text(encoding="utf-8"))["commitA"])
    values["git_diff_commit_b"] = str(json.loads(manifest.read_text(encoding="utf-8"))["commitB"])
    values["git_diff_manifest"] = manifest.as_posix()


def teardown(ctx: Any) -> None:
    # Retain the repository until report rotation so screenshots can be audited.
    _ = ctx


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        default="qa-ui-auto-report/git-diff-viewport",
        help="directory that will contain git-diff-repos/ and the generated fixture",
    )
    args = parser.parse_args(argv)
    repo, manifest = create_fixture(Path(args.output_root))
    payload = {
        "repo": str(repo),
        "manifest": str(manifest),
        "status": json.loads(manifest.read_text(encoding="utf-8"))["startingStatusPorcelain"],
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
