# NewMob

A cross-platform SSH/terminal client inspired by MobaXterm, built with React + Vite + TypeScript. Originally a Tauri desktop app, adapted to run in the browser on Replit.

## Architecture

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **State**: Zustand
- **Terminal**: xterm.js with addons (fit, webgl, search, web-links)
- **Layout**: react-resizable-panels

## Key Directories

- `src/` — React frontend source
  - `components/` — UI components (menubar, sidebar, tabbar, terminal, settings, etc.)
  - `layouts/` — MainLayout (main app shell)
  - `lib/` — Utilities (IPC, themes, fonts, session paths, terminal profile)
  - `stores/` — Zustand stores (appStore, sessionStore)
  - `types/` — TypeScript types
  - `stubs/` — Browser stubs for Tauri APIs (tauri-core, tauri-window, tauri-event, tauri-shell)
- `src-tauri/` — Original Tauri/Rust backend (not used in browser mode)

## Project Principle

**The final release target is the Tauri 2 + Rust desktop app.** The Vite/web mode
that runs on Replit (and `pnpm dev` / `pnpm build` in general) exists **only**
for development convenience and visual testing in the browser. Anything added
purely to make the web preview work (browser stubs, the WebSocket SSH proxy,
etc.) **must not** alter or pollute the desktop build pipeline.

## Build Mode Detection

`vite.config.ts` checks `process.env.TAURI_ENV_PLATFORM` to decide which mode it
is in. The Tauri CLI sets this env var automatically whenever it invokes the
frontend build (`pnpm tauri dev` / `pnpm tauri build`).

- **Tauri mode** (`TAURI_ENV_PLATFORM` is set): no stub aliases, no SSH proxy
  plugin. The frontend imports the real `@tauri-apps/api` and talks to the Rust
  backend (`russh`, etc.).
- **Web mode** (env var unset, e.g. plain `pnpm dev` / `pnpm build` on Replit):
  stub aliases for `@tauri-apps/api/*` are applied and the WebSocket SSH proxy
  Vite plugin is registered.

`ssh2` and `ws` are listed under `devDependencies`, not `dependencies`, so they
never ship inside the desktop bundle.

## Browser Adaptation (web mode only)

Since Tauri's native backend is not available in the browser, stub modules are used:

- `src/stubs/tauri-core.ts` — Stubs `invoke()`. Session/group CRUD goes through localStorage; SSH commands (`create_ssh_terminal`, `test_ssh_connection`, `write_terminal`, `resize_terminal`, `send_terminal_signal`, `close_terminal`) are bridged to a real WebSocket-based SSH proxy (see below). `create_local_terminal` throws — local PTY is unavailable in the browser.
- `src/stubs/tauri-window.ts` — Stubs window/close APIs
- `src/stubs/tauri-event.ts` — Stubs event listen/emit APIs (in-memory pub/sub)
- `src/stubs/tauri-shell.ts` — Stubs shell command APIs
- `src/stubs/sshClient.ts` — Maintains one WebSocket per SSH session, sends connect/data/resize/signal/close messages, and re-emits server-pushed `output`/`closed` frames as `terminal-output-{sid}` / `terminal-exit-{sid}` events on the in-memory bus so `TerminalPanel` works unchanged.

These stubs are aliased via `vite.config.ts` at build time.

## SFTP Browser

A dual-pane SFTP file manager is wired in alongside the terminal. Three entry points
all render the same `<FileBrowser>` component:

