---
name: code-workspace-idea-task
description: Claim and deliver exactly one small Taomni Code Workspace editor task from the active IntelliJ IDEA parity backlog. Use when an agent should select or receive a claimable ED-* card, implement or finish its evidence, verify every acceptance ID, and update the shared board. Do not use the historical design document as a queue or for unrelated Code Workspace work.
---

# Code Workspace IDEA Task

Deliver one `ED-*` task from `claudedocs/code-workspace-idea-parity-backlog.md`. A historical green task, exported model, fixture-only path, screenshot, or unrun check is not current completion evidence.

## Read The Contract

Before claiming:

1. Read the repository `AGENTS.md`.
2. Read backlog sections 1-3, the selected card, and its dependency cards.
3. Read `claudedocs/code-workspace-idea-specs/shared-contracts.md` and the selected card's linked spec section, including the capability design above it.
4. Read [references/task-lifecycle.md](references/task-lifecycle.md) before using the task-board script.

Read `claudedocs/code-workspace-ide-design.md` only when a card's `legacy` links or an implementation question needs historical detail. Its old queues are archives, never claim sources.

Before verification or a terminal status update, read [references/evidence-policy.md](references/evidence-policy.md).

## Non-Negotiable Boundaries

- Work on exactly one claimed task. Do not absorb adjacent cards or unrelated editor/product work.
- Claim only `ready` or `implemented` when all dependencies are `done`. Never manually edit ownership metadata.
- Re-audit current production code after claiming. The backlog records a dated baseline, not an assumption that the gap is unchanged.
- Satisfy the selected spec, every listed acceptance ID, and every required evidence kind. Do not weaken the spec or tests to fit existing code.
- Trace a real chain: user entry -> production owner -> provider/IPC -> typed result/effect -> failure/cancel/stale -> undo/recovery -> observable evidence.
- Preserve unrelated worktree changes. Keep edits within the card's outcome and ownership boundary.
- Do not collapse `failed`, `cancelled`, `stale`, `conflict`, or unknown external effects into generic success/unavailable states.
- Browser stubs cannot prove native filesystem, clipboard, IME, provider, performance, accessibility, or IDEA behavior.
- A task is `done` only when structured evidence covers all acceptance IDs and every required evidence kind has a final passing check.

## Implement And Verify

If current code already satisfies the card, do not reimplement it; verify the production path and close only with valid current evidence. If the implementation contradicts a material spec contract, stop scope-changing work and set `review_required` with the exact decision needed.

For behavior changes, add a focused regression test that fails for the intended reason on the claimed baseline. Pure ADR, audit, catalog, or evidence tasks may use a deterministic failing check instead. Follow local patterns and avoid broad rewrites, especially in `CodeWorkspaceTab.tsx`.

Always run focused checks. For TypeScript contracts, production wiring, or UI changes run the scoped gate — `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <each path this card owns>` — and run repo-wide `pnpm build` only for the cards that still hold the `build` kind (ED-GATE-003, ED-GATE-001, ED-QA-001). Run relevant Rust tests for Rust/IPC changes. Use the repository `qa-ui-auto` skill when the task changes UI controls, user workflows, testcase YAML, feature ownership, or observation/evidence surfaces. Run native/provider/performance/accessibility/IDEA layers only in qualifying environments; record unavailable layers without fabricating substitutes.

Before updating the board, review the final diff and re-check every acceptance ID against the actual production path. Preserve failed checks before successful reruns in chronological evidence.

## Finish One Task

End in one truthful state:

- `done`: all acceptance and required evidence passed.
- `implemented`: production work is complete, but named required evidence is missing or currently failing.
- `review_required`: implementation and spec have a material contract conflict requiring maintainer review.
- `blocked`: a reproducible external prerequisite prevents further progress; record the condition needed to resume.

Validate the board after the update. If the caller requested one commit per task, stage only this task's implementation, tests, necessary spec changes, and backlog update, then create one conventional commit containing the task ID. Never include unrelated user/agent changes.

Report the task ID, baseline and final worktree/commit state, files changed, production effect chain, commands and results, unrun layers, terminal status, and the narrow capability ceiling. Do not claim broader IDEA parity than the evidence proves.
