#!/usr/bin/env python3
"""Scoped TypeScript gate for the `typecheck` evidence kind.

Runs the repository typecheck once and reports diagnostics split into the paths a
task card owns versus everything else. Exit status reflects only the owned paths,
so one card's unfinished module cannot hold another card's evidence hostage. The
repo-wide `build` gate stays the property of the gate/release cards.

    python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py \\
      --path src/components/editor/workspace/workspaceClipboardSession.ts \\
      --path src/components/editor/workspace/workspaceClipboardSession.test.ts

Use --from-file to score an already captured `pnpm build` / `tsc -b` log instead
of recompiling. Never hand-edit the log: the command and its counts are the
evidence.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

DIAGNOSTIC = re.compile(r"^(?P<file>[^(\s][^(]*)\((?P<line>\d+),(?P<col>\d+)\): (?P<severity>error|warning) (?P<code>TS\d+): (?P<message>.*)$")
DEFAULT_COMMAND = ["pnpm", "exec", "tsc", "-b", "--pretty", "false"]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def run_typecheck(command: list[str], cwd: Path) -> str:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    return completed.stdout + completed.stderr


def parse(output: str) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []
    for raw in output.splitlines():
        match = DIAGNOSTIC.match(raw.rstrip())
        if match and match.group("severity") == "error":
            found.append({**match.groupdict(), "raw": raw.rstrip()})
    return found


def owns(file_path: str, scopes: list[str]) -> bool:
    normalized = file_path.replace("\\", "/").lstrip("./")
    for scope in scopes:
        target = scope.replace("\\", "/").lstrip("./").rstrip("/")
        if normalized == target or normalized.startswith(f"{target}/"):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Scoped TypeScript gate for one task card")
    parser.add_argument("--path", action="append", required=True, help="Repo-relative file or directory this card owns (repeatable)")
    parser.add_argument("--from-file", type=Path, help="Score this captured tsc/pnpm build log instead of recompiling")
    parser.add_argument("--command", help="Override the typecheck command (default: pnpm exec tsc -b --pretty false)")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable summary")
    args = parser.parse_args()

    root = repo_root()
    if args.from_file:
        source = str(args.from_file)
        output = args.from_file.read_text(encoding="utf-8", errors="replace")
    else:
        command = args.command.split() if args.command else DEFAULT_COMMAND
        source = " ".join(command)
        output = run_typecheck(command, root)

    diagnostics = parse(output)
    scoped = [item for item in diagnostics if owns(item["file"], args.path)]
    external = [item for item in diagnostics if item not in scoped]
    external_files = sorted({item["file"] for item in external})

    if args.json:
        print(json.dumps({
            "source": source,
            "scope": args.path,
            "scoped_errors": len(scoped),
            "external_errors": len(external),
            "external_files": external_files,
            "scoped": [item["raw"] for item in scoped],
        }, ensure_ascii=False, indent=2))
    else:
        print(f"typecheck source: {source}")
        print(f"scope: {', '.join(args.path)}")
        print(f"scoped errors: {len(scoped)}")
        for item in scoped:
            print(f"  {item['raw']}")
        print(f"out-of-scope errors: {len(external)} across {len(external_files)} file(s) (owned by other cards)")
        for path in external_files:
            print(f"  - {path}")
        print("RESULT: passed" if not scoped else "RESULT: failed")

    return 0 if not scoped else 1


if __name__ == "__main__":
    sys.exit(main())
