# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Taomni is a cross-platform AI-native remote workspace for developers (a MobaXterm alternative) built with Tauri 2 + React 19 + TypeScript. It bundles local/SSH terminals, SFTP file browsing, RDP/VNC viewers, port tunneling, database clients, object storage, and LAN peer chat, with AI capabilities (command generation, agent, chat, voice) woven through the workflow.

## Development Commands

```bash
pnpm install              # Install dependencies
pnpm tauri dev            # Full desktop app dev mode (Rust + frontend, Vite on port 1980)
pnpm dev                  # Frontend-only dev server (port 5000, uses stubs for Tauri APIs)
pnpm build                # Build frontend (tsc -b + vite build)
pnpm tauri build          # Build desktop app bundle (runs pnpm build first)
pnpm test                 # Run all tests (vitest run)
npx vitest run src/path/to/file.test.ts  # Run a single test file
npx vitest                # Watch mode
```

Rust backend: build/check happens through `pnpm tauri dev` / `pnpm tauri build`, or run `cargo` directly inside `src-tauri/`. Default features include `hbase-kerberos`; other optional features (`voice-capture`, `screen-capture`, `native-av`, `asr-sherpa-onnx`, `vulkan-detect`, `local-llm-fim`) are off by default.

## Architecture

### Frontend (src/)
- **Framework**: React 19 + TypeScript + Vite + Tailwind CSS v4
- **State**: Zustand stores in `src/stores/` (session, sftp, transfer, app, vnc, rdp, servers, chat, ai, vault, objectStorage, capture, update, and lanchat-related lanChat/lanCall/lanWb stores)
- **IPC layer**: `src/lib/ipc.ts` wraps Tauri `invoke()`; other `src/lib/` files handle SFTP, zmodem, themes, network settings, session import/export, terminal profiles, SQL/HBase statement parsing, object storage, and LAN RTC
- **Terminal**: xterm.js with WebGL renderer + fit/search/web-links addons
- **Editor**: CodeMirror 6 for the SQL client editor
- **Layout**: `src/layouts/MainLayout.tsx` is the main shell; components organized by feature under `src/components/`
- **i18n**: `src/lib/i18n/locales/` (en, zh-CN)

### Backend (src-tauri/src/)
- **Entry**: `lib.rs` registers ~290 Tauri commands and drives startup in `.setup()`: legacy-identity migration (`migrate.rs`) → SQLite init (`session::db::init_db`) → vault open → AI context construction (`ai::AppAiCtx::from_config`, ASR + LLM router, resolves `vault:<id>` api keys) → `app.manage(AppState)` → autostart tunnels/servers → main window creation (+ Linux `with_webview` WebRTC/media-stream enablement for LanChat)
- **State**: `state.rs` holds the shared `AppState` — `Mutex`/`RwLock`-wrapped maps of live sessions (terminals, sftp, transfers, tunnels, servers, vnc, rdp, db, object storage), the SQLite connection, `Vault`, AI context, and LanChat state. Also defines the oneshot-responder plumbing for SSH keyboard-interactive auth and the Claude Code MCP HITL flow (`CcToolResponder`, `CcPermissionResponder`)
- **Async**: tokio runtime for SSH, SFTP, tunnel, VNC, RDP, database, LAN, and AI operations

