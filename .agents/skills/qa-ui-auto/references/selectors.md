# NewMob UI selectors used by qa-ui-auto

The runner targets stable `data-testid` attributes whenever possible. When the
UI changes, update both the component and this list. The template
`testcase-for-auto.md` is regenerated from these selectors.

## Menubar / global
- `[data-testid="menubar-settings"]`     — open settings panel
- `[data-testid="settings-panel"]`       — settings panel root
- `[data-testid="settings-close"]`       — close settings
- `[data-testid="theme-toggle"]`         — light/dark toggle

## Tab bar / terminals
- `role=tablist`                         — main tab strip
- `[data-testid="new-local-terminal"]`   — "+" button → spawn local PTY
- `[data-testid="terminal-pane"]`        — active xterm container

## Quick connect
- `[data-testid="quick-connect"]`        — quick-connect launcher
- `[data-testid="qc-input"]`             — URL-style input
- `[data-testid="auth-password"]`        — password field in auth modal
- `[data-testid="auth-submit"]`          — auth modal submit

## Sessions
- `[data-testid="session-new"]`          — "new session" button
- `[data-testid="session-name"]`         — session name field
- `[data-testid="session-host"]`         — host field
- `[data-testid="session-port"]`         — port field
- `[data-testid="session-user"]`         — username field
- `[data-testid="session-save"]`         — save session

## SFTP
- `[data-testid="open-sftp"]`            — open SFTP browser button
- `[data-testid="sftp-remote-pane"]`     — remote pane root
- `[data-testid="sftp-remote-path"]`     — remote path input
- `[data-testid="sftp-upload"]`          — upload action
- `[data-testid="sftp-download"]`        — download action
- `[data-testid="sftp-delete"]`          — delete action

## Notes
- If a component currently lacks a `data-testid`, add one as part of the
  feature change rather than scraping by text — text drifts with i18n.
- Prefer `role=` selectors for accessibility-first elements (buttons, dialogs).
