# Backlog And Specification Authoring

Use this mode only when the caller asks to create/review task cards or designs.
Do not claim product work to write a plan. Do not change historical ownership,
status, or completion evidence unless the caller requests that change.

## Deliver The Linked Contract

- Keep backlog sections 1-3 for board selection/rules, spec index and delivery gates.
  Cards contain discovery metadata and a spec link; put implementation contracts
  in the linked capability document.
- Each card has one small production outcome, explicit file/symbol ownership,
  dependencies within this board, and a real spec section with
  `<a id="ed-example-001"></a>`.
- Use that card's own full acceptance IDs, for example `ED-EXAMPLE-001-A1`.
  Do not borrow another card's acceptance or anchor to satisfy validation.
- A spec contains current code facts, proposed changes, UI-to-effect ownership,
  typed failure/cancel/stale/unknown effects, undo/recovery, exact fixture/action,
  focused tests, native platform plan, evidence kinds and completion ceiling.
- Distinguish a confirmed code defect from an IDEA behavior that still requires
  observation. Reference current production callers, not only exported helpers.
  Missing evidence is not automatically a code bug. Earlier failed checks followed
  by a final pass are valid history; unrun non-required layers are not automatic
  reasons to reopen a card.
- Record real IDEA version/build and same-fixture observations only after execution.
  Documents and synthetic fixtures are not real comparison evidence.
- New tasks may use `prior_completion: {"kind":"new-task","completed":false}`
  to satisfy the current board format without inventing completion history.
  Set audit date/HEAD and a factual finding; omit owner/claimed_at/baseline/evidence
  on new ready cards. Metadata belongs immediately after the task heading.
- Required evidence in metadata and spec must agree. A behavior card owns scoped
  typecheck; assign repository build to an explicit integration card. Cross-platform
  plans and the current-platform completion requirement must be unambiguous.
- Reuse qa-ui-auto's current runners and evidence contracts. Proposed collectors,
  cases or schema files must be marked as new and assigned to a task; don't print
  unimplemented commands as if they already run.

## Handoff Check

Run both commands with the exact selected board path:

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md list --claimable
```

Also review spec links, owner/test paths, every acceptance-to-verification mapping
and shared-file dependency conflicts. Successful board validation checks metadata
and anchors, not product implementation or IDEA parity. Do not mark planned work
done. Report the backlog/spec links, actual validation and remaining runtime gaps.
