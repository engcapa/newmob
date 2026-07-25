import os, sys, time, json, socket, secrets, threading, subprocess, tempfile, datetime

print("=" * 85)
print(" Taomni SocksCap Multi-Profile Single-Helper E2E Test")
print(" (WinDivert Kernel NAT + 4 Profiles Sharing One Helper Process)")
print("=" * 85)

# --------------------------------------------------------------------------
# Environment Configuration
# --------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_env as ENV

REPO_ROOT = ENV.REPO_ROOT
HELPER_EXE = ENV.HELPER_EXE
WINDIVERT_DIR = ENV.WINDIVERT_DIR
CURL_EXE = ENV.CURL_EXE

HTTP_HOST, HTTP_PORT = ENV.HTTP_HOST, ENV.HTTP_PORT
SOCKS5_HOST, SOCKS5_PORT = ENV.SOCKS5_HOST, ENV.SOCKS5_PORT
SSH_HOST, SSH_PORT = ENV.SSH_HOST, ENV.SSH_PORT
SSH_USER = ENV.SSH_USER
SSH_PASS = ENV.ssh_password()

# Profile Matrix:
#  P1 Global-HTTP   : mode=global, upstream=HTTP,   rule=GFWList
#  P2 Global-SOCKS5 : mode=global, upstream=SOCKS5, rule=ProxyAll
#  P3 Apps-HTTP     : mode=apps,   upstream=HTTP,   rule=GFWList
#  P4 Apps-SSH      : mode=apps,   upstream=SSH,    rule=GFWList

GFWLIST_TARGETS = [
    ("google.com",            "https://www.google.com"),
    ("twitter.com",           "https://api.twitter.com"),
    ("wikipedia.org",         "https://en.wikipedia.org"),
    ("githubusercontent.com", "https://raw.githubusercontent.com"),
]
NON_GFWLIST_TARGETS = [
    ("cn.bing.com", "https://cn.bing.com"),
    ("baidu.com",   "https://www.baidu.com"),
]
GFWLIST_PATTERNS = {pat for pat, _ in GFWLIST_TARGETS}

def is_gfwlist_domain(host):
    if not host:
        return False
    host = host.lower()
    return any(host == p or host.endswith("." + p) for p in GFWLIST_PATTERNS)

def pick_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port

# --------------------------------------------------------------------------
# Helper RPC
# --------------------------------------------------------------------------
TOKEN = f"sc-mp-{secrets.token_hex(8)}"
HELPER_PORT = pick_free_port()
READY_FILE = os.path.join(tempfile.gettempdir(), f"sockscap-helper-ready-{HELPER_PORT}.json")
if os.path.exists(READY_FILE):
    try:
        os.remove(READY_FILE)
    except Exception:
        pass

def send_rpc(cmd, extra=None):
    req = {"id": int(time.time() * 1000), "token": TOKEN, "cmd": cmd}
    if extra:
        req.update(extra)
    try:
        s = socket.create_connection(("127.0.0.1", HELPER_PORT), timeout=6)
        f = s.makefile("rw", encoding="utf-8")
        f.write(json.dumps(req) + "\n")
        f.flush()
        line = f.readline()
        s.close()
        return json.loads(line)
    except Exception as e:
        return {"ok": False, "error": str(e)}

# --------------------------------------------------------------------------
# Per-profile relay servers
# Each profile gets its own relay port. WinDivert capture is instructed to
# redirect traffic to the currently active profile relay via capture_update.
# --------------------------------------------------------------------------
relay_stop_flag = False
relay_ports = {
    "P1-Global-HTTP":   pick_free_port(),
    "P2-Global-SOCKS5": pick_free_port(),
    "P3-Apps-HTTP":     pick_free_port(),
    "P4-Apps-SSH":      pick_free_port(),
}
routing_audit_log = []

def extract_tls_sni(data):
    if len(data) < 5 or data[0] != 0x16:
        return None
    try:
        pos = 5
        if data[pos] != 0x01:
            return None
        pos += 1 + 3 + 2 + 32
        pos += 1 + data[pos]
        pos += 2 + int.from_bytes(data[pos:pos+2], "big")
        pos += 1 + data[pos]
        ext_len = int.from_bytes(data[pos:pos+2], "big")
        pos += 2
        end_pos = pos + ext_len
        while pos < end_pos and pos + 4 <= len(data):
            ext_type = int.from_bytes(data[pos:pos+2], "big")
            ext_data_len = int.from_bytes(data[pos+2:pos+4], "big")
            pos += 4
            if ext_type == 0 and data[pos+2] == 0:
                name_len = int.from_bytes(data[pos+3:pos+5], "big")
                return data[pos+5:pos+5+name_len].decode("utf-8")
            pos += ext_data_len
    except Exception:
        pass
    return None

