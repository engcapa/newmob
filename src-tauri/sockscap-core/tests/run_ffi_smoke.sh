#!/usr/bin/env bash
# Build libsockscap_core.a and run the C smoke test against it — the same C ABI
# the macOS Network Extension provider links. Proves no-drift for real, not on a
# mock. Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate_dir="$(dirname "$here")"          # sockscap-core/
workspace_dir="$(dirname "$crate_dir")" # src-tauri/
target_dir="$workspace_dir/target/debug"
out="$(mktemp -d)/ffi_smoke"

echo "==> cargo build -p sockscap-core"
( cd "$workspace_dir" && cargo build -p sockscap-core )

# macOS links a few system frameworks pulled in transitively by the Rust std
# staticlib; on Linux they are not needed.
extra=()
if [[ "$(uname -s)" == "Darwin" ]]; then
  extra=(-framework CoreFoundation -framework Security)
fi

echo "==> cc tests/ffi_smoke.c -> $out"
cc "$here/ffi_smoke.c" -I "$crate_dir/include" \
   -L "$target_dir" -lsockscap_core -o "$out" "${extra[@]}"

echo "==> run"
"$out"
