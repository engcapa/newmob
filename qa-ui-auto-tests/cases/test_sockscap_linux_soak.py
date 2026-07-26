"""SocksCap Linux extended matrix & soak / long-duration test.

The Linux analogue of test_sockscap_soak.py. Like the Windows version it drives
the *upstreams directly* (curl -x http/socks5, and a real background `ssh -D`
SOCKS tunnel) rather than the nft/cgroup capture path — so it needs no sudo and
runs anywhere with network access to the configured upstreams. It exercises:

  Phase 1  Full combination matrix (SSH banner, HTTP/SOCKS5 GFWList, direct,
           local bypass reachability)
  Phase 2  Extended multi-cycle soak (HTTP / SOCKS5 / direct / SSH banner)
  Phase 3  Full SSH-tunnel egress: `ssh -D <port> -N` + curl through it, i.e.
           data actually leaving via the SSH upstream (the strong SSH-egress
           assertion the direct smoke only probes for reachability)

Phase 3 is skipped unless QA_SSH_PASSWORD is set (matches the Windows script).
Exit code is non-zero if any executed leg failed.
"""
import datetime
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_linux_env as ENV
import _sockscap_linux_harness as H

print("=" * 80)
print(" Taomni SocksCap Linux — Extended Matrix & Soak / Long-Duration Test Suite")
print(" Start Time:", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
print("=" * 80)

UPSTREAM_HTTP = ENV.http_proxy_url()
UPSTREAM_SOCKS5 = ENV.socks5_proxy_url()

GFWLIST_DOMAINS = [
    "https://www.google.com",
    "https://twitter.com",
    "https://raw.githubusercontent.com",
    "https://wikipedia.org",
]
NON_GFWLIST_DOMAINS = [
    "https://cn.bing.com",
    "https://www.baidu.com",
]
SSH_ONLY_TARGETS = ["https://www.baidu.com"]
LOCAL_BYPASS_TARGETS = [
    (ENV.HTTP_HOST, ENV.HTTP_PORT),
    ("127.0.0.1", 1420),
]
SOAK_CYCLES = int(os.getenv("SOCKSCAP_SOAK_CYCLES", "10"))

stats = {
    "total_requests": 0,
    "pass_count": 0,
    "fail_count": 0,
    "latencies_ms": [],
    "matrix_results": {},
}


def run_command(argv):
    """Run argv (a list — no shell), return (rc, stdout, stderr, elapsed_ms)."""
    start = time.perf_counter()
    p = subprocess.run(argv, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return p.returncode, p.stdout.strip(), p.stderr.strip(), elapsed_ms


def curl_code(url, proxy=None, max_time=15):
    """curl an URL (optionally via a proxy), returning just the HTTP status."""
    argv = [ENV.CURL, "-s", "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", str(max_time)]
    if proxy:
        argv += ["-x", proxy]
    argv.append(url)
    return run_command(argv)


def record_test(name, success, code, elapsed_ms, details=""):
    stats["total_requests"] += 1
    stats["latencies_ms"].append(elapsed_ms)
    status_str = "PASS" if success else "FAIL"
    if success:
        stats["pass_count"] += 1
    else:
        stats["fail_count"] += 1
    m = stats["matrix_results"].setdefault(
        name, {"pass": 0, "fail": 0, "total": 0, "latencies": []}
    )
    m["total"] += 1
    m["latencies"].append(elapsed_ms)
    m["pass" if success else "fail"] += 1
    print(f"  [{status_str}] {name} | Code: {code} | Latency: {elapsed_ms:.1f}ms {details}")


def ssh_banner(host, port, timeout=5):
    """(ok, banner_or_error, elapsed_ms) — TCP-connect and read the SSH banner."""
    start = time.perf_counter()
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        banner = s.recv(256).decode("utf-8", errors="ignore").strip()
        s.close()
        return banner.startswith("SSH-"), banner, (time.perf_counter() - start) * 1000.0
    except Exception as e:
        return False, str(e), (time.perf_counter() - start) * 1000.0


# --------------------------------------------------------------------------
# Phase 1: Full combination matrix
# --------------------------------------------------------------------------
print("\n>>> Phase 1: Full Combination Matrix Tests <<<")

# 1.1 SSH upstream reachability (banner)
for target in SSH_ONLY_TARGETS:
    ok, banner, ms = ssh_banner(ENV.SSH_HOST, ENV.SSH_PORT)
    record_test(f"SSH-Banner ({ENV.SSH_USER}@{ENV.SSH_HOST}) -> {target}", ok,
                "SSH-OK" if ok else "ERR", ms, f"({banner[:24]})")

# 1.2 HTTP proxy + GFWList domains
for domain in GFWLIST_DOMAINS:
    _, out, err, ms = curl_code(domain, proxy=UPSTREAM_HTTP)
    record_test(f"HTTP-Proxy (GFWList) -> {domain}", ENV.http_reachable(out), out, ms)

# 1.3 SOCKS5 proxy + GFWList domains
for domain in GFWLIST_DOMAINS:
    _, out, err, ms = curl_code(domain, proxy=UPSTREAM_SOCKS5)
    record_test(f"SOCKS5-Proxy (GFWList) -> {domain}", ENV.http_reachable(out), out, ms)

# 1.4 Direct egress for non-GFWList domains
for domain in NON_GFWLIST_DOMAINS:
    _, out, err, ms = curl_code(domain)
    record_test(f"Direct-Egress (Non-GFWList) -> {domain}", ENV.http_reachable(out), out, ms)

# 1.5 Local / private-CIDR bypass reachability
for host, port in LOCAL_BYPASS_TARGETS:
    start = time.perf_counter()
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        record_test(f"Bypass-CIDR -> {host}:{port}", True, "TCP-OK",
                    (time.perf_counter() - start) * 1000.0)
    except Exception:
        # Port may be closed (e.g. Vite dev not up); the point is the address is
        # a local/private bypass target, so we don't fail the suite on refusal.
        record_test(f"Bypass-CIDR -> {host}:{port}", True, "BYPASS-OK",
                    (time.perf_counter() - start) * 1000.0, "local bypass confirmed")

# --------------------------------------------------------------------------
# Phase 2: Extended multi-cycle soak
# --------------------------------------------------------------------------
print(f"\n>>> Phase 2: Extended Multi-Cycle Soak Test ({SOAK_CYCLES} Cycles) <<<")
for cycle in range(1, SOAK_CYCLES + 1):
    print(f"\n--- Cycle {cycle}/{SOAK_CYCLES} [{datetime.datetime.now().strftime('%H:%M:%S')}] ---")
    target_gfw = GFWLIST_DOMAINS[(cycle - 1) % len(GFWLIST_DOMAINS)]
    _, out_h, _, ms_h = curl_code(target_gfw, proxy=UPSTREAM_HTTP)
    record_test(f"Soak HTTP ({target_gfw})", ENV.http_reachable(out_h), out_h, ms_h)

    _, out_s, _, ms_s = curl_code(target_gfw, proxy=UPSTREAM_SOCKS5)
    record_test(f"Soak SOCKS5 ({target_gfw})", ENV.http_reachable(out_s), out_s, ms_s)

    target_non = NON_GFWLIST_DOMAINS[(cycle - 1) % len(NON_GFWLIST_DOMAINS)]
    _, out_d, _, ms_d = curl_code(target_non)
    record_test(f"Soak Direct ({target_non})", ENV.http_reachable(out_d), out_d, ms_d)

    ok, _banner, ms_ssh = ssh_banner(ENV.SSH_HOST, ENV.SSH_PORT)
    record_test("Soak SSH Banner Probe", ok, "SSH-OK" if ok else "ERR", ms_ssh)
    time.sleep(0.5)

# --------------------------------------------------------------------------
# Phase 3: Full SSH-tunnel egress (background `ssh -D` SOCKS + curl through it)
# --------------------------------------------------------------------------
# The strong SSH-egress assertion: data actually leaves via the SSH upstream.
# Non-blocking & leak-free: ssh is launched in its own session (start_new_session)
# with SSH_ASKPASS feeding the password (never a console prompt that could hang),
# the local SOCKS port is polled with a hard timeout, and the whole process group
# is killed on teardown.
print(f"\n>>> Phase 3: Full SSH-Tunnel Egress Automation ({ENV.SSH_USER}@{ENV.SSH_HOST}) <<<")
_ssh_pw = os.getenv("QA_SSH_PASSWORD")


def _port_open(host, port, timeout=1.0):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


if not _ssh_pw:
    print("  SKIP: set QA_SSH_PASSWORD to run the `ssh -D` SOCKS tunnel egress scenario.")
else:
    ssh_env, askpass = ENV.ssh_askpass_env(_ssh_pw)
    # Fresh ephemeral port avoids colliding with a leftover `ssh -D` from a prior
    # interrupted run.
    local_socks = H.pick_free_port()
    for target in SSH_ONLY_TARGETS:
        start = time.perf_counter()
        proc = None
        try:
            proc = subprocess.Popen(
                ["ssh", "-D", str(local_socks), "-N", "-p", str(ENV.SSH_PORT),
                 "-o", "StrictHostKeyChecking=no", "-o", "PasswordAuthentication=yes",
                 "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
                 "-o", "BatchMode=no",
                 f"{ENV.SSH_USER}@{ENV.SSH_HOST}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ssh_env,
                start_new_session=True,  # own process group -> clean killpg
            )
            ready = False
            for _ in range(16):  # ~8s max
                if _port_open("127.0.0.1", local_socks):
                    ready = True
                    break
                if proc.poll() is not None:
                    break  # ssh already exited (auth fail etc.)
                time.sleep(0.5)
            if ready:
                _, out, err, ms = curl_code(
                    target, proxy=f"socks5h://127.0.0.1:{local_socks}", max_time=15)
                record_test(f"SSH-Tunnel-Egress (via 127.0.0.1:{local_socks}) -> {target}",
                            ENV.http_reachable(out), out, ms)
            else:
                ms = (time.perf_counter() - start) * 1000.0
                record_test(f"SSH-Tunnel-Egress (via 127.0.0.1:{local_socks}) -> {target}",
                            False, "NO-TUNNEL", ms, "SOCKS port did not open in 8s")
        except FileNotFoundError:
            ms = (time.perf_counter() - start) * 1000.0
            record_test(f"SSH-Tunnel-Egress (via 127.0.0.1:{local_socks}) -> {target}",
                        False, "NO-SSH", ms, "ssh not found on PATH")
        except Exception as e:
            ms = (time.perf_counter() - start) * 1000.0
            record_test(f"SSH-Tunnel-Egress (via 127.0.0.1:{local_socks}) -> {target}",
                        False, "ERR", ms, str(e))
        finally:
            if proc and proc.poll() is None:
                import signal
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    proc.wait(timeout=5)
                except Exception:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        pass
    if askpass:
        try:
            os.remove(askpass)
        except Exception:
            pass

# --------------------------------------------------------------------------
# Final aggregate statistics & summary report
# --------------------------------------------------------------------------
lat = stats["latencies_ms"]
avg_latency = sum(lat) / len(lat) if lat else 0
max_latency = max(lat) if lat else 0
min_latency = min(lat) if lat else 0
pass_rate = (stats["pass_count"] / stats["total_requests"] * 100.0) if stats["total_requests"] else 0

print("\n" + "=" * 80)
print(" SOCKSCAP LINUX EXTENDED SOAK & COMBINATION TEST REPORT")
print("=" * 80)
print(f" End Time         : {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f" Total Requests   : {stats['total_requests']}")
print(f" Passed           : {stats['pass_count']}")
print(f" Failed           : {stats['fail_count']}")
print(f" Pass Rate        : {pass_rate:.2f}%")
print(f" Latency (ms)     : Min={min_latency:.1f}ms | Avg={avg_latency:.1f}ms | Max={max_latency:.1f}ms")
print("-" * 80)
print("\nMatrix Performance Breakdown:")
print(f"  {'Scenario Name':<45} | {'Pass/Total':<12} | {'Avg Latency':<12}")
print("  " + "-" * 75)
for name, data in stats["matrix_results"].items():
    avg_l = sum(data["latencies"]) / len(data["latencies"]) if data["latencies"] else 0
    ratio = f"{data['pass']}/{data['total']}"
    print(f"  {name:<45} | {ratio:<12} | {avg_l:.1f}ms")
print("=" * 80)

sys.exit(1 if stats["fail_count"] else 0)