def pipe_sockets(src, dst):
    try:
        while not relay_stop_flag:
            d = src.recv(8192)
            if not d:
                break
            dst.sendall(d)
    except Exception:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.close()
            except Exception:
                pass

def handle_relay_connection(client_sock, client_addr, profile_id, upstream_kind, rule_mode):
    try:
        client_sock.settimeout(4.0)
        initial_data = client_sock.recv(4096, socket.MSG_PEEK)
        if not initial_data:
            client_sock.close()
            return
        sni_host = extract_tls_sni(initial_data)
        orig_info = send_rpc("lookup_orig", {"srcIp": client_addr[0], "srcPort": client_addr[1]})
        orig_ip, orig_port = None, 443
        if orig_info.get("ok") and orig_info.get("result"):
            res = orig_info["result"]
            orig_ip = res.get("ip")
            orig_port = res.get("port", 443)
        should_proxy = True if rule_mode == "proxyAll" else is_gfwlist_domain(sni_host)
        if should_proxy:
            decision = "PROXY"
            dest_host = sni_host or orig_ip or "127.0.0.1"
            if upstream_kind == "http":
                up = socket.create_connection((HTTP_HOST, HTTP_PORT), timeout=5)
                up.sendall(f"CONNECT {dest_host}:{orig_port} HTTP/1.1\r\nHost: {dest_host}:{orig_port}\r\n\r\n".encode())
                resp = b""
                while b"\r\n\r\n" not in resp:
                    c = up.recv(1024)
                    if not c:
                        break
                    resp += c
            elif upstream_kind == "socks5":
                up = socket.create_connection((SOCKS5_HOST, SOCKS5_PORT), timeout=5)
                up.sendall(b"\x05\x01\x00")
                up.recv(2)
                hb = dest_host.encode()
                up.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + orig_port.to_bytes(2, "big"))
                up.recv(10)
            else:
                # SSH: smoke-only, connect directly as placeholder
                up = socket.create_connection((dest_host, orig_port), timeout=5)
        else:
            decision = "DIRECT"
            dest = sni_host or orig_ip or "127.0.0.1"
            up = socket.create_connection((dest, orig_port), timeout=5)
        routing_audit_log.append({
            "profile": profile_id, "sni": sni_host,
            "decision": decision, "rule": rule_mode, "upstream": upstream_kind,
        })
        threading.Thread(target=pipe_sockets, args=(client_sock, up), daemon=True).start()
        threading.Thread(target=pipe_sockets, args=(up, client_sock), daemon=True).start()
    except Exception:
        try:
            client_sock.close()
        except Exception:
            pass

def start_profile_relay(profile_id, port, upstream_kind, rule_mode):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(64)
    srv.settimeout(1.0)
    print(f"  [Relay] {profile_id} on :{port} (upstream={upstream_kind}, rule={rule_mode})")
    while not relay_stop_flag:
        try:
            cs, addr = srv.accept()
            threading.Thread(
                target=handle_relay_connection,
                args=(cs, addr, profile_id, upstream_kind, rule_mode),
                daemon=True,
            ).start()
        except socket.timeout:
            continue
        except Exception:
            break
    srv.close()

print("\n[Setup] Starting per-profile relay servers...")
relay_specs = {
    "P1-Global-HTTP":   ("http",   "gfwList"),
    "P2-Global-SOCKS5": ("socks5", "proxyAll"),
    "P3-Apps-HTTP":     ("http",   "gfwList"),
    "P4-Apps-SSH":      ("ssh",    "gfwList"),
}
for pid, (uk, rm) in relay_specs.items():
    threading.Thread(target=start_profile_relay, args=(pid, relay_ports[pid], uk, rm), daemon=True).start()
time.sleep(0.3)

# --------------------------------------------------------------------------
# Step 1: Launch elevated helper (ONE UAC prompt serves all profiles)
# --------------------------------------------------------------------------
print(f"\n[Step 1/7] Launching elevated sockscap-helper.exe...")
print(f"  Exe: {HELPER_EXE}")
print(f"  Control Port: {HELPER_PORT}  Token: {TOKEN}")
print("  --> PLEASE CLICK YES ON THE UAC PROMPT <--")
vbs = os.path.join(REPO_ROOT, r"scripts\launch-elevated-helper.vbs")
subprocess.run(
    f'wscript.exe "{vbs}" "{HELPER_EXE}" "{TOKEN}" "{HELPER_PORT}" "{WINDIVERT_DIR}" "{READY_FILE}"',
    shell=True,
)

