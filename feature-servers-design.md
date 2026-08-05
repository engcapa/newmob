# Feature Design: Servers Management

> Taomni — Local Server Manager Panel  
> Design reference: MobaXterm "Servers management" dialog  
> UI system: Taomni design tokens (`--taomni-*`), Tailwind CSS, React 19 + TypeScript

---

## 1. Overview

The **Servers** feature lets users start, stop, and configure lightweight local servers directly from Taomni — eliminating the need for external tools. Supported server types mirror MobaXterm's offering and are extended with modern additions.

### Supported Server Types

| # | Server | Protocol | Default Port | Description |
|---|--------|----------|-------------|-------------|
| 1 | SSH/SFTP | TCP | 22 | Minimal SSH server using current OS credentials |
| 2 | FTP | TCP | 21 | Simple FTP server for local file sharing |
| 3 | TFTP | UDP | 69 | Trivial FTP for firmware/config transfers |
| 4 | HTTP | TCP | 8080 | Static file server / reverse proxy |
| 5 | Telnet | TCP | 23 | Legacy Telnet server |
| 6 | VNC | TCP | 5900 | VNC server to share local desktop |
| 7 | NFS | TCP/UDP | 2049 | Network File System share |
| 8 | Cron | — | — | Local cron job scheduler with log output |
| 9 | Iperf | TCP/UDP | 5201 | Network bandwidth testing server |

---

## 2. Entry Point

### 2.1 Ribbon Button

Add a **"Servers"** button to the main ribbon toolbar (between "Tunnels" and "Tools" groups).

```
Icon: server-stack (Lucide `Server`)
Label: Servers
Color: #0891b2 (cyan-600) — distinct from SSH blue, signals "local infrastructure"
```

### 2.2 Keyboard Shortcut

`Ctrl+Shift+S` — opens the Servers panel.

---

## 3. UI Architecture

The Servers feature is implemented as a **modal dialog** (not a sidebar panel), consistent with how Taomni handles Tunnels and other utility windows. It is a floating, resizable, non-blocking dialog.

### 3.1 Dialog Shell

```
Component: ServersDialog
Type: Modal overlay (z-index: 400, same layer as other dialogs)
Size: 720px × 520px default, min 600px × 420px, resizable
Position: Centered on first open, then remembered per session
```

**Structure:**
```
┌─────────────────────────────────────────────────────────────┐
│  [Server icon]  Servers Management          [─] [□] [✕]     │  ← Title bar (28px, --taomni-chrome-bg gradient)
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │  Server List     │  │  Settings Panel                  │ │
│  │  (220px fixed)   │  │  (flex-1)                        │ │
│  │                  │  │                                  │ │
│  │  [server rows]   │  │  [selected server config]        │ │
│  │                  │  │                                  │ │
│  └──────────────────┘  └──────────────────────────────────┘ │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                          [Cancel]  [Apply]  │  ← Footer (36px)
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Server List Panel (Left)

### 4.1 Layout

- Fixed width: **220px**
- Right border: `1px solid var(--taomni-divider)`
- Background: `var(--taomni-chrome-bg)`
- Scrollable if server list grows

### 4.2 Server Row

Each row is **40px tall** and contains:

```
┌────────────────────────────────────────────────┐
│  [status dot]  SSH/SFTP server    [▶] [■] [⚙]  │
└────────────────────────────────────────────────┘
```

**Elements:**

| Element | Detail |
|---------|--------|
| Status dot | 8px circle: green `#16a34a` = running, gray `#94a3b8` = stopped, amber `#f59e0b` = starting |
| Server name | `var(--taomni-text)`, 12px, font-weight 500, truncated with ellipsis |
| Start button `▶` | 22×22px icon button, Lucide `Play`, color `#16a34a` when stopped |
| Stop button `■` | 22×22px icon button, Lucide `Square`, color `#dc2626` when running |
| Settings button `⚙` | 22×22px icon button, Lucide `Settings2`, color `var(--taomni-accent)` |

**Row states:**
- Default: `background: transparent`
- Hover: `background: var(--taomni-hover)`
- Selected: `background: var(--taomni-selected)`, left border `3px solid var(--taomni-accent)`
- Running: status dot pulses with a subtle CSS animation (opacity 1→0.5→1, 2s loop)

### 4.3 Row Component Spec

```tsx
interface ServerRowProps {
  id: ServerType;
  label: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onSettings: () => void;
}
```

---

## 5. Settings Panel (Right)

The right panel shows configuration for the **currently selected** server. It has two sub-sections:

### 5.1 Panel Header

