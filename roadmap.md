# Taomni Roadmap

> Status: living roadmap, refreshed 2026-08-05. The current application version is `0.4.9`; `package.json` remains the release-version source of truth.

## Direction

Taomni is a local-first, AI-assisted desktop workspace. Near-term work is focused on making the already broad feature set reliable across real Windows, macOS, and Linux environments rather than adding another layer of disconnected prototypes.

The product continues to prioritize user-owned data, offline-capable core workflows, explicit AI permissions, and honest platform capability reporting.

## Current product baseline

Delivered foundations include:

- local/SSH terminals, SFTP, tunnels, split view, MultiExec, capture, profiles, and session import/export;
- VNC and RDP clients and built-in local server management;
- SQL, Redis, HBase, object-storage, and mail workspaces;
- encrypted credentials, local notes, LAN collaboration, and automatic-update client support;
- AI chat, local/cloud providers, voice input, command assistance, web search, MCP tools, and Claude Code/Codex/ACP agents;
- Code Workspace editing, Git integration, LSP navigation, and initial multi-language build/run/debug support;
- a cross-platform SocksCap control plane with platform implementations still passing release gates.

The detailed implemented surface is maintained in `qa-ui-auto-tests/feature-list.md`.

## Priority 1: release safety and platform evidence

### Remote desktop

- Complete the real-client interoperability matrix for RDP client and local RDP server.
- Finish long-run, reconnect, sleep/wake, network-change, and fault-injection testing.
- Keep Windows local-server capture marked unavailable until a real DXGI/WGC path exists.
- Close macOS production gates in `rdp-production-phase4-todo.md` before claiming production readiness.

### SocksCap

- Finish privileged real-traffic verification on Linux and Windows.
- Complete macOS Redirector dual-architecture, selected/unselected application, crash-recovery, and soak gates.
- Verify package contents, signatures, recovery journals, and stop/update cleanup on every platform.

### Updates and packaging

- Configure release signing keys and repository secrets outside the repository.
- Validate update discovery, signature verification, install, and user-triggered restart from an older released build.
- Record per-platform bundle and architecture evidence.

## Priority 2: security closure

- Implement SSH known-hosts/TOFU. The current `terminal/ssh.rs::check_server_key` accepts all server keys and must not be described as secure host verification.
- Make the built-in SSH server's SFTP `rootDir` symlink-safe; the current lexical `..` check is not a filesystem sandbox.
- Continue auditing agent tool scope, session binding, redaction, managed output directories, and confirmation enforcement.
- Keep imported credentials opt-in and vault-backed.
- Review privileged SocksCap helpers and local servers at their process, filesystem, and network trust boundaries.

## Priority 3: Code Workspace completion

- Finish the performance backlog without regressing file recovery, Git, LSP, diagnostics, or layout persistence.
- Complete provider-specific artifact discovery and pre-launch orchestration.
- Expand DAP support and run real toolchain/adapter smoke tests across platforms.
- Keep capability labels at `unavailable`, `detected`, or `verified`; code-path existence alone is not “supported”.

## Priority 4: product hardening

- Expand native smoke coverage for database engines, mail providers, keyrings, local servers, and protocol clients.
- Improve cancellation, reconnection, resource cleanup, and error recovery in long-running workflows.
- Keep UI automation aligned with feature changes and reduce browser-only coverage gaps where native fixtures are feasible.
- Measure terminal, workspace, query, capture, and agent-output memory/latency under realistic load.

## Later work

These remain valid ideas but are not commitments for the next release:

- user-controlled multi-device synchronization and shared session data;
- a session health dashboard and richer connection diagnostics;
- complete runbook recording/playback and AI-assisted bulk SFTP workflows;
- additional local-agent protocols/providers after the ACP boundary is stable;
- broader server/session parity where the target platform exposes a maintainable API.

## Non-goals

- A Taomni-operated SaaS account or mandatory cloud backend.
- Silent execution of destructive AI actions.
- Pretending browser stubs or compile-only platform code are production validation.
- Reimplementing Windows RDS, macOS login-window sharing, or other platform facilities that require unsupported/private APIs.
- Shipping secrets, signing material, local credentials, or environment-specific test data in Git.

## Roadmap maintenance

- `package.json` owns the current version; do not duplicate release numbers elsewhere unless the document is dated.
- `qa-ui-auto-tests/feature-list.md` owns implemented UI coverage.
- Focused plan/todo documents own unfinished work and release gates.
- `DESIGN.md` owns stable architecture and security boundaries.
- Remove completed implementation plans after durable decisions have been migrated into architecture or operations documentation.
