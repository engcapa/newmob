# NewMob

### Overview

NewMob is a cross-platform SSH/terminal client, inspired by MobaXterm, developed using React, Vite, and TypeScript. Primarily designed as a Tauri desktop application, it has been adapted to function in the browser environment, specifically on Replit, for development and visual testing purposes. The project's core vision is to deliver a robust desktop SSH client, with the web version serving as a development preview.

### User Preferences

The final release target is the Tauri 2 + Rust desktop app. The Vite/web mode that runs on Replit (and `pnpm dev` / `pnpm build` in general) exists **only** for development convenience and visual testing in the browser. Anything added purely to make the web preview work (browser stubs, the WebSocket SSH proxy, etc.) **must not** alter or pollute the desktop build pipeline.

### System Architecture

The frontend is built with React 18, TypeScript, and Vite, utilizing Tailwind CSS for styling and Zustand for state management. The terminal functionality is powered by xterm.js with various addons. Layouts are managed using react-resizable-panels.

**Key Technical Implementations:**

-   **Build Mode Detection:** `vite.config.ts` uses `process.env.TAURI_ENV_PLATFORM` to differentiate between Tauri (desktop) and Web (browser) modes.
    -   **Tauri Mode:** Directly imports `@tauri-apps/api` for communication with the Rust backend.
    -   **Web Mode:** Employs stub aliases for `@tauri-apps/api/*` and registers a WebSocket SSH proxy Vite plugin, as Tauri's native backend is unavailable in the browser.
-   **Browser Adaptation (Web Mode):** Stub modules (`src/stubs/`) mimic Tauri APIs for `invoke()`, window management, event handling, and shell commands. SSH commands are bridged to a WebSocket-based SSH proxy. Local PTY is not available in the browser.
-   **SFTP Browser:** A dual-pane SFTP file manager is integrated, rendering the `<FileBrowser>` component in three ways:
    1.  **Attached sidebar:** Docks an `<SftpSidebar>` next to the terminal, sharing SSH credentials.
    2.  **Standalone tab:** Opens a full-tab `<FileBrowser>` without a terminal.
    3.  **Detached window:** Opens a new window (`window.open` in browser, `WebviewWindow` in Tauri) for SFTP, with credentials passed via `localStorage`.
    -   Supports toggles for "Sync to terminal cwd" and "Pane orientation."
    -   SFTP transfers support pause, resume, retry, and cancellation. Folder transfers are also supported with progress tracking.
    -   `chmod` functionality is implemented for local (Unix-only) and remote files.
    -   A `BroadcastChannel` (`newmob.sftp.sync`) synchronizes the transfer queue across same-origin windows.
-   **Real SSH in Browser (Web Mode Only):** A dev-only WebSocket proxy is integrated into the Vite dev server to allow the browser preview to connect to real SSH servers. This uses `ssh2.Client` and pipes data over WebSockets with a defined wire protocol for client-server communication. `ssh2` and `ws` are `devDependencies` and not included in the desktop build.
-   **UI/UX:** The application supports light, dark, and system themes, stored in `localStorage` under `newmob.appTheme.v1`.
-   **Session Data:** Persisted in `localStorage` under `newmob.sessions.v1` and `newmob.groups.v1`.

### External Dependencies

-   **Frontend:**
    -   React 18
    -   TypeScript
    -   Vite
    -   Tailwind CSS
    -   Zustand
    -   xterm.js (with fit, webgl, search, web-links addons)
    -   react-resizable-panels
-   **Backend (Tauri/Rust):**
    -   `russh` (for SSH connectivity)
    -   `russh-sftp` (for SFTP functionality)
    -   `tokio` (asynchronous runtime)
-   **Development/Web Mode Specific:**
    -   `ssh2` (for WebSocket SSH proxy in web mode)
    -   `ws` (WebSocket library for web mode proxy)
    -   IndexedDB (for `localVfs` in web mode)