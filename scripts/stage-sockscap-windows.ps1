# Stage sockscap-helper + WinDivert next to the built taomni binary (dev/release).
# Usage (from repo root):
#   pwsh scripts/stage-sockscap-windows.ps1
#   pwsh scripts/stage-sockscap-windows.ps1 -Configuration release
#
# WinDivert64.sys stays locked while the WinDivert *kernel driver* is loaded
# (even after sockscap-helper exits). This script stops helper + driver first.

param(
  [ValidateSet("debug", "release")]
  [string]$Configuration = "debug"
)

if (-not $IsWindows) {
  Write-Host "Skipping Windows SocksCap preflight on non-Windows host."
  exit 0
}

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "src-tauri"
$target = Join-Path $tauri "target\$Configuration"
$resWin = Join-Path $tauri "resources\sockscap\windows"

if ($args -contains "--check") {
  # Preflight only - no build, no copy
  if (-not (Test-Path $resWin)) {
    Write-Host "WinDivert resources missing at $resWin"
    exit 1
  }
  $dll = Join-Path $resWin "WinDivert.dll"
  if (-not (Test-Path $dll)) {
    Write-Host "WinDivert.dll missing."
    exit 1
  }
  # xray-core is optional: its absence only disables core-backed upstreams
  # (shadowsocks/trojan/vmess/vless/wireguard), not capture. Warn, don't fail.
  $xray = Join-Path $resWin "xray.exe"
  if (-not (Test-Path $xray)) {
    Write-Host "note: xray.exe not staged (core-backed upstreams disabled; run scripts/fetch-xray.ps1)"
  } else {
    Write-Host "  xray-core present."
  }
  Write-Host "Windows SocksCap bundle preflight passed (WinDivert present)."
  exit 0
}

function Stop-SockscapHelper {
  $procs = Get-Process -Name "sockscap-helper" -ErrorAction SilentlyContinue
  if (-not $procs) { return }
  Write-Host "Stopping running sockscap-helper (so WinDivert files can be updated)..."
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

function Test-WinDivertDriverRunning {
  $q = & sc.exe query WinDivert 2>&1 | Out-String
  return ($q -match "RUNNING")
}

function Stop-WinDivertDriver {
  if (-not (Test-WinDivertDriverRunning)) {
    return $true
  }
  Write-Host "WinDivert kernel driver is RUNNING (locks WinDivert64.sys). Stopping..."

  # Non-elevated attempt first.
  $null = & sc.exe stop WinDivert 2>&1
  Start-Sleep -Seconds 1
  if (-not (Test-WinDivertDriverRunning)) {
    Write-Host "  WinDivert driver stopped."
    return $true
  }

  # Elevate once (UAC). Driver stop requires admin.
  Write-Host "  Need admin to unload driver — prompting UAC..."
  $tmp = Join-Path $env:TEMP "taomni-stop-windivert.ps1"
  @'
$ErrorActionPreference = "Continue"
foreach ($name in @("WinDivert", "WinDivert1", "WinDivert14", "WinDivert2")) {
  $null = & sc.exe stop $name 2>&1
}
Start-Sleep -Seconds 2
'@ | Set-Content -Path $tmp -Encoding UTF8
  try {
    $p = Start-Process -FilePath "powershell.exe" -Verb RunAs `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $tmp) `
      -Wait -PassThru -ErrorAction Stop
    Start-Sleep -Seconds 1
  } catch {
    Write-Warning "UAC elevation cancelled or failed: $_"
    return $false
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-WinDivertDriverRunning)) {
    Write-Host "  WinDivert driver stopped (elevated)."
    return $true
  }
  Write-Warning "WinDivert driver still running. .sys may stay locked until reboot."
  return $false
}

