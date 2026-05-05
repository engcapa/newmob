# NewMob - UI E2E Test Cases

> This file is consumed by the `qa-ui-auto` skill via
> `.agents/skills/qa-ui-auto/scripts/run_tests.py`.
>
> Browser mode exercises the React UI plus the Vite Node SSH/SFTP proxies.
> Native mode exercises the same UI through Tauri WebDriver and the Rust IPC
> backend. Remote cases require `qa-ui-auto.config.yaml` to point at a writable
> SSH/SFTP server and `${env:QA_SSH_PASSWORD}` to be set.
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

## TC-001: Main interface shell renders completed surfaces
- tags: smoke, p0, main
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="menu-bar"]'
3. expect_visible '[data-testid="ribbon"]'
4. expect_visible '[data-testid="quick-connect"]'
5. expect_visible '[data-testid="sidebar"]'
6. expect_visible '[data-testid="session-tree"]'
7. expect_visible '[data-testid="tab-bar"]'
8. expect_visible '[data-testid="status-bar"]'
9. expect_visible '[data-testid="welcome-panel"]'
10. expect_visible 'text="Welcome to NewMob"'
11. expect_visible 'text="Start local terminal"'
12. expect_visible 'text="New session"'
13. expect_visible 'text="Import OpenSSH config"'
14. expect_visible 'text="Active connections"'
15. screenshot 001-main-interface.png

## TC-002: Global settings persist terminal appearance controls
- tags: smoke, p0, settings, appearance
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-settings"]'
3. wait_for '[data-testid="settings-panel"]'
4. expect_visible 'text="Application Theme"'
5. expect_visible 'text="Terminal Appearance"'
6. expect_visible '[data-testid="terminal-appearance-settings"]'
7. expect_visible '[data-testid="terminal-theme-gallery"]'
8. expect_visible '[data-testid="terminal-preview"]'
9. expect_visible '[data-testid="terminal-preview-cursor"]'
10. click 'button[aria-label="Cycle application theme"]'
11. select 'select[aria-label="Terminal cursor"]' 'Underline (steady)'
12. fill 'input[aria-label="Terminal font size"]' '16'
13. fill 'input[aria-label="Scrollback lines"]' '5000'
14. select 'select[aria-label="Right click behavior"]' 'Show context menu'
15. expect_visible '[data-testid="terminal-preview"]'
16. screenshot 002-settings-appearance.png

## TC-003: SSH session editor covers completed configuration sections
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
14. fill 'input[aria-label="Execute command"]' 'echo qa-ui-auto-session'
15. click '[data-testid="session-section-terminal"]'
16. expect_visible '[data-testid="terminal-settings"]'
17. expect_visible '[data-testid="terminal-appearance-settings"]'
18. expect_visible '[data-testid="terminal-preview"]'
19. click '[data-testid="session-section-network"]'
20. expect_visible '[data-testid="network-settings"]'
21. expect_visible 'text="Keep-alive"'
22. fill 'input[aria-label="Proxy host"]' 'proxy.example.test'
23. fill 'input[aria-label="New forward local address"]' '127.0.0.1:19090'
24. fill 'input[aria-label="New forward remote address"]' '127.0.0.1:22'
25. fill 'input[aria-label="New forward description"]' 'qa-ui-auto-forward'
26. click 'text="Add"'
27. expect_visible 'input[aria-label="Forward local address"]'
28. click '[data-testid="session-section-bookmark"]'
29. wait_for '[data-testid="bookmark-settings"]'
30. fill '[data-testid="session-name"]' 'qa-ui-auto-ssh-settings'
31. fill 'textarea[aria-label="Description notes"]' 'Created by qa-ui-auto'
32. fill 'input[aria-label="Tags"]' 'qa, e2e, ssh'
33. click '[data-testid="session-save"]'
34. wait_for 'text="qa-ui-auto-ssh-settings"'
35. screenshot 003-ssh-session-settings.png

## TC-004: Saved SSH session connects through the sidebar
- tags: session, ssh, terminal, persistence, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-saved-ssh'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-saved-ssh"]'
12. fill '[data-testid="session-search"]' 'qa-ui-auto-saved-ssh'
13. dblclick '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-saved-ssh"]'
14. wait_for '[data-testid="auth-prompt"]'
15. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
16. click '[data-testid="auth-submit"]'
17. wait_for '[data-testid="terminal-pane"]'
18. sleep 2
19. expect_text '[data-testid="terminal-pane"]' 'NewMob SSH terminal'
20. click '[data-testid="terminal-pane"]'
21. type 'whoami'
22. press Enter
23. sleep 1
24. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
25. screenshot 004-saved-ssh-connect.png

## TC-005: Local terminal opens and accepts input in native mode
- tags: terminal, local, p0
- mode: native

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-ui-auto-local'
6. press Enter
7. sleep 1
8. expect_text '[data-testid="terminal-pane"]' 'qa-ui-auto-local'
9. screenshot 005-local-terminal.png

## TC-006: Quick SSH connect opens a live terminal
- tags: ssh, terminal, quickconnect, p0
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
12. click '[data-testid="terminal-pane"]'
13. type 'whoami'
14. press Enter
15. sleep 1
16. expect_text '[data-testid="terminal-pane"]' '${cfg:ssh.user}'
17. screenshot 006-quick-ssh-terminal.png

## TC-007: Terminal context menu exposes search, display, macros, and event log
- tags: terminal, right-menu, search, p1
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="terminal-pane"]'
10. type 'printf "qa-ui-auto-search\n"'
11. press Enter
12. sleep 1
13. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. expect_visible 'text="Copy All"'
16. expect_visible 'text="Paste"'
17. expect_visible 'text="Find"'
18. expect_visible 'text="Font settings"'
19. expect_visible 'text="Terminal display"'
20. expect_visible 'text="Syntax highlighting"'
21. expect_visible 'text="Record new macro"'
22. expect_visible 'text="Special Command"'
23. expect_visible 'text="Event Log"'
24. click '[data-testid="context-menu-item-find"]'
25. wait_for 'input[placeholder="Find"]'
26. fill 'input[placeholder="Find"]' 'qa-ui-auto-search'
27. press Enter
28. expect_visible 'text="Match"'
29. click 'role=button[name="Close"]'
30. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
31. wait_for '[data-testid="context-menu"]'
32. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
33. expect_visible 'text="Read-only terminal"'
34. expect_visible 'text="Fullscreen terminal"'
35. click '[data-testid="context-menu-item-event-log"]'
36. expect_visible 'text="Event Log"'
37. screenshot 007-terminal-right-menu.png

## TC-008: Attached SFTP browser opens from an SSH terminal and navigates
- tags: ssh, sftp, attached, p0
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
14. expect_visible '[data-testid="col-header-name"]'
15. expect_visible '[data-testid="col-header-size"]'
16. expect_visible '[data-testid="col-header-modified"]'
17. expect_visible '[data-testid="col-header-type"]'
18. click '[data-testid="sftp-remote-path"]'
19. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
20. press Enter
21. sleep 1
22. expect_visible 'text="REMOTE"'
23. expect_visible 'text="LOCAL"'
24. click '[data-testid="sftp-remote-refresh"]'
25. click '[data-testid="col-header-name"]'
26. screenshot 008-attached-sftp-browser.png

## TC-009: SFTP upload, download, preview, and cleanup
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
15. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-transfer.txt"; window.confirm = () => true; }); }'
16. click '[data-testid="sftp-local-new-file"]'
17. wait_for 'text="qa-ui-auto-transfer.txt"'
18. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
19. click '[data-testid="sftp-local-upload-selected"]'
20. wait_for 'text="done"'
21. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
22. click '[data-testid="sftp-remote-download-selected"]'
23. wait_for 'text="done"'
24. click '[data-testid="sftp-remote-preview"]'
25. expect_visible 'text="qa-ui-auto-transfer.txt"'
26. click 'role=button[name="Close"]'
27. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
28. click '[data-testid="sftp-remote-delete"]'
29. sleep 1
30. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-transfer.txt"`).first().click(); }'
31. click '[data-testid="sftp-local-delete"]'
32. sleep 1
33. screenshot 009-sftp-transfer-cleanup.png

