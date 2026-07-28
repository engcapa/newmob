#!/usr/bin/env bash
# build-extension.sh — scaffold for building the Sockscap system extension.
#
# AUTHORED SCAFFOLD, NOT RUNNABLE END-TO-END HERE. Producing a loadable
# NETransparentProxyProvider system extension is an Apple-account / signing /
# notarization / macOS-hardware task (ADR-0003, Blocked-on-infra). This script
# documents the exact steps and fails fast with a clear message if the external
# prerequisites are absent, so it is safe to check in and to run on a properly
# provisioned Mac.
#
# Prereqs (all external to this repo):
#   * macOS + Xcode with an App-Proxy Provider system-extension target.
#   * A Developer ID Application signing identity ($SIGN_IDENTITY).
#   * The entitlements in this directory wired to the app + extension targets.
#   * A notarization profile ($NOTARY_PROFILE) for `xcrun notarytool`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_dir="$(cd "$here/../../sockscap-core" && pwd)"

echo "==> 1) Build sockscap-core staticlib (the shared decision + control core)"
( cd "$core_dir/.." && cargo build -p sockscap-core --release )
echo "    libsockscap_core.a → src-tauri/target/release/libsockscap_core.a"
echo "    C header           → sockscap-core/include/sockscap_core.h"
echo "    module map         → $here/module.modulemap (import SockscapCore)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "!! Not macOS: the Xcode system-extension target cannot be built here." >&2
  echo "   The staticlib above is ready; run the rest on a provisioned Mac." >&2
  exit 0
fi

: "${SIGN_IDENTITY:?set SIGN_IDENTITY to a Developer ID Application identity}"

echo "==> 2) Build + sign the system-extension target (Xcode)"
echo "    Expected target: SockscapExtension (App Proxy Provider system extension)"
echo "    - Compiles SockscapTransparentProxyProvider.swift"
echo "    - Adds $core_dir/include to import paths, links libsockscap_core.a"
echo "    - Info.plist: $here/Info.plist  Entitlements: $here/SockscapExtension.entitlements"
# xcodebuild -project Taomni.xcodeproj -target SockscapExtension \
#   -configuration Release CODE_SIGN_IDENTITY="$SIGN_IDENTITY" build

echo "==> 3) Embed the .appex under Taomni.app/Contents/Library/SystemExtensions/"
echo "    Tauri bundles resources/sockscap/**/* already; the built"
echo "    SockscapExtension.systemextension is detected by"
echo "    sockscap::transparent::activation::resolve_extension_bundle."

echo "==> 4) Notarize (xcrun notarytool submit ... --wait) and staple"
echo "    Verify: user-approval flow, version upgrade, Intel + Apple Silicon."

echo "Scaffold complete. Steps 2-4 require the external Apple infrastructure."