```
┌──────────────────────────────────────────────┐
│  SSH/SFTP server settings                    │
│  ─────────────────────────────────────────   │
│  [info text / description]                   │
└──────────────────────────────────────────────┘
```

- Title: 13px, font-weight 600, `var(--taomni-text)`
- Divider: `1px solid var(--taomni-divider)`, margin 8px 0
- Description: 11px, `var(--taomni-text-muted)`, max 3 lines

### 5.2 Configuration Fields

Each server type has its own config form. Common fields:

#### Common Fields (all servers)

| Field | Type | Default |
|-------|------|---------|
| Listening port | Number input (spin) | Server-specific |
| Auto-stop after | Checkbox + number input | ☑ 3600 seconds |
| Bind address | Text input | `0.0.0.0` |
| Start on app launch | Checkbox | ☐ |

#### SSH/SFTP Specific

| Field | Type | Notes |
|-------|------|-------|
| Listening port | Number | Default: 22 |
| Auth method | Select | `OS credentials` / `Key file` |
| Allowed users | Text | Comma-separated, empty = all |
| SFTP root directory | Path picker | Default: home dir |

#### FTP Specific

| Field | Type | Notes |
|-------|------|-------|
| Listening port | Number | Default: 21 |
| Root directory | Path picker | Required |
| Allow anonymous | Checkbox | ☐ |
| Max connections | Number | Default: 10 |

#### HTTP Specific

| Field | Type | Notes |
|-------|------|-------|
| Listening port | Number | Default: 8080 |
| Root directory | Path picker | Required |
| Enable directory listing | Checkbox | ☑ |
| CORS headers | Checkbox | ☐ |

#### VNC Specific

| Field | Type | Notes |
|-------|------|-------|
| Listening port | Number | Default: 5900 |
| Password | Password input | Required |
| View-only mode | Checkbox | ☐ |
| Shared desktop | Checkbox | ☑ |

#### Iperf Specific

| Field | Type | Notes |
|-------|------|-------|
| Listening port | Number | Default: 5201 |
| Protocol | Radio | TCP / UDP |
| Bandwidth limit | Number + unit | Optional |

#### Cron Specific

| Field | Type | Notes |
|-------|------|-------|
| (No port config) | — | — |
| Cron expression | Text | e.g. `*/5 * * * *` |
| Command | Text | Shell command to run |
| Working directory | Path picker | Optional |

### 5.3 Server Output Log

Below the config fields, a **log output area** shows real-time server stdout/stderr:

```
┌──────────────────────────────────────────────┐
│  Server output                    [Clear] [↓] │
│  ┌────────────────────────────────────────┐   │
│  │ [2026-05-30 14:22:01] Server started   │   │
│  │ [2026-05-30 14:22:03] Client connected │   │
│  │ [2026-05-30 14:22:10] 192.168.1.5:... │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

- Log area: `background: var(--taomni-term-bg)`, `color: var(--taomni-term-text)`, monospace 11px
- Height: `120px` fixed, scrollable, auto-scrolls to bottom when running
- `[Clear]` button: clears log buffer
- `[↓]` button: toggles auto-scroll lock

---

## 6. Field Component Specs

All form fields follow the existing Taomni input design system:

### Number Input (Spin)

```css
height: 22px;
border-radius: 2px;
border: 1px solid var(--taomni-input-border);
background: var(--taomni-input-bg);
font-size: 12px;
padding: 0 6px;
width: 80px;
```

Spin buttons: native browser spinners, styled to match chrome.

### Text Input

```css
height: 22px;
border-radius: 2px;
border: 1px solid var(--taomni-input-border);
background: var(--taomni-input-bg);
font-size: 12px;
padding: 0 6px;
width: 100%;
```

Focus ring: `box-shadow: 0 0 0 2px var(--taomni-accent-soft)40`

### Checkbox

Native checkbox with custom accent color: `accent-color: var(--taomni-accent)`

### Path Picker

Text input + `[Browse…]` button inline:

```
[  /home/user/share          ] [Browse…]
```

Button: same style as secondary button (see §7).

### Select / Dropdown

```css
height: 22px;
border-radius: 2px;
border: 1px solid var(--taomni-input-border);
background: var(--taomni-input-bg);
font-size: 12px;
padding: 0 4px;
```

### Form Row Layout

```
Label (100px, right-aligned, muted)    [  Input field  ]
```

Label: `font-size: 12px; color: var(--taomni-text-muted); text-align: right; padding-right: 8px;`

---

## 7. Footer Buttons

```
                              [Cancel]  [Apply]
