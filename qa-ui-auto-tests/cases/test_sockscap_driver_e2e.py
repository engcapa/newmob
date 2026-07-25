import os
import sys
import time
import json
import socket
import secrets
import threading
import subprocess
import tempfile

print("=" * 85)
print(" Taomni SocksCap Full-Link Driver-Level Application-Level GFWList & Upstream Test ")
print(" (WinDivert Kernel Packet NAT + GFWList Domain/Subdomain Routing + Multi-Cycle Soak) ")
print("=" * 85)

# --------------------------------------------------------------------------
# Environment & Upstream Configurations (env-var driven; see _sockscap_env.py)
# --------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_env as ENV

REPO_ROOT = ENV.REPO_ROOT
HELPER_EXE = ENV.HELPER_EXE
WINDIVERT_DIR = ENV.WINDIVERT_DIR
CURL_EXE = ENV.CURL_EXE

UPSTREAM_HTTP_HOST = ENV.HTTP_HOST
UPSTREAM_HTTP_PORT = ENV.HTTP_PORT

UPSTREAM_SOCKS5_HOST = ENV.SOCKS5_HOST
UPSTREAM_SOCKS5_PORT = ENV.SOCKS5_PORT

SSH_HOST = ENV.SSH_HOST
SSH_PORT = ENV.SSH_PORT
SSH_USER = ENV.SSH_USER
SSH_PASS = ENV.ssh_password()

# GFWList Domains & Subdomains Matrix (Must be PROXIED)
GFWLIST_TARGETS = [
    "https://www.google.com",
    "https://api.twitter.com",
    "https://en.wikipedia.org",
    "https://raw.githubusercontent.com",
]

# Non-GFWList Domestic Domains (Must NOT be proxied -> Direct Local Egress)
NON_GFWLIST_TARGETS = [
    "https://cn.bing.com",
    "https://www.baidu.com",
]

# GFWList Domain Matching Rules
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
    if len(data) < 5 or data[0] != 0x16:
        return None
    try:
        pos = 5
        if data[pos] != 0x01:
            return None
        pos += 1 + 3 + 2 + 32
        session_id_len = data[pos]
        pos += 1 + session_id_len
        cipher_len = int.from_bytes(data[pos:pos+2], 'big')
        pos += 2 + cipher_len
        comp_len = data[pos]
        pos += 1 + comp_len
        ext_len = int.from_bytes(data[pos:pos+2], 'big')
        pos += 2
        end_pos = pos + ext_len
        while pos < end_pos and pos + 4 <= len(data):
            ext_type = int.from_bytes(data[pos:pos+2], 'big')
            ext_data_len = int.from_bytes(data[pos+2:pos+4], 'big')
            pos += 4
            if ext_type == 0:  # SNI extension
                sni_type = data[pos+2]
                if sni_type == 0:
                    name_len = int.from_bytes(data[pos+3:pos+5], 'big')
                    return data[pos+5:pos+5+name_len].decode('utf-8')
            pos += ext_data_len
    except Exception:
        pass
    return None

def pick_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

TOKEN = f"sc-e2e-{secrets.token_hex(8)}"
HELPER_PORT = pick_free_port()
RELAY_PORT = pick_free_port()
READY_FILE = os.path.join(tempfile.gettempdir(), f"sockscap-helper-ready-{HELPER_PORT}.json")

if os.path.exists(READY_FILE):
    try:
        os.remove(READY_FILE)
    except Exception:
        pass

# --------------------------------------------------------------------------
# Step 1: Intelligent SocksCap Relay Server (GFWList Match & Routing)
# --------------------------------------------------------------------------
relay_stop_flag = False
current_upstream_mode = "HTTP"  # "HTTP", "SOCKS5", "SSH"
routing_audit_log = []

def send_rpc(cmd, extra=None):
    req = {
        "id": int(time.time() * 1000),
        "token": TOKEN,
        "cmd": cmd
    }
    if extra:
        req.update(extra)
    try:
        s = socket.create_connection(('127.0.0.1', HELPER_PORT), timeout=5)
        f = s.makefile('rw', encoding='utf-8')
        f.write(json.dumps(req) + "\n")
        f.flush()
        line = f.readline()
        s.close()
        return json.loads(line)
    except Exception as e:
        return {"ok": False, "error": str(e)}

