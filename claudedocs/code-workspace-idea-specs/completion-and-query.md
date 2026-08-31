# Completion And Semantic Query Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). This spec covers Basic Completion and provider-backed semantic navigation. Smart/Type-Matching and Full Line completion remain deferred because they require separate engines and evidence.

## Capability Design

Completion freezes provider response order and raw candidate identity, then resolves and accepts one candidate as a single editor transaction. Project/module scope is usable only from a ready, same-workspace project-facts generation.

`WorkspaceSemanticQueryHost` owns request envelope, abort, and four-phase live guards for definition, declaration, type definition, implementation, references, and hierarchy. Results open/reveal through the navigation owner and enter history only after successful reveal. Empty, cancelled, failed, and stale are distinct.

<a id="ed-comp-001"></a>
## ED-COMP-001 Typed Completion Resolve Outcome

- **User outcome:** a candidate that cannot resolve stays visible with a reason/retry instead of applying unsafe partial text.
- **Audit:** `implemented`. Typed resolve outcomes remain in the production completion controller path and focused tests pass; the repository build gate is red.
- **Contract:** `resolved | not-required | unavailable | timeout | failed | cancelled | stale`; missing resolver is not `not-required`; unsafe outcomes preserve popup/selection and edit zero.
- **Acceptance:** `ED-COMP-001-A1` throw/null/timeout/missing resolver are distinct; `A2` cancel/stale applies zero; `A3` explicit primary-only degradation is user initiated.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-comp-002"></a>
## ED-COMP-002 Candidate, Session, Provider Identity And Ranking

- **User outcome:** completion selection does not drift when ranking/preferences/provider state change during a popup.
- **Audit:** `implemented`. Candidate mapping and controller retain raw index, frozen identities, match-tier-first ranking, and provider order; focused tests pass, but the repository build gate is red.
- **Contract:** stable candidate id binds raw/mapped entry; session freezes document/provider/policy/project generations; live changes affect only a new session.
- **Acceptance:** `ED-COMP-002-A1` sorting never breaks raw/mapped pairs; `A2` zero/one/many and incomplete/truncated lists are stable; `A3` workspace/policy/provider changes make old acceptance stale.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-comp-003"></a>
## ED-COMP-003 Atomic Completion Acceptance And One Undo

- **User outcome:** primary text, snippet placeholders, and additional imports apply together and undo once.
- **Audit:** `implemented`. Acceptance logic and resolve gate remain in the production completion controller and focused tests pass; the repository build gate is red.
- **Contract:** revalidate candidate uniqueness, ranges, snippet, overlap, document/provider generation; do not silently drop additional edits after resolve failure.
- **Acceptance:** `ED-COMP-003-A1` snippet plus import is one transaction; `A2` overlap/stale rejects all edits; `A3` one undo restores the full preimage and explicit primary-only degradation is labelled.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-comp-004"></a>
## ED-COMP-004 Ready Project Scope Facts In Production Completion

- **User outcome:** document/module/project scope labels and results reflect the actual imported project, never guessed descriptors.
- **Audit:** `ready`. `completionScopeAdapter.ts` is only tested and has no production consumer; `projectFactsConsumers.ts` is otherwise unused. Current completion does not read the project-facts store.
- **Scope:** integrate scope resolution into completion request/session and UI. Do not implement Smart Completion or dependency completion.
- **Contract:** only same-workspace `ready` generation may supply module/project scope; discovery/loading/degraded/stale returns `scope-facts-missing`; provider-reported scope is labelled separately.
- **Acceptance:** `ED-COMP-004-A1` document/module/project requests use ready facts; `A2` stale/degraded/cross-workspace facts fail closed; `A3` UI and provider request record the effective scope.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `typecheck`.

<a id="ed-query-001"></a>
## ED-QUERY-001 Complete Semantic Query Envelope And Cancellation

- **User outcome:** late semantic results cannot navigate the wrong document or workspace.
- **Audit:** `implemented`. `WorkspaceSemanticQueryHost` is production-owned and its focused envelope/guard tests pass; the repository build gate is red.
- **Contract:** guards run before request, after response, before reveal, and before history; supersede/unmount aborts; stale/cancelled has zero reveal/history.
- **Acceptance:** `ED-QUERY-001-A1` envelope preserves every identity; `A2` supersede/cancel reaches transport; `A3` each guard rejects the corresponding race with zero downstream effect.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-query-002"></a>
## ED-QUERY-002 Definition/Declaration/Type/Implementation/References Migration

- **User outcome:** all common navigation queries share typed state, reveal, cancellation, and history behavior.
- **Audit:** `implemented`. Production navigation calls the semantic host and focused migration tests pass; provider behavior remains ED-QUERY-004 and the repository build gate is red.
- **Contract:** declaration has an explicit supported/unavailable mapping; empty is not failure; history writes only after successful open/reveal.
- **Acceptance:** `ED-QUERY-002-A1` five query kinds use the host; `A2` empty/failed/cancelled/stale are distinct; `A3` open/reveal precedes one history entry.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-query-003"></a>
## ED-QUERY-003 Call/Type Hierarchy Prepare And Expand

- **User outcome:** hierarchy roots and child expansions remain tied to the provider/document generation that produced them.
- **Audit:** `implemented`. `executeHierarchyPrepare/Expand` and `HierarchyPanel` are production-wired and focused tests pass; the repository build gate is red.
- **Contract:** prepare and every expand carry frozen envelope/provenance; root change/supersede aborts children; unavailable provider leaves an explanatory empty state.
- **Acceptance:** `ED-QUERY-003-A1` call/type prepare uses host envelope; `A2` callers/callees/supertypes/subtypes expand through the host; `A3` stale/superseded expansion changes no tree or history.
- **Required evidence:** `code-audit`, `unit`, `typecheck`.

<a id="ed-query-004"></a>
## ED-QUERY-004 Provider-Backed Query Behavior Case

- **User outcome:** a real JDT LS project proves definition, references, hierarchy expansion, open/reveal, history, and cancellation.
- **Audit:** `ready`. `TC-IDE-C6-02` currently presses `Ctrl+B` and takes a screenshot; it does not assert provider request/result, references session, reveal, history, cancel, or hierarchy expansion.
- **Scope:** packaged/native JDT LS fixture plus browser typed-unavailable branch. Rename belongs ED-REF-001.
- **Contract:** evidence records JDT LS/JDK/project identity and request generations; test waits on semantic observations, not arbitrary sleeps/screenshots.
- **Acceptance:** `ED-QUERY-004-A1` definition reveals expected fixture symbol and writes history; `A2` references session groups expected locations; `A3` hierarchy expands expected children; `A4` superseded request records cancel and zero stale reveal.
- **Required evidence:** `qa-lint`, `browser`, `native`, `provider`, `accessibility`.
- **References:** historical `BB7`, `BB8`, `BB10-C5/C6`; IDEA [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) and [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html).
