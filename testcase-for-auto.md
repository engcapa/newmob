<!-- qa-ui-auto:auto-generated -->
# NewMob — UI E2E Test Cases

> Consumed by the `qa-ui-auto` skill via
> `.agents/skills/qa-ui-auto/scripts/run_tests.py`.
>
> Format reminder (verbs space-separated, args shell-quoted):
>
>   ## TC-<id>: <title>
>   - tags: smoke, p0
>   - mode: browser
>
>   1. open http://localhost:5000
>   2. click 'role=button[name="Connect"]'
>   3. expect_visible 'text="Connected"'
>   4. screenshot connected.png
>
> Placeholders:
>   ${cfg:ssh.host}     → resolved from qa-ui-auto.config.yaml
>   ${env:VAR}          → resolved from environment
>
> Remove the auto-generated header comment above to mark this file as
> user-customised; the skill will then preserve it instead of overwriting.

## TC-001: Launch and render main window
- tags: smoke, p0
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for 'role=tablist'
3. expect_visible 'text="Local Terminal"'
4. screenshot 01-launch.png

## TC-002: Open settings panel and toggle theme
- tags: smoke, ui
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="menubar-settings"]'
3. wait_for '[data-testid="settings-panel"]'
4. click '[data-testid="theme-toggle"]'
5. screenshot 02-theme-toggled.png
6. click '[data-testid="settings-close"]'

## TC-003: Create a local terminal tab
- tags: terminal, p0
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="new-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. type 'echo qa-ui-auto'
5. press Enter
6. expect_text '[data-testid="terminal-pane"]' 'qa-ui-auto'
7. screenshot 03-local-terminal.png

## TC-004: Quick SSH connect
- tags: ssh, p0
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="quick-connect"]'
3. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
4. press Enter
5. fill '[data-testid="auth-password"]' '${cfg:ssh.password}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. type 'whoami'
9. press Enter
10. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
11. screenshot 04-ssh-connected.png

## TC-005: SFTP browse + upload + download + delete
- tags: sftp, p0
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="open-sftp"]'
3. wait_for '[data-testid="sftp-remote-pane"]'
4. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
5. press Enter
6. click '[data-testid="sftp-upload"]'
7. wait_for 'text="Transfer complete"'
8. screenshot 05-sftp-upload.png
9. click '[data-testid="sftp-download"]'
10. wait_for 'text="Transfer complete"'
11. click '[data-testid="sftp-delete"]'
12. wait_for 'text="Deleted"'
13. screenshot 05-sftp-cleanup.png

## TC-006: Save a session and reload from sidebar
- tags: session, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. fill '[data-testid="session-name"]' 'qa-auto-session'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-save"]'
8. wait_for 'text="qa-auto-session"'
9. dblclick 'text="qa-auto-session"'
10. fill '[data-testid="auth-password"]' '${cfg:ssh.password}'
11. click '[data-testid="auth-submit"]'
12. wait_for '[data-testid="terminal-pane"]'
13. screenshot 06-session-loaded.png