1. **Attached sidebar** — every SSH terminal tab gains an "SFTP" toggle button
   (top-right of the terminal). When opened it docks an `<SftpSidebar>` to the right
   of the terminal that shares the same SSH credentials. The remote pane follows
   the terminal's working directory via OSC 7 — `TerminalPanel` parses
   `\e]7;file://host/path\e\` sequences and pushes them to `MainLayout` via the
   `onCwdChange` prop. After connect, a small shell snippet
   (`PROMPT_COMMAND` for bash, `precmd_functions` for zsh) is injected to start
   emitting OSC 7 every prompt.
2. **Standalone tab** — choosing `SessionType::SFTP` from the session editor opens
   a full-tab `<FileBrowser>` (no terminal). Standalone tabs stay mounted while
   inactive so transfers keep running in the background.
3. **Detached window** — both attached and standalone variants expose a
   "Detach to window" action that stashes the SFTP credentials in
   `localStorage` (key `newmob.sftp.detached.<sid>`) and opens `?sftp=<sid>`;
   `App.tsx` detects the query param and renders `<SftpDetachedWindow>`
   instead of the main shell. In Tauri the new window is a real OS
   `WebviewWindow` opened via the `open_sftp_window` Rust command (sharing
   the same origin, so the same `localStorage` is visible); in browser
   preview we fall back to `window.open`. The detached window uses a
   **distinct session id** (`<parentId>__detached`) so its backend SFTP
   channel is independent from the sidebar/standalone tab — without this
   they shared `Arc<Mutex<SftpSession>>` and a long transfer in one
   window would stall clicks/listings in the other. The handoff payload
   carries the original `parentSessionId` so the detached window can
   still subscribe to OSC 7 cwd-hint broadcasts published by the main
   window.

The SFTP browser also supports per-view toggles:
- **Sync to terminal cwd** — `<FileBrowser>` (used directly by standalone
  tabs/detached windows and wrapped by `<SftpSidebar>` for the attached
  pane) does **one-shot** initial sync to the terminal's cwd the first
  time a hint arrives after attach, then leaves the panel alone. The
  *Sync* button in the cwd toolbar re-jumps on demand. Continuous
  follow was removed because it was preventing the user from navigating
  away inside the SFTP pane.
- **Pane orientation** — `<FileBrowser>` accepts `defaultOrientation`
  (`horizontal`/`vertical`) and ships a header toggle so the user can flip
  between side-by-side and stacked layouts. The choice is persisted per
  `orientationScope` in `localStorage` (`newmob.sftp.orientation.<scope>`).
  The narrow attached `<SftpSidebar>` defaults to vertical (stacked); the
  full-tab and detached views default to horizontal.
- **OSC 7 auto-inject** — under *Advanced SSH settings* the user can
  disable injection of the `PROMPT_COMMAND`/`precmd_functions` snippet
  per-session (default ON). The flag flows through `options_json` →
  `SshConnectInfo.osc7AutoInject` → `<TerminalPanel>`.

A disabled "Cross-host transfer (remote ↔ remote)" placeholder lives in
the SFTP footer to reserve the spot for the upcoming feature.

Transfers can be **paused, resumed, retried, or cancelled** from the
queue UI. The Rust transfer worker holds an `AtomicBool + tokio::Notify`
that the chunk loop checks every block; pause emits
`sftp-paused-{transferId}` so the UI can flip its badge immediately.

**Folder transfers** are supported in both directions
(`sftp_upload_dir` / `sftp_download_dir`). The backend pre-walks the
tree (`local::dir_size` / `ActiveSftp::dir_size`) to compute an accurate
total byte count, then walks again to copy each file while a shared
`Arc<AtomicU64>` counter aggregates progress into the existing
`sftp-progress-{id}` event stream. Cancel and pause are checked at every
walk iteration and inside each file's chunk loop, so suspending in the
middle of a deep tree (or between empty subdirs) takes effect promptly.
`mkdir_idempotent` swallows "already exists" while preserving the
original `create_dir` error message when the path also fails to stat as
a directory. Symlinks and special files are skipped. The transfer queue
records an explicit `kind: "file" | "dir"` at enqueue time so retries
route to the correct command (the previous `size === 0` heuristic
mis-classified empty files as directories). The browser-preview stubs
return a friendly "not available in browser preview" error for both dir
commands. `startTransferTracking` awaits listener registration before
returning so any synchronous completion event from the stub layer
cannot race past the listeners.

**chmod** accepts a `side: FileSide` parameter and routes `Local` →
`local::chmod` (Unix-only via `PermissionsExt`; non-Unix returns an
explicit error) and `Remote` → SFTP `setstat`. The browser-preview stub
no-ops the local case because the in-memory VFS does not track POSIX
permission bits.

A small `BroadcastChannel` (`newmob.sftp.sync`, see `src/lib/sftpSync.ts`)
mirrors the in-memory transfer queue across same-origin windows so a
detached SFTP window and the main app see the same upload/download list.

**Frontend layers:**
- `src/components/filebrowser/` — `FileBrowser`, `FilePanel`, `PathBreadcrumb`,
  `FileToolbar`, `FileTransferQueue`, `SftpSidebar`, `SftpDetachedWindow`
- `src/stores/sftpStore.ts` (per-session pane state) and `transferStore.ts`
  (global transfer queue with progress/eta/cancel)
- `src/lib/sftp.ts` — single source of truth for the Tauri command surface
  (every `invoke("sftp_*", …)` lives here so the desktop and web stubs stay
  aligned)
- `src/lib/sftpController.ts` — high-level operations (open, refresh, mkdir,
  remove, rename, upload, download, double-click "download first" prompt)
- `src/lib/runtime.ts` — small Tauri-vs-web detector used by the controller to
  decide local-FS vs IndexedDB VFS

**Backend (`src-tauri/src/filebrowser/`):**
- `sftp.rs` — `russh-sftp 2.x` wrapper. Opens a fresh `channel_open_session`,
  requests the `sftp` subsystem, and keeps the parent `client::Handle`
  alive for the lifetime of `ActiveSftp` so the SSH connection task is
  not dropped under it.
- `local.rs` — `std::fs` operations (list/stat/mkdir/remove/rename/read/write,
  plus `xdg-open`/`open`/`start` for `sftp_open_path`)
- `transfer.rs` — `Arc<TransferHandle>` per upload/download with an
  `AtomicBool` cancellation flag; emits `sftp-progress-{transferId}` on
  every chunk and `sftp-transfer-complete-{transferId}` at the end
- `mod.rs` — registers all `sftp_*` Tauri commands (see `lib.rs` handler list).
  `AppState` gains `sftp_sessions: HashMap<String, Arc<ActiveSftp>>` and
  `transfers: HashMap<String, Arc<TransferHandle>>`.

**Web mode (dev-only) parity:**
- `vite-plugins/sftpProxy.ts` — `ws.WebSocketServer` on `/__newmob/sftp-bridge`,
  drives an `ssh2.SFTPWrapper` for remote ops (mirrors the JSON envelope
  protocol of the SSH proxy)
- `src/stubs/sftpClient.ts` — WebSocket client used by `tauri-core` stub
- `src/stubs/localVfs.ts` — IndexedDB-backed local filesystem rooted at
  `/preview/` (real files cannot be touched from the browser sandbox)

## Real SSH in the Browser (WebSocket proxy, web mode only)

This whole subsystem is dev-only and is **not** part of the Tauri desktop release.
The Vite dev server hosts an SSH proxy alongside it so the browser preview can talk to real SSH servers:

- **`vite-plugins/sshProxy.ts`** — A Vite plugin that attaches a `ws.WebSocketServer` (noServer mode) to Vite's HTTP server's `upgrade` event, listening on path `/__newmob/ssh-bridge`. For each WS connection it spins up an `ssh2.Client`, opens an interactive shell, and pipes bytes both ways (binary frames are base64-encoded inside small JSON envelopes).
- **Wire protocol**:
  - Client → server: `{type:"connect",host,port,username,authMethod,authData,cols,rows,test?}` · `{type:"data",data:base64}` · `{type:"resize",cols,rows}` · `{type:"signal",signal}` · `{type:"close"}`
  - Server → client: `{type:"ready"}` (or `{type:"ok",message}` for `test:true`) · `{type:"output",data:base64}` · `{type:"error",message}` · `{type:"closed"}`
- **Auth**: `Password` works directly. `PrivateKey` requires the PEM key text to be passed as `authData` (file paths can't be read in the browser). `Agent` is rejected.
- **Hosts the Replit container can reach** are the only valid SSH targets (e.g. `test.rebex.net:22` user `demo` / pass `password` is a public demo).
- The same proxy is unused by the desktop Tauri build, which keeps using the original Rust `russh` backend. The plugin is `apply: "serve"` so it never runs in production builds.

## Development

```bash
pnpm install
pnpm run dev       # Starts Vite dev server on port 5000
pnpm run build     # Production build to dist/
pnpm run test      # Unit tests via vitest
```

## Deployment

Configured as a **static** site deployment:
- Build command: `pnpm run build`
- Public directory: `dist/`

## Notes

- Session data is persisted in `localStorage` (keys: `newmob.sessions.v1`, `newmob.groups.v1`)
- SSH connections in browser preview are real (via the WebSocket proxy above). Local PTY and the placeholder protocols (RDP/VNC/SFTP/Telnet/Serial) are still UI-only.

## Running the Tauri desktop build on Replit (verified)

The full Tauri 2 + Rust desktop app builds and runs inside Replit and can be
viewed through the workspace **Tools → VNC** panel.

- **Toolchain:** `rust-stable`, `nodejs-20`, `pnpm`, plus the system libs
  already pinned in `replit.nix` (webkit2gtk-4.1, gtk+-3.0, libsoup-3.0,
  openssl, librsvg, glib, pkg-config). `@tauri-apps/cli` and
  `@tauri-apps/api` must share the same major+minor as the Rust `tauri`
  crate; otherwise `tauri build` aborts with a "version mismatched" error.
  Last verified pairing: Rust crate `tauri 2.11`, npm `@tauri-apps/cli@^2.10.1`,
  npm `@tauri-apps/api@^2.11.0` — adjust together when bumping any of them.
- **Virtual display:** the `VNC Server` workflow runs `scripts/start-vnc.sh`,
  which launches `Xvnc :0` on RFB port `5901` (no auth, 1280x800x24, bound to
  localhost), then `websockify` on `0.0.0.0:5900` to bridge wss → raw RFB,
  plus `fluxbox` as the window manager. It then launches
  `src-tauri/target/debug/newmob` on `DISPLAY=:0` in the background and
  supervises all four children with `wait -n` plus an `EXIT/INT/TERM`
  trap that tears the whole stack down if any one of them dies.
  Replit's Tools → VNC connects via wss to port 5900; the websockify
  bridge is required because tigervnc Xvnc speaks raw RFB only.
  The workflow is configured with `outputType: "vnc"`; Replit auto-waits
  for port 5900 to open before marking it ready.
  `websockify` lives at a hashed nix-store path and is not on the workflow
  PATH, so the script resolves it via `command -v` then a
  `/nix/store/*python*websockify*/bin/websockify` glob fallback.
  Security note: the websockify bridge listens on `0.0.0.0:5900` with
  `SecurityTypes None` (no VNC password). It is safe only because port
  5900 is not in Replit's external-port allowlist and is reachable
  exclusively through the workspace Tools → VNC proxy. Do **not** add
  port 5900 to `[[ports]]` in `.replit` or otherwise expose it publicly
  without first putting auth in front of it.
- **Build:** the `Tauri Build` workflow runs `pnpm tauri build --debug --no-bundle`.
  First compile of the Rust deps (russh, rusqlite, font-kit, portable-pty,
  tokio, …) takes ~2.5 minutes; incremental rebuilds are much faster.
  After the binary is produced, restart the `VNC Server` workflow to relaunch it.
- **Production bundle:** for a release build use `pnpm tauri build` (drop
  `--debug --no-bundle`); on Replit this produces a Linux binary, not a macOS
  `.app` / Windows `.exe` — those still require their respective host OSes.
- The app theme (light/dark/system) is stored in `localStorage` under `newmob.appTheme.v1`
- SFTP detached windows: in Tauri they spawn a real `WebviewWindow` via
  the `open_sftp_window` command; in browser preview they fall back to
  `window.open` and report "Browser blocked the SFTP window…" if pop-ups
  are denied. Handoff is via `localStorage` so the new window can read
  the credentials regardless of runtime.

## SFTP drag-and-drop

Cross-pane drag-and-drop (REMOTE↔LOCAL inside the same SFTP session) is
implemented via HTML5 drag events in `FilePanel.tsx` using a custom
`application/x-newmob-files` MIME payload that bundles the current
selection (multi-select + folder support routed through
`sftp_upload_dir`/`sftp_download_dir`).

OS file drops onto a pane are **intentionally disabled**. Use the
toolbar "Upload from disk" button instead; dropping arbitrary OS files
into the SFTP browser is not supported.

**Critical Tauri config:** Tauri 2 by default intercepts drag-drop
events on Windows (WebView2) before the webview sees them, which made
the cross-pane drag silently no-op on Win11. Both the main window
(`tauri.conf.json` → `app.windows[].dragDropEnabled: false`) and the
detached SFTP `WebviewWindow` (`.disable_drag_drop_handler()` in
`open_sftp_window`) opt out of this so HTML5 drag events reach React.

## Known Pitfalls / Fixes

- **`onNewSession(groupPath?: string | null)` must not be bound directly to a button `onClick`.**
  React passes the `MouseEvent` as the first argument, which then propagates as `groupPath` and crashes
  `splitGroupPath` with `path.replace is not a function`. Always wrap: `onClick={() => onNewSession?.()}`.
  `splitGroupPath` also has a `typeof !== "string"` guard as defence-in-depth.

- **`AuthPrompt` must not submit on empty password.** When QuickConnect's Enter keypress
  immediately mounts the modal, `autoFocus` on the password input combined with a still-active
  Enter event can submit the form before the user types anything, which then opens an SSH session
  with no credentials. The modal validates `if (!password) return` and disables the Connect
  button until something is typed.
