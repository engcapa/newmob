---
name: qa-ui-auto
description: "Run end-to-end UI automation tests against the NewMob Tauri desktop app (cross-platform Linux, macOS, Windows). Drives the app via playwright-cli plus Python orchestration scripts. Use when the user asks to run UI tests, do E2E testing, automate the GUI, verify a feature end-to-end, regression test the SSH/SFTP/terminal flows, or mentions qa-ui-auto, testcase-for-auto.md, or automated UI test. Test cases are read from testcase-for-auto.md at the project root. SSH/SFTP servers and other test fixtures are read from qa-ui-auto.config.yaml."
---

# qa-ui-auto — NewMob UI E2E Automation

## When to use

Trigger this skill whenever the user asks for any of:

- "Run UI tests", "E2E test", "automate the GUI", "smoke test the app".
- Verifying SSH connect / SFTP browse / file transfer / terminal flows end-to-end.
- Running cases defined in `testcase-for-auto.md`.
- Any mention of `qa-ui-auto`, `playwright-cli`, or "test the Tauri UI".

This skill is designed to run inside coding-agent CLIs (Claude Code, Codex, etc.). It must remain non-interactive and exit non-zero on failure so the agent can react.

## Architecture & rationale

NewMob ships in two runnable forms (see `replit.md` and the tech doc):

1. **Browser dev mode** — start Vite on port `5000` with `DEV_PROXY_ALLOW_PRIVATE=1` and `ALLOW_PRIVATE_TARGETS=1` (PowerShell: `$env:DEV_PROXY_ALLOW_PRIVATE="1"; $env:ALLOW_PRIVATE_TARGETS="1"; pnpm run dev`, cmd.exe: `set DEV_PROXY_ALLOW_PRIVATE=1 && set ALLOW_PRIVATE_TARGETS=1 && pnpm run dev`, macOS/Linux: `DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm run dev`). Vite serves the React UI and the `sshProxy` / `sftpProxy` plugins implement the SSH/SFTP backend in Node, with `src/stubs/*` shimming the Tauri APIs. This mode is **headless-CI-friendly** and is the primary target for automation: a real browser drives the same React UI shipped in the desktop binary.
2. **Native Tauri WebDriver mode** — `pnpm tauri build --debug --no-bundle` (or `cargo tauri build --debug --no-bundle`) then drive the real debug binary through `tauri-driver`. This mode tests the actual native WebView and Tauri/Rust IPC backend. On Windows it requires `msedgedriver.exe` matching the installed Edge/WebView2 runtime; on Linux it requires `WebKitWebDriver` and a display. macOS desktop WebDriver is not supported by Tauri because WKWebView has no desktop WebDriver tool.

Default mode is `browser`. Use `--mode native` when the user explicitly asks to test real Tauri rendering, Rust commands, or native backend behavior.

The reason we use `playwright-cli` (not the Playwright test runner) is token efficiency: the coding agent can issue concise CLI commands without loading the Playwright API surface or accessibility trees. See `references/playwright-cli.md` for the command cheatsheet.

## Layout

```
.agents/skills/qa-ui-auto/
├── SKILL.md                      ← this file
├── scripts/
│   ├── run_tests.py              ← entry point; orchestrates lifecycle + reporting
│   ├── parse_testcases.py        ← parses testcase-for-auto.md into steps
│   ├── env_check.py              ← verifies node/pnpm/playwright-cli/python deps
│   ├── probe.py                  ← detects missing services and prints how to start them
│   ├── tauri_webdriver.py        ← minimal W3C WebDriver client for native Tauri
│   └── fixtures.py               ← spins up local SFTP/SSH if config requests it
├── assets/
│   ├── testcase-for-auto.template.md  ← template for separately creating test cases
│   └── qa-ui-auto.config.example.yaml
└── references/
    ├── playwright-cli.md         ← command cheatsheet
    └── selectors.md              ← stable selectors for NewMob UI
```

Test cases and config live at the **project root**, not inside the skill, so users can edit them:

- `testcase-for-auto.md`        — the test case file, generated separately before running this skill
- `qa-ui-auto.config.yaml`      — server endpoints + credentials (gitignored)
- `qa-ui-auto-report/`          — reports, screenshots, traces (gitignored)

## Workflow (always follow this order)

1. **Preflight tooling.**
   - Browser mode: run `python .agents/skills/qa-ui-auto/scripts/env_check.py --mode browser`. It checks/installs:
     - `node >= 18`, `pnpm`, project deps (`pnpm install` if missing).
     - `playwright-cli` globally: `npm install -g @playwright/cli@latest` if `playwright-cli --version` fails.
     - Browsers: `playwright-cli install chromium`.
     - Python deps: `pyyaml`. Install with `pip install pyyaml` if missing.
   - Native mode: run `python .agents/skills/qa-ui-auto/scripts/env_check.py --mode native`. It checks only; it does not install automatically. It verifies `cargo`, `tauri-driver`, the Tauri debug binary, and platform WebDriver dependencies. If `tauri-driver` is missing, ask the user whether to run `cargo install tauri-driver --locked`. If the debug binary is missing, ask whether to run `cargo tauri build --debug --no-bundle` (or `pnpm tauri build --debug --no-bundle`). On Windows, `msedgedriver.exe` must be on PATH or configured as `webdriver.native_driver`; do not auto-install it because it must match the local Edge/WebView2 runtime.
