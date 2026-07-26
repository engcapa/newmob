<#
.SYNOPSIS
  Download the official xray-core binary into the SocksCap resources directory
  so the app bundle (and CI --check) can ship the proxy engine that backs the
  Shadowsocks / Trojan / VMess / VLESS / WireGuard upstreams.

.DESCRIPTION
  xray-core (MPL-2.0) is a third-party redistributable and is gitignored (see
  src-tauri/resources/sockscap/<platform>/.gitignore). A fresh checkout / CI
  runner has neither, so release bundles would omit it. This script fetches the
  pinned release from the official XTLS/Xray-core GitHub release and verifies
  each archive against a pinned SHA256 (supply-chain guard), then extracts just
  the `xray` executable.

  Idempotent: if the target executable already exists it does nothing unless
  -Force is given (hash re-verification happens on the downloaded archive, not
  the extracted exe).

.PARAMETER Platform
  windows | macos | macos-arm64 | linux. Defaults to windows (the Phase-1
  target). Pick the others when staging cross-platform bundles.

.PARAMETER Force
  Re-download and overwrite even if the executable is already present.

.EXAMPLE
  pwsh scripts/fetch-xray.ps1
  pwsh scripts/fetch-xray.ps1 -Platform linux
#>
param(
  [ValidateSet("windows", "macos", "macos-arm64", "linux")]
  [string]$Platform = "windows",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# --- Pinned facts (xray-core v25.8.31) -------------------------------------
# Digests come from the official *.dgst files published alongside each asset:
#   https://github.com/XTLS/Xray-core/releases/download/<tag>/<asset>.dgst
$tag = "v25.8.31"
$assets = @{
  "windows"     = @{ zip = "Xray-windows-64.zip";        exe = "xray.exe"; dir = "windows"; sha256 = "993c952450cd6518a0ca46e938888d820732b8b1f376b6b76d941d6970c2580e" }
  "macos"       = @{ zip = "Xray-macos-64.zip";          exe = "xray";     dir = "macos";   sha256 = "cda946335bb5cb6097ee0e73b97912310b4364c89e148972aceb6ee75b6ad4a7" }
  "macos-arm64" = @{ zip = "Xray-macos-arm64-v8a.zip";   exe = "xray";     dir = "macos";   sha256 = "ee7a530a47eab857497e2abdd45eda809db94cc13b9e092c0758174260dddc37" }
  "linux"       = @{ zip = "Xray-linux-64.zip";          exe = "xray";     dir = "linux";   sha256 = "0daa9c18cbc81699013cfdd0de4275e4a4c08d29aa1cf9d264f7e4b825b46ca8" }
}

$a = $assets[$Platform]
$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "src-tauri\resources\sockscap\$($a.dir)"
$destExe = Join-Path $destDir $a.exe

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

if ((-not $Force) -and (Test-Path $destExe)) {
  Write-Host "xray already present at $destExe (use -Force to re-download)."
  exit 0
}

$zipUrl = "https://github.com/XTLS/Xray-core/releases/download/$tag/$($a.zip)"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("xray-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $a.zip

try {
  Write-Host "Downloading xray-core $tag ($($a.zip)) ..."
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -MaximumRedirection 5

  $h = (Get-FileHash -Algorithm SHA256 $zipPath).Hash
  if ($h -ne $a.sha256.ToUpper()) {
    throw "SHA256 mismatch for $($a.zip)`n  expected $($a.sha256)`n  got      $h`nRefusing to stage untrusted binary."
  }
  Write-Host "  archive sha256 ok"

  $extractDir = Join-Path $tmp "unzip"
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  $src = Join-Path $extractDir $a.exe
  if (-not (Test-Path $src)) {
    throw "Expected '$($a.exe)' not found in archive. xray-core layout may have changed."
  }
  Copy-Item -LiteralPath $src -Destination $destExe -Force
  # Preserve the exec bit for non-Windows binaries staged on a POSIX host.
  if (($Platform -ne "windows") -and ($IsLinux -or $IsMacOS)) {
    & chmod +x $destExe 2>$null
  }
  Write-Host "xray-core $tag staged at $destExe"
}
finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
