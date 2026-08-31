# Project Facts, Import, And Templates Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). Maven/Gradle files discovered on disk are hints, not a resolved project model. Semantic consumers require tooling-derived, trusted, generation-scoped facts.

## Capability Design

Native tooling commands ingest Maven/Gradle output into typed facts. The project-facts store publishes `discovery | loading | ready | degraded | failed` entries keyed by workspace root and generation. Ready facts include modules, source/resource roots, classpaths, compiler/language level, outputs, and a fingerprint. Completion, query, refactor, imports, formatting scopes, and templates consume the same snapshot.

Untrusted workspaces do not execute build tooling. Offline/proxy/tool-missing/timeout/malformed output is visible and cannot be promoted to ready. Descriptor parsing remains useful for discovery UI only.

<a id="ed-project-001"></a>
## ED-PROJECT-001 Descriptor Discovery Versus Ready Snapshot

- **User outcome:** the UI can say that a Maven/Gradle project was discovered without pretending its modules/classpath are resolved.
- **Audit:** `implemented`. `projectStructureModel.ts` separates discovery/snapshot states, but its only current non-test downstream path is another unwired find-scope model; no production workspace status consumes it.
- **Contract:** descriptor data never yields ready semantic scope; unknown/loading/degraded consumers fail closed with a reason.
- **Acceptance:** `ED-PROJECT-001-A1` discovery and ready types cannot be confused; `A2` consumers reject non-ready/stale generation; `A3` production UI exposes discovered/loading/degraded truth.
- **Required evidence:** `code-audit`, `unit`, `browser`, `typecheck`.

<a id="ed-project-002"></a>
## ED-PROJECT-002 Trusted Maven Tooling Ingestion

- **User outcome:** a trusted Maven workspace exposes real modules, roots, classpath, language level, and outputs with actionable failures.
- **Audit:** `implemented`. Rust Maven tooling and TypeScript IPC exist and are registered, but no Code Workspace production consumer invokes them; historical evidence omitted required Rust/native fixture runs.
- **Contract:** execute only after trust; bound timeout/output; fingerprint command/tool/version/descriptors; distinguish missing tool, offline/proxy, nonzero exit, malformed output, cancelled, and stale.
- **Acceptance:** `ED-PROJECT-002-A1` single/multi-module fixtures resolve exact facts; `A2` untrusted is zero process effect; `A3` offline/missing/malformed/cancel/stale are typed and cache no ready result.
- **Required evidence:** `code-audit`, `unit`, `rust`, `native`, `typecheck`.

<a id="ed-project-003"></a>
## ED-PROJECT-003 Trusted Gradle Tooling Ingestion

- **User outcome:** a trusted Gradle workspace exposes the same normalized fact schema without running wrappers unexpectedly.
- **Audit:** `implemented`. Rust Gradle tooling and IPC are registered but not consumed by Code Workspace; historical evidence omitted Rust/native fixture runs.
- **Contract:** wrapper/system Gradle selection is explicit; trust, offline, daemon, timeout, output limits, cancellation, and fingerprint rules mirror Maven.
- **Acceptance:** `ED-PROJECT-003-A1` single/multi-project fixtures normalize exact facts; `A2` untrusted/unsupported wrapper is zero process effect; `A3` failure/cancel/stale never publishes ready.
- **Required evidence:** `code-audit`, `unit`, `rust`, `native`, `typecheck`.

<a id="ed-project-004"></a>
## ED-PROJECT-004 Project Facts Cache And Generation Lifecycle

- **User outcome:** project import has visible state and semantic consumers never use old facts after descriptor/tooling changes.
- **Audit:** `ready`. `projectFactsStore`, hook, and status badge exist but have no production consumer, and the store/tests currently do not type-check against `JavaProjectModuleV1`.
- **Contract:** cache key includes workspace/tooling/descriptors; invalidation increments generation; late results cannot replace newer state; refresh and trust changes are explicit.
- **Acceptance:** `ED-PROJECT-004-A1` state transitions and generation are monotonic; `A2` concurrent/late fetches are deduplicated or stale; `A3` production status/refresh consumes the store.
- **Required evidence:** `code-audit`, `unit`, `browser`, `typecheck`.

<a id="ed-project-005"></a>
## ED-PROJECT-005 Completion, Query, And Refactor Consumers

- **User outcome:** semantic workflows use the same ready module/classpath truth and show why project scope is unavailable.
- **Audit:** `ready`. `projectFactsConsumers.ts` has no production consumer except the separately unwired completion adapter; query/refactor paths still derive identity from older project analysis.
- **Scope:** wire three consumers and status UI; auto-import/templates remain their own tasks.
- **Contract:** same workspace/generation/fingerprint required; loading/degraded/stale is fail-closed; a consumer records the fact generation in its request/plan.
- **Acceptance:** `ED-PROJECT-005-A1` completion/query/refactor read one ready snapshot; `A2` invalidation cancels or stales in-flight work; `A3` cross-root and degraded facts never leak into requests; `A4` UI identifies the missing project prerequisite.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `typecheck`.

<a id="ed-import-001"></a>
## ED-IMPORT-001 Provider-Backed On-The-Fly And Paste Auto-Import

- **User outcome:** a unique trusted provider candidate may import automatically by policy; ambiguous candidates require selection; paste imports undo with the paste.
- **Audit:** `ready`. `autoImportModel.ts` and its tests have no production consumer.
- **Contract:** candidates come from provider plus ready classpath, never a fixed dictionary; exclusions/priorities are policy; stale provider/project rejects all edits; one import/paste transaction has one undo.
- **Acceptance:** `ED-IMPORT-001-A1` unique/ambiguous/excluded/prioritized flows match policy; `A2` paste and on-the-fly settings are independent; `A3` stale generations apply zero; `A4` provider-backed fixture proves import and one undo.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `typecheck`.

<a id="ed-template-001"></a>
## ED-TEMPLATE-001 Minimal Java File And Code Templates

- **User outcome:** New Class/Interface/Record creates the right package/source-root file from an editable safe template and can undo/recover the resource creation.
- **Audit:** `ready`. `fileTemplateModel.ts` is test-only with no command, dialog, project-facts integration, or resource transaction owner in production.
- **Contract:** only ready source-root/package facts; validate names/path/conflict; template variables are allowlisted; create is one recoverable resource transaction.
- **Acceptance:** `ED-TEMPLATE-001-A1` command/dialog creates class/interface/record in expected package; `A2` invalid/conflict/untrusted variable has zero effect; `A3` one undo removes creation and recovery can replay/restore; `A4` settings persist edited templates.
- **Required evidence:** `code-audit`, `unit`, `browser`, `native`, `typecheck`.
- **References:** historical `BB9`, `N11.1`, `N13.5`; IDEA [Auto import](https://www.jetbrains.com/help/idea/optimizing-imports.html).
