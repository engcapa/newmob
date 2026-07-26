"""SocksCap Linux full-link app-mode E2E (nft + cgroup v2 + relay, sudo-driven).

The Linux analogue of test_sockscap_driver_e2e.py. Where the Windows test
launches an elevated WinDivert helper via UAC, this drives the real Linux
capture mechanism directly with sudo:

    sudo mkdir  /sys/fs/cgroup/taomni-sockscap-<pid>/capture-profile-0
    sudo nft -f -   (inet taomni_sockscap OUTPUT nat redirect for that cgroup)
    sudo sh -c 'echo $$ > .../cgroup.procs && exec curl ...'   (curl in-cgroup)

curl's TCP is REDIRECTed by the kernel to a loopback relay; the relay recovers
the pre-NAT destination with SO_ORIGINAL_DST, reads the TLS SNI, applies
GFWList routing, and forwards to the HTTP/SOCKS5 upstream (or direct). Routing
correctness is asserted from the relay's audit log, exactly like the Windows
driver test.

REQUIREMENTS (the script preflights and skips cleanly if unmet):
  * Linux with cgroup v2 mounted at /sys/fs/cgroup
  * nftables usable under sudo (CAP_NET_ADMIN) with `socket cgroupv2` support
  * reachable upstreams (QA_HTTP_PROXY_*, QA_SOCKS5_PROXY_*) — see _sockscap_env
  * curl on PATH

Exit codes: 0 all passed · 1 a leg failed · 77 skipped (prereqs unmet).
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_linux_env as ENV
import _sockscap_linux_harness as H

SKIP = 77

print("=" * 82)
print(" Taomni SocksCap Linux — Full-Link App-Mode E2E (nft + cgroup v2 + relay)")
print("=" * 82)

GFWLIST_TARGETS = [
    "https://www.google.com",
    "https://api.twitter.com",
    "https://en.wikipedia.org",
    "https://raw.githubusercontent.com",
]
NON_GFWLIST_TARGETS = [
    "https://cn.bing.com",
    "https://www.baidu.com",
]
SOAK_CYCLES = int(os.getenv("SOCKSCAP_SOAK_CYCLES", "3"))

stats = {"total": 0, "passed": 0, "failed": 0}


def record(name, ok, detail=""):
    stats["total"] += 1
    if ok:
        stats["passed"] += 1
        s = "PASS"
    else:
        stats["failed"] += 1
        s = "FAIL"
    print(f"  [{s}] {name:<48} {detail}")


def run_curl_in_cgroup(session, url):
    """curl the URL as a member of capture-profile-0; -4 pins IPv4 (nft is v4)."""
    argv = [ENV.CURL, "-4", "-s", "-o", "/dev/null",
            "-w", "%{http_code}", "--max-time", "20", url]
    rc, out, _err = session.run_in_cgroup(0, argv, timeout=25)
    return out.strip()


def main():
    if sys.platform != "linux":
        print(f"  SKIP: not Linux ({sys.platform})")
        return SKIP

    sudo = H.Sudo(ENV.sudo_password())

    print("\n[Step 1/6] Preflight (sudo, nftables, cgroup v2)...")
    try:
        sudo.verify()
        notes = H.preflight(sudo)
        for n in notes:
            print(f"  - {n}")
        print("  RESULT: PASS [privileged prerequisites present]")
    except RuntimeError as e:
        print(f"  SKIP: {e}")
        return SKIP

    if not os.path.isfile(ENV.CURL):
        print(f"  SKIP: curl not found at {ENV.CURL}")
        return SKIP

    print("\n[Step 2/6] Clearing any residual SocksCap capture state (recover)...")
    for err in H.recover(sudo):
        print(f"  WARN: {err}")

    print("\n[Step 3/6] Starting loopback relay (HTTP + SOCKS5 upstreams)...")
    relay = H.Relay(
        http=(ENV.HTTP_HOST, ENV.HTTP_PORT),
        socks5=(ENV.SOCKS5_HOST, ENV.SOCKS5_PORT),
    )
    relay_port = relay.start()
    print(f"  Relay listening on 127.0.0.1:{relay_port}")

    session = H.CaptureSession(sudo)
    try:
        print("\n[Step 4/6] Creating capture cgroup + installing nft redirect...")
        session.create_cgroups(profile_count=1)
        print(f"  cgroup: {session.profile_dirs[0]}")
        session.install_nft([(0, relay_port)], ENV.DEFAULT_BYPASS_CIDRS)
        record("nft redirect installed", session.residue()[0])
        # Prove the residue carries the ownership marker a real Start leaves.
        rc, out, _e = sudo.run([ENV.NFT, "list", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE])
        record("nft table carries ownership marker", ENV.OWNERSHIP_MARKER in out)

        print(f"\n[Step 5/6] Soak matrix ({SOAK_CYCLES} cycles, HTTP/SOCKS5 alternating)...")
        for cycle in range(1, SOAK_CYCLES + 1):
            mode = "HTTP" if cycle % 2 == 1 else "SOCKS5"
            relay.upstream_mode = mode
            print(f"\n  Cycle {cycle}/{SOAK_CYCLES} [{time.strftime('%H:%M:%S')}] upstream={mode}")
            for url in GFWLIST_TARGETS:
                host = url.split("://", 1)[1].split("/", 1)[0]
                before = len(relay.audit)
                code = run_curl_in_cgroup(session, url)
                entry = relay.audit[-1] if len(relay.audit) > before else {}
                ok = (
                    ENV.http_reachable(code)
                    and entry.get("gfwlist_match") is True
                    and entry.get("decision") == "PROXY"
                )
                record(f"[{mode}] GFWList {host}", ok,
                       f"code={code} sni={entry.get('sni')} decision={entry.get('decision')}")
            for url in NON_GFWLIST_TARGETS:
                host = url.split("://", 1)[1].split("/", 1)[0]
                before = len(relay.audit)
                code = run_curl_in_cgroup(session, url)
                entry = relay.audit[-1] if len(relay.audit) > before else {}
                # Non-GFWList still transits the relay (it was captured), but the
                # relay must route it DIRECT rather than through an upstream.
                ok = ENV.http_reachable(code) and entry.get("decision") == "DIRECT"
                record(f"[{mode}] Direct  {host}", ok,
                       f"code={code} decision={entry.get('decision')}")
            time.sleep(0.3)
    finally:
        print("\n[Step 6/6] Teardown (nft table + cgroup tree) and verify clean...")
        relay.stop()
        errors = session.cleanup()
        for e in errors:
            print(f"  WARN: {e}")
        table_present, dir_present = session.residue()
        record("nft table removed after teardown", not table_present)
        record("cgroup session dir removed after teardown", not dir_present)

    print("\n" + "=" * 82)
    rate = (stats["passed"] / stats["total"] * 100.0) if stats["total"] else 0.0
    print(f" Total {stats['total']} | Passed {stats['passed']} | "
          f"Failed {stats['failed']} | Pass rate {rate:.1f}%")
    print("=" * 82)
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())

