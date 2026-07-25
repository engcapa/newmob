#!/usr/bin/env bash
# Tauri beforeBundleCommand dispatcher (runs post-compile, pre-bundle).
#
# Tauri runs beforeBundleCommand through the *platform* shell: /bin/sh on
# macOS/Linux, but cmd.exe on Windows. Inline POSIX `if`/`[ ]`/`$(...)` syntax
# therefore breaks on Windows — cmd.exe reports `"$(uname -s)" was unexpected
# at this time.` and fails the bundle. Keeping this a single
# `bash scripts/before-bundle.sh` invocation means cmd.exe only ever sees one
# program name, and all platform branching happens here in bash (git-bash is
# available on the Windows CI runner, same as the other bash-based hooks).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "$(uname -s)" in
  Darwin)
    # Rewrite the compiled binary's krb5 load commands to @rpath + re-sign.
    bash scripts/bundle-krb5-macos.sh fixbin
    ;;
  Linux)
    bash scripts/stage-sockscap-linux.sh --check
    ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    pwsh -File scripts/stage-sockscap-windows.ps1 --check
    ;;
  *)
    echo "before-bundle: no bundle preflight for $(uname -s), skipping."
    ;;
esac
