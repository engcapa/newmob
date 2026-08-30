# Performance Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). Correct behavior takes precedence over performance. Timings are evidence only when the runner, fixture, warmup, sample set, percentile method, and raw artifact are recorded.

<a id="ed-perf-001"></a>
## ED-PERF-001 Stable Props And CodeMirror Reconfiguration

- **User outcome:** typing and parent renders do not trigger redundant store writes or expensive editor compartment reconfiguration.
- **Audit:** `implemented`. Production stabilizes empty/status values and compares extension inputs, with focused counters; historical evidence has no reproducible before/after performance samples.
- **Contract:** semantically unchanged state is a no-op; identity stabilization cannot hide changed diagnostics/style/provider state.
- **Acceptance:** `ED-PERF-001-A1` equal writes/renders reconfigure zero times; `A2` real semantic changes reconfigure once; `A3` recorded before/after typing samples show no regression on defined fixture.
- **Required evidence:** `code-audit`, `unit`, `performance`, `build`.

<a id="ed-perf-002"></a>
## ED-PERF-002 Hidden Workspace Git/LSP Activity

- **User outcome:** hidden workspaces stop avoidable polling/detection while visible workspaces and same-repo deduplication stay responsive.
- **Audit:** `implemented`. Production hooks gate visibility, share cache/in-flight work, and focused call-count tests pass; the repository build gate is red.
- **Contract:** hide cancels or suppresses publication; show refreshes stale data; shared repo cache never crosses credentials/workspace identity incorrectly.
- **Acceptance:** `ED-PERF-002-A1` hidden polling/detection call count is zero after shutdown; `A2` same repo deduplicates in-flight/cache; `A3` show/manual refresh and slow cancel publish only current results.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-perf-003"></a>
## ED-PERF-003 Active-First Restore And Visible-File Diff

- **User outcome:** a workspace restores active files first, bounds background reads, and avoids diff work for invisible files.
- **Audit:** `ready`. Restore planning/queue are production-wired, but `workspaceRestoreModel.ts` imports a missing `workspaceLayoutSnapshot` module and its test has an unused import, so the build fails before the required 20-40 tab/large-file TTI evidence.
- **Contract:** every leaf active file precedes inactive tabs; concurrency stays 2-4; fast switch can promote; failures do not block remaining restore; diff cache keys path/HEAD/text version.
- **Acceptance:** `ED-PERF-003-A1` deterministic plan honors active-first and concurrency; `A2` failure/fast-switch/large-file degradation is correct; `A3` measured 20-40 tab TTI and visible-only diff meet documented budget.
- **Required evidence:** `code-audit`, `unit`, `performance`, `build`.

<a id="ed-perf-004"></a>
## ED-PERF-004 Buffer Authority Migration ADR And Baseline

- **User outcome:** a reviewable migration plan moves live text authority toward CodeMirror without data loss or an unmeasured performance premise.
- **Audit:** `ready`. The ADR exists, but its 1 MB/5 MB latency, allocation, and IPC numbers are asserted ranges without runner commands/raw artifacts; required current baselines were not actually captured.
- **Scope:** correct the ADR with reproducible baseline evidence, invariants, phased tests, feature gate, and rollback. Production migration remains separate future tasks.
- **Contract:** distinguish measured data from target/estimate; define shared-document, save, LSP, Git, undo, crash recovery, and snapshot invariants at every phase.
- **Acceptance:** `ED-PERF-004-A1` 1 MB/5 MB current baselines are reproducible with raw samples; `A2` ADR labels measured/target values; `A3` each phase has correctness/performance gates and rollback triggers.
- **Required evidence:** `document`, `code-audit`, `performance`.
- **References:** [`code-workspace-performance-todo.md`](../code-workspace-performance-todo.md), [`adr-buffer-authority-migration.md`](../adr-buffer-authority-migration.md).
