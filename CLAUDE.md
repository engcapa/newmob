# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow [AGENTS.md](AGENTS.md) for shared contributor guidelines. The architecture and workflow details below supplement those rules.

## Project Overview

Taomni is a Windows, macOS, and Linux desktop AI-native remote workspace for developers (a MobaXterm alternative) built with Tauri 2 + React 19 + TypeScript + Rust. It bundles local/SSH terminals, SFTP file browsing, RDP/VNC viewers, port tunneling, database clients, object storage, LAN peer chat, an IMAP/SMTP mail client, a notes app, and a CodeMirror-based code workspace/IDE (LSP intelligence + DAP debugging + git). AI capabilities (command generation, agent, chat, voice) are woven through the workflow. Browser mode supports development and auxiliary testing; implementation must preserve all three desktop platforms.

## Development Commands

```bash
pnpm install              # Install dependencies
pnpm tauri dev            # Full desktop app dev mode (Rust + frontend, Vite on port 1980)
pnpm dev                  # Frontend-only dev server (port 5000, uses stubs for Tauri APIs)
pnpm build                # Build frontend (tsc -b + vite build)
pnpm tauri build          # Build desktop app bundle (runs pnpm build first)
pnpm test                 # Run frontend/unit tests (vitest run)
pnpm test src/path/to/file.test.ts  # Run a selected test file
pnpm exec vitest          # Watch mode
```

Rust backend: build/check happens through `pnpm tauri dev` / `pnpm tauri build`, or run `cargo` directly inside `src-tauri/`. Default features include `hbase-kerberos`; other optional features (`voice-capture`, `screen-capture`, `native-av`, `asr-sherpa-onnx`, `vulkan-detect`, `local-llm-fim`) are off by default.

Run these commands from `src-tauri/`:

```bash
cargo test --lib                     # Unit tests without linking the integration binary
cargo test --lib sockscap::          # Filter by module
cargo test --test integration        # Unified integration suite
cargo test                          # Full suite, including applicable binaries
```

Before direct Cargo builds/tests on macOS, run `bash scripts/bundle-krb5-macos.sh stage` from the repository root. Tauri invokes this staging step through its build/dev hooks. Frontend output goes to `dist/`; native binaries and bundles go under `src-tauri/target/`.

## Architecture

### Frontend (src/)

- **Framework**: React 19 + TypeScript + Vite + Tailwind CSS v4
- **State**: Zustand stores in `src/stores/` (session, sftp, transfer, app, vnc, rdp, servers, chat, ai, vault, backup, objectStorage, capture, update, codeWorkspace/codeWorkspaceStatus/projectFacts, notes, taoAlert/taoHub, and lanchat-related lanChat/lanCall/lanWb)
- **IPC layer**: `src/lib/ipc.ts` wraps Tauri `invoke()`; other `src/lib/` files handle SFTP, zmodem, themes, network settings, session import/export, terminal profiles, SQL/HBase parsing, object storage, git, mail, notes, and LAN RTC. `src/lib/editor/` holds the workspace/LSP/DAP/SDK client wrappers
- **Terminal**: xterm.js with WebGL renderer + fit/search/web-links addons
- **Code workspace**: CodeMirror 6 powers both the SQL client editor and a multi-tab code IDE (`src/components/editor/`) with a file tree, breadcrumbs, workspace search, LSP-backed intelligence, DAP debug panels, Java main-class/test runners, git diff/peek, and local-history snapshots
- **Layout**: `src/layouts/MainLayout.tsx` is the main shell; components organized by feature under `src/components/` (terminal, filebrowser, database, editor, git, mail, notes, vnc, rdp, servers, sockscap, lanchat, agent, chat, settings, tao, menubar, statusbar, sidebar, tabbar, window, …)
- **i18n**: `src/lib/i18n/locales/` (en, zh-CN)

### Backend (src-tauri/src/)

