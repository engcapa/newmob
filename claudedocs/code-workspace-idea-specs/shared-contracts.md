# Code Workspace IDEA Parity Shared Contracts

> Authority: active requirements shared by every `ED-*` task.
> Audit baseline: `5ac80fc4ef663bbcd6c04e11863697b2e4cc060b` (2026-08-29).
> Historical source: [`code-workspace-ide-design.md`](../code-workspace-ide-design.md), which is an archive rather than a task queue.

Current audit limitation: focused core suites pass (21 files/309 tests plus 3 mounted clipboard tests), but full `pnpm test` fails 5/3,425 tests and `pnpm build` fails TypeScript compilation across several reopened task modules. Consequently, no TypeScript production task is `done` at this baseline; a code-complete narrow task is at most `implemented` until the build gate is green. The only retained `done` card is the document-only ED-MULTIVIEW-001 ADR.

## 1. Product Goal And Claim Boundary

The Code Workspace editor should reproduce the observable IntelliJ IDEA code-editor workflow where Taomni has an equivalent provider and platform capability. It does not copy IDEA's private PSI, index, ranking, or inspection engines. A visible command, a TypeScript model, an exported protocol, or a screenshot is not itself a delivered workflow.

An implementation is complete only when this chain is real:

```text
user entry -> production owner -> provider/IPC -> typed result or effect
           -> failure/cancel/stale -> undo/recovery -> observable evidence
```

The parity levels are:

| Level | Meaning |
|---|---|
| L0 | No production entry, or the entry cannot produce its promised result. |
| L1 | UI/protocol is wired, but effect, failure, scope, provider truth, or undo is incomplete. |
| L2 | The real main path, negative paths, state synchronization, and undo/recovery pass focused behavior automation. |
| L3 | L2 plus target-platform native, performance, accessibility, and observed IDEA comparison evidence. |

Task completion never promotes a whole capability family automatically. Claims must name the capability, fixture, provider, platform, and highest proven level.

## 2. Shared Identities And Ownership

Every async editor operation freezes the identities it relies on before awaiting: workspace instance, document URI/key and revision, provider id/version/generation, project-facts generation/fingerprint, policy generation, and request id. The production owner revalidates the relevant identities immediately before an irreversible effect.

- A view is not a document. Multiple editor leaves may share one document transaction owner and undo ledger while retaining independent caret, selection, scroll, and fold state.
- A provider response is not a user effect. Request/resolve models remain immutable until a current production owner commits them.
- A disk acknowledgement is not a buffer overwrite. Save writeback merges metadata and must not resurrect a closed buffer or erase newer typing.
- A capability probe is not a permission state. Permission, trust, and provider readiness use explicit typed states.
- An attempted external effect is not necessarily zero effect. If an await returns after ownership changes, report `performed`, `not-performed`, or `unknown`; never claim zero after an OS write may have happened.

## 3. Result And Failure Contract

Do not collapse these states into `null`, an empty list, or generic `unavailable`:

- `unsupported`: the provider/platform does not advertise the capability.
- `unavailable`: prerequisites are absent or not ready.
- `cancelled`: the user or owner intentionally stopped the operation.
- `stale`: frozen identity no longer matches live identity; commit effect is zero unless the result explicitly says an external effect is unknown/performed.
- `conflict`: a live resource differs from the planned preimage.
- `failed`: execution started and returned a known failure.
- `unknown-effect`: the boundary cannot prove whether an external side effect occurred.
- `applied`: postconditions and effect receipts match the committed plan.

Failures remain visible and retryable where retry is safe. Cancellation and stale results do not create history entries. A multi-resource mutation is one logical transaction with one preview, one commit decision, and one undo/recovery identity.

## 4. Interaction Contract

- Menu, command palette, context menu, toolbar, gutter, and keymap entries route to one action definition and one production owner.
- Disabled or unavailable commands explain the actual missing prerequisite; they do not silently run a weaker unrelated behavior.
- Async results never steal focus after the initiating view, document, or workspace loses ownership.
- Keyboard-only use, visible focus, accessible name/role/state, 200% zoom, screen-reader announcements, and IME composition are separate evidence dimensions.
- Browser stubs may prove UI routing and typed unavailable states. They cannot prove native filesystem, system clipboard, IME, packaged-runtime, or real language-provider effects.

