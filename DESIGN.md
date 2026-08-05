# Taomni Architecture

> Status: current architecture overview. Update this document when a subsystem boundary or persistent data contract changes. Detailed implemented UI coverage lives in `qa-ui-auto-tests/feature-list.md`; dependency versions live in `package.json` and `src-tauri/Cargo.toml`.

## Product boundary

Taomni is a local-first Tauri 2 desktop workspace for terminal, remote access, file transfer, databases, mail, code workspaces, local servers, LAN collaboration, and AI-assisted workflows. The shipped product is the Rust-backed desktop app. Browser mode is a development preview with controlled stubs, not an alternative production backend.

The project favors:

- local persistence and user-controlled credentials;
- explicit confirmation for destructive or external AI actions;
- one shared desktop shell instead of separate protocol applications;
- platform capability reporting instead of pretending unsupported native paths work;
- bounded streaming for terminal, query, capture, and large-file data.

## Runtime architecture

```text
React 19 UI
  components / layouts / stores
             |
             | typed wrappers, Tauri invoke, Channel, events
             v
Rust application state
  sessions / terminal / protocol clients / databases / AI / servers
             |
             v
SQLite + encrypted vault + platform APIs + network services
```

### Frontend

- `src/layouts/MainLayout.tsx` owns the main application shell, tab routing, global dialogs, and cross-feature wiring.
- `src/components/` is organized by feature. Heavy surfaces such as database, editor, RDP, VNC, mail, and agent panels are loaded through their feature entry points.
- `src/stores/` contains Zustand state. Stores hold UI/session state and call typed functions from `src/lib/`; they do not duplicate Rust persistence rules.
- `src/lib/ipc.ts` and feature-specific helpers are the frontend IPC boundary.
- `src/stubs/` implements browser-preview behavior. Desktop-only effects must remain guarded and must not leak stub assumptions into the Tauri build.
- `src/lib/i18n/locales/` is the source for user-facing English and Chinese strings.

### Backend

`src-tauri/src/lib.rs` constructs `AppState`, registers commands, installs Tauri plugins, starts opt-in/autostart services, and owns application shutdown cleanup.

Major backend areas include:

- `terminal/`, `filebrowser/`, `tunnel/`: local PTY, SSH, SFTP, and port forwarding;
- `rdp/`, `vnc/`: outbound remote desktop clients;
- `servers/`: built-in local SSH/SFTP, RDP, VNC, HTTP, FTP, TFTP, NFS, Telnet, iperf, and cron services;
- `database/`, `hbase/`, `objectstorage/`: SQL, Redis, HBase, and object-storage clients;
- `mail/`, `lanchat/`, `notes/`: application-level local services and persistence;
- `ai/`, `asr/`, `llm/`, `agent/`, `chat/`, `voice/`: provider configuration, speech capture, chat, ACP/CLI agents, MCP tools, safety, and auditing;
- workspace/LSP/DAP modules: file workspace, source navigation, build/run/debug, and Git integration;
- `sockscap/`: platform-specific traffic capture and proxy routing.

## Communication contracts

Use the smallest suitable Tauri transport:

- ordinary request/response commands for bounded control data;
- `tauri::ipc::Channel` for ordered streams such as terminal output and database rows;
- `InvokeResponseBody::Raw` or raw responses for binary payloads;
- named events for lifecycle notifications and UI-owned side effects;
- bounded file-backed capture for outputs that should not enter the model or WebView in full.

Command names and payload shapes are contracts. Add typed frontend wrappers and browser stubs whenever a command is exposed to React. Long-running operations must support cancellation or deterministic teardown.

## State and persistence

The application data directory contains several intentionally separate stores:

| Store | Responsibility |
|---|---|
| `taomni.db` | sessions, groups, tunnels, server configuration, chat metadata, query workspaces, history, and related application state |
| `notes.db` | Tao Notes content, steps, tags, preferences, and alert acknowledgement |
| `lanchat.sqlite` | LAN identity, peers, conversations, messages, transfers, and collaboration state |
| `mail-cache/` | per-account mail cache data |
| `vault.db` | encrypted secrets and provider credentials |
| AI/config files | non-secret provider preferences and local model/runtime metadata |

Schema changes belong in the owning Rust module and must be backward compatible. Secrets must be stored through the vault/keyring boundary, not in session JSON, logs, prompts, or exported files unless the user explicitly opts in.

## Feature boundaries

### Terminal and remote access

Local and SSH terminals share `TerminalPanel`, terminal profiles, history, context-menu actions, split view, MultiExec, capture, and raw output channels. Backend-specific differences remain below the shared UI. RDP and VNC have independent protocol engines and rendering paths.

### Data clients

SQL databases share the query workspace, streaming result model, query library, and result grid. Redis uses a key/value workspace. HBase exposes shell semantics over REST, Thrift, or native RPC while adapting results to the shared grid where practical.

### AI and agents

Cloud/local LLM providers use the common router and configuration model. Claude Code, Codex, and general ACP agents run as local processes with bounded lifetimes. Taomni-owned MCP tools remain behind scope checks, permission prompts, session binding, redaction, and audit rules. A provider must never bypass the shared safety path for write actions.

### Browser preview

Browser mode uses Vite aliases for Tauri APIs plus SSH/SFTP/RDP development bridges. It is suitable for UI development and E2E smoke tests. Native permissions, real keyrings, OS capture, packaging, and production protocol behavior require the desktop runtime.

## Cross-platform rules

- Keep platform code behind `cfg` gates and expose an honest capability probe.
- Do not make successful compilation imply runtime support.
- Native capture, input injection, keyring, signing, and elevated networking require real-platform smoke tests before being called production-ready.
- Windows paths, POSIX paths, and shell quoting must remain structured until the final platform-specific execution boundary.

## Security invariants

- Destructive AI/agent actions require the configured confirmation policy and backend enforcement.
- Web search and other data-egress operations honor provider capability and privacy settings.
- Secrets are redacted before prompt construction and never written to ordinary logs.
- Imported secret material is opt-in and routed to the vault.
- SSH client host-key verification is not yet implemented: `terminal/ssh.rs::check_server_key` currently accepts every key. Treat TOFU/known-hosts support as a release-blocking security backlog, not a completed feature.
- The built-in SSH server's SFTP `rootDir` is currently a lexical path boundary, not a symlink-safe filesystem sandbox. Do not expose it to untrusted clients until canonical/no-follow confinement is implemented.
- SocksCap and local servers must clean up privileged/native state on stop, application exit, and recovery startup.

## Verification and documentation ownership

- Frontend behavior: colocated Vitest tests plus `qa-ui-auto-tests/feature-list.md` and YAML cases.
- Rust behavior: inline unit tests and the unified suite under `src-tauri/tests/`.
- Native release claims: platform smoke evidence in the relevant active plan or release checklist.
- Operational instructions: README files next to the affected resource or subsystem.
- Historical implementation task lists are not architecture documentation and should be removed after delivery.
