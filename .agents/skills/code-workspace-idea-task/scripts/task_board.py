#!/usr/bin/env python3
"""List, claim, validate, and update Code Workspace IDEA parity tasks."""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Iterator


ALLOWED_STATUSES = {
    "ready",
    "implemented",
    "claimed",
    "in_progress",
    "blocked",
    "review_required",
    "done",
    "deferred",
}
ALLOWED_PRIORITIES = {"P0", "P1", "P2"}
ACTIVE_STATUSES = {"claimed", "in_progress", "blocked"}
CLAIMABLE_STATUSES = {"ready", "implemented"}
ALLOWED_EVIDENCE_KINDS = {
    "code-audit",
    "unit",
    "build",
    "rust",
    "qa-lint",
    "browser",
    "native",
    "provider",
    "performance",
    "accessibility",
    "idea-comparison",
    "document",
}
TASK_ID_PATTERN = re.compile(r"^ED-[A-Z]+-\d{3}$")
CARD_PATTERN = re.compile(
    r"^### (?P<id>ED-[A-Z]+-\d{3}) (?P<title>[^\n]+)\n"
    r"(?P<line><!-- ide-task (?P<json>\{[^\n]*\}) -->)$",
    re.MULTILINE,
)


class TaskBoardError(RuntimeError):
    pass


def find_repo_root(start: Path) -> Path:
    for candidate in (start, *start.parents):
        if (candidate / "claudedocs" / "code-workspace-idea-parity-backlog.md").is_file():
            return candidate
    raise TaskBoardError("Cannot locate repository root containing the IDEA parity backlog")