Major modules:
- `terminal/` — SSH (russh) + local PTY (portable-pty); proxy and single-level SSH jump host (`network.rs`, `ssh.rs`), shell-integration cwd tracking (`shell_integration.rs`), X11 forwarding (`x11_forward.rs`)
- `filebrowser/` — SFTP + local file ops + transfer queue
- `session/` — SQLite session/group persistence; imports from PuTTY / WSL / Tabby / OpenSSH (`import.rs`, `import_secrets/`)
- `tunnel/` — local/remote/dynamic port forwarding with autostart
- `proxy/`, `nettools/` — shared proxy plumbing and network utilities
- `sockscap/` — per-app/global OS traffic capture routed through an upstream (a MobaXterm/netch-style "SocksCap"). Windows: elevated `sockscap-helper` + WinDivert (bundled resource, provisioned by `scripts/fetch-windivert.ps1`); Linux: nftables + cgroup v2 redirect. Captured TCP flows enter a loopback relay (`relay.rs`) that applies GFWList/rule policy then dials an upstream via `egress/`. Native upstreams: HTTP / SOCKS5 / SSH. Core-backed upstreams (Shadowsocks / Trojan / VMess / VLESS / WireGuard) are served by a bundled **xray-core** sidecar (MPL-2.0, `core/`; `scripts/fetch-xray.ps1`, pinned SHA256) — one process per profile exposing a local SOCKS inbound the relay dials, so no protocol/crypto lives in-tree. Share links (`ss://`/`vmess://`/`vless://`/`trojan://`) and subscriptions are parsed in `core/share_link.rs`. SSR is intentionally unsupported
- `vnc/` — RFB protocol client + WebSocket bridge; `rdp/` — RDP client (ironrdp)
- `servers/` — local servers, including an RDP **server** (`servers/rdp/`) with screen capture + cross-platform input injection (enigo)
- `database/` — SQL clients (MySQL/PostgreSQL via sqlx, SQL Server via tiberius, ClickHouse via HTTP) and Redis; connections can route through proxy / SSH jump host (`forward.rs`)
- `hbase/` — native HBase RPC client (prost protobuf + ZooKeeper region discovery, `hbase/native/`) plus a Thrift2-over-HTTP backend for Aliyun Lindorm / HBase enhanced (`hbase/thrift/`, bindings pre-generated in `idl.rs`)
- `objectstorage/` — S3-family (rusty-s3) and Azure Blob storage with credentials, sessions, and a transfer queue
- `lanchat/` — P2P LAN messaging/file transfer with mDNS discovery, mutual TLS (`tls.rs`), and optional native A/V media stack (`media/`, behind `native-av`)
- `ai/` — LLM-backed shell command generation with safety auditing (`shell_safety.rs`, `network_policy.rs`, `session_safety.rs`)
- `agent/` — agent tool execution, web search (SearXNG/Exa/Google CSE), Claude Code bridge (`cc_bridge/`, in-app Streamable-HTTP MCP server via rmcp+axum), Codex bridge (`codex_bridge/`), output capture/reduce (`capture/`, jaq jq engine)
- `chat/` — AI chat threads/messages; `llm/` — llama.cpp sidecar; `models/` — model download manager (+ CUDA pack)
- `voice/` + `asr/` — voice capture (cpal) + speech-to-text
- `vault/` — encrypted credential store (argon2 + aes-gcm + OS keyring)
- `config/`, `tab/`, `history.rs`, `serial/`, `wsl/`, `windowing/`, `appearance.rs`, `update.rs`, `perf.rs`

### Vendored crates
`src-tauri/vendor/` holds patched forks (ironrdp-connector, picky, picky-krb, sspi, winscard, portable-pty), wired in via `[patch.crates-io]` in `Cargo.toml`. Upgrading these crates requires re-applying or re-vendoring the patches.

### Dev-mode Stubs
When running `pnpm dev` (no Tauri), `vite.config.ts` aliases `@tauri-apps/api/*` and the dialog/shell/notification plugins to stub implementations in `src/stubs/` (tauri-core, tauri-event, tauri-window, tauri-shell, etc., plus sshClient/sftpClient/localVfs). Custom Vite plugins in `vite-plugins/` provide SSH, SFTP, and RDP proxy servers (Node ssh2/ws) so the frontend can be developed without the Rust backend. These plugins are only loaded when `TAURI_ENV_PLATFORM` is unset.

### Communication Pattern
Frontend calls Tauri commands (Rust `#[tauri::command]`) via `invoke()`. Terminal, SFTP, database stream, AI/chat token streams, and LanChat use Tauri events (`emit`/`listen`) for bidirectional async communication between Rust and the webview. The Claude Code agent bridge inverts this: the in-app MCP server dispatches side-effect tool calls back to the frontend via events and blocks on a oneshot until `cc_resolve_tool_call` / `cc_resolve_permission` delivers the human's outcome.

## Key Conventions

- App version lives in root `package.json`; `tauri.conf.json` reads it via `"version": "../package.json"`, and Vite exposes it as `__APP_VERSION__`. `Cargo.toml` has a separate Rust crate version — the published app version is the `package.json` one.
- App identifier is `com.taomni.app`; the window has `decorations: false` — the app renders its own title bar (`src/components/window/`)
- ES2022 build target in Vite (Tauri 2 targets modern WebView)
- Database: SQLite named `taomni.db` in the platform app-data directory (resolved from the `com.taomni.app` identifier)
- Release: push a `v<version>` git tag (must equal `v` + `package.json` version) to trigger GitHub Actions cross-platform builds; manual `Release Bundle` workflow runs without a tag produce artifacts only
- Formatting: Rust code uses edition 2024. Do not pin the Rust toolchain unless explicitly requested. Do not run project-wide `cargo fmt` (it churns large numbers of unrelated files). If Rust formatting is necessary, run `rustfmt --edition 2024 <changed .rs files>` only on files you edited, keeping the diff minimal

## Testing

- Vitest with jsdom environment; setup file `src/test/setup.ts`. `.claude/worktrees/**` is excluded from test discovery (parallel worktrees carry a second React copy that crashes hooks)
- Rust unit tests live in `#[cfg(test)] mod tests` blocks within modules; integration tests under `src-tauri/tests/`
- UI automation tests defined as YAML under `qa-ui-auto-tests/cases/*.testcase.yaml` (Playwright-based, see `qa-ui-auto` skill)

## Environment Requirements

- Node.js 18+, pnpm, Rust 1.94+
- Tauri system dependencies (WebView2 on Windows, webkit2gtk on Linux)
- `protoc` (Protocol Buffers compiler) for the native HBase client build
- `nasm` is required when building with the `native-av` feature (openh264 x86 asm)
