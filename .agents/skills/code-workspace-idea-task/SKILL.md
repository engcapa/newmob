---
name: code-workspace-idea-task
description: Claim and deliver one small Taomni Code Workspace editor task from the current IntelliJ IDEA parity backlog. Use when an agent should select or receive an ED-* task, implement it, run proportionate verification, and update the shared task status. Do not use the historical design document as a claim queue or for unrelated Code Workspace work.
---

# Code Workspace IDEA Task

Deliver exactly one task from `claudedocs/code-workspace-idea-parity-backlog.md` without turning historical plans, model-only code, or unrun evidence into completion claims.

## Sources Of Truth

1. Read the repository `AGENTS.md`.
2. Read the new backlog's sections 1-5, the selected task card, its dependencies, and the verification rules relevant to that card.
3. Read `claudedocs/code-workspace-ide-design.md` only when the card's `legacy` field or implementation question requires historical design detail. Never claim work from its old `N/W/V/U/X/Y/Z/AA/BB` queues.
4. Re-read current production consumers and tests. The backlog is an audited baseline, not permission to ignore code that landed later.

Task `done` means the card's narrow outcome is complete. It does not by itself mean an IDEA capability is L2/L3 or release verified.

## Task Board

Use the bundled script from the repository root:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py list --claimable
python .agents/skills/code-workspace-idea-task/scripts/task_board.py show ED-CLIP-001
```

If the user supplied a task ID, use that task after validating it is claimable. Otherwise choose the first highest-priority claimable task whose owner/files do not conflict with current work. Do not claim `blocked` or `deferred` tasks.

Choose a stable owner label supplied by the harness/user when available. Otherwise use `codex-<UTC timestamp>-<short HEAD>`. Claim before editing production files:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py claim ED-CLIP-001 --owner <owner>
python .agents/skills/code-workspace-idea-task/scripts/task_board.py update ED-CLIP-001 --owner <owner> --status in_progress
```

The claim command checks dependencies and current state while holding a lock. If it rejects the claim, re-list tasks and choose another; do not manually overwrite another owner's metadata.

## Re-Audit Before Implementation

Record `git status --short`, current HEAD, and the task baseline. Preserve unrelated user/agent changes.

Trace the existing path:

```text
user entry -> production owner -> provider/IPC -> typed result/effect
           -> failure/cancel/stale -> undo/recovery -> observable evidence
```

Then decide one of three cases:

- The gap still exists: continue with the task.
- Current code already satisfies the entire card: verify the production path and required checks, then update the card with that evidence. Do not reimplement it.
- The card is stale or its contract is wrong: stop implementation, record the concrete discrepancy, and ask for review before changing scope or dependencies.

Keep the task's single outcome and main ownership boundary. A discovery that belongs to the next card becomes a note or separate backlog update, not extra production work in this task.

## Implement

For behavior changes, add a focused test that fails against the claimed baseline for the intended reason. Pure audit, ADR, catalog, or evidence tasks may instead start with a deterministic check that exposes the gap.

Follow existing repository patterns and make the smallest production change that closes the card. In particular:

- Do not rewrite or reformat `CodeWorkspaceTab.tsx`; edit only the relevant owner region.
- Do not treat exported types, comments, protocol fields, fixture-only modules, screenshots, or mock-only tests as production workflow evidence.
- Do not turn typed `failed/stale/cancelled/conflict` results into `null` or `unavailable` to make tests green.
- Preserve first-failure output. A later green rerun is additional evidence, not a replacement.
- Do not mix Mail, Terminal, SFTP, VNC, File Browser, Build/Run/Debug, or unrelated refactors into an Editor parity task.

## Verify

Scale verification to the card, but always run its focused tests. Also run:

- `pnpm build` for shared TypeScript contracts, production wiring, or UI changes.
- Relevant Rust tests for Rust/IPC changes. Format only changed Rust files with `rustfmt --edition 2024 <files>`.
- Full `pnpm test` for shared editor state, action, layout, save, completion, query, or cross-workspace behavior when feasible.

When the task changes UI controls, user workflow, feature ownership, testcase YAML, or observation/evidence surfaces, explicitly use the repository `qa-ui-auto` skill. Follow its `audit -> fix one gap -> audit` loop. It does not prove visual layout, viewport behavior, a11y, performance, or native behavior.

Only run native/provider/performance/a11y/IDEA comparison when the card requires it and the environment is available. Never substitute browser stubs for native disk/clipboard/provider effects. Record required but unrun layers as `not run` and leave the task non-done when those layers are part of its DoD.

## Review And Update

Before marking completion, review the diff for unrelated files and re-read the task card against the final production path. Update status with concise evidence:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py update ED-CLIP-001 \
  --owner <owner> \
  --status done \
  --evidence "focused 12/12; pnpm build exit 0; qa audit exit 0"
python .agents/skills/code-workspace-idea-task/scripts/task_board.py validate
```

Use `blocked` only with a reproducible reason and next condition:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py update ED-PROJECT-002 \
  --owner <owner> \
  --status blocked \
  --note "Maven fixture cannot resolve artifacts offline; requires configured mirror"
```

Do not mark `done` when any card-specific verification is failing or unrun. If implementation is complete but required native/provider review cannot run, keep `in_progress` or use `blocked` with the exact missing condition.

Report the task ID, baseline/final HEAD or working-tree state, changed files, production effect chain, focused/full/QA/native command exits, unrun layers, and remaining capability ceiling. Do not claim broader IDEA parity than the evidence supports.
