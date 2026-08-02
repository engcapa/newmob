"""SocksCap Linux mixed-profile E2E (app relay -> global catch-all relay).

This reproduces the production priority topology from the original regression:

    priority 1 application + proxyAll -> dedicated app relay (HTTP upstream)
    priority 2 global + gfwList       -> final catch-all relay (SOCKS5 upstream)

The test proves the application cgroup rule precedes the bare global redirect,
and that both routes work simultaneously without cross-contamination.

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
print(" Taomni SocksCap Linux — Mixed-Profile E2E (app relay + global fallback)")
print("=" * 82)

# The app target intentionally misses GFWList: proxyAll must still proxy it.
APP_TARGET = "https://www.baidu.com"             # app relay (HTTP)
GLOBAL_TARGET = "https://en.wikipedia.org"       # global GFWList (SOCKS5)

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


def curl_in_app(session, url):
    argv = [ENV.CURL, "-4", "-s", "-o", "/dev/null",
            "-w", "%{http_code}", "--max-time", "20", url]
    _rc, out, _err = session.run_in_cgroup(0, argv, timeout=25)
    return out.strip()


def curl_in_global(session, url):
    argv = [ENV.CURL, "-4", "-s", "-o", "/dev/null",
            "-w", "%{http_code}", "--max-time", "20", url]
    _rc, out, _err = session.run_global(argv, timeout=25)
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

    print("\n[Step 2/5] Starting app proxyAll + global GFWList relays...")
    app_relay = H.Relay(
        http=(ENV.HTTP_HOST, ENV.HTTP_PORT), rule_mode="proxyAll"
    )
    app_relay.upstream_mode = "HTTP"
    global_relay = H.Relay(socks5=(ENV.SOCKS5_HOST, ENV.SOCKS5_PORT))
    global_relay.upstream_mode = "SOCKS5"
    app_port = app_relay.start()
    global_port = global_relay.start()
    print(f"  app relay (HTTP/proxyAll)       127.0.0.1:{app_port}")
    print(f"  global relay (SOCKS5/gfwList)  127.0.0.1:{global_port}")

    session = H.CaptureSession(sudo)
    try:
        print("\n[Step 3/5] Creating mixed cgroups + ordered nft routes...")
        session.create_cgroups(profile_count=1, mixed=True)
        print(f"  app profile: {session.profile_dirs[0]} -> :{app_port}")
        print(f"  global catch-all -> :{global_port}")
        session.install_nft(
            [(0, app_port)],
            ENV.DEFAULT_BYPASS_CIDRS,
            global_relay_port=global_port,
        )
        rc, out, _e = sudo.run([ENV.NFT, "list", "table", ENV.NFT_FAMILY, ENV.NFT_TABLE])
        app_rule = f"capture-profile-0\" ip protocol tcp redirect to :{app_port}"
        global_rule = f"ip protocol tcp redirect to :{global_port}"
        record("application route present", app_rule in out)
        record("global catch-all route present", global_rule in out)
        record(
            "application route precedes global catch-all",
            out.find(app_rule) >= 0 and out.find(app_rule) < out.find(global_rule),
        )

        print("\n[Step 4/5] Driving application and global traffic...")
        app_code = curl_in_app(session, APP_TARGET)
        global_code = curl_in_global(session, GLOBAL_TARGET)
        time.sleep(0.2)

        app_audit = [e for e in app_relay.audit if "error" not in e]
        global_audit = [e for e in global_relay.audit if "error" not in e]

        record("application request reachable", ENV.http_reachable(app_code), f"code={app_code}")
        record("global request reachable", ENV.http_reachable(global_code), f"code={global_code}")
        record("app relay saw only the app request", len(app_audit) == 1,
               f"count={len(app_audit)} sni={app_audit[-1].get('sni') if app_audit else None}")
        record("global relay saw only fallback traffic", len(global_audit) == 1,
               f"count={len(global_audit)} sni={global_audit[-1].get('sni') if global_audit else None}")
        record("app proxyAll proxied a GFWList miss",
               bool(app_audit) and not app_audit[-1].get("gfwlist_match")
               and app_audit[-1].get("decision") == "PROXY")
        record("global GFWList used SOCKS5",
               bool(global_audit) and global_audit[-1].get("gfwlist_match")
               and global_audit[-1].get("mode") == "SOCKS5"
               and global_audit[-1].get("decision") == "PROXY")
        record("app relay did not see global traffic",
               all("wikipedia" not in (e.get("sni") or "") for e in app_audit))
        record("global relay did not see app traffic",
               all("baidu" not in (e.get("sni") or "") for e in global_audit))
    finally:
        print("\n[Step 5/5] Teardown + verify clean...")
        app_relay.stop()
        global_relay.stop()
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