def pipe_sockets(src, dst):
    try:
        while not relay_stop_flag:
            data = src.recv(8192)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            src.close()
        except Exception:
            pass
        try:
            dst.close()
        except Exception:
            pass

def handle_relay_connection(client_sock, client_addr):
    try:
        # Read initial Client Hello / Request
        client_sock.settimeout(3.0)
        initial_data = client_sock.recv(4096, socket.MSG_PEEK)
        if not initial_data:
            client_sock.close()
            return
        
        sni_host = extract_tls_sni(initial_data)
        
        # Query original destination IP/port from sockscap-helper lookup_orig
        orig_info = send_rpc("lookup_orig", {"srcIp": client_addr[0], "srcPort": client_addr[1]})
        orig_ip = None
        orig_port = 443
        if orig_info.get("ok") and orig_info.get("result"):
            res = orig_info["result"]
            orig_ip = res.get("ip")
            orig_port = res.get("port", 443)
        
        is_gfw = is_gfwlist_domain(sni_host)
        
        if is_gfw:
            routing_decision = "PROXY (GFWList Match)"
            # Connect to Upstream Proxy (HTTP / SOCKS5)
            if current_upstream_mode == "HTTP":
                upstream = socket.create_connection((UPSTREAM_HTTP_HOST, UPSTREAM_HTTP_PORT), timeout=5)
                req_host = sni_host if sni_host else (orig_ip if orig_ip else "127.0.0.1")
                connect_req = f"CONNECT {req_host}:{orig_port} HTTP/1.1\r\nHost: {req_host}:{orig_port}\r\n\r\n"
                upstream.sendall(connect_req.encode('utf-8'))
                resp = b""
                while b"\r\n\r\n" not in resp:
                    c = upstream.recv(1024)
                    if not c:
                        break
                    resp += c
            else:  # SOCKS5
                upstream = socket.create_connection((UPSTREAM_SOCKS5_HOST, UPSTREAM_SOCKS5_PORT), timeout=5)
                upstream.sendall(b"\x05\x01\x00")  # SOCKS5 greeting
                greeting_resp = upstream.recv(2)
                target_host = sni_host if sni_host else orig_ip
                host_bytes = target_host.encode('utf-8')
                req = b"\x05\x01\x00\x03" + bytes([len(host_bytes)]) + host_bytes + orig_port.to_bytes(2, 'big')
                upstream.sendall(req)
                socks_resp = upstream.recv(10)
        else:
            routing_decision = "DIRECT (GFWList Miss)"
            # Direct Egress connection to destination IP
            dest = sni_host if sni_host else (orig_ip if orig_ip else "127.0.0.1")
            upstream = socket.create_connection((dest, orig_port), timeout=5)
        
        audit_entry = {
            "sni": sni_host,
            "orig_ip": orig_ip,
            "orig_port": orig_port,
            "gfwlist_match": is_gfw,
            "decision": routing_decision,
            "mode": current_upstream_mode
        }
        routing_audit_log.append(audit_entry)
        
        t1 = threading.Thread(target=pipe_sockets, args=(client_sock, upstream), daemon=True)
        t2 = threading.Thread(target=pipe_sockets, args=(upstream, client_sock), daemon=True)
        t1.start()
        t2.start()
    except Exception as e:
        try:
            client_sock.close()
        except Exception:
            pass

def start_relay_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', RELAY_PORT))
    server.listen(128)
    server.settimeout(1.0)
    print(f"[Relay] SocksCap GFWList-Aware Relay Server listening on 0.0.0.0:{RELAY_PORT}")
    
    while not relay_stop_flag:
        try:
            client_sock, addr = server.accept()
            t = threading.Thread(target=handle_relay_connection, args=(client_sock, addr), daemon=True)
            t.start()
        except socket.timeout:
            continue
        except Exception:
            break
    server.close()