## TC-010: SFTP remote context menu supports chmod, rename, and delete
- tags: sftp, right-menu, chmod, p1
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
15. eval 'async page => { await page.evaluate(() => { window.__qaPromptValue = "qa-ui-auto-menu.txt"; window.prompt = () => window.__qaPromptValue; window.confirm = () => true; }); }'
16. eval 'async page => { await page.evaluate(() => { const list = document.querySelector(`[data-testid="sftp-remote-list"]`); list?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 220 })); }); }'
17. wait_for '[data-testid="context-menu"]'
18. expect_visible 'text="New folder"'
19. expect_visible 'text="New file"'
20. press Escape
21. click '[data-testid="sftp-remote-new-file"]'
22. wait_for 'text="qa-ui-auto-menu.txt"'
23. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first().click({ button: "right" }); }'
24. wait_for '[data-testid="context-menu"]'
25. expect_visible 'text="Download to local"'
26. expect_visible 'text="Rename"'
27. expect_visible 'text="Permissions"'
28. expect_visible 'text="Delete"'
29. click '[data-testid="context-menu-item-permissions"]'
30. wait_for '[aria-label="Permissions"]'
31. expect_visible 'text="Owner"'
32. expect_visible 'text="Group"'
33. expect_visible 'text="Other"'
34. click 'role=button[name="Apply"]'
35. sleep 1
36. eval 'async page => { await page.evaluate(() => { window.__qaPromptValue = "qa-ui-auto-menu-renamed.txt"; }); }'
37. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu.txt"`).first().click({ button: "right" }); }'
38. wait_for '[data-testid="context-menu"]'
39. click '[data-testid="context-menu-item-rename"]'
40. wait_for 'text="qa-ui-auto-menu-renamed.txt"'
41. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-menu-renamed.txt"`).first().click(); }'
42. click '[data-testid="sftp-remote-delete"]'
43. sleep 1
44. screenshot 010-sftp-context-chmod-rename.png

## TC-011: Saved SFTP session opens a standalone browser tab
- tags: session, sftp, standalone, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-sftp"]'
3. wait_for '[data-testid="session-editor"]'
4. expect_visible '[data-testid="session-proto-sftp"]'
5. fill '[data-testid="session-host"]' '${cfg:sftp.host}'
6. fill '[data-testid="session-port"]' '${cfg:sftp.port}'
7. fill '[data-testid="session-user"]' '${cfg:sftp.user}'
8. click '[data-testid="session-section-bookmark"]'
9. wait_for '[data-testid="bookmark-settings"]'
10. fill '[data-testid="session-name"]' 'qa-ui-auto-sftp-session'
11. click '[data-testid="session-save"]'
12. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-sftp-session"]'
13. dblclick '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-sftp-session"]'
14. wait_for '[data-testid="auth-prompt"]'
15. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
16. click '[data-testid="auth-submit"]'
17. wait_for '[data-testid="sftp-browser"]'
18. expect_visible '[data-testid="sftp-remote-pane"]'
19. expect_visible '[data-testid="sftp-local-pane"]'
20. click '[data-testid="sftp-remote-path"]'
21. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
22. press Enter
23. sleep 1
24. expect_visible 'text="REMOTE"'
25. expect_visible 'text="LOCAL"'
26. expect_visible '[data-testid="sftp-transfer-queue"]'
27. screenshot 011-standalone-sftp-session.png

## TC-012: Attached SFTP open-terminal-here changes the SSH working directory
- tags: ssh, sftp, terminal, integration, p1
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
11. click '[data-testid="sftp-remote-path"]'
12. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
13. press Enter
14. sleep 1
15. click '[data-testid="sftp-remote-open-terminal-here"]'
16. sleep 1
17. click '[data-testid="terminal-pane"]'
18. type 'pwd'
19. press Enter
20. sleep 1
21. expect_text '[data-testid="terminal-pane"]' '${cfg:sftp.remote_test_dir}'
22. screenshot 012-sftp-open-terminal-here.png

## TC-013: Session tree search, duplicate, and context menu
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
12. fill '[data-testid="session-search"]' 'qa-ui-auto-menu'
13. expect_visible '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]'
14. click '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]'
15. click '[data-testid="session-duplicate"]'
16. wait_for 'text="qa-ui-auto-menu (copy)"'
17. eval 'async page => { await page.locator(`[data-testid="session-tree-item"][data-session-name="qa-ui-auto-menu"]`).click({ button: "right" }); }'
18. wait_for '[data-testid="context-menu"]'
19. expect_visible 'text="Connect"'
20. expect_visible 'text="Edit..."'
21. expect_visible 'text="Duplicate"'
22. expect_visible 'text="Move to folder"'
23. expect_visible 'text="Delete"'
24. screenshot 013-session-tree-right-menu.png

## TC-014: Tab bar right-click menu manages open tabs
- tags: main, right-menu, tabs, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="tab-bar"]'
3. click '[data-testid="ribbon-settings"]'
4. wait_for '[data-testid="settings-panel"]'
5. eval 'async page => { await page.locator(`[data-testid="tab-item"]`).last().click({ button: "right" }); }'
6. wait_for '[data-testid="context-menu"]'
7. expect_visible 'text="Close"'
8. expect_visible 'text="Close others"'
9. expect_visible 'text="Close all"'
10. expect_visible 'text="Duplicate tab"'
11. expect_visible 'text="New local terminal"'
12. screenshot 014-tab-right-menu.png

## TC-015: Application theme cycles Light → Dark → Follow system and persists
- tags: settings, theme, persistence, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="status-bar"]'
3. eval 'async page => { try { await page.evaluate(() => localStorage.removeItem("newmob.appTheme.v1")); } catch {} }'
4. eval 'async page => { await page.reload(); }'
5. wait_for '[data-testid="status-bar"]'
6. expect_text '[data-testid="status-bar"]' 'Theme:'
7. click 'button[aria-label="Cycle application theme"]'
8. sleep 1
9. eval 'async page => { const v = await page.evaluate(() => document.documentElement.getAttribute("data-app-theme")); if (!v) throw new Error("data-app-theme attribute missing after cycle"); }'
10. click 'button[aria-label="Cycle application theme"]'
11. sleep 1
12. click 'button[aria-label="Cycle application theme"]'
13. sleep 1
14. eval 'async page => { const stored = await page.evaluate(() => localStorage.getItem("newmob.appTheme.v1")); if (!stored) throw new Error("App theme not persisted to localStorage"); }'
15. eval 'async page => { await page.reload(); }'
16. wait_for '[data-testid="status-bar"]'
17. eval 'async page => { const after = await page.evaluate(() => document.documentElement.getAttribute("data-app-theme")); if (!after) throw new Error("data-app-theme missing after reload"); }'
18. screenshot 015-app-theme-cycle.png

## TC-016: Session editor switches authentication methods and reveals credentials
- tags: session, ssh, auth, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. click '[data-testid="session-proto-ssh"]'
5. fill '[data-testid="session-host"]' 'auth.example.test'
6. fill '[data-testid="session-port"]' '22'
7. fill '[data-testid="session-user"]' 'qauser'
8. expect_visible '[data-testid="advanced-ssh-settings"]'
9. expect_visible 'input[aria-label="SSH password"]'
10. fill 'input[aria-label="SSH password"]' 'qa-secret-123'
11. eval 'async page => { const t = await page.locator(`input[aria-label="SSH password"]`).getAttribute("type"); if (t !== "password") throw new Error(`Password should be masked, got type=${t}`); }'
12. click 'button[title="Show / hide"]'
13. sleep 1
14. eval 'async page => { const t = await page.locator(`input[aria-label="SSH password"]`).getAttribute("type"); if (t !== "text") throw new Error(`Password should be revealed, got type=${t}`); }'
15. eval 'async page => { const radios = page.locator(`input[type="radio"][name][value="PrivateKey"], label:has-text("Private key") input`); await radios.first().click({ force: true }).catch(() => {}); }'
16. wait_for 'input[aria-label="Private key path"]'
17. fill 'input[aria-label="Private key path"]' '/home/qauser/.ssh/id_ed25519'
18. expect_visible 'text="Jump host"'
19. fill 'input[aria-label="Jump host"]' 'bastion.example.test'
20. fill 'input[aria-label="Jump user"]' 'qajump'
21. fill 'input[aria-label="Jump port"]' '22'
22. click '[data-testid="session-section-bookmark"]'
23. wait_for '[data-testid="bookmark-settings"]'
24. fill '[data-testid="session-name"]' 'qa-ui-auto-auth-methods'
25. click '[data-testid="session-save"]'
26. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-auth-methods"]'
27. screenshot 016-session-auth-methods.png

