# Search, Navigation, Usages, And Refactor Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). File-local search, project search, semantic usages, navigation, and refactor are separate workflows. Regex text matches cannot stand in for provider semantic completeness.

## Capability Design

File-local Find/Replace is owned by the CodeMirror search panel and syntax-aware filters. Find/Replace in Files requires a production scope resolver, file-mask matcher, result session, preview/exclusion, conflict recheck, one workspace transaction, and undo/recovery. Semantic usages run through `WorkspaceSemanticQueryHost` and `UsageQuerySession`, with provider role/completeness evidence.

Navigation history is written after successful reveal. Breadcrumb/navigation bar and explicit occurrence highlighting share workspace actions but maintain their own focus/session state. Refactor plans consume real provider edits and usage/project evidence, then use canonical preview/commit/history.

<a id="ed-find-001"></a>
## ED-FIND-001 Preserve Case In File Replace

- **User outcome:** Preserve Case replacement respects the capitalization pattern of each selected match.
- **Audit:** `implemented`. The production CodeMirror search panel owns the option and focused tests pass; the repository build gate is red.
- **Contract:** preserve-case composes with literal/regex/whole-word and replace-one/all; unsupported mixed patterns use a deterministic documented fallback.
- **Acceptance:** `ED-FIND-001-A1` upper/lower/title/camel examples transform correctly; `A2` regex groups remain correct; `A3` replace-all is one undo transaction.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-find-002"></a>
## ED-FIND-002 Selection, Comments, And Strings Filters

- **User outcome:** users can limit in-file matches to selection, comments, or string literals without corrupting replacement ranges.
- **Audit:** `implemented`. Filter logic is integrated into the production editor search panel and focused tests pass; the repository build gate is red.
- **Contract:** selection snapshot is frozen per query; comments/strings require supported syntax context and expose unavailable otherwise; replacements apply only to current matching ranges.
- **Acceptance:** `ED-FIND-002-A1` each filter returns exact ranges; `A2` unsupported language is explicit; `A3` edits that stale the query force recomputation before replace.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-find-003"></a>
## ED-FIND-003 Find In Files Scope And File Mask

- **User outcome:** project/module/directory/recent/custom scopes and include/exclude masks constrain real search results predictably.
- **Audit:** `ready`. `findInFilesScopeModel.ts` is not imported by `FindInFilesPanel` or `CodeWorkspaceTab`; the visible panel therefore does not consume the new scope model or ready project facts.
- **Contract:** module scope requires ready facts; roots and masks normalize safely; excluded/read-only/generated paths are labelled; cancellation/stale generation stops result publication.
- **Acceptance:** `ED-FIND-003-A1` production panel builds the selected scope plan; `A2` masks and exclusions match exact fixture files; `A3` degraded/stale/cross-workspace facts fail closed; `A4` cancel stops search and late results.
- **Required evidence:** `code-audit`, `unit`, `browser`, `native`, `build`.

<a id="ed-find-004"></a>
## ED-FIND-004 Replace In Files Preview, Exclude, Commit

- **User outcome:** users review matches, exclude rows/files, commit current preimages once, and undo/recover the workspace edit.
- **Audit:** `ready`. `replaceInFilesModel.ts` is test-only and the visible project-search workflow has no production preview/commit integration.
- **Contract:** preview freezes query/scope/file hashes and exact edits; exclusion rebuilds the immutable plan; pre-commit recheck detects dirty/disk conflicts; partial external failure enters recovery.
- **Acceptance:** `ED-FIND-004-A1` preview groups exact files/matches and exclusions; `A2` cancel/stale/conflict has zero commit; `A3` accepted plan applies once with post hashes; `A4` one undo restores all affected resources or exposes recovery.
- **Required evidence:** `code-audit`, `unit`, `browser`, `native`, `build`.

<a id="ed-nav-001"></a>
## ED-NAV-001 Keyboard Navigation Bar

