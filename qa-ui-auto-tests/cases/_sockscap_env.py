"""Shared configuration for the SocksCap real-machine test scripts.

Every host/port/credential/path the sockscap E2E scripts need is read from an
environment variable here, with a default that reproduces the original values.
The unified launcher (scripts/run-sockscap-tests.ps1) sets these before running
a test; running a script directly still works using the defaults below.

Env vars (aligned with the Rust win11 scenarios in
src-tauri/tests/integration/sockscap_win11_scenarios.rs):

  QA_HTTP_PROXY_HOST / QA_HTTP_PROXY_PORT     upstream HTTP CONNECT proxy
  QA_SOCKS5_PROXY_HOST / QA_SOCKS5_PROXY_PORT upstream SOCKS5 proxy
  QA_SSH_HOST / QA_SSH_PORT / QA_SSH_USER     upstream SSH tunnel
  QA_SSH_PASSWORD                             SSH password (else prompted)
  SOCKSCAP_CURL                               curl.exe path
  SOCKSCAP_REPO_ROOT                          repo root (else derived from path)
  SOCKSCAP_HELPER_EXE / SOCKSCAP_WINDIVERT_DIR override built-helper locations
"""
import os

# The leading underscore keeps this out of any test-case discovery glob.

def _env(name, default):
    v = os.getenv(name)
    v = v.strip() if v else ""
    return v if v else default


def _env_int(name, default):
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


# --- Repo layout ----------------------------------------------------------
# <repo>/qa-ui-auto-tests/cases/_sockscap_env.py -> repo root is two dirs up.
_CASES_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = _env(
    "SOCKSCAP_REPO_ROOT",
    os.path.dirname(os.path.dirname(_CASES_DIR)),
)

HELPER_EXE = _env(
    "SOCKSCAP_HELPER_EXE",
    os.path.join(REPO_ROOT, "src-tauri", "target", "debug", "sockscap-helper.exe"),
)
WINDIVERT_DIR = _env(
    "SOCKSCAP_WINDIVERT_DIR",
    os.path.join(REPO_ROOT, "src-tauri", "target", "debug"),
)
CURL_EXE = _env("SOCKSCAP_CURL", r"C:\Windows\System32\curl.exe")
VBS_LAUNCHER = os.path.join(REPO_ROOT, "scripts", "launch-elevated-helper.vbs")

# --- Upstreams (defaults reproduce the original hardcoded values) ---------
HTTP_HOST = _env("QA_HTTP_PROXY_HOST", "10.1.0.80")
HTTP_PORT = _env_int("QA_HTTP_PROXY_PORT", 3228)

SOCKS5_HOST = _env("QA_SOCKS5_PROXY_HOST", "10.1.5.52")
SOCKS5_PORT = _env_int("QA_SOCKS5_PROXY_PORT", 6088)

SSH_HOST = _env("QA_SSH_HOST", "10.1.0.80")
SSH_PORT = _env_int("QA_SSH_PORT", 22)
SSH_USER = _env("QA_SSH_USER", "engcapa")

# Back-compat aliases used by some scripts.
UPSTREAM_HTTP_HOST, UPSTREAM_HTTP_PORT = HTTP_HOST, HTTP_PORT
UPSTREAM_SOCKS5_HOST, UPSTREAM_SOCKS5_PORT = SOCKS5_HOST, SOCKS5_PORT


def http_proxy_url():
    return f"http://{HTTP_HOST}:{HTTP_PORT}"


def socks5_proxy_url():
    return f"socks5h://{SOCKS5_HOST}:{SOCKS5_PORT}"


def ssh_password():
    """SSH password from QA_SSH_PASSWORD, or an interactive prompt."""
    pw = os.getenv("QA_SSH_PASSWORD")
    if pw:
        return pw
    import getpass
    return getpass.getpass(f"Enter SSH password for {SSH_USER}@{SSH_HOST}: ")


def ssh_askpass_env(password):
    """Build an environment that lets Windows OpenSSH authenticate with a
    password non-interactively, plus the temp askpass script path to delete.

    OpenSSH uses SSH_ASKPASS (with SSH_ASKPASS_REQUIRE=force, OpenSSH >= 8.4,
    which Windows 11 ships) whenever it has no console to prompt on. The askpass
    script just echoes the password read from a private env var (kept out of the
    file so a password with shell metacharacters is not embedded on disk).

    Returns (env_dict, askpass_path) or (None, None) when no password is given.
    The caller MUST launch ssh detached (CREATE_NO_WINDOW / stdin=DEVNULL) so it
    can never fall back to a blocking console prompt, and delete askpass_path.
    """
    if not password:
        return None, None
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".bat", prefix="sc-askpass-")
    with os.fdopen(fd, "w") as f:
        f.write("@echo %SC_SSH_PW%\r\n")
    env = dict(os.environ)
    env["SSH_ASKPASS"] = path
    env["SSH_ASKPASS_REQUIRE"] = "force"
    env["SC_SSH_PW"] = password
    # Avoid a real DISPLAY dependency; force flag covers the no-tty case.
    env.setdefault("DISPLAY", "localhost:0")
    return env, path


def http_reachable(code):
    """True if curl returned a real HTTP response (reachability check).

    A reachability assertion only needs to prove the request completed the full
    capture -> relay -> upstream -> target round trip and got an HTTP status
    back. curl writes "000" (and returns non-zero) when it got no response at
    all — timeout, connection refused, TLS failure, broken proxy chain. Any
    real status (2xx/3xx/4xx/5xx, e.g. api.twitter.com's 404 on "/") proves the
    path works; routing correctness is asserted separately via the audit log.
    """
    code = (str(code) if code is not None else "").strip()
    return code.isdigit() and code != "000"
