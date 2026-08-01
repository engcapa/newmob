# SocksCap Linux runtime

The Linux capture backend uses `nftables` OUTPUT NAT plus cgroup v2 process
matching. Redirected TCP connections enter Taomni's loopback relay, which reads
the original destination through `SO_ORIGINAL_DST` and applies the normal
SocksCap rule and upstream policy.

## Runtime requirements

- A Linux kernel with nftables and cgroup v2 enabled.
- The `nft` executable (the DEB/RPM bundle declares an `nftables` dependency).
- Permission to create and move cgroups under `/sys/fs/cgroup`, and
  `CAP_NET_ADMIN` to install the temporary nftables table. A regular desktop
  session normally needs an administrator-approved, narrowly scoped launcher
  or a delegated cgroup from its service manager.

The application deliberately does **not** grant the full GUI process broad
Linux capabilities during installation. Operators should provision the least
privilege mechanism appropriate for their desktop policy rather than applying
`CAP_SYS_ADMIN` to Taomni wholesale.

## Lifecycle and recovery

While active, SocksCap owns only its marked `inet taomni_sockscap` nftables
table and creates cgroups named `taomni-sockscap-<pid>`. Stop removes the table
before the relay and restores moved processes to their original cgroups.
Normal application exit and updater relaunch run the same teardown before the
process terminates; if cleanup fails, the transition is blocked so the user can
retry or run **Recover network**.

**Recover network** removes a residual table after an unclean shutdown only
when its ownership marker is present, and only deletes empty generated cgroups;
it never moves an unrelated live process. Desktop sessions request sudo
authorization when that recovery needs `CAP_NET_ADMIN` or cgroup permissions.

## xray-core (core-backed upstreams)

Shadowsocks / Trojan / VMess / VLESS / WireGuard upstreams are served by a
bundled `xray` process (xray-core, MPL-2.0), spawned with a loopback SOCKS
inbound the relay dials through. The binary is a third-party redistributable and
is **not committed** — stage it before packaging:

```bash
pwsh scripts/fetch-xray.ps1 -Platform linux
```

The script pins the release tag and verifies a SHA256 before extracting `xray`
here. The runtime resolves it via `sockscap::paths::resolve_xray_exe` (override
with `SOCKSCAP_XRAY_DIR` / `SOCKSCAP_XRAY_EXE`). A missing xray only disables
core-backed upstreams; native HTTP / SOCKS5 / SSH upstreams and capture are
unaffected.
