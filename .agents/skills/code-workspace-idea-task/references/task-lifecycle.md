# Task Lifecycle

Use these commands from the repository root. Select the caller's board once and pass it to every command. The script locks and atomically rewrites only the selected task metadata.

```bash
task_board_doc=claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md
# For a caller-selected earlier board, assign its path instead.
```

The discovery example uses ED-AUDIT-001 on the new board. Terminal-state examples illustrate different cards; replace each ID with your actually claimed card and never update an unclaimed example card. PowerShell users should pass the literal board path through --doc. Never mix a claim on one board with an update on another.

## 1. Discover And Inspect

Record current HEAD and `git status --short`, then validate the board:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" list --claimable
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" show ED-AUDIT-001
```

If the caller supplied an ID, inspect that card and reject it when `claimable` is false. Otherwise choose the first highest-priority claimable card that does not overlap files currently being edited. `implemented` is claimable because it still needs a named audit/evidence gap closed.

Use the owner supplied by the harness or caller. Otherwise create a stable label such as `codex-<UTC timestamp>-<short HEAD>`. A loop should use a distinct owner label for each task so one blocked task does not hide ownership of another.

## 2. Claim Before Production Edits

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" claim ED-AUDIT-001 \
  --owner <owner>
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" update ED-AUDIT-001 \
  --owner <owner> \
  --status in_progress
```

`claim` records the current Git HEAD unless `--baseline` is supplied. If the claim fails, re-list the board; never overwrite another owner or bypass an incomplete dependency.

## 3. Re-Audit The Card

Inspect production callers, ownership, stores, providers/IPC, tests, and QA cases. Map each acceptance ID to a concrete implementation and verification point.

Choose the truthful path:

- Gap still exists: implement the narrow card.
- Card is already satisfied: run its current required evidence and avoid redundant code changes.
- Material spec conflict: do not silently redefine the result, effect, scope, failure, undo, or recovery contract. Finish as `review_required` with the exact discrepancy and proposed decision.
- Adjacent gap: leave it outside this task. Mention it in the handoff or propose a separately reviewed card.

## 4. Update The Terminal State

Create evidence using [evidence-policy.md](evidence-policy.md). Prefer `--evidence-file` for non-trivial JSON.

Complete:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" update ED-AUDIT-001 \
  --owner <owner> \
  --status done \
  --evidence-file <evidence.json>
```

Production complete but required evidence remains:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" update ED-AUDIT-010 \
  --owner <owner> \
  --status implemented \
  --evidence-file <evidence.json> \
  --note "Packaged native check is unrun: no Tauri display session"
```

Material contract conflict:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" update ED-AUDIT-010 \
  --owner <owner> \
  --status review_required \
  --evidence-file <evidence.json> \
  --note "Spec requires zero effect after await, but the OS write may already have completed"
```

External blocker:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" update ED-AUDIT-007 \
  --owner <owner> \
  --status blocked \
  --note "Maven fixture cannot resolve offline; resume with the configured repository mirror"
```

`implemented`, `review_required`, and `done` release ownership and preserve the attempt in `last_attempt`. `blocked` retains ownership because work is expected to resume from the stated condition.

Always finish with:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc "$task_board_doc" validate
git diff --check
git status --short
```

## 5. Atomic Commit When Requested

Only commit when the caller or loop explicitly authorizes it. Inspect the diff, stage explicit task-owned paths, and verify the staged diff. Include implementation, focused tests, any approved spec correction, and the task-board transition in one commit.

Use a conventional message containing the task ID, for example:

```text
feat(code-workspace): add ED-AUDIT-001 comparison validator
```

Do not use broad staging in a dirty worktree. Do not amend, rewrite, or include other owners' changes. Report the resulting commit hash and any task-owned files intentionally left uncommitted.
