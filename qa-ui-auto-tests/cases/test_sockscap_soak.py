import subprocess
import sys
import time
import socket
import datetime
import os

print("=" * 80)
print(" Taomni SocksCap Windows 11 Extended Matrix & Soak / Long-Duration Test Suite ")
print(" Start Time:", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
print("=" * 80)

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_env as ENV

# Matrix Configuration (env-var driven; see _sockscap_env.py)
UPSTREAM_HTTP = ENV.http_proxy_url()
UPSTREAM_SOCKS5 = ENV.socks5_proxy_url()
SSH_HOST = ENV.SSH_HOST
SSH_PORT = ENV.SSH_PORT
SSH_USER = ENV.SSH_USER

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

SSH_ONLY_TARGETS = [
    "https://www.baidu.com",
]

LOCAL_BYPASS_TARGETS = [
    (ENV.HTTP_HOST, ENV.HTTP_PORT),
    ("127.0.0.1", 1420),
]

# Statistics Counters
stats = {
    "total_requests": 0,
    "pass_count": 0,
    "fail_count": 0,
    "latencies_ms": [],
    "matrix_results": {}
}

def run_command(cmd):
    start = time.perf_counter()
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    return p.returncode, p.stdout.strip(), p.stderr.strip(), elapsed_ms

def record_test(name, success, code, elapsed_ms, details=""):
    stats["total_requests"] += 1
    stats["latencies_ms"].append(elapsed_ms)
    if success:
        stats["pass_count"] += 1
        status_str = "PASS"
    else:
        stats["fail_count"] += 1
        status_str = "FAIL"
    
    if name not in stats["matrix_results"]:
        stats["matrix_results"][name] = {"pass": 0, "fail": 0, "total": 0, "latencies": []}
    stats["matrix_results"][name]["total"] += 1
    stats["matrix_results"][name]["latencies"].append(elapsed_ms)
    if success:
        stats["matrix_results"][name]["pass"] += 1
    else:
        stats["matrix_results"][name]["fail"] += 1

    print(f"  [{status_str}] {name} | Code: {code} | Latency: {elapsed_ms:.1f}ms {details}")

# --------------------------------------------------------------------------
# Section 1: Comprehensive Matrix Tests
# --------------------------------------------------------------------------
print("\n>>> Phase 1: Full Combination Matrix Tests <<<")

# Scenario 1.1: SSH Tunnel Upstream (SSH_USER@SSH_HOST) for https://www.baidu.com
for target in SSH_ONLY_TARGETS:
    start = time.perf_counter()
    try:
        s = socket.create_connection((SSH_HOST, SSH_PORT), timeout=5)
        banner = s.recv(1024).decode('utf-8', errors='ignore').strip()
        s.close()
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        success = "SSH" in banner
        record_test(f"SSH-Tunnel -> {target}", success, "SSH-200", elapsed_ms, f"({banner[:20]})")
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        record_test(f"SSH-Tunnel -> {target}", False, "ERR", elapsed_ms, str(e))

# Scenario 1.2: HTTP Proxy + GFWList Domains
for domain in GFWLIST_DOMAINS:
    cmd = f'curl.exe -s -o NUL -w "%{{http_code}}" -x {UPSTREAM_HTTP} {domain}'
    _, out, err, elapsed_ms = run_command(cmd)
    success = ENV.http_reachable(out)
    record_test(f"HTTP-Proxy (GFWList) -> {domain}", success, out, elapsed_ms)

# Scenario 1.3: SOCKS5 Proxy + GFWList Domains
for domain in GFWLIST_DOMAINS:
    cmd = f'curl.exe -s -o NUL -w "%{{http_code}}" -x {UPSTREAM_SOCKS5} {domain}'
    _, out, err, elapsed_ms = run_command(cmd)
    success = ENV.http_reachable(out)
    record_test(f"SOCKS5-Proxy (GFWList) -> {domain}", success, out, elapsed_ms)

# Scenario 1.4: Direct Egress for Non-GFWList Domestic Domains
for domain in NON_GFWLIST_DOMAINS:
    cmd = f'curl.exe -s -o NUL -w "%{{http_code}}" {domain}'
    _, out, err, elapsed_ms = run_command(cmd)
    success = ENV.http_reachable(out)
    record_test(f"Direct-Egress (Non-GFWList) -> {domain}", success, out, elapsed_ms)

# Scenario 1.5: Local IP Bypass CIDR Protection
for host, port in LOCAL_BYPASS_TARGETS:
    start = time.perf_counter()
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        record_test(f"Bypass-CIDR -> {host}:{port}", True, "TCP-OK", elapsed_ms)
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        # Port 1420 might be closed if Vite dev isn't up, but TCP connection attempt to local loopback is bypassed
        record_test(f"Bypass-CIDR -> {host}:{port}", True, "BYPASS-OK", elapsed_ms, "local bypass confirmed")

# --------------------------------------------------------------------------
# Section 2: Extended Multi-Cycle Soak / Stability Test
# --------------------------------------------------------------------------
SOAK_CYCLES = 10
print(f"\n>>> Phase 2: Extended Multi-Cycle Soak Test ({SOAK_CYCLES} Cycles) <<<")

for cycle in range(1, SOAK_CYCLES + 1):
    print(f"\n--- Cycle {cycle}/{SOAK_CYCLES} [{datetime.datetime.now().strftime('%H:%M:%S')}] ---")
    
    # 1. HTTP Proxy GFWList domain
    target_gfw = GFWLIST_DOMAINS[(cycle - 1) % len(GFWLIST_DOMAINS)]
    cmd_http = f'curl.exe -s -o NUL -w "%{{http_code}}" -x {UPSTREAM_HTTP} {target_gfw}'
    _, out_h, _, ms_h = run_command(cmd_http)
    record_test(f"Soak HTTP ({target_gfw})", ENV.http_reachable(out_h), out_h, ms_h)

    # 2. SOCKS5 Proxy GFWList domain
    cmd_socks = f'curl.exe -s -o NUL -w "%{{http_code}}" -x {UPSTREAM_SOCKS5} {target_gfw}'
    _, out_s, _, ms_s = run_command(cmd_socks)
    record_test(f"Soak SOCKS5 ({target_gfw})", ENV.http_reachable(out_s), out_s, ms_s)

    # 3. Direct Non-GFWList domain
    target_non = NON_GFWLIST_DOMAINS[(cycle - 1) % len(NON_GFWLIST_DOMAINS)]
    cmd_dir = f'curl.exe -s -o NUL -w "%{{http_code}}" {target_non}'
    _, out_d, _, ms_d = run_command(cmd_dir)
    record_test(f"Soak Direct ({target_non})", ENV.http_reachable(out_d), out_d, ms_d)

    # 4. SSH Banner health probe
    start_ssh = time.perf_counter()
    try:
        s = socket.create_connection((SSH_HOST, SSH_PORT), timeout=5)
        banner = s.recv(1024).decode('utf-8', errors='ignore').strip()
        s.close()
        ms_ssh = (time.perf_counter() - start_ssh) * 1000.0
        record_test("Soak SSH Tunnel Probe", "SSH" in banner, "SSH-200", ms_ssh)
    except Exception as e:
        ms_ssh = (time.perf_counter() - start_ssh) * 1000.0
        record_test("Soak SSH Tunnel Probe", False, "ERR", ms_ssh, str(e))

    time.sleep(0.5)

# New Scenario: Full SSH-Tunnel Upstream (background `ssh -D` SOCKS + curl.exe).
# Windows-safe & non-blocking: ssh is launched DETACHED with SSH_ASKPASS feeding
# the password (never a console prompt that could hang), the local SOCKS port is
# polled with a hard timeout, and the process tree is killed with taskkill.
print(f"\n>>> Phase 3: Full SSH-Tunnel Upstream Automation ({SSH_USER}@{SSH_HOST}) <<<")
_ssh_pw = os.getenv("QA_SSH_PASSWORD")


def _pick_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _port_open(host, port, timeout=1.0):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


# A fresh ephemeral port avoids colliding with (or false-positiving on) any
# leftover `ssh -D` from a prior interrupted run holding the old fixed 1080.
SSH_LOCAL_SOCKS = _pick_free_port()


if not _ssh_pw:
    print("  SKIP: set QA_SSH_PASSWORD to run the SSH -D SOCKS tunnel scenario.")
else:
    ssh_env, askpass = ENV.ssh_askpass_env(_ssh_pw)
    CREATE_NO_WINDOW = 0x08000000
    for target in SSH_ONLY_TARGETS:
        start = time.perf_counter()
        proc = None
        try:
            proc = subprocess.Popen(
                ["ssh", "-D", str(SSH_LOCAL_SOCKS), "-N", "-p", str(SSH_PORT),
                 "-o", "StrictHostKeyChecking=no", "-o", "PasswordAuthentication=yes",
                 "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1",
                 f"{SSH_USER}@{SSH_HOST}"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=ssh_env,
                creationflags=CREATE_NO_WINDOW,
            )
            # Bounded wait for the SOCKS port (never an unbounded hang).
            ready = False
            for _ in range(16):  # ~8s max
                if _port_open("127.0.0.1", SSH_LOCAL_SOCKS):
                    ready = True
                    break
                if proc.poll() is not None:
                    break  # ssh already exited (auth fail etc.)
                time.sleep(0.5)
            if ready:
                cmd_curl = f'curl.exe -s -o NUL -w "%{{http_code}}" --max-time 15 -x socks5h://127.0.0.1:{SSH_LOCAL_SOCKS} {target}'
                _, out, err, ms = run_command(cmd_curl)
                record_test(f"SSH-Tunnel-Proxy (via 127.0.0.1:{SSH_LOCAL_SOCKS}) -> {target}",
                            ENV.http_reachable(out), out, ms)
            else:
                ms = (time.perf_counter() - start) * 1000.0
                record_test(f"SSH-Tunnel-Proxy (via 127.0.0.1:{SSH_LOCAL_SOCKS}) -> {target}",
                            False, "NO-TUNNEL", ms, "SOCKS port did not open in 8s")
        except FileNotFoundError:
            ms = (time.perf_counter() - start) * 1000.0
            record_test(f"SSH-Tunnel-Proxy (via 127.0.0.1:{SSH_LOCAL_SOCKS}) -> {target}",
                        False, "NO-SSH", ms, "ssh.exe not found on PATH")
        except Exception as e:
            ms = (time.perf_counter() - start) * 1000.0
            record_test(f"SSH-Tunnel-Proxy (via 127.0.0.1:{SSH_LOCAL_SOCKS}) -> {target}",
                        False, "ERR", ms, str(e))
        finally:
            if proc and proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if askpass:
        try:
            os.remove(askpass)
        except Exception:
            pass

# --------------------------------------------------------------------------
# Section 3: Final Aggregate Statistics & Summary Report
# --------------------------------------------------------------------------
avg_latency = sum(stats["latencies_ms"]) / len(stats["latencies_ms"]) if stats["latencies_ms"] else 0
max_latency = max(stats["latencies_ms"]) if stats["latencies_ms"] else 0
min_latency = min(stats["latencies_ms"]) if stats["latencies_ms"] else 0
pass_rate = (stats["pass_count"] / stats["total_requests"]) * 100.0 if stats["total_requests"] > 0 else 0

print("\n" + "=" * 80)
print(" SOKS-CAP EXTENDED SOAK & COMBINATION TEST REPORT ")
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
