#!/usr/bin/env bash
# R9 native gate — Linux runbook (§8.19.10).
# Builds the packaged debug app, runs native-mode gate cases through
# tauri-driver with isolated app-data, then emits sanitized evidence entries.
#
# Prereqs: tauri-driver (cargo install --locked), WebKitWebDriver, JDK on PATH
# for provider cases; a real X11/Wayland session (no headless — this drives
# the actual app).
set -euo pipefail
cd "$(dirname "$0")/../../.."

echo "== [1/4] build packaged debug app =="
pnpm tauri build --debug --no-bundle

echo "== [2/4] preflight =="
command -v tauri-driver >/dev/null || { echo "tauri-driver missing: cargo install tauri-driver --locked"; exit 2; }
command -v WebKitWebDriver >/dev/null || { echo "WebKitWebDriver missing (libwebkit2gtk tools)"; exit 2; }

echo "== [3/4] run native cases (app-data isolated by the runner) =="
# The runner redirects XDG_DATA_HOME/XDG_CONFIG_HOME into the run report dir,
# so the launched binary never touches the developer profile.
CASES="${CASES:-TC-IDE-C0-01}"
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner \
  --mode native --filter "$CASES"

echo "== [4/4] evidence entries =="
RUN_DIR=$(ls -td qa-ui-auto-report/run-* | head -1)
for CASE in ${CASES//,/ }; do
  RESULT=$(python3 - "$RUN_DIR" "$CASE" <<'PY'
import json, sys, pathlib
run, case = sys.argv[1], sys.argv[2]
s = json.loads((pathlib.Path(run) / "summary.json").read_text())
r = next(r for r in s["results"] if r["id"] == case)
print({"passed": "passed", "failed": "failed", "skipped": "environment-blocked"}[r["status"]])
PY
)
  ARTIFACT="$RUN_DIR/$CASE/summary.json"
  [ -f "$ARTIFACT" ] || ARTIFACT="$RUN_DIR/summary.json"
  FS_PATH=$(ls -dt qa-ui-auto-report/native-workspaces/${CASE}-* 2>/dev/null | head -1 || echo "$HOME")
  python .agents/skills/qa-ui-auto/scripts/evidence_collect.py \
    --case "$CASE" --gate G0 --result "$RESULT" \
    --command "python -m qa_ui_auto.runner --mode native --filter $CASE" \
    --artifact "$ARTIFACT" --fs-path "${FS_PATH:-$HOME}" \
    --gap "single layout run; add non-US layout + IME + 200% scale runs for the full matrix"
done

echo "Done. Entries in qa-ui-auto-report/evidence/ ; roll up into qa-ui-auto-tests/native/manifest.template.md copies."
