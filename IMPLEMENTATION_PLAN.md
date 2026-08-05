# Taomni Implementation Status and Active Work

> This file is a current delivery index, not the original project bootstrap checklist. Implemented UI coverage is authoritative in `qa-ui-auto-tests/feature-list.md`; architecture is documented in `DESIGN.md`.

## Current baseline

The application is at version `0.4.9` as declared by the root `package.json`. The following product foundations are implemented and covered by code/tests:

- Tauri 2 + React 19 application shell, tabs, detachable windows, themes, settings, and i18n;
- local PTY and SSH terminals, SFTP, tunnels, split view, MultiExec, history, ZMODEM, capture, and terminal profiles;
- VNC and RDP clients, plus built-in local server management;
- SQL, Redis, HBase, object-storage, and mail workspaces;
- session import/export, encrypted credential vault, WSL sessions, and browser-preview stubs;
- AI chat, provider routing, ASR/PTT, command assistance, web search, Claude Code/Codex/ACP integrations, MCP tools, permission cards, and auditing;
- Tao Notes/Tao Hub and LAN collaboration;
- Code Workspace editing, Git, LSP navigation, and the first build/run/debug providers;
- SocksCap shared control plane and platform implementations at differing release-readiness levels.

Do not reopen the old phase 1–6 task model. New work should be tracked in the focused documents below or in an issue/task system.

## Active workstreams

| Workstream | Current state | Active source |
|---|---|---|
| RDP client/server production readiness | Core paths exist; native interoperability, long-run, fault, and remaining platform gates are incomplete | `rdp-production-phase4-todo.md`, `claudedocs/local-rdp-server-plan.md` |
| SocksCap | Control plane exists; Windows/Linux/macOS have platform-specific packaging, privilege, and real-traffic gates | `claudedocs/sockscap-*-plan.md`, `claudedocs/sockscap-macos-redirector-implementation-analysis.md` |
| Code Workspace performance | Known optimization backlog remains | `claudedocs/code-workspace-performance-todo.md` |
| Multi-language build/run/debug | Shared model and first providers landed; complete artifact discovery, adapters, and native smoke matrix remain | `claudedocs/code-workspace-multilanguage-build-run-debug-plan.md` |
| Auto-update releases | Client code exists; signing secrets and end-to-end release verification are operational gates | `claudedocs/auto-update-plan.md` |
| SSH known-hosts | Not implemented; current client accepts host keys | `roadmap.md` |
| Terminal compatibility | SFTP-aware terminal actions and some backend-specific signals/logging remain partial | `TERMINAL_EXPERIENCE_PLAN.md` |

## Delivery contract

For each change:

1. Identify the owning subsystem and update its focused design/backlog only when the contract changes.
2. Keep TypeScript strict and add focused Vitest coverage for UI, store, and utility behavior.
3. Add Rust unit tests or unified integration tests for backend behavior.
4. Update `qa-ui-auto-tests/feature-list.md` and YAML coverage for visible workflows.
5. Run verification proportional to the change; native capability claims require real-platform evidence.
6. Update user-facing docs when commands, prerequisites, supported platforms, or release gates change.

## Standard verification

```bash
pnpm test
pnpm build
cd src-tauri && cargo test --lib
cd src-tauri && cargo test --test integration
```

Use focused subsets while iterating. Run `cargo test` for the full backend suite when the touched area crosses library/integration boundaries. Format only edited Rust files with `rustfmt --edition 2024`.

## Definition of done

A feature is complete only when:

- its primary user path is connected to the real backend;
- unsupported platform behavior is represented as unavailable or degraded, not simulated success;
- cancellation, error, cleanup, and restart behavior are defined;
- security and secret-handling boundaries are enforced in the backend;
- automated tests cover the stable logic and the feature catalog is synchronized;
- required native/manual verification is recorded, or the remaining gate stays explicitly open.