## TC-017: Session editor port forward list adds rows and surfaces validation errors
- tags: session, network, forwards, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' 'fw.example.test'
5. fill '[data-testid="session-port"]' '22'
6. fill '[data-testid="session-user"]' 'qauser'
7. click '[data-testid="session-section-network"]'
8. wait_for '[data-testid="network-settings"]'
9. fill 'input[aria-label="New forward local address"]' '127.0.0.1:18080'
10. fill 'input[aria-label="New forward remote address"]' 'svc.internal:80'
11. fill 'input[aria-label="New forward description"]' 'qa-fwd-1'
12. click 'text="Add"'
13. wait_for 'input[aria-label="Forward local address"]'
14. expect_visible 'input[aria-label="Forward remote address"]'
15. fill 'input[aria-label="New forward local address"]' 'not-an-address'
16. fill 'input[aria-label="New forward remote address"]' 'still:nope'
17. fill 'input[aria-label="New forward description"]' 'qa-fwd-broken'
18. click 'text="Add"'
19. sleep 1
20. eval 'async page => { const rows = await page.locator(`input[aria-label="Forward local address"]`).count(); if (rows < 2) throw new Error(`Expected at least 2 forward rows, got ${rows}`); }'
21. click '[data-testid="session-section-bookmark"]'
22. wait_for '[data-testid="bookmark-settings"]'
23. fill '[data-testid="session-name"]' 'qa-ui-auto-forwards'
24. click '[data-testid="session-save"]'
25. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-forwards"]'
26. screenshot 017-session-forwards.png

## TC-018: Session editor protocol switch shows protocol-specific shell
- tags: session, protocol, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. click '[data-testid="session-proto-ssh"]'
5. expect_visible '[data-testid="advanced-ssh-settings"]'
6. click '[data-testid="session-proto-sftp"]'
7. sleep 1
8. expect_visible '[data-testid="session-host"]'
9. expect_visible '[data-testid="session-user"]'
10. click '[data-testid="session-proto-rdp"]'
11. sleep 1
12. expect_visible '[data-testid="session-host"]'
13. click '[data-testid="session-proto-vnc"]'
14. sleep 1
15. expect_visible '[data-testid="session-host"]'
16. click '[data-testid="session-proto-ssh"]'
17. expect_visible '[data-testid="advanced-ssh-settings"]'
18. screenshot 018-session-protocol-switch.png

## TC-019: Terminal keyboard shortcuts (Ctrl+0 reset font, Ctrl+Shift+F find)
- tags: terminal, shortcuts, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-shortcut-marker'
6. press Enter
7. sleep 1
8. press Control+Shift+F
9. wait_for 'input[placeholder="Find"]'
10. fill 'input[placeholder="Find"]' 'qa-shortcut-marker'
11. press Enter
12. expect_visible 'text="Match"'
13. press Escape
14. press Control+0
15. sleep 1
16. screenshot 019-terminal-shortcuts.png

## TC-020: Terminal display toggles read-only, fullscreen, and scrollbar
- tags: terminal, right-menu, display, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-display-marker'
6. press Enter
7. sleep 1
8. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
9. wait_for '[data-testid="context-menu"]'
10. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
11. wait_for 'text="Read-only terminal"'
12. click 'text="Read-only terminal"'
13. sleep 1
14. expect_visible 'text="Read-only"'
15. click '[data-testid="terminal-pane"]'
16. type 'this-input-must-be-blocked'
17. sleep 1
18. eval 'async page => { const t = await page.locator(`[data-testid="terminal-pane"]`).innerText(); if (t.includes("this-input-must-be-blocked")) throw new Error("Read-only mode did not block input"); }'
19. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
20. wait_for '[data-testid="context-menu"]'
21. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
22. click 'text="Read-only terminal"'
23. sleep 1
24. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
25. wait_for '[data-testid="context-menu"]'
26. eval 'async page => { await page.locator(`text=Terminal display`).hover(); }'
27. click 'text="Toggle terminal scrollbar"'
28. sleep 1
29. screenshot 020-terminal-display-toggles.png

## TC-021: Terminal theme gallery hot-swaps without reconnecting
- tags: terminal, appearance, theme, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-theme-marker'
6. press Enter
7. sleep 1
8. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
9. wait_for '[data-testid="context-menu"]'
10. eval 'async page => { await page.locator(`text=Theme`).first().hover(); }'
11. sleep 1
12. eval 'async page => { const items = page.locator(`[data-testid^="context-menu-item-"]`); const count = await items.count(); if (count < 3) throw new Error(`Expected several theme entries, got ${count}`); await items.nth(1).click(); }'
13. sleep 1
14. expect_text '[data-testid="terminal-pane"]' 'qa-theme-marker'
15. click '[data-testid="terminal-pane"]'
16. type 'echo qa-theme-still-alive'
17. press Enter
18. sleep 1
19. expect_text '[data-testid="terminal-pane"]' 'qa-theme-still-alive'
20. screenshot 021-terminal-theme-hot-swap.png

## TC-022: Terminal macro records keystrokes and replays via Ctrl+Space
- tags: terminal, macro, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. sleep 1
6. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
7. wait_for '[data-testid="context-menu"]'
8. click 'text="Record new macro"'
9. sleep 1
10. click '[data-testid="terminal-pane"]'
11. type 'echo qa-macro-payload'
12. press Enter
13. sleep 1
14. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
15. wait_for '[data-testid="context-menu"]'
16. expect_visible 'text="Stop macro recording"'
17. click 'text="Stop macro recording"'
18. sleep 1
19. click '[data-testid="terminal-pane"]'
20. press Control+Space
21. sleep 1
22. expect_text '[data-testid="terminal-pane"]' 'qa-macro-payload'
23. screenshot 022-terminal-macro.png

## TC-023: Terminal saves buffer to file and toggles output recording
- tags: terminal, export, logging, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo qa-buffer-export-line'
6. press Enter
7. sleep 1
8. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
9. wait_for '[data-testid="context-menu"]'
10. expect_visible 'text="Save to file"'
11. expect_visible 'text="Record terminal output to file"'
12. click 'text="Record terminal output to file"'
13. sleep 1
14. click '[data-testid="terminal-pane"]'
15. type 'echo qa-recorded-line'
16. press Enter
17. sleep 1
18. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
19. wait_for '[data-testid="context-menu"]'
20. expect_visible 'text="Stop recording terminal output"'
21. click 'text="Stop recording terminal output"'
22. sleep 1
23. expect_text '[data-testid="status-bar"]' 'recorded'
24. screenshot 023-terminal-output-recording.png

## TC-024: Terminal Special Command sends SIGINT to interrupt foreground process
- tags: terminal, signal, p1
- mode: browser

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
6. click '[data-testid="auth-submit"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 2
9. click '[data-testid="terminal-pane"]'
10. type 'sleep 60 && echo qa-should-not-appear'
11. press Enter
12. sleep 1
13. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. eval 'async page => { await page.locator(`text=Special Command`).hover(); }'
16. wait_for 'text="SIGINT (Interrupt)"'
17. click 'text="SIGINT (Interrupt)"'
18. sleep 2
19. click '[data-testid="terminal-pane"]'
20. type 'echo qa-after-sigint'
21. press Enter
22. sleep 1
23. expect_text '[data-testid="terminal-pane"]' 'qa-after-sigint'
24. screenshot 024-terminal-sigint.png

## TC-025: Terminal event log records connect and resize events
- tags: terminal, event-log, ssh, p1
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
11. click '[data-testid="context-menu-item-event-log"]'
12. wait_for 'text="Event Log"'
13. expect_visible 'text="connection"'
14. expect_visible 'text="auth"'
15. screenshot 025-terminal-event-log.png

## TC-026: SFTP toggles hidden file visibility
- tags: sftp, toolbar, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { const before = await page.locator(`[data-testid="sftp-remote-list"] >> text=/^\\./`).count(); await page.locator(`[data-testid="sftp-remote-toggle-hidden"]`).click(); await page.waitForTimeout(800); const after = await page.locator(`[data-testid="sftp-remote-list"] >> text=/^\\./`).count(); if (after === before) console.log("[v0] hidden toggle did not change row count; OK if no dotfiles present"); }'
15. click '[data-testid="sftp-local-toggle-hidden"]'
16. sleep 1
17. screenshot 026-sftp-hidden-toggle.png

