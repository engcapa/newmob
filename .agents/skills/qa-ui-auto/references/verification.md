# Selection, Coverage And Runtime

## Daily Work

Use affected unit/component tests and browser cases for pure renderer changes.
Add selected native cases when IPC payloads, persistence, processes, native APIs,
WebView behavior or OS integration can change, including frontend callers.
Run affected Rust integration tests for backend logic and local test services.

`plan --diff REF` includes committed and local changes. Feature file ownership
selects cases; shared/unmapped code broadens selection. Changed YAML is included.
`--tag smoke` limits the scope before planning; omit it for full affected coverage.
`--feature F.x` selects a feature. These are recommendations, not a dependency
graph or proof that unmapped code is covered. Native-only cases remain in mapped
feature plans even when shared cases run in browser.

Use native runbooks for Windows/Linux. The macOS runbook builds only: execute and
record actual WKWebView/OS scenarios separately. CI browser jobs explicitly select
browser mode; running Chromium on three hosts is not native platform coverage.

## What Was Actually Tested

`status --json` reports all catalog features, including those with zero YAML
cases. Each case records review state and browser/native execution cells.
`needs-review` and `legacy-imported` require assertion review; removing a tag is
not itself verification. Optional controls and selector touches are static
inventory, independent of execution success.

Status accepts runner summaries only with an execution marker and a matching
receipt. Dry-runs, legacy reports lacking provenance and modified summaries are
not current execution proof. Current means matching source, runner and case
fingerprints with stable inputs during execution. Native additionally requires a
QA ID and matching build-source fingerprint. A legacy QA binary may still run,
but cannot establish current-source coverage until rebuilt.

For each source/case/mode/OS, the latest current run wins, including failures and
skips; an older pass must not conceal a newer failure. Browser results prove a
Chromium workflow on the recorded host. Native cells distinguish all three OS
targets; unsupported automation remains an explicit gap.

Content identities include uncommitted and untracked non-ignored inputs, not
only Git HEAD. Text LF/CRLF differences are normalized for cross-platform Git
checkouts; binaries retain byte identities. Non-secret execution configuration
is also bound. `status --config PATH` supplies expected conditions for imported
reports; otherwise their recorded config path must still exist in this checkout.
Secret values are not persisted or treated as scenario identity. Source identities
conservatively cover repository production sources; unrelated
production-source changes can make results stale. Keep identical source checkouts
when merging platform reports. Local receipts provide provenance/integrity checks,
not protection against an actor with repository write access. Verify a reused
Vite server serves this checkout; its URL alone cannot prove that.

## Release Review

Use three independent results:

- `audit --gate`: YAML/schema, catalog freshness and static coverage ratchet.
- `status --gate --tag p0 --platform Windows,Linux`: reviewed current passing YAML
  executions for the explicitly selected platforms. Remove `--tag` for all cases.
  No selected cases fails. Skips, missing/stale evidence and review gaps fail;
  no passing percentage can hide a required case.
- `audit --release-evidence`: existing validated manual/native/performance release
  manifest. This includes the static gate and does not turn manual entries into
  automated YAML passes.

Inspect status without a tag too: P0 classification does not guarantee that every
product capability has a case. Agree release scope from affected and critical
user workflows. Include failure/recovery and persistent postconditions; asserting
that a control was clicked is insufficient.

Combine platform artifacts with repeated `--reports <root-or-summary.json>`.
Keep release reports outside rotating daily runs, e.g.
`run --report-dir qa-ui-auto-report/release-<id> --keep-runs 0`. Retain the entire directory;
summary.json without its receipt cannot establish execution. Neither Linux nor
Windows nor browser WebKit substitutes for macOS native evidence.

## Runtime And Performance

Runner reports include per-step durations and setup/fixture/cleanup timings.
Use those to distinguish slow automation from slow product behavior. Browser
workers reuse processes with fresh contexts; native cases keep separate sessions
and share only the batch driver. Native failures capture the original session.
Successful browser traces are discarded; failure traces and requested screenshots
are retained. Profile directories are excluded from receipt artifact hashing.

`timeout_sec` is a monotonic execution budget checked around fixtures/steps and
applied to Playwright waits, WebDriver requests and native polling sleeps. This
is cooperative cancellation, not a hard process kill: an OS fixture, synchronous
JavaScript or external helper may finish its bounded operation before control
returns. Artifact collection and host-state cleanup have separate allowances.
Do not use a hard kill that bypasses host permission/clipboard cleanup.

`native_build.py` reuses a verified binary only when recorded source, recipe,
platform, compiler, Node and relevant environment inputs match. `--force` rebuilds.
Keep QA identity and storage isolation even during fast iteration.

Measure application performance only for affected hot paths. Use matching
hardware, OS/WebView, dataset and build profile with explicit warmup, raw samples
and previously measured noise. `perf_baseline.py --baseline PATH --noise-ms N`
compares the Chromium renderer proxy under matching conditions and fails on
regression or absolute-budget violations. Without a baseline, only the absolute
budget is checked; no-regression is unverified. Native release latency/resource
measurements remain separate from browser and automation timings.
