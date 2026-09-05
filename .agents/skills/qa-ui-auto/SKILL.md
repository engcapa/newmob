---
name: qa-ui-auto
description: "Test Taomni UI workflows, audit coverage and change impact, maintain YAML cases and feature/control catalogs, or explore UI failures. Prefer real native Tauri testing with an isolated QA application identity; assess performance regressions and Linux, macOS, and Windows compatibility. Use for qa-ui-auto, UI smoke/regression testing, testcase YAML, and qa-ui-auto-tests maintenance."
---

# Taomni UI E2E

Exercise observable user workflows and retain reproducible evidence. Application
logic already has unit tests; prioritize the real Tauri app, Rust IPC, filesystem,
clipboard, dialogs, keyboard/IME, and platform WebView. Browser tests provide
quick diagnosis and supplementary renderer coverage.

## Requirements

- **Performance must not regress.** Compare affected paths before/after on the
  same OS, hardware, build profile and dataset. Keep existing budgets and raw
  evidence for latency (especially p95) and relevant resource usage. A reproducible
  slowdown beyond established measurement noise is a regression even within an
  absolute budget. Never relax budgets, discard slow samples or replace a baseline
  merely to pass. Missing measurements are unverified, not a pass.
- **Consider Linux, macOS and Windows.** Check WebView differences, Ctrl/Meta
  shortcuts, IME, paths/case sensitivity, permissions, clipboard, dialogs and window
  behavior where affected. Report each platform as native-tested, browser-only or
  unverified, with a concrete reason. One OS or Chromium run cannot prove all three.
- **Prefer native testing on a real target OS.** Add native coverage where the
  driver and verbs support the workflow. Explain browser fallback when tooling or
  a target machine is unavailable, retaining the native gap. macOS lacks Tauri
  WebDriver support; use available OS automation or recorded manual native testing.
  Unit tests and browser stubs cannot replace native integration evidence.
- **Native tests must use an independent application ID.** Build with
  `com.taomni.app.qa`, never launch the production `com.taomni.app` binary for QA.
  Environment overrides or renaming an executable are insufficient. The QA build
  helper records the ID and binary hash; the harness checks them before launch.
  Also isolate data/config/cache and fixture workspaces. Never reset production
  profiles, credentials, user files or system configuration. Read
  [native-testing.md](references/native-testing.md) before any native launch.

## Minimal Workflow

Choose the user's scope, then run or edit directly. Diagnostics are conditional;
there is no required `audit -> fix -> lint -> dry-run -> run -> audit` chain.

From the repository root, set the module path once:

```bash
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
# PowerShell: $env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
```

Two routine entry points:

```bash
python -m qa_ui_auto audit --diff          # health, gaps and change impact
python -m qa_ui_auto run --filter TC-117   # selected cases, native by default
```

`audit` accepts `--feature F.x`, `--diff REF`, `--gate`, and `--json`. It combines
schema/feature lint, control coverage, orphan selectors, catalog freshness,
optional diff impact and the CI baseline gate without editing files. Use it to
choose affected cases, diagnose gaps or verify catalog changes. Fix correctness
errors before coverage gaps. Its `fix ...` suggestions are optional context
helpers, not mandatory stages or standalone shell commands.

`run` accepts `--tag smoke,p0`, `--mode browser`, `--config PATH`, `--cases DIR`,
`--workers N`, `--headed`, and `--dry-run`. It validates YAML itself; do not repeat
lint and dry-run before each execution. Native runs are sequential; independent
browser cases may use workers. Dry-run checks syntax/verbs and is never execution
evidence. Direct module commands such as `qa_ui_auto.runner` keep their existing
config-driven mode for CI compatibility; the new `run` entry defaults to native.

- **Execute:** read the selected cases/config, prepare only their dependencies,
  run once and inspect the report. Secrets come from environment variables. Reuse
  healthy local services; start scoped local test services when needed within the
  request without an unnecessary approval round trip. Browser fallback needs
  Vite (`pnpm dev`); SSH/SFTP bridge tests also require
  `DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1` on that server.
- **Add or repair coverage:** read [authoring.md](references/authoring.md) and
  relevant [verb-catalog.md](references/verb-catalog.md) entries. Edit related
  cases/features/controls together and run affected cases. Regenerate the catalog
  only if controls changed; audit once after the batch. Ratchet only verified
  coverage improvements, never hide losses. Optional maintenance tools remain
  available in the authoring reference.
- **Explore:** drive the selected feature in native mode where possible, checking
  observable postconditions, screenshots and console/backend errors. Browser
  fallback uses available Playwright tools or
  [playwright-cli.md](references/playwright-cli.md). Default bound: 10 minutes or
  200 actions, whichever comes first; honor explicit user scope. Write repros,
  anomalies, platform/mode and evidence paths to
  `qa-ui-auto-report/exploratory-<timestamp>.md`. Add regression YAML when repair
  or coverage work is requested; exploration alone does not require case edits.

Select affected cases first, reuse builds only when source/configuration match,
and use condition-based waits. Do not reduce assertions or coverage to save time.
Rerun affected failures after a concrete fix or diagnosed environment recovery;
preserve the first failure and avoid blind retries. Broaden to smoke/full coverage
when shared behavior, release scope or remaining risk warrants it.

## Evidence And Completion

The runner writes `qa-ui-auto-report/run-<timestamp>/summary.json`, `summary.md`,
JUnit, case artifacts and execution receipts. `summary.json` is the result
contract. A failed step stops that case; remaining cases continue. Exit codes:
`0` no failed cases, `1` test failure, `2` setup/config error. Inspect skips and
selected-case counts: exit 0 alone does not prove completion.

Report scope, platform/mode, native QA app ID, pass/fail/skip counts, relevant
performance comparison and unverified platforms/behaviors. Failures need the
first failing step, available screenshot/log paths and repro. Native failure
screenshots currently come from a fresh session; disclose that limitation.
Retain required evidence before report rotation removes old runs.

Coverage gates prove selector/verb coverage, not visual fidelity, performance,
accessibility or localization. Use targeted screenshots, geometry, keyboard/IME
checks and measurements when relevant; describe their actual scope. There is no
automatic universal visual/viewport/a11y/performance matrix. See
[native-testing.md](references/native-testing.md) for isolation, platform setup
and performance methods, including existing measurement-tool limitations.
