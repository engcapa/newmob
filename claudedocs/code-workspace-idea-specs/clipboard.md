# Clipboard Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). IDEA-aligned outcomes are a workspace clipboard history, copy/paste across editor views, predictable multi-caret distribution, OS permission failure that remains visible, and one undo for one paste transaction.

## Capability Design

`CodeWorkspaceTab` owns one root clipboard session per workspace instance. Each mounted editor view owns a tokenized consumer lease. `CodeMirrorHost` routes copy/paste/history actions through that handle. Workspace payload/history is distinct from the system clipboard; a system denial may fall back only when the UI identifies the fallback.

The permission state is `unknown | granted | denied` with a monotonic generation. A native capability probe may establish availability but not `granted`. A write that crossed the OS boundary before a generation change reports `performed` or `unknown-effect`, never zero effect.

<a id="ed-clip-001"></a>
## ED-CLIP-001 Consumer Lease Token Ownership

- **User outcome:** closing one split never detaches another split's clipboard access or leaks the root session.
- **Audit:** `implemented`. Current session code issues per-acquisition tokens, detaches only that token, and separates root and consumer counts; focused ownership tests pass, but the repository build gate is red.
- **Scope:** duplicate consumer ids, arbitrary detach order, idempotent detach, same path in separate workspaces, final root release.
- **Contract:** consumer id is descriptive; token is authoritative. Closing a view changes exactly one lease.
- **Acceptance:** `ED-CLIP-001-A1` duplicate ids have independent tokens; `A2` detach order cannot remove a later lease; `A3` final release clears the workspace slot once.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-clip-002"></a>
## ED-CLIP-002 Native Permission Epoch And External Effect Truth

- **User outcome:** copy/paste reports denial, fallback, stale ownership, and uncertain OS effects truthfully.
- **Audit:** `review_required`. `createNativeClipboardPermissionAdapter()` currently maps any non-null capability probe to `granted`. `writeSystemClipboard()` may perform the OS write and then return `stale-generation` with `systemEffect: 0`, which contradicts the actual boundary.
- **Scope:** native/web permission adapter, pre/post-await generation guards, same-value generation stability, and visible workspace fallback. OS-specific automation belongs to ED-CLIP-004.
- **Contract:** replace numeric `systemEffect` with an explicit `not-performed | performed | unknown` (or an equivalent typed result). A post-write stale generation cannot erase knowledge that a write was attempted/completed.
- **Acceptance:** `ED-CLIP-002-A1` capability and permission are separate; `A2` denied-before-await has no system effect; `A3` generation change after write reports performed/unknown; `A4` fallback is visible and never labelled system success.
- **Required evidence:** `code-audit`, `unit`, `typecheck` after maintainer approval of the result contract.
- **Review decision needed:** confirm the effect-state contract before this task is claimable.

<a id="ed-clip-003"></a>
## ED-CLIP-003 Mounted Cross-Split Copy/Paste/Undo

- **User outcome:** text copied in one real editor leaf pastes into another and one undo restores only the destination transaction.
- **Audit:** `implemented`. Mounted `CodeWorkspaceTab` tests create real CodeMirror leaves and the 3 focused clipboard tests pass, but the repository build gate is red.
- **Scope:** workspace clipboard path and mounted browser editor state; system permission remains ED-CLIP-004.
- **Contract:** paste is one CodeMirror transaction; source remains unchanged; destination selection and text are asserted before and after undo.
- **Acceptance:** `ED-CLIP-003-A1` A-to-B paste changes expected destination text; `A2` one undo restores destination text/selection; `A3` split close returns lease count to its exact pre-split value.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-clip-004"></a>
## ED-CLIP-004 Behavioral And Native Clipboard Case

- **User outcome:** the shipped workflow proves cross-view effect, history selection, undo, cleanup, and OS denial/grant behavior.
- **Audit:** `ready`. `TC-IDE-C3-01` presses paste and undo but does not assert destination text at either point; cleanup allows `<= 2` instead of restoring the initial count. Native permission/rectangle coverage is unrun.
- **Scope:** strengthen the browser case with read-only observable text/selection/revision facts; add packaged Linux permission and rectangular/multi-caret behavior. Windows/macOS remain independent matrix entries.
- **Contract:** observations expose redacted state/effect only and cannot execute actions. Screenshots are diagnostic artifacts, not assertions.
- **Acceptance:** `ED-CLIP-004-A1` browser case proves exact paste and undo text; `A2` history selection changes the expected payload/revision; `A3` lease count returns exactly to baseline; `A4` packaged Linux proves denial/grant and multi-caret/rectangle behavior.
- **Required evidence:** `qa-lint`, `browser`, `native`, `accessibility`.
- **References:** historical `BB1`, `BB10-C3`, `BB11`; IDEA [Multiple cursors](https://www.jetbrains.com/help/idea/multicursor.html).
