#!/usr/bin/env bash
# Stage the pinned, upstream-signed Mitmproxy Redirector app tar for macOS.
#
# The app bundle is intentionally kept as the original tar from the wheel so
# Tauri's resource copy cannot rewrite its nested System Extension signature.
set -euo pipefail
export LC_ALL=C
export LANG=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="0.12.11"
wheel_url="https://files.pythonhosted.org/packages/fe/7f/7f77310e810ab3ee47357e4ce1bdafc05d429e411bad63c0e546ceef2f2e/mitmproxy_macos-0.12.11-py3-none-any.whl"
wheel_sha256="63349d9b46514ca679547651f7c0548f9222892edfbcba087b82b3244fbae859"
app_tar_sha256="b8ea49940489560bb76b231a064aa823cf3d3e8a0787eac4a456611f26c96a7f"
app_executable_sha256="fb154632717ac7780c2706757573f2352a769e07fef7db1e4ae22027d2e4bc7a"
extension_executable_sha256="0785d00082db59543c093fe63581d31060f5fdc9677dbf2796bf6ac473f6087a"
resource_dir="$repo_root/src-tauri/resources/sockscap/macos/redirector/$version"
app_tar="$resource_dir/Mitmproxy Redirector.app.tar"
manifest="$resource_dir/manifest.json"

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_staged() {
  test -f "$manifest" || {
    echo "Redirector manifest is missing: $manifest" >&2
    exit 1
  }
  test -f "$app_tar" || {
    echo "Redirector app tar is missing: $app_tar" >&2
    echo "Run: bash scripts/stage-mitmproxy-redirector-macos.sh --stage" >&2
    exit 1
  }
  actual_tar_sha256="$(sha256 "$app_tar")"
  test "$actual_tar_sha256" = "$app_tar_sha256" || {
    echo "Redirector app tar SHA-256 mismatch: $actual_tar_sha256" >&2
    exit 1
  }

  verify_dir="$(mktemp -d /tmp/taomni-redirector-verify.XXXXXX)"
  trap 'rm -rf "$verify_dir"' RETURN
  tar -xf "$app_tar" -C "$verify_dir"
  app="$verify_dir/Mitmproxy Redirector.app"
  extension="$app/Contents/Library/SystemExtensions/org.mitmproxy.macos-redirector.network-extension.systemextension"

  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --verify --deep --strict --verbose=2 "$extension"
  app_signature="$(codesign -d --verbose=4 "$app" 2>&1)"
  extension_signature="$(codesign -d --verbose=4 "$extension" 2>&1)"
  grep -Fq 'Identifier=org.mitmproxy.macos-redirector' <<<"$app_signature"
  grep -Fq 'TeamIdentifier=S8XHQB96PW' <<<"$app_signature"
  grep -Fq 'Identifier=org.mitmproxy.macos-redirector.network-extension' <<<"$extension_signature"
  grep -Fq 'TeamIdentifier=S8XHQB96PW' <<<"$extension_signature"
  app_entitlements="$(codesign -d --entitlements - "$app" 2>&1)"
  extension_entitlements="$(codesign -d --entitlements - "$extension" 2>&1)"
  grep -Fq 'com.apple.developer.system-extension.install' <<<"$app_entitlements"
  grep -Fq 'app-proxy-provider-systemextension' <<<"$app_entitlements"
  grep -Fq 'app-proxy-provider-systemextension' <<<"$extension_entitlements"

  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "2.0"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")" = "1"

  executable="$app/Contents/MacOS/Mitmproxy Redirector"
  extension_executable="$extension/Contents/MacOS/org.mitmproxy.macos-redirector.network-extension"
  test "$(sha256 "$executable")" = "$app_executable_sha256"
  test "$(sha256 "$extension_executable")" = "$extension_executable_sha256"
  architectures="$(lipo -archs "$executable")"
  grep -Eq '(^| )arm64( |$)' <<<"$architectures"
  grep -Eq '(^| )x86_64( |$)' <<<"$architectures"
  extension_architectures="$(lipo -archs "$extension_executable")"
  grep -Eq '(^| )arm64( |$)' <<<"$extension_architectures"
  grep -Eq '(^| )x86_64( |$)' <<<"$extension_architectures"

  gatekeeper="$(spctl --assess --type execute --verbose=4 "$app" 2>&1)"
  grep -Fq 'source=Notarized Developer ID' <<<"$gatekeeper"
  if xcrun --find stapler >/dev/null 2>&1; then
    xcrun stapler validate "$app"
  elif [[ "${CI:-}" == "true" ]]; then
    echo "Xcode stapler is required for the macOS release gate" >&2
    exit 1
  else
    echo "warning: Xcode stapler unavailable; Gatekeeper notarization passed, staple validation skipped" >&2
  fi
  rm -rf "$verify_dir"
  trap - RETURN
  echo "Mitmproxy Redirector $version resource verified (signed universal app tar)."
}

case "${1:---check}" in
  --stage)
    work_dir="$(mktemp -d /tmp/taomni-redirector-stage.XXXXXX)"
    trap 'rm -rf "$work_dir"' EXIT
    wheel="$work_dir/mitmproxy_macos-$version.whl"
    curl_args=(--fail --location --silent --show-error)
    if [[ -n "${SOCKSCAP_DOWNLOAD_PROXY:-}" ]]; then
      curl_args+=(--proxy "$SOCKSCAP_DOWNLOAD_PROXY")
    fi
    curl "${curl_args[@]}" --output "$wheel" "$wheel_url"
    actual_wheel_sha256="$(sha256 "$wheel")"
    test "$actual_wheel_sha256" = "$wheel_sha256" || {
      echo "Mitmproxy Redirector wheel SHA-256 mismatch: $actual_wheel_sha256" >&2
      exit 1
    }
    mkdir -p "$resource_dir"
    unzip -p "$wheel" 'mitmproxy_macos/Mitmproxy Redirector.app.tar' >"$app_tar"
    verify_staged
    ;;
  --check)
    verify_staged
    ;;
  *)
    echo "Usage: $0 [--stage|--check]" >&2
    exit 2
    ;;
esac