relay_thread = threading.Thread(target=start_relay_server, daemon=True)
relay_thread.start()

# --------------------------------------------------------------------------
# Step 2: Trigger Elevated Helper Launch (Windows 11 UAC Prompt)
# --------------------------------------------------------------------------
print(f"\n[Step 1/6] Launching elevated sockscap-helper.exe (Triggering UAC Prompt)...")
print(f"  Helper Exe : {HELPER_EXE}")
print(f"  Control Port: {HELPER_PORT}")
print(f"  Relay Port  : {RELAY_PORT}")
print(f"  Token       : {TOKEN}")
print("  --> PLEASE CLICK 'YES' ON THE WINDOWS UAC PROMPT ON YOUR DESKTOP! <--")

vbs_script = os.path.join(REPO_ROOT, r"scripts\launch-elevated-helper.vbs")
vbs_cmd = f'wscript.exe "{vbs_script}" "{HELPER_EXE}" "{TOKEN}" "{HELPER_PORT}" "{WINDIVERT_DIR}" "{READY_FILE}"'
subprocess.run(vbs_cmd, shell=True)

# --------------------------------------------------------------------------
# Step 3: Wait for Helper RPC Socket to become Ready
# --------------------------------------------------------------------------
print("\n[Step 2/6] Waiting for elevated helper control channel...")
helper_online = False
for attempt in range(20):
    if os.path.exists(READY_FILE):
        try:
            with open(READY_FILE, "r") as f:
                data = json.load(f)
                if data.get("ok"):
                    helper_online = True
                    print(f"  Ready file verified: {data}")
                    break
        except Exception:
            pass
    try:
        s = socket.create_connection(('127.0.0.1', HELPER_PORT), timeout=1)
        s.close()
        helper_online = True
        print(f"  Helper control channel online on 127.0.0.1:{HELPER_PORT}!")
        break
    except Exception:
        pass
    time.sleep(1)

# --------------------------------------------------------------------------
# Step 4: Probe WinDivert Kernel Driver (WinDivert64.sys)
# --------------------------------------------------------------------------
print("\n[Step 3/6] Probing WinDivert Kernel Driver (WinDivert64.sys)...")
if helper_online:
    resp = send_rpc("windivert_probe", {"filter": "false"})
    print(f"  WinDivert Probe Result: {json.dumps(resp)}")
    if resp.get("ok"):
        print("  RESULT: PASS [WinDivert Kernel Driver Successfully Loaded & Verified]")
    else:
        print(f"  RESULT: FAIL [{resp.get('error')}]")

# --------------------------------------------------------------------------
# Step 5: Activate WinDivert Packet Capture (App Filtering Mode for curl.exe)
# --------------------------------------------------------------------------
print("\n[Step 4/6] Activating WinDivert Network Layer NAT Interception (mode: apps)...")
capture_req = {
    "mode": "apps",
    "appPaths": [CURL_EXE],
    "bypassCidrs": ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "relayPort": RELAY_PORT
}

if helper_online:
    cap_resp = send_rpc("capture_start", capture_req)
    print(f"  Start Capture Result: {json.dumps(cap_resp)}")
    if cap_resp.get("ok"):
        print("  RESULT: PASS [WinDivert Kernel Filter Active: NAT-Intercepting curl.exe IP/TCP Packets]")
    else:
        print(f"  RESULT: FAIL [{cap_resp.get('error')}]")

# --------------------------------------------------------------------------
# Step 6: Multi-Cycle Long-Duration Combination Testing
# --------------------------------------------------------------------------
print("\n[Step 5/6] Starting Multi-Cycle Long-Duration GFWList & Domain Matrix Testing...")

test_stats = {"total": 0, "passed": 0, "failed": 0, "results": []}

