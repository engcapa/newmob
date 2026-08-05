# Browser Preview and Replit Development

> The filename is retained for existing references. This document covers the browser-only development mode, including Replit. Taomni's shipped product remains the Tauri 2 desktop application.

## Runtime modes

`vite.config.ts` checks `TAURI_ENV_PLATFORM`:

| Mode | Command | Port | Backend behavior |
|---|---|---:|---|
| Browser preview | `pnpm dev` | 5000 | Tauri APIs are aliased to `src/stubs/`; development SSH/SFTP/RDP Vite plugins are enabled |
| Tauri development | `pnpm tauri dev` | 1980 | Real Tauri APIs and Rust commands; proxy plugins and aliases are disabled |
| Frontend build | `pnpm build` | n/a | Builds the browser-compatible frontend assets into `dist/` |
| Desktop package | `pnpm tauri build` | n/a | Builds the frontend and native bundles for the current platform |

Both frontend modes use React 19, TypeScript, Vite 8, Tailwind CSS 4, Zustand, xterm.js, and CodeMirror 6.

## Browser adaptation boundary

Browser mode exists for UI development, deterministic component behavior, and E2E smoke tests. It must not change desktop semantics.

`vite.config.ts` aliases these modules to local stubs when `TAURI_ENV_PLATFORM` is absent:

- `@tauri-apps/api/core`
- `@tauri-apps/api/window`
- `@tauri-apps/api/event`
- shell, notification, and dialog plugins

The stubs model bounded local behavior such as settings, sessions, notes, local virtual files, and dialogs. Native keyrings, OS capture/input injection, privileged networking, packaging, signing, and real platform permissions cannot be validated in browser mode.

## Development bridges

Browser preview enables Vite plugins under `vite-plugins/`:

- `sshProxyPlugin` bridges browser WebSocket traffic to SSH;
- `sftpProxyPlugin` exposes development-only SFTP operations;
- `rdpProxyPlugin` supports browser RDP preview paths.

These bridges run with the permissions and network reachability of the development host. They are not part of the packaged desktop application and must not become a production remote-access service.

## Local development

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5000`. The Vite server binds to `0.0.0.0` with a strict port so hosted environments such as Replit can expose it.

Run tests and the production frontend build with:

```bash
pnpm test
pnpm build
```

For native behavior use:

```bash
pnpm tauri dev
```

## Replit notes

- The browser preview is the normal Replit workflow.
- A Linux Tauri build can run only when the workspace supplies Rust, Tauri system packages, a display/VNC path, and the required WebKitGTK libraries.
- A Replit-hosted build is still a Linux build; it cannot validate Windows/macOS native paths or produce their release bundles.
- Remote protocol targets must be reachable from the Replit container.
- Do not commit Replit credentials, generated logs, `dist/`, or `src-tauri/target/`.

## UI and file-transfer behavior

Browser file operations use the local virtual filesystem/stubs. Desktop local files use Tauri commands. SFTP panes keep browser and desktop wiring behind their respective adapters.

HTML5 cross-pane drag-and-drop depends on Tauri allowing webview drag events. The main window and detached SFTP windows deliberately disable Tauri's native drag-drop interception so React receives browser drag events. OS file drops remain separate from cross-pane SFTP drag behavior.

## Common pitfalls

- Do not bind callbacks with optional domain arguments directly to `onClick`; wrap them so React's `MouseEvent` is not mistaken for the domain value.
- Authentication prompts must reject empty credentials and guard against the Enter key event that opened the dialog.
- Add every new desktop IPC command to the typed frontend boundary and provide a browser fallback or an explicit unsupported error.
- Keep build targets at `es2020`/`safari16` compatibility because packaged WebViews can be older than the development browser.