- **Entry**: `lib.rs` registers Tauri commands and drives startup in `.setup()`: legacy-identity migration (`migrate.rs`) → pending backup restore (`backup::restore::apply_pending_restore`) → SQLite init → vault open → AI context construction (`ai::AppAiCtx::from_config_with_proxy_db`, ASR + LLM router, resolves `vault:<id>` API keys) → managed application/workspace state → autostart tunnels/servers → main window creation (+ Linux `with_webview` WebRTC/media-stream enablement for LanChat)
- **State**: `state.rs` holds the shared `AppState` — `Mutex`/`RwLock`-wrapped maps of live sessions (terminals, sftp, transfers, tunnels, servers, vnc, rdp, db, object storage, LSP/DAP), the SQLite connection, `Vault`, AI context, and LanChat state. Also defines the oneshot-responder plumbing for SSH keyboard-interactive auth and the Claude Code MCP HITL flow (`CcToolResponder`, `CcPermissionResponder`)
- **Async**: tokio runtime for SSH, SFTP, tunnel, VNC, RDP, database, LAN, mail, LSP/DAP, and AI operations

Major modules:

- `terminal/` — SSH (russh) + local PTY (portable-pty); proxy and single-level SSH jump host (`network.rs`, `ssh.rs`), shell-integration cwd tracking (`shell_integration.rs`), X11 forwarding (`x11_forward.rs`)
- `filebrowser/` — SFTP + local file ops + transfer queue
- `session/` — SQLite session/group persistence; imports from PuTTY / WSL / Tabby / OpenSSH (`import.rs`, `import_secrets/`)
- `tunnel/` — local/remote/dynamic port forwarding with autostart
- `proxy/`, `nettools/` — shared proxy plumbing and network utilities
- `sockscap/` — per-app/global OS traffic capture routed through an upstream. Windows uses elevated `sockscap-helper` + WinDivert (`scripts/fetch-windivert.ps1`); Linux has nftables/cgroup v2 transparent capture and an unprivileged ptrace/seccomp path for launched applications (`capture/linux/`); macOS uses the mitmproxy Redirector (`redirector/`, `capture/macos/`). Captured TCP flows enter a loopback relay (`relay.rs`) that applies GFWList/rule policy then dials through `egress/`. Native upstreams: HTTP / SOCKS5 / SSH. Core-backed upstreams (Shadowsocks / Trojan / VMess / VLESS / WireGuard) use bundled **xray-core** (`core/`, `scripts/fetch-xray.ps1`) with local SOCKS inbounds. Share links and subscriptions are parsed in `core/share_link.rs`. SSR is intentionally unsupported
- `vnc/` — RFB protocol client + WebSocket bridge; `rdp/` — RDP client (ironrdp)
- `servers/` — local servers, including an RDP **server** (`servers/rdp/`) with screen capture + cross-platform input injection (enigo)
- `database/` — SQL clients including MySQL/StarRocks/PostgreSQL via sqlx, PanWeiDB via openGauss, Oracle, SQL Server via tiberius, and HTTP-backed clients such as ClickHouse; also Redis. Connections can route through proxy / SSH jump host (`forward.rs`)
- `hbase/` — native HBase RPC client (prost protobuf + ZooKeeper region discovery, `hbase/native/`) plus a Thrift2-over-HTTP backend for Aliyun Lindorm / HBase enhanced (`hbase/thrift/`, bindings in `idl.rs`)
- `objectstorage/` — S3-family (rusty-s3) and Azure Blob storage with credentials, sessions, and a transfer queue
- `lanchat/` — P2P LAN messaging/file transfer with mDNS discovery, mutual TLS (`tls.rs`), and optional native A/V media stack (`media/`, behind `native-av`)
- `mail/` — generic IMAP/SMTP client; per-account live IMAP session with idle TTL, session-scoped proxy forwarding (never the app global proxy), OAuth token fetch isolated off any current Tokio runtime
- `notes/` — Tao Notes (unified notes/memo/task), backed by a dedicated `notes.db`
- `backup/` — backup archive creation/inspection and verified restore staging; pending restores are applied during startup before databases are opened
- **Code workspace / IDE** — `workspace.rs` (path-scoped file list/read/write/rename, guarded roots), `workspace_fs.rs` (WorkspaceFs trait spike for a future SFTP-backed root), `workspace_search.rs` (ripgrep-style search via the `grep`/`ignore` crates), `local_history.rs` (content-addressed pre-save snapshots in `local-history/`), `git.rs` (git CLI wrapper with vault-backed credentials)
- **Language intelligence** — `lsp.rs` (LSP client managing language-server child processes), `dap.rs` (language-agnostic Debug Adapter Protocol kernel), `sdk/` (Java runtime/SDK detection + resolution). Java debugging is the first DAP adapter: `java_bundles.rs` (resolve jdtls java-debug/java-test extension jars), `java_debug_adapter.rs` (drives jdtls to launch and bridges its TCP transport into the DAP kernel), `java_test.rs` (test discovery)
- **Build/run tooling** — `workspace_execution.rs` discovers structured multi-language build/run/debug commands; `workspace_tooling/` contains Maven/Gradle tooling; `dependency_index.rs` provides cached Maven dependency queries
- `ai/` — LLM-backed shell command generation with safety auditing (`shell_safety.rs`, `network_policy.rs`, `session_safety.rs`)
- `agent/` — agent tool execution, web search (SearXNG/Exa/Google CSE), Claude Code bridge (`cc_bridge/`, in-app Streamable-HTTP MCP server via rmcp+axum), Codex bridge (`codex_bridge/`), output capture/reduce (`capture/`, jaq jq engine)
- `chat/` — AI chat threads/messages; `llm/` — llama.cpp sidecar; `models/` — model download manager (+ CUDA pack)
- `voice/` + `asr/` — voice capture (cpal) + speech-to-text
- `vault/` — encrypted credential store (argon2 + aes-gcm + OS keyring)
- `config/`, `tab/`, `history.rs`, `serial/`, `wsl/`, `windowing/`, `appearance.rs`, `update.rs`, `perf.rs`