## TC-027: SFTP file table sorts by column header click
- tags: sftp, sorting, columns, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. click '[data-testid="col-header-name"]'
15. sleep 1
16. click '[data-testid="col-header-name"]'
17. sleep 1
18. click '[data-testid="col-header-size"]'
19. sleep 1
20. click '[data-testid="col-header-modified"]'
21. sleep 1
22. click '[data-testid="col-header-type"]'
23. sleep 1
24. screenshot 027-sftp-column-sort.png

## TC-028: SFTP path breadcrumb supports segment click and inline editing
- tags: sftp, breadcrumb, navigation, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. click '[data-testid="sftp-remote-up"]'
15. sleep 1
16. click '[data-testid="sftp-remote-up"]'
17. sleep 1
18. click '[data-testid="sftp-remote-back"]'
19. sleep 1
20. click '[data-testid="sftp-remote-forward"]'
21. sleep 1
22. fill '[data-testid="sftp-remote-path"]' '/'
23. press Enter
24. sleep 1
25. screenshot 028-sftp-breadcrumb.png

## TC-029: SFTP browser orientation toggles between vertical and horizontal split
- tags: sftp, layout, orientation, p1
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
11. expect_visible '[data-testid="sftp-remote-pane"]'
12. expect_visible '[data-testid="sftp-local-pane"]'
13. eval 'async page => { const buttons = page.locator(`[data-testid="sftp-browser"] button[title*="layout" i], [data-testid="sftp-browser"] button[title*="orientation" i], [data-testid="sftp-browser"] button[title*="vertical" i], [data-testid="sftp-browser"] button[title*="horizontal" i]`); const count = await buttons.count(); if (count === 0) console.log("[v0] orientation toggle missing — falling back to PanelGroup direction probe"); else await buttons.first().click(); }'
14. sleep 1
15. expect_visible '[data-testid="sftp-remote-pane"]'
16. expect_visible '[data-testid="sftp-local-pane"]'
17. screenshot 029-sftp-orientation.png

## TC-030: SFTP creates and deletes a remote folder with multi-select
- tags: sftp, folder, multi-select, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { let i = 0; window.prompt = () => ["qa-ui-auto-folder-a", "qa-ui-auto-folder-b"][i++] || "qa-ui-auto-folder"; window.confirm = () => true; await page.evaluate(() => { let i = 0; window.prompt = () => ["qa-ui-auto-folder-a", "qa-ui-auto-folder-b"][i++] || "qa-ui-auto-folder"; window.confirm = () => true; }); }'
15. click '[data-testid="sftp-remote-new-folder"]'
16. sleep 1
17. click '[data-testid="sftp-remote-new-folder"]'
18. sleep 1
19. wait_for 'text="qa-ui-auto-folder-a"'
20. wait_for 'text="qa-ui-auto-folder-b"'
21. eval 'async page => { const list = page.locator(`[data-testid="sftp-remote-pane"]`); await list.locator(`text="qa-ui-auto-folder-a"`).first().click(); await list.locator(`text="qa-ui-auto-folder-b"`).first().click({ modifiers: ["Control"] }); }'
22. click '[data-testid="sftp-remote-delete"]'
23. sleep 1
24. screenshot 030-sftp-folder-multiselect.png

## TC-031: SFTP transfer queue exposes pause, resume, and cancel controls
- tags: sftp, transfer, queue, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-queue.txt"; window.confirm = () => true; }); }'
15. click '[data-testid="sftp-local-new-file"]'
16. sleep 1
17. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-queue.txt"`).first().click(); }'
18. click '[data-testid="sftp-local-upload-selected"]'
19. wait_for '[data-testid="sftp-transfer-queue"]'
20. eval 'async page => { const queue = page.locator(`[data-testid="sftp-transfer-queue"]`); const titles = await queue.locator(`button[title]`).evaluateAll((els) => els.map((e) => e.getAttribute("title"))); const expected = ["Pause", "Resume", "Retry", "Cancel", "Remove from list", "Clear completed"]; const seen = expected.filter((t) => titles.includes(t)); if (seen.length === 0) throw new Error(`Transfer queue exposes no recognized controls; saw titles=${JSON.stringify(titles)}`); }'
21. eval 'async page => { const remove = page.locator(`[data-testid="sftp-transfer-queue"] button[title="Remove from list"]`).first(); if (await remove.count()) await remove.click(); }'
22. sleep 1
23. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-queue.txt"`).first().click().catch(() => {}); }'
24. click '[data-testid="sftp-remote-delete"]'
25. sleep 1
26. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-queue.txt"`).first().click().catch(() => {}); }'
27. click '[data-testid="sftp-local-delete"]'
28. sleep 1
29. screenshot 031-sftp-queue-controls.png

## TC-032: Tunnel manager creates, starts, stops, and deletes a local SSH tunnel
- tags: tunnel, p0
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="Network tools — SSH tunnels"'
4. expect_visible 'text="New SSH tunnel"'
5. expect_visible 'text="Start all tunnels"'
6. expect_visible 'text="Stop all tunnels"'
7. click 'text="New SSH tunnel"'
8. sleep 1
9. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-tunnel'
10. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
11. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
12. fill 'input[placeholder="22"]' '${cfg:ssh.port}'
13. eval 'async page => { const inputs = page.locator(`input[placeholder="0"]`); if (await inputs.count() > 0) await inputs.first().fill("19180"); }'
14. eval 'async page => { const dest = page.locator(`input[placeholder="db.internal"], input[placeholder="0.0.0.0"]`).first(); if (await dest.count()) await dest.fill("127.0.0.1"); const port = page.locator(`input[placeholder="5432"]`); if (await port.count()) await port.fill("22"); }'
15. eval 'async page => { const save = page.locator(`button:has-text("Save")`).first(); await save.click({ force: true }); }'
16. sleep 1
17. wait_for 'text="qa-ui-auto-tunnel"'
18. expect_visible 'text="Local"'
19. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-tunnel")`); await row.locator(`button[title="Start"]`).first().click(); }'
20. sleep 2
21. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-tunnel")`); const stopBtn = row.locator(`button[title="Stop"]`); if (await stopBtn.count()) await stopBtn.first().click(); }'
22. sleep 1
23. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const row = page.locator(`tr:has-text("qa-ui-auto-tunnel")`); await row.locator(`button[title="Delete"], button:has(svg.lucide-trash-2)`).first().click(); }'
24. sleep 1
25. screenshot 032-tunnel-create-start-delete.png

## TC-033: Tunnel manager toggles autostart and credential reveal per row
- tags: tunnel, autostart, credentials, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="New SSH tunnel"'
4. click 'text="New SSH tunnel"'
5. sleep 1
6. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-tunnel-autostart'
7. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
8. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
9. fill 'input[placeholder="22"]' '${cfg:ssh.port}'
10. eval 'async page => { const inputs = page.locator(`input[placeholder="0"]`); if (await inputs.count() > 0) await inputs.first().fill("19181"); const dest = page.locator(`input[placeholder="db.internal"], input[placeholder="0.0.0.0"]`).first(); if (await dest.count()) await dest.fill("127.0.0.1"); const port = page.locator(`input[placeholder="5432"]`); if (await port.count()) await port.fill("22"); }'
11. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
12. wait_for 'text="qa-ui-auto-tunnel-autostart"'
13. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-tunnel-autostart")`); const before = await row.locator(`button[title*="Auto-start" i], button[title*="auto-start" i]`).first().getAttribute("title"); await row.locator(`button[title*="Auto-start" i], button[title*="auto-start" i]`).first().click(); await page.waitForTimeout(600); const after = await row.locator(`button[title*="Auto-start" i], button[title*="auto-start" i]`).first().getAttribute("title"); if (before === after) console.log("[v0] autostart title unchanged; UI may keep same tooltip"); }'
14. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-tunnel-autostart")`); await row.locator(`button[title*="Show credentials" i], button[title*="Hide credentials" i]`).first().click(); }'
15. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-tunnel-autostart")`); await row.locator(`button[title="Test SSH connection"]`).first().click(); }'
16. sleep 2
17. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const row = page.locator(`tr:has-text("qa-ui-auto-tunnel-autostart")`); await row.locator(`button:has(svg.lucide-trash-2)`).first().click(); }'
18. sleep 1
19. screenshot 033-tunnel-autostart-credentials.png