def default_doc() -> Path:
    return find_repo_root(Path.cwd().resolve()) / "claudedocs" / "code-workspace-idea-parity-backlog.md"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def git_head(repo_root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise TaskBoardError(f"Cannot resolve git HEAD: {completed.stderr.strip()}")
    return completed.stdout.strip()


def parse_cards(text: str) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for match in CARD_PATTERN.finditer(text):
        try:
            metadata = json.loads(match.group("json"))
        except json.JSONDecodeError as error:
            raise TaskBoardError(f"Invalid task JSON at offset {match.start()}: {error}") from error
        cards.append(
            {
                "heading_id": match.group("id"),
                "title": match.group("title").strip(),
                "metadata": metadata,
                "line_start": match.start("line"),
                "line_end": match.end("line"),
            }
        )
    if not cards:
        raise TaskBoardError("No ide-task cards found")
    return cards


def card_map(cards: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {card["metadata"].get("id", ""): card for card in cards}


def validate_evidence(
    task_id: str,
    evidence: Any,
    required_kinds: list[str],
    acceptance_ids: list[str],
    require_complete: bool,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(evidence, dict):
        return [f"{task_id}: evidence must be an object"]
    for field in ("verified_at", "head"):
        if not isinstance(evidence.get(field), str) or not evidence[field].strip():
            errors.append(f"{task_id}: evidence.{field} must be a non-empty string")
    checks = evidence.get("checks")
    if not isinstance(checks, list):
        errors.append(f"{task_id}: evidence.checks must be a list")
        checks = []
    latest_kind_results: dict[str, str] = {}
    passed_acceptance: set[str] = set()
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            errors.append(f"{task_id}: evidence.checks[{index}] must be an object")
            continue
        kind = check.get("kind")
        if kind not in ALLOWED_EVIDENCE_KINDS:
            errors.append(f"{task_id}: evidence.checks[{index}] has invalid kind {kind!r}")
        if check.get("result") not in {"passed", "failed"}:
            errors.append(f"{task_id}: evidence.checks[{index}].result must be passed or failed")
        for field in ("command", "summary"):
            if not isinstance(check.get(field), str) or not check[field].strip():
                errors.append(f"{task_id}: evidence.checks[{index}].{field} must be non-empty")
        check_acceptance = check.get("acceptance")
        if not isinstance(check_acceptance, list) or not all(
            isinstance(acceptance_id, str) for acceptance_id in check_acceptance
        ):
            errors.append(f"{task_id}: evidence.checks[{index}].acceptance must be a string list")
            check_acceptance = []
        else:
            unknown_acceptance = sorted(set(check_acceptance) - set(acceptance_ids))
            if unknown_acceptance:
                errors.append(
                    f"{task_id}: evidence.checks[{index}] references unknown acceptance ids: "
                    + ", ".join(unknown_acceptance)
                )
            if len(set(check_acceptance)) != len(check_acceptance):
                errors.append(f"{task_id}: evidence.checks[{index}].acceptance ids must be unique")
        if kind in ALLOWED_EVIDENCE_KINDS and check.get("result") in {"passed", "failed"}:
            latest_kind_results[kind] = check["result"]
            if check["result"] == "passed":
                passed_acceptance.update(set(check_acceptance) & set(acceptance_ids))
    unrun = evidence.get("unrun")
    if not isinstance(unrun, list) or not all(isinstance(item, str) for item in unrun):
        errors.append(f"{task_id}: evidence.unrun must be a string list")
    notes = evidence.get("notes")
    if not isinstance(notes, list) or not all(isinstance(note, str) for note in notes):
        errors.append(f"{task_id}: evidence.notes must be a string list")
    if require_complete:
        missing_kinds = sorted(
            kind for kind in set(required_kinds) if latest_kind_results.get(kind) != "passed"
        )
        if missing_kinds:
            errors.append(
                f"{task_id}: done evidence lacks a final passed check for kinds: "
                + ", ".join(missing_kinds)
            )
        missing_acceptance = sorted(set(acceptance_ids) - passed_acceptance)
        if missing_acceptance:
            errors.append(
                f"{task_id}: done evidence does not cover acceptance ids: {', '.join(missing_acceptance)}"
            )
    return errors


def validate_spec_reference(
    task_id: str,
    metadata: dict[str, Any],
    repo_root: Path | None,
) -> list[str]:
    errors: list[str] = []
    spec = metadata.get("spec")
    if not isinstance(spec, str) or "#" not in spec:
        return [f"{task_id}: spec must be a repository path plus #anchor"]
    spec_path_text, anchor = spec.split("#", 1)
    if not spec_path_text or not anchor:
        return [f"{task_id}: spec path and anchor must be non-empty"]
    expected_anchor = task_id.lower()
    if anchor != expected_anchor:
        errors.append(f"{task_id}: spec anchor must be #{expected_anchor}")
    acceptance = metadata.get("acceptance")
    if not isinstance(acceptance, list) or not acceptance or not all(isinstance(item, str) for item in acceptance):
        errors.append(f"{task_id}: acceptance must be a non-empty string list")
        acceptance = []
    elif len(set(acceptance)) != len(acceptance):
        errors.append(f"{task_id}: acceptance ids must be unique")
    for acceptance_id in acceptance:
        if not acceptance_id.startswith(f"{task_id}-A"):
            errors.append(f"{task_id}: invalid acceptance id {acceptance_id!r}")
    if repo_root is None:
        return errors
    candidate = (repo_root / spec_path_text).resolve()
    try:
        candidate.relative_to(repo_root.resolve())
    except ValueError:
        errors.append(f"{task_id}: spec path escapes repository: {spec_path_text}")
        return errors
    if not candidate.is_file():
        errors.append(f"{task_id}: spec file does not exist: {spec_path_text}")
        return errors
    spec_text = candidate.read_text(encoding="utf-8")
    anchor_marker = f'<a id="{anchor}"></a>'
    section_start = spec_text.find(anchor_marker)
    if section_start == -1:
        errors.append(f"{task_id}: spec anchor not found: {spec}")
        return errors
    section_end = spec_text.find('<a id="', section_start + len(anchor_marker))
    spec_section = spec_text[section_start : section_end if section_end != -1 else None]
    for acceptance_id in acceptance:
        short_id = acceptance_id.removeprefix(f"{task_id}-")
        if acceptance_id not in spec_section and f"`{short_id}`" not in spec_section:
            errors.append(f"{task_id}: acceptance id not found in spec: {acceptance_id}")
    return errors


def validate_cards(cards: list[dict[str, Any]], repo_root: Path | None = None) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    active_owners: dict[str, str] = {}
    tasks = card_map(cards)

    for card in cards:
        metadata = card["metadata"]
        task_id = metadata.get("id")
        if not isinstance(task_id, str) or not TASK_ID_PATTERN.fullmatch(task_id):
            errors.append(f"invalid task id: {task_id!r}")
            continue
        if task_id in seen:
            errors.append(f"duplicate task id: {task_id}")
        seen.add(task_id)
        if card["heading_id"] != task_id:
            errors.append(f"{task_id}: heading id is {card['heading_id']}")
        if metadata.get("status") not in ALLOWED_STATUSES:
            errors.append(f"{task_id}: invalid status {metadata.get('status')!r}")
        if metadata.get("priority") not in ALLOWED_PRIORITIES:
            errors.append(f"{task_id}: invalid priority {metadata.get('priority')!r}")
        if metadata.get("size") not in {"S", "M", "L"}:
            errors.append(f"{task_id}: invalid size {metadata.get('size')!r}")
        dependencies = metadata.get("depends_on")
        if not isinstance(dependencies, list) or not all(isinstance(item, str) for item in dependencies):
            errors.append(f"{task_id}: depends_on must be a string list")
            dependencies = []
        if task_id in dependencies:
            errors.append(f"{task_id}: cannot depend on itself")
        status = metadata.get("status")
        owner = metadata.get("owner")
        required_evidence = metadata.get("required_evidence")
        if (
            not isinstance(required_evidence, list)
            or not required_evidence
            or not all(isinstance(item, str) for item in required_evidence)
        ):
            errors.append(f"{task_id}: required_evidence must be a non-empty string list")
            required_evidence = []
        else:
            unknown_evidence = sorted(set(required_evidence) - ALLOWED_EVIDENCE_KINDS)
            if unknown_evidence:
                errors.append(f"{task_id}: invalid required evidence kinds: {', '.join(unknown_evidence)}")
            if len(set(required_evidence)) != len(required_evidence):
                errors.append(f"{task_id}: required_evidence kinds must be unique")
        errors.extend(validate_spec_reference(task_id, metadata, repo_root))
        acceptance = metadata.get("acceptance")
        if not isinstance(acceptance, list) or not all(isinstance(item, str) for item in acceptance):
            acceptance = []
        audit = metadata.get("audit")
        if not isinstance(audit, dict):
            errors.append(f"{task_id}: audit must be an object")
        else:
            for field in ("date", "head", "finding"):
                if not isinstance(audit.get(field), str) or not audit[field].strip():
                    errors.append(f"{task_id}: audit.{field} must be a non-empty string")
        prior_completion = metadata.get("prior_completion")
        if not isinstance(prior_completion, (str, dict)):
            errors.append(f"{task_id}: prior_completion must preserve or reference historical completion")
        if status in ACTIVE_STATUSES and not owner:
            errors.append(f"{task_id}: status {status} requires owner")
        if status in ACTIVE_STATUSES and not metadata.get("baseline"):
            errors.append(f"{task_id}: status {status} requires baseline")
        if status in ACTIVE_STATUSES and not metadata.get("claimed_at"):
            errors.append(f"{task_id}: status {status} requires claimed_at")
        if status in {"ready", "implemented", "review_required", "deferred", "done"} and any(
            metadata.get(field) is not None for field in ("owner", "claimed_at", "baseline")
        ):
            errors.append(f"{task_id}: non-active status {status} cannot retain claim metadata")
        if status == "done":
            errors.extend(
                validate_evidence(
                    task_id,
                    metadata.get("evidence"),
                    required_evidence,
                    acceptance,
                    True,
                )
            )
        elif metadata.get("evidence") is not None:
            errors.extend(
                validate_evidence(
                    task_id,
                    metadata.get("evidence"),
                    required_evidence,
                    acceptance,
                    False,
                )
            )
        if status == "blocked" and not metadata.get("note"):
            errors.append(f"{task_id}: blocked requires note")
        if status in ACTIVE_STATUSES and isinstance(owner, str):
            previous_task = active_owners.get(owner)
            if previous_task:
                errors.append(f"owner {owner!r} has multiple active tasks: {previous_task}, {task_id}")
            else:
                active_owners[owner] = task_id

    for task_id, card in tasks.items():
        for dependency in card["metadata"].get("depends_on", []):
            if dependency not in tasks:
                errors.append(f"{task_id}: missing dependency {dependency}")
            elif card["metadata"].get("status") in {*ACTIVE_STATUSES, "done"} and tasks[dependency][
                "metadata"
            ].get("status") != "done":
                errors.append(f"{task_id}: active or done task has incomplete dependency {dependency}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, trail: list[str]) -> None:
        if task_id in visiting:
            errors.append(f"dependency cycle: {' -> '.join((*trail, task_id))}")
            return
        if task_id in visited or task_id not in tasks:
            return
        visiting.add(task_id)
        for dependency in tasks[task_id]["metadata"].get("depends_on", []):
            visit(dependency, [*trail, task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id, [])
    return errors


def dependency_state(card: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> tuple[bool, list[str]]:
    pending = [
        dependency
        for dependency in card["metadata"].get("depends_on", [])
        if tasks.get(dependency, {}).get("metadata", {}).get("status") != "done"
    ]
    return not pending, pending


def compact_metadata(metadata: dict[str, Any]) -> str:
    return json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))


@contextlib.contextmanager
def board_lock(doc: Path) -> Iterator[None]:
    digest = hashlib.sha256(str(doc.resolve()).encode("utf-8")).hexdigest()[:16]
    lock_path = Path(tempfile.gettempdir()) / f"taomni-idea-task-board-{digest}.lock"
    lock_file = lock_path.open("a+b")
    try:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            lock_file.write(b"0")
            lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt

            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def write_atomic(doc: Path, text: str) -> None:
    mode = doc.stat().st_mode
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="",
        dir=doc.parent,
        prefix=f".{doc.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary.write(text)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, doc)


def mutate_task(doc: Path, task_id: str, mutation: Any) -> dict[str, Any]:
    with board_lock(doc):
        repo_root = find_repo_root(doc.parent.resolve())
        text = doc.read_text(encoding="utf-8")
        cards = parse_cards(text)
        errors = validate_cards(cards, repo_root)
        if errors:
            raise TaskBoardError("Task board is invalid before update:\n- " + "\n- ".join(errors))
        tasks = card_map(cards)
        card = tasks.get(task_id)
        if not card:
            raise TaskBoardError(f"Unknown task: {task_id}")
        metadata = dict(card["metadata"])
        mutation(metadata, tasks)
        replacement = f"<!-- ide-task {compact_metadata(metadata)} -->"
        next_text = text[: card["line_start"]] + replacement + text[card["line_end"] :]
        next_cards = parse_cards(next_text)
        next_errors = validate_cards(next_cards, repo_root)
        if next_errors:
            raise TaskBoardError("Task board would be invalid:\n- " + "\n- ".join(next_errors))
        write_atomic(doc, next_text)
        return metadata


def command_validate(doc: Path, _args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    errors = validate_cards(cards, find_repo_root(doc.parent.resolve()))
    if errors:
        raise TaskBoardError("\n".join(f"- {error}" for error in errors))
    print(f"OK: {len(cards)} tasks in {doc}")


def command_list(doc: Path, args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    errors = validate_cards(cards, find_repo_root(doc.parent.resolve()))
    if errors:
        raise TaskBoardError("Task board is invalid:\n- " + "\n- ".join(errors))
    tasks = card_map(cards)
    rows: list[dict[str, Any]] = []
    for order, card in enumerate(cards):
        metadata = card["metadata"]
        dependencies_done, pending = dependency_state(card, tasks)
        claimable = metadata["status"] in CLAIMABLE_STATUSES and dependencies_done
        if args.status and metadata["status"] not in args.status:
            continue
        if args.claimable and not claimable:
            continue
        rows.append(
            {
                "id": metadata["id"],
                "priority": metadata["priority"],
                "size": metadata["size"],
                "status": metadata["status"],
                "claimable": claimable,
                "owner": metadata.get("owner"),
                "spec": metadata.get("spec"),
                "required_evidence": metadata.get("required_evidence", []),
                "pending_dependencies": pending,
                "title": card["title"],
                "order": order,
            }
        )
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    rows.sort(key=lambda row: (priority_order[row["priority"]], row["order"]))
    if args.json:
        print(json.dumps([{key: value for key, value in row.items() if key != "order"} for row in rows], ensure_ascii=False, indent=2))
        return
    if not rows:
        print("No matching tasks")
        return
    for row in rows:
        pending = f" deps={','.join(row['pending_dependencies'])}" if row["pending_dependencies"] else ""
        owner = f" owner={row['owner']}" if row["owner"] else ""
        print(
            f"{row['priority']} {row['size']} {row['status']:<11} "
            f"{row['id']} {row['title']}{owner}{pending}"
        )


def command_show(doc: Path, args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    tasks = card_map(cards)
    card = tasks.get(args.task_id)
    if not card:
        raise TaskBoardError(f"Unknown task: {args.task_id}")
    dependencies_done, pending = dependency_state(card, tasks)
    output = {
        **card["metadata"],
        "title": card["title"],
        "claimable": card["metadata"]["status"] in CLAIMABLE_STATUSES and dependencies_done,
        "pending_dependencies": pending,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def command_claim(doc: Path, args: argparse.Namespace) -> None:
    repo_root = find_repo_root(doc.parent.resolve())
    baseline = args.baseline or git_head(repo_root)
    owner = args.owner.strip()
    if not owner:
        raise TaskBoardError("owner cannot be empty")

    def claim(metadata: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> None:
        if metadata["status"] not in CLAIMABLE_STATUSES:
            raise TaskBoardError(
                f"{args.task_id} is {metadata['status']}; only ready or implemented tasks are claimable"
            )
        dependencies_done, pending = dependency_state(tasks[args.task_id], tasks)
        if not dependencies_done:
            raise TaskBoardError(f"{args.task_id} has incomplete dependencies: {', '.join(pending)}")
        for other_task_id, other_card in tasks.items():
            other_metadata = other_card["metadata"]
            if (
                other_task_id != args.task_id
                and other_metadata.get("status") in ACTIVE_STATUSES
                and other_metadata.get("owner") == owner
            ):
                raise TaskBoardError(f"owner {owner!r} already has active task {other_task_id}")
        now = utc_now()
        claimed_from = metadata["status"]
        metadata.update(
            {
                "status": "claimed",
                "claimed_from": claimed_from,
                "owner": owner,
                "claimed_at": now,
                "baseline": baseline,
                "updated_at": now,
            }
        )
        metadata.pop("note", None)
        metadata.pop("evidence", None)

    metadata = mutate_task(doc, args.task_id, claim)
    print(f"Claimed {args.task_id} for {args.owner} at {metadata['baseline']}")


def load_evidence(args: argparse.Namespace) -> Any:
    if args.evidence_json and args.evidence_file:
        raise TaskBoardError("use only one of --evidence-json or --evidence-file")
    if not args.evidence_json and not args.evidence_file:
        return None
    raw = args.evidence_json
    if args.evidence_file:
        evidence_path = args.evidence_file.resolve()
        if not evidence_path.is_file():
            raise TaskBoardError(f"evidence file does not exist: {evidence_path}")
        raw = evidence_path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as error:
        raise TaskBoardError(f"invalid evidence JSON: {error}") from error


def command_update(doc: Path, args: argparse.Namespace) -> None:
    owner = args.owner.strip()
    if not owner:
        raise TaskBoardError("owner cannot be empty")
    evidence = load_evidence(args)

    def update(metadata: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> None:
        current_status = metadata["status"]
        current_owner = metadata.get("owner")
        if current_status in CLAIMABLE_STATUSES:
            raise TaskBoardError(f"{args.task_id} must be claimed before update")
        if current_status in {"deferred", "review_required"}:
            raise TaskBoardError(f"{args.task_id} is {current_status}; resolve it through backlog review")
        if current_status == "done":
            raise TaskBoardError(f"{args.task_id} is done and cannot be reopened through update")
        if current_owner != owner:
            raise TaskBoardError(f"{args.task_id} is owned by {current_owner}, not {owner}")
        if args.status == "done":
            if evidence is None:
                raise TaskBoardError("done requires --evidence-json or --evidence-file")
            dependencies_done, pending = dependency_state(tasks[args.task_id], tasks)
            if not dependencies_done:
                raise TaskBoardError(f"cannot finish with incomplete dependencies: {', '.join(pending)}")
        if args.status == "blocked" and not args.note:
            raise TaskBoardError("blocked requires --note")
        if args.status in {"implemented", "review_required"} and not args.note:
            raise TaskBoardError(f"{args.status} requires --note describing the remaining gap or conflict")
        metadata["status"] = args.status
        metadata["owner"] = owner
        metadata["updated_at"] = utc_now()
        if args.baseline:
            metadata["baseline"] = args.baseline
        if evidence is not None:
            metadata["evidence"] = evidence
        elif args.status != "done":
            metadata.pop("evidence", None)
        if args.note:
            metadata["note"] = args.note
        elif args.status != "blocked":
            metadata.pop("note", None)
        if args.status in {"done", "implemented", "review_required"}:
            metadata["last_attempt"] = {
                "owner": owner,
                "claimed_from": metadata.get("claimed_from"),
                "claimed_at": metadata.get("claimed_at"),
                "baseline": metadata.get("baseline"),
                "finished_at": metadata["updated_at"],
                "result": args.status,
                "note": args.note,
            }
            for field in ("owner", "claimed_from", "claimed_at", "baseline", "note"):
                metadata.pop(field, None)

    metadata = mutate_task(doc, args.task_id, update)
    print(f"Updated {args.task_id}: {metadata['status']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--doc", type=Path, default=None, help="Backlog document path")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("validate", help="Validate task metadata and dependencies")

    list_parser = subparsers.add_parser("list", help="List tasks by priority, then document order")
    list_parser.add_argument("--status", action="append", choices=sorted(ALLOWED_STATUSES))
    list_parser.add_argument("--claimable", action="store_true")
    list_parser.add_argument("--json", action="store_true")

    show_parser = subparsers.add_parser("show", help="Show one task's metadata")
    show_parser.add_argument("task_id")

    claim_parser = subparsers.add_parser("claim", help="Atomically claim a ready or implemented task")
    claim_parser.add_argument("task_id")
    claim_parser.add_argument("--owner", required=True)
    claim_parser.add_argument("--baseline")

    update_parser = subparsers.add_parser("update", help="Update an owned task")
    update_parser.add_argument("task_id")
    update_parser.add_argument("--owner", required=True)
    update_parser.add_argument(
        "--status",
        required=True,
        choices=["in_progress", "blocked", "implemented", "review_required", "done"],
    )
    update_parser.add_argument("--baseline")
    update_parser.add_argument("--evidence-json")
    update_parser.add_argument("--evidence-file", type=Path)
    update_parser.add_argument("--note")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        doc = (args.doc or default_doc()).resolve()
        if not doc.is_file():
            raise TaskBoardError(f"Backlog document not found: {doc}")
        if args.command == "validate":
            command_validate(doc, args)
        elif args.command == "list":
            command_list(doc, args)
        elif args.command == "show":
            command_show(doc, args)
        elif args.command == "claim":
            command_claim(doc, args)
        elif args.command == "update":
            command_update(doc, args)
        else:
            parser.error(f"Unknown command: {args.command}")
        return 0
    except TaskBoardError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
