# Tabs And Multi-View Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). The user must be able to open, preview, pin, reorder, split, evict, reopen, and close views without confusing view lifetime with document/resource lifetime.

## Capability Design

The workspace store owns layout and its monotonic revision. `TabPolicyPlan` freezes the layout/policy preimage and proposed result. Commit changes layout, policy, and persistence snapshot atomically. A recovery coordinator owns final-resource cleanup. Multiple views of one document share its buffer/transaction/undo owner and document decorations while retaining per-view caret, selection, scroll, and folds.

<a id="ed-tabs-001"></a>
## ED-TABS-001 Store-Owned Layout Revision

- **User outcome:** concurrent tab/split operations cannot commit against a hidden component-local layout version.
- **Audit:** `implemented`. `codeWorkspaceStore` remains the production owner and `CodeWorkspaceTab` consumes its revision; focused tests pass, but the repository build gate is red.
- **Contract:** every effective open/close/move/pin/preview/split/unsplit/resize/policy eviction increments once; no-op increments zero; workspace instances are isolated.
- **Acceptance:** `ED-TABS-001-A1` all mutations have exact revision deltas; `A2` no-op and second workspace do not affect the owner; `A3` restore starts from a coherent revision.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-tabs-002"></a>
## ED-TABS-002 Atomic Tab Policy Plan And Commit

- **User outcome:** applying a tab limit cannot evict the wrong tabs or partially persist policy/layout.
- **Audit:** `implemented`. The plan/commit model is production-wired and guarded by base revisions; focused tests pass, but the repository build gate is red.
- **Contract:** plan freezes dirty/pinned/preview/resource ids and pre/post images; cancel/stale has zero commit; persistence failure returns recovery rather than silent success.
- **Acceptance:** `ED-TABS-002-A1` clean eviction follows policy; `A2` dirty confirmation/cancel and stale plan are zero effect; `A3` one commit updates layout, policy, and snapshot with a typed receipt.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-tabs-003"></a>
## ED-TABS-003 View/Resource Recovery Coordinator

- **User outcome:** the last view closes a resource exactly once and cleanup failures can be recovered without losing the committed layout.
- **Audit:** `implemented`. `workspaceResourceRecoveryCoordinator` is called from the production tab owner and focused failure/replay tests pass, but the repository build gate is red.
- **Contract:** final release order is `didClose -> watcher -> buffer -> history`; non-final views retain all document resources; partial cleanup returns `committed-with-recovery` and an idempotent replay id.
- **Acceptance:** `ED-TABS-003-A1` same-document split retains resources until final view; `A2` each cleanup stage runs once; `A3` every failure position yields replayable recovery.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-tabs-004"></a>
## ED-TABS-004 Behavioral Tab Policy Lifecycle Case

- **User outcome:** changing a real tab limit demonstrates eviction choice, dirty confirmation, active tab, resource cleanup, and recovery.
- **Audit:** `ready`. `TC-IDE-C4-01` opens the dialog and clicks Apply without changing the limit, opening enough tabs, or asserting eviction/recovery effects.
- **Scope:** browser workflow for policy lifecycle; native key-release Tab Switcher behavior is a separate matrix observation.
- **Contract:** test fixtures must contain enough clean/dirty/pinned/preview tabs to force a deterministic plan; observations are read-only.
- **Acceptance:** `ED-TABS-004-A1` the case changes limit and previews expected victims; `A2` dirty cancel is zero effect and confirm commits; `A3` active tab/layout/resource counters match the receipt; `A4` cleanup failure exposes recovery and replay.
- **Required evidence:** `qa-lint`, `browser`, `accessibility`.

<a id="ed-multiview-001"></a>
## ED-MULTIVIEW-001 Shared Document Transaction Owner ADR

- **User outcome:** all later multi-view work has one explicit authority and lifecycle design.
- **Audit:** `done`. [`adr-shared-document-transaction-owner.md`](../adr-shared-document-transaction-owner.md) defines ownership, transactions, resource leases, migration, and rollback.
- **Scope:** design and invariants only; production implementation is ED-MULTIVIEW-002/003.
- **Acceptance:** `ED-MULTIVIEW-001-A1` ADR names view/document/resource identities; `A2` edit, undo, close, stale, recovery, migration, and rollback are specified.
- **Required evidence:** `document`, `code-audit`.

<a id="ed-multiview-002"></a>
## ED-MULTIVIEW-002 Shared Document And Undo Transaction

- **User outcome:** editing a document in either split updates both views, and one undo/redo is coherent across them.
- **Audit:** `implemented`. `WorkspaceDocumentTransactionOwner` is used by `CodeWorkspaceTab`, `EditorGroup`, and `CodeMirrorHost`; focused tests pass, but the repository build gate is red.
- **Contract:** one document version and undo ledger; per-origin echo is suppressed; closing one view cannot dispose the shared document.
- **Acceptance:** `ED-MULTIVIEW-002-A1` A edit appears in B once; `A2` undo/redo from either view applies one shared transaction; `A3` close/reopen preserves document state until final release.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-multiview-003"></a>
## ED-MULTIVIEW-003 Shared Decorations And Per-View State

- **User outcome:** diagnostics, breakpoints, and bookmarks stay consistent in all views while caret/selection/scroll/folds remain independent.
- **Audit:** `implemented`. Production now computes debug decorations per displayed file, but `workspaceMultiViewState.ts` itself has no production consumer and current evidence does not prove diagnostics/bookmarks plus per-view restoration as one workflow.
- **Contract:** document decorations key by document/version; view state keys by view id and is never broadcast as a document mutation.
- **Acceptance:** `ED-MULTIVIEW-003-A1` diagnostics/breakpoints/bookmarks update all views; `A2` caret/selection/scroll/folds remain distinct through edits; `A3` close/reopen restores the right view state without releasing shared resources.
- **Required evidence:** `code-audit`, `unit`, `browser`, `typecheck`.