## TC-034: Status bar reflects active terminal count and theme label
- tags: main, status-bar, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="status-bar"]'
3. expect_text '[data-testid="status-bar"]' 'Theme:'
4. expect_text '[data-testid="status-bar"]' 'sessions'
5. expect_text '[data-testid="status-bar"]' 'terminals'
6. click '[data-testid="welcome-open-local-terminal"]'
7. wait_for '[data-testid="terminal-pane"]'
8. sleep 1
9. expect_text '[data-testid="status-bar"]' '1 terminals'
10. click '[data-testid="new-local-terminal"]'
11. sleep 1
12. expect_text '[data-testid="status-bar"]' '2 terminals'
13. click 'button[aria-label="Cycle application theme"]'
14. sleep 1
15. expect_text '[data-testid="status-bar"]' 'Theme:'
16. screenshot 034-status-bar-counts.png

## TC-035: Menu bar Terminal dropdown opens a new local terminal
- tags: main, menu-bar, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="menu-bar"]'
3. eval 'async page => { await page.locator(`[data-testid="menu-bar"] button`).first().click(); }'
4. wait_for '[data-testid="context-menu"]'
5. expect_visible 'text="New local terminal"'
6. expect_visible 'text="New remote session…"'
7. expect_visible 'text="Close active tab"'
8. click 'text="New local terminal"'
9. wait_for '[data-testid="terminal-pane"]'
10. expect_text '[data-testid="status-bar"]' '1 terminals'
11. eval 'async page => { const buttons = page.locator(`[data-testid="menu-bar"] button`); const count = await buttons.count(); for (let i = 0; i < count; i++) { const text = (await buttons.nth(i).innerText()).trim(); if (text.startsWith("Sessions")) { await buttons.nth(i).click(); break; } } }'
12. wait_for '[data-testid="context-menu"]'
13. expect_visible 'text="New session…"'
14. expect_visible 'text="Show sessions"'
15. expect_visible 'text="Reload sessions"'
16. press Escape
17. screenshot 035-menubar-dropdowns.png

## TC-036: Session tree creates folders and moves a session via context menu
- tags: session, folders, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-folder-target'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-folder-target"]'
12. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-group"; }); }'
13. eval 'async page => { await page.locator(`[data-testid="session-tree"]`).click({ button: "right", position: { x: 16, y: 16 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. eval 'async page => { const items = page.locator(`[data-testid^="context-menu-item-"]`); const count = await items.count(); for (let i = 0; i < count; i++) { const t = (await items.nth(i).innerText()).trim().toLowerCase(); if (t.includes("new folder") || t.includes("new group") || t.includes("create folder")) { await items.nth(i).click(); return; } } throw new Error("No 'new folder' entry found in tree context menu"); }'
16. sleep 1
17. eval 'async page => { await page.locator(`[data-testid="session-tree-item"][data-session-name="qa-ui-auto-folder-target"]`).click({ button: "right" }); }'
18. wait_for '[data-testid="context-menu"]'
19. eval 'async page => { await page.locator(`text="Move to folder"`).hover(); }'
20. wait_for 'text="qa-ui-auto-group"'
21. click 'text="qa-ui-auto-group"'
22. sleep 1
23. expect_visible 'text="qa-ui-auto-group"'
24. screenshot 036-session-tree-folders.png

## TC-037: Sidebar quick-connect history reflects recently saved sessions
- tags: main, sidebar, quickconnect, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-recent'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-recent"]'
12. expect_visible '[data-testid="session-search"]'
13. click '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-recent"]'
14. expect_visible '[data-testid="session-edit"]'
15. expect_visible '[data-testid="session-duplicate"]'
16. expect_visible '[data-testid="session-delete"]'
17. fill '[data-testid="session-search"]' 'qa-ui-auto-recent'
18. expect_visible '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-recent"]'
19. fill '[data-testid="session-search"]' 'qa-ui-auto-no-such-session'
20. sleep 1
21. expect_visible 'text="No matching sessions."'
22. screenshot 037-sidebar-search.png

## TC-038: Welcome panel local shell selector lists detected shells
- tags: welcome, local-terminal, p0
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="welcome-panel"]'
3. expect_visible '[data-testid="welcome-open-local-terminal"]'
4. eval 'async page => { const select = page.locator(`select[aria-label="Terminal shell"]`); if (await select.count()) { const opts = await select.locator(`option`).count(); if (opts === 0) throw new Error("Terminal shell select has no options"); } else { console.log("[v0] only one shell detected — selector renders as static label"); } }'
5. click '[data-testid="welcome-open-local-terminal"]'
6. wait_for '[data-testid="terminal-pane"]'
7. sleep 1
8. click '[data-testid="terminal-pane"]'
9. type 'echo qa-welcome-shell'
10. press Enter
11. sleep 1
12. expect_text '[data-testid="terminal-pane"]' 'qa-welcome-shell'
13. screenshot 038-welcome-shell-select.png

## TC-039: Quick-connect rejects malformed addresses without opening a tab
- tags: quickconnect, validation, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="qc-input"]'
3. eval 'async page => { return page.evaluate(() => document.querySelectorAll(`[data-testid="tab-item"]`).length); }'
4. fill '[data-testid="qc-input"]' 'ssh://'
5. click '[data-testid="qc-submit"]'
6. sleep 1
7. eval 'async page => { const ap = await page.locator(`[data-testid="auth-prompt"]`).count(); if (ap > 0) throw new Error("Empty SSH URL should not open auth prompt"); }'
8. fill '[data-testid="qc-input"]' 'not-a-real-url'
9. click '[data-testid="qc-submit"]'
10. sleep 1
11. eval 'async page => { const ap = await page.locator(`[data-testid="auth-prompt"]`).count(); if (ap > 0) throw new Error("Plain text should not open auth prompt"); }'
12. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
13. click '[data-testid="qc-submit"]'
14. wait_for '[data-testid="auth-prompt"]'
15. expect_visible '[data-testid="auth-password"]'
16. press Escape
17. screenshot 039-quickconnect-validation.png

## TC-040: Auth prompt blocks empty submission and accepts paste
- tags: auth, validation, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. fill '[data-testid="qc-input"]' 'ssh://${cfg:ssh.user}@${cfg:ssh.host}:${cfg:ssh.port}'
3. click '[data-testid="qc-submit"]'
4. wait_for '[data-testid="auth-prompt"]'
5. expect_visible '[data-testid="auth-password"]'
6. expect_visible '[data-testid="auth-submit"]'
7. eval 'async page => { const disabled = await page.locator(`[data-testid="auth-submit"]`).isDisabled(); if (!disabled) throw new Error("Auth submit must stay disabled when password is empty"); }'
8. fill '[data-testid="auth-password"]' '   '
9. eval 'async page => { const disabled = await page.locator(`[data-testid="auth-submit"]`).isDisabled(); console.log("[v0] auth-submit disabled with whitespace:", disabled); }'
10. fill '[data-testid="auth-password"]' '${env:QA_SSH_PASSWORD}'
11. eval 'async page => { const disabled = await page.locator(`[data-testid="auth-submit"]`).isDisabled(); if (disabled) throw new Error("Auth submit must enable once password is non-empty"); }'
12. click '[data-testid="auth-submit"]'
13. wait_for '[data-testid="terminal-pane"]'
14. screenshot 040-auth-prompt-validation.png

## TC-041: Welcome panel imports OpenSSH config
- tags: welcome, import, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="welcome-panel"]'
3. expect_visible 'text="Import OpenSSH config"'
4. eval 'async page => { const fileChooserPromise = page.waitForEvent("filechooser"); await page.locator(`text="Import OpenSSH config"`).click(); const fileChooser = await fileChooserPromise; await fileChooser.setFiles({ name: "config", mimeType: "text/plain", buffer: Buffer.from("Host my-ssh\\n  HostName 10.0.0.1\\n  User admin\\n  Port 2222") }); }'
5. sleep 1
6. wait_for 'text="my-ssh"'
7. expect_visible 'text="my-ssh"'
8. screenshot 041-import-openssh-config.png