### Vendored crates

`src-tauri/vendor/` holds patched forks wired through `[patch.crates-io]` in `Cargo.toml`: libspa, ironrdp-connector, ironrdp-server, picky, picky-krb, portable-pty, sspi, tauri-utils, and winscard. Check the patch table when upgrading dependencies and preserve the repository's compatibility fixes.

### Dev-mode Stubs

When running `pnpm dev` (no Tauri), `vite.config.ts` aliases `@tauri-apps/api/*` and the dialog/shell/notification plugins to stub implementations in `src/stubs/` (tauri-core, tauri-event, tauri-window, tauri-shell, etc., plus sshClient/sftpClient/localVfs). Custom Vite plugins in `vite-plugins/` provide SSH, SFTP, and RDP proxy servers (Node ssh2/ws) so the frontend can be developed without the Rust backend. These plugins are only loaded when `TAURI_ENV_PLATFORM` is unset.

### Communication Pattern

Frontend calls Tauri commands (Rust `#[tauri::command]`) via `invoke()`. Async updates use Tauri events (`emit`/`listen`) and IPC `Channel`s, including terminal output and database query streams. Match the existing transport and payload contract at each call site. The Claude Code bridge dispatches tool calls and permission requests to the frontend through events and awaits a oneshot response from `cc_resolve_tool_call` / `cc_resolve_permission`, with timeout handling.

## Key Conventions

- App version lives in root `package.json`; `tauri.conf.json` reads it via `"version": "../package.json"`, and Vite exposes it as `__APP_VERSION__`. `Cargo.toml` has a separate Rust crate version — the published app version is the `package.json` one.
- App identifier is `com.taomni.app`; the window has `decorations: false` — the app renders its own title bar (`src/components/window/`)
- Production Vite targets are `es2020` and `safari16`; dependency optimization also targets `es2020`. Preserve these WebView compatibility settings. TypeScript's `ES2022` target is separate from the emitted Vite build target
- SQLite files live in the platform app-data directory (resolved from the `com.taomni.app` identifier): `taomni.db` (sessions), `notes.db` (notes), `local-history/history.db` (workspace snapshots)
- Release: push a `v<version>` git tag (must equal `v` + `package.json` version) to trigger GitHub Actions cross-platform builds; manual `Release Bundle` workflow runs without a tag produce artifacts only
- Formatting: Rust code uses edition 2024. Do not pin the Rust toolchain unless explicitly requested. Do not run project-wide `cargo fmt` (it churns large numbers of unrelated files). If Rust formatting is necessary, run `rustfmt --edition 2024 <changed .rs files>` only on files you edited, keeping the diff minimal
- TypeScript: use strict mode, two-space indentation, double quotes, and no unused locals/parameters. Components use `PascalCase`, hooks `use*`, and stores `*Store.ts`; Rust modules/functions use `snake_case`. Keep platform-specific APIs and dependencies behind the appropriate existing gates