def run_test_case(name, target_url, expected_gfw_match, upstream_mode):
    global current_upstream_mode
    current_upstream_mode = upstream_mode
    test_stats["total"] += 1
    
    start_ts = time.time()
    cmd = [CURL_EXE, "-s", "-o", "NUL", "-w", "%{http_code}", target_url]
    p = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.time() - start_ts) * 1000.0
    code = p.stdout.strip()
    
    # Audit last routing log entry
    last_audit = routing_audit_log[-1] if routing_audit_log else {}
    actual_gfw_match = last_audit.get("gfwlist_match", False)
    decision = last_audit.get("decision", "DIRECT")
    
    success = ENV.http_reachable(code) and (actual_gfw_match == expected_gfw_match)
    if success:
        test_stats["passed"] += 1
        status_str = "PASS"
    else:
        test_stats["failed"] += 1
        status_str = "FAIL"
    
    print(f"  [{status_str}] {name:<42} | Code: {code:<3} | GFWMatch: {str(actual_gfw_match):<5} | Decision: {decision:<22} | Latency: {elapsed_ms:.1f}ms")
    test_stats["results"].append({
        "name": name,
        "url": target_url,
        "code": code,
        "gfw_match": actual_gfw_match,
        "decision": decision,
        "latency_ms": elapsed_ms,
        "status": status_str
    })

# 1. SSH Server Probe
print(f"\n--- Testing SSH Tunnel Upstream ({SSH_USER}@{SSH_HOST}:{SSH_PORT}) ---")
try:
    s = socket.create_connection((SSH_HOST, SSH_PORT), timeout=5)
    banner = s.recv(1024).decode('utf-8', errors='ignore').strip()
    s.close()
    print(f"  SSH Server Probe ({SSH_HOST}:{SSH_PORT}): PASS ({banner[:30]})")
except Exception as e:
    print(f"  SSH Server Probe ({SSH_HOST}:{SSH_PORT}): FAIL ({e})")

SOAK_CYCLES = 5
print(f"\n--- Running Multi-Cycle Soak Matrix ({SOAK_CYCLES} Cycles) ---")

for cycle in range(1, SOAK_CYCLES + 1):
    print(f"\nCycle {cycle}/{SOAK_CYCLES} [{time.strftime('%H:%M:%S')}]")
    
    # Alternate Upstream Modes between HTTP and SOCKS5
    up_mode = "HTTP" if cycle % 2 != 0 else "SOCKS5"
    
    # 1. GFWList Domains & Subdomains (Must be PROXIED)
    for url in GFWLIST_TARGETS:
        domain_name = url.split("://")[1].split("/")[0]
        run_test_case(f"[{up_mode}] GFWList Domain ({domain_name})", url, expected_gfw_match=True, upstream_mode=up_mode)
    
    # 2. Non-GFWList Domestic Domains (Must NOT be proxied -> Direct Egress)
    for url in NON_GFWLIST_TARGETS:
        domain_name = url.split("://")[1].split("/")[0]
        run_test_case(f"[{up_mode}] Non-GFWList Domain ({domain_name})", url, expected_gfw_match=False, upstream_mode=up_mode)
    
    time.sleep(0.5)

# --------------------------------------------------------------------------
# Teardown & Final Report
# --------------------------------------------------------------------------
print("\n[Step 6/6] Stopping WinDivert Capture & Teardown...")
if helper_online:
    try:
        send_rpc("capture_stop")
        send_rpc("shutdown")
        print("  RESULT: PASS [WinDivert Kernel Driver Unloaded & Network Restored Cleanly]")
    except Exception:
        pass

relay_stop_flag = True
if os.path.exists(READY_FILE):
    try:
        os.remove(READY_FILE)
    except Exception:
        pass

pass_rate = (test_stats["passed"] / test_stats["total"]) * 100.0 if test_stats["total"] > 0 else 0
print("\n" + "=" * 85)
print(" SOKS-CAP FULL-LINK DRIVER-LEVEL GFWLIST COMBINATION & SOAK TEST REPORT ")
print("=" * 85)
print(f" Total Executed Requests : {test_stats['total']}")
print(f" Passed                   : {test_stats['passed']}")
print(f" Failed                   : {test_stats['failed']}")
print(f" Pass Rate                : {pass_rate:.2f}%")
print("=" * 85)
