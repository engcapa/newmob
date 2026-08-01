#!/usr/bin/env bash
# Post-bundle release gate for the Taomni macOS app. This validates Taomni's
# Developer ID/notarization chain separately from the pinned mitmproxy chain.
set -euo pipefail
export LC_ALL=C
export LANG=C

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <rust-target-triple> <expected-arch>" >&2
  exit 2
fi

target_triple="$1"
expected_arch="$2"
expected_team_id="${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_root="$repo_root/src-tauri/target/$target_triple/release/bundle"
app="$bundle_root/macos/Taomni.app"
main_executable="$app/Contents/MacOS/taomni"
resource_root="$app/Contents/Resources"
pinned_redirector="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar"
pinned_manifest="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/manifest.json"
pinned_license="$repo_root/src-tauri/resources/sockscap/macos/redirector/0.12.11/LICENSE"

test -d "$app" || {
  echo "Taomni app bundle is missing: $app" >&2
  exit 1
}
test -x "$main_executable" || {
  echo "Taomni executable is missing: $main_executable" >&2
  exit 1
}

codesign --verify --deep --strict --verbose=2 "$app"
signature="$(codesign -d --verbose=4 "$app" 2>&1)"
grep -Fq 'Identifier=com.taomni.app' <<<"$signature"
grep -Fq "TeamIdentifier=$expected_team_id" <<<"$signature"
grep -Eq 'flags=.*\(runtime\)' <<<"$signature"

main_architectures="$(lipo -archs "$main_executable")"
test "$main_architectures" = "$expected_arch" || {
  echo "Expected Taomni architecture $expected_arch, found: $main_architectures" >&2
  exit 1
}

xray_count="$(find "$resource_root" -type f -path '*/sockscap/macos/xray' | wc -l | tr -d ' ')"
test "$xray_count" = "1" || {
  echo "Expected one bundled macOS xray executable, found $xray_count" >&2
  exit 1
}
xray="$(find "$resource_root" -type f -path '*/sockscap/macos/xray' -print -quit)"
test -x "$xray" || {
  echo "Bundled xray is not executable: $xray" >&2
  exit 1
}
xray_architectures="$(lipo -archs "$xray")"
test "$xray_architectures" = "$expected_arch" || {
  echo "Expected bundled xray architecture $expected_arch, found: $xray_architectures" >&2
  exit 1
}

redirector_count="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar' | wc -l | tr -d ' ')"
test "$redirector_count" = "1" || {
  echo "Expected one bundled Redirector v0.12.11 archive, found $redirector_count" >&2
  exit 1
}
bundled_redirector="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar' -print -quit)"
cmp "$pinned_redirector" "$bundled_redirector"

bundled_manifest="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/manifest.json' -print -quit)"
bundled_license="$(find "$resource_root" -type f -path '*/sockscap/macos/redirector/0.12.11/LICENSE' -print -quit)"
test -n "$bundled_manifest" && cmp "$pinned_manifest" "$bundled_manifest"
test -n "$bundled_license" && cmp "$pinned_license" "$bundled_license"

gatekeeper="$(spctl --assess --type execute --verbose=4 "$app" 2>&1)"
grep -Fq 'source=Notarized Developer ID' <<<"$gatekeeper"
xcrun stapler validate "$app"

echo "Taomni macOS $expected_arch release verified: Developer ID, notarization, architecture, Xray and Redirector v0.12.11."