## 5. Task Status Contract

| Status | Meaning | Claimable |
|---|---|---:|
| `ready` | Remaining implementation and acceptance are defined. | yes, once dependencies are `done` |
| `implemented` | Production code is present, but one or more required evidence layers are missing. | yes, to finish evidence or a named audit gap |
| `claimed` | An owner and baseline have been recorded; production edits have not started. | no |
| `in_progress` | Implementation or verification is in progress. | no |
| `blocked` | A reproducible external/prerequisite condition prevents progress. | no |
| `review_required` | The implementation and specification disagree on a material contract. | no; maintainer resolution required |
| `done` | Every acceptance ID and required evidence kind passed for the current production path. | no |
| `deferred` | Explicitly outside the current claimable scope. | no |

`implemented` is not a release pass. Dependencies remain strict: a dependent task is claimable only after every `depends_on` task is `done`. This deliberately makes agents finish the predecessor's evidence before building on it.

When an audited historical `done` task is reopened, its old owner, baseline, timestamps, and evidence stay in `prior_completion`. They are audit history, not current completion evidence.

## 6. Acceptance And Evidence

Every task owns stable acceptance IDs in its spec. Backlog metadata lists those IDs and required evidence kinds. A `done` update supplies structured evidence:

```json
{
  "verified_at": "2026-08-29T00:00:00Z",
  "head": "<40-char commit>",
  "checks": [
    {
      "kind": "unit",
      "command": "pnpm test <focused files>",
      "result": "passed",
      "summary": "12/12 tests passed",
      "acceptance": ["ED-EXAMPLE-001-A1", "ED-EXAMPLE-001-A2"]
    }
  ],
  "unrun": [],
  "notes": []
}
```

Allowed evidence kinds are `code-audit`, `unit`, `build`, `rust`, `qa-lint`, `browser`, `native`, `provider`, `performance`, `accessibility`, `idea-comparison`, and `document`. Each `required_evidence` kind needs a matching final `checks` entry with `result: passed`, and the union of `acceptance` on passed checks must cover every acceptance ID on the task card. Checks are chronological, so an initial failure remains in the record while a later pass for the same kind establishes its final result. A check may use an empty acceptance list when it is a broad gate such as `build`; it still satisfies its required evidence kind. `unrun` is informational and can never satisfy a required kind or acceptance ID.

Evidence rules:

1. `code-audit` names the production consumer and traces the effect chain; import/export existence alone fails.
2. `unit` and `build` include the exact command, exit/result, and focused count where available.
3. `browser` asserts observable state/effect and undo, not only visibility, key presses, screenshots, or dev-only counters.
4. `native` uses a packaged or Tauri runtime and a real OS boundary; browser VFS/stubs do not qualify.
5. `provider` records provider id/version, JDK/tooling, fixture identity, request/result/cancel facts, and postcondition.
6. `performance` records environment, warmup, samples, percentile method, and raw artifact.
7. `accessibility` records keyboard, focus, name/role/state, zoom, screen reader, and IME separately.
8. `idea-comparison` records the IDEA version, identical fixture/action, observed delta, and accepted ceiling.
9. Unit tests that construct fake receipts or hard-code PASS records only test validators; they are not runner evidence.

## 7. Specification Template

Each task section in a capability spec contains:

- user outcome and current audited gap;
- in-scope and out-of-scope boundaries;
- interaction/state and production ownership;
- failure, cancellation, stale, undo, and recovery semantics;
- stable acceptance IDs;
- required evidence kinds and exact constraints;
- historical design and public IDEA references where useful.

If implementation discovery invalidates any of these contracts, set `review_required` and request review. Do not silently redefine acceptance to match the current code.

## 8. Public IDEA References

- [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html)
- [Write and edit source code](https://www.jetbrains.com/help/idea/working-with-source-code.html)
- [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html)
- [Code reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html)
- [Intention actions](https://www.jetbrains.com/help/idea/intention-actions.html)
- [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)
- [Search for usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html)
- [Editor tabs](https://www.jetbrains.com/help/idea/editor-tabs.html)
- [Multiple cursors](https://www.jetbrains.com/help/idea/multicursor.html)
- [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html)
