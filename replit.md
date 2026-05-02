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

## Browser Adaptation

Since Tauri's native backend is not available in the browser, stub modules are used:

- `src/stubs/tauri-core.ts` — Stubs `invoke()` using localStorage for session/group persistence
- `src/stubs/tauri-window.ts` — Stubs window/close APIs
- `src/stubs/tauri-event.ts` — Stubs event listen/emit APIs
- `src/stubs/tauri-shell.ts` — Stubs shell command APIs

These stubs are aliased via `vite.config.ts` at build time.

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
- Terminal connections (SSH, local shell) are simulated in browser mode — actual connections require the Tauri backend
- The app theme (light/dark/system) is stored in `localStorage` under `newmob.appTheme.v1`

## Known Pitfalls / Fixes

- **`onNewSession(groupPath?: string | null)` must not be bound directly to a button `onClick`.**
  React passes the `MouseEvent` as the first argument, which then propagates as `groupPath` and crashes
  `splitGroupPath` with `path.replace is not a function`. Always wrap: `onClick={() => onNewSession?.()}`.
  `splitGroupPath` also has a `typeof !== "string"` guard as defence-in-depth.
