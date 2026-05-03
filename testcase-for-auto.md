<!-- qa-ui-auto:auto-generated -->
# NewMob - UI E2E Test Cases

> This file is consumed by the `qa-ui-auto` skill via
> `.agents/skills/qa-ui-auto/scripts/run_tests.py`.
>
> Format reminder:
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
>   ${cfg:ssh.host}       resolved from qa-ui-auto.config.yaml
>   ${cfg:sftp.*}         resolved from qa-ui-auto.config.yaml
>   ${env:VAR}            resolved from environment
>
> Note: config values are not recursively expanded. Use `${env:QA_SSH_PASSWORD}`
> directly in password fields instead of `${cfg:ssh.password}` when the YAML
> stores the password as an environment reference.

## TC-001: Main interface shell renders
- tags: smoke, p0, main
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="menu-bar"]'
3. expect_visible '[data-testid="ribbon"]'
4. expect_visible '[data-testid="quick-connect"]'
5. expect_visible '[data-testid="sidebar"]'
6. expect_visible '[data-testid="tab-bar"]'
7. expect_visible '[data-testid="status-bar"]'
8. expect_visible '[data-testid="welcome-panel"]'
9. expect_visible 'text="Welcome to NewMob"'
10. expect_visible 'text="Start local terminal"'
11. expect_visible 'text="New session"'
12. screenshot 001-main-interface.png

## TC-002: Global settings and terminal appearance controls
- tags: smoke, p0, settings, appearance
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-settings"]'
3. wait_for '[data-testid="settings-panel"]'
4. expect_visible 'text="Application Theme"'
5. expect_visible '[data-testid="terminal-appearance-settings"]'
6. expect_visible '[data-testid="terminal-theme-gallery"]'
7. expect_visible '[data-testid="terminal-preview"]'
8. click 'button[aria-label="Cycle application theme"]'
9. screenshot 002-settings-appearance.png

## TC-003: SSH session settings editor covers completed tabs
- tags: session, ssh, settings, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. expect_visible '[data-testid="session-proto-ssh"]'
5. expect_visible '[data-testid="session-proto-sftp"]'
6. expect_visible '[data-testid="session-proto-rdp"]'
7. expect_visible '[data-testid="session-proto-vnc"]'
8. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
9. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
10. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
11. expect_visible '[data-testid="advanced-ssh-settings"]'
12. expect_visible 'text="SSH-browser type"'
13. expect_visible 'text="Auto-inject OSC 7 cwd reporting"'
14. click '[data-testid="session-section-terminal"]'
15. expect_visible '[data-testid="terminal-settings"]'
16. expect_visible '[data-testid="terminal-appearance-settings"]'
17. expect_visible '[data-testid="terminal-preview"]'
18. click '[data-testid="session-section-network"]'
19. expect_visible '[data-testid="network-settings"]'
20. expect_visible 'text="Keep-alive"'
21. click '[data-testid="session-section-bookmark"]'
22. wait_for '[data-testid="bookmark-settings"]'
23. fill '[data-testid="session-name"]' 'qa-ui-auto-ssh-settings'
24. click '[data-testid="session-save"]'
25. wait_for 'text="qa-ui-auto-ssh-settings"'
26. screenshot 003-ssh-session-settings.png

## TC-004: Local terminal opens and accepts input
- tags: terminal, local, p0
- mode: native

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. type 'echo qa-ui-auto-local'
5. press Enter
6. sleep 1
7. expect_text '[data-testid="terminal-pane"]' 'qa-ui-auto-local'
8. screenshot 004-local-terminal.png

## TC-005: Quick SSH connect opens terminal banner
- tags: ssh, terminal, banner, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. expect_text '[data-testid="terminal-pane"]' 'NewMob SSH terminal'
10. expect_text '[data-testid="terminal-pane"]' 'SSH-browser'
11. expect_text '[data-testid="terminal-pane"]' 'X11-forwarding'
12. type 'whoami'
13. press Enter
14. sleep 1
15. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
16. screenshot 005-ssh-terminal-banner.png

