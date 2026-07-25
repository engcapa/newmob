<#
.SYNOPSIS
  Unified launcher for the SocksCap Windows real-machine E2E tests.

.DESCRIPTION
  Interactively confirms the upstream/SSH/curl settings (as environment
  variables consumed by qa-ui-auto-tests/cases/_sockscap_env.py; defaults
  reproduce the original in-repo values), then lets you pick which test to run.

  Tests that drive the elevated helper (driver / multiprofile) will trigger a
  Windows UAC prompt — click Yes.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File scripts/run-sockscap-tests.ps1
#>
$ErrorActionPreference = "Stop"
$repo  = Split-Path -Parent $PSScriptRoot
$cases = Join-Path $repo "qa-ui-auto-tests\cases"

$settings = @(
  @{ Key = "QA_HTTP_PROXY_HOST";   Label = "HTTP proxy host";   Default = "10.1.0.80" }
  @{ Key = "QA_HTTP_PROXY_PORT";   Label = "HTTP proxy port";   Default = "3228" }
  @{ Key = "QA_SOCKS5_PROXY_HOST"; Label = "SOCKS5 proxy host"; Default = "10.1.5.52" }
  @{ Key = "QA_SOCKS5_PROXY_PORT"; Label = "SOCKS5 proxy port"; Default = "6088" }
  @{ Key = "QA_SSH_HOST";          Label = "SSH host";          Default = "10.1.0.80" }
  @{ Key = "QA_SSH_PORT";          Label = "SSH port";          Default = "22" }
  @{ Key = "QA_SSH_USER";          Label = "SSH user";          Default = "engcapa" }
  @{ Key = "SOCKSCAP_CURL";        Label = "curl.exe path";     Default = "C:\Windows\System32\curl.exe" }
)

function Read-Settings {
  Write-Host ""
  Write-Host "=== SocksCap test configuration (press Enter to keep [current]) ===" -ForegroundColor Cyan
  foreach ($s in $settings) {
    $cur = [Environment]::GetEnvironmentVariable($s.Key)
    if (-not $cur) { $cur = $s.Default }
    $inp = Read-Host ("  {0} [{1}]" -f $s.Label, $cur)
    $val = if ([string]::IsNullOrWhiteSpace($inp)) { $cur } else { $inp.Trim() }
    Set-Item -Path ("Env:" + $s.Key) -Value $val
  }
  # SSH password: blank => the test prompts (getpass) itself.
  $sec = Read-Host "  SSH password (blank = prompt inside test)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  if (-not [string]::IsNullOrWhiteSpace($plain)) { $env:QA_SSH_PASSWORD = $plain }
}

function Test-Prereqs {
  $ok = $true
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  [!] python not found on PATH." -ForegroundColor Yellow; $ok = $false
  }
  $helper = if ($env:SOCKSCAP_HELPER_EXE) { $env:SOCKSCAP_HELPER_EXE } `
            else { Join-Path $repo "src-tauri\target\debug\sockscap-helper.exe" }
  if (-not (Test-Path $helper)) {
    Write-Host "  [!] helper missing: $helper" -ForegroundColor Yellow
    Write-Host "      build+stage it:  pwsh scripts/stage-sockscap-windows.ps1" -ForegroundColor Yellow
    $ok = $false
  }
  $wdDir = if ($env:SOCKSCAP_WINDIVERT_DIR) { $env:SOCKSCAP_WINDIVERT_DIR } `
           else { Split-Path -Parent $helper }
  if (-not (Test-Path (Join-Path $wdDir "WinDivert.dll"))) {
    Write-Host "  [!] WinDivert.dll not next to helper ($wdDir)" -ForegroundColor Yellow
    Write-Host "      fetch it:  pwsh scripts/fetch-windivert.ps1  then re-run stage" -ForegroundColor Yellow
    $ok = $false
  }
  return $ok
}

$menu = @(
  @{ Num = "1"; File = "test_sockscap_direct.py";           Desc = "Direct connectivity smoke (no helper/UAC)" }
  @{ Num = "2"; File = "test_sockscap_driver_e2e.py";       Desc = "Full-link driver E2E (WinDivert + UAC)" }
  @{ Num = "3"; File = "test_sockscap_multiprofile_e2e.py"; Desc = "Multi-profile single-helper (UAC, hot-swap)" }
  @{ Num = "4"; File = "test_sockscap_soak.py";             Desc = "Extended matrix + soak" }
)

function Invoke-Case([string]$file) {
  Write-Host ""
  Write-Host ">>> Running $file" -ForegroundColor Green
  Push-Location $repo
  try { python -u (Join-Path $cases $file) }
  finally { Pop-Location }
  Write-Host "<<< $file exit=$LASTEXITCODE" -ForegroundColor Green
}

Read-Settings
Write-Host ""
Write-Host "=== Prerequisite check ===" -ForegroundColor Cyan
$prereqOk = Test-Prereqs
if ($prereqOk) { Write-Host "  All prerequisites present." -ForegroundColor Green }

while ($true) {
  Write-Host ""
  Write-Host "=== Select a test to run ===" -ForegroundColor Cyan
  foreach ($m in $menu) { Write-Host ("  {0}) {1,-34} {2}" -f $m.Num, $m.File, $m.Desc) }
  Write-Host "  a) run ALL of the above in order"
  Write-Host "  c) re-edit configuration"
  Write-Host "  q) quit"
  $choice = (Read-Host "  choice").Trim().ToLower()
  switch ($choice) {
    "q" { return }
    "c" { Read-Settings; continue }
    "a" { foreach ($m in $menu) { Invoke-Case $m.File }; continue }
    default {
      $hit = $menu | Where-Object { $_.Num -eq $choice }
      if ($hit) { Invoke-Case $hit.File }
      else { Write-Host "  unknown choice: $choice" -ForegroundColor Yellow }
    }
  }
}
