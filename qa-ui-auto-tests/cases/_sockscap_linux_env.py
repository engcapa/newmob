"""Shared configuration for the SocksCap **Linux** real-machine test scripts.

Linux capture uses a fundamentally different mechanism than Windows: instead of
an elevated WinDivert helper it uses an `nftables` OUTPUT NAT redirect plus a
`cgroup v2` process filter, and the relay recovers the pre-NAT destination with
`SO_ORIGINAL_DST`. There is no persistent helper process — the privileged work
is a handful of `nft`/cgroup mutations run with `sudo`.

Upstream/SSH/curl settings are shared with the Windows scripts via
`_sockscap_env` so both platforms read the same env vars; this module only adds
the Linux-specific bits (a POSIX curl default, sudo-password retrieval, and the
nft/cgroup identifiers that must stay in lock-step with the Rust backend).

Env vars (Linux-specific, in addition to those in _sockscap_env.py):

  QA_SUDO_PASSWORD        sudo password (else prompted; blank on passwordless sudo)
  SOCKSCAP_CURL           curl path (default /usr/bin/curl)
  SOCKSCAP_NFT            nft path (default: first of the standard locations)

The nft table name, ownership marker, cgroup root and session prefix below MUST
match src-tauri/src/sockscap/capture/linux/{tunnel,cgroup}.rs. If the Rust side
renames them, these are the values a real capture would leave behind and the
tests assert against, so update both together.
"""
import os
import shutil

# The leading underscore keeps this out of any test-case discovery glob.

# Reuse every upstream/SSH knob (and the http_reachable helper) from the shared
# module so QA_HTTP_PROXY_*, QA_SOCKS5_PROXY_*, QA_SSH_* mean the same thing on
# both platforms.
import _sockscap_env as _WIN  # noqa: E402

REPO_ROOT = _WIN.REPO_ROOT

# --- Upstreams (re-exported from the shared module) -----------------------
HTTP_HOST = _WIN.HTTP_HOST
HTTP_PORT = _WIN.HTTP_PORT
SOCKS5_HOST = _WIN.SOCKS5_HOST
SOCKS5_PORT = _WIN.SOCKS5_PORT
SSH_HOST = _WIN.SSH_HOST
SSH_PORT = _WIN.SSH_PORT
SSH_USER = _WIN.SSH_USER

http_proxy_url = _WIN.http_proxy_url
socks5_proxy_url = _WIN.socks5_proxy_url
ssh_password = _WIN.ssh_password
http_reachable = _WIN.http_reachable


def _env(name, default):
    v = os.getenv(name)
    v = v.strip() if v else ""
    return v if v else default


# --- Linux tooling --------------------------------------------------------
_NFT_CANDIDATES = ("/usr/sbin/nft", "/usr/bin/nft", "/sbin/nft", "/bin/nft")


def _default_nft():
    for path in _NFT_CANDIDATES:
        if os.path.isfile(path):
            return path
    return shutil.which("nft") or "/usr/sbin/nft"


NFT = _env("SOCKSCAP_NFT", _default_nft())
CURL = _env("SOCKSCAP_CURL", shutil.which("curl") or "/usr/bin/curl")


def sudo_password():
    """sudo password from QA_SUDO_PASSWORD, or an interactive prompt.

    An empty string is a valid value: it means "sudo needs no password on this
    host" (NOPASSWD sudoers or already-root). The harness passes it to
    `sudo -S` either way.
    """
    pw = os.getenv("QA_SUDO_PASSWORD")
    if pw is not None:
        return pw
    import getpass
    return getpass.getpass("Enter sudo password (blank if passwordless / root): ")


# --- nftables / cgroup identifiers (must match the Rust backend) ----------
# src-tauri/src/sockscap/capture/linux/tunnel.rs
NFT_TABLE = "taomni_sockscap"          # `table inet taomni_sockscap`
NFT_FAMILY = "inet"
OWNERSHIP_MARKER = "taomni-sockscap-managed-v1"  # comment on each redirect rule

# src-tauri/src/sockscap/capture/linux/cgroup.rs
CGROUP_ROOT = "/sys/fs/cgroup"
SESSION_PREFIX = "taomni-sockscap-"    # session dir = <root>/<prefix><pid>

# Loopback CIDRs the backend always returns early on, plus the private ranges
# the UI ships as default bypass_cidrs. Kept here so tests install the same
# bypass set a real Start would.
DEFAULT_BYPASS_CIDRS = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
]