## TC-006: Terminal right-click menu exposes completed operations
- tags: terminal, right-menu, p0
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
10. wait_for '[data-testid="context-menu"]'
11. expect_visible 'text="Copy All"'
12. expect_visible 'text="Paste"'
13. expect_visible 'text="Find"'
14. expect_visible 'text="Font settings"'
15. expect_visible 'text="Terminal display"'
16. expect_visible 'text="Syntax highlighting"'
17. expect_visible 'text="Special Command"'
18. expect_visible 'text="Event Log"'
19. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
20. expect_visible 'text="Read-only terminal"'
21. expect_visible 'text="Fullscreen terminal"'
22. click '[data-testid="context-menu-item-event-log"]'
23. expect_visible 'text="Event Log"'
24. screenshot 006-terminal-right-menu.png

## TC-007: SSH terminal attached SFTP browser opens and navigates
- tags: ssh, sftp, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. expect_visible '[data-testid="sftp-remote-pane"]'
12. expect_visible '[data-testid="sftp-local-pane"]'
13. expect_visible '[data-testid="sftp-transfer-queue"]'
14. click '[data-testid="sftp-remote-path"]'
15. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
16. press Enter
17. sleep 1
18. expect_visible 'text="REMOTE"'
19. expect_visible 'text="LOCAL"'
20. screenshot 007-attached-sftp-browser.png

## TC-008: SFTP upload, download, preview, and delete flow
- tags: sftp, transfer, p0
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-upload.txt"; window.confirm = () => true; }); }'
16. click '[data-testid="sftp-local-new-file"]'
17. wait_for 'text="qa-ui-auto-upload.txt"'
18. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-upload.txt"`).first().click(); }'
19. click '[data-testid="sftp-local-upload-selected"]'
20. wait_for 'text="done"'
21. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-upload.txt"`).first().click(); }'
22. click '[data-testid="sftp-remote-download-selected"]'
23. wait_for 'text="done"'
24. click '[data-testid="sftp-remote-preview"]'
25. expect_visible 'text="qa-ui-auto-upload.txt"'
26. click 'role=button[name="Close"]'
27. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-upload.txt"`).first().click(); }'
28. click '[data-testid="sftp-remote-delete"]'
29. sleep 1
30. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-upload.txt"`).first().click(); }'
31. click '[data-testid="sftp-local-delete"]'
32. sleep 1
33. screenshot 008-sftp-transfer-cleanup.png

## TC-009: SFTP file and empty-area right-click menus
- tags: sftp, right-menu, p1
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="attached-sftp-toggle"]'
10. wait_for '[data-testid="sftp-browser"]'
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-menu.txt"; window.confirm = () => true; }); }'
16. eval 'async page => { await page.evaluate(() => { const list = document.querySelector(`[data-testid="sftp-remote-list"]`); list?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 220 })); }); }'
17. wait_for '[data-testid="context-menu"]'
18. expect_visible 'text="New folder"'
19. expect_visible 'text="New file"'
20. press Escape
21. click '[data-testid="sftp-remote-new-file"]'
22. wait_for 'text="qa-ui-auto-menu.txt"'
23. eval 'async page => { const row = page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first(); await row.click({ button: "right" }); }'
24. wait_for '[data-testid="context-menu"]'
25. expect_visible 'text="Download to local"'
26. expect_visible 'text="Rename"'
27. expect_visible 'text="Permissions"'
28. expect_visible 'text="Delete"'
29. screenshot 009-sftp-right-menu.png
30. press Escape
31. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first().click(); }'
32. click '[data-testid="sftp-remote-delete"]'
33. sleep 1

## TC-010: Tab bar right-click menu
- tags: main, right-menu, tabs, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="tab-bar"]'
3. eval 'async page => { await page.locator(`[data-testid="tab-item"]`).first().click({ button: "right" }); }'
4. wait_for '[data-testid="context-menu"]'
5. expect_visible 'text="Close"'
6. expect_visible 'text="Close others"'
7. expect_visible 'text="Close all"'
8. expect_visible 'text="Duplicate tab"'
9. screenshot 010-tab-right-menu.png

## TC-011: Session tree right-click menu after saving a session
- tags: session, right-menu, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-menu'
10. click '[data-testid="session-save"]'
11. wait_for 'text="qa-ui-auto-menu"'
12. eval 'async page => { await page.locator(`[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]`).click({ button: "right" }); }'
13. wait_for '[data-testid="context-menu"]'
14. expect_visible 'text="Connect"'
15. expect_visible 'text="Edit..."'
16. expect_visible 'text="Duplicate"'
17. expect_visible 'text="Move to folder"'
18. expect_visible 'text="Delete"'
19. screenshot 011-session-tree-right-menu.png
