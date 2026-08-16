# Taomni

Taomni is an AI-native remote workspace for developers. Built with **Tauri 2, React 19, TypeScript, and Rust**, it runs as a native desktop application on Linux, macOS, and Windows. It integrates local terminals, SSH, SFTP, RDP/VNC, tunnels, database clients, mail, and AI-assisted workflows into one compact workspace.

## Project layout

```
src/                    React frontend (TypeScript)
src/components/         UI components
src/layouts/            Application shells
src/lib/                IPC clients and shared utilities
src/stores/             Frontend state (Zustand)
src/stubs/              Browser-only Tauri API stubs (for dev without Rust)
src/test/               Vitest setup
src-tauri/              Tauri/Rust backend
src-tauri/src/          Rust modules
src-tauri/tests/        Rust integration tests
qa-ui-auto-tests/       UI automation YAML test cases
claudedocs/             Design and implementation planning documents
```

## Stack

- **Frontend:** React 19, TypeScript, Vite 8, Tailwind CSS 4, Zustand
- **Desktop shell:** Tauri 2 (Rust)
- **Terminal:** xterm.js
- **Editor:** CodeMirror 6
- **Collaboration:** Yjs
- **Testing:** Vitest, @testing-library/react

## Running (not configured on Replit)

This project is imported here for browsing/study purposes. It is a native desktop app — full functionality requires building the Tauri/Rust backend locally.

To run the React frontend in browser stub mode locally:
```bash
pnpm install
pnpm dev
```

To build the full desktop app locally:
```bash
pnpm tauri build
```

## User preferences

- Project imported for code browsing/study only — no run workflow needed on Replit.