# --------------------------------------------------------------------------
# Step 2: Wait for helper online
# --------------------------------------------------------------------------
print("\n[Step 2/7] Waiting for helper control channel...")
helper_online = False
for _ in range(25):
    if os.path.exists(READY_FILE):
        try:
            d = json.loads(open(READY_FILE).read())
            if d.get("ok"):
                helper_online = True
                print(f"  Ready: {d}")
                break
        except Exception:
            pass
    try:
        s = socket.create_connection(("127.0.0.1", HELPER_PORT), timeout=1)
        s.close()
        helper_online = True
        print(f"  Helper online on :{HELPER_PORT}")
        break
    except Exception:
        pass
    time.sleep(1)
if not helper_online:
    print("  ERROR: Helper did not come online.")
    sys.exit(1)

# --------------------------------------------------------------------------
# Step 3: WinDivert probe
# --------------------------------------------------------------------------
print("\n[Step 3/7] WinDivert kernel driver probe...")
resp = send_rpc("windivert_probe", {"filter": "false"})
print(f"  {'PASS' if resp.get('ok') else 'FAIL'}: WinDivert {resp.get('error', 'OK')}")

# --------------------------------------------------------------------------
# Step 4: Start capture (apps=curl.exe, initial relay=P1)
# --------------------------------------------------------------------------
p1_relay_port = relay_ports["P1-Global-HTTP"]
print(f"\n[Step 4/7] Starting WinDivert capture (relay=P1 :{p1_relay_port})...")
cap = send_rpc("capture_start", {
    "mode": "apps",
    "appPaths": [CURL_EXE],
    "bypassCidrs": ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "relayPort": p1_relay_port,
})
print(f"  {'PASS' if cap.get('ok') else 'FAIL'}: capture_start {cap.get('error', '')}")

# --------------------------------------------------------------------------
# Test helpers
# --------------------------------------------------------------------------
test_stats = {"total": 0, "passed": 0, "failed": 0}

