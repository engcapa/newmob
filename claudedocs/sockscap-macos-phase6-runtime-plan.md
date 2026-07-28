# SocksCap macOS Phase 6 — Wire transparent (per-app) capture into the engine runtime

**Goal.** Complete the macOS transparent-capture backend end-to-end *at the code level*:
bring the Swift `NETransparentProxyProvider` onto `main` and de-drift it to the
`sockscap-core` FFI (single source of truth), add the versioned control protocol,
wire the transparent backend into `sockscap_start` / teardown with **dynamic backend
selection** (transparent when the extension is installed + has connected back;
system-proxy fallback otherwise), make `capabilities()` report `app_filter=true`
only when the extension bundle is actually present, and author all packaging
scaffolding.

**Hard contract preserved:** real activation stays *Blocked-on-infra* (Apple
Network Extension entitlement + Developer ID + notarization + Mac approval).
Nothing ever reports `Active` for an extension that is not installed and has not
connected back. `activate()` still fails fast when the bundle is absent.

## Verifiability (I am on Linux)

Work is split so the maximum amount compiles + unit-tests here:

| Layer | cfg | Verifiable on Linux? |
|---|---|---|
| Control-server loop (AF_UNIX, transport-agnostic) | `#[cfg(unix)]` | **Yes** — compiles + unit-tested |
| Bundle-path detection, selection JSON, backend-choice logic | none (pure) | **Yes** — unit-tested |
| Dynamic `capabilities()` probe | pure + injected probe | **Yes** — unit-tested |
| `OSSystemExtensionRequest` activation shim | `#[cfg(target_os="macos")]` + build.rs ObjC | **No** — authored, flagged |
| Swift provider, entitlements, Info.plist, module map, build script | text artifacts | **No** — authored, flagged |

Every unverifiable file is called out in its own header and in the final summary.
Phase 1 (system-proxy) stays fully working; its tests stay green. No project-wide
`cargo fmt` — only `rustfmt --edition 2024` on files I create/edit.

## Design decisions (resolved during investigation)

1. **Single decision implementation.** Swift calls `sockscap_provider_decide(...)`
   over the C-ABI. The Swift copy of `selectedAppIDs.contains(...)` is deleted —
   this is exactly the drift `sockscap-core` exists to prevent.
2. **Readiness = the control channel, not activation submission.** `activate()`
   only *submits* `OSSystemExtensionRequest`. The backend reports `Active` only
   after the provider connects to the engine's AF_UNIX control socket and
   completes `Hello` (auth + version). No connect within a timeout ⇒ deterministic
   fallback to system-proxy (Degraded note explains "approve the extension").
3. **Self-capture safety (new hazard vs Phase 1).** The provider relays into a
   loopback SOCKS port, which under a transparent proxy could loop. Guards:
   - Swift settings add `excludedNetworkRules` for loopback (127.0.0.0/8, ::1).
   - Decision self-bypass includes `com.taomni.app` **and** the extension's own
     signing id (passed in the selection JSON `bypassIds`).
   - The dial target is the engine-provided ingress port (dynamic), not 1080.
4. **Dynamic port + token via provider configuration.** The app hands the
   extension `{ socksPort, controlSocketPath, token, selectionJson }` through the
   provider configuration / `sendProviderMessage`, replacing the hardcoded 1080.
5. **`capabilities()` becomes bundle-aware.** `sockscap_capabilities` command gains
   an `AppHandle` (Tauri injects it — no frontend change); on macOS it reports
   `app_filter=true` + `capture_backend="ne-transparent"` when the extension
   bundle is found, else the Phase-1 `system-proxy` values. A no-arg default stays
   for internal callers (journal/recover/start_stub).

## Phases

### Phase A — Restructure control server to build + test on all Unix (verifiable)
- `transparent/mod.rs`: gate submodules so `control` + `decision` (already) and the
  **AF_UNIX serve loop** compile on `#[cfg(unix)]`; keep only activation
  `#[cfg(target_os="macos")]`.
- Move `serve_control`, `serve_control_stream`, `write_response` from the
  macOS-only `adapter.rs` into a `#[cfg(unix)]` `adapter/control_server.rs`; keep
  `TransparentAdapter` + `activate()` split into `adapter/mod.rs`.
- Result: the 3 existing serve-loop tests now actually run on Linux (they never did
  — `adapter.rs` was macOS-gated). Add tests for `ApplyConfig` push + degraded.

