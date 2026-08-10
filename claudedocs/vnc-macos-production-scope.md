# macOS VNC production scope and ADR

## Decision

Taomni keeps the existing Rust RFB engine for the macOS production track. The
engine already owns RA2/RA2ne, the required baseline encodings, framebuffer
state, and the WebView relay. Replacing it with a C FFI engine or moving the
protocol into WKWebView would enlarge the signing, memory-safety, and migration
surface without removing the relay and platform-integration work.

The supported production scope is macOS 13 and 14 on Apple Silicon and Intel,
subject to the release-package checks below. Windows and Linux support claims
are unchanged by this work.

## Supported matrix

- RFB 3.3, 3.7, and 3.8.
- VeNCrypt with system-trust-chain/hostname-validated X509 TLS
  (`X509None`, `X509Vnc`, and `X509Plain`), plus RA2/RA2ne and VNCAuth. The
  anonymous `TLSNone`/`TLSVnc`/`TLSPlain` family is rejected because the macOS
  system TLS stack cannot authenticate it. `None` is rejected unless the user
  explicitly enables it. The negotiated security type, encryption state, and
  identity validation result are visible. Custom CA, certificate pinning, and
  client-certificate configuration are deliberately outside this release
  scope.
- Raw, CopyRect, Hextile, and ZRLE. Tight/JPEG is not advertised until a
  conformant bounded decoder is present.
- Server-driven DesktopSize. Local window resizing changes only the local fit;
  Taomni does not claim SetDesktopSize support.
- Direct, HTTP CONNECT, SOCKS5, and SSH jump-host network paths.
- Bidirectional UTF-8 text clipboard by default. HTML and RTF require explicit
  opt-in and use the native macOS pasteboard path.
- Configurable view-only, shared-session, clipboard direction, Command-key
  mapping, and bounded automatic reconnect.

## Security boundary

The RFB server connection is separate from an authenticated loopback WebSocket.
The relay requires an unguessable one-time subprotocol token, validates Origin,
accepts one WebView, limits message size, and is cancelled with the session.
Passwords remain in the vault/backend or volatile component state and are not
written into VNC detach/reattach localStorage payloads.

Traditional VNCAuth and RA2ne do not encrypt the complete session. The UI must
show that fact. `require-encryption` accepts only VeNCrypt/TLS or the full-session
encrypted RA2 types; it never falls back to VNCAuth, RA2ne, or None.

## Automated release gates

- Frontend typecheck/build and focused Vitest suites.
- Rust VNC unit and integration fixtures for protocol versions, security
  selection, encodings, resize, clipboard, relay authorization, limits,
  cancellation, proxy routing, and malformed input.
- Browser-mode qa-ui-auto wiring tests. macOS cannot run Tauri WebDriver.
- Deterministic 1080p/4K frame-pipeline benchmarks, bounded slow-consumer tests,
  50-update resize tests, and a configurable mailbox soak test. The default
  soak executes 100,000 producer iterations and can be raised with
  `TAOMNI_VNC_SOAK_ITERATIONS` (hard-capped at 5,000,000).
- `cargo test`, release `cargo check`, and macOS bundle construction where local
  signing/notarization credentials are not required.

## Manual release-candidate checks

Only OS/hardware interactions remain manual: signed/notarized WKWebView smoke,
Retina/non-Retina screen movement, real IMEs and reserved system shortcuts,
NSPasteboard interoperability with third-party apps, App Nap/lid/sleep/network
switching, and commercial/macOS Screen Sharing server compatibility.
