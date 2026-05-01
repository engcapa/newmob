# Terminal Appearance Plan

> Goal: improve terminal appearance settings with OS font discovery, Source Code Pro default preference, and a Termius-like theme gallery. Status is updated as implementation and verification progress.

## Requirements

- [x] List font choices from fonts available on the current operating system.
- [x] Prefer Source Code Pro as the default terminal font when it is available.
- [x] Keep a reliable fallback font stack when Source Code Pro is not available.
- [x] Provide a richer terminal theme catalog with visual previews similar to Termius.
- [x] Let users change global terminal appearance settings from the Settings entry.
- [x] Let per-session terminal settings reuse the same font and theme controls.
- [x] Let the active terminal apply font size, font family, ligatures, and theme changes live.
- [x] Keep the terminal preview at the bottom of session and global terminal settings.
- [x] Merge cursor and other profile-backed terminal settings into the same shared UI.
- [x] Reflect cursor style and blink settings in the preview.
- [x] Verify every feature point with automated checks where feasible and build/type checks.

## Implementation Checklist

- [x] Add a Tauri command that enumerates installed OS font families.
- [x] Add frontend IPC helpers and resilient fallback behavior for font loading.
- [x] Update the terminal profile default font stack to prefer Source Code Pro.
- [x] Expand the terminal theme catalog and expose theme metadata for UI rendering.
- [x] Build shared appearance controls: font selector, font-size stepper, theme gallery, and preview.
- [x] Replace the Session Editor terminal font/theme form controls with shared appearance controls.
- [x] Add a global Settings screen focused on terminal appearance.
- [x] Make current terminal theme mutable and add right-click quick theme switching.
- [x] Persist global settings to `localStorage` and keep session overrides stored in `options_json.terminalProfile`.
- [x] Move cursor, scrollback, logging, keyword highlighting, display, clipboard, and paste settings into `TerminalAppearanceSettings`.
- [x] Use the same full terminal profile UI in global Settings and Session Editor.

## Verification Checklist

- [x] Font list can be loaded through the new OS font command.
- [x] Source Code Pro is selected by default when present in the loaded font list.
- [x] Font selector only renders loaded OS fonts plus a safe fallback when loading fails.
- [x] Theme gallery updates the terminal preview.
- [x] Session Editor persists selected font, font size, theme, logging, and highlighting settings.
- [x] Global Settings persists selected font, font size, ligatures, and theme.
- [x] Session Editor and global Settings persist cursor style/blink through the shared UI.
- [x] Terminal preview renders after cursor/scrollback/profile behavior controls.
- [x] Terminal preview reflects cursor block, underline, or bar style and blink state.
- [x] Active terminal can change theme from the context menu without remounting.
- [x] `pnpm test` passes.
- [x] `pnpm build` passes.

## Verification Results

- `cargo test lists_installed_font_families` passed. This exercises the Tauri font enumeration path against the current OS and verifies non-empty, sorted, deduplicated font families.
- `pnpm test` passed. Coverage includes OS font list rendering, Source Code Pro default selection, fallback font list behavior, theme selection, bottom preview placement, cursor preview rendering, Session Editor persistence, and global Settings persistence.
- `pnpm build` passed. This verifies TypeScript and Vite production build output after the shared terminal settings UI refactor.
- `cargo check` passed. This verifies the Rust command and new `font-kit` dependency compile with the Tauri backend.

## Application Theme Extension

- [x] Add global application theme modes: Light, Dark, Follow system.
- [x] Persist the selected application theme mode in `localStorage`.
- [x] Apply the resolved application theme to the root document with `data-app-theme`.
- [x] Listen to `prefers-color-scheme` changes when Follow system is selected.
- [x] Add application theme controls to global Settings.
- [x] Add quick theme switching to the Welcome screen and top menu row.
- [x] Add compact theme switching to the Session settings title bar.
- [x] Update main chrome variables for menu bar, ribbon, quick connect, tabs, sidebar, status bar, cards, inputs, buttons, and context menus.
- [x] Update Session settings and Authentication popups to use theme variables in dark mode.
- [x] Update the status bar to display the current application theme mode.
- [x] Verify application theme persistence and quick switchers with `pnpm test`.
- [x] Verify TypeScript and production build with `pnpm build`.

## Notes

- Browser APIs generally cannot enumerate all local fonts without extra permissions. In Tauri, the stable path is to enumerate fonts in Rust and expose a command to the frontend.
- The default profile can include Source Code Pro first in the CSS font stack. If the font is unavailable, xterm falls through to the next installed monospace font.