2. **Load config.** Read `qa-ui-auto.config.yaml`. If absent, copy the example and tell the user which fields to fill in (host/port/user/password or key path for SSH, SFTP). Never invent credentials. If the user supplies secrets in chat, write them via the environment-secrets skill, not the YAML, and reference them as `${env:VAR_NAME}`.
3. **Load `testcase-for-auto.md`.** This skill does not generate or modify test cases. If the file is missing, stop and tell the user to generate it separately before running automation.
4. **Probe required services.** `run_tests.py` automatically calls `probe.py` after parsing test cases. The probe checks only what the active cases need:
   - Browser mode → Vite dev server reachable at `app.base_url`, started with `DEV_PROXY_ALLOW_PRIVATE=1` and `ALLOW_PRIVATE_TARGETS=1`.
   - Native mode → Tauri debug binary built; `tauri-driver` available; platform WebDriver available; on Linux, a `DISPLAY` is set.
   - SSH/SFTP host:port reachable (only if any case references `${cfg:ssh.*}` or `${cfg:sftp.*}`).
   - Tooling (`pnpm`, `playwright-cli`) on PATH for browser mode; `tauri-driver` and platform WebDriver tooling for native mode.
   When something is missing, the probe prints a short, copy-pasteable startup recipe and `run_tests.py` exits with code `2` **without** running any tests. You can also probe manually: `python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser`.
   When the user reports the probe failing, do not silently start services for them — surface the printed recipe verbatim and ask whether to start the listed workflow / Docker container.
5. **Run.** `python .agents/skills/qa-ui-auto/scripts/run_tests.py --mode browser` or `python .agents/skills/qa-ui-auto/scripts/run_tests.py --mode native`. The browser runner:
   - Parses `testcase-for-auto.md` into ordered cases and steps.
   - For each case, opens a fresh browser context: `playwright-cli open http://localhost:5000 --user-data-dir qa-ui-auto-report/profile-<case>`.
   - Executes each step as a `playwright-cli` command (`click`, `type`, `press`, `expect`, `screenshot`).
   - On failure, captures a screenshot, DOM snapshot, page console logs, the injected page console buffer, and page HTML into `qa-ui-auto-report/<case>/`.
   - Writes `qa-ui-auto-report/summary.json` and a Markdown summary.
   The native runner starts or connects to `tauri-driver` at `webdriver.host:webdriver.port`, creates one Tauri WebDriver session per case with `tauri:options.application`, drives the real native WebView through W3C WebDriver, captures screenshots through WebDriver, and writes the same report format.
6. **Report.** Print the Markdown summary to stdout. Exit non-zero if any case failed so the parent agent loop can react.
7. **Failure artifacts.** For every failed case, inspect and report the artifacts listed under that failed step in `summary.md`.
   - Browser mode captures failure screenshot, DOM snapshot, console output from `playwright-cli console` at default/info/warning/error levels, an in-page console buffer JSON (`console.log/info/warn/error/debug`, `window.error`, `unhandledrejection`), and page HTML where available.
   - Native mode captures failure screenshot, page HTML, a JSON file containing the injected in-page console buffer (`console.log/info/warn/error/debug`, `window.error`, `unhandledrejection`) and basic runtime state such as `window.__TAURI__` availability.
   - Native mode also lists `tauri-driver.out.log` and `tauri-driver.err.log` in the run artifacts. Treat these as backend/native-driver logs; Tauri/Rust process output normally flows through the driver-launched process. If the Rust app exits early or WebDriver cannot create a session, surface the tail of these logs in the final answer.

## Test case format (`testcase-for-auto.md`)

Each case is a `## TC-<id>: <title>` heading followed by metadata and a numbered step list. Steps use a tiny DSL the parser understands — one verb per line:

```
## TC-001: Launch and render main window
- tags: smoke, p0
- mode: browser

1. open http://localhost:5000
2. expect_visible role=tablist
3. expect_visible text="Local Terminal"
4. screenshot launch.png
```

Supported verbs (see `scripts/parse_testcases.py` for the authoritative list): `open`, `goto`, `click`, `dblclick`, `type`, `press`, `fill`, `select`, `wait`, `wait_for selector=...`, `expect_visible`, `expect_text`, `expect_url`, `screenshot`, `eval`, `sleep`. Selectors accept Playwright syntax (`role=button[name="Connect"]`, `text="Open"`, CSS, `data-testid=...`).

For SSH/SFTP/terminal interactions that need credentials, reference config keys with `${cfg:ssh.host}` etc. The parser substitutes them before dispatch.

## Config (`qa-ui-auto.config.yaml`)

The full schema and examples live in `assets/qa-ui-auto.config.example.yaml`. Copy that file to the project root as `qa-ui-auto.config.yaml` and fill in the fields needed by the selected test cases.

Do not duplicate the config schema in this skill document. Keep configuration details in the example asset so there is a single source of truth.

## Cross-platform notes

- **Linux (CI / Replit):** browser mode runs headless Chromium fine. Native mode needs `tauri-driver`, `WebKitWebDriver`, and Xvfb or the existing `VNC Server` workflow up.
- **macOS:** browser mode is supported. Tauri desktop WebDriver is not available because WKWebView has no desktop WebDriver tool.
- **Windows:** native binary is `.exe`; native mode requires `tauri-driver` plus `msedgedriver.exe` matching Edge/WebView2.
- The runner detects the platform with `platform.system()` — never hard-code paths.

## Failure handling

- Treat first failing step in a case as fatal for that case but continue with remaining cases.
- Always exit `1` if any case failed, `0` if all passed.
- On any unexpected exception, dump traceback into `qa-ui-auto-report/error.log` and surface its tail in stdout.

## Maintenance

- Keep `references/selectors.md` in sync when UI components rename their `data-testid`s. The runner depends on these — if you change a component, update the reference file in the same change.
- Don't add new verbs to the DSL without updating both `parse_testcases.py` and the verb list in this SKILL.md.
