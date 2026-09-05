#!/usr/bin/env python3
"""Editor Baseline Summary Receipt Generator (ED-GATE-002 / BB0-C).

Generates a read-only, non-release claim baseline receipt recording:
- Git source commit, tree hash, tested source tree hash (SHA-256 of tracked sources)
- Source dirty status, explicit lists of dirty/untracked product files
- Deterministic command execution summaries:
  * pnpm test (vitest test files / test counts / failures)
  * pnpm build (tsc -b + vite production build)
  * cargo test --lib (rust test counts / failures)
  * qa-ui-auto audit --diff (QA case counts / diff impact / broken cases / lint)
- Quarantined non-editor issues with ADR tracking
- Byte-identical reproduction across runs on identical commit & input facts

Safety invariants:
- Non-release claim: must NEVER write to qa-ui-auto-tests/native/evidence/ or
  modify qa-ui-auto-tests/native/manifest.v1.*
- Read-only inspection and structured report generation.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[4]

SOURCE_GLOBS = [
    "src",
    "src-tauri/src",
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "tsconfig.json",
]

DISALLOWED_OUTPUT_DIRS = [
    ROOT / "qa-ui-auto-tests" / "native" / "evidence",
    ROOT / "qa-ui-auto-tests" / "native" / "manifest.v1.json",
    ROOT / "qa-ui-auto-tests" / "native" / "manifest.v1.md",
]


def _run_cmd(cmd: list[str], cwd: Optional[Path] = None, timeout: float = 30.0) -> tuple[int, str, str]:
    try:
        res = subprocess.run(
            cmd,
            cwd=str(cwd or ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return res.returncode, res.stdout, res.stderr
    except Exception as exc:
        return 1, "", str(exc)


def get_current_head() -> str:
    _, stdout, _ = _run_cmd(["git", "rev-parse", "HEAD"])
    return stdout.strip()


def get_git_tree_hash() -> str:
    _, stdout, _ = _run_cmd(["git", "rev-parse", "HEAD^{tree}"])
    return stdout.strip()


def get_git_commit_date() -> str:
    _, stdout, _ = _run_cmd(["git", "log", "-1", "--format=%cI"])
    return stdout.strip()


def get_dirty_product_files() -> list[str]:
    cmd = ["git", "status", "--porcelain", "--"] + SOURCE_GLOBS
    _, stdout, _ = _run_cmd(cmd)
    dirty = []
    for line in stdout.strip().splitlines():
        if line.strip():
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2:
                dirty.append(parts[1])
            else:
                dirty.append(line.strip())
    return sorted(dirty)


def get_untracked_product_files() -> list[str]:
    cmd = ["git", "ls-files", "--others", "--exclude-standard", "--"] + SOURCE_GLOBS
    _, stdout, _ = _run_cmd(cmd)
    untracked = [line.strip() for line in stdout.strip().splitlines() if line.strip()]
    return sorted(untracked)


def get_tested_source_fingerprint() -> str:
    cmd = ["git", "ls-files", "--"] + SOURCE_GLOBS
    _, stdout, _ = _run_cmd(cmd)
    files = sorted([f.strip() for f in stdout.strip().splitlines() if f.strip()])
    h = hashlib.sha256()
    for rel_path in files:
        p = ROOT / rel_path
        if not p.exists():
            continue
        h.update(rel_path.encode("utf-8"))
        if p.is_symlink():
            h.update(b"symlink:")
            try:
                h.update(str(p.readlink()).encode("utf-8"))
            except Exception:
                pass
        elif p.is_file():
            h.update(b"file:")
            try:
                with p.open("rb") as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b""):
                        h.update(chunk)
            except Exception:
                pass
    return h.hexdigest()


def validate_output_path(path: Path | str) -> Path:
    target = Path(path).resolve()
    for disallowed in DISALLOWED_OUTPUT_DIRS:
        disallowed_resolved = disallowed.resolve()
        if target == disallowed_resolved or disallowed_resolved in target.parents:
            raise ValueError(
                f"Editor baseline receipts are non-release claims and must never be written to "
                f"release evidence directories or manifests: {target}"
            )
    return target


@dataclass
class BaselineSubject:
    git_commit: str
    git_tree_hash: str
    source_tree_hash: str
    source_dirty: bool
    dirty_files: list[str]
    untracked_files: list[str]
    is_clean: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "gitCommit": self.git_commit,
            "gitTreeHash": self.git_tree_hash,
            "sourceTreeHash": self.source_tree_hash,
            "sourceDirty": self.source_dirty,
            "dirtyFiles": sorted(self.dirty_files),
            "untrackedFiles": sorted(self.untracked_files),
            "isClean": self.is_clean,
        }


def get_baseline_subject() -> BaselineSubject:
    commit = get_current_head()
    tree_hash = get_git_tree_hash()
    source_fp = get_tested_source_fingerprint()
    dirty_files = get_dirty_product_files()
    untracked_files = get_untracked_product_files()
    source_dirty = len(dirty_files) > 0
    is_clean = (not source_dirty) and (len(untracked_files) == 0)

    return BaselineSubject(
        git_commit=commit,
        git_tree_hash=tree_hash,
        source_tree_hash=source_fp,
        source_dirty=source_dirty,
        dirty_files=dirty_files,
        untracked_files=untracked_files,
        is_clean=is_clean,
    )


@dataclass
class CommandRecord:
    name: str
    command: str
    category: str
    exit_code: int
    passed: bool
    test_files_total: Optional[int] = None
    test_files_failed: Optional[int] = None
    tests_total: Optional[int] = None
    tests_passed: Optional[int] = None
    tests_failed: Optional[int] = None
    tests_skipped: Optional[int] = None
    failed_tests: list[dict[str, Any]] = field(default_factory=list)
    quarantined: list[dict[str, Any]] = field(default_factory=list)
    duration_sec: Optional[float] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "command": self.command,
            "category": self.category,
            "exitCode": self.exit_code,
            "passed": self.passed,
            "testFilesTotal": self.test_files_total,
            "testFilesFailed": self.test_files_failed,
            "testsTotal": self.tests_total,
            "testsPassed": self.tests_passed,
            "testsFailed": self.tests_failed,
            "testsSkipped": self.tests_skipped,
            "failedTests": sorted(self.failed_tests, key=lambda x: (x.get("file", ""), x.get("name", ""))),
            "quarantined": sorted(self.quarantined, key=lambda x: (x.get("adr", ""), x.get("test_name", ""))),
            "durationSec": round(self.duration_sec, 2) if self.duration_sec is not None else None,
        }


def parse_vitest_output(output_text: str, exit_code: int = 0) -> CommandRecord:
    passed = (exit_code == 0)
    test_files_total = None
    test_files_failed = 0
    tests_total = None
    tests_passed = 0
    tests_failed = 0
    tests_skipped = 0
    failed_tests: list[dict[str, Any]] = []

    # Parse Test Files line
    # Examples:
    # Test Files  349 passed (349)
    # Test Files  1 failed | 348 passed (349)
    m_files = re.search(r"Test Files\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed\s+\((\d+)\)", output_text)
    if m_files:
        failed_cnt = int(m_files.group(1)) if m_files.group(1) else 0
        passed_cnt = int(m_files.group(2))
        total_cnt = int(m_files.group(3))
        test_files_failed = failed_cnt
        test_files_total = total_cnt
    else:
        m_files_fail_only = re.search(r"Test Files\s+(\d+)\s+failed\s+\((\d+)\)", output_text)
        if m_files_fail_only:
            test_files_failed = int(m_files_fail_only.group(1))
            test_files_total = int(m_files_fail_only.group(2))

    # Parse Tests line
    # Examples:
    # Tests  3166 passed (3166)
    # Tests  1 failed | 3165 passed (3166)
    # Tests  2 failed | 1 skipped | 3163 passed (3166)
    m_tests = re.search(
        r"Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(?:(\d+)\s+skipped\s+\|\s+)?(\d+)\s+passed\s+\((\d+)\)",
        output_text,
    )
    if m_tests:
        tests_failed = int(m_tests.group(1)) if m_tests.group(1) else 0
        tests_skipped = int(m_tests.group(2)) if m_tests.group(2) else 0
        tests_passed = int(m_tests.group(3))
        tests_total = int(m_tests.group(4))
    else:
        m_tests_fail_only = re.search(r"Tests\s+(\d+)\s+failed\s+\((\d+)\)", output_text)
        if m_tests_fail_only:
            tests_failed = int(m_tests_fail_only.group(1))
            tests_total = int(m_tests_fail_only.group(2))

    # Parse Failed test items
    # e.g.
    #  ❯ src/components/editor/Broken.test.tsx (2 tests | 1 failed) 45ms
    #    × Broken Suite > should not crash
    # or
    #  FAIL  src/path/file.test.tsx > suite > test name
    current_file = ""
    for line in output_text.splitlines():
        line_str = line.strip()
        m_file_header = re.search(r"^[❯]\s+([^\s]+\.(?:test|spec)\.[jt]sx?)", line_str)
        if m_file_header:
            current_file = m_file_header.group(1).strip()
            continue

        m_test_fail = re.search(r"^[×]\s+([^\n]+)", line_str)
        if m_test_fail:
            test_name = m_test_fail.group(1).strip()
            failed_tests.append({"name": test_name, "file": current_file})
            continue

        m_fail_banner = re.search(r"^FAIL\s+([^\s]+\.(?:test|spec)\.[jt]sx?)\s*>\s*(.+)", line_str)
        if m_fail_banner:
            file_name = m_fail_banner.group(1).strip()
            test_name = m_fail_banner.group(2).strip()
            if not any(f["name"] == test_name and f["file"] == file_name for f in failed_tests):
                failed_tests.append({"name": test_name, "file": file_name})

    # Duration
    duration_sec = None
    m_dur = re.search(r"Duration\s+([\d\.]+)s", output_text)
    if m_dur:
        duration_sec = float(m_dur.group(1))

    if tests_failed > 0 or test_files_failed > 0:
        passed = False

    return CommandRecord(
        name="pnpm test",
        command="pnpm test",
        category="frontend_unit_test",
        exit_code=exit_code,
        passed=passed,
        test_files_total=test_files_total,
        test_files_failed=test_files_failed,
        tests_total=tests_total,
        tests_passed=tests_passed,
        tests_failed=tests_failed,
        tests_skipped=tests_skipped,
        failed_tests=failed_tests,
        duration_sec=duration_sec,
    )


def parse_cargo_test_output(output_text: str, exit_code: int = 0) -> CommandRecord:
    passed = (exit_code == 0)
    tests_total = 0
    tests_passed = 0
    tests_failed = 0
    tests_skipped = 0
    failed_tests: list[dict[str, Any]] = []

    # Match: test result: ok. 1302 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.15s
    # or:    test result: FAILED. 1301 passed; 1 failed; 0 ignored; ...
    for m in re.finditer(
        r"test result:\s+(ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored",
        output_text,
    ):
        p = int(m.group(2))
        f = int(m.group(3))
        ign = int(m.group(4))
        tests_passed += p
        tests_failed += f
        tests_skipped += ign
        tests_total += (p + f + ign)

    # Match failures block:
    # failures:
    #     editor::tests::test_failed
    in_failures_block = False
    for line in output_text.splitlines():
        if line.strip() == "failures:":
            in_failures_block = True
            continue
        if in_failures_block:
            if line.startswith("    ") and not line.startswith("----"):
                name = line.strip()
                if name:
                    failed_tests.append({"name": name, "file": "src-tauri/src"})
            elif not line.strip() or line.startswith("test result:"):
                in_failures_block = False

    duration_sec = None
    m_dur = re.search(r"finished in ([\d\.]+)s", output_text)
    if m_dur:
        duration_sec = float(m_dur.group(1))

    if tests_failed > 0 or exit_code != 0:
        passed = False

    return CommandRecord(
        name="cargo test --lib",
        command="cargo test --lib",
        category="backend_unit_test",
        exit_code=exit_code,
        passed=passed,
        test_files_total=1 if tests_total > 0 else 0,
        test_files_failed=1 if tests_failed > 0 else 0,
        tests_total=tests_total,
        tests_passed=tests_passed,
        tests_failed=tests_failed,
        tests_skipped=tests_skipped,
        failed_tests=failed_tests,
        duration_sec=duration_sec,
    )


def parse_pnpm_build_output(output_text: str, exit_code: int = 0) -> CommandRecord:
    passed = (exit_code == 0)
    failed_tests: list[dict[str, Any]] = []

    if exit_code != 0:
        # Extract typescript / vite errors
        for line in output_text.splitlines():
            if "error TS" in line or "Error:" in line or "[vite]" in line:
                failed_tests.append({"name": line.strip(), "file": ""})

    return CommandRecord(
        name="pnpm build",
        command="pnpm build",
        category="frontend_build",
        exit_code=exit_code,
        passed=passed,
        test_files_total=None,
        test_files_failed=None,
        tests_total=None,
        tests_passed=None,
        tests_failed=None,
        tests_skipped=None,
        failed_tests=failed_tests,
    )


def parse_qa_audit_output(output_text: str, exit_code: int = 0) -> CommandRecord:
    passed = (exit_code == 0)
    cases_total = None
    errors_count = 0
    failed_tests: list[dict[str, Any]] = []

    m_cases = re.search(r"cases:\s+(\d+)\s+files,\s+(\d+)\s+unique ids,\s+(\d+)\s+error\(s\)", output_text)
    if m_cases:
        cases_total = int(m_cases.group(1))
        errors_count = int(m_cases.group(3))

    for line in output_text.splitlines():
        if line.strip().startswith("ERROR:") or "broken case" in line.lower():
            failed_tests.append({"name": line.strip(), "file": "qa-ui-auto-tests"})

    if errors_count > 0 or len(failed_tests) > 0 or exit_code != 0:
        passed = False

    return CommandRecord(
        name="qa-ui-auto audit --diff",
        command="python -m qa_ui_auto.audit --diff",
        category="qa_diff_audit",
        exit_code=exit_code,
        passed=passed,
        test_files_total=cases_total,
        test_files_failed=1 if errors_count > 0 else 0,
        tests_total=cases_total,
        tests_passed=cases_total - errors_count if cases_total else None,
        tests_failed=errors_count,
        tests_skipped=0,
        failed_tests=failed_tests,
    )


@dataclass
class EditorBaselineSummary:
    schema_version: str
    summary_type: str
    claim_status: str
    is_release_claim: bool
    subject: BaselineSubject
    overall: dict[str, Any]
    commands: list[CommandRecord]
    failures: list[dict[str, Any]]
    quarantine: list[dict[str, Any]]
    generated_at: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "summaryType": self.summary_type,
            "claimStatus": self.claim_status,
            "isReleaseClaim": self.is_release_claim,
            "generatedAt": self.generated_at,
            "subject": self.subject.to_dict(),
            "overall": self.overall,
            "commands": [c.to_dict() for c in self.commands],
            "failures": sorted(self.failures, key=lambda x: (x.get("command", ""), x.get("name", ""))),
            "quarantine": sorted(self.quarantine, key=lambda x: (x.get("adr", ""), x.get("test_name", ""))),
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=True) + "\n"


def build_baseline_summary(
    subject: BaselineSubject,
    commands: list[CommandRecord],
    quarantine: Optional[list[dict[str, Any]]] = None,
    deterministic: bool = True,
    timestamp: Optional[str] = None,
) -> EditorBaselineSummary:
    quarantine_list = quarantine or []
    for cmd in commands:
        quarantine_list.extend(cmd.quarantined)

    all_failures: list[dict[str, Any]] = []
    total_commands = len(commands)
    passed_commands = sum(1 for c in commands if c.passed)
    failed_commands = sum(1 for c in commands if not c.passed)

    total_test_files = 0
    failed_test_files = 0
    total_tests = 0
    passed_tests = 0
    failed_tests = 0
    skipped_tests = 0

    for cmd in commands:
        if cmd.test_files_total is not None:
            total_test_files += cmd.test_files_total
        if cmd.test_files_failed is not None:
            failed_test_files += cmd.test_files_failed
        if cmd.tests_total is not None:
            total_tests += cmd.tests_total
        if cmd.tests_passed is not None:
            passed_tests += cmd.tests_passed
        if cmd.tests_failed is not None:
            failed_tests += cmd.tests_failed
        if cmd.tests_skipped is not None:
            skipped_tests += cmd.tests_skipped

        for f in cmd.failed_tests:
            all_failures.append({
                "command": cmd.command,
                "name": f.get("name", ""),
                "file": f.get("file", ""),
            })

    all_passed = (failed_commands == 0) and (failed_tests == 0) and (failed_test_files == 0)

    overall = {
        "allPassed": all_passed,
        "totalCommands": total_commands,
        "passedCommands": passed_commands,
        "failedCommands": failed_commands,
        "totalTestFiles": total_test_files,
        "failedTestFiles": failed_test_files,
        "totalTests": total_tests,
        "passedTests": passed_tests,
        "failedTests": failed_tests,
        "skippedTests": skipped_tests,
        "quarantinedFailures": len(quarantine_list),
    }

    gen_at: Optional[str] = None
    if not deterministic:
        import datetime
        gen_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    elif timestamp:
        gen_at = timestamp
    else:
        # In deterministic mode without explicit timestamp, use git commit date or omit
        gen_at = get_git_commit_date() or "2026-08-29T00:00:00Z"

    return EditorBaselineSummary(
        schema_version="editor-baseline-summary/v1",
        summary_type="editor_baseline_receipt",
        claim_status="non_release_claim",
        is_release_claim=False,
        subject=subject,
        overall=overall,
        commands=commands,
        failures=all_failures,
        quarantine=quarantine_list,
        generated_at=gen_at,
    )


def render_markdown_summary(summary: EditorBaselineSummary) -> str:
    sub = summary.subject
    ov = summary.overall
    status_badge = "PASSED" if ov["allPassed"] else "FAILED"
    clean_badge = "CLEAN" if sub.is_clean else "DIRTY"

    lines = [
        "# Editor Regression Baseline Receipt",
        "",
        "> **NON-RELEASE CLAIM** — This is a local regression baseline snapshot (§8.23 / BB0-C).",
        "> It records command exit codes, test counts, and failures without creating release claims.",
        "",
        "## Subject Metadata",
        "",
        f"- **Git Commit**: `{sub.git_commit or 'unknown'}`",
        f"- **Git Tree Hash**: `{sub.git_tree_hash or 'unknown'}`",
        f"- **Source Fingerprint**: `{sub.source_tree_hash or 'unknown'}`",
        f"- **Worktree Status**: **{clean_badge}** (sourceDirty={sub.source_dirty})",
    ]

    if sub.dirty_files:
        lines.append("- **Dirty Product Files**:")
        for df in sub.dirty_files:
            lines.append(f"  * `{df}`")
    if sub.untracked_files:
        lines.append("- **Untracked Product Files**:")
        for uf in sub.untracked_files:
            lines.append(f"  * `{uf}`")

    lines.extend([
        "",
        "## Overall Summary",
        "",
        f"- **Status**: **{status_badge}**",
        f"- **Commands**: {ov['passedCommands']}/{ov['totalCommands']} passed",
        f"- **Tests**: {ov['passedTests']}/{ov['totalTests']} passed ({ov['failedTests']} failed, {ov['skippedTests']} skipped)",
        f"- **Quarantined**: {ov['quarantinedFailures']} test(s)",
        "",
        "## Command Details",
        "",
        "| Command | Exit | Status | Files (Fail/Total) | Tests (Pass/Total) | Duration |",
        "|---|---|---|---|---|---|",
    ])

    for cmd in summary.commands:
        files_str = f"{cmd.test_files_failed or 0}/{cmd.test_files_total or 0}" if cmd.test_files_total is not None else "N/A"
        tests_str = f"{cmd.tests_passed or 0}/{cmd.tests_total or 0}" if cmd.tests_total is not None else "N/A"
        dur_str = f"{cmd.duration_sec:.2f}s" if cmd.duration_sec is not None else "N/A"
        status_str = "✓ ok" if cmd.passed else "✗ fail"
        lines.append(f"| `{cmd.command}` | `{cmd.exit_code}` | {status_str} | {files_str} | {tests_str} | {dur_str} |")

    if summary.failures:
        lines.extend([
            "",
            "## Failure List",
            "",
        ])
        for f in summary.failures:
            lines.append(f"- `[{f['command']}]` {f['name']} ({f['file']})")

    if summary.quarantine:
        lines.extend([
            "",
            "## Quarantined Failures",
            "",
        ])
        for q in summary.quarantine:
            lines.append(f"- **{q.get('adr', 'ADR')}**: {q.get('test_name', '')} — {q.get('reason', '')} (expires: {q.get('expires', 'N/A')})")

    lines.append("")
    return "\n".join(lines)


def run_and_parse_command(
    name: str,
    cmd: list[str],
    category: str,
    parser_fn: Any,
    cwd: Optional[Path] = None,
    timeout: float = 600.0,
) -> CommandRecord:
    """Executes a command and parses its output into a CommandRecord."""
    import time
    start_time = time.perf_counter()
    exit_code, stdout, stderr = _run_cmd(cmd, cwd=cwd, timeout=timeout)
    duration = time.perf_counter() - start_time
    combined_output = stdout + ("\n" + stderr if stderr else "")
    record = parser_fn(combined_output, exit_code=exit_code)
    record.name = name
    record.command = " ".join(cmd)
    record.category = category
    record.duration_sec = duration
    return record


def collect_baseline(
    run_vitest: bool = True,
    run_build: bool = True,
    run_cargo: bool = True,
    run_audit: bool = True,
    deterministic: bool = True,
    quarantine: Optional[list[dict[str, Any]]] = None,
) -> EditorBaselineSummary:
    """Collects baseline data by running the standard regression suite."""
    subject = get_baseline_subject()
    commands: list[CommandRecord] = []

    if run_vitest:
        rec = run_and_parse_command(
            name="pnpm test",
            cmd=["pnpm", "test"],
            category="frontend_unit_test",
            parser_fn=parse_vitest_output,
        )
        commands.append(rec)

    if run_build:
        rec = run_and_parse_command(
            name="pnpm build",
            cmd=["pnpm", "build"],
            category="frontend_build",
            parser_fn=parse_pnpm_build_output,
        )
        commands.append(rec)

    if run_cargo:
        rec = run_and_parse_command(
            name="cargo test --lib",
            cmd=["cargo", "test", "--lib"],
            category="backend_unit_test",
            parser_fn=parse_cargo_test_output,
            cwd=ROOT / "src-tauri",
        )
        commands.append(rec)

    if run_audit:
        rec = run_and_parse_command(
            name="qa-ui-auto audit --diff",
            cmd=[sys.executable, "-m", "qa_ui_auto.audit", "--diff"],
            category="qa_diff_audit",
            parser_fn=parse_qa_audit_output,
        )
        commands.append(rec)

    return build_baseline_summary(subject, commands, quarantine=quarantine, deterministic=deterministic)


def check_receipt(receipt_path: Path | str) -> tuple[bool, list[str]]:
    """Checks an existing receipt JSON file for validity and non-release isolation."""
    p = Path(receipt_path).resolve()
    errors: list[str] = []

    if not p.exists():
        return False, [f"Receipt file does not exist: {p}"]

    try:
        validate_output_path(p)
    except ValueError as e:
        errors.append(str(e))

    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        return False, [f"Invalid JSON in receipt: {e}"]

    if data.get("schemaVersion") != "editor-baseline-summary/v1":
        errors.append(f"Unexpected schemaVersion: {data.get('schemaVersion')}")
    if data.get("claimStatus") != "non_release_claim":
        errors.append(f"Invalid claimStatus: {data.get('claimStatus')}")
    if data.get("isReleaseClaim") is not False:
        errors.append(f"isReleaseClaim must be False, got: {data.get('isReleaseClaim')}")
    if "subject" not in data or "overall" not in data or "commands" not in data:
        errors.append("Missing required root keys in receipt")

    return len(errors) == 0, errors


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Editor Baseline Receipt Generator (ED-GATE-002)")
    subparsers = parser.add_subparsers(dest="subcommand", help="Subcommands")

    # generate / default
    gen_parser = subparsers.add_parser("generate", help="Generate baseline receipt from current repo state")
    gen_parser.add_argument("--output", "-o", type=str, help="Output JSON or MD file path")
    gen_parser.add_argument("--format", choices=["json", "md"], default="json", help="Output format")
    gen_parser.add_argument("--vitest-output", type=str, help="Path to captured vitest output file")
    gen_parser.add_argument("--cargo-output", type=str, help="Path to captured cargo test output file")
    gen_parser.add_argument("--build-output", type=str, help="Path to captured pnpm build output file")
    gen_parser.add_argument("--audit-output", type=str, help="Path to captured qa audit output file")
    gen_parser.add_argument("--quarantine-json", type=str, help="Path to quarantine entries JSON file")
    gen_parser.add_argument("--deterministic", action="store_true", default=True, help="Force byte-identical output")

    # collect (runs the tests)
    col_parser = subparsers.add_parser("collect", help="Execute baseline test suite and generate receipt")
    col_parser.add_argument("--output", "-o", type=str, help="Output JSON or MD file path")
    col_parser.add_argument("--format", choices=["json", "md"], default="json", help="Output format")
    col_parser.add_argument("--skip-vitest", action="store_true", help="Skip pnpm test")
    col_parser.add_argument("--skip-build", action="store_true", help="Skip pnpm build")
    col_parser.add_argument("--skip-cargo", action="store_true", help="Skip cargo test")
    col_parser.add_argument("--skip-audit", action="store_true", help="Skip QA audit")
    col_parser.add_argument("--quarantine-json", type=str, help="Path to quarantine entries JSON file")
    col_parser.add_argument("--deterministic", action="store_true", default=True, help="Force byte-identical output")

    # verify-deterministic
    ver_parser = subparsers.add_parser("verify-deterministic", help="Verify two consecutive generations are byte-identical")

    # check
    chk_parser = subparsers.add_parser("check", help="Check an existing receipt JSON file")
    chk_parser.add_argument("receipt_file", type=str, help="Path to receipt JSON file")

    args = parser.parse_args(argv)

    # Handle no subcommand given (default to generate)
    if args.subcommand is None or args.subcommand == "generate":
        output_file = getattr(args, "output", None)
        fmt = getattr(args, "format", "json")
        deterministic = getattr(args, "deterministic", True)

        if output_file:
            validate_output_path(output_file)

        subject = get_baseline_subject()
        commands: list[CommandRecord] = []

        if getattr(args, "vitest_output", None):
            txt = Path(args.vitest_output).read_text(encoding="utf-8")
            commands.append(parse_vitest_output(txt))
        if getattr(args, "cargo_output", None):
            txt = Path(args.cargo_output).read_text(encoding="utf-8")
            commands.append(parse_cargo_test_output(txt))
        if getattr(args, "build_output", None):
            txt = Path(args.build_output).read_text(encoding="utf-8")
            commands.append(parse_pnpm_build_output(txt))
        if getattr(args, "audit_output", None):
            txt = Path(args.audit_output).read_text(encoding="utf-8")
            commands.append(parse_qa_audit_output(txt))

        quarantine = []
        if getattr(args, "quarantine_json", None):
            quarantine = json.loads(Path(args.quarantine_json).read_text(encoding="utf-8"))

        summary = build_baseline_summary(subject, commands, quarantine=quarantine, deterministic=deterministic)

        if fmt == "md":
            content = render_markdown_summary(summary)
        else:
            content = summary.to_json()

        if output_file:
            out_path = Path(output_file)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(content, encoding="utf-8")
            print(f"Wrote baseline receipt to {out_path}")
        else:
            sys.stdout.write(content)
        return 0

    elif args.subcommand == "collect":
        output_file = args.output
        fmt = args.format
        if output_file:
            validate_output_path(output_file)

        quarantine = []
        if args.quarantine_json:
            quarantine = json.loads(Path(args.quarantine_json).read_text(encoding="utf-8"))

        summary = collect_baseline(
            run_vitest=not args.skip_vitest,
            run_build=not args.skip_build,
            run_cargo=not args.skip_cargo,
            run_audit=not args.skip_audit,
            deterministic=args.deterministic,
            quarantine=quarantine,
        )

        if fmt == "md":
            content = render_markdown_summary(summary)
        else:
            content = summary.to_json()

        if output_file:
            out_path = Path(output_file)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(content, encoding="utf-8")
            print(f"Wrote baseline receipt to {out_path}")
        else:
            sys.stdout.write(content)
        return 0 if summary.overall["allPassed"] else 1

    elif args.subcommand == "verify-deterministic":
        subject = get_baseline_subject()
        cmd = CommandRecord(
            name="pnpm test",
            command="pnpm test",
            category="frontend_unit_test",
            exit_code=0,
            passed=True,
            test_files_total=349,
            test_files_failed=0,
            tests_total=3166,
            tests_passed=3166,
            tests_failed=0,
            tests_skipped=0,
            failed_tests=[],
        )
        s1 = build_baseline_summary(subject, [cmd], deterministic=True)
        s2 = build_baseline_summary(subject, [cmd], deterministic=True)
        if s1.to_json() == s2.to_json():
            print("OK: Deterministic byte-identical output verified.")
            return 0
        else:
            print("ERROR: Non-deterministic output detected across runs!", file=sys.stderr)
            return 1

    elif args.subcommand == "check":
        ok, errors = check_receipt(args.receipt_file)
        if ok:
            print(f"OK: Receipt {args.receipt_file} is valid.")
            return 0
        else:
            print(f"FAIL: Receipt {args.receipt_file} has errors:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