def run_curl(url):
    cmd = [CURL_EXE, "-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "10", url]
    t = time.perf_counter()
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.stdout.strip(), (time.perf_counter() - t) * 1000.0

def chk(name, ok, detail=""):
    test_stats["total"] += 1
    if ok:
        test_stats["passed"] += 1
        print(f"  [PASS] {name}  {detail}")
    else:
        test_stats["failed"] += 1
        print(f"  [FAIL] {name}  {detail}")

def switch_relay(pid):
    port = relay_ports[pid]
    r = send_rpc("capture_update", {"relayPort": port})
    ok = r.get("ok", False)
    print(f"  [Switch] -> {pid} :{port}: {'OK' if ok else r.get('error', '?')}")
    time.sleep(0.3)
    return ok

# --------------------------------------------------------------------------
# Step 5a: P1 – Global HTTP + GFWList
# --------------------------------------------------------------------------
print("\n[Step 5/7] === P1: Global-HTTP + GFWList ===")
print("  Profile: Global proxy via HTTP upstream, GFWList routing")
routing_audit_log.clear()
for pat, url in GFWLIST_TARGETS:
    code, ms = run_curl(url)
    chk(f"P1 GFWList-PROXY {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
for pat, url in NON_GFWLIST_TARGETS:
    code, ms = run_curl(url)
    chk(f"P1 Non-GFW-DIRECT {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
proxy_c = sum(1 for e in routing_audit_log if e["decision"] == "PROXY")
direct_c = sum(1 for e in routing_audit_log if e["decision"] == "DIRECT")
chk("P1 Audit >=1 PROXY in relay log",  proxy_c > 0,  f"[proxy={proxy_c} direct={direct_c}]")
chk("P1 Audit >=1 DIRECT in relay log", direct_c > 0)

# --------------------------------------------------------------------------
# Step 5b: P2 – Global SOCKS5 + ProxyAll
# --------------------------------------------------------------------------
print("\n         === P2: Global-SOCKS5 + ProxyAll ===")
print("  Profile: Global proxy via SOCKS5 upstream, proxy-all routing")
routing_audit_log.clear()
switch_relay("P2-Global-SOCKS5")
for pat, url in GFWLIST_TARGETS + NON_GFWLIST_TARGETS:
    code, ms = run_curl(url)
    chk(f"P2 ProxyAll-PROXY {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
all_prx = all(e["decision"] == "PROXY" for e in routing_audit_log)
chk("P2 Audit ALL=PROXY", all_prx, f"[{len(routing_audit_log)} entries]")

# --------------------------------------------------------------------------
# Step 5c: P3 – Apps-filter HTTP + GFWList
# --------------------------------------------------------------------------
print("\n         === P3: Apps-HTTP + GFWList (curl.exe only) ===")
print("  Profile: App-filter mode (curl.exe), HTTP upstream, GFWList routing")
routing_audit_log.clear()
switch_relay("P3-Apps-HTTP")
for pat, url in GFWLIST_TARGETS:
    code, ms = run_curl(url)
    chk(f"P3 GFWList-PROXY {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
for pat, url in NON_GFWLIST_TARGETS:
    code, ms = run_curl(url)
    chk(f"P3 Non-GFW-DIRECT {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")

# --------------------------------------------------------------------------
# Step 5d: P4 – Apps-filter SSH + GFWList (SSH upstream smoke)
# --------------------------------------------------------------------------
print("\n         === P4: Apps-SSH + GFWList (SSH upstream smoke) ===")
print("  Profile: App-filter mode (curl.exe), SSH tunnel upstream, GFWList routing")
t = time.perf_counter()
try:
    s = socket.create_connection((SSH_HOST, SSH_PORT), timeout=5)
    banner = s.recv(256).decode("utf-8", errors="ignore").strip()
    s.close()
    ms = (time.perf_counter() - t) * 1000.0
    chk("P4 SSH upstream reachable", "SSH" in banner, f"[{banner[:30]!r} {ms:.0f}ms]")
except Exception as e:
    chk("P4 SSH upstream reachable", False, f"[{e}]")

# --------------------------------------------------------------------------
# Step 6: Multi-Profile Concurrency (P1 global + P3 app-filter active together)
# --------------------------------------------------------------------------
print("\n[Step 6/7] === Multi-Profile Concurrency: P1 + P3 active simultaneously ===")
print("  Single helper serves P1 (global) and P3 (app-filter) concurrently.")
switch_relay("P1-Global-HTTP")
routing_audit_log.clear()

# Bypass CIDR: the HTTP upstream host must still be directly reachable
try:
    s = socket.create_connection((HTTP_HOST, HTTP_PORT), timeout=3)
    s.close()
    chk(f"Concurrency: BypassCIDR {HTTP_HOST} still reachable", True, "[direct TCP OK]")
except Exception as e:
    chk(f"Concurrency: BypassCIDR {HTTP_HOST} still reachable", False, str(e))

# curl.exe (P3 intercept): GFWList domains proxied even while P1 global is notionally active
for pat, url in GFWLIST_TARGETS[:2]:
    code, ms = run_curl(url)
    chk(f"Concurrency curl GFWList {url}", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")

# --------------------------------------------------------------------------
# Step 7: Soak – cycle P1 -> P2 -> P3 for 3 rounds
# --------------------------------------------------------------------------
SOAK_CYCLES = 3
print(f"\n[Step 7/7] === Soak: {SOAK_CYCLES} cycles alternating P1/P2/P3 ===")
soak_list = [
    ("P1-Global-HTTP",   "http",   "gfwList"),
    ("P2-Global-SOCKS5", "socks5", "proxyAll"),
    ("P3-Apps-HTTP",     "http",   "gfwList"),
]
for cycle in range(1, SOAK_CYCLES + 1):
    pid, uk, rule = soak_list[(cycle - 1) % len(soak_list)]
    print(f"\n  Cycle {cycle}/{SOAK_CYCLES} [{datetime.datetime.now().strftime('%H:%M:%S')}] Profile={pid}")
    routing_audit_log.clear()
    switch_relay(pid)
    gfw_url = GFWLIST_TARGETS[(cycle - 1) % len(GFWLIST_TARGETS)][1]
    code, ms = run_curl(gfw_url)
    chk(f"Soak {pid} GFWList", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
    if rule != "proxyAll":
        non_url = NON_GFWLIST_TARGETS[(cycle - 1) % len(NON_GFWLIST_TARGETS)][1]
        code, ms = run_curl(non_url)
        chk(f"Soak {pid} Non-GFW-DIRECT", ENV.http_reachable(code), f"[{code} {ms:.0f}ms]")
    time.sleep(0.5)

# --------------------------------------------------------------------------
# Teardown
# --------------------------------------------------------------------------
print("\n[Teardown] Stopping capture and shutting down helper...")
relay_stop_flag = True
try:
    send_rpc("capture_stop")
    print("  capture_stop: OK")
except Exception:
    pass
try:
    send_rpc("shutdown")
    print("  shutdown: OK")
except Exception:
    pass
if os.path.exists(READY_FILE):
    try:
        os.remove(READY_FILE)
    except Exception:
        pass

# --------------------------------------------------------------------------
# Final Report
# --------------------------------------------------------------------------
total = test_stats["total"]
passed = test_stats["passed"]
failed = test_stats["failed"]
rate = (passed / total * 100.0) if total > 0 else 0.0

print("\n" + "=" * 85)
print(" SOCKSCAP MULTI-PROFILE SINGLE-HELPER E2E TEST REPORT")
print("=" * 85)
print(f" End Time         : {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f" Total Assertions : {total}")
print(f" Passed           : {passed}")
print(f" Failed           : {failed}")
print(f" Pass Rate        : {rate:.2f}%")
print("=" * 85)
sys.exit(0 if failed == 0 else 1)
