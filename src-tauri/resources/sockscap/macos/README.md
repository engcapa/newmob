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

> macOS capture is not implemented yet; the egress/core layer is cross-platform
> and ready once a capture backend lands.
