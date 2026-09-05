# Native Testing, Isolation And Performance

## Build Once, Run Selected Cases

Use a separately built QA application even for manual native exploration.
`assets/tauri.qa.conf.json` overrides the identifier to `com.taomni.app.qa` and
product name to `Taomni QA`. Keep production Tauri configuration unchanged.
Environment overrides or renamed executables cannot change a compiled ID.

From the repository root (with the module path set as in SKILL.md):

```bash
python .agents/skills/qa-ui-auto/scripts/native_build.py
python -m qa_ui_auto run --filter TC-117
```

The helper builds with the QA overlay in `src-tauri/target/qa-ui-auto` and writes
`<binary>.qa-identity.json` with the ID and binary SHA-256 only after success.
The harness checks this record before starting the driver or fixtures; missing
records, production IDs and changed binaries are rejected. Never hand-author a
record for an existing production binary. This is build provenance to prevent
accidental profile reuse, not a signature against malicious substitutions.

The default binary is `src-tauri/target/qa-ui-auto/debug/taomni` (`taomni.exe` on
Windows). For release-profile measurements, build with `native_build.py --release`
and set `app.native_binary` in a dedicated config to the resulting release binary.
Keep its identity record adjacent. Reuse builds only when source/configuration
match the task: the binary hash cannot establish that newer edits were rebuilt.

The harness redirects Linux XDG data/config/cache or Windows AppData/LocalAppData
to this run, then restores its environment on exit. `reset_db` only clears QA
application state inside verified run roots. Native runs are sequential. The
driver must be started by this run to inherit isolation; an existing listener is
rejected. Configure free WebDriver and native-driver ports for independent jobs.

An independent ID does not isolate arbitrary files, hardcoded shared credential
service names, clipboard, global shortcuts or SSH targets. Use disposable
workspaces/accounts, inspect affected storage paths, preserve/restore supported
host state and disclose non-restorable effects. Never use personal projects or
credentials as mutation fixtures, redirect HOME, or erase a profile as a shortcut.

## Three Target Platforms

| Target | Native execution | Compatibility evidence |
|---|---|---|
| Linux | `tauri-driver`, `WebKitWebDriver`, an X11 desktop or Xvfb; X11-specific verbs need real dependencies | GTK/WebKitGTK, Ctrl shortcuts, case-sensitive paths/permissions, clipboard and IME |
| Windows | `tauri-driver` plus matching `msedgedriver.exe`/WebView2; set `webdriver.native_driver` if needed | Ctrl/Alt shortcuts, drive/UNC paths, locking/permissions, clipboard/dialogs, WebView2 |
| macOS | Tauri WebDriver unsupported; use available OS UI automation or recorded manual QA-app runs on macOS | Cmd/Meta shortcuts, WKWebView, IME, case sensitivity, permissions, clipboard/dialogs/window controls |

Linux/Xvfb exercises Tauri/WebKitGTK but cannot prove physical input, GPU,
compositor, IME or performance behavior for another desktop/device. For macOS
packaged/manual runs, verify `CFBundleIdentifier` and QA-owned data/config/cache/
keychain namespaces; use a disposable OS account for workflows sharing resources
outside them. Do not install over production. Browser WebKit is supplementary
renderer evidence, not a native WKWebView/IPC test.

Choose representative native workflows for each affected OS. When a host or
dependency is unavailable, retain available evidence and label missing targets
unverified with the remaining action. Do not invent YAML platform fields or
count Linux-only verbs as Windows/macOS executions.

## Performance Must Not Regress

Choose metrics for the changed behavior: startup/readiness, input response,
editor actions, terminal throughput, file/list/search latency, transfer throughput,
memory/CPU, long tasks or leaked processes. Reuse scenarios and budgets; an
unrelated documentation edit does not need a full application performance suite.

Record baseline/candidate revisions, OS/hardware/WebView versions, build profile,
dataset, warmup and sample count. Compare with matching conditions and repeated
samples; separate cold/warm runs and account for known variance. Keep raw samples,
p50/p95 and relevant resource measurements. Unexplained slow samples remain
evidence. Missing baselines/measurements are unverified; establish a baseline
before claiming no regression.

`native_editor_performance` records keydown-to-CodeMirror-DOM-mutation samples
and gates a supplied p95 budget. This renderer metric is not full OS-to-screen
latency. Compare `native-editor-performance.json` before/after as well as checking
the absolute budget. `assert_native_process_delta` detects Linux process leaks.

`scripts/perf_baseline.py --base-url URL` remains a Chromium editor diagnostic.
It excludes samples >=1000ms and returns 0 even over budget. Inspect counts and
verdicts; its exit code or filtered p95 cannot prove native performance or no
regression. Do not use those filtered measurements as the sole regression gate.

Functional success and performance success are separate. Reproducible slowdown
beyond measured noise fails the requirement even within an absolute budget.
Fix and rerun the affected scenario; never reset budgets/baselines to conceal it.
Keep collection focused and avoid permanent production hot-path instrumentation.
