# Backend tests

Unit tests live inline in each module (`#[cfg(test)]`). Integration tests live
under this directory as a **single** Cargo test binary
(`tests/integration/main.rs` + sibling modules), so `cargo test` only links
one heavy executable instead of one per former top-level file (large
`target/` savings).

## Recommended day-to-day commands

Prefer the library unit tests while iterating — they do not build the
integration binary or the `acp-fake-agent` helper:

```bash
cargo test --lib
cargo test --lib sockscap::          # filter by module path
```

Run the unified integration suite when needed:

```bash
cargo test --test integration
cargo test --test integration router_routing
```

Full suite (lib + integration + bins that have tests):

```bash
cargo test
```

## Layout

| Path | Role |
| --- | --- |
| `tests/integration/main.rs` | Single integration-test crate root (modules only) |
| `tests/integration/*.rs` | Integration cases (former top-level `tests/*.rs`) |
| `tests/integration/support/` | Shared mocks for the integration crate |
| `tests/support/acp_fake_agent.rs` | `[[bin]] acp-fake-agent` fixture (not a test target) |

## Network / proxy / SSH jump-host tests

The proxy-handshake tests are **self-contained** and run by default: they spin
up an in-process SOCKS5 / HTTP CONNECT proxy and a loopback echo server, then
drive the real client handshake through them. No configuration needed.

- `terminal::network::tests::socks5_handshake_round_trips_through_real_proxy`
- `terminal::network::tests::http_connect_handshake_round_trips_through_real_proxy`
- `terminal::network::tests::socks5_handshake_with_username_password_auth`
- `database::forward::tests::loopback_forward_bridges_through_socks5_to_target`

## SocksCap xray-core tests

`integration/sockscap_xray_core.rs` has two tiers. The config-generation and
manager-guard tests are pure and always run. The live lifecycle test
(`xray_core_lifecycle_spawn_reuse_shutdown`) spawns a real `xray` process and
**skips silently** unless a binary is locatable:

| Variable | Purpose |
| --- | --- |
| `SOCKSCAP_XRAY_EXE` | Absolute path to an `xray` binary |
| `SOCKSCAP_XRAY_DIR` | Directory containing `xray[.exe]` |

If neither is set, it falls back to a staged
`resources/sockscap/<platform>/xray[.exe]` (run `scripts/fetch-xray.ps1` to
stage one). The live test uses an unreachable server, so it needs no network.

## Live tests (opt-in, real SSH server)

Tests that reach a real SSH server are marked `#[ignore]` and **skip silently**
when their environment variables are unset. They never contain hard-coded
credentials — everything comes from the environment.

Run them explicitly with:

```bash
cargo test -- --ignored
```

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `TAOMNI_LIVE_SSH_HOST` | SSH server host | (required) |
| `TAOMNI_LIVE_SSH_USER` | SSH username | (required) |
| `TAOMNI_LIVE_SSH_PASSWORD` | SSH password | (required) |
| `TAOMNI_LIVE_SSH_PORT` | SSH port | `22` |
| `TAOMNI_INTERNAL_HOST` | Host reachable *through* the jump host (for the jump-host test) | (required for that test) |
| `TAOMNI_INTERNAL_PORT` | Port on the internal host | `22` |
| `TAOMNI_INTERNAL_USER` | Username on the internal host | falls back to `TAOMNI_LIVE_SSH_USER` |
| `TAOMNI_INTERNAL_PASSWORD` | Password on the internal host | falls back to `TAOMNI_LIVE_SSH_PASSWORD` |

### What each live test covers

- `terminal::ssh::tests::live_ssh_through_socks5_proxy` — authenticates to the
  live SSH server through an in-process SOCKS5 proxy (Strategy 2: proxy → real
  SSH end-to-end).
- `terminal::ssh::tests::live_ssh_through_jump_host` — connects to
  `TAOMNI_INTERNAL_HOST` *through* the live SSH server acting as a jump host.
- `terminal::ssh::tests::live_terminal_survives_vi_quit_and_followup_input` —
  pre-existing terminal smoke test.

> Strategy 3 (a real third-party HTTP/SOCKS5 proxy via `TAOMNI_PROXY_*`) is not
> wired up yet — add it once a proxy is available in the test environment.

## Disk / profile notes

`Cargo.toml` sets `profile.dev` / `profile.test` to `debug = 1` and turns off
debug info on dependency crates (`profile.dev.package."*".debug = false`) so
`target/` grows more slowly. Do not keep parallel long-lived trees (e.g. host
`target/debug` plus `target/<triple>/` plus `release`) unless you need them;
`cargo clean` (or deleting `target/`) reclaims space after large experiments.
