"""Privileged nft+cgroup+relay harness for the SocksCap Linux E2E tests.

This is the Linux analogue of the Windows helper-driven flow. Where Windows
launches an elevated `sockscap-helper.exe` (UAC) that programs WinDivert, Linux
capture is a few `sudo` mutations:

    1. create a cgroup v2 session tree under /sys/fs/cgroup/taomni-sockscap-<pid>
    2. put the target process (curl) into a `capture-profile-N` leaf cgroup
    3. install an `nft` inet OUTPUT NAT redirect that matches that cgroup and
       redirects its TCP to a loopback relay port
    4. run a relay that recovers the pre-NAT destination via SO_ORIGINAL_DST,
       extracts the TLS SNI, applies GFWList routing, and forwards upstream

The relay stays in the caller's cgroup (never the capture cgroup), so its own
upstream connections are naturally excluded from the redirect — no loop.

Everything here is idempotent and cleans up after itself; teardown removes the
nft table and the cgroup tree in the same safe order the Rust backend uses
(rules first, then cgroups). Nothing persists across a run.

SECURITY: the sudo password is read once, held only in this process, and passed
to `sudo -S` on stdin — never on argv and never into a redirected file the
relay reads back.
"""
import os
import socket
import struct
import subprocess
import threading
import time

import _sockscap_linux_env as ENV

# SO_ORIGINAL_DST from linux/netfilter_ipv4.h — the same constant the Rust
# relay uses (src-tauri/.../linux/relay.rs). getsockopt(SOL_IP, 80) returns the
# pre-REDIRECT destination of a connection the OUTPUT nat hook rewrote.
SO_ORIGINAL_DST = 80

# GFWList match set mirrors the Windows E2E scripts so both platforms assert the
# same routing decisions.
GFWLIST_PATTERNS = [
    "google.com",
    "twitter.com",
    "wikipedia.org",
    "githubusercontent.com",
    "github.com",
]


def is_gfwlist_domain(host):
    if not host:
        return False
    host = host.lower()
    for pat in GFWLIST_PATTERNS:
        if host == pat or host.endswith("." + pat):
            return True
    return False


def extract_tls_sni(data):
    """Best-effort SNI from a TLS ClientHello (same parser as the Windows E2E)."""
    if len(data) < 5 or data[0] != 0x16:
        return None
    try:
        pos = 5
        if data[pos] != 0x01:  # handshake type: ClientHello
            return None
        pos += 1 + 3 + 2 + 32  # msg_type(1)+len(3)+version(2)+random(32)
        session_id_len = data[pos]
        pos += 1 + session_id_len
        cipher_len = int.from_bytes(data[pos:pos + 2], "big")
        pos += 2 + cipher_len
        comp_len = data[pos]
        pos += 1 + comp_len
        ext_len = int.from_bytes(data[pos:pos + 2], "big")
        pos += 2
        end_pos = pos + ext_len
        while pos < end_pos and pos + 4 <= len(data):
            ext_type = int.from_bytes(data[pos:pos + 2], "big")
            ext_data_len = int.from_bytes(data[pos + 2:pos + 4], "big")
            pos += 4
            if ext_type == 0:  # server_name
                sni_type = data[pos + 2]
                if sni_type == 0:
                    name_len = int.from_bytes(data[pos + 3:pos + 5], "big")
                    return data[pos + 5:pos + 5 + name_len].decode("utf-8")
            pos += ext_data_len
    except Exception:
        pass
    return None