## Testing

- Vitest, Testing Library, and jsdom; colocate `*.test.ts`/`*.test.tsx` files and use `describe`/`it`. Shared setup is `src/test/setup.ts`; Vitest limits workers to four and excludes `.claude/worktrees/**` to avoid duplicate React instances
- Rust unit tests use inline `#[test]`/`#[tokio::test]`. Integration tests are modules of the single `src-tauri/tests/integration/main.rs` binary; add cases there rather than creating additional top-level test binaries. See `src-tauri/tests/README.md` for filters and live-service prerequisites
- UI cases live in `qa-ui-auto-tests/cases/TC-*.testcase.yaml`. Use `.agents/skills/qa-ui-auto/` and keep `covers`, feature controls, and `qa-ui-auto-tests/feature-list.md` aligned; regenerate derived catalogs with the existing tooling. CI runs `python -m qa_ui_auto.audit --gate` with the skill's scripts on `PYTHONPATH`
- Add focused behavior/regression tests and inspect skipped live-service cases; exit code zero alone does not prove real SSH/SFTP/provider execution
- Code must remain compatible with Windows, macOS, and Linux. Plan native verification for all three; completing the current runtime platform's verification suffices for the current delivery. Record other platforms as unverified with follow-up steps; missing devices alone do not block delivery, but known code incompatibilities still require fixes
- Browser stubs and synthetic fixtures cannot prove native or real-service behavior. Record the tested build, environment, actual result, and evidence; use isolated application data and test resources

## Design Workflows

Design skills are maintained in the repository under `.agents/skills/`:

- `feature-design`: new capabilities or extensions; write detailed designs to `docs-feature/<feature-slug>-design.md`
- `issue-design`: bugs, regressions, and incorrect behavior; write repair designs to `docs-issue/<issue-id-or-slug>-design.md`, including reproduction evidence, root-cause certainty, and regression cases

Both support `prompt` (generate a reusable design prompt), `design` (investigate and write the document), and natural-language requests without a subcommand. Read the relevant `SKILL.md`; create output directories when needed. Link acceptance criteria (`AC-*`), implementation tasks (`TASK-*`), verification (`V-*`), and evidence so another agent can implement without chat history. Design-ready does not mean implemented or verified.

For Code Workspace IDEA parity cards, use `.agents/skills/code-workspace-idea-task/` and the active backlog; historical design documents are background rather than a task queue. Task decomposition alone does not authorize starting multiple agents or changing shared boards.

## Commits, Pull Requests, and Local Data

- Use scoped conventional commits such as `fix(code-workspace): ...` and `feat(settings): ...`. PRs should describe the change, affected areas, linked issues, checks performed, and screenshots/recordings for visible UI changes
- Preserve unrelated worktree changes. Keep credentials, generated logs, `qa-ui-auto-report/`, `dist/`, and `src-tauri/target/` uncommitted; store test secrets in environment variables and use isolated test data

## Environment Requirements

- Node.js 22.x (22.13+) or 24+, pnpm, and Rust 1.94+. These Node versions satisfy the installed Vite/jsdom engine requirements; Node 18 does not
- Tauri system dependencies (WebView2 on Windows, webkit2gtk on Linux)
- `protoc` (Protocol Buffers compiler) for the native HBase client build
- A complete Perl 5 distribution for vendored OpenSSL (VNC TLS); Git for Windows' bundled Perl is insufficient. See `README.md` for installation examples
- Bash for Tauri's build/dev/bundle hooks, including on Windows. See `.github/workflows/release.yml` for platform setup; macOS requires staged Kerberos libraries through `scripts/bundle-krb5-macos.sh`
- `nasm` is required when building with the `native-av` feature (openh264 x86 asm)
- Language intelligence is runtime-provisioned by the user: a JDK + jdtls (with java-debug / java-test extension jars) for Java LSP/DAP, and the relevant language server for other languages
