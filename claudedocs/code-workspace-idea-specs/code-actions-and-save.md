# Code Actions And Save Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). IDEA-aligned intentions and save actions need a single provider request/resolve/plan owner, explicit preview and failure states, atomic workspace edits, and truthful disk receipts.

## Capability Design

`CanonicalCodeActionService` owns capability check, request, stable candidate identity, resolve, and immutable plan. Lightbulb, Alt+Enter, Problems, context menu, Search Actions, and save organize-imports consume it rather than rebuilding the protocol. Apply mode then uses the workspace edit transaction owner for preview, commit, postcondition, history, and recovery. Plan-only mode is pure: no live edit, command, disk write, or history.

Save freezes a `PreparedSave` through format, organize-imports, trim, final newline, EOL, and charset/BOM stages. One byte writer commits final bytes after a synchronous boundary recheck. A write acknowledgement and readback receipt drive metadata writeback; newer text remains dirty.

<a id="ed-action-001"></a>
## ED-ACTION-001 Canonical Code Action Service Core

- **User outcome:** code-action candidates have stable identity and typed provider failures instead of disappearing or changing under the popup.
- **Audit:** `implemented`. The canonical service implements request and resolve-plan contracts, is instantiated by the production editor, and its focused tests pass; the repository build gate is red.
- **Contract:** freeze document/diagnostic/provider/project/trust identity; unknown/plaintext never defaults to Java; malformed, timeout, failed, cancelled, stale, and command allowlist outcomes are typed.
- **Acceptance:** `ED-ACTION-001-A1` candidate ids remain stable across mapping; `A2` timeout/throw/null/malformed are distinct; `A3` stale/trust/language mismatch produces zero plan/effect.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-action-002"></a>
## ED-ACTION-002 Lightbulb And Alt+Enter Migration

- **User outcome:** gutter lightbulb and Alt+Enter show the same frozen candidates, resolve state, retry, and disabled reason.
- **Audit:** `implemented`. Candidate request and canonical resolve are production-wired, but `runCodeAction` still contains a direct resolve fallback and executes through legacy `executeCodeAction`; the declared mounted two-entry equivalence is incomplete.
- **Scope:** entry/session/request/resolve ownership. Final apply unification is ED-ACTION-004.
- **Contract:** opening one entry supersedes the prior request; resolve failure keeps the candidate list and exposes retry; stale result applies zero edits.
- **Acceptance:** `ED-ACTION-002-A1` both entries share request/session/candidate ids; `A2` resolve failure stays visible/retryable; `A3` static and mounted checks show no direct request/resolve path outside the service.
- **Required evidence:** `code-audit`, `unit`, `browser`, `build`.

<a id="ed-action-003"></a>
## ED-ACTION-003 Problems, Context Menu, And Save Plan-Only Migration

- **User outcome:** every code-action entry sees one candidate/resolve truth, while save can obtain a pure organize-imports plan.
- **Audit:** `implemented`. Save calls `planAction()` and validates the returned plan, and editor entries share candidate creation, but current evidence does not prove all five mounted entries or fully eliminate legacy execution composition.
- **Contract:** plan-only effect counters are exactly zero; Problems/context menu cannot bypass candidate/session identity; a command-only or multi-file save plan is typed unavailable.
- **Acceptance:** `ED-ACTION-003-A1` five entries use the canonical service; `A2` mounted entries share the same request result; `A3` plan-only records zero edit/write/history/command effects.
- **Required evidence:** `code-audit`, `unit`, `browser`, `build`.

<a id="ed-action-004"></a>
## ED-ACTION-004 Canonical Preview, Commit, Postcondition, And History

