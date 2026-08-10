# macOS VNC release-candidate manual checklist

The automated gates cover protocol parsing, policy enforcement, resource
limits, relay authorization/backpressure, frontend wiring, and production
builds. The following checks require macOS 14 hardware, a signed app, or a
real VNC server and therefore remain manual release-candidate gates.

## Packaging and WebView

- [ ] Build the signed `.app` and verify the bundle launches under a clean
      macOS 14 user account.
- [ ] Verify hardened runtime, notarization, Gatekeeper launch, and WKWebView
      CSP/loopback WebSocket behavior after notarization.
- [ ] Confirm both Apple Silicon and Intel artifacts where those targets are
      part of the release matrix.

## Display and input

- [ ] Move a session between Retina and non-Retina displays and verify 1:1,
      fit, pointer coordinates, screenshots, and server-driven DesktopSize.
- [ ] Exercise Command, Option, Fn, function keys, both modifier sides,
      numeric keypad, dead keys, IME composition, and reserved system
      shortcuts. Confirm disconnect/blur/sleep never leaves a remote key held.
- [ ] Verify view-only blocks keyboard, pointer, resize, and clipboard writes.

## Clipboard and lifecycle

- [ ] Exchange UTF-8 text with Finder, Notes, Safari, and a third-party VNC
      client through the real `NSPasteboard`.
- [ ] Verify explicitly enabled HTML/RTF behavior and text-only/default policy.
- [ ] Test App Nap, lid close/sleep/wake, fast user switching, network changes,
      VPN/proxy changes, reconnect backoff, and clean app quit.

## Server compatibility and security

- [ ] Test RFB 3.3/3.7/3.8 and VNCAuth/RA2/RA2ne against the release server
      matrix; verify the UI reports actual security and encryption state.
- [ ] Test VeNCrypt X509None, X509Vnc, and X509Plain against servers with valid
      system-trusted certificates and hostname mismatches. Certificate errors
      must fail closed; anonymous TLS-family subtypes must be rejected with an
      unsupported-security error.
- [ ] Exercise macOS Screen Sharing's proprietary authentication separately;
      it is not part of the open VeNCrypt compatibility claim.
