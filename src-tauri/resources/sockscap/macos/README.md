# SocksCap binaries (macOS)

## xray-core

Core-backed upstreams (Shadowsocks / Trojan / VMess / VLESS / WireGuard) are
served by a bundled `xray` process. It is a third-party redistributable
(xray-core, MPL-2.0) and is **not committed** — stage it before packaging:

```bash
# Intel
pwsh scripts/fetch-xray.ps1 -Platform macos
# Apple silicon
pwsh scripts/fetch-xray.ps1 -Platform macos-arm64
```

The script pins the release tag and verifies a SHA256 before extracting `xray`
into this directory. `tauri.conf.json` bundles `resources/sockscap/**/*` into
the app resource dir; the runtime resolves it via
`sockscap::paths::resolve_xray_exe` (override with `SOCKSCAP_XRAY_DIR` /
`SOCKSCAP_XRAY_EXE`).

## Mitmproxy Redirector

macOS transparent capture uses the separately installed, upstream-signed
Mitmproxy Redirector. The release bundle carries the original pinned app tar
and its MIT notice; Taomni never rebuilds or re-signs the nested System
Extension:

```bash
SOCKSCAP_DOWNLOAD_PROXY=http://127.0.0.1:8080 \
  bash scripts/stage-mitmproxy-redirector-macos.sh --stage
```

The proxy variable is optional. The script fixes version `0.12.11`, verifies
the wheel and app-tar SHA-256 values, checks both bundle identities and Team ID
`S8XHQB96PW`, validates the nested signature, and requires both `arm64` and
`x86_64` slices. `--check` performs the offline bundle preflight.

The runtime currently requires the verified app to be installed at
`/Applications/Mitmproxy Redirector.app`. Installation/upgrade UI remains a
separate production gate; there is no system-proxy fallback.
