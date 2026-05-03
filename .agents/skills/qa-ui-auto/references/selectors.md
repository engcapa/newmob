# NewMob UI selectors used by qa-ui-auto

The runner targets stable `data-testid` attributes whenever possible. When the
UI changes, update both the component and this list. The template
`testcase-for-auto.md` is regenerated from these selectors.

## Main shell
- `[data-testid="menu-bar"]` - top menu row
- `[data-testid="ribbon"]` - ribbon command row
- `[data-testid="ribbon-session"]` - open Session settings
- `[data-testid="ribbon-sftp"]` - open SFTP session settings
- `[data-testid="ribbon-settings"]` - open global Settings tab
- `[data-testid="quick-connect"]` - quick connect bar
- `[data-testid="qc-input"]` - quick connect address input
- `[data-testid="qc-submit"]` - quick connect submit button
- `[data-testid="sidebar"]` - left sidebar
- `[data-testid="tab-bar"]` - tab strip
- `[data-testid="tab-item"]` - individual tab
- `[data-testid="new-local-terminal"]` - plus tab button
- `[data-testid="status-bar"]` - bottom status bar
- `[data-testid="welcome-panel"]` - welcome/start panel
- `[data-testid="welcome-open-local-terminal"]` - welcome local terminal action
- `[data-testid="context-menu"]` - shared right-click menu surface
- `[data-testid="context-menu-item-<slug>"]` - shared right-click menu item

## Terminal
- `[data-testid="terminal-pane"]` - active xterm container
- `[data-testid="attached-sftp-toggle"]` - SSH terminal SFTP sidebar toggle
- `button[aria-label="Cycle application theme"]` - application theme quick cycle

## Settings and terminal appearance
- `[data-testid="settings-panel"]` - settings panel root
- `[data-testid="terminal-appearance-settings"]` - shared terminal profile controls
- `[data-testid="terminal-theme-gallery"]` - terminal theme preview gallery
- `[data-testid="terminal-preview"]` - terminal appearance preview

## Session editor
- `[data-testid="session-new"]` - sidebar "new session" action
- `[data-testid="session-edit"]` - sidebar edit selected action
- `[data-testid="session-duplicate"]` - sidebar duplicate selected action
- `[data-testid="session-delete"]` - sidebar delete selected action
- `[data-testid="session-search"]` - sidebar session search
- `[data-testid="session-tree"]` - session tree root
- `[data-testid="session-tree-item"]` - tree row; also exposes `data-session-name` and `data-session-type`
- `[data-testid="session-editor"]` - session settings dialog
- `[data-testid="session-proto-ssh"]` - SSH protocol selector
- `[data-testid="session-proto-sftp"]` - SFTP protocol selector
- `[data-testid="session-host"]` - remote host field
- `[data-testid="session-port"]` - port field
- `[data-testid="session-user"]` - username field
- `[data-testid="session-name"]` - bookmark/session name field
- `[data-testid="session-save"]` - OK/save button
- `[data-testid="session-section-advanced"]` - advanced SSH settings tab
- `[data-testid="session-section-terminal"]` - terminal settings tab
- `[data-testid="session-section-network"]` - network settings tab
- `[data-testid="session-section-bookmark"]` - bookmark settings tab
- `[data-testid="advanced-ssh-settings"]` - advanced SSH settings body
- `[data-testid="terminal-settings"]` - per-session terminal settings body
- `[data-testid="network-settings"]` - network settings body
- `[data-testid="bookmark-settings"]` - bookmark settings body
- `[data-testid="auth-prompt"]` - SSH/SFTP password prompt
- `[data-testid="auth-password"]` - password input
- `[data-testid="auth-submit"]` - password submit button

## SFTP
- `[data-testid="sftp-browser"]` - dual-pane SFTP browser root
- `[data-testid="sftp-remote-pane"]` - remote pane root
- `[data-testid="sftp-local-pane"]` - local pane root
- `[data-testid="sftp-remote-list"]` / `[data-testid="sftp-local-list"]` - file table scroll area
- `[data-testid="sftp-remote-path"]` - remote path breadcrumb/editor
- `[data-testid="sftp-local-path"]` - local path breadcrumb/editor
- `[data-testid="sftp-transfer-queue"]` - transfer queue panel
- `[data-testid="sftp-remote-refresh"]` / `[data-testid="sftp-local-refresh"]` - refresh pane
- `[data-testid="sftp-remote-new-file"]` / `[data-testid="sftp-local-new-file"]` - create file
- `[data-testid="sftp-remote-new-folder"]` / `[data-testid="sftp-local-new-folder"]` - create folder
- `[data-testid="sftp-remote-download-selected"]` - download selected remote entries
- `[data-testid="sftp-local-upload-selected"]` - upload selected local entries
- `[data-testid="sftp-remote-upload-from-disk"]` - upload files from OS picker
- `[data-testid="sftp-remote-delete"]` / `[data-testid="sftp-local-delete"]` - delete selected entries
- `[data-testid="sftp-remote-preview"]` / `[data-testid="sftp-local-preview"]` - preview selected text file
- `[data-testid="sftp-remote-chmod"]` / `[data-testid="sftp-local-chmod"]` - permission dialog
- `[data-testid="sftp-remote-open-terminal-here"]` - `cd` parent terminal into remote path
- `[data-testid="col-header-name"]`, `[data-testid="col-header-size"]`, `[data-testid="col-header-modified"]`, `[data-testid="col-header-type"]` - file table headers
- `[data-testid="col-resize-name"]`, `[data-testid="col-resize-size"]`, `[data-testid="col-resize-modified"]`, `[data-testid="col-resize-type"]` - file table resize handles

## Notes
- Prefer `data-testid` selectors for E2E steps that must survive text changes.
- `text=` and `role=` selectors are still useful for user-facing assertions and
  menu item checks.
- Browser-mode cases that use `eval 'async page => ...'` rely on Playwright API
  access and should stay `mode: browser`.
