<#
.SYNOPSIS
  Download the official WinDivert 2.2.2 x64 redistributables into the SocksCap
  resources directory so the Windows bundle (and CI --check) has them.

.DESCRIPTION
  WinDivert.dll + WinDivert64.sys are gitignored (LGPLv3/GPLv2 redistributables,
  see src-tauri/resources/sockscap/windows/README.md). A fresh checkout / CI
  runner has neither, so `stage-sockscap-windows.ps1 --check` fails and release
  bundles omit WinDivert. This script fetches them from the official reqrypt.org
  release and verifies each file against a pinned SHA256 (supply-chain guard).

  Idempotent: if both files already exist with the expected hash it does nothing
  unless -Force is given.

.PARAMETER Force
  Re-download and overwrite even if valid files are already present.

.EXAMPLE
  pwsh scripts/fetch-windivert.ps1
#>
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# --- Pinned facts (WinDivert 2.2.2-A, x64) ---------------------------------
$zipUrl = "https://reqrypt.org/download/WinDivert-2.2.2-A.zip"
# SHA256 of the exact bytes the project ships/tests with (see README).
$expected = @{
  "WinDivert.dll"   = "C1E060EE19444A259B2162F8AF0F3FE8C4428A1C6F694DCE20DE194AC8D7D9A2"
  "WinDivert64.sys" = "8DA085332782708D8767BCACE5327A6EC7283C17CFB85E40B03CD2323A90DDC2"
}
# Path of each file inside the zip (WinDivert ships arch subdirs).
$zipEntry = @{
  "WinDivert.dll"   = "WinDivert-2.2.2-A/x64/WinDivert.dll"
  "WinDivert64.sys" = "WinDivert-2.2.2-A/x64/WinDivert64.sys"
}

$root = Split-Path -Parent $PSScriptRoot
$resWin = Join-Path $root "src-tauri\resources\sockscap\windows"

function Test-Pinned {
  param([string]$Dir)
  foreach ($name in $expected.Keys) {
    $p = Join-Path $Dir $name
    if (-not (Test-Path $p)) { return $false }
    $h = (Get-FileHash -Algorithm SHA256 $p).Hash
    if ($h -ne $expected[$name]) { return $false }
  }
  return $true
}

New-Item -ItemType Directory -Force -Path $resWin | Out-Null

if ((-not $Force) -and (Test-Pinned -Dir $resWin)) {
  Write-Host "WinDivert already present and verified in $resWin (use -Force to re-download)."
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("windivert-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp "WinDivert.zip"

try {
  Write-Host "Downloading WinDivert 2.2.2 from $zipUrl ..."
  $ProgressPreference = "SilentlyContinue"  # faster Invoke-WebRequest
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -MaximumRedirection 5

  Write-Host "Extracting ..."
  $extractDir = Join-Path $tmp "unzip"
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  foreach ($name in $expected.Keys) {
    $src = Join-Path $extractDir ($zipEntry[$name] -replace "/", "\")
    if (-not (Test-Path $src)) {
      throw "Expected '$($zipEntry[$name])' not found in archive. WinDivert layout may have changed."
    }
    $h = (Get-FileHash -Algorithm SHA256 $src).Hash
    if ($h -ne $expected[$name]) {
      throw "SHA256 mismatch for $name`n  expected $($expected[$name])`n  got      $h`nRefusing to stage untrusted binary."
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $resWin $name) -Force
    Write-Host "  staged $name (sha256 ok)"
  }

  if (-not (Test-Pinned -Dir $resWin)) {
    throw "Post-copy verification failed."
  }
  Write-Host "WinDivert 2.2.2 x64 ready in $resWin"
}
finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
