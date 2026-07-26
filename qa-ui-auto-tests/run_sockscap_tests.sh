#!/usr/bin/env bash
# Taomni SocksCap Test Launcher (unified) — Linux double-clickable entry.
#
# The Linux analogue of qa-ui-auto-tests/run_sockscap_tests.bat. It is a thin
# wrapper that forwards to scripts/run-sockscap-tests.sh (which holds the real
# interactive menu / prerequisite check / test runner logic), mirroring how the
# .bat forwards to scripts/run-sockscap-tests.ps1 on Windows.
#
# The privileged tests install a temporary nft OUTPUT NAT redirect + a cgroup v2
# tree, so they prompt for a sudo password (CAP_NET_ADMIN). See the launcher.
#
#   bash qa-ui-auto-tests/run_sockscap_tests.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

echo "========================================================================="
echo " Taomni SocksCap Linux Real-Machine Test Launcher"
echo " Configure upstream/SSH/curl (env vars), then pick a test to run."
echo " Privileged tests (full-link / multi-profile) will prompt for sudo."
echo "========================================================================="
echo

exec bash "$repo/scripts/run-sockscap-tests.sh" "$@"