### Phase B — De-drift + complete the Swift provider (authored, unverifiable)
Create `src-tauri/resources/macos-provider/SockscapTransparentProxyProvider.swift`:
- `handleNewFlow`: derive signing id from `sourceAppAuditToken` (audit-token based,
  not `sourceAppSigningIdentifier`); call `sockscap_provider_decide(selection, id)`;
  `Handle` ⇒ relay, `PassThrough` ⇒ `return false`.
- Rebuild `SockscapSelection` from the app-delivered JSON via
  `sockscap_selection_from_json` (freed on config change / stop).
- Control-protocol **client**: `Hello{version,token}` over AF_UNIX (path from
  config); handle `ApplyConfig` via `handleAppMessage`; `Ping`/`Report`; fail-open
  to DIRECT on channel loss.
- Relay to `socksPort` from config (not 1080); loopback excluded in settings.

### Phase C — Engine-side activation + extension detection
- `transparent/activation.rs`:
  - `locate_extension_bundle(resource_dir) -> Option<PathBuf>` + `extension_identifier()`
    — **pure, Linux-tested** (searches `…/Library/SystemExtensions/…appex`,
    dev `resources/macos-provider/` layouts, mirrors `paths.rs` candidate style).
  - `#[cfg(target_os="macos")] request_activation(ext_id) -> Result<(),String>`
    calling a build.rs-compiled ObjC shim `sockscap_ne_activate` (authored,
    unverifiable). Bundle absent ⇒ existing `ENTITLEMENT_UNAVAILABLE` error.
- `build.rs`: `#[cfg(macos)]` compile `resources/macos-provider/activation_shim.m`
  (cc), link `SystemExtensions` + `Foundation`. Guarded by `CARGO_CFG_TARGET_OS`.

### Phase D — Runtime wiring: dynamic backend selection (verifiable logic + macOS glue)
- New `capture/macos/transparent.rs`: `MacosTransparentCaptureHandle` owning the
  loopback ingress + AF_UNIX control server task + submitted activation; `stop()`
  deactivates/te ars down in safe order (control server → ingress; request
  deactivation best-effort).
- New pure fn `choose_macos_backend(cfg, extension_present) -> MacosBackend`
  (`Transparent` | `SystemProxy`) — **Linux-tested**: transparent iff bundle present
  (app scope now allowed); else system-proxy (Global only, unchanged).
- `start_macos_capture` branches on it; on `Transparent`, start ingress + control
  server, submit activation, await provider `Hello` (bounded); on timeout, tear
  down and fall back to system-proxy with a Degraded note. Orchestrator gains a
  `macos_transparent_capture` handle slot mirroring `macos_capture` (start/stop/
  finish_stop/force_idle + `relay_port`). Teardown restores in safe order.

### Phase E — Dynamic capabilities (verifiable)
- `capture::capabilities_for(app)` (macOS: probe bundle) + keep `capabilities()`
  default. `sockscap_capabilities(app)` uses the probe. Unit-test both branches via
  an injected `extension_present: bool` helper. Frontend already gates Apps mode on
  `caps.appFilter` — no UI change needed; it lights up when the bundle ships.

### Phase F — Packaging scaffolding (authored, unverifiable)
Under `src-tauri/resources/macos-provider/`: `README.md` (integration checklist),
`module.modulemap` (exposes `sockscap_core.h` to Swift), `SockscapExtension.entitlements`
+ `Taomni.app.entitlements` (`com.apple.developer.networking.networkextension =
[app-proxy-provider-systemextension]`), `Info.plist` (`NetworkExtension` /
`NEProviderClasses`), `activation_shim.m`, `build-extension.sh` (xcodebuild target
skeleton, clearly marked external-infra). `tauri.conf.json` already bundles
`resources/sockscap/**/*`; document where the built `.appex` is staged.

### Phase G — Docs + verification
- Update `claudedocs/sockscap-macos-phase6-rust-plan.md` "not doing" ⇒ done list;
  update ADR-0003 exit-criteria progress note (kept Blocked-on-infra).
- Update `src/lib/i18n/locales/{en,zh-CN}.ts` transparent-capture / "approve
  extension" strings.
- Run: `cargo test -p sockscap-core`, `cargo test --lib sockscap` (expect ≥111 +
  new), `cargo check` (Linux target), `bash sockscap-core/tests/run_ffi_smoke.sh`,
  `pnpm test` for the panel. `rustfmt --edition 2024` on new/edited .rs only.

## Explicitly NOT done (still infra-gated, unchanged from ADR-0003)
Xcode system-extension target build, Developer ID signing, notarization, real
device user-approval / upgrade, and the actual kernel `auditToken → signing id`
derivation. These need an Apple account + Mac hardware and cannot be produced or
verified in this Linux session. All such files are authored and flagged unverifiable.
