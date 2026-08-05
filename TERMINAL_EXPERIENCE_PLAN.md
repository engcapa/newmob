# Terminal Experience Status and Backlog

> Status: shared terminal experience is implemented. This file now records the durable behavior contract and the small remaining compatibility backlog.

## Shared behavior

Local and SSH terminals use the same `TerminalPanel`, xterm.js rendering, terminal profile, context menu, history, split/MultiExec integration, capture actions, and output pipeline.

Implemented shared behavior includes:

- copy, copy all, paste, find, clear/reset, title, fullscreen, read-only, and scrollbar controls;
- live font, size, ligature, cursor, theme, scrollback, syntax-highlight, paste, and logging preferences;
- global defaults plus per-session `options_json.terminalProfile` overrides;
- macro recording/playback and common-command palette;
- buffer export and live output recording;
- ZMODEM send/receive with conflict handling;
- keyboard shortcuts and mouse-wheel font resizing;
- Linux WebKitGTK IME composition deduplication;
- attached SFTP toggle for SSH terminals, shared credentials, and optional cwd synchronization;
- terminal screenshot, full-buffer capture, and GIF workflows.

Unsupported backend-specific actions stay disabled and must not execute placeholder behavior.

## Backend differences

- Local terminals can deliver supported OS signals to the child process.
- SSH terminals use channel signal requests where supported and may fall back to Ctrl+C for SIGINT.
- SSH adds attached SFTP, jump host, proxy, keepalive, agent/X11 forwarding, and remote lifecycle behavior.
- PowerShell terminals may suppress AI inline suggestions where they conflict with PSReadLine.

## Profile contract

`TerminalProfile` is the persisted user-facing contract for appearance and terminal behavior. New settings must:

- have a stable default and migration behavior;
- work for both saved and temporary terminals where meaningful;
- apply live when safe;
- be represented in shared Settings and Session Editor controls;
- avoid silently changing an already-running backend connection when reconnection is required.

## Remaining compatibility backlog

- Add reconnect events when a complete reconnect workflow exists.
- Add native RTF clipboard output where the platform clipboard API supports it; HTML/plain text already work.
- Finish cross-platform local signal parity.
- Add SSH break requests where supported by the SSH library/server.
- Continue real-platform IME, clipboard, and shell-specific regression testing.

These items are compatibility enhancements, not blockers for the shared terminal surface.

## Verification

- Colocated Vitest covers the menu, profile state, IME guard, output filters, history, ZMODEM, capture, and MainLayout wiring.
- Rust tests cover terminal creation, binary output delivery, signals, SSH behavior, and cleanup where practical.
- `qa-ui-auto-tests/feature-list.md` owns the implemented controls and partial-status labels.
- Native clipboard, IME, shell, and signal claims require the corresponding operating system.