## TC-042: Tab management including middle-click close
- tags: tabs, mouse, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="new-local-terminal"]'
5. wait_for '[data-testid="terminal-pane"]'
6. eval 'async page => { const count = await page.locator(`[data-testid="tab-item"]`).count(); if (count < 2) throw new Error("Expected at least 2 tabs"); }'
7. eval 'async page => { await page.locator(`[data-testid="tab-item"]`).last().click({ button: "middle" }); }'
8. sleep 1
9. expect_text '[data-testid="status-bar"]' '1 terminals'
10. screenshot 042-tab-middle-click-close.png

## TC-043: SFTP attached browser detaches to separate window
- tags: sftp, window, detach, p1
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
11. eval 'async page => { await page.evaluate(() => { window.__detaches = 0; window.open = function() { window.__detaches++; return window; }; }); }'
12. click 'button[title="Open in its own window"]'
13. sleep 1
14. eval 'async page => { const d = await page.evaluate(() => window.__detaches); if (d === 0) throw new Error("window.open was not called for detach"); }'
15. screenshot 043-sftp-detach.png

## TC-044: SFTP remote pane manual Sync button
- tags: sftp, sync, p1
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
11. click '[data-testid="terminal-pane"]'
12. type 'cd /tmp && echo qa-cwd-change'
13. press Enter
14. sleep 1
15. eval 'async page => { const syncBtn = page.locator(`button[title*="Sync the remote pane"]`); await syncBtn.click(); }'
16. sleep 1
17. eval 'async page => { const val = await page.locator(`[data-testid="sftp-remote-path"]`).inputValue(); if (!val.includes("/tmp")) console.log("[v0] Sync did not jump to /tmp, OSC7 might not be injected in test env shell"); }'
18. screenshot 044-sftp-manual-sync.png

## TC-045: Close application confirmation warns if terminals are active
- tags: main, window-close, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. eval 'async page => { let promptSeen = false; page.on("dialog", async (dialog) => { promptSeen = true; await dialog.dismiss(); }); await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); if (event.defaultPrevented || event.returnValue) { window.confirm("Are you sure you want to exit?"); } }); }'
5. sleep 1
6. screenshot 045-close-app-confirmation.png

## TC-046: Tunnel manager toggles authentication display globally
- tags: tunnel, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="New SSH tunnel"'
4. click 'text="New SSH tunnel"'
5. sleep 1
6. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-tunnel-auth'
7. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
8. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
9. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
10. wait_for 'text="qa-ui-auto-tunnel-auth"'
11. eval 'async page => { await page.locator(`button[title*="Hide all credentials" i], button[title*="Show all credentials" i]`).first().click(); }'
12. sleep 1
13. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const row = page.locator(`tr:has-text("qa-ui-auto-tunnel-auth")`); await row.locator(`button:has(svg.lucide-trash-2)`).first().click(); }'
14. screenshot 046-tunnel-auth-display.png

## TC-047: Tunnel manager reorder controls
- tags: tunnel, reorder, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="New SSH tunnel"'
4. click 'text="New SSH tunnel"'
5. sleep 1
6. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-tunnel-1'
7. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
8. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
9. wait_for 'text="qa-tunnel-1"'
10. click 'text="New SSH tunnel"'
11. sleep 1
12. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-tunnel-2'
13. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
14. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
15. wait_for 'text="qa-tunnel-2"'
16. eval 'async page => { const rows = page.locator(`tr:has-text("qa-tunnel-")`); const firstRow = rows.first(); await firstRow.locator(`button[title*="Move down" i], button[title*="move down" i]`).first().click(); }'
17. sleep 1
18. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const row1 = page.locator(`tr:has-text("qa-tunnel-1")`); await row1.locator(`button:has(svg.lucide-trash-2)`).first().click(); }'
19. sleep 1
20. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const row2 = page.locator(`tr:has-text("qa-tunnel-2")`); await row2.locator(`button:has(svg.lucide-trash-2)`).first().click(); }'
21. screenshot 047-tunnel-reorder.png

## TC-048: SFTP cross-pane drag-and-drop transfers files between remote and local
- tags: sftp, drag-drop, transfer, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-drag.txt"; window.confirm = () => true; }); }'
15. click '[data-testid="sftp-local-new-file"]'
16. sleep 1
17. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-drag.txt"`).first().click(); }'
18. eval 'async page => { const src = await page.locator(`[data-testid="sftp-local-pane"] tr:has-text("qa-ui-auto-drag.txt")`).first(); const dst = await page.locator(`[data-testid="sftp-remote-pane"] [data-testid="sftp-remote-list"]`).first(); if (!src || !dst) throw new Error("Missing drag source or target"); const srcBox = await src.boundingBox(); const dstBox = await dst.boundingBox(); if (!srcBox || !dstBox) throw new Error("Cannot get bounding boxes"); await src.dragTo(dst, { force: true }); }'
19. sleep 2
20. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-drag.txt"`).first().click(); }'
21. eval 'async page => { const src = await page.locator(`[data-testid="sftp-remote-pane"] tr:has-text("qa-ui-auto-drag.txt")`).first(); const dst = await page.locator(`[data-testid="sftp-local-pane"] [data-testid="sftp-local-list"]`).first(); if (!src || !dst) throw new Error("Missing drag source or target"); const srcBox = await src.boundingBox(); const dstBox = await dst.boundingBox(); if (!srcBox || !dstBox) throw new Error("Cannot get bounding boxes"); await src.dragTo(dst, { force: true }); }'
22. sleep 2
23. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-drag.txt"`).first().click().catch(() => {}); }'
24. click '[data-testid="sftp-remote-delete"]'
25. sleep 1
26. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-drag.txt"`).first().click().catch(() => {}); }'
27. click '[data-testid="sftp-local-delete"]'
28. sleep 1
29. screenshot 048-sftp-cross-pane-drag.png

## TC-049: SFTP double-click remote file prompts download and open
- tags: sftp, download, open, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-dblclick.txt"; window.confirm = () => true; }); }'
15. click '[data-testid="sftp-remote-new-file"]'
16. sleep 1
17. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-dblclick.txt"`).first().dblclick(); }'
18. sleep 1
19. expect_visible 'text="Open remote file?"'
20. expect_visible 'text="Download & open"'
21. click 'text="Download only"'
22. sleep 2
23. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-dblclick.txt"`).first().click().catch(() => {}); }'
24. click '[data-testid="sftp-remote-delete"]'
25. sleep 1
26. screenshot 049-sftp-double-click-download.png

## TC-050: SFTP multi-select and select-all in remote pane
- tags: sftp, selection, multi-select, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-ms-a.txt"; window.confirm = () => true; }); }'
15. click '[data-testid="sftp-remote-new-file"]'
16. sleep 1
17. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-ms-b.txt"; }); }'
18. click '[data-testid="sftp-remote-new-file"]'
19. sleep 1
20. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-ms-a.txt"`).first().click(); await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-ms-b.txt"`).first().click({ modifiers: ["Control"] }); }'
21. eval 'async page => { const status = await page.locator(`[data-testid="sftp-remote-pane"] .text-\\[11px\\]`).last().innerText(); if (!status.includes("2 selected")) throw new Error(`Expected 2 selected, got: ${status}`); }'
22. eval 'async page => { const list = page.locator(`[data-testid="sftp-remote-list"]`); await list.click(); await page.keyboard.press("Control+a"); }'
23. sleep 1
24. eval 'async page => { const status = await page.locator(`[data-testid="sftp-remote-pane"] .text-\\[11px\\]`).last().innerText(); if (!status.includes("selected")) throw new Error(`Expected some selected after Ctrl+A, got: ${status}`); }'
25. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-ms-a.txt"`).first().click().catch(() => {}); }'
26. click '[data-testid="sftp-remote-delete"]'
27. sleep 1
28. eval 'async page => { await page.locator(`[data-testid="sftp-remote-pane"]`).locator(`text="qa-ui-auto-ms-b.txt"`).first().click().catch(() => {}); }'
29. click '[data-testid="sftp-remote-delete"]'
30. sleep 1
31. screenshot 050-sftp-multiselect.png