- **User outcome:** users traverse breadcrumb segments, open siblings/children, and reveal a target without leaving the keyboard.
- **Audit:** `implemented`. `Breadcrumbs` and navigation model are production-wired, but the task's keyboard-only/focus/accessibility workflow has no browser evidence.
- **Contract:** one focused segment; arrow/home/end/enter/escape behavior; async children respect workspace/document generation; successful reveal enters history once.
- **Acceptance:** `ED-NAV-001-A1` keyboard traversal and popup selection are deterministic; `A2` cancel/stale leaves focus/history unchanged; `A3` reveal/focus and accessible name/role/state pass browser checks.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-nav-002"></a>
## ED-NAV-002 Highlight Usages And Occurrence Navigation

- **User outcome:** explicit highlight, next/previous occurrence, and clear operate on one current occurrence session.
- **Audit:** `implemented`. Occurrence model and workspace actions are production-wired, but no behavior case proves text/provider occurrence transitions, stale clearing, and keyboard focus.
- **Contract:** lexical and provider results are labelled; document revision invalidates ranges; navigation wraps only when the setting says so; clear removes only explicit-session decorations.
- **Acceptance:** `ED-NAV-002-A1` highlight creates exact current ranges/source label; `A2` next/previous/wrap reveal expected match; `A3` edit/file switch/provider stale clears or refreshes safely.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-usage-001"></a>
## ED-USAGE-001 Show/Find Usages Result Session

- **User outcome:** Show Usages and Find Usages share grouped results, scope, refresh, reveal, and cancellation without losing the previous session prematurely.
- **Audit:** `implemented`. `UsageQuerySession` is instantiated and used by the production editor and focused tests pass; the repository build gate is red.
- **Contract:** one session freezes symbol/provider/project/scope; refresh supersedes with cancellation; successful reveal writes history; empty/partial/failed remain distinct.
- **Acceptance:** `ED-USAGE-001-A1` Show/Find create the intended session/presentation; `A2` grouped result and reveal are stable; `A3` refresh/cancel/stale preserve correct prior/current state.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-usage-002"></a>
## ED-USAGE-002 Provider Role And Completeness Evidence

- **User outcome:** usage results state whether they cover reads, writes, declarations, libraries, and the whole requested scope.
- **Audit:** `ready`. `providerUsageEvidence.ts` is test-only and current usages/refactor production paths do not consume its role/completeness report.
- **Contract:** completeness is provider/fixture evidence, never inferred from nonempty results; unknown roles stay unknown; refactor may fail closed when required completeness is absent.
- **Acceptance:** `ED-USAGE-002-A1` production result session records role/source/completeness; `A2` JDT LS fixture proves expected read/write/declaration/library rows; `A3` partial/unknown evidence visibly limits refactor claims.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `build`.

<a id="ed-ref-001"></a>
## ED-REF-001 Rename/Refactor Completeness And Conflict Cycle

- **User outcome:** provider rename/refactor previews all known changes, blocks unsafe incomplete cases, commits once, and undoes/recoveries coherently.
- **Audit:** `ready`. `refactorPlan.ts` is production-consumed, but its current tests do not type-check against `LspFileTextEdits`/completeness contracts; there is also no real JDT LS multi-file rename proof, provider completeness integration, or verified postcondition/undo hash transaction.
- **Contract:** plan records coverage/completeness/library ownership/project generation and resource preimages; excluded/dirty/read-only conflicts are resolved before commit; Safe Delete fails closed without dedicated coverage.
- **Acceptance:** `ED-REF-001-A1` JDT LS multi-file rename preview matches fixture; `A2` dirty/library/read-only/incomplete/stale cases block or explain; `A3` commit post hashes match; `A4` one undo restores hashes and restart recovery is replayable.
- **Required evidence:** `code-audit`, `unit`, `browser`, `native`, `provider`, `build`.
- **References:** historical `N9.1`, `W4/W5`, `BB5`; IDEA [Search for usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html) and [Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html).