```

### Primary Button (Apply / OK)

```css
height: 26px;
padding: 0 16px;
border-radius: 3px;
background: linear-gradient(to bottom, var(--taomni-accent-soft), var(--taomni-accent));
color: #ffffff;
font-size: 12px;
font-weight: 500;
border: 1px solid var(--taomni-accent);
```

Hover: `filter: brightness(1.1)`  
Active: `filter: brightness(0.95)`

### Secondary Button (Cancel)

```css
height: 26px;
padding: 0 16px;
border-radius: 3px;
background: var(--taomni-chrome-bg);
color: var(--taomni-text);
font-size: 12px;
border: 1px solid var(--taomni-chrome-border);
```

---

## 8. State Management

### Zustand Store: `serversStore`

```typescript
interface ServerConfig {
  port: number;
  bindAddress: string;
  autoStop: boolean;
  autoStopSeconds: number;
  startOnLaunch: boolean;
  // server-specific fields...
  [key: string]: unknown;
}

interface ServerState {
  status: 'stopped' | 'starting' | 'running' | 'error';
  pid?: number;
  startedAt?: number;
  logLines: string[];
}

interface ServersStore {
  // Dialog visibility
  isOpen: boolean;
  selectedServer: ServerType | null;

  // Per-server config (persisted to SQLite)
  configs: Record<ServerType, ServerConfig>;

  // Per-server runtime state (in-memory only)
  states: Record<ServerType, ServerState>;

