#!/usr/bin/env bash
# Unified launcher for the SocksCap **Linux** real-machine E2E tests.
#
# The Linux analogue of scripts/run-sockscap-tests.ps1. It interactively
# confirms the upstream/SSH settings (env vars consumed by
# qa-ui-auto-tests/cases/_sockscap_linux_env.py; defaults reproduce the shared
# in-repo values), collects a sudo password, runs a prerequisite check, then
# lets you pick which test to run.
#
# The privileged tests install a temporary `nft` OUTPUT NAT redirect and a
# cgroup v2 tree under /sys/fs/cgroup, then remove them on teardown. They need
# nftables usable under sudo (CAP_NET_ADMIN). No persistent helper is installed.
#
#   bash scripts/run-sockscap-tests.sh
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cases="$repo/qa-ui-auto-tests/cases"

c_cyan=$'\033[36m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_reset=$'\033[0m'

# Settings: NAME|Label|Default  (upstream defaults match _sockscap_env.py)
settings=(
  "QA_HTTP_PROXY_HOST|HTTP proxy host|10.1.0.80"
  "QA_HTTP_PROXY_PORT|HTTP proxy port|3228"
  "QA_SOCKS5_PROXY_HOST|SOCKS5 proxy host|10.1.5.52"
  "QA_SOCKS5_PROXY_PORT|SOCKS5 proxy port|6088"
  "QA_SSH_HOST|SSH host|10.1.0.80"
  "QA_SSH_PORT|SSH port|22"
  "QA_SSH_USER|SSH user|engcapa"
  "SOCKSCAP_CURL|curl path|$(command -v curl || echo /usr/bin/curl)"
)

read_settings() {
  echo
  echo "${c_cyan}=== SocksCap test configuration (press Enter to keep [current]) ===${c_reset}"
  local entry name label def cur inp
  for entry in "${settings[@]}"; do
    IFS='|' read -r name label def <<<"$entry"
    cur="${!name:-$def}"
    read -r -p "  $label [$cur]: " inp
    export "$name"="${inp:-$cur}"
  done
  # sudo password: silent; blank means passwordless sudo / root.
  # Why it's needed: tests 2 & 3 install a temporary nft OUTPUT NAT redirect and
  # a cgroup v2 tree (CAP_NET_ADMIN), then tear them down. Test 1 (direct smoke)
  # does NOT use sudo, so a blank password there just makes it SKIP the rest.
  echo
  echo "  ${c_cyan}A sudo password is required for the privileged tests (2 & 3):${c_reset}"
  echo "    they add/remove an nft redirect + cgroup v2 tree (CAP_NET_ADMIN)."
  echo "    Leave blank if sudo is passwordless or you run as root; the direct"
  echo "    smoke test (1) needs no sudo. Wrong/blank => privileged tests SKIP (77)."
  local pw
  read -r -s -p "  sudo password (blank = passwordless / root): " pw
  echo
  export QA_SUDO_PASSWORD="$pw"

  # SSH password: only for the soak test's `ssh -D` egress leg (Phase 3). Read
  # it here the same way Windows Read-Settings does. Blank => leave QA_SSH_PASSWORD
  # untouched, so that leg SKIPs (the SSH *banner* probe elsewhere needs no
  # password). Only export when non-empty so a blank never clobbers a value the
  # environment already provided.
  echo
  echo "  ${c_cyan}An SSH password enables the soak test's real ssh -D egress leg:${c_reset}"
  echo "    it curls through a background 'ssh -D' SOCKS tunnel to prove data"
  echo "    actually leaves via the SSH upstream. Blank => that leg SKIPs."
  local sshpw
  read -r -s -p "  SSH password for ${QA_SSH_USER:-engcapa}@${QA_SSH_HOST:-<host>} (blank = skip ssh -D egress): " sshpw
  echo
  if [[ -n "$sshpw" ]]; then
    export QA_SSH_PASSWORD="$sshpw"
  fi
}

nft_bin() {
  local p
  for p in "${SOCKSCAP_NFT:-}" /usr/sbin/nft /usr/bin/nft /sbin/nft /bin/nft; do
    [[ -n "$p" && -x "$p" ]] && { echo "$p"; return 0; }
  done
  command -v nft 2>/dev/null && return 0
  return 1
}

check_prereqs() {
  local ok=0
  echo "${c_cyan}=== Prerequisite check ===${c_reset}"

  if command -v python3 >/dev/null 2>&1; then
    echo "  ${c_green}[ok]${c_reset} python3: $(command -v python3)"
  else
    echo "  ${c_yellow}[!]${c_reset} python3 not found on PATH"; ok=1
  fi

  if [[ -x "${SOCKSCAP_CURL:-/usr/bin/curl}" ]] || command -v curl >/dev/null 2>&1; then
    echo "  ${c_green}[ok]${c_reset} curl present"
  else
    echo "  ${c_yellow}[!]${c_reset} curl not found (needed by the E2E tests)"; ok=1
  fi

  if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
    echo "  ${c_green}[ok]${c_reset} cgroup v2 mounted at /sys/fs/cgroup"
  else
    echo "  ${c_yellow}[!]${c_reset} cgroup v2 not mounted at /sys/fs/cgroup (unified host required)"; ok=1
  fi

  local nft; nft="$(nft_bin)"
  if [[ -z "$nft" ]]; then
    echo "  ${c_yellow}[!]${c_reset} nft not found; install the nftables package"; ok=1
  else
    # Probe nft under sudo (this is the CAP_NET_ADMIN gate). Feed the password
    # on stdin via sudo -S so it never lands on argv.
    if printf '%s\n' "${QA_SUDO_PASSWORD:-}" | sudo -S -p '' "$nft" list tables >/dev/null 2>&1; then
      echo "  ${c_green}[ok]${c_reset} nft usable under sudo: $nft"
    else
      echo "  ${c_yellow}[!]${c_reset} nft not usable under sudo (need CAP_NET_ADMIN + correct sudo password)"; ok=1
    fi
  fi

  if [[ $ok -eq 0 ]]; then
    echo "  ${c_green}All prerequisites present.${c_reset}"
  else
    echo "  ${c_yellow}Some prerequisites are missing; privileged tests will SKIP (exit 77).${c_reset}"
  fi
  return $ok
}

declare -a menu_file menu_desc
menu_file=(
  "test_sockscap_linux_direct.py"
  "test_sockscap_linux_e2e.py"
  "test_sockscap_linux_multiprofile_e2e.py"
  "test_sockscap_linux_soak.py"
)
menu_desc=(
  "Direct connectivity smoke (no sudo/capture)"
  "Full-link app-mode E2E (nft + cgroup + soak)"
  "Multi-profile (2 cgroups -> 2 relay ports)"
  "Extended matrix + soak + ssh -D egress (no sudo)"
)

run_case() {
  local file="$1"
  echo
  echo "${c_green}>>> Running $file${c_reset}"
  ( cd "$repo" && python3 -u "$cases/$file" )
  echo "${c_green}<<< $file exit=$?${c_reset}"
}

read_settings
echo
check_prereqs || true

while true; do
  echo
  echo "${c_cyan}=== Select a test to run ===${c_reset}"
  for i in "${!menu_file[@]}"; do
    printf "  %d) %-38s %s\n" "$((i+1))" "${menu_file[$i]}" "${menu_desc[$i]}"
  done
  echo "  a) run ALL of the above in order"
  echo "  c) re-edit configuration"
  echo "  q) quit"
  read -r -p "  choice: " choice
  case "$choice" in
    q|Q) exit 0 ;;
    c|C) read_settings; echo; check_prereqs || true ;;
    a|A) for f in "${menu_file[@]}"; do run_case "$f"; done ;;
    ''|*[!0-9]*) echo "  ${c_yellow}unknown choice: $choice${c_reset}" ;;
    *)
      idx=$((choice-1))
      if [[ $idx -ge 0 && $idx -lt ${#menu_file[@]} ]]; then
        run_case "${menu_file[$idx]}"
      else
        echo "  ${c_yellow}unknown choice: $choice${c_reset}"
      fi
      ;;
  esac
done

