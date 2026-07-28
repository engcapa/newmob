# Sockscap macOS transparent-proxy provider

This directory holds the macOS transparent-capture backend's **Network Extension
provider** and its packaging scaffolding. Per-app capture on macOS (plan §4.1/§8,
ADR-0003) needs a `NETransparentProxyProvider` running as a *system extension* —
a separate, signed, notarized bundle that a `cargo build` cannot produce.

Everything that *can* be produced without an Apple account is done and wired into
the engine; what remains is the external packaging step.

## Files

| File | Role | Built by |
|---|---|---|
| `SockscapTransparentProxyProvider.swift` | The provider. `handleNewFlow` calls the shared `sockscap_provider_decide` (no Swift copy of the decision); relays handled flows to the engine's loopback SOCKS port. | Xcode system-extension target |
| `activation_shim.m` | C entry `sockscap_ne_activate` submitting `OSSystemExtensionRequest`. | `build.rs` on macOS (`cc`) |
| `module.modulemap` | Exposes `sockscap_core.h` to Swift (`import SockscapCore`). | Xcode |
| `Info.plist` | Extension bundle: `NEProviderClasses`, identifier `com.taomni.app.SockscapExtension`. | Xcode |
| `SockscapExtension.entitlements` / `Taomni.app.entitlements` | NetworkExtension + app-group entitlements. | Xcode signing |
| `build-extension.sh` | Scaffolded build/sign/notarize steps; fails fast off-Mac. | you, on a Mac |

## How the engine uses it (already implemented in Rust)

- `sockscap::transparent::activation::resolve_extension_bundle` locates the
  embedded `.systemextension`. Present ⇒ `capabilities()` reports
  `app_filter=true` / `capture_backend="ne-transparent"` and per-app scope is
  offered in the UI; absent ⇒ Phase 1 system-proxy (Global only).
- On Start, `start_macos_capture` chooses the transparent backend when the bundle
  is present: it starts the loopback ingress + the `AF_UNIX` control server,
  submits activation via the shim, and waits for the provider to connect and
  authenticate. If it doesn't connect (not yet approved, or the NE tunnel glue
  below is unbuilt), the engine **falls back to system-proxy** — it never reports
  the transparent plane active unless a provider is genuinely relaying.
- The provider is handed `{ socksPort, controlSocketPath, token, selectionJson }`
  (`transparent::provider_config::ProviderConfig`) — dynamic port + token, no
  hardcoding.

## Integration checklist (Phase 6, the remaining external work)

- [ ] Add the Xcode **App Proxy Provider** system-extension target compiling the
      Swift file; add `../../sockscap-core/include` to import paths and link
      `libsockscap_core.a`; set the module map.
- [ ] Wire `com.taomni.app` + extension entitlements and a Developer ID identity.
- [ ] Build the **NE tunnel glue**: after activation, configure and start the
      provider via `NEAppProxyProviderManager` and deliver `ProviderConfig`
      through the provider configuration / `sendProviderMessage`. (This is what
      makes the provider connect to the control socket and flip the engine to
      Active; without it, Start falls back to system-proxy by design.)
- [ ] Notarize; verify user-approval + version-upgrade flows.
- [ ] Verify audit-token identity + provider self-bypass (the extension id and
      `com.taomni.app` are already in the selection's `bypassIds`).
- [ ] Confirm Intel + Apple Silicon builds.

## Why the decision is not in Swift

An earlier draft reimplemented the capture check in Swift (`selectedAppIDs.contains`)
and used `sourceAppSigningIdentifier`. That drifts from the engine and trusts a
spoofable field. This version derives identity from `sourceAppAuditToken` and
calls the shared `sockscap-core` FFI, so engine and extension are provably one
implementation. See `../../sockscap-core/` and `src/sockscap/transparent/`.
