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


ALLOWED_STATUSES = {"ready", "claimed", "in_progress", "blocked", "done", "deferred"}
ALLOWED_PRIORITIES = {"P0", "P1", "P2"}
ACTIVE_STATUSES = {"claimed", "in_progress", "blocked"}
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


def validate_cards(cards: list[dict[str, Any]]) -> list[str]:
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
        if status in {*ACTIVE_STATUSES, "done"} and not owner:
            errors.append(f"{task_id}: status {status} requires owner")
        if status in {*ACTIVE_STATUSES, "done"} and not metadata.get("baseline"):
            errors.append(f"{task_id}: status {status} requires baseline")
        if status in {*ACTIVE_STATUSES, "done"} and not metadata.get("claimed_at"):
            errors.append(f"{task_id}: status {status} requires claimed_at")
        if status == "ready" and any(
            metadata.get(field) is not None for field in ("owner", "claimed_at", "baseline")
        ):
            errors.append(f"{task_id}: ready task cannot retain claim metadata")
        if status == "done" and not metadata.get("evidence"):
            errors.append(f"{task_id}: done requires evidence")
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
        text = doc.read_text(encoding="utf-8")
        cards = parse_cards(text)
        errors = validate_cards(cards)
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
        next_errors = validate_cards(next_cards)
        if next_errors:
            raise TaskBoardError("Task board would be invalid:\n- " + "\n- ".join(next_errors))
        write_atomic(doc, next_text)
        return metadata


def command_validate(doc: Path, _args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    errors = validate_cards(cards)
    if errors:
        raise TaskBoardError("\n".join(f"- {error}" for error in errors))
    print(f"OK: {len(cards)} tasks in {doc}")


def command_list(doc: Path, args: argparse.Namespace) -> None:
    cards = parse_cards(doc.read_text(encoding="utf-8"))
    errors = validate_cards(cards)
    if errors:
        raise TaskBoardError("Task board is invalid:\n- " + "\n- ".join(errors))
    tasks = card_map(cards)
    rows: list[dict[str, Any]] = []
    for order, card in enumerate(cards):
        metadata = card["metadata"]
        dependencies_done, pending = dependency_state(card, tasks)
        claimable = metadata["status"] == "ready" and dependencies_done
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
        "claimable": card["metadata"]["status"] == "ready" and dependencies_done,
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
        if metadata["status"] != "ready":
            raise TaskBoardError(f"{args.task_id} is {metadata['status']}, not ready")
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
        metadata.update(
            {
                "status": "claimed",
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


def command_update(doc: Path, args: argparse.Namespace) -> None:
    owner = args.owner.strip()
    if not owner:
        raise TaskBoardError("owner cannot be empty")

    def update(metadata: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> None:
        current_status = metadata["status"]
        current_owner = metadata.get("owner")
        if current_status == "ready":
            raise TaskBoardError(f"{args.task_id} must be claimed before update")
        if current_status == "deferred":
            raise TaskBoardError(f"{args.task_id} is deferred; reopen it through backlog review")
        if current_status == "done":
            raise TaskBoardError(f"{args.task_id} is done and cannot be reopened through update")
        if current_owner != owner:
            raise TaskBoardError(f"{args.task_id} is owned by {current_owner}, not {owner}")
        if args.status == "done":
            if not args.evidence:
                raise TaskBoardError("done requires --evidence")
            dependencies_done, pending = dependency_state(tasks[args.task_id], tasks)
            if not dependencies_done:
                raise TaskBoardError(f"cannot finish with incomplete dependencies: {', '.join(pending)}")
        if args.status == "blocked" and not args.note:
            raise TaskBoardError("blocked requires --note")
        metadata["status"] = args.status
        metadata["owner"] = owner
        metadata["updated_at"] = utc_now()
        if args.baseline:
            metadata["baseline"] = args.baseline
        if args.evidence:
            metadata["evidence"] = args.evidence
        elif args.status != "done":
            metadata.pop("evidence", None)
        if args.note:
            metadata["note"] = args.note
        elif args.status != "blocked":
            metadata.pop("note", None)

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

    claim_parser = subparsers.add_parser("claim", help="Atomically claim a ready task")
    claim_parser.add_argument("task_id")
    claim_parser.add_argument("--owner", required=True)
    claim_parser.add_argument("--baseline")

    update_parser = subparsers.add_parser("update", help="Update an owned task")
    update_parser.add_argument("task_id")
    update_parser.add_argument("--owner", required=True)
    update_parser.add_argument("--status", required=True, choices=["in_progress", "blocked", "done"])
    update_parser.add_argument("--baseline")
    update_parser.add_argument("--evidence")
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
