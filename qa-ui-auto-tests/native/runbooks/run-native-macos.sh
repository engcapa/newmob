#!/usr/bin/env bash
# R9 native gate — macOS runbook (§8.19.10).
#
# KNOWN LIMITATION: tauri-driver does not support macOS (no WebDriver
# implementation for WKWebView). G1 keyboard/IME/a11y evidence on macOS is a
# MANUAL checklist: perform each gate interaction by hand on the packaged app,
# then record one entry per item with --result passed|failed. Automated
# browser-mode runs never substitute for this.
#
# The only automatable slice is the Rust fault harness + unit gates, which do
# not need the UI:
#   cargo test -p taomni --features hbase-kerberos workspace::
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "== [1/2] build packaged debug app =="
pnpm tauri build --debug --no-bundle

echo "== [2/2] manual gate checklist =="
cat <<'EOF'
For each §8.19.10 matrix item, drive the packaged app by hand and record:
  python .agents/skills/qa-ui-auto/scripts/evidence_collect.py \
    --case <item-id> --gate <G0|G1|perf|a11y> \
    --platform macos --result <passed|failed> \
    --command "<what you did>" --layout <layout> --ime <ime> --scale <100%|200%> \
    --gap "<anything not covered>"

App-data isolation note: the app writes to
~/Library/Application Support/com.taomni.app. To protect the developer
profile, either snapshot that directory first or set
QA_NATIVE_HOME_OVERRIDE to a scratch HOME before launching (invasive —
breaks Keychain; prefer the snapshot approach).
EOF
