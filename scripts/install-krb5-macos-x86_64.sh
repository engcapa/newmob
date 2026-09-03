#!/usr/bin/env bash
# Install MIT Kerberos (krb5) for macOS x86_64 cross-compilation.
#
# Homebrew deprecated macOS on Intel (x86_64) in September 2026 and stopped
# building new x86_64 bottles. Running `brew install krb5` attempts to compile
# dependencies (such as openssl@3) from source under Rosetta 2 emulation, which
# takes 30+ minutes and fails during non-interactive post-install in CI.
#
# MIT Kerberos's client libraries (libgssapi_krb5, etc.) do not link against OpenSSL.
# We directly fetch the precompiled Homebrew krb5 x86_64 bottle (1.3 MB), unpack
# it into /usr/local/Cellar/krb5/1.22.2, patch pkg-config path placeholders, and
# symlink /usr/local/opt/krb5. This takes seconds and avoids source builds entirely.
set -euo pipefail

# Ensure Rosetta 2 is present on Apple Silicon runners
if [ "$(uname -m)" = "arm64" ]; then
  if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    sudo softwareupdate --install-rosetta --agree-to-license || true
  fi
fi

TARGET_DIR="/usr/local/Cellar/krb5/1.22.2"
OPT_DIR="/usr/local/opt/krb5"

if [ -d "$OPT_DIR/lib" ] && [ -f "$OPT_DIR/include/gssapi/gssapi.h" ]; then
  echo "MIT Kerberos (x86_64) already present at $OPT_DIR, skipping download."
  exit 0
fi

BOTTLE_SHA256="a4ab63ede148b1230e05c3002024e37d402ad3a18c98976d71a83920a879c462"
BOTTLE_URL="https://ghcr.io/v2/homebrew/core/krb5/blobs/sha256:${BOTTLE_SHA256}"
WORK_DIR="${RUNNER_TEMP:-/tmp}/krb5-x86_64"
ARCHIVE="$WORK_DIR/krb5.tar.gz"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "Requesting anonymous token for Homebrew ghcr.io..."
TOKEN="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/krb5:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')"

echo "Downloading krb5 x86_64 bottle..."
downloaded=false
for attempt in 1 2 3; do
  if curl -fsSL -H "Authorization: Bearer $TOKEN" "$BOTTLE_URL" -o "$ARCHIVE"; then
    downloaded=true
    break
  fi
  echo "Download failed (attempt $attempt), retrying in 3s..."
  sleep 3
done

if [ "$downloaded" != "true" ]; then
  echo "Failed to download krb5 bottle from $BOTTLE_URL" >&2
  exit 1
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$BOTTLE_SHA256" ]; then
  echo "Checksum verification failed: expected $BOTTLE_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi

echo "Extracting krb5 bottle..."
sudo mkdir -p "/usr/local/Cellar" "/usr/local/opt"
sudo tar -xzf "$ARCHIVE" -C "/usr/local/Cellar"
sudo chown -R "$(id -un):$(id -gn)" "$TARGET_DIR"

echo "Patching pkg-config placeholders..."
find "$TARGET_DIR" -type f \( -name "*.pc" -o -name "krb5-config" \) -exec perl -pi -e 's|@@HOMEBREW_CELLAR@@|/usr/local/Cellar|g' {} +

sudo ln -sfn "$TARGET_DIR" "$OPT_DIR"
rm -rf "$WORK_DIR"

echo "MIT Kerberos (x86_64) staged at $OPT_DIR:"
ls -la "$OPT_DIR/lib"