function Copy-Safe {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$DestinationDir
  )
  if (-not (Test-Path $Source)) {
    Write-Warning "Skip missing: $Source"
    return $false
  }
  $dest = Join-Path $DestinationDir (Split-Path $Source -Leaf)
  try {
    Copy-Item -LiteralPath $Source -Destination $dest -Force -ErrorAction Stop
    Write-Host "  copied $(Split-Path $Source -Leaf)"
    return $true
  } catch {
    # Same bytes already on disk → fine (common when only .sys is locked).
    if ((Test-Path $dest) -and (Test-Path $Source)) {
      $srcLen = (Get-Item -LiteralPath $Source).Length
      $dstLen = (Get-Item -LiteralPath $dest).Length
      if ($srcLen -eq $dstLen) {
        Write-Warning "Could not overwrite $dest (in use). Same size as source ($dstLen bytes) — OK to keep existing."
        return $true
      }
      Write-Warning "Could not overwrite $dest (in use). Existing size $dstLen != source $srcLen. Stop driver/reboot then re-run."
      return $false
    }
    Write-Warning "Failed to copy $Source -> $dest : $_"
    return $false
  }
}

Stop-SockscapHelper
$null = Stop-WinDivertDriver

Push-Location $tauri
try {
  Write-Host "Building sockscap-helper ($Configuration)..."
  if ($Configuration -eq "release") {
    cargo build --bin sockscap-helper --release
  } else {
    cargo build --bin sockscap-helper
  }
} finally {
  Pop-Location
}

$helperSrc = Join-Path $target "sockscap-helper.exe"
if (-not (Test-Path $helperSrc)) {
  throw "helper not found at $helperSrc"
}

# Stage helper into resources/sockscap/windows/ so it is bundled with the app (via resources wildcard + paths.rs support).
$helperDest = Join-Path $resWin "sockscap-helper.exe"
Copy-Item -Path $helperSrc -Destination $helperDest -Force
Write-Host "Helper staged to resources for bundling: $helperDest"

# Prefer resources/sockscap/windows for WinDivert; copy into target for runtime discovery.
$dll = Join-Path $resWin "WinDivert.dll"
$sys = Join-Path $resWin "WinDivert64.sys"
if (-not (Test-Path $dll)) {
  Write-Warning "WinDivert.dll missing at $dll — download WinDivert 2.2+ into resources/sockscap/windows/"
} else {
  Write-Host "Staging WinDivert into $target ..."
  # Driver may have been re-opened during cargo; stop again right before copy.
  $null = Stop-WinDivertDriver
  $okDll = Copy-Safe -Source $dll -DestinationDir $target
  $okSys = $true
  if (Test-Path $sys) {
    $okSys = Copy-Safe -Source $sys -DestinationDir $target
  }
  if ($okDll -and $okSys) {
    Write-Host "WinDivert ready under $target"
  } else {
    Write-Warning "WinDivert staging incomplete; if capture already worked before, existing files may still be fine."
  }
}

# xray-core: fetch (pinned SHA256) + stage into target for dev runtime discovery.
# Non-fatal — a missing xray only disables core-backed upstreams, not capture.
$fetchXray = Join-Path $root "scripts\fetch-xray.ps1"
try {
  & $fetchXray -Platform windows
  $xraySrc = Join-Path $resWin "xray.exe"
  if (Test-Path $xraySrc) {
    $okXray = Copy-Safe -Source $xraySrc -DestinationDir $target
    if ($okXray) { Write-Host "xray-core ready under $target" }
  }
} catch {
  Write-Warning "fetch-xray failed ($_); core-backed upstreams (ss/trojan/vmess/vless/wireguard) will be unavailable."
}

Write-Host "Helper ready: $helperSrc"
Write-Host "Done. Start Taomni (dev build) and open SocksCap -> Start (accept UAC)."
Write-Host "Tip: .sys 'in use' means the WinDivert kernel driver is loaded — script tries sc stop (+ UAC)."
Write-Host "     If it still fails: SocksCap Stop, close all Taomni, or reboot, then re-run."
