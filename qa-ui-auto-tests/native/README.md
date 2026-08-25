# Native release gates (§8.19.10 R9)

This directory holds the **sanitized, committed** side of the R9 native gate:
templates, runbooks, and this README. Actual run evidence (screenshots,
console dumps, per-item entries) is written to `qa-ui-auto-report/evidence/`
(gitignored) — only sanitized manifests/templates may be committed.

## What counts as an evidence entry

Every gate item records **all** of the following (template:
`evidence-entry.template.yaml`, collector: `.agents/skills/qa-ui-auto/scripts/evidence_collect.py`):

| Field | Meaning |
|---|---|
| `commit` / `app_sha256` | git commit the binary was built from + binary hash |
| `os` / `webview` / `arch` | e.g. Linux 6.14 / WebKitGTK 2.48 / x86_64 |
| `keyboard_layout` / `ime` | `setxkbmap -query` layout + IME name (or "none") |
| `display_scale` | 100% / 200% |
| `filesystem` | fs type hosting the workspace root |
| `jdk` / `jdtls` / `build_tool` | pinned provider versions (provider items only) |
| `command` | exact command(s) executed |
| `result` | passed / failed / environment-blocked — never invented |
| `artifact_sha256` | hash of the saved artifact backing the result |
| `known_gaps` | anything not covered by this run |
| `highest_claim` | max L0–L3 claim this evidence supports |

Honest-evidence rules (unchanged from §8.19.3): a fixture/provider failure is
`environment-blocked`, never a stub pass; mock providers only back fault
branches and can never substitute for at least one real process trace.

## Per-platform runbooks

- Linux: `runbooks/run-native-linux.sh` (this machine can execute it)
- Windows: `runbooks/run-native-windows.ps1`
- macOS: `runbooks/run-native-macos.sh`

Each runbook builds the packaged debug app (`tauri build --debug --no-bundle`),
launches it through `tauri-driver` with **isolated app-data** (never the
developer profile), runs the native-mode cases
(`python -m qa_ui_auto.runner --mode native --filter TC-IDE-C0-01,…`), then
collects one evidence entry per case via `evidence_collect.py`.

## Matrix status

Items not yet run on a platform stay `platform-unverified`; provider items
without a real jdtls trace stay `provider-unverified`. See
`claudedocs/code-workspace-ide-design.md` §8.19.10 for the authoritative
as-built ledger.
