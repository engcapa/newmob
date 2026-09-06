---
name: qa-ui-auto
description: "Plan and run Taomni UI verification, inspect actual execution coverage, maintain YAML cases and feature/control catalogs, or investigate UI failures. Choose browser or isolated native tests by the affected behavior and report Windows, Linux and macOS evidence separately."
---

# Taomni UI Verification

Exercise observable user workflows and retain reproducible evidence. Choose the
cheapest layer that proves the requested behavior: browser for renderer behavior,
unit/Rust integration tests for logic and services, selected native cases for IPC,
disk, processes and OS boundaries. A native mode declaration is not proof of
execution, platform compatibility or OS-level input.

## Essential Constraints

- Native runs use the independently built `com.taomni.app.qa` application and
  isolated data/config/cache and fixture workspaces. Environment overrides or
  renamed production binaries cannot establish the QA identity. Never reset
  production profiles, credentials or personal projects. Read
  [native-testing.md](references/native-testing.md) before any native launch.
- Native verification is needed for affected IPC, persistence, PTY/LSP processes,
  clipboard, dialogs, shortcuts/IME, permissions and windows. A frontend change
  can still affect these boundaries. Browser stubs cannot prove them.
- Consider Windows/WebView2, Linux/WebKitGTK and macOS/WKWebView where affected.
  Native on one OS or Chromium on three hosts cannot prove all three. macOS has
  no Tauri WebDriver adapter; use available OS automation or recorded manual QA.
  Keep missing targets and unsupported verbs explicit.
- Measure performance when changes affect startup, input/rendering, large data,
  search, transfers or background work. Compare matching baseline/candidate
  conditions and retain raw samples, p95 and relevant resource measurements.
  Never hide slow samples or relax budgets to pass. Without a matching baseline,
  no-regression is unverified. Unrelated UI/metadata edits need no performance suite.

## Routine Work

Set the module path from repository root:

```bash
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
# PowerShell: $env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
```

```bash
python -m qa_ui_auto plan --diff HEAD --tag smoke
python -m qa_ui_auto run --mode browser --filter TC-001
python -m qa_ui_auto run --mode native --filter TC-NATIVE-CORE-001
python -m qa_ui_auto status --feature F25.5
python -m qa_ui_auto audit --gate
```

Choose the user's scope and run or edit directly; these commands are not a
mandatory sequence. `plan` is read-only and recommends cases from changed YAML,
feature owners and shared/unmapped code. `--tag smoke` limits scope; it is not
full affected coverage. Inspect native gaps and unmapped files before execution.

`run` defaults to browser. The direct `qa_ui_auto.runner` remains config-driven;
CI must select mode explicitly. `--workers N` reuses browser processes with fresh
contexts; native cases are sequential. `--require-pass` fails selected skips.
`--report-dir` separates release evidence; `--keep-runs 0` disables its rotation.
Unknown/unavailable requested IDs fail before launch. `--dry-run` checks verbs
and syntax only, emits no execution receipt, and never proves behavior.

Prepare only selected dependencies and reuse healthy local services. Browser
needs Vite (`pnpm dev`); SSH/SFTP bridges also require `DEV_PROXY_ALLOW_PRIVATE=1
ALLOW_PRIVATE_TARGETS=1`. Start scoped local fixtures within the authorized task;
use environment variables for secrets. Verify a reused server serves this checkout.
Run affected failures again only after a concrete fix or diagnosed recovery.
Keep the first failure. Broaden coverage for shared behavior or release scope.

For case/control changes, read [authoring.md](references/authoring.md) and the
relevant [verb-catalog.md](references/verb-catalog.md) entries. Assert user results,
including failure/recovery and disk postconditions where relevant. Update related
cases/features/controls together; regenerate the catalog only when controls change.
Audit after the batch; ratchet only reviewed and verified improvements.

Exploration uses the layer appropriate to the feature, with observable outcomes,
screenshots and console/backend errors. Default bound: 10 minutes or 200 actions;
honor explicit scope. Write repros, anomalies, platform/mode and evidence paths to
`qa-ui-auto-report/exploratory-<timestamp>.md`. Exploration alone requires no case
edits. Browser tooling guidance: [playwright-cli.md](references/playwright-cli.md).

## Evidence And Completion

`summary.json` is the runner contract: pass/fail/skip counts, selected IDs, source
and case identities, platform/mode and phase/step durations. Exit codes are 0 for
successful checks, 1 for failure (including required skips or changing inputs),
2 for setup/configuration errors. Inspect skips and counts; exit 0 alone is not
completion. Native failures capture the original session before cleanup; disclose
missing artifacts when the driver cannot respond.

`audit --gate` checks static schema/catalog/coverage. `status` separately reports
written, reviewed and actual passed/failed/skipped/stale/unverified executions.
`status --gate` requires reviewed current passes in the selected scope.
`audit --release-evidence` additionally validates the existing release manifest.
Read [verification.md](references/verification.md) before interpreting release
coverage, combining reports or claiming a performance improvement.

Report scope, platform/mode, QA app ID, pass/fail/skip counts, performance evidence
when relevant and remaining gaps. Selector coverage does not prove visual fidelity,
a11y, localization or performance. Use targeted geometry, screenshots and input
checks where relevant. No universal visual/viewport/a11y matrix is implied.
