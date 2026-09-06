# R9 native gate — Windows runbook (§8.19.10).
#
# Prereqs:
#   * tauri-driver (cargo install tauri-driver --locked)
#   * msedgedriver.exe matching the installed WebView2 runtime, on PATH or
#     set in qa-ui-auto.config.yaml under webdriver.native_driver
#   * JDK + jdtls on PATH for provider cases
#
# The runner redirects APPDATA/LOCALAPPDATA for the launched binary into the
# run report dir, so the developer profile is never touched.
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Join-Path $PSScriptRoot "..\..\..")

Write-Host "== [1/3] build packaged debug app =="
python .agents/skills/qa-ui-auto/scripts/native_build.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== [2/3] run native cases =="
$Cases = $env:CASES
if (-not $Cases) { $Cases = "TC-NATIVE-CORE-001" }
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
$QaConfig = if ($env:QA_CONFIG) { $env:QA_CONFIG } else { ".agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml" }
python -m qa_ui_auto.runner --mode native --require-pass --filter $Cases --config $QaConfig
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== [3/3] evidence entries =="
# Read case results from qa-ui-auto-report/run-*/summary.json
# and emit one entry per item, e.g.:
#   python .agents/skills/qa-ui-auto/scripts/evidence_collect.py `
#     --case TC-IDE-C0-01 --gate G0 --result passed `
#     --command "python -m qa_ui_auto.runner --mode native --filter TC-IDE-C0-01" `
#     --artifact <run-dir>/summary.json --scale 100%
# Repeat with --layout <non-US layout> and --ime <IME> for G1 matrix items,
# and once at 200% scale.
Write-Host "Manual evidence_collect.py invocations required (see README.md)."