- **User outcome:** applying an intention previews its actual scope, commits once, verifies the result, and supports coherent undo/recovery.
- **Audit:** `ready`. `CanonicalCodeActionService.applyPlan()` exists but has no production caller; `runCodeAction` uses legacy `executeCodeAction`. The service registers history callbacks whose undo/redo bodies are empty, so generated ids/hashes do not prove recovery.
- **Scope:** wire all apply-mode entries to one transaction owner; retain plan-only save behavior. Do not broaden into unsupported IDEA inspection/refactor engines.
- **Contract:** preview freezes affected URIs/preimages; revalidate after preview and immediately before commit; partial failure produces recovery; history undo/redo performs and verifies real inverse/forward effects.
- **Acceptance:** `ED-ACTION-004-A1` production entries call canonical apply only; `A2` multi-file preview/cancel/conflict/stale have correct effects; `A3` post hashes match live resources; `A4` history undo/redo and recovery ids perform verified transactions.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `build`.

<a id="ed-save-001"></a>
## ED-SAVE-001 Six-Stage Immutable Save Plan

- **User outcome:** save behavior is deterministic and every transformation can explain whether it applied, failed, was unavailable, or became stale.
- **Audit:** `implemented`. The six-stage pipeline is used by the production style controller/save path and focused tests pass; the repository build gate is red.
- **Contract:** freeze text/document/disk/policy/style/provider/project/encoding identity; stages are format, organize-imports, trim, final-newline, EOL, charset-BOM; preparation has zero live-buffer/disk effect.
- **Acceptance:** `ED-SAVE-001-A1` every stage has typed status/reason and SHA-256; `A2` stage order is fixed; `A3` encoding failure is one terminal failed stage with zero live effect.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-save-002"></a>
## ED-SAVE-002 Organize Imports Through Plan-Only Code Action

- **User outcome:** save can organize imports without executing hidden commands or mutating unrelated files.
- **Audit:** `implemented`. Production save requests `source.organizeImports` through canonical `planAction()` and focused validation tests pass; the repository build gate is red.
- **Contract:** target URI/version/ranges/overlap must match; command-only and non-atomic multi-file edits are unavailable; provider failure follows save policy and remains visible.
- **Acceptance:** `ED-SAVE-002-A1` valid single-file plan transforms shadow text only; `A2` wrong URI/version/overlap/multi-file/command is rejected; `A3` effect counters stay zero before save commit.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-save-003"></a>
## ED-SAVE-003 Single Byte Writer And Final-Bytes Receipt

- **User outcome:** one save produces at most one disk write, and the UI can distinguish current, stale-snapshot, failed, unknown-effect, and recovery states.
- **Audit:** `implemented`. `PreparedSave` is used by open/closed production save paths and focused byte/race tests pass; the repository build gate is red.
- **Contract:** synchronous pre-write identity check; one writer; receipt includes logical/encoded hashes, disk pre/post, count, and transaction/recovery ids; typing during write remains dirty.
- **Acceptance:** `ED-SAVE-003-A1` BOM/EOL/encoding produce expected bytes and count=1; `A2` disk/typing/closed-buffer races are typed; `A3` unknown effects enter recovery and never show ordinary success.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-save-004"></a>
## ED-SAVE-004 Behavioral And Native Save Evidence

- **User outcome:** packaged save proves actual final bytes, saved/dirty UI, stale typing behavior, and recovery/undo across supported encodings.
- **Audit:** `ready`. `saveObservationContract.ts` is only consumed by tests, there is no native runner/fixture integration, and no current C0 behavior case reconciles receipts with real disk bytes.
- **Scope:** wire a read-only observation adapter to real save receipts; run a temporary native workspace for UTF-8/BOM/UTF-16/Latin-1 and LF/CRLF. Browser VFS can test UI states only.
- **Contract:** observations contain hashes/metadata, never source text; native runner independently hashes disk bytes; newer typing is preserved; recovery is exercised after an induced write/readback failure.
- **Acceptance:** `ED-SAVE-004-A1` browser proves dirty/saved/stale UI against a receipt; `A2` packaged Linux verifies encoding/EOL byte matrix; `A3` receipt and independent disk hash agree; `A4` failure/recovery and undo remain coherent.
- **Required evidence:** `qa-lint`, `browser`, `native`, `accessibility`.
- **References:** historical `BB5`, `BB6`, `BB10-C0`, `BB11`; IDEA [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html).
