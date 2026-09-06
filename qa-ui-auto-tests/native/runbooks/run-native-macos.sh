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
python .agents/skills/qa-ui-auto/scripts/native_build.py

echo "== [2/2] manual gate checklist =="
cat <<'EOF'
For each §8.19.10 matrix item, drive the packaged app by hand and record:
  python .agents/skills/qa-ui-auto/scripts/evidence_collect.py \
    --case <item-id> --gate <G0|G1|perf|a11y> \
    --platform macos --result <passed|failed> \
    --command "<what you did>" --layout <layout> --ime <ime> --scale <100%|200%> \
    --gap "<anything not covered>"

Use only the com.taomni.app.qa build and record its binary hash and source
identity. Use QA-owned data/config/cache and disposable workspaces. Do not
launch the production app or redirect HOME. Workflows sharing Keychain or
other host resources require a disposable OS account.
Building does not prove native execution. Record observable outcomes and
artifacts; browser evidence does not satisfy WKWebView/OS checks.
EOF