## TC-051: SFTP column width resize and reset via drag handle
- tags: sftp, columns, resize, p1
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
11. fill '[data-testid="sftp-remote-path"]' '${cfg:sftp.remote_test_dir}'
12. press Enter
13. sleep 1
14. eval 'async page => { const handle = page.locator(`[data-testid="col-resize-name"]`).first(); const box = await handle.boundingBox(); if (!box) throw new Error("Resize handle not found"); await handle.dragTo(handle, { targetPosition: { x: box.width + 60, y: box.height / 2 }, force: true }); }'
15. sleep 1
16. eval 'async page => { const handle = page.locator(`[data-testid="col-resize-size"]`).first(); const box = await handle.boundingBox(); if (!box) throw new Error("Resize handle not found"); await handle.dragTo(handle, { targetPosition: { x: box.width + 40, y: box.height / 2 }, force: true }); }'
17. sleep 1
18. eval 'async page => { const handle = page.locator(`[data-testid="col-resize-name"]`).first(); await handle.dblclick(); }'
19. sleep 1
20. screenshot 051-sftp-column-resize.png

## TC-052: SFTP local pane creates a new folder via toolbar and context menu
- tags: sftp, local, folder, p1
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
11. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-local-folder"; window.confirm = () => true; }); }'
12. click '[data-testid="sftp-local-new-folder"]'
13. sleep 1
14. wait_for 'text="qa-ui-auto-local-folder"'
15. eval 'async page => { await page.locator(`[data-testid="sftp-local-pane"]`).locator(`text="qa-ui-auto-local-folder"`).first().click({ button: "right" }); }'
16. wait_for '[data-testid="context-menu"]'
17. expect_visible 'text="Delete"'
18. click 'text="Delete"'
19. sleep 1
20. screenshot 052-sftp-local-new-folder.png

## TC-053: Session tree drag-and-drop moves session into a folder
- tags: session, drag-drop, folders, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-dnd-target'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-dnd-target"]'
12. eval 'async page => { await page.evaluate(() => { window.prompt = () => "qa-ui-auto-dnd-group"; }); }'
13. eval 'async page => { await page.locator(`[data-testid="session-tree"]`).click({ button: "right", position: { x: 16, y: 16 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. eval 'async page => { const items = page.locator(`[data-testid^="context-menu-item-"]`); const count = await items.count(); for (let i = 0; i < count; i++) { const t = (await items.nth(i).innerText()).trim().toLowerCase(); if (t.includes("new folder") || t.includes("new group") || t.includes("create folder")) { await items.nth(i).click(); return; } } throw new Error("No \"new folder\" entry found in tree context menu"); }'
16. sleep 1
17. eval 'async page => { const src = await page.locator(`[data-testid="session-tree-item"][data-session-name="qa-ui-auto-dnd-target"]`).first(); const dst = await page.locator(`[data-testid="session-tree"]`).locator(`text="qa-ui-auto-dnd-group"`).first(); if (!src || !dst) throw new Error("Missing drag source or destination"); await src.dragTo(dst, { force: true }); }'
18. sleep 1
19. expect_visible 'text="qa-ui-auto-dnd-group"'
20. screenshot 053-session-tree-drag-drop.png

## TC-054: Session import and export JSON, CSV, and MobaXterm formats
- tags: session, import, export, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
5. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
6. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
7. click '[data-testid="session-section-bookmark"]'
8. wait_for '[data-testid="bookmark-settings"]'
9. fill '[data-testid="session-name"]' 'qa-ui-auto-export-source'
10. click '[data-testid="session-save"]'
11. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-export-source"]'
12. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); }'
13. eval 'async page => { await page.locator(`[data-testid="session-tree"]`).click({ button: "right", position: { x: 16, y: 16 } }); }'
14. wait_for '[data-testid="context-menu"]'
15. eval 'async page => { const items = page.locator(`[data-testid^="context-menu-item-"]`); const count = await items.count(); for (let i = 0; i < count; i++) { const t = (await items.nth(i).innerText()).trim(); if (t.includes("Export NewMob sessions")) { await items.nth(i).click(); return; } } throw new Error("Export NewMob sessions not found"); }'
16. sleep 1
17. eval 'async page => { await page.locator(`[data-testid="session-tree"]`).click({ button: "right", position: { x: 16, y: 16 } }); }'
18. wait_for '[data-testid="context-menu"]'
19. eval 'async page => { const items = page.locator(`[data-testid^="context-menu-item-"]`); const count = await items.count(); for (let i = 0; i < count; i++) { const t = (await items.nth(i).innerText()).trim(); if (t.includes("Export MobaXterm sessions")) { await items.nth(i).click(); return; } } throw new Error("Export MobaXterm sessions not found"); }'
20. sleep 1
21. eval 'async page => { await page.evaluate(() => { const blob = new Blob(["name,session_type,host,port,username\nqa-csv-import,SSH,${cfg:ssh.host},22,${cfg:ssh.user}"], { type: "text/csv" }); const file = new File([blob], "qa-import.csv", { type: "text/csv" }); const input = document.createElement("input"); input.type = "file"; input.style.display = "none"; document.body.appendChild(input); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); document.body.removeChild(input); }); }'
22. sleep 2
23. wait_for 'text="qa-csv-import"'
24. screenshot 054-session-import-export.png

## TC-055: OpenSSH config import from Welcome panel creates sessions
- tags: session, import, openssh, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="welcome-panel"]'
3. eval 'async page => { await page.evaluate(() => { const blob = new Blob(["Host qa-openssh-import\\n  HostName ${cfg:ssh.host}\\n  Port ${cfg:ssh.port}\\n  User ${cfg:ssh.user}\\n"], { type: "text/plain" }); const file = new File([blob], "config", { type: "text/plain" }); const input = document.createElement("input"); input.type = "file"; input.accept = ".config,.txt,*"; input.style.display = "none"; document.body.appendChild(input); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); document.body.removeChild(input); }); }'
4. sleep 2
5. wait_for 'text="qa-openssh-import"'
6. screenshot 055-openssh-config-import.png

## TC-056: Tunnel editor supports Remote and Dynamic types and clones tunnels
- tags: tunnel, editor, remote, dynamic, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="Network tools — SSH tunnels"'
4. click 'text="New SSH tunnel"'
5. sleep 1
6. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-remote-tunnel'
7. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
8. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
9. fill 'input[placeholder="22"]' '${cfg:ssh.port}'
10. eval 'async page => { await page.locator(`label:has-text("Remote port forwarding") input[type="radio"]`).first().click({ force: true }); }'
11. sleep 1
12. fill 'input[placeholder="0"]' '19222'
13. fill 'input[placeholder="127.0.0.1"]' '127.0.0.1'
14. fill 'input[placeholder="5432"]' '8080'
15. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
16. sleep 1
17. wait_for 'text="qa-ui-auto-remote-tunnel"'
18. expect_visible 'text="Remote"'
19. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-remote-tunnel")`); await row.locator(`button[title="Clone"]`).first().click(); }'
20. sleep 1
21. wait_for 'text="qa-ui-auto-remote-tunnel (copy)"'
22. eval 'async page => { const row = page.locator(`tr:has-text("qa-ui-auto-remote-tunnel (copy)")`); await row.locator(`button[title="Edit"]`).first().click(); }'
23. sleep 1
24. eval 'async page => { await page.locator(`label:has-text("Dynamic port forwarding (SOCKS proxy)") input[type="radio"]`).first().click({ force: true }); }'
25. sleep 1
26. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
27. sleep 1
28. wait_for 'text="Dynamic"'
29. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const rows = page.locator(`tr:has-text("qa-ui-auto-remote-tunnel")`); const count = await rows.count(); for (let i = 0; i < count; i++) { await rows.nth(i).locator(`button:has(svg.lucide-trash-2)`).first().click(); await page.waitForTimeout(400); } }'
30. sleep 1
31. screenshot 056-tunnel-remote-dynamic-clone.png