  // Actions
  openDialog: () => void;
  closeDialog: () => void;
  selectServer: (type: ServerType) => void;
  updateConfig: (type: ServerType, patch: Partial<ServerConfig>) => void;
  startServer: (type: ServerType) => Promise<void>;
  stopServer: (type: ServerType) => Promise<void>;
  clearLog: (type: ServerType) => void;
}
```

### Persistence

Server configs are persisted to the existing SQLite database (`taomni.db`) in a new `server_configs` table:

```sql
CREATE TABLE server_configs (
  server_type TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Server runtime state (status, PID, logs) is **not** persisted — it is reconstructed on app start by probing whether the server process is still alive.

---

## 9. Tauri Backend Commands

New Rust commands to register in `lib.rs`:

```rust
// Start a local server
#[tauri::command]
async fn start_local_server(server_type: String, config: serde_json::Value) -> Result<u32, String>

// Stop a running local server
#[tauri::command]
async fn stop_local_server(server_type: String) -> Result<(), String>

// Get current server status (pid, running?)
#[tauri::command]
async fn get_server_status(server_type: String) -> Result<ServerStatus, String>

// Save server config to DB
#[tauri::command]
async fn save_server_config(server_type: String, config: serde_json::Value) -> Result<(), String>

// Load all server configs from DB
#[tauri::command]
async fn load_server_configs() -> Result<HashMap<String, serde_json::Value>, String>
```

Tauri events emitted from Rust → frontend:

```
server://output/{server_type}   — new log line (payload: string)
server://status/{server_type}   — status change (payload: ServerStatus)
```

---

## 10. Component File Structure

```
src/
  components/
    servers/
      ServersDialog.tsx          ← Main dialog shell
      ServerList.tsx             ← Left panel: list of server rows
      ServerRow.tsx              ← Individual server row with controls
      ServerSettings.tsx         ← Right panel: config form dispatcher
      ServerOutputLog.tsx        ← Log output area component
      settings/
        SshSftpSettings.tsx      ← SSH/SFTP config form
        FtpSettings.tsx          ← FTP config form
        TftpSettings.tsx         ← TFTP config form
        HttpSettings.tsx         ← HTTP config form
        TelnetSettings.tsx       ← Telnet config form
        VncSettings.tsx          ← VNC config form
        NfsSettings.tsx          ← NFS config form
        CronSettings.tsx         ← Cron config form
        IperfSettings.tsx        ← Iperf config form
        CommonSettings.tsx       ← Shared fields (port, auto-stop, bind addr)
  stores/
    serversStore.ts              ← Zustand store
  lib/
    servers.ts                   ← IPC wrappers for server commands
```

---

## 11. Visual Mockup (ASCII)

```
┌─ [⚙] Servers Management ─────────────────────────────────────────── [─][□][✕] ─┐
│                                                                                   │
│  ┌─────────────────────┬─────────────────────────────────────────────────────┐   │
│  │ • SSH/SFTP server   │  SSH/SFTP server settings                           │   │
│  │   [▶][■][⚙]         │  ─────────────────────────────────────────────────  │   │
│  │                     │  Simple SSH/SFTP server using current OS login.     │   │
│  │ ○ FTP server        │                                                     │   │
│  │   [▶][■][⚙]         │  Listening port    [ 22  ↕]                        │   │
│  │                     │  Bind address      [ 0.0.0.0              ]        │   │
│  │ ○ TFTP server       │  Auth method       [ OS credentials     ▾]        │   │
│  │   [▶][■][⚙]         │  SFTP root dir     [ /home/user    ] [Browse…]    │   │
│  │                     │  ☑ Auto-stop after [ 3600 ↕] seconds              │   │
│  │ ○ HTTP server       │  ☐ Start on app launch                             │   │
│  │   [▶][■][⚙]         │                                                     │   │
│  │                     │  Server output                        [Clear] [↓]  │   │
│  │ ○ Telnet server     │  ┌─────────────────────────────────────────────┐   │   │
│  │   [▶][■][⚙]         │  │ [14:22:01] Server started on port 22       │   │   │
│  │                     │  │ [14:22:03] Client 192.168.1.5 connected     │   │   │
│  │ ○ VNC server        │  │ [14:22:10] Session opened: zhyha            │   │   │
│  │   [▶][■][⚙]         │  └─────────────────────────────────────────────┘   │   │
│  │                     │                                                     │   │
│  │ ○ NFS server        │                                                     │   │
│  │   [▶][■][⚙]         │                                                     │   │
│  │                     │                                                     │   │
│  │ ○ Cron server       │                                                     │   │
│  │   [▶][■][⚙]         │                                                     │   │
│  │                     │                                                     │   │
│  │ ○ Iperf server      │                                                     │   │
│  │   [▶][■][⚙]         │                                                     │   │
│  └─────────────────────┴─────────────────────────────────────────────────────┘   │
│                                                              [Cancel]  [Apply]    │
└───────────────────────────────────────────────────────────────────────────────────┘

Legend:  •  running (green dot)   ○  stopped (gray dot)   ◐  starting (amber dot)
         ▶  Start   ■  Stop   ⚙  Settings (selects row)
```

---

## 12. Interaction Flows

### Start a Server

1. User clicks `▶` on a stopped server row
2. Row status dot turns amber (starting), `▶` button disabled
3. Tauri command `start_local_server` invoked with current config
4. On success: dot turns green, `▶` disabled, `■` enabled
5. Log area begins receiving `server://output/{type}` events
6. On error: dot turns red, toast notification shown

### Stop a Server

1. User clicks `■` on a running server row
2. Tauri command `stop_local_server` invoked
3. Dot turns gray, `■` disabled, `▶` enabled
4. Log appends: `[HH:MM:SS] Server stopped`

### Change Config

1. User selects a server row (clicks anywhere on row or `⚙`)
2. Right panel shows that server's config form
3. User edits fields — changes are held in local state (not yet saved)
4. User clicks `[Apply]` → `save_server_config` called, store updated
5. If server is running and port changed: warning shown — "Restart server to apply port change"

### Auto-stop

When auto-stop is enabled, the Rust backend sets a timer. When it fires:
- Server process is killed
- `server://status/{type}` event emitted with `stopped`
- Log appends: `[HH:MM:SS] Auto-stopped after 3600s`

---

## 13. Dark Theme Adaptation

All components use CSS variables, so dark theme is automatic. Additional dark-specific overrides:

```css
html[data-app-theme="dark"] {
  /* Log area already uses --taomni-term-bg which is dark */
  /* Status dot colors remain the same (semantic) */
  /* Running pulse animation: same */
}
```

No additional dark theme work needed beyond the existing token system.

---

## 14. Accessibility

- Dialog: `role="dialog"`, `aria-modal="true"`, `aria-labelledby="servers-dialog-title"`
- Server rows: `role="row"`, `aria-selected`, keyboard navigable with arrow keys
- Start/Stop buttons: `aria-label="Start SSH/SFTP server"` etc.
- Status dots: `aria-label="Running"` / `"Stopped"` (not color-only)
- Log area: `role="log"`, `aria-live="polite"`, `aria-label="Server output"`
- Focus trap within dialog when open
- `Escape` key closes dialog (with unsaved-changes confirmation if dirty)

---

## 15. Implementation Priority

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | Dialog shell + server list + SSH/SFTP settings + start/stop IPC | ~3 days |
| **Phase 2** | FTP, HTTP, Iperf settings + log output streaming | ~2 days |
| **Phase 3** | TFTP, Telnet, VNC, NFS, Cron settings | ~2 days |
| **Phase 4** | Auto-stop, start-on-launch, config persistence | ~1 day |
| **Phase 5** | Polish, dark theme verification, accessibility audit | ~1 day |

**Total estimated effort: ~9 developer-days**

---

*Design document generated 2026-05-30. Matches Taomni v0.1.37 UI system.*
