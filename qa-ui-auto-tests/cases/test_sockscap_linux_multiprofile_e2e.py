"""SocksCap Linux multi-profile E2E (distinct cgroups -> distinct relay ports).

The Linux analogue of test_sockscap_multiprofile_e2e.py. Windows shares one
WinDivert helper and hot-swaps a single relay port; Linux instead gives each
app profile its own capture cgroup and its own relay port, wired by a single
nft table (the `RedirectPlan::new_app_routes` shape in the Rust backend):

    capture-profile-0  -> redirect to :<relay0>   (HTTP upstream)
    capture-profile-1  -> redirect to :<relay1>   (SOCKS5 upstream)

The test proves per-profile isolation: a request made from inside profile-0's
cgroup lands only on relay0 and egresses via HTTP; a request from profile-1's
cgroup lands only on relay1 and egresses via SOCKS5. Cross-contamination (a
request showing up on the wrong relay) fails the test.

Exit codes: 0 all passed · 1 a leg failed · 77 skipped (prereqs unmet).
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _sockscap_linux_env as ENV
import _sockscap_linux_harness as H

SKIP = 77

print("=" * 82)
print(" Taomni SocksCap Linux — Multi-Profile E2E (2 cgroups, 2 relay ports)")
print("=" * 82)

# One GFWList target per profile so each must be PROXIED through its own relay.
PROFILE0_TARGET = "https://www.google.com"       # via relay0 (HTTP)
PROFILE1_TARGET = "https://en.wikipedia.org"     # via relay1 (SOCKS5)

stats = {"total": 0, "passed": 0, "failed": 0}


def record(name, ok, detail=""):
    stats["total"] += 1
    if ok:
        stats["passed"] += 1
        s = "PASS"
    else:
        stats["failed"] += 1
        s = "FAIL"
    print(f"  [{s}] {name:<52} {detail}")


def curl_in(session, index, url):
    argv = [ENV.CURL, "-4", "-s", "-o", "/dev/null",
            "-w", "%{http_code}", "--max-time", "20", url]
    _rc, out, _err = session.run_in_cgroup(index, argv, timeout=25)
    return out.strip()


def main():
    if sys.platform != "linux":
        print(f"  SKIP: not Linux ({sys.platform})")
        return SKIP

    sudo = H.Sudo(ENV.sudo_password())

    print("\n[Step 1/5] Preflight + recover...")
    try:
        sudo.verify()
        for n in H.preflight(sudo):
            print(f"  - {n}")
    except RuntimeError as e:
        print(f"  SKIP: {e}")
        return SKIP
    if not os.path.isfile(ENV.CURL):
        print(f"  SKIP: curl not found at {ENV.CURL}")
        return SKIP
    for err in H.recover(sudo):
        print(f"  WARN: {err}")

    print("\n[Step 2/5] Starting two relays (profile0=HTTP, profile1=SOCKS5)...")
    relay0 = H.Relay(http=(ENV.HTTP_HOST, ENV.HTTP_PORT))
    relay0.upstream_mode = "HTTP"
    relay1 = H.Relay(socks5=(ENV.SOCKS5_HOST, ENV.SOCKS5_PORT))
    relay1.upstream_mode = "SOCKS5"
    p0 = relay0.start()
    p1 = relay1.start()
    print(f"  relay0 (HTTP)   127.0.0.1:{p0}")
    print(f"  relay1 (SOCKS5) 127.0.0.1:{p1}")

    session = H.CaptureSession(sudo)
    try:
        print("\n[Step 3/5] Creating 2 capture cgroups + single nft table with 2 routes...")
        session.create_cgroups(profile_count=2)
        print(f"  profile-0: {session.profile_dirs[0]} -> :{p0}")
        print(f"  profile-1: {session.profile_dirs[1]} -> :{p1}")
        session.install_nft([(0, p0), (1, p1)], ENV.DEFAULT_BYPASS_CIDRS)
        # Both cgroup routes must be present in the one table.
        rc, out, _e = sudo.run([ENV.NFT, "list", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE])
        record("route 0 present (profile-0 -> relay0)",
               f"capture-profile-0\" ip protocol tcp redirect to :{p0}" in out)
        record("route 1 present (profile-1 -> relay1)",
               f"capture-profile-1\" ip protocol tcp redirect to :{p1}" in out)

        print("\n[Step 4/5] Driving each profile and checking isolation...")
        c0 = curl_in(session, 0, PROFILE0_TARGET)
        c1 = curl_in(session, 1, PROFILE1_TARGET)
        time.sleep(0.2)

        a0 = [e for e in relay0.audit if "error" not in e]
        a1 = [e for e in relay1.audit if "error" not in e]

        record("profile-0 request reachable", ENV.http_reachable(c0), f"code={c0}")
        record("profile-1 request reachable", ENV.http_reachable(c1), f"code={c1}")
        record("relay0 saw exactly profile-0's request", len(a0) == 1,
               f"count={len(a0)} sni={a0[-1].get('sni') if a0 else None}")
        record("relay1 saw exactly profile-1's request", len(a1) == 1,
               f"count={len(a1)} sni={a1[-1].get('sni') if a1 else None}")
        record("relay0 egressed via HTTP",
               bool(a0) and a0[-1].get("mode") == "HTTP" and a0[-1].get("decision") == "PROXY")
        record("relay1 egressed via SOCKS5",
               bool(a1) and a1[-1].get("mode") == "SOCKS5" and a1[-1].get("decision") == "PROXY")
        # No cross-contamination: neither relay saw the other's SNI.
        record("no cross-contamination relay0",
               all("wikipedia" not in (e.get("sni") or "") for e in a0))
        record("no cross-contamination relay1",
               all("google" not in (e.get("sni") or "") for e in a1))
    finally:
        print("\n[Step 5/5] Teardown + verify clean...")
        relay0.stop()
        relay1.stop()
        for e in session.cleanup():
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

