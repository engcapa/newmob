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
- The app theme (light/dark/system) is stored in `localStorage` under `newmob.appTheme.v1`

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