# --------------------------------------------------------------------------
# Privileged command runner (sudo -S, password on stdin only)
# --------------------------------------------------------------------------
class Sudo:
    """Run privileged commands via `sudo -S`, feeding the password on stdin.

    A blank password means passwordless sudo (or already root); we still use
    `sudo` so the tests behave identically to a delegated-permission host.
    """

    def __init__(self, password):
        self._password = password if password is not None else ""
        self._is_root = os.geteuid() == 0

    def run(self, argv, input_text=None, timeout=20):
        """Return (rc, stdout, stderr). `argv` is a list; never shell-quoted."""
        if self._is_root:
            cmd = list(argv)
            stdin_data = input_text
        else:
            # -S read password from stdin; -p '' suppress the prompt text.
            cmd = ["sudo", "-S", "-p", ""] + list(argv)
            # When the command itself needs stdin (nft -f -, tee), sudo consumes
            # the first line as the password, so prepend it.
            pw_line = self._password + "\n"
            stdin_data = pw_line + (input_text if input_text is not None else "")
        try:
            proc = subprocess.run(
                cmd,
                input=stdin_data,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            return 124, "", f"timeout after {timeout}s: {e}"
        return proc.returncode, proc.stdout, proc.stderr

    def check(self, argv, input_text=None, timeout=20):
        rc, out, err = self.run(argv, input_text=input_text, timeout=timeout)
        if rc != 0:
            raise RuntimeError(
                f"sudo {' '.join(argv)} failed (rc={rc}): {err.strip() or out.strip()}"
            )
        return out

    def verify(self):
        """Prove sudo works before we start mutating the system."""
        rc, _out, err = self.run(["true"], timeout=15)
        if rc != 0:
            raise RuntimeError(
                "sudo authentication failed. Set QA_SUDO_PASSWORD or configure "
                f"passwordless sudo. Detail: {err.strip()}"
            )


def preflight(sudo):
    """Fail early, with actionable messages, before touching the system.

    Mirrors the Rust preflight: cgroup v2 mounted, nft present + usable
    (CAP_NET_ADMIN), and the `socket cgroupv2` match kernel feature available.
    Returns a list of human-readable notes; raises RuntimeError on a hard stop.
    """
    notes = []
    # cgroup v2 unified hierarchy
    if not os.path.isfile(os.path.join(ENV.CGROUP_ROOT, "cgroup.controllers")):
        raise RuntimeError(
            f"cgroup v2 not mounted at {ENV.CGROUP_ROOT} (need a unified cgroup2 host)"
        )
    if not os.path.isfile(ENV.NFT):
        raise RuntimeError(f"nft not found at {ENV.NFT}; install the nftables package")
    # nft usable under sudo (this is the CAP_NET_ADMIN gate)
    sudo.check([ENV.NFT, "--version"], timeout=15)
    rc, _out, err = sudo.run([ENV.NFT, "list", "tables"], timeout=15)
    if rc != 0:
        raise RuntimeError(
            f"nft list tables failed under sudo: {err.strip()}. "
            "Linux capture requires CAP_NET_ADMIN."
        )
    notes.append("nftables usable under sudo")
    return notes


class CaptureSession:
    """One capture run's cgroup tree + nft redirect, driven under sudo.

    Layout matches the Rust backend exactly so the residue (and any assertions
    against it) are identical:

        /sys/fs/cgroup/taomni-sockscap-<pid>/
            capture-profile-0/   <- curl for profile 0 goes here
            capture-profile-1/   <- (multiprofile)
    """

    def __init__(self, sudo, session_pid=None):
        self.sudo = sudo
        self.session_pid = session_pid if session_pid is not None else os.getpid()
        self.root = os.path.join(
            ENV.CGROUP_ROOT, f"{ENV.SESSION_PREFIX}{self.session_pid}"
        )
        self.profile_dirs = []      # index -> absolute cgroup dir
        self.profile_matches = []   # index -> (relative_path, level)
        self._nft_installed = False

    # --- cgroup ---------------------------------------------------------
    def _relative_match(self, abs_dir):
        rel = os.path.relpath(abs_dir, ENV.CGROUP_ROOT)
        level = len([c for c in rel.split("/") if c])
        return rel, level

    def create_cgroups(self, profile_count):
        if os.path.exists(self.root):
            raise RuntimeError(
                f"stale cgroup session at {self.root}; run recover first"
            )
        self.sudo.check(["mkdir", "-p", self.root])
        for index in range(profile_count):
            group_dir = os.path.join(self.root, f"capture-profile-{index}")
            self.sudo.check(["mkdir", "-p", group_dir])
            self.profile_dirs.append(group_dir)
            self.profile_matches.append(self._relative_match(group_dir))

    # --- nft ------------------------------------------------------------
    def _render_nft(self, routes, bypass_cidrs):
        """Render the same inet table the Rust `RedirectPlan` produces.

        `routes` is a list of (profile_index, relay_port). App mode only: each
        capture cgroup redirects to its relay port. IPv4-only (`ip protocol
        tcp`) keeps the test deterministic; curl is pinned to -4.
        """
        lines = [f"table {ENV.NFT_FAMILY} {ENV.NFT_TABLE} {{",
                 "  chain output {",
                 "    type nat hook output priority dstnat; policy accept;",
                 "    ip daddr 127.0.0.0/8 return",
                 "    ip6 daddr ::1/128 return"]
        for cidr in bypass_cidrs:
            fam = "ip6" if ":" in cidr else "ip"
            lines.append(f"    {fam} daddr {cidr} return")
        for index, relay_port in routes:
            rel, level = self.profile_matches[index]
            lines.append(
                f'    socket cgroupv2 level {level} "{rel}" ip protocol tcp '
                f'redirect to :{relay_port} comment "{ENV.OWNERSHIP_MARKER}"'
            )
        lines += ["  }", "}", ""]
        return "\n".join(lines)

    def install_nft(self, routes, bypass_cidrs):
        script = self._render_nft(routes, bypass_cidrs)
        self.sudo.check([ENV.NFT, "-f", "-"], input_text=script)
        self._nft_installed = True
        return script

    # --- run a process inside a capture cgroup --------------------------
    def run_in_cgroup(self, profile_index, argv, timeout=25):
        """Run `argv` as a member of capture-profile-<index>.

        The elevated shell writes its own PID into the leaf cgroup.procs, then
        exec's the target so the target inherits membership. Runs under sudo
        because cgroup.procs is root-owned; the target itself therefore also
        runs as root (fine for curl in a test).
        """
        group_dir = self.profile_dirs[profile_index]
        procs = os.path.join(group_dir, "cgroup.procs")
        quoted = " ".join("'" + a.replace("'", "'\\''") + "'" for a in argv)
        shell = f'echo $$ > "{procs}" && exec {quoted}'
        return self.sudo.run(["sh", "-c", shell], timeout=timeout)

    # --- teardown -------------------------------------------------------
    def cleanup(self):
        """Rules first, then cgroups — the safe order the Rust backend uses."""
        errors = []
        if self._nft_installed:
            rc, _o, err = self.sudo.run(
                [ENV.NFT, "delete", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE]
            )
            if rc != 0 and "No such file" not in err and "does not exist" not in err:
                errors.append(f"nft delete: {err.strip()}")
            else:
                self._nft_installed = False
        # Remove leaf profile dirs then the session root (must be empty).
        for group_dir in reversed(self.profile_dirs):
            rc, _o, err = self.sudo.run(["rmdir", group_dir])
            if rc != 0 and "No such file" not in err:
                errors.append(f"rmdir {group_dir}: {err.strip()}")
        rc, _o, err = self.sudo.run(["rmdir", self.root])
        if rc != 0 and "No such file" not in err:
            errors.append(f"rmdir {self.root}: {err.strip()}")
        self.profile_dirs = []
        self.profile_matches = []
        return errors

    def residue(self):
        """(nft_table_present, session_dir_present) — used to assert clean teardown."""
        rc, _o, _e = self.sudo.run(
            [ENV.NFT, "list", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE]
        )
        return (rc == 0, os.path.exists(self.root))


def recover(sudo):
    """Best-effort cleanup of leftover SocksCap nft table + empty cgroup trees.

    Only removes the managed table (verified by the ownership marker) and empty
    taomni-sockscap-* cgroup dirs; never moves a live process. Mirrors the Rust
    Recover path.
    """
    errors = []
    rc, out, _e = sudo.run([ENV.NFT, "list", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE])
    if rc == 0:
        if ENV.OWNERSHIP_MARKER in out:
            rc2, _o, err = sudo.run(
                [ENV.NFT, "delete", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE]
            )
            if rc2 != 0:
                errors.append(f"nft delete: {err.strip()}")
        else:
            errors.append(
                "found a taomni_sockscap table without the ownership marker; "
                "refusing to delete it"
            )
    # Remove empty session trees (rmdir refuses non-empty, so live captures are safe).
    try:
        for name in os.listdir(ENV.CGROUP_ROOT):
            if not name.startswith(ENV.SESSION_PREFIX):
                continue
            base = os.path.join(ENV.CGROUP_ROOT, name)
            for child in sorted(os.listdir(base), reverse=True):
                sudo.run(["rmdir", os.path.join(base, child)])
            sudo.run(["rmdir", base])
    except FileNotFoundError:
        pass
    return errors


def pick_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _original_dst_v4(sock):
    """Recover the pre-NAT IPv4 destination via getsockopt(SOL_IP, SO_ORIGINAL_DST)."""
    data = sock.getsockopt(socket.SOL_IP, SO_ORIGINAL_DST, 16)
    # struct sockaddr_in: family(2) port(2, big-endian) addr(4) pad(8)
    _family, port = struct.unpack("!HH", data[:4])
    ip = socket.inet_ntoa(data[4:8])
    return ip, port


def _pipe(src, dst, stop):
    try:
        while not stop.is_set():
            chunk = src.recv(8192)
            if not chunk:
                break
            dst.sendall(chunk)
    except Exception:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except Exception:
                pass


class Relay:
    """Loopback relay: recovers original dst, extracts SNI, applies GFWList
    routing, forwards to HTTP/SOCKS5 upstream or direct.

    `upstream_mode` is read fresh per connection so a soak loop can flip
    HTTP<->SOCKS5 between requests, exactly like the Windows E2E relay. Every
    routed connection appends to `audit` for the test to assert against.
    """

    def __init__(self, http=None, socks5=None):
        self.http = http        # (host, port) or None
        self.socks5 = socks5    # (host, port) or None
        self.upstream_mode = "HTTP"
        self.audit = []
        self.port = pick_free_port()
        self._stop = threading.Event()
        self._srv = None
        self._thread = None

    def start(self):
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # nft redirect targets loopback; bind there like the Rust relay.
        self._srv.bind(("127.0.0.1", self.port))
        self._srv.listen(128)
        self._srv.settimeout(1.0)
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._thread.start()
        return self.port

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        if self._srv:
            try:
                self._srv.close()
            except Exception:
                pass

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                client, addr = self._srv.accept()
            except socket.timeout:
                continue
            except Exception:
                break
            threading.Thread(
                target=self._handle, args=(client, addr), daemon=True
            ).start()

    def _handle(self, client, addr):
        try:
            try:
                orig_ip, orig_port = _original_dst_v4(client)
            except OSError as e:
                # No SO_ORIGINAL_DST => the connection was not nft-redirected.
                self.audit.append({"error": f"no original dst: {e}", "origin": addr})
                client.close()
                return

            client.settimeout(3.0)
            try:
                initial = client.recv(4096, socket.MSG_PEEK)
            except Exception:
                initial = b""
            sni = extract_tls_sni(initial)
            is_gfw = is_gfwlist_domain(sni)
            mode = self.upstream_mode
            target_host = sni if sni else orig_ip

            if is_gfw:
                decision = "PROXY"
                upstream = self._connect_upstream(mode, target_host, orig_port)
            else:
                decision = "DIRECT"
                upstream = socket.create_connection((target_host, orig_port), timeout=5)

            self.audit.append({
                "sni": sni,
                "orig_ip": orig_ip,
                "orig_port": orig_port,
                "gfwlist_match": is_gfw,
                "decision": decision,
                "mode": mode,
            })
            client.settimeout(None)
            threading.Thread(target=_pipe, args=(client, upstream, self._stop), daemon=True).start()
            threading.Thread(target=_pipe, args=(upstream, client, self._stop), daemon=True).start()
        except Exception as e:
            self.audit.append({"error": str(e), "origin": addr})
            try:
                client.close()
            except Exception:
                pass

    def _connect_upstream(self, mode, host, port):
        if mode == "SOCKS5":
            if not self.socks5:
                raise RuntimeError("SOCKS5 upstream not configured")
            up = socket.create_connection(self.socks5, timeout=5)
            up.sendall(b"\x05\x01\x00")             # greeting: no auth
            up.recv(2)
            hb = host.encode("utf-8")
            up.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + port.to_bytes(2, "big"))
            up.recv(10)                              # connect reply
            return up
        # default HTTP CONNECT
        if not self.http:
            raise RuntimeError("HTTP upstream not configured")
        up = socket.create_connection(self.http, timeout=5)
        req = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
        up.sendall(req.encode("utf-8"))
        resp = b""
        while b"\r\n\r\n" not in resp:
            c = up.recv(1024)
            if not c:
                break
            resp += c
        return up