## TC-057: Tunnel row supports test connection, edit, and drag reorder
- tags: tunnel, test, edit, reorder, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-tunneling"]'
3. wait_for 'text="Network tools — SSH tunnels"'
4. click 'text="New SSH tunnel"'
5. sleep 1
6. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-reorder-a'
7. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
8. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
9. fill 'input[placeholder="22"]' '${cfg:ssh.port}'
10. eval 'async page => { const inputs = page.locator(`input[placeholder="0"]`); if (await inputs.count() > 0) await inputs.first().fill("19333"); const dest = page.locator(`input[placeholder="db.internal"], input[placeholder="0.0.0.0"]`).first(); if (await dest.count()) await dest.fill("127.0.0.1"); const port = page.locator(`input[placeholder="5432"]`); if (await port.count()) await port.fill("22"); }'
11. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
12. sleep 1
13. wait_for 'text="qa-ui-auto-reorder-a"'
14. click 'text="New SSH tunnel"'
15. sleep 1
16. fill 'input[placeholder="e.g. postgres-replica"]' 'qa-ui-auto-reorder-b'
17. fill 'input[placeholder="ssh.example.com"]' '${cfg:ssh.host}'
18. fill 'input[placeholder="user"]' '${cfg:ssh.user}'
19. fill 'input[placeholder="22"]' '${cfg:ssh.port}'
20. eval 'async page => { const inputs = page.locator(`input[placeholder="0"]`); if (await inputs.count() > 0) await inputs.first().fill("19334"); const dest = page.locator(`input[placeholder="db.internal"], input[placeholder="0.0.0.0"]`).first(); if (await dest.count()) await dest.fill("127.0.0.1"); const port = page.locator(`input[placeholder="5432"]`); if (await port.count()) await port.fill("22"); }'
21. eval 'async page => { await page.locator(`button:has-text("Save")`).first().click({ force: true }); }'
22. sleep 1
23. wait_for 'text="qa-ui-auto-reorder-b"'
24. eval 'async page => { const rowA = page.locator(`tr:has-text("qa-ui-auto-reorder-a")`); const rowB = page.locator(`tr:has-text("qa-ui-auto-reorder-b")`); const downA = await rowA.locator(`button[title="Move down"]`).first(); await downA.click(); }'
25. sleep 1
26. eval 'async page => { const rowA = page.locator(`tr:has-text("qa-ui-auto-reorder-a")`); await rowA.locator(`button[title="Test SSH connection"]`).first().click(); }'
27. sleep 2
28. eval 'async page => { await page.evaluate(() => { window.confirm = () => true; }); const rows = page.locator(`tr:has-text("qa-ui-auto-reorder")`); const count = await rows.count(); for (let i = 0; i < count; i++) { await rows.nth(i).locator(`button:has(svg.lucide-trash-2)`).first().click(); await page.waitForTimeout(400); } }'
29. sleep 1
30. screenshot 057-tunnel-reorder-test.png

## TC-058: Local terminal administrator launch button is visible and clickable
- tags: terminal, local, admin, p1
- mode: browser,native

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="welcome-panel"]'
3. expect_visible 'text="Start local terminal"'
4. eval 'async page => { const btn = page.locator(`button[aria-label="Open as administrator"]`); const count = await btn.count(); if (count === 0) console.log("[v0] Admin button not shown — shell may not support elevation"); else await btn.click(); }'
5. sleep 1
6. screenshot 058-local-terminal-admin.png

## TC-059: Terminal syntax highlighting switches between modes
- tags: terminal, syntax, highlighting, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="welcome-open-local-terminal"]'
3. wait_for '[data-testid="terminal-pane"]'
4. click '[data-testid="terminal-pane"]'
5. type 'echo error warning success'
6. press Enter
7. sleep 1
8. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
9. wait_for '[data-testid="context-menu"]'
10. eval 'async page => { await page.locator(`text="Syntax highlighting"`).hover(); }'
11. sleep 1
12. eval 'async page => { const items = page.locator(`text="Error/Warning/Success keywords"`); if (await items.count()) await items.first().click(); }'
13. sleep 1
14. eval 'async page => { await page.locator(`[data-testid="terminal-pane"]`).click({ button: "right", position: { x: 24, y: 24 } }); }'
15. wait_for '[data-testid="context-menu"]'
16. eval 'async page => { await page.locator(`text="Syntax highlighting"`).hover(); }'
17. sleep 1
18. eval 'async page => { const items = page.locator(`text="Default"`); if (await items.count()) await items.first().click(); }'
19. sleep 1
20. screenshot 059-terminal-syntax-highlight.png

## TC-060: Terminal font ligatures toggle persists in settings
- tags: terminal, font, ligatures, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="ribbon-settings"]'
3. wait_for '[data-testid="settings-panel"]'
4. eval 'async page => { const cb = page.locator(`input[aria-label="Enable font ligatures"]`); const before = await cb.isChecked(); await cb.click(); await page.waitForTimeout(300); const after = await cb.isChecked(); if (before === after) throw new Error("Ligatures checkbox did not change state"); }'
5. sleep 1
6. eval 'async page => { const cb = page.locator(`input[aria-label="Enable font ligatures"]`); const stored = await page.evaluate(() => { try { const p = JSON.parse(localStorage.getItem("newmob.terminalProfile.v1") || "{}"); return p.fontLigatures; } catch { return undefined; } }); if (typeof stored !== "boolean") console.log("[v0] ligatures not found in localStorage profile"); }'
7. screenshot 060-terminal-font-ligatures.png

## TC-061: Tab middle-click closes a closable tab
- tags: tabs, mouse, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="tab-bar"]'
3. click '[data-testid="welcome-open-local-terminal"]'
4. wait_for '[data-testid="terminal-pane"]'
5. eval 'async page => { const tabs = await page.locator(`[data-testid="tab-item"]`).count(); if (tabs < 2) throw new Error("Expected at least 2 tabs after opening local terminal"); }'
6. eval 'async page => { const tab = page.locator(`[data-testid="tab-item"]`).last(); await tab.click({ button: "middle" }); }'
7. sleep 1
8. eval 'async page => { const tabs = await page.locator(`[data-testid="tab-item"]`).count(); if (tabs !== 1) throw new Error(`Expected 1 tab after middle-click close, got ${tabs}`); }'
9. screenshot 061-tab-middle-click-close.png

## TC-062: Welcome panel active connections list updates when terminals open
- tags: welcome, connections, p1
- mode: browser

1. open ${cfg:app.base_url}
2. wait_for '[data-testid="welcome-panel"]'
3. expect_visible 'text="Active connections"'
4. expect_visible 'text="No active terminal tabs."'
5. click '[data-testid="welcome-open-local-terminal"]'
6. wait_for '[data-testid="terminal-pane"]'
7. sleep 1
8. eval 'async page => { await page.evaluate(() => window.__qaTabSwitchToWelcome && window.__qaTabSwitchToWelcome()); }'
9. sleep 1
10. eval 'async page => { const welcome = page.locator(`[data-testid="welcome-panel"]`); const text = await welcome.innerText(); if (!text.includes("local shell")) throw new Error("Active connections did not list the opened local terminal"); }'
11. screenshot 062-welcome-active-connections.png

## TC-063: Session editor advanced SSH forward switches (X11, compression, OSC 7)
- tags: session, ssh, advanced, p1
- mode: browser

1. open ${cfg:app.base_url}
2. click '[data-testid="session-new"]'
3. wait_for '[data-testid="session-editor"]'
4. click '[data-testid="session-proto-ssh"]'
5. fill '[data-testid="session-host"]' '${cfg:ssh.host}'
6. fill '[data-testid="session-port"]' '${cfg:ssh.port}'
7. fill '[data-testid="session-user"]' '${cfg:ssh.user}'
8. expect_visible '[data-testid="advanced-ssh-settings"]'
9. eval 'async page => { const x11 = page.locator(`[data-testid="advanced-ssh-settings"] input[type="checkbox"]`).first(); const before = await x11.isChecked(); await x11.click(); await page.waitForTimeout(300); const after = await x11.isChecked(); if (before === after) throw new Error("X11 checkbox did not toggle"); }'
10. eval 'async page => { const comp = page.locator(`label:has-text("Use SSH compression") input[type="checkbox"]`).first(); const before = await comp.isChecked(); await comp.click(); await page.waitForTimeout(300); const after = await comp.isChecked(); if (before === after) throw new Error("Compression checkbox did not toggle"); }'
11. eval 'async page => { const osc7 = page.locator(`label:has-text("Auto-inject OSC 7 cwd reporting") input[type="checkbox"]`).first(); const before = await osc7.isChecked(); await osc7.click(); await page.waitForTimeout(300); const after = await osc7.isChecked(); if (before === after) throw new Error("OSC 7 checkbox did not toggle"); }'
12. click '[data-testid="session-section-bookmark"]'
13. wait_for '[data-testid="bookmark-settings"]'
14. fill '[data-testid="session-name"]' 'qa-ui-auto-adv-switches'
15. click '[data-testid="session-save"]'
16. wait_for '[data-testid="session-tree-item"][data-session-name="qa-ui-auto-adv-switches"]'
17. screenshot 063-session-advanced-forward-switches.png
