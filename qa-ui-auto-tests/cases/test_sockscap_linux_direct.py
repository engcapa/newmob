"""SocksCap Linux direct-connectivity smoke test (no sudo, no capture).

The Linux analogue of test_sockscap_direct.py. It proves the *upstream* side of
the pipeline is reachable and routes correctly, without installing any nft /
cgroup capture — so it can run on any host (CI included) that has network
access to the configured upstreams. It never needs CAP_NET_ADMIN or sudo.

What it checks:
  1. Upstream HTTP CONNECT proxy tunnels a GFWList target (TLS handshake).
  2. Upstream SOCKS5 proxy tunnels a GFWList target.
  3. A non-GFWList target is reachable via direct egress.
  4. The TLS-SNI / GFWList decision logic in the harness matches expectations.

Exit code is non-zero if any enabled leg fails, so a launcher can gate on it.
"""
import os
import socket
import ssl
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_linux_env as ENV
import _sockscap_linux_harness as H

print("=" * 78)
print(" Taomni SocksCap Linux — Direct Connectivity Smoke (no capture)")
print("=" * 78)

STEPS = 5

results = {"total": 0, "passed": 0, "failed": 0}


def record(name, ok, detail=""):
    results["total"] += 1
    if ok:
        results["passed"] += 1
        status = "PASS"
    else:
        results["failed"] += 1
        status = "FAIL"
    print(f"  [{status}] {name:<44} {detail}")


def tls_via_http_connect(proxy, host, port=443):
    up = socket.create_connection(proxy, timeout=8)
    req = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
    up.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = up.recv(1024)
        if not c:
            break
        resp += c
    if b" 200 " not in resp.split(b"\r\n", 1)[0] and b"200" not in resp[:16]:
        up.close()
        raise RuntimeError(f"CONNECT rejected: {resp[:60]!r}")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    tls = ctx.wrap_socket(up, server_hostname=host)
    tls.close()


def tls_via_socks5(proxy, host, port=443):
    up = socket.create_connection(proxy, timeout=8)
    up.sendall(b"\x05\x01\x00")
    if up.recv(2) != b"\x05\x00":
        up.close()
        raise RuntimeError("SOCKS5 greeting rejected")
    hb = host.encode()
    up.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + port.to_bytes(2, "big"))
    reply = up.recv(10)
    if len(reply) < 2 or reply[1] != 0x00:
        up.close()
        raise RuntimeError(f"SOCKS5 connect failed: {reply!r}")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    tls = ctx.wrap_socket(up, server_hostname=host)
    tls.close()


# --- 1. Harness routing logic (always runs, no network) -------------------
print(f"\n[1/{STEPS}] GFWList decision logic")
record("google.com -> GFWList match", H.is_gfwlist_domain("www.google.com"))
record("baidu.com  -> no match", not H.is_gfwlist_domain("www.baidu.com"))

# --- 2. HTTP CONNECT upstream --------------------------------------------
print(f"\n[2/{STEPS}] HTTP CONNECT upstream ({ENV.HTTP_HOST}:{ENV.HTTP_PORT})")
try:
    tls_via_http_connect((ENV.HTTP_HOST, ENV.HTTP_PORT), "www.google.com")
    record("HTTP CONNECT -> www.google.com:443", True)
except Exception as e:
    record("HTTP CONNECT -> www.google.com:443", False, f"({e})")

# --- 3. SOCKS5 upstream ---------------------------------------------------
print(f"\n[3/{STEPS}] SOCKS5 upstream ({ENV.SOCKS5_HOST}:{ENV.SOCKS5_PORT})")
try:
    tls_via_socks5((ENV.SOCKS5_HOST, ENV.SOCKS5_PORT), "en.wikipedia.org")
    record("SOCKS5 -> en.wikipedia.org:443", True)
except Exception as e:
    record("SOCKS5 -> en.wikipedia.org:443", False, f"({e})")

# --- 4. SSH upstream reachability (banner) --------------------------------
# Mirrors Windows test_sockscap_direct.py Scenario 1: prove the SSH egress
# endpoint is reachable and speaks SSH. The full `ssh -D` egress data-path is
# exercised by the soak test; here we only assert the server is up.
print(f"\n[4/{STEPS}] SSH upstream ({ENV.SSH_USER}@{ENV.SSH_HOST}:{ENV.SSH_PORT})")
try:
    s = socket.create_connection((ENV.SSH_HOST, ENV.SSH_PORT), timeout=8)
    banner = s.recv(256).decode("utf-8", errors="ignore").strip()
    s.close()
    record("SSH banner reachable", banner.startswith("SSH-"), f"({banner[:24]})")
except Exception as e:
    record("SSH banner reachable", False, f"({e})")

# --- 5. Direct egress (non-GFWList) --------------------------------------
print(f"\n[5/{STEPS}] Direct egress (non-GFWList)")
try:
    s = socket.create_connection(("www.baidu.com", 443), timeout=8)
    s.close()
    record("Direct -> www.baidu.com:443", True)
except Exception as e:
    record("Direct -> www.baidu.com:443", False, f"({e})")

print("\n" + "=" * 78)
print(f" Total {results['total']} | Passed {results['passed']} | Failed {results['failed']}")
print("=" * 78)
sys.exit(1 if results["failed"] else 0)
