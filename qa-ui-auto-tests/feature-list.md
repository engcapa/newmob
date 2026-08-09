# Taomni 已完成功能清单

> 本文档基于当前仓库代码、稳定 `data-testid` 目录和自动化用例维护，**仅记录已实现并接入主流程的功能**。架构与现状索引见 `DESIGN.md`、`IMPLEMENTATION_PLAN.md`。
> 标记说明：
> - ✅ 已完成
> - 🟡 已部分完成（关键路径可用，仍有未覆盖的能力，列出具体范围）
> - 未完成的能力不写入本文档（详见各 plan 文档的待办项）
> 当前对照版本：以本仓库 `package.json` 的 `0.4.9` 为准；下方历史版本记录仅用于追溯用例来源。

---

## 1. 应用框架与主界面

### 1.1 工程基座 ✅
- Tauri 2 + React 19 + TypeScript + Vite 桌面工程已搭建
- Rust 后端模块拆分：`terminal / session / filebrowser / tunnel / appearance / config / state`
- 前端目录拆分：`components / layouts / lib / stores / hooks / stubs / types`
- 同时支持 **Tauri 桌面打包模式** 与 **Vite 浏览器开发预览模式**（通过 `TAURI_ENV_PLATFORM` 自动切换 stub/真实后端）

### 1.2 主窗口三栏布局 ✅

<!-- feature
id: F1.2
status: done
area: main
components: [MainLayout, MenuBar, Ribbon, QuickConnect, Sidebar, TabBar, StatusBar]
files:
  - src/layouts/MainLayout.tsx
controls:
  # MainLayout owns layout-level chrome only; menu/ribbon/sidebar/quick-connect testids belong to their own features.
  # Ribbon and QuickConnect are hidden by default and can be enabled from View.
  - id: collapsed-sidebar-rail
    selector: '[data-testid="collapsed-sidebar-rail"]'
    kind: interactive
    optional: true       # only when sidebar collapsed
  - id: compact-sidebar-drawer
    selector: '[data-testid="compact-sidebar-drawer"]'
    kind: display
    optional: true       # only in compact mode after Show sessions drawer
  - id: sidebar-resize-handle
    selector: '[data-testid="main-sidebar-resize-handle"]'
    kind: display    # drag handle — meaningless to click; existence is the assertion
-->

- 顶部菜单栏 `MenuBar`（File/Edit/View/Sessions/Tools/Help）
- Ribbon 工具条 `Ribbon`（Session、Servers、Tools、View、Split、MultiExec、Tunneling、Packages、Settings、Help、X server、Exit）
- 地址栏式快速连接 `QuickConnect`
- 左侧可拖拽/可折叠 Sidebar
- 中间 Tab 栏 + 内容区
- 底部状态栏 `StatusBar`（活跃连接数、当前应用主题、状态消息）
- 侧边栏宽度通过 `react-resizable-panels` 持久化

### 1.3 自定义标题栏与窗口控制 ✅

<!-- feature
id: F1.3
status: done
area: main/window
components: [AppTitleBar, WindowControls, WindowResizeHandles, TitleBarTrayControls]
files:
  - src/components/window/AppTitleBar.tsx
  - src/components/window/WindowControls.tsx
  - src/components/window/TitleBarTrayControls.tsx
controls:
  - id: titlebar
    selector: '[data-testid="app-titlebar"]'
    kind: display
  - id: tray
    selector: '[data-testid="titlebar-tray"]'
    kind: display
  - id: theme-cycle
    selector: '[data-testid="theme-cycle"]'
    kind: interactive
  - id: compact-toggle
    selector: '[data-testid="compact-toggle"]'
    kind: interactive
  - id: split-view             # toggles terminal split view (lives in title bar tray)
    selector: '[data-testid="tab-split-view"]'
    kind: interactive
  - id: multiexec-toggle       # toggles MultiExec (lives in title bar tray)
    selector: '[data-testid="tab-multiexec-toggle"]'
    kind: interactive
  # language-switcher control is owned by F-I18n-1; the tray simply hosts the
  # button. Putting it both places would create a duplicate-selector lint
  # error, so this feature only documents that the title bar is its mount
  # point in prose below.
  - id: window-controls
    selector: '[data-testid="window-controls"]'
    kind: display
  - id: window-min
    selector: '[data-testid="window-min"]'
    kind: display    # clicking would minimize the window — assertion of presence is the right check
  - id: window-max
    selector: '[data-testid="window-max"]'
    kind: display    # clicking would maximize/restore the window
  - id: window-close
    selector: '[data-testid="window-close"]'
    kind: display    # clicking would close the window and abort the test
-->

- 取消原生 decorations，前端自绘 `AppTitleBar` + `WindowControls`（最小化 / 最大化 / 关闭）
- 标题栏托盘 `TitleBarTrayControls`：分组排列 — Voice (PTT) | View (主题循环 + 紧凑模式) | Terminal (Split + MultiExec) | Language (locale 切换)
- `WindowResizeHandles` 在无 decorations 模式下提供 8 向窗口缩放（North/South/East/West/四个角）
- 主菜单 / Sessions / View / Tunneling / Settings / Help / Exit 入口接入

### 1.4 紧凑 UI 模式（Compact mode）✅

<!-- feature
id: F1.4
status: done
area: main/window
components: [CompactTitleBar]
files:
  - src/components/tabbar/CompactTitleBar.tsx
  - src/index.css
controls:
  - id: titlebar
    selector: '[data-testid="compact-titlebar"]'
    kind: display
  - id: main-menu
    selector: '[data-testid="compact-main-menu"]'
    kind: interactive
  - id: sidebar-drawer-toggle
    selector: '[data-testid="compact-sidebar-drawer-toggle"]'
    kind: interactive
    aliases:
      - '[aria-label="Show sessions drawer"]'
-->

- 默认布局 vs 紧凑布局可一键切换，状态持久化到 `localStorage` (`taomni.compactMode`)
- 紧凑模式下使用 `CompactTitleBar`：主菜单按钮 + 标签栏 + 托盘控件统一在一行
- 标题栏内置主菜单：新建本地/远程会话、新建 SFTP、关闭活动标签、Sessions、View、Tunneling、Settings、Help、Exit
- 快捷键 Ctrl+Shift+M 切换紧凑模式

### 1.5 标签页系统 ✅

<!-- feature
id: F1.5
status: done
area: main/tabs
components: [TabBar, ControlBar, OpenTabsMenu, TabDetailsOverlay]
files:
  - src/components/tabbar/TabBar.tsx
  - src/components/tabbar/ControlBar.tsx
  - src/components/tabbar/OpenTabsMenu.tsx
  - src/components/tabbar/TabDetailsOverlay.tsx
  - src/lib/customDnD.ts
  - src/lib/tabDetails.ts
  - src/lib/terminalActivity.ts
  - src/lib/terminalCwd.ts
  - src/stores/appStore.ts
controls:
  - id: tab-bar
    selector: '[data-testid="tab-bar"]'
    kind: display
  - id: tab-item               # individual tab; pair with [data-tab-type=...] / [data-tab-title=...] when targeting
    selector: '[data-testid="tab-item"]'
    kind: interactive
  - id: tab-title              # the title span inside a tab; double-click to rename
    selector: '[data-testid="tab-title"]'
    kind: interactive
  - id: tab-title-input        # inline rename input; only present while editing
    selector: '[data-testid="tab-title-input"]'
    kind: interactive
    optional: true
  - id: new-local-terminal     # the "+" plus tab button
    selector: '[data-testid="new-local-terminal"]'
    kind: interactive
  - id: new-tab-split          # the "+ ▾" split-button container (Windows Terminal style)
    selector: '[data-testid="new-tab-split"]'
    kind: display
  - id: new-tab-launch-menu    # the "▾" chevron that opens the quick-launch context menu
    selector: '[data-testid="new-tab-launch-menu"]'
    kind: interactive
  - id: launch-menu-new-session  # "New session…" leaf in the quick-launch menu
    selector: '[data-testid="launch-menu-new-session"]'
    kind: interactive
    optional: true       # only after opening the launch menu
  - id: tabs-more
    selector: '[data-testid="tab-more"]'
    kind: interactive
  - id: tab-details-hover
    selector: '[data-testid="tab-details-hover"]'
    kind: interactive
  - id: tab-details-overlay
    selector: '[data-testid="tab-details-overlay"]'
    kind: display
    optional: true
  - id: tab-details-card
    selector: '[data-testid^="tab-details-card-"]'
    kind: display
    optional: true
  - id: tab-details-program
    selector: '[data-testid^="tab-details-program-"]'
    kind: display
    optional: true
  - id: open-tabs-menu
    selector: '[data-testid="open-tabs-menu"]'
    kind: display
    optional: true
  - id: open-tabs-detach-active
    selector: '[data-testid="open-tabs-detach-active"]'
    kind: interactive
    optional: true
  - id: tab-menu-move-first
    selector: '[data-testid="context-menu-item-move-to-first"]'
    kind: interactive
    optional: true       # only visible in a tab context menu
  - id: tab-menu-move-left
    selector: '[data-testid="context-menu-item-move-left"]'
    kind: interactive
    optional: true
  - id: tab-menu-move-right
    selector: '[data-testid="context-menu-item-move-right"]'
    kind: interactive
    optional: true
  - id: tab-menu-move-last
    selector: '[data-testid="context-menu-item-move-to-last"]'
    kind: interactive
    optional: true
  - id: tab-new-output-dot
    selector: 'span[aria-label="New output"]'
    kind: display
    optional: true
-->

- 多标签：本地终端 / SSH 终端 / SFTP / VNC / 设置 / 隧道管理 / Welcome / 占位标签
- 标签操作：新建、切换、关闭、中键关闭
- **新建标签 split-button**（Windows Terminal 风格 `+ ▾`）：`+`（`new-local-terminal`）直接开默认本地终端；`▾`（`new-tab-launch-menu`）打开快速启动菜单，列出全部本地 shell（含检测到的 WSL 发行版，`launch-menu-shell-<id>`）、最近会话子菜单（`launch-menu-recent-<id>`）、以及 `New session…`（`launch-menu-new-session`）打开会话编辑器
- **拖拽排序**：标签通过 `customDnD` 指针驱动层重新排列，拖拽时显示 drop indicator
- **重命名**：双击标签标题或右键菜单 "Rename" 进入内联编辑，Enter 确认 / Esc 取消 / 失焦自动提交
- **终端目录自动命名**：未手动命名的本地/SSH terminal 标题随 cwd 末级目录持续更新；远程标题始终以 session 名开头；复制 terminal 使用源 cwd 并延续 `-N` 家族编号
- **可见标签详情层**：按 `Ctrl+Shift+H`（macOS 为 `Cmd+Shift+H`）切换所有可见标签详情；hover 单个标签标题只展示该标签，hover/focus 右侧叠放标签信息按钮则展示全部；详情突出 cwd，并用主题 accent 色加重当前运行程序，同时简洁显示本地/远程、session、endpoint 和状态
- **Detach 收纳**：主窗口 terminal/RDP/VNC/DB 的 Detach 从 tab action slot 移入 `⋯` Open Tabs 菜单，原位置由标签详情按钮替代
- 标签右键菜单：关闭、关闭其他、关闭全部、复制标签、新建本地终端、重命名、Move to first/left/right/last
- SSH / SFTP / VNC 标签 **常驻挂载**（切换标签不销毁，传输/输出/连接不中断）
- 关闭应用前若有终端活跃会弹出确认

### 1.6 欢迎页 `WelcomePanel` ✅

<!-- feature
id: F1.6
status: done
area: main/welcome
components: [WelcomePanel]
files:
  - src/components/WelcomePanel.tsx
controls:
  - id: panel-root
    selector: '[data-testid="welcome-panel"]'
    kind: display
  - id: open-local-terminal
    selector: '[data-testid="welcome-open-local-terminal"]'
    kind: interactive
  - id: shell-select
    selector: 'select[aria-label="Terminal shell"]'
    kind: interactive
    optional: true       # only rendered when >1 local shell detected
  - id: open-home-folder
    selector: '[data-testid="welcome-open-home-folder"]'
    kind: interactive
    optional: true       # only rendered when onOpenLocalPath prop is set
  - id: open-as-administrator
    selector: 'button[aria-label="Open as administrator"]'
    kind: interactive
    optional: true       # only rendered when selected shell canElevate
  - id: new-session-card
    selector: 'text="New session…"'
    kind: interactive
  - id: new-session-button
    selector: '[data-testid="welcome-new-session"]'
    kind: interactive
  - id: recent-sessions-panel
    selector: '[data-testid="welcome-recent-sessions"]'
    kind: display
  - id: recent-filter
    selector: '[data-testid="welcome-recent-filter"]'
    kind: interactive
  - id: recent-type-filter
    selector: '[data-testid="welcome-recent-type-filter"]'
    kind: interactive
  - id: recent-sort
    selector: '[data-testid="welcome-recent-sort"]'
    kind: interactive
  - id: recent-open-all
    selector: '[data-testid="welcome-recent-open-all"]'
    kind: interactive
  - id: recent-open-filtered
    selector: '[data-testid="welcome-recent-open-filtered"]'
    kind: interactive
  - id: recent-open-selected
    selector: '[data-testid="welcome-recent-open-selected"]'
    kind: interactive
  - id: recent-select-filtered
    selector: '[data-testid="welcome-recent-select-filtered"]'
    kind: interactive
  - id: recent-clear-filter
    selector: '[data-testid="welcome-recent-clear-filter"]'
    kind: interactive
  - id: recent-clear-selection
    selector: '[data-testid="welcome-recent-clear-selection"]'
    kind: interactive
    optional: true       # rendered only after at least one recent row is selected
  - id: recent-settings
    selector: '[data-testid="welcome-recent-settings"]'
    kind: interactive
  - id: recent-session-row
    selector: '[data-testid="welcome-recent-session-row"]'
    kind: display
    optional: true       # only rendered when saved sessions have last_connected_at
  - id: recent-session-select
    selector: '[data-testid="welcome-recent-select"]'
    kind: interactive
    optional: true
  - id: recent-session-open
    selector: '[data-testid="welcome-recent-open"]'
    kind: interactive
    optional: true
  - id: recent-session-reveal
    selector: '[data-testid="welcome-recent-reveal"]'
    kind: interactive
    optional: true
  - id: recent-empty
    selector: '[data-testid="welcome-recent-empty"]'
    kind: display
    optional: true
  - id: recent-no-matches
    selector: '[data-testid="welcome-recent-no-matches"]'
    kind: display
    optional: true
  - id: tips-section
    selector: 'text="Tips"'
    kind: display
  - id: version-header
    selector: '[data-testid="welcome-version"]'
    kind: display
  - id: version-footer
    selector: '[data-testid="welcome-version-footer"]'
    kind: display
-->

- 启动入口：开始本地终端、新建会话、导入 OpenSSH config
- 最近会话历史：显示最近打开过的已保存 session，支持过滤、类型筛选、排序、打开全部/过滤结果/所选/单条、定位到 session 树；行右键菜单与 session 树会话项保持一致（连接、编辑、复制、移动到文件夹、删除），并可跳转设置历史数量（默认 20）

### 1.7 状态栏 ✅

<!-- feature
id: F1.7
status: done
area: main/statusbar
components: [StatusBar]
files:
  - src/components/statusbar/StatusBar.tsx
controls:
  - id: status-bar
    selector: '[data-testid="status-bar"]'
    kind: display
-->

- 显示活跃连接数
- 显示当前应用主题（Light / Dark / Follow system）
- 显示瞬时状态消息（操作反馈）

### 1.8 关于对话框 `AboutDialog` ✅
- Help 菜单入口
- 展示应用图标、`Version` 字段（来自 `__APP_VERSION__` 注入的 `package.json` 版本号）
- Esc / 点击遮罩 / Close 按钮均可关闭

### 1.8 主菜单栏 `MenuBar` ✅

<!-- feature
id: F1.8
status: done
area: main/menubar
components: [MenuBar]
files:
  - src/components/menubar/MenuBar.tsx
controls:
  - id: menu-bar
    selector: '[data-testid="menu-bar"]'
    kind: display
  - id: menu-terminal
    selector: '[data-testid="menu-terminal"]'
    kind: interactive
  - id: menu-sessions
    selector: '[data-testid="menu-sessions"]'
    kind: interactive
  - id: menu-view
    selector: '[data-testid="menu-view"]'
    kind: interactive
  - id: menu-toggle-ribbon
    selector: '[data-testid="context-menu-item-toggle-ribbon"]'
    kind: interactive
    optional: true       # only after opening View or the menu-bar right-click menu
  - id: menu-toggle-quick-connect
    selector: '[data-testid="context-menu-item-toggle-quick-connect"]'
    kind: interactive
    optional: true       # only after opening View or the menu-bar right-click menu
  - id: menu-help
    selector: '[data-testid="menu-help"]'
    kind: interactive
  - id: menu-import-sessions      # submenu trigger inside Sessions menu
    selector: '[data-testid="menu-import-sessions"]'
    kind: interactive
    optional: true       # only after opening the Sessions menu
  - id: menu-export-sessions      # submenu trigger inside Sessions menu
    selector: '[data-testid="menu-export-sessions"]'
    kind: interactive
    optional: true
-->

- 顶级菜单：Terminal / Sessions / View / X server / Tools / Settings / Macros / Help
- 下拉项调用 ribbon 命令或在新标签内打开会话
- 右键菜单兜底已被 ContextMenu 通用化

### 1.9 Ribbon 命令条 `Ribbon` ✅

<!-- feature
id: F1.9
status: done
area: main/ribbon
components: [Ribbon]
files:
  - src/components/menubar/Ribbon.tsx
controls:
  - id: ribbon
    selector: '[data-testid="ribbon"]'
    kind: display
    optional: true       # hidden by default; enable via View -> Tool button bar
  - id: ribbon-session
    selector: '[data-testid="ribbon-session"]'
    kind: interactive
  - id: ribbon-sftp
    selector: '[data-testid="ribbon-sftp"]'
    kind: interactive
  - id: ribbon-servers
    selector: '[data-testid="ribbon-servers"]'
    kind: interactive       # opens the Local servers dialog (F-Servers-1)
  - id: ribbon-settings
    selector: '[data-testid="ribbon-settings"]'
    kind: interactive
  - id: ribbon-tunneling
    selector: '[data-testid="ribbon-tunneling"]'
    kind: interactive
  - id: ribbon-multiexec
    selector: '[data-testid="ribbon-multiexec"]'
    kind: interactive
    optional: true
  - id: ribbon-commands
    selector: '[data-testid="ribbon-commands"]'
    kind: interactive
    optional: true
-->

- 大图标命令：Session / SFTP / Servers / Tools / View / Split / MultiExec / Tunneling / Packages / Settings / Help
- 每条命令通过 `data-testid={`ribbon-${slug(label)}`}` 暴露稳定锚点

---

## 2. 本地终端（Local Terminal）

### 2.1 PTY 后端 ✅

<!-- feature
id: F2.1
status: done
area: terminal/local
components: [TerminalPanel]
files:
  - src-tauri/src/terminal/
controls: []   # backend-only — PTY runtime has no UI surface; the terminal pane is owned by F2.2
-->

- Rust 端基于 `portable-pty` 创建 PTY（Linux/macOS/Windows）
- 平台默认 shell 自动判定（bash / zsh / powershell）
- 命令：`create_local_terminal` / `write_terminal` / `resize_terminal` / `close_terminal`
- 数据通路：默认通过 `terminal-output-{sid}` event 推送；Tauri 2 IPC channel 改造后改用 `tauri::ipc::Channel<InvokeResponseBody>` 直传二进制，去掉 base64 编解码与字符串拷贝
- 桌面启动器中 `TERM` 缺失的回归已修复（保证 vi、TUI 程序可用）

### 2.2 终端面板 `TerminalPanel` ✅

<!-- feature
id: F2.2
status: done
area: terminal/local
components: [TerminalPanel]
files:
  - src/components/terminal/TerminalPanel.tsx
  - src/components/ContextMenu.tsx
  - src/lib/terminalCommand.ts
controls:
  - id: terminal-pane
    selector: '[data-testid="terminal-pane"]'
    kind: interactive       # type / send_keys go here
  - id: attached-sftp-toggle
    selector: '[data-testid="attached-sftp-toggle"]'
    kind: interactive
    optional: true          # only on SSH-backed terminals
  - id: tab-chat-toggle
    selector: '[data-testid="tab-chat-toggle"]'
    kind: interactive
    optional: true          # terminal floating toolbar; hidden in terminal split mode
  # Shared right-click menu surface (rendered by ContextMenu)
  - id: context-menu
    selector: '[data-testid="context-menu"]'
    kind: display
    optional: true          # only after right_click
-->

- xterm.js + FitAddon + WebglAddon（失败回退 canvas）+ SearchAddon + WebLinksAddon
- ResizeObserver + debounce 自动 fit
- 容器卸载时正确 dispose 终端实例与监听器
- 浮动工具栏包含当前 tab 绑定 Chat 入口（`tab-chat-toggle` / Ctrl+Shift+L）；全局 Chat 入口已移除
- 命令历史持久化：每条 host 维度记录到 SQLite (`command_history` 表)，支持 `history_append / history_match_prefix / history_list_recent / history_clear`
- Inline ghost-text 自动补全：基于 host 命令历史的前缀匹配，按右箭头 / End / Tab 接受建议（PowerShell 本地终端关闭以避免与 PSReadLine 冲突）
- Common commands 调色板（`CommonCommandsPalette`）：合并历史 + 用户自定义 + 平台预置命令（Windows / Unix），在本地终端中可调出
- SSH 终端连接进度态 UI（连接中 / 已建立 / 断开）有更连贯的过渡

### 2.3 终端连接状态 ✅
- SSH 终端启动期 UI：占位骨架 + "Connecting…"，连接成功后无缝切换到 xterm 渲染
- 端会话失败时给出错误提示

### 2.4 本地 shell 选择 ✅

<!-- feature
id: F2.4
status: done
area: terminal/local
components: [WelcomePanel]
files: []     # WelcomePanel UI is owned by F1.6; F2.4 is the logical concern (which shells get listed) and has no dedicated source surface
controls: []
-->

- `list_local_shells` 列出系统 shell
- `open_local_shell_as_administrator` 以管理员身份启动（平台支持时）
- 支持选择 shell 启动本地终端

### 2.5 本地真实信号投递 🟡
- 已实现 Unix `SIGINT / SIGTERM / SIGKILL / SIGQUIT / SIGHUP`
- 跨平台对齐尚未完整覆盖

---

## 3. SSH 终端

### 3.1 SSH 后端（russh）✅

<!-- feature
id: F3.1
status: done
area: terminal/ssh
components: [TerminalPanel]
files:
  - src-tauri/src/terminal/
controls: []   # backend-only — russh client + IPC lives in src-tauri; the terminal pane belongs to F2.2
-->

- `create_ssh_terminal` / `test_ssh_connection` / `send_terminal_signal`
- 三种认证：Password、PrivateKey（密钥文件）、Agent
- 请求 PTY channel（term=`xterm-256color`），启动 shell
- SSH channel 与本地 PTY 共用相同的 event 推送通道
- Windows 11 上私钥认证失败的兼容性问题已修复

### 3.2 高级 SSH 能力 ✅

<!-- feature
id: F3.2
status: done
area: terminal/ssh
files:
  - src-tauri/src/terminal/forwards.rs
  - src-tauri/src/terminal/network.rs
controls: []   # backend-only — ProxyJump / agent forwarding / keepalive run in Rust; user-facing toggles live in the SessionEditor (F6.3)
-->

- ProxyJump（跳板机）：`forwards.rs` 实现 direct-tcpip 链路
- Agent 转发
- X11 转发（Linux/macOS/Windows）：`terminal/x11.rs` 解析 `$DISPLAY`/cookie，`terminal/x11_forward.rs` 桥接 SSH x11 通道到本机 X 服务（Xorg/XQuartz/VcXsrv/WSLg），支持信任/非信任 cookie 两种模式；状态栏与 Ribbon 的 X server 指示来自 `detect_x_server` 实时探测
- Keepalive 定时包
- 断线检测 + 状态事件
- 网络代理配置（`network.rs` 入口）

### 3.3 OSC 7 工作目录广播 ✅

<!-- feature
id: F3.3
status: done
area: terminal/ssh
files:
  - src/components/terminal/TerminalPanel.tsx
controls: []   # OSC 7 is an in-pty protocol; the terminal pane surface is owned by F2.2
-->

- 终端解析 `\e]7;file://host/path\e\` 序列
- 通过 `onCwdChange` prop 同步给主布局
- 连接成功后自动注入 `PROMPT_COMMAND` (bash) / `precmd_functions` (zsh) 来周期性发出 OSC 7
- 高级设置中可按会话开关 OSC 7 自动注入

### 3.4 浏览器预览模式下的 SSH 桥接（开发用）✅
- Vite 插件 `sshProxy.ts` + WebSocket `/__taomni/ssh-bridge`
- 浏览器内连接真实 SSH 服务器（仅密码与内联私钥）
- 仅 dev 模式启用，不进入 desktop release 包

---

## 4. 终端右键菜单与操作（MobaXterm 同款）

### 4.1 复制粘贴查找 ✅

<!-- feature
id: F4.1
status: done
area: terminal/right-menu
files:
  - src-tauri/src/lib.rs
  - src/components/terminal/TerminalPanel.tsx
controls:
  # Right-click menu items (text-based — ContextMenu generates testids dynamically by label slug)
  - id: copy
    selector: 'text="Copy"'
    kind: interactive
    optional: true            # only after right_click on terminal
  - id: copy-all
    selector: 'text="Copy All"'
    kind: interactive
    optional: true
  - id: copy-formatted
    selector: 'text="Copy formatted text (HTML/RTF)"'
    kind: interactive
    optional: true
  - id: paste
    selector: 'text="Paste"'
    kind: interactive
    optional: true
  - id: find
    selector: 'text="Find"'
    kind: interactive
    optional: true
    aliases:
      - '[data-testid="context-menu-item-find"]'
  # Find dialog spawned by Ctrl+Shift+F or "Find" menu item
  - id: find-input
    selector: 'input[placeholder="Find"]'
    kind: interactive
    optional: true
  - id: find-match-info
    selector: 'span:has-text("Match")'
    kind: display
    optional: true
  - id: find-close
    selector: 'role=button[name="Close"]'
    kind: interactive
    optional: true
-->

- Copy / Copy All / Paste / Paste with Shift+Insert
- 跨平台复制/粘贴快捷键：macOS `Cmd+C / Cmd+V`，Windows / Linux `Ctrl+Shift+C / Ctrl+Shift+V`
- **CopyOnSelect**：选区释放后自动复制到剪贴板（开关存在 `terminalProfile`，每会话可覆盖）
- **中键粘贴（middle-click paste）**：当前选区优先，无选区则回退剪贴板内容；read-only 模式下被拦截
- **OS 文件拖入终端**：拖到终端面板时按当前 shell 引号风格（unix/powershell/cmd）插入引号路径，多文件以空格分隔，末尾保留一个空格
  - SSH 远程终端：固定 unix 引号（路径仅插入文本，不会触发上传）
  - 本地终端：按解析后的 `localShellId`（powershell / command-prompt / git-bash）选择风格，未知时按主机平台回退
  - 来源：Linux/macOS 走 Tauri `onDragDropEvent` 绝对路径；Windows 走 webview HTML5 `text/uri-list`
  - read-only 模式下被拦截，状态栏给出提示
  - **e2e 测试限制**：与 SFTP 同因——单元测试 `src/lib/osFileDrop.test.ts` + `TerminalPanel.test.tsx` 覆盖引号格式与事件路由，平台行为需手动回归
- Find（Ctrl+Shift+F），结果计数、上下匹配、关闭
- HTML + 纯文本剪贴板写入（`ClipboardItem` 可用时）

### 4.2 字体与显示 ✅

<!-- feature
id: F4.2
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: zoom-in
    selector: 'text="Zoom in"'
    kind: interactive
    optional: true
  - id: zoom-out
    selector: 'text="Zoom out"'
    kind: interactive
    optional: true
  - id: zoom-reset
    selector: 'text="Reset zoom"'
    kind: interactive
    optional: true
  - id: appearance
    selector: '[data-testid="context-menu-item-appearance"]'
    kind: interactive
    optional: true
  - id: terminal-display
    selector: 'text="Terminal display"'
    kind: interactive
    optional: true
  - id: read-only-toggle
    selector: 'text="Read-only terminal"'
    kind: interactive
    optional: true
  - id: scrollbar-toggle
    selector: 'text="Toggle terminal scrollbar"'
    kind: interactive
    optional: true
  - id: fullscreen-toggle
    selector: 'text="Fullscreen terminal"'
    kind: interactive
    optional: true
-->

- 一级菜单：Zoom in / Zoom out / Reset zoom，快捷键保持 Ctrl++ / Ctrl+- / Ctrl+0
- Appearance 子菜单：统一配置主题、字体家族、字号；不再保留重复的 Font size 子菜单
- Ctrl+滚轮调整字号、Ctrl+0 重置
- Terminal display 子菜单：Reset terminal output、Clear scrollback、Set terminal title、Toggle scrollbar、Fullscreen (F11)、Read-only

### 4.3 语法高亮 ✅

<!-- feature
id: F4.3
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: syntax-highlighting
    selector: 'text="Syntax highlighting"'
    kind: interactive
    optional: true
  - id: syntax-default
    selector: 'text="Default"'
    kind: interactive
    optional: true
  - id: syntax-keywords
    selector: 'text="Error/Warning/Success keywords"'
    kind: interactive
    optional: true
-->

- Default / Error-Warning-Success keywords / Unix shell / Cisco / Perl / SQL
- Read-only 模式下输入被拦截，输出仍正常渲染

### 4.4 宏录制与回放 ✅

<!-- feature
id: F4.4
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: record-macro
    selector: 'text="Record new macro"'
    kind: interactive
    optional: true
  - id: stop-macro
    selector: 'text="Stop macro recording"'
    kind: interactive
    optional: true
-->

- 录制新宏、执行宏（Ctrl+Space）

### 4.5 输出导出 ✅

<!-- feature
id: F4.5
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: save-to-file
    selector: 'text="Save to file"'
    kind: interactive
    optional: true
  - id: start-output-record
    selector: 'text="Record terminal output to file"'
    kind: interactive
    optional: true
  - id: stop-output-record
    selector: 'text="Stop recording terminal output"'
    kind: interactive
    optional: true
-->

- Save to file（Ctrl+Shift+S）：浏览器下载导出当前 buffer
- Record terminal output to file：实时记录会话输出

### 4.6 特殊命令 / 信号 🟡
- 已实现：Local 端真实 Unix 信号、SSH channel 信号 + Ctrl+C 兜底 SIGINT、Break、IGNORE message
- 未实现：SSH break request、跨平台完整信号矩阵

### 4.7 事件日志 🟡

<!-- feature
id: F4.7
status: partial
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: event-log-menu-item
    selector: '[data-testid="context-menu-item-event-log"]'
    kind: interactive
    optional: true
    aliases:
      - 'text="Event Log"'
-->

- 已记录：connect / auth / resize / disconnect / error / 导出 / 日志 / 宏 / 信号
- 未记录：reconnect 事件（重连流程尚未上线）

### 4.8 快捷键 ✅

<!-- feature
id: F4.8
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls: []   # F4.8 covers OS-level keyboard shortcuts (Ctrl+0 / F11 / Ctrl+Shift+F / etc.) — exercised via `press` verb against [data-testid="terminal-pane"] (F2.2). No dedicated DOM surface.
-->

- Shift+Insert 粘贴、Ctrl+Shift+F 查找、F11 全屏、Ctrl+0 重置字号、Ctrl+滚轮缩放字号
- macOS Cmd+C / Cmd+V，Windows / Linux Ctrl+Shift+C / Ctrl+Shift+V

### 4.9 Linux 中文输入兼容 ✅
- WebKitGTK 下 IME composition/preedit guard
- 防止中文重复回显，commit 阶段唯一放行
- `compositionend`/`beforeinput` fallback、组合时间窗内的去重

### 4.10 Z-modem 文件收发（rz / sz）✅

<!-- feature
id: F4.10
status: done
area: terminal/file-transfer
components: [TerminalPanel, ZmodemConflictDialog]
files:
  - src/lib/zmodem.ts
  - src/components/terminal/ZmodemConflictDialog.tsx
controls:
  - id: dialog
    selector: '[data-testid="zmodem-conflict"]'
    kind: display
    optional: true       # only when a name conflict surfaces during rz/sz
  - id: overwrite
    selector: '[data-testid="zmodem-overwrite"]'
    kind: interactive
    optional: true
  - id: rename
    selector: '[data-testid="zmodem-rename"]'
    kind: interactive
    optional: true
  - id: skip
    selector: '[data-testid="zmodem-skip"]'
    kind: interactive
    optional: true
-->

- 基于 `zmodem.js` 的 `Sentry` 实现协议检测，所有终端输出字节流经 `ZmodemSession.consume()` 透明路由
- **接收（sz → 本地）**：检测到远端 `sz` 握手后弹出目录选择对话框，通过 Tauri 文件写流（`onOpenWriteStream / onAppendWriteStream / onCloseWriteStream`）落盘，支持中途 abort
- **发送（rz → 远端）**：
  - 右键菜单 "Send file using Z-modem" 主动触发：弹出文件选择器，选好后自动向终端注入 `rz\r` 并排队发送
  - 远端主动执行 `rz` 时自动弹出文件选择器，通过 Tauri 文件读流（`onOpenReadStream / onReadStream / onCloseReadStream`）分块发送
- 传输进度条：实时显示文件名、已传字节 / 总字节、百分比进度条，覆盖接收与发送两个方向
- 文件冲突对话框 `ZmodemConflictDialog`：目标文件已存在时弹出 Overwrite / Skip / Rename，可勾选 "应用到剩余文件"
- 事件日志：传输完成与错误均写入终端事件日志（`appendEvent("zmodem", ...)`）
- 状态互斥：传输进行中菜单项 disabled，防止并发冲突；传输结束后自动重置为 idle
- 协议容错：`on_retract` / 超时 grace 期（750 ms）自动重置协议状态，异常时重建 Sentry 实例
- 内存占用优化：传输管线按块流式处理，避免整文件常驻内存
- 已修复 password 模式 SSH 终端下 rz/sz 不工作 / 弹出多次文件选择器 / vi 等 TUI 程序回归等问题

### 4.11 MultiExec 多终端广播模式 ✅

<!-- feature
id: F4.11
status: done
area: terminal/multiexec
components: [MultiExecBar]
files:
  - src/components/terminal/MultiExecBar.tsx
controls:
  - id: bar
    selector: '[data-testid="multiexec-bar"]'
    kind: display
    optional: true       # only when MultiExec is active
  - id: input
    selector: '[data-testid="multiexec-input"]'
    kind: interactive
    optional: true
-->

- Ribbon 入口 + 全局 `Ctrl+Alt+M` 切换
- 选中多个标签后，输入广播到所有被选中的终端
- `MultiExecBar`：紧凑发送条 + 可拖拽的展开编辑器（多行文本、最近命令历史、回车 / Ctrl+Enter 发送）
- 选中状态在 TabBar 上有视觉标记（`isMultiExecTarget`）

### 4.12 Common commands 调色板 ✅

<!-- feature
id: F4.12
status: done
area: terminal/palette
components: [CommonCommandsPalette]
files:
  - src/components/terminal/CommonCommandsPalette.tsx
controls:
  - id: palette
    selector: '[data-testid="commands-palette"]'
    kind: display
    optional: true       # only when palette is open
  - id: search
    selector: '[data-testid="commands-search"]'
    kind: interactive
    optional: true
  - id: list
    selector: '[data-testid="commands-list"]'
    kind: display
    optional: true
-->

- 本地终端中通过快捷键调出 `CommonCommandsPalette`
- 候选合并三类来源并去重：命令历史（host 维度）、用户自定义命令、平台预置命令（Windows / Unix 各一套，覆盖 nav / git / network / process / system / files / env）
- 选中后注入到当前终端

### 4.13 终端截图 / 滚动截屏 / GIF 录制 ✅

<!-- feature
id: F4.13
status: done
area: capture
components: [CaptureToolbar, FloatingToolbar]
files:
  - src/components/capture/CaptureToolbar.tsx
  - src/lib/capture/
controls:
  - id: toolbar-root
    selector: '[data-testid="capture-toolbar"]'
    kind: display
  - id: capture-menu
    selector: '[data-testid="capture-menu"]'
    kind: interactive
  - id: save-visible
    selector: '[data-testid="capture-save-visible"]'
    kind: interactive
    optional: true       # only renders when menu is open
  - id: copy-clipboard
    selector: '[data-testid="capture-copy-clipboard"]'
    kind: interactive
    optional: true
  - id: save-full
    selector: '[data-testid="capture-save-full"]'
    kind: interactive
    optional: true       # menu open AND host provides getFull
  - id: toggle-scroll
    selector: '[data-testid="capture-toggle-scroll"]'
    kind: interactive
    optional: true       # menu open AND host provides getScrollFrame
  - id: toggle-gif
    selector: '[data-testid="capture-toggle-gif"]'
    kind: interactive
    optional: true       # menu open AND host provides getGifFrame
  - id: stop-scroll-pill   # active-capture pill, only while scroll-capturing
    selector: '[data-testid="capture-stop-scroll"]'
    kind: interactive
    optional: true
  - id: stop-gif-pill      # active-capture pill, only while recording
    selector: '[data-testid="capture-stop-gif"]'
    kind: interactive
    optional: true
-->

- 终端面板内嵌 `CaptureToolbar`（通过 `FloatingToolbar` 浮窗承载，可拖拽 / 折叠 / 位置持久化）
- **可见区域 PNG**：截取当前可见 viewport，可保存到磁盘或写入剪贴板（`ClipboardItem`）
- **滚动截屏**：滚动捕获整段 scrollback 拼接为单张长图（`startScrollCapture`）
- **GIF 录制**：基于 `gifenc` 的实时录制，工具条显示计时与 Stop；保存为 .gif
- 文件名前缀按上下文（terminal / vnc）自动生成时间戳后缀

---

## 5. 终端外观与配置

### 5.1 OS 字体枚举 ✅

<!-- feature
id: F5.1
status: done
area: terminal/appearance
files:
  - src/lib/systemFonts.ts
  - src-tauri/src/appearance/
controls: []   # font enumeration is consumed by F4.2/F5.2 UI controls
-->

- Tauri 命令 `list_system_fonts`（基于 `font-kit`）
- 前端 IPC 拉取系统字体列表，加载失败时使用安全 fallback
- Source Code Pro 在可用时作为默认字体

### 5.2 终端主题预览下拉（Termius 风格）✅

<!-- feature
id: F5.2
status: done
area: terminal/appearance
components: [TerminalAppearanceSettings]
files:
  - src/components/terminal/TerminalAppearanceSettings.tsx
controls:
  - id: appearance-root
    selector: '[data-testid="terminal-appearance-settings"]'
    kind: display
  - id: theme-select
    selector: '[data-testid="terminal-theme-select"]'
    kind: interactive
  - id: theme-options
    selector: '[data-testid^="terminal-theme-option-"]'
    kind: interactive
    optional: true       # only visible while the preview dropdown is open
  - id: local-default-theme
    selector: '[data-testid="terminal-context-set-local-default-theme"]'
    kind: interactive
    optional: true       # only visible in the local terminal context menu
  - id: preview
    selector: '[data-testid="terminal-preview"]'
    kind: display
  - id: preview-cursor
    selector: '[data-testid="terminal-preview-cursor"]'
    kind: display
  # Settings inputs (aria-label fallback — promote to testids when these labels change)
  - id: font-size
    selector: 'input[aria-label="Terminal font size"]'
    kind: interactive
  - id: font-family
    selector: 'select[aria-label="Terminal font"]'
    kind: interactive
  - id: font-size-decrease
    selector: 'button[aria-label="Decrease text size"]'
    kind: interactive
  - id: font-size-increase
    selector: 'button[aria-label="Increase text size"]'
    kind: interactive
  - id: font-ligatures-toggle
    selector: 'input[aria-label="Enable font ligatures"]'
    kind: interactive
  - id: scrollback
    selector: 'input[aria-label="Scrollback lines"]'
    kind: interactive
  - id: inline-suggestions-max
    selector: 'input[aria-label="Maximum command history entries per host"]'
    kind: interactive
  - id: cursor-style
    selector: 'select[aria-label="Terminal cursor"]'
    kind: interactive
  - id: right-click-behavior
    selector: 'select[aria-label="Right click behavior"]'
    kind: interactive
  - id: background-hex
    selector: 'input[aria-label="Terminal background hex"]'
    kind: interactive
  - id: foreground-hex
    selector: 'input[aria-label="Terminal foreground hex"]'
    kind: interactive
-->

- 多套预置主题，带可视化预览
- 主题元数据驱动 UI
- 终端右键菜单可快速切换主题（无需重连重挂载）

### 5.3 共享外观控件 `TerminalAppearanceSettings` ✅
- 字体选择器、字号 stepper、主题预览下拉、底部预览
- 光标样式（block / underline / bar）+ 闪烁
- Scrollback 行数、日志、关键字高亮、显示项、剪贴板/粘贴策略
- 同一控件复用于终端类会话编辑器与终端上下文菜单相关设置
- 实时预览反映光标样式与闪烁状态

### 5.4 配置持久化 ✅
- 终端默认配置：`localStorage` 的 `taomni.terminalDefaultProfile.v1`（用于新建 SSH / 本地终端；旧 `taomni.localTerminalProfile.v1` 仅作兼容读取）
- 保存会话 override：`session.options_json.terminalProfile`
- 活跃终端可在不重启的情况下应用主题/字体/字号/连字变化

### 5.5 应用整体主题（Light / Dark / Follow system）✅

<!-- feature
id: F5.5
status: done
area: main/theme
files:
  - src/lib/appTheme.ts
  - src/components/settings/AppThemeSwitcher.tsx
controls:
  # Title-bar quick-cycle theme button is owned by F1.3 (theme-cycle).
  # F5.5 owns the in-Settings preview dropdown + standalone icon button.
  - id: theme-select
    selector: '[data-testid="app-theme-select"]'
    kind: interactive
  - id: theme-options
    selector: '[data-testid^="app-theme-"]'
    kind: interactive
    optional: true       # light/dark/system rows only render while the dropdown is open
  - id: theme-icon-button
    selector: 'button[aria-label="Cycle application theme"]'
    kind: interactive
    optional: true       # AppThemeIconButton — currently unused outside the title-bar tray
-->

- `localStorage` key `taomni.appTheme.v1`
- `data-app-theme` 应用到 root document
- Follow system 监听 `prefers-color-scheme` 变化
- 全局 Settings、Welcome、顶部菜单、会话设置标题栏均可快速切换主题
- MenuBar / Ribbon / QuickConnect / Tabs / Sidebar / StatusBar / Cards / Inputs / Buttons / 右键菜单 / 会话设置 / 认证弹窗 全部接入主题变量

---

## 6. 会话管理

### 6.1 SQLite 会话存储 ✅

<!-- feature
id: F6.1
status: done
area: sessions/persistence
files:
  - src-tauri/src/session/
  - src/stubs/tauri-core.ts
controls: []   # backend-only — SQLite persistence + dev-mode IPC stubs; sidebar/editor surfaces belong to F6.2 / F6.3
-->

- 表：`sessions` + `session_groups`
- 命令：`list_sessions / get_session / save_session / delete_session / mark_session_connected / list_session_groups / save_session_group / delete_session_group`
- 应用启动时初始化于 `app_data_dir/taomni.db`
- 浏览器预览模式回退到 `localStorage`（key `taomni.sessions.v1` / `taomni.groups.v1`）

### 6.2 会话树 `SessionTree` ✅

<!-- feature
id: F6.2
status: done
area: sessions
components: [SessionTree, Sidebar]
files:
  - src/components/sidebar/SessionTree.tsx
  - src/components/sidebar/Sidebar.tsx
  - src/components/session/SessionConnectionCommandMenu.tsx
  - src/lib/customDnD.ts
  - src/lib/sessionConnectionCommand.ts
controls:
  - id: sidebar
    selector: '[data-testid="sidebar"]'
    kind: display
  - id: side-tab-sessions
    selector: '[data-testid="side-tab-sessions"]'
    kind: interactive
    optional: true       # compact rail entry when the main sidebar is collapsed
  - id: session-tree
    selector: '[data-testid="session-tree"]'
    kind: display
  - id: session-tree-item       # individual row; pair with [data-session-name=...] / [data-session-type=...]
    selector: '[data-testid="session-tree-item"]'
    kind: interactive
  - id: session-search
    selector: '[data-testid="session-search"]'
    kind: interactive
  - id: session-new
    selector: '[data-testid="session-new"]'
    kind: interactive
  - id: session-edit
    selector: '[data-testid="session-edit"]'
    kind: interactive
  - id: session-duplicate
    selector: '[data-testid="session-duplicate"]'
    kind: interactive
  - id: session-delete
    selector: '[data-testid="session-delete"]'
    kind: interactive
  - id: context-set-terminal-theme
    selector: '[data-testid="context-menu-item-set-terminal-theme"]'
    kind: interactive
    optional: true       # visible from a saved session context menu
  - id: context-copy-connection-command
    selector: '[data-testid="context-menu-item-copy-connection-command"]'
    kind: interactive
    optional: true       # visible from a command-capable saved session context menu
  - id: context-copy-command-posix
    selector: '[data-testid="context-menu-item-copy-command-posix"]'
    kind: interactive
    optional: true       # visible from the copy connection command flyout
  - id: context-copy-command-powershell
    selector: '[data-testid="context-menu-item-copy-command-powershell"]'
    kind: interactive
    optional: true       # visible from the copy connection command flyout
  - id: context-copy-command-posix-basic
    selector: '[data-testid="context-menu-item-copy-command-posix-basic"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Linux/macOS
  - id: context-copy-command-posix-jump
    selector: '[data-testid="context-menu-item-copy-command-posix-jump"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Linux/macOS
  - id: context-copy-command-posix-forwards
    selector: '[data-testid="context-menu-item-copy-command-posix-forwards"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Linux/macOS
  - id: context-copy-command-posix-full
    selector: '[data-testid="context-menu-item-copy-command-posix-full"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Linux/macOS
  - id: context-copy-command-powershell-basic
    selector: '[data-testid="context-menu-item-copy-command-powershell-basic"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Windows PowerShell
  - id: context-copy-command-powershell-jump
    selector: '[data-testid="context-menu-item-copy-command-powershell-jump"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Windows PowerShell
  - id: context-copy-command-powershell-forwards
    selector: '[data-testid="context-menu-item-copy-command-powershell-forwards"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Windows PowerShell
  - id: context-copy-command-powershell-full
    selector: '[data-testid="context-menu-item-copy-command-powershell-full"]'
    kind: interactive
    optional: true       # visible for SSH sessions under Windows PowerShell
  - id: context-terminal-theme-options
    selector: '[data-testid^="session-terminal-theme-option-"]'
    kind: interactive
    optional: true       # visible while the terminal theme flyout is open
-->

- 分组树（展开 / 折叠 / 拖拽到分组）
- 搜索框 `session-search`
- 双击 → 触发连接
- 右键菜单：Connect / Copy connection command / Edit / Duplicate / Move to folder / Set terminal theme / Delete
- 「最近连接」区域

### 6.3 会话编辑器 `SessionEditor` ✅

<!-- feature
id: F6.3
status: done
area: sessions
components: [SessionEditor]
files:
  - src/components/session/SessionEditor.tsx
controls:
  # Dialog frame
  - id: editor
    selector: '[data-testid="session-editor"]'
    kind: display
  # Protocol selectors (dynamic: session-proto-${id.toLowerCase()})
  - id: proto-ssh
    selector: '[data-testid="session-proto-ssh"]'
    kind: interactive
  - id: proto-sftp
    selector: '[data-testid="session-proto-sftp"]'
    kind: interactive
  - id: proto-rdp
    selector: '[data-testid="session-proto-rdp"]'
    kind: interactive
  - id: proto-vnc
    selector: '[data-testid="session-proto-vnc"]'
    kind: interactive
  - id: proto-ftp
    selector: '[data-testid="session-proto-ftp"]'
    kind: interactive
  - id: proto-telnet
    selector: '[data-testid="session-proto-telnet"]'
    kind: interactive
  - id: proto-rlogin
    selector: '[data-testid="session-proto-rlogin"]'
    kind: interactive
  - id: proto-mosh
    selector: '[data-testid="session-proto-mosh"]'
    kind: interactive
  - id: proto-serial
    selector: '[data-testid="session-proto-serial"]'
    kind: interactive
  - id: proto-browser
    selector: '[data-testid="session-proto-browser"]'
    kind: interactive
  - id: proto-shell
    selector: '[data-testid="session-proto-shell"]'
    kind: interactive
  - id: proto-file
    selector: '[data-testid="session-proto-file"]'
    kind: interactive
    optional: true
  - id: proto-wsl
    selector: '[data-testid="session-proto-wsl"]'
    kind: interactive
    optional: true        # WSL session type — form body owned by F9.8
  - id: proto-mysql
    selector: '[data-testid="session-proto-mysql"]'
    kind: interactive
    optional: true        # DB session type — form body owned by F-DB-1
  - id: proto-postgresql
    selector: '[data-testid="session-proto-postgresql"]'
    kind: interactive
    optional: true        # DB session type — form body owned by F-DB-1
  - id: proto-panweidb
    selector: '[data-testid="session-proto-panweidb"]'
    kind: interactive
    optional: true        # DB session type — form body owned by F-DB-1
  - id: proto-clickhouse
    selector: '[data-testid="session-proto-clickhouse"]'
    kind: interactive
    optional: true        # DB session type — form body owned by F-DB-1
  - id: proto-redis
    selector: '[data-testid="session-proto-redis"]'
    kind: interactive
    optional: true        # Redis session type — form body owned by F-DB-2
  - id: proto-hbaseshell
    selector: '[data-testid="session-proto-hbaseshell"]'
    kind: interactive
    optional: true        # HBase session type — form body owned by F-DB-3
  # Top-level connection fields (visible when SSH/SFTP/VNC/RDP)
  - id: host
    selector: '[data-testid="session-host"]'
    kind: interactive
  - id: user
    selector: '[data-testid="session-user"]'
    kind: interactive
  - id: port
    selector: '[data-testid="session-port"]'
    kind: interactive
  - id: name
    selector: '[data-testid="session-name"]'
    kind: interactive
  - id: file-target
    selector: '[data-testid="session-file-target"]'
    kind: interactive
    optional: true        # only visible for file-browser proto
  - id: planned-client-note
    selector: '[data-testid="session-planned-client-note"]'
    kind: display
    optional: true        # only visible when a future protocol is explicitly marked planned
  - id: serial-section
    selector: '[data-testid="session-serial-section"]'
    kind: display
    optional: true        # only visible for Serial proto
  - id: serial-device
    selector: '[data-testid="session-serial-device"]'
    kind: interactive
    optional: true        # only visible for Serial proto
  - id: serial-baud
    selector: '[data-testid="session-serial-baud"]'
    kind: interactive
    optional: true        # only visible for Serial proto
  - id: local-shell-section
    selector: '[data-testid="session-local-shell-section"]'
    kind: display
    optional: true        # only visible for Shell proto
  - id: local-shell-select
    selector: '[data-testid="local-shell-select"]'
    kind: interactive
    optional: true        # only visible for Shell proto
  - id: local-shell-preview
    selector: '[data-testid="local-shell-preview"]'
    kind: display
    optional: true        # only visible for Shell proto
  # Section tabs (dynamic: session-section-${t.id})
  - id: section-bookmark
    selector: '[data-testid="session-section-bookmark"]'
    kind: interactive
  - id: section-advanced
    selector: '[data-testid="session-section-advanced"]'
    kind: interactive
  - id: section-terminal
    selector: '[data-testid="session-section-terminal"]'
    kind: interactive
    optional: true        # absent for Mail and RDP
  - id: section-appearance
    selector: '[data-testid="session-section-appearance"]'
    kind: interactive
    optional: true        # Mail uses a mail-specific Appearance tab
  - id: section-network
    selector: '[data-testid="session-section-network"]'
    kind: interactive
  - id: section-database
    selector: '[data-testid="session-section-database"]'
    kind: interactive
    optional: true        # only present for DB protos; body owned by F-DB-1/F-DB-2
  - id: hbase-section
    selector: '[data-testid="session-hbase-section"]'
    kind: display
    optional: true        # only present for HBaseShell; body owned by F-DB-3
  # Section bodies
  - id: advanced-body
    selector: '[data-testid="advanced-ssh-settings"]'
    kind: display
  - id: terminal-body
    selector: '[data-testid="terminal-settings"]'
    kind: display
    optional: true        # not used by Mail Appearance
  - id: network-body
    selector: '[data-testid="network-settings"]'
    kind: display
  - id: bookmark-body
    selector: '[data-testid="bookmark-settings"]'
    kind: display
  # Advanced SSH inputs (aria-label fallback — selectors will fail when label text changes; promote to testids later)
  - id: advanced-execute-command
    selector: 'input[aria-label="Execute command"]'
    kind: interactive
  - id: advanced-ssh-password
    selector: 'input[aria-label="SSH password"]'
    kind: interactive
    optional: true        # only when authMethod=Password
  - id: save-in-vault
    selector: '[data-testid="session-save-in-vault"]'
    kind: interactive
    optional: true        # only when authMethod=Password and vault is not empty
  - id: advanced-private-key
    selector: 'input[aria-label="Private key path"]'
    kind: interactive
    optional: true        # only when authMethod=PrivateKey
  - id: advanced-jump-host
    selector: 'input[aria-label="Jump host"]'
    kind: interactive
    optional: true
  - id: advanced-jump-user
    selector: 'input[aria-label="Jump user"]'
    kind: interactive
    optional: true
  - id: advanced-jump-port
    selector: 'input[aria-label="Jump port"]'
    kind: interactive
    optional: true
  # Network inputs
  - id: network-proxy-host
    selector: 'input[aria-label="Proxy host"]'
    kind: interactive
  - id: network-proxy-port
    selector: 'input[aria-label="Proxy port"]'
    kind: interactive
  - id: network-proxy-user
    selector: 'input[aria-label="Proxy username"]'
    kind: interactive
  - id: network-proxy-password
    selector: 'input[aria-label="Proxy password"]'
    kind: interactive
  - id: network-keepalive
    selector: 'input[aria-label="Keep-alive interval"]'
    kind: interactive
  - id: network-new-forward-local
    selector: 'input[aria-label="New forward local address"]'
    kind: interactive
  - id: network-new-forward-remote
    selector: 'input[aria-label="New forward remote address"]'
    kind: interactive
  - id: network-new-forward-desc
    selector: 'input[aria-label="New forward description"]'
    kind: interactive
  # Bookmark inputs
  - id: bookmark-background
    selector: 'input[aria-label="Background image"]'
    kind: interactive
  - id: bookmark-bg-opacity
    selector: 'input[aria-label="Background opacity"]'
    kind: interactive
  - id: bookmark-description
    selector: 'textarea[aria-label="Description notes"]'
    kind: interactive
  - id: bookmark-tags
    selector: 'input[aria-label="Tags"]'
    kind: interactive
  - id: bookmark-extra-params
    selector: 'input[aria-label="Additional parameters"]'
    kind: interactive
  - id: bookmark-shortcut
    selector: 'input[aria-label="Keyboard shortcut"]'
    kind: interactive
  # Footer
  - id: save
    selector: '[data-testid="session-save"]'
    kind: interactive
-->

- 协议选择：SSH、SFTP、RDP、VNC、Browser、FTP、Telnet、Rlogin、Mosh、Serial、Shell（SSH/SFTP 原生；VNC/RDP 接入基础 client；Browser 打开系统浏览器；FTP/Telnet/Rlogin/Mosh/Serial 启动本地命令行 client；Shell 启动本地终端）
- 基础设置：host、port、username、auth method；远程主机框可粘贴 `ssh -p 2222 user@host` 这类 OpenSSH 命令并填充会话草稿
- Advanced SSH：SSH-browser type、Auto-inject OSC 7、Execute command、跳板机/代理
- Terminal：复用 `TerminalAppearanceSettings` 全套外观控件；Mail 使用独立的邮件外观控件
- Network：Keep-alive、proxy 配置、隧道转发列表（local/remote/dynamic 添加）
- Bookmark：name、group、tags、描述备注
- 顶部主题快速切换条
- Session 类型 Shell/LocalShell：在编辑器中设置启动参数

### 6.4 快速连接栏 `QuickConnect` ✅

<!-- feature
id: F6.4
status: done
area: sessions
components: [QuickConnect]
files:
  - src/components/quickconnect/QuickConnect.tsx
controls:
  - id: bar-root
    selector: '[data-testid="quick-connect"]'
    kind: display
    optional: true       # hidden by default; enable via View -> Quick connect toolbar
  - id: input
    selector: '[data-testid="qc-input"]'
    kind: interactive
  - id: submit
    selector: '[data-testid="qc-submit"]'
    kind: interactive
  - id: back
    selector: '[data-testid="qc-back"]'
    kind: interactive
  - id: forward
    selector: '[data-testid="qc-forward"]'
    kind: interactive
  - id: home
    selector: '[data-testid="qc-home"]'
    kind: interactive
  - id: recent-button         # one of N rendered for each recent session
    selector: '[data-testid="qc-recent"]'
    kind: interactive
    optional: true            # only when there's at least one recent session
  - id: refresh
    selector: '[data-testid="qc-refresh"]'
    kind: interactive
-->

- 地址栏式输入：`ssh://user@host:port`、`ssh user@host:port`、`browser://host`、`ftp://user@host:port`、`serial /dev/ttyUSB0:115200`
- 自动解析协议/用户/主机/端口，本地 Shell/Browser/FTP/Telnet/Rlogin/Mosh/Serial 分流到对应 client 打开路径
- Enter 提交后弹出认证弹窗（密码场景）

### 6.5 认证弹窗 `AuthPrompt` ✅

<!-- feature
id: F6.5
status: done
area: sessions
components: [AuthPrompt]
files:
  - src/components/session/AuthPrompt.tsx
controls:
  - id: prompt
    selector: '[data-testid="auth-prompt"]'
    kind: display
  - id: password
    selector: '[data-testid="auth-password"]'
    kind: interactive
  - id: submit
    selector: '[data-testid="auth-submit"]'
    kind: interactive
  - id: cancel
    selector: '[data-testid="auth-cancel"]'
    kind: interactive
  - id: close
    selector: '[data-testid="auth-close"]'
    kind: interactive
-->

- 密码输入弹窗
- 空密码不可提交（防 Enter 误触）

### 6.6 OpenSSH 配置导入 ✅

<!-- feature
id: F6.6
status: done
area: sessions/import
files:
  - src/lib/sessionImportExport.ts
controls: []   # UI entry is the Sessions menu import flow; this feature is the import library logic only
-->

- 解析 `~/.ssh/config` 并批量导入会话
- Sessions 菜单提供入口

### 6.7 会话 import/export 工具 ✅
- `src/lib/sessionImportExport.ts` 提供导入导出能力（含单元测试）

---

## 7. SFTP 文件浏览器

### 7.1 SFTP 后端（russh-sftp 2.x）✅

<!-- feature
id: F7.1
status: done
area: sftp
files:
  - src-tauri/src/filebrowser/
controls: []   # backend-only — russh-sftp protocol layer; the dual-pane UI is owned by F7.2
-->

- 命令：
  - 连接：`sftp_attach / sftp_detach`
  - 浏览：`sftp_list_remote / sftp_list_local / sftp_local_home / sftp_local_drives / sftp_realpath / sftp_stat`
  - 增删改：`sftp_mkdir / sftp_remove / sftp_rename / sftp_chmod`
  - 读写：`sftp_read_file_text / sftp_write_file_text`
  - 传输：`sftp_upload / sftp_download / sftp_upload_dir / sftp_download_dir / sftp_upload_bytes / sftp_download_bytes`
  - 控制：`sftp_cancel_transfer / sftp_pause_transfer / sftp_resume_transfer`
  - 系统：`sftp_open_path`（xdg-open / open / start）
  - 跨窗口：`open_sftp_window`
- `ActiveSftp` 内持有 `client::Handle` 保持 SSH 连接存活

### 7.2 双面板浏览器 `FileBrowser` ✅

<!-- feature
id: F7.2
status: done
area: sftp
components: [FileBrowser, FilePanel]
files:
  - src/components/filebrowser/LocalFileBrowserPanel.tsx
  - src/components/filebrowser/FileBrowser.tsx
  - src/components/filebrowser/FilePanel.tsx
  - src/components/filebrowser/PathBreadcrumb.tsx
  - src/lib/sftp.ts
controls:
  - id: panel-root
    selector: '[data-testid="sftp-browser"]'
    kind: display
  - id: local-pane
    selector: '[data-testid="sftp-local-pane"]'
    kind: display
  - id: remote-pane
    selector: '[data-testid="sftp-remote-pane"]'
    kind: display
  - id: local-list
    selector: '[data-testid="sftp-local-list"]'
    kind: display
  - id: remote-list
    selector: '[data-testid="sftp-remote-list"]'
    kind: display
  - id: col-header-name
    selector: '[data-testid="col-header-name"]'
    kind: interactive       # click to sort
  - id: col-header-size
    selector: '[data-testid="col-header-size"]'
    kind: interactive
  - id: col-header-type
    selector: '[data-testid="col-header-type"]'
    kind: interactive
  - id: col-header-modified
    selector: '[data-testid="col-header-modified"]'
    kind: interactive
  - id: col-resize-name
    selector: '[data-testid="col-resize-name"]'
    kind: interactive       # drag handle
  - id: col-resize-size
    selector: '[data-testid="col-resize-size"]'
    kind: interactive
  - id: col-resize-modified
    selector: '[data-testid="col-resize-modified"]'
    kind: interactive
  - id: breadcrumb-drives-root
    selector: '[data-testid="breadcrumb-drives-root"]'
    kind: interactive
    optional: true          # Windows-only drives breadcrumb
-->

- 远程面板 + 本地面板（左右或上下，可切换 orientation）
- 列：图标 / 名称 / 大小 / 修改时间 / 类型 / 权限 / 所有者
- 列头点击排序
- 路径面包屑 + 路径输入框（Enter 跳转）
- 工具条：刷新、上一级、Home、新建文件、新建文件夹、上传、下载、预览、删除
- 多选 + 全选
- 本地新建文件、本地删除、本地上传到远程
- 远程预览（`sftp_remote_preview`）

### 7.3 文件传输队列 ✅

<!-- feature
id: F7.3
status: done
area: sftp
files:
  - src/components/filebrowser/FileTransferQueue.tsx
controls:
  - id: queue-root
    selector: '[data-testid="sftp-transfer-queue"]'
    kind: display
-->

- 状态：进度条、速度、ETA、状态徽章
- 操作：暂停 / 恢复 / 取消 / 重试
- 暂停事件 `sftp-paused-{id}` 即时反馈
- 文件夹传输：双向 `sftp_upload_dir` / `sftp_download_dir`（预先 dir_size 计算总量，按文件聚合进度）
- 跨窗口同步：`BroadcastChannel taomni.sftp.sync` 镜像同源窗口的传输队列
- 入队时记录 `kind: file | dir`，重试路由到正确命令
- 批量上传 / 下载吞吐优化：合并复制粘贴和拖拽路径，减少多文件场景下的 IPC 抖动
- 复制粘贴：跨面板复制粘贴文件（参考 OS 行为，配合 `application/x-taomni-files` MIME）

### 7.4 SFTP 入口（三种）✅

<!-- feature
id: F7.4
status: done
area: sftp
files:
  - src/components/filebrowser/FileBrowser.tsx
  - src/components/filebrowser/FileToolbar.tsx
  - src/components/filebrowser/SftpDetachedWindow.tsx
controls:
  - id: detach
    selector: '[data-testid="sftp-detach"]'
    kind: interactive
    optional: true       # only when host wires onDetach
  - id: close
    selector: '[data-testid="sftp-close"]'
    kind: interactive
    optional: true       # only when host wires onClose (attached sidebar)
  - id: orientation-toggle
    selector: '[data-testid="sftp-orientation-toggle"]'
    kind: interactive
  - id: local-detach           # toolbar detach (FileToolbar testId={`sftp-${side}-detach`})
    selector: '[data-testid="sftp-local-detach"]'
    kind: interactive
    optional: true
  - id: remote-detach
    selector: '[data-testid="sftp-remote-detach"]'
    kind: interactive
    optional: true
-->

- **附加侧边栏**：每个 SSH 终端右上角 `attached-sftp-toggle`，与终端共用凭证；远程面板首次跟随 OSC 7 跳转一次，工具条 Sync 按钮可手动重跳
- **独立标签页**：从会话编辑器选择 `SessionType::SFTP` → 全标签 `FileBrowser`，未激活时仍挂载以保持传输
- **分离窗口**：附加 / 独立两种均提供 Detach 入口
  - Tauri：通过 `open_sftp_window` 打开真实 OS WebviewWindow
  - 浏览器：`window.open` 兜底
  - 使用独立 sessionId（`__detached`）避免与父窗口共享 SFTP channel
  - 通过 `localStorage` `taomni.sftp.detached.<sid>` 传递凭证
  - 父窗口 OSC 7 cwd 通过 `BroadcastChannel` 同步给分离窗口

### 7.5 面板交互 ✅

<!-- feature
id: F7.5
status: done
area: sftp
files:
  - src-tauri/src/lib.rs
  - src/components/filebrowser/FileToolbar.tsx
  - src/components/filebrowser/FilePanel.tsx
  - src/components/filebrowser/PathBreadcrumb.tsx
  - src/components/filebrowser/ChmodDialog.tsx
  - src/lib/customDnD.ts
controls:
  # path input + breadcrumb (FilePanel renders PathBreadcrumb with testId={`sftp-${side}-path`})
  - id: local-path
    selector: '[data-testid="sftp-local-path"]'
    kind: interactive       # click to edit, Enter to navigate
  - id: remote-path
    selector: '[data-testid="sftp-remote-path"]'
    kind: interactive
  # toolbar — local side
  - id: local-back
    selector: '[data-testid="sftp-local-back"]'
    kind: interactive
  - id: local-forward
    selector: '[data-testid="sftp-local-forward"]'
    kind: interactive
  - id: local-up
    selector: '[data-testid="sftp-local-up"]'
    kind: interactive
  - id: local-refresh
    selector: '[data-testid="sftp-local-refresh"]'
    kind: interactive
  - id: local-upload-selected
    selector: '[data-testid="sftp-local-upload-selected"]'
    kind: interactive
    optional: true       # only when host wires onUploadSelected
  - id: local-open-selected
    selector: '[data-testid="sftp-local-open-selected"]'
    kind: interactive
    optional: true
  - id: local-reveal-in-os
    selector: '[data-testid="sftp-local-reveal-in-os"]'
    kind: interactive
    optional: true
  - id: local-new-folder
    selector: '[data-testid="sftp-local-new-folder"]'
    kind: interactive
  - id: local-new-file
    selector: '[data-testid="sftp-local-new-file"]'
    kind: interactive
    optional: true
  - id: local-delete
    selector: '[data-testid="sftp-local-delete"]'
    kind: interactive
    optional: true
  - id: local-chmod
    selector: '[data-testid="sftp-local-chmod"]'
    kind: interactive
    optional: true
  - id: local-preview
    selector: '[data-testid="sftp-local-preview"]'
    kind: interactive
    optional: true
  - id: local-toggle-hidden
    selector: '[data-testid="sftp-local-toggle-hidden"]'
    kind: interactive
  # toolbar — remote side
  - id: remote-back
    selector: '[data-testid="sftp-remote-back"]'
    kind: interactive
  - id: remote-forward
    selector: '[data-testid="sftp-remote-forward"]'
    kind: interactive
  - id: remote-up
    selector: '[data-testid="sftp-remote-up"]'
    kind: interactive
  - id: remote-refresh
    selector: '[data-testid="sftp-remote-refresh"]'
    kind: interactive
  - id: remote-download-selected
    selector: '[data-testid="sftp-remote-download-selected"]'
    kind: interactive
    optional: true
  - id: remote-upload-from-disk
    selector: '[data-testid="sftp-remote-upload-from-disk"]'
    kind: interactive
    optional: true
  - id: remote-new-folder
    selector: '[data-testid="sftp-remote-new-folder"]'
    kind: interactive
  - id: remote-new-file
    selector: '[data-testid="sftp-remote-new-file"]'
    kind: interactive
    optional: true
  - id: remote-delete
    selector: '[data-testid="sftp-remote-delete"]'
    kind: interactive
    optional: true
  - id: remote-chmod
    selector: '[data-testid="sftp-remote-chmod"]'
    kind: interactive
    optional: true
  - id: remote-preview
    selector: '[data-testid="sftp-remote-preview"]'
    kind: interactive
    optional: true
  - id: remote-toggle-hidden
    selector: '[data-testid="sftp-remote-toggle-hidden"]'
    kind: interactive
  - id: remote-open-terminal-here
    selector: '[data-testid="sftp-remote-open-terminal-here"]'
    kind: interactive
    optional: true
  # Right-click context-menu items (rendered by the shared ContextMenu surface)
  - id: ctx-permissions
    selector: '[data-testid="context-menu-item-permissions"]'
    kind: interactive
    aliases:
      - 'text="Permissions…"'
  - id: ctx-rename
    selector: '[data-testid="context-menu-item-rename"]'
    kind: interactive
    aliases:
      - 'text="Rename"'
  - id: ctx-delete
    selector: '[data-testid="context-menu-item-delete"]'
    kind: interactive
    optional: true       # also reachable via toolbar; menu item only fires when right-click chooses it
  # ChmodDialog (opened by ctx-permissions)
  - id: chmod-dialog
    selector: '[aria-label="Permissions"]'
    kind: display
  - id: chmod-apply
    selector: 'role=button[name="Apply"]'
    kind: interactive
-->

- 右键菜单：
  - 远程：Download to local、Rename、Permissions（chmod）、Delete、New folder、New file
  - 本地：对应操作
- chmod 对话框：Owner / Group / Other 三组权限位 + Apply
- 跨面板拖拽（REMOTE↔LOCAL）：`customDnD` 指针驱动层 + `application/x-taomni-files` MIME，支持多选与文件夹
- OS 文件拖入远程面板 → 直接上传到当前远程目录
  - Linux/macOS：通过 Tauri `onDragDropEvent` 拿到绝对路径，前端 `sftpStat(side="local") → controller.upload`
  - Windows：通过 webview HTML5 `dataTransfer.files`（拿不到绝对路径，按 File blob 上传）
  - 与跨面板拖拽并存：根据 `dataTransfer.types` 区分 OS drop（`Files` / `text/uri-list`）vs 内部 drop（`application/x-taomni-files`）
  - 主窗口 + 分离 SFTP 窗口 `dragDropEnabled=true`，仅 Windows `disable_drag_drop_handler()`
  - **e2e 测试限制**：依赖真实 OS 拖拽产生的 `DataTransfer.types=Files`/`text/uri-list` 或 Tauri `onDragDropEvent`，Playwright `drag_to` 与 `tauri-driver` 都无法合成此 payload；当前 verb-catalog 也禁止 `dispatchEvent`/`new DataTransfer`。覆盖由单元测试 `src/lib/osFileDrop.test.ts` + `FileToolbarWiring.test.tsx` 承担，平台行为（Win/macOS/Linux）需手动回归
- 双击文件：下载后用系统编辑器打开（"先下载"确认）
- Open terminal here：把远程当前路径发到关联终端（`cd 'path'`）

### 7.6 同步与方向控制 ✅
- 终端 cwd → 远程面板：一次性首次同步 + 手动 Sync 按钮（不再连续追踪）
- Pane orientation：横向/纵向布局切换 + per-scope 持久化（`taomni.sftp.orientation.<scope>`）
- 附加侧边栏默认 vertical，全标签/分离窗口默认 horizontal

### 7.7 浏览器预览模式 SFTP 桥接（开发用）✅
- `vite-plugins/sftpProxy.ts` WebSocket 桥
- `src/stubs/sftpClient.ts`、`localVfs.ts`（IndexedDB 模拟本地 FS）
- 仅 dev 模式启用

---

## 8. SSH 隧道（端口转发）

### 8.1 隧道后端 ✅
- 命令：`list_tunnels / upsert_tunnel / delete_tunnel / start_tunnel / stop_tunnel / start_all_tunnels / stop_all_tunnels / reorder_tunnels / test_tunnel / get_tunnel_status / list_tunnel_statuses`
- 类型：Local / Remote / Dynamic (SOCKS5)
- 应用启动时自动启动 `autostart=true` 的隧道
- 状态通过 `tunnel-status-{id}` 事件推送

### 8.2 隧道管理界面 `TunnelManager` ✅

<!-- feature
id: F8.2
status: done
area: tunnel
components: [TunnelManager, TunnelEditor]
files:
  - src/components/tunnel/TunnelManager.tsx
  - src/components/tunnel/TunnelEditor.tsx
controls:
  - id: panel-root
    selector: '[data-testid="tunnel-manager"]'
    kind: display
  - id: tunnel-list
    selector: '[data-testid="tunnel-list"]'
    kind: display
  # Footer: bulk actions
  - id: new-tunnel
    selector: '[data-testid="tunnel-new"]'
    kind: interactive
    aliases:
      - 'button:has-text("New SSH tunnel")'   # legacy text-based reference in TC-032..057
  - id: start-all
    selector: '[data-testid="tunnel-start-all"]'
    kind: interactive
  - id: stop-all
    selector: '[data-testid="tunnel-stop-all"]'
    kind: interactive
  - id: exit-button
    selector: '[data-testid="tunnel-exit"]'
    kind: interactive
    optional: true       # only rendered when onClose prop is wired
  # Per-row controls (matched by data-tunnel-id when targeting a specific tunnel)
  - id: row
    selector: '[data-testid="tunnel-row"]'
    kind: display
  - id: row-move-up
    selector: '[data-testid="tunnel-row-move-up"]'
    kind: interactive
  - id: row-move-down
    selector: '[data-testid="tunnel-row-move-down"]'
    kind: interactive
  - id: row-toggle           # central status-column start/stop button
    selector: '[data-testid="tunnel-row-toggle"]'
    kind: interactive
  - id: row-toggle-reveal
    selector: '[data-testid="tunnel-row-toggle-reveal"]'
    kind: interactive
  # Settings-column action icons (rendered via IconBtn — extractor missed them)
  - id: row-edit
    selector: '[data-testid="tunnel-row-edit"]'
    kind: interactive
  - id: row-edit-key
    selector: '[data-testid="tunnel-row-edit-key"]'
    kind: interactive
  - id: row-test
    selector: '[data-testid="tunnel-row-test"]'
    kind: interactive
  - id: row-clone
    selector: '[data-testid="tunnel-row-clone"]'
    kind: interactive
  - id: row-autostart
    selector: '[data-testid="tunnel-row-autostart"]'
    kind: interactive
  - id: row-delete
    selector: '[data-testid="tunnel-row-delete"]'
    kind: interactive
  - id: row-power            # right-edge duplicate of row-toggle
    selector: '[data-testid="tunnel-row-power"]'
    kind: interactive
  # TunnelEditor dialog (modal opened by new-tunnel / row-edit)
  - id: editor-root
    selector: '[data-testid="tunnel-editor"]'
    kind: display
  - id: editor-name
    selector: 'input[placeholder="e.g. postgres-replica"]'
    kind: interactive
  - id: editor-host
    selector: 'input[placeholder="ssh.example.com"]'
    kind: interactive
  - id: editor-user
    selector: 'input[placeholder="user"]'
    kind: interactive
  - id: editor-port
    selector: 'input[placeholder="22"]'
    kind: interactive
  - id: editor-local-port
    selector: 'input[placeholder="0"]'
    kind: interactive
  - id: editor-remote-host
    selector: 'input[placeholder="127.0.0.1"]'
    kind: interactive
    optional: true       # only rendered for remote-forward / dynamic kinds
  - id: editor-remote-port
    selector: 'input[placeholder="5432"]'
    kind: interactive
    optional: true
  - id: editor-kind-remote
    selector: 'label:has-text("Remote port forwarding") input[type="radio"]'
    kind: interactive
  - id: editor-kind-dynamic
    selector: 'label:has-text("Dynamic port forwarding (SOCKS proxy)") input[type="radio"]'
    kind: interactive
  - id: editor-save
    selector: '[data-testid="tunnel-editor-save"]'
    kind: interactive
    aliases:
      - 'button:has-text("Save")'
  - id: editor-cancel
    selector: '[data-testid="tunnel-editor-cancel"]'
    kind: interactive
    optional: true
  # Activity log (footer, below the tunnel list) — records start/stop/error events
  - id: activity-log
    selector: '[data-testid="tunnel-activity-log"]'
    kind: display
  - id: activity-log-toggle
    selector: '[data-testid="tunnel-activity-log-toggle"]'
    kind: interactive
  - id: activity-log-clear
    selector: '[data-testid="tunnel-activity-log-clear"]'
    kind: interactive
    optional: true       # only visible when the log is expanded
-->

- 列表展示：类型、状态徽章（运行/错误/停止）、本地端口 → 远程地址、关联会话、认证图标
- 操作：启动 / 停止 / 启动全部 / 停止全部 / 测试 / 编辑 / 复制 / 删除 / 显示隐藏认证 / 拖拽排序
- 实时状态订阅 `listenTunnelStatus`
- 编辑器 `TunnelEditor`：填写所有字段、验证
- **活动日志**（`tunnel-activity-log`）：底部可折叠面板，记录隧道启动 / 停止 / 错误事件，显示条数与错误计数徽章；`tunnel-activity-log-toggle` 展开/折叠，展开后 `tunnel-activity-log-clear` 清空（无日志时禁用）

---

## 9. VNC 客户端

### 9.1 嵌入式 VNC client（RFB 协议引擎）✅

<!-- feature
id: F9.1
status: done
area: vnc
files:
  - src-tauri/src/vnc/
controls: []   # backend-only — RFB protocol + WebSocket bridge; the canvas surface is owned by F9.6
-->

- Rust 端 VNC 模块：`src-tauri/src/vnc/{mod, rfb, ws, encodings, clipboard}.rs`
- Tauri 命令：`vnc_connect / vnc_disconnect / vnc_test_connection`
- 本地动态端口 WebSocket relay：VNC server ↔ 前端 Canvas（前端不再直接持有 TCP 套接字）

### 9.2 RFB 握手与认证 ✅
- 安全类型：VNC password、RealVNC RA2 / RA2ne（128 / 256 位 AES）；None 默认拒绝，仅 `allow-none` 显式策略允许
- RA2 子模式：USER_PASS、PASS-only；公钥位长度合法性校验（1024–8192 bit）
- 安全类型按强度选择，连接状态展示实际 RFB 版本、认证类型与传输是否加密

### 9.3 编码与画面 ✅
- 解码器：Raw（0）、CopyRect（1）、Hextile（5）、ZRLE（16，单一持久 zlib 流）
- 伪编码：DesktopSize（-223），后端通过带 frame id 的 resize 消息原子同步前端；未声明支持 client SetDesktopSize
- ZRLE 单 zlib 状态贯穿整个 session，已修复历史的 "zrle: eof cpixel" 间歇性断连
- 像素格式 `set_pixel_format_rgba()` 协商成 little-endian RGBA，前端按位图直接渲染
- Tight 编码暂未启用（解码器尚未 RFC-conformant，避免 stream 失步）
- FramebufferUpdate 以逻辑帧批处理，rendered ACK 在 Canvas 实际绘制后发送；慢消费者只保留最新帧，丢帧后请求全量恢复

### 9.4 ExtendedClipboard 互通 ✅
- 实现 ExtendedClipboard 伪编码（`0xC0A1E5CE` + 旧 draft 值 `-1063` 双广告兼容）
- 支持 actions：caps / request / peek / notify / provide
- 支持 formats：text (UTF-8)、HTML、RTF（zlib 压缩）
- 老服务器（vino 等）回落 legacy `ServerCutText / ClientCutText` 路径，并已修复中文剪贴板丢失 / Windows 11 端到端粘贴乱码 / 非 ASCII 粘贴丢失等回归
- 前端 ↔ 后端剪贴板桥：四向策略、单格式大小上限和 HTML/RTF 显式开关均由 relay 强制执行

### 9.5 输入处理 ✅
- 鼠标：左/中/右键、滚轮、拖拽（pointer capture）
- 键盘：左右修饰键、AltGr、数字键盘、锁定键、F1-F24、失焦全释放；view-only 前后端双重阻止输入
- 剪贴板：disabled / 单向 / 双向同步，自动切换 Extended / Legacy

### 9.6 前端 `VncPanel` ✅

<!-- feature
id: F9.6
status: done
area: vnc
components: [VncPanel, FloatingToolbar, CaptureToolbar]
files:
  - src/components/vnc/VncPanel.tsx
  - src/components/session/SessionEditor.tsx
controls:
  - id: panel-root
    selector: '[data-testid="vnc-panel"]'
    kind: display
  - id: canvas
    selector: '[data-testid="vnc-canvas"]'
    kind: display       # pointer / wheel / context-menu handlers fire only after a live RFB session;
                        # without a configured VNC fixture we can only verify the canvas is attached.
                        # Driving it is left to feature-flagged conformance tests.
  - id: floating-toolbar
    selector: '[data-testid="vnc-floating-toolbar"]'
    kind: display
    optional: true          # only renders when canvas is showing (connected)
  - id: scale-toggle
    selector: '[data-testid="vnc-scale-toggle"]'
    kind: interactive
    optional: true          # inside the floating toolbar
  - id: reconnect
    selector: '[data-testid="vnc-reconnect"]'
    kind: interactive
    optional: true          # only on disconnected/error state
  - id: security-status
    selector: '[data-testid="vnc-connection-security"]'
    kind: display
    optional: true
  - id: client-options
    selector: '[data-testid="vnc-client-options"]'
    kind: display
  - id: security-policy
    selector: '[data-testid="vnc-security-policy"]'
    kind: interactive
  - id: clipboard-policy
    selector: '[data-testid="vnc-clipboard-policy"]'
    kind: interactive
  - id: shared
    selector: '[data-testid="vnc-shared"]'
    kind: interactive
  - id: view-only
    selector: '[data-testid="vnc-view-only"]'
    kind: interactive
  - id: clipboard-html
    selector: '[data-testid="vnc-clipboard-html"]'
    kind: interactive
  - id: clipboard-rtf
    selector: '[data-testid="vnc-clipboard-rtf"]'
    kind: interactive
  - id: auto-reconnect
    selector: '[data-testid="vnc-auto-reconnect"]'
    kind: interactive
  - id: reconnect-attempts
    selector: '[data-testid="vnc-reconnect-attempts"]'
    kind: interactive
  - id: clipboard-limit
    selector: '[data-testid="vnc-clipboard-limit"]'
    kind: interactive
-->

- Canvas 画面渲染 + fit / 1:1 缩放
- 浮动 `FloatingToolbar`：可拖拽 / 折叠 / 位置持久化
- 内嵌 `CaptureToolbar`：可见区域 PNG / 全帧 PNG / GIF 录制（与终端共用截图链路）
- 断开提示 + Reconnect、错误分类（区分用户主动断开 / 服务端断开 / 网络异常）
- 保存的 VNC 会话可从会话树双击连接，密码场景复用 `AuthPrompt`
- `vnc://` QuickConnect 与保存会话共用 VNC panel、认证和网络链路
- VNC tab 常驻挂载，切换标签时连接不主动销毁
- 可配置 security/shared/view-only/clipboard/HTML/RTF/大小限制/有限自动重连；旧连接回调不能覆盖重连后的新会话状态
- detach 仅持久化 256-bit 内存 capability，不把 VNC password 或 vault ref 写入 localStorage
- TC-117 提供 Linux WebKitGTK/Tauri debug bundle 启动截图 smoke；真实 RFB pixels/input/clipboard 仍由 native fixture 与人工矩阵验证

### 9.7 RDP client（IronRDP 0.17）🟡

<!-- feature
id: F9.7
status: partial
area: rdp
components: [RdpPanel, RdpOptionsForm]
files:
  - src/components/rdp/RdpPanel.tsx
  - src/components/session/forms/RdpOptionsForm.tsx
  - src/lib/rdp.ts
  - src/types/rdp.ts
  - src-tauri/src/rdp/mod.rs
  - src-tauri/src/rdp/ws.rs
  - src-tauri/src/rdp/session.rs
  - src-tauri/src/rdp/transport.rs
  - src-tauri/src/rdp/gateway/mod.rs
controls:
  - id: panel-root
    selector: '[data-testid="rdp-panel"]'
    kind: display
  - id: status
    selector: '[data-testid="rdp-status"]'
    kind: display
  - id: canvas
    selector: '[data-testid="rdp-canvas"]'
    kind: display       # browser-mode smoke verifies mount; live frame paint is covered by Rust live tests
  - id: scale-toggle
    selector: '[data-testid="rdp-scale-toggle"]'
    kind: interactive
  - id: reconnect
    selector: '[data-testid="rdp-reconnect"]'
    kind: interactive
  - id: chat-toggle
    selector: '[data-testid="rdp-chat-toggle"]'
    kind: interactive
    optional: true
  - id: detach
    selector: '[data-testid="rdp-detach"]'
    kind: interactive
  - id: view-cycle
    selector: '[data-testid="rdp-view-cycle"]'
    kind: interactive       # one button cycles normal → maximized → fullscreen
-->

- Tauri desktop 模式下通过 IronRDP 0.17 驱动真实 RDP 会话：CredSSP/NLA、active-stage 图像解码、键盘/鼠标/滚轮输入、画布绘制
- 传输路径支持 direct TCP、HTTP/SOCKS5 proxy，以及 RD Gateway（MS-TSGU）代码路径；RD Gateway 当前无真实环境，只以 unit test + ignored live smoke 作为验收
- RDP tab 常驻挂载，保存会话和 `rdp://` QuickConnect 均能打开 RDP panel；密码场景复用 `AuthPrompt`
- resize 优先使用 DisplayControl DVC；服务器不开放该通道时保持同一 WS/control session 并按新桌面尺寸重连
- RDP options 表单已持久化 domain、color depth、NLA/performance、clipboard、audio、drive redirection、RD Gateway 配置
- 浏览器预览模式只提供 desktop-only stub；真实协议连接和画面验证必须在 Tauri/native 或 Rust live test 环境下执行

### 9.8 WSL 会话类型（WSL session）✅

<!-- feature
id: F9.8
status: done
area: terminal/wsl
components: [WslOptionsForm, SessionEditor, WelcomePanel]
files:
  - src/components/session/forms/WslOptionsForm.tsx
  - src/types/wsl.ts
controls:
  # proto-wsl chip lives in SessionEditor (owned by F6.3). This feature owns
  # the WSL options form body + the Welcome quick-launch card.
  - id: distro-select
    selector: '[data-testid="wsl-distro"]'
    kind: interactive
    optional: true       # only when distro detection succeeds (status=ready, Windows)
  - id: distro-text
    selector: '[data-testid="wsl-distro-text"]'
    kind: interactive
    optional: true       # free-text fallback when detection unavailable (non-Windows / unsupported)
  - id: status-unsupported
    selector: '[data-testid="wsl-status-unsupported"]'
    kind: display
    optional: true       # only on non-Windows / unsupported runners
  - id: user
    selector: '[data-testid="wsl-user"]'
    kind: interactive
  - id: cwd
    selector: '[data-testid="wsl-cwd"]'
    kind: interactive
  - id: initial-cmd
    selector: '[data-testid="wsl-initial-cmd"]'
    kind: interactive
  - id: admin
    selector: '[data-testid="wsl-admin"]'
    kind: interactive
  - id: argv-preview
    selector: '[data-testid="wsl-argv-preview"]'
    kind: display
  # Welcome panel quick-launch card (only on Windows with detected distros)
  - id: welcome-wsl-card
    selector: '[data-testid="welcome-wsl-card"]'
    kind: display
    optional: true       # Windows-only — hidden on non-Windows runners
  - id: welcome-wsl-distro
    selector: '[data-testid="welcome-wsl-distro"]'
    kind: interactive
    optional: true
  - id: welcome-wsl-open
    selector: '[data-testid="welcome-wsl-open"]'
    kind: interactive
    optional: true
-->

- 会话编辑器协议选择新增 `WSL`，选中后挂载 `WslOptionsForm`：发行版（检测成功用下拉，否则自由文本）、登录用户、起始目录（带 Browse）、初始命令、以管理员身份运行
- 实时 `wsl.exe …` argv 预览（`wsl-argv-preview`），随表单字段变化更新
- 发行版探测（`list_wsl_distros`）仅在 Windows 可用；非 Windows / 探测失败回落到自由文本输入并显示 `wsl-status-unsupported` 提示
- `WslOptions` 经 `SessionEditor.buildConfig` 归一化为 `localShellPath=wsl.exe` + `localShellArgs`，复用既有本地终端启动管线；保存的 WSL 会话往返保持 `proto=WSL`（`sessionTypeToProto` 修复）
- Welcome 页在检测到发行版时显示 `welcome-wsl-card` 快速启动入口（选发行版 + 一键打开）
- **e2e 测试限制**：浏览器预览模式无法 spawn `wsl.exe`，且发行版探测受 Windows 门控，TC-112 仅验证表单挂载 / 自由文本回落 / 保存往返，真实启动需 Windows 手动回归

### 9.9 已知限制
- 浏览器预览模式没有 VNC stub（仅 Tauri 桌面下可用）
- 当前不支持 VeNCrypt/TLS、Tight/JPEG、client SetDesktopSize；传统 VNCAuth 仅应在可信网络或 SSH tunnel 中使用

---

## 10. 截图 / 录屏 / 浮动工具条（共享基础设施）

### 10.1 `FloatingToolbar` ✅
- 任意 tab 内嵌的浮动浮窗：可拖拽、可折叠、最小化为 pill
- 位置 / 折叠状态按 `storageKey` 持久化到 `localStorage`
- 终端、VNC、SFTP 等多个面板共用

### 10.2 `CaptureToolbar` ✅
- 三类操作：可见区域 PNG、滚动 / 全帧 PNG、GIF 录制
- 输出路由：保存到磁盘（`saveBlobToFile` 走原生保存对话框）/ 复制到剪贴板（`ClipboardItem`）
- `startScrollCapture`：滚动区域逐帧拼接为长图（终端 scrollback / VNC 画面）
- `createGifRecorder`：基于 `gifenc` 的 GIF 实时编码，工具条显示录制时长 + Stop
- 文件名前缀按上下文 + 时间戳生成（`safeFilePart` / `timestampFilePart`）

### 10.3 文件 IO 流式 IPC ✅
- Tauri 命令对：`read_stream_open / read_stream_read / read_stream_close` 与 `write_stream_open / write_stream_append / write_stream_close / write_stream_abort`
- 用于 zmodem / 大文件 / GIF 等场景，避免一次性把整个文件塞进单次 IPC body
- `read_file_bytes` 用 `tauri::ipc::Response::new(bytes)` 返回原始二进制，跳过 base64
- 配合 `clipboard_read_text / clipboard_write_text`、`check_file_exists`、`select_save_directory / select_save_file_path / select_upload_file / select_private_key_file` 等原生对话框命令

### 10.4 命令历史持久化 ✅
- SQLite 表 `command_history`（host_key + command 唯一）+ `last_used_at` / `use_count`
- Tauri 命令：`history_append / history_match_prefix / history_list_recent / history_clear`
- 写入按 host 上限自动 LRU 裁剪
- 复用于终端 inline ghost-text 自动补全 + Common commands 调色板

---

## 11. 应用全局设置 `SettingsPanel` ✅

<!-- feature
id: F11.1
status: done
area: settings
components: [SettingsPanel, SqlCompletionSettings]
files:
  - src/components/settings/SettingsPanel.tsx
  - src/components/settings/SqlCompletionSettings.tsx
  - src/components/settings/settingsSearch.ts
  - src/lib/sqlCompletionPreferences.ts
controls:
  - id: panel-root
    selector: '[data-testid="settings-panel"]'
    kind: display
  - id: welcome-recent-session-limit
    selector: '[data-testid="settings-welcome-recent-session-limit"]'
    kind: interactive
  - id: search-input
    selector: '[data-testid="settings-search-input"]'
    kind: interactive
  - id: search-count
    selector: '[data-testid="settings-search-count"]'
    kind: display
  - id: search-empty
    selector: '[data-testid="settings-search-empty"]'
    kind: display
  - id: reset-code-view-profile
    selector: '[data-testid="settings-reset-code-view-profile"]'
    kind: interactive
  - id: reset-terminal-default-profile
    selector: '[data-testid="settings-reset-terminal-default-profile"]'
    kind: interactive
  - id: sql-completion-settings
    selector: '[data-testid="sql-completion-settings"]'
    kind: display
  - id: sql-completion-activate-on-typing
    selector: '[data-testid="sql-completion-activate-on-typing"]'
    kind: interactive
  - id: sql-completion-trigger-shortcut
    selector: '[data-testid="sql-completion-trigger-shortcut"]'
    kind: interactive
  - id: sql-completion-shortcut-error
    selector: '[data-testid="sql-completion-shortcut-error"]'
    kind: display
    optional: true       # only after an invalid or conflicting shortcut is pressed
  - id: sql-completion-accept-tab
    selector: '[data-testid="sql-completion-accept-tab"]'
    kind: interactive
  - id: sql-completion-accept-enter
    selector: '[data-testid="sql-completion-accept-enter"]'
    kind: interactive
  - id: sql-completion-reset
    selector: '[data-testid="sql-completion-reset"]'
    kind: interactive
-->

- Application Theme 切换（Light / Dark / Follow system）
- Welcome 最近会话历史数量设置（默认 20）
- Database / SQL Editor 设置支持输入时补全开关、可录制的触发快捷键、Tab/Enter 接受方式与冲突提示；设置通过 localStorage 在主窗口和分离窗口间同步
- 设置项即时持久化

### 11.2 多版本 SDK 与工作区工具链 ✅

<!-- feature
id: F11.2
status: done
area: settings/code-workspace
components: [SdkSettings, WorkspaceSdkStatus]
files:
  - src/components/settings/SdkSettings.tsx
  - src/components/editor/workspace/WorkspaceSdkStatus.tsx
  - src/lib/editor/sdk.ts
  - src-tauri/src/sdk/
controls:
  # Global SDK manager (always present in Settings -> Code)
  - id: sdk-settings
    selector: '[data-testid="sdk-settings"]'
    kind: display
  - id: sdk-discover
    selector: '[data-testid="sdk-discover"]'
    kind: interactive
  - id: sdk-add
    selector: '[data-testid="sdk-add"]'
    kind: interactive
  - id: sdk-refresh-all
    selector: '[data-testid="sdk-refresh-all"]'
    kind: interactive
  - id: sdk-kind-java
    selector: '[data-testid="sdk-kind-java"]'
    kind: display
  - id: sdk-kind-kotlin
    selector: '[data-testid="sdk-kind-kotlin"]'
    kind: display
  - id: sdk-kind-scala
    selector: '[data-testid="sdk-kind-scala"]'
    kind: display
  - id: sdk-kind-python
    selector: '[data-testid="sdk-kind-python"]'
    kind: display
  - id: sdk-default-java
    selector: '[data-testid="sdk-default-java"]'
    kind: interactive
    optional: true
  - id: sdk-default-kotlin
    selector: '[data-testid="sdk-default-kotlin"]'
    kind: interactive
  - id: sdk-default-scala
    selector: '[data-testid="sdk-default-scala"]'
    kind: interactive
    optional: true
  - id: sdk-default-python
    selector: '[data-testid="sdk-default-python"]'
    kind: interactive
    optional: true
  - id: sdk-add-kind
    selector: '[data-testid^="sdk-add-"]'
    kind: interactive
    optional: true
  - id: sdk-settings-error
    selector: '[data-testid="sdk-settings-error"]'
    kind: display
    optional: true
  # Add/edit and discovery states are conditional.
  - id: sdk-editor
    selector: '[data-testid="sdk-editor"]'
    kind: display
    optional: true
  - id: sdk-editor-kind
    selector: '[data-testid="sdk-editor-kind"]'
    kind: interactive
    optional: true
  - id: sdk-editor-name
    selector: '[data-testid="sdk-editor-name"]'
    kind: interactive
    optional: true
  - id: sdk-editor-location
    selector: '[data-testid="sdk-editor-location"]'
    kind: interactive
    optional: true
  - id: sdk-editor-browse
    selector: '[data-testid="sdk-editor-browse"]'
    kind: interactive
    optional: true
  - id: sdk-editor-probe
    selector: '[data-testid="sdk-editor-probe"]'
    kind: display
    optional: true
  - id: sdk-editor-probe-button
    selector: '[data-testid="sdk-editor-probe-button"]'
    kind: interactive
    optional: true
  - id: sdk-editor-save
    selector: '[data-testid="sdk-editor-save"]'
    kind: interactive
    optional: true
  - id: sdk-discovery-results
    selector: '[data-testid="sdk-discovery-results"]'
    kind: display
    optional: true
  - id: sdk-discovery-add-all
    selector: '[data-testid="sdk-discovery-add-all"]'
    kind: interactive
    optional: true
  - id: sdk-discovery-add
    selector: '[data-testid="sdk-discovery-add"]'
    kind: interactive
    optional: true
  - id: sdk-discovery-close
    selector: '[data-testid="sdk-discovery-close"]'
    kind: interactive
    optional: true
  - id: sdk-installation-row
    selector: '[data-testid^="sdk-row-"]'
    kind: display
    optional: true
  - id: sdk-installation-refresh
    selector: '[data-testid="sdk-installation-refresh"]'
    kind: interactive
    optional: true
  - id: sdk-installation-edit
    selector: '[data-testid="sdk-installation-edit"]'
    kind: interactive
    optional: true
  - id: sdk-installation-remove
    selector: '[data-testid="sdk-installation-remove"]'
    kind: interactive
    optional: true
  # Code Workspace status and per-project bindings are present only in a workspace tab.
  - id: workspace-sdk-status
    selector: '[data-testid="code-workspace-sdk-status"]'
    kind: interactive
    optional: true
  - id: workspace-sdk-dialog
    selector: '[data-testid="workspace-sdk-dialog"]'
    kind: display
    optional: true
  - id: workspace-sdk-refresh
    selector: '[data-testid="workspace-sdk-refresh"]'
    kind: interactive
    optional: true
  - id: workspace-sdk-open-settings
    selector: '[data-testid="workspace-sdk-open-settings"]'
    kind: interactive
    optional: true
  - id: workspace-sdk-close
    selector: '[data-testid="workspace-sdk-close"]'
    kind: interactive
    optional: true
  - id: workspace-sdk-error
    selector: '[data-testid="workspace-sdk-error"]'
    kind: display
    optional: true
  - id: workspace-sdk-root
    selector: '[data-testid^="workspace-sdk-root-"]'
    kind: display
    optional: true
  - id: workspace-kotlin-profile
    selector: '[data-testid^="workspace-kotlin-profile-"]'
    kind: display
    optional: true
  - id: workspace-sdk-binding
    selector: '[data-testid^="workspace-sdk-binding-"]'
    kind: interactive
    optional: true
-->

- 全局 SDK 管理支持登记、探测、自动发现、刷新和移除多个 Java/JDK、Kotlin、Scala 与 Python 安装，并为每类工具链设置兼容默认项。
- 工作区扫描 Maven、Gradle、sbt、pyproject、版本管理器及独立源码配置，按嵌套项目作用域解析版本要求、配置证据和有效 SDK；用户可在工作区状态面板中覆盖或恢复自动匹配。
- Kotlin 项目配置独立展示平台、构建托管/独立编译器模式、编译器版本、language/apiVersion、JVM target、Java toolchain 与 Gradle launcher JDK；Gradle/Maven 管理的 Kotlin 编译器不会误要求本机 `kotlinc`。
- 项目 JDK、构建 launcher JDK、JDT LS 工具 JDK（JDK 21+）相互独立。解析结果统一注入语言服务器、本地终端与 Run Tasks，SDK 绑定变化会重启已打开的 LSP 会话。

---

## 12. 凭证保险库（Credential Vault）

### 12.1 保险库管理 `VaultSettings` ✅

<!-- feature
id: F12.1
status: done
area: vault
components: [VaultSettings, VaultSetupDialog, VaultUnlockDialog, StartupVaultUnlockGate]
files:
  - src/components/vault/VaultSettings.tsx
  - src/components/vault/VaultSetupDialog.tsx
  - src/components/vault/VaultUnlockDialog.tsx
  - src/components/vault/StartupVaultUnlockGate.tsx
  - src/stores/vaultStore.ts
  - src-tauri/src/vault/
controls:
  - id: settings-root
    selector: '[data-testid="vault-settings"]'
    kind: display
  - id: state-badge
    selector: '[data-testid="vault-state-badge"]'
    kind: display
  - id: unlock-mode-setting
    selector: '[data-testid="vault-unlock-mode-setting"]'
    kind: display
  - id: unlock-mode-startup
    selector: '[data-testid="vault-unlock-mode-startup"]'
    kind: interactive
  - id: unlock-mode-on-demand
    selector: '[data-testid="vault-unlock-mode-on-demand"]'
    kind: interactive
  - id: unlock-mode-hint
    selector: '[data-testid="vault-unlock-mode-hint"]'
    kind: display
  - id: init-button
    selector: '[data-testid="vault-init-button"]'
    kind: interactive
    optional: true       # only when state=empty
  - id: unlock-button
    selector: '[data-testid="vault-unlock-button"]'
    kind: interactive
    optional: true       # only when state=locked
  - id: lock-button
    selector: '[data-testid="vault-lock-button"]'
    kind: interactive
    optional: true       # only when state=unlocked
  - id: change-master-button
    selector: '[data-testid="vault-change-master-button"]'
    kind: interactive
    optional: true       # only when state=unlocked
  - id: change-master-form
    selector: '[data-testid="vault-change-master-form"]'
    kind: display
    optional: true       # only when change-master action is active
  - id: change-master-old
    selector: '[data-testid="vault-change-master-old"]'
    kind: interactive
    optional: true
  - id: change-master-new1
    selector: '[data-testid="vault-change-master-new1"]'
    kind: interactive
    optional: true
  - id: change-master-new2
    selector: '[data-testid="vault-change-master-new2"]'
    kind: interactive
    optional: true
  - id: change-master-submit
    selector: '[data-testid="vault-change-master-submit"]'
    kind: interactive
    optional: true
  - id: entries-section
    selector: '[data-testid="vault-entries-section"]'
    kind: display
    optional: true       # only when state=unlocked
  # VaultSetupDialog
  - id: setup-dialog
    selector: '[data-testid="vault-setup-dialog"]'
    kind: display
    optional: true       # only when init action is active
  - id: setup-pw1
    selector: '[data-testid="vault-setup-pw1"]'
    kind: interactive
    optional: true
  - id: setup-pw2
    selector: '[data-testid="vault-setup-pw2"]'
    kind: interactive
    optional: true
  - id: setup-cancel
    selector: '[data-testid="vault-setup-cancel"]'
    kind: interactive
    optional: true
  - id: setup-confirm
    selector: '[data-testid="vault-setup-confirm"]'
    kind: interactive
    optional: true
  - id: setup-too-short
    selector: '[data-testid="vault-setup-too-short"]'
    kind: display
    optional: true       # only when pw1 is 1-7 chars
  - id: setup-mismatch
    selector: '[data-testid="vault-setup-mismatch"]'
    kind: display
    optional: true       # only when pw2 differs from pw1
  - id: setup-error
    selector: '[data-testid="vault-setup-error"]'
    kind: display
    optional: true       # only on submit error
  # VaultUnlockDialog
  - id: unlock-dialog
    selector: '[data-testid="vault-unlock-dialog"]'
    kind: display
    optional: true       # only when unlock action is active
  - id: unlock-pw
    selector: '[data-testid="vault-unlock-pw"]'
    kind: interactive
    optional: true
  - id: unlock-reason
    selector: '[data-testid="vault-unlock-reason"]'
    kind: display
    optional: true       # only when reason prop is provided
  - id: unlock-cancel
    selector: '[data-testid="vault-unlock-cancel"]'
    kind: interactive
    optional: true
  - id: unlock-confirm
    selector: '[data-testid="vault-unlock-confirm"]'
    kind: interactive
    optional: true
  - id: unlock-error
    selector: '[data-testid="vault-unlock-error"]'
    kind: display
    optional: true       # only on wrong password
-->

- AES-256-GCM 加密存储，密钥由 Argon2id 从主密码派生
- 三态生命周期：empty（未初始化）→ locked（已设置但未解锁）→ unlocked（可读写）
- **初始化**：VaultSetupDialog 设置主密码（≥8 字符，二次确认）
- **解锁**：VaultUnlockDialog 输入主密码解锁，错误密码提示
- **锁定**：一键锁定，从内存中清除密钥
- **修改主密码**：输入旧密码 + 新密码（≥8 字符，二次确认）
- **条目管理**：解锁后展示已保存条目列表，支持删除
- **解锁提示时机**：Settings 中可选择启动时解锁（默认）或按需解锁
- 会话编辑器 / 隧道编辑器中 "Save in vault" 复选框将密码加密存入保险库
- 打开已保存密码的会话时自动触发解锁流程

---

## 13. 自动化测试基线

### 13.1 单元测试（Vitest）✅
- 测试文件 17 个，覆盖：
  - `ChmodDialog`、`FileToolbarWiring`、`SftpPolish`
  - `SessionEditor`
  - `AppThemeSwitcher`、`SettingsPanel`、`TerminalAppearanceSettings`
  - `MainLayout`
  - `CommonCommandsPalette`、`TerminalPanel`
  - `clipboard`、`zmodem`、`terminalOutputFilter`、`terminalImeGuard`、`sessionImportExport`
  - `VaultSetupDialog`、`VaultUnlockDialog`
  - `appStore`（含 moveTab / updateTabTitle）

### 13.2 Rust 测试 ✅
- `appearance::lists_installed_font_families` 验证 OS 字体枚举
- VNC `encodings` 模块单元测试（Hextile / ZRLE 解码、跨 rectangle 共享 zlib 状态）
- VNC `clipboard` 模块单元测试（Extended caps body 编/解码）
- Vault `crypto` + `db` 模块单元测试（加密/解密、条目 CRUD、主密码变更）
- `cargo check` 通过

### 13.3 端到端测试用例（`qa-ui-auto-tests/cases/*.testcase.yaml`，被 `qa-ui-auto` 消费）✅ 109 条
- 覆盖 TC-001 ～ TC-113 + TC-AI-* + TC-auto-*：主界面、设置、会话编辑器、SSH/SFTP/QuickConnect 全流程、终端右键菜单与快捷键、SFTP 多种交互（chmod / rename / 拖拽 / 多选 / 双击下载 / 列宽 / 创建文件夹）、独立 SFTP 标签、open-terminal-here、会话树搜索 / 复制 / 拖拽、标签栏右键与移动动作、应用主题循环、隧道编辑器与重排 / 活动日志、终端字体连字 / 字体搜索 / 语法高亮、本地管理员启动、tab 中键关闭、tab split-button 快速启动菜单、会话 import/export 多格式、OpenSSH config 导入、Welcome active connections、custom title bar、compact mode、MultiExec、command palette、capture toolbar、zmodem 冲突、VNC scaffold、RDP scaffold、WSL session、标签 detach/reattach、SSH MFA scaffold、Vault、i18n 等
- v0.1.33→v0.1.36 新增/补充：F9.8 WSL 会话表单（TC-112）、F9.7 RDP detach（TC-111）、F-Detach-1 通用标签分离（TC-auto-F-Detach-1）、F-Mfa-1 键盘交互式 MFA（TC-113，scaffolding-only）、F1.5 split-button 快速启动（TC-auto-F1-5-tab-launch-menu）、F8.2 隧道活动日志（TC-auto-F8-2-tunnel-activity-log）

### 13.4 部署 ✅
- Replit 上验证通过：Tauri 桌面构建（`pnpm tauri build --debug --no-bundle`）通过 VNC 查看；Web 模式作为静态站点构建到 `dist/`
- GitHub Actions：`release.yml` 推送 `v<version>` tag 触发跨平台打包

---

## 14. AI 子系统

### 14.1 AI 总开关与隐私 ✅

<!-- feature
id: F-AI-2.1
status: done
area: ai/settings
components: [AiMasterSwitch, PrivacyToggle, SettingsPanel]
files:
  - src/components/settings/AiMasterSwitch.tsx
  - src/components/settings/PrivacyToggle.tsx
  - src/components/settings/SettingsPanel.tsx
  - src/stores/aiStore.ts
controls:
  - id: ai-master-toggle
    selector: 'text="Disable AI completely"'
    kind: interactive
  - id: privacy-fully-local
    selector: 'text="Full local mode"'
    kind: interactive
    optional: true       # only shown when AI master is enabled
-->

- `AiMasterSwitch`：一键关闭所有 AI 入口（Drawer 按钮、PTT、命令重写等），内存占用与网络调用全部归零
- `PrivacyToggle`：保持 AI 启用，但强制把请求路由到 loopback / 本地 provider
- 状态由 `aiStore.config.fully_disabled` 持久化；勾选后标题栏 `ptt-button` 与 Chat Tao ribbon / drawer 入口立即从 DOM 中移除

### 14.2 终端补全与命令重写 ✅

<!-- feature
id: F-AI-2.2
status: done
area: ai/terminal
components: [TerminalAppearanceSettings, AiRewriteOverlay]
files:
  - src/components/terminal/TerminalAppearanceSettings.tsx
  - src/components/terminal/AiRewriteOverlay.tsx
controls:
  - id: inline-suggestions-history
    selector: 'input[name="inlineSuggestionsSource"][value="history"]'
    kind: interactive
  - id: inline-suggestions-history-path
    selector: 'input[name="inlineSuggestionsSource"][value="history+path"]'
    kind: interactive
  - id: inline-suggestions-history-path-ai
    selector: 'input[name="inlineSuggestionsSource"][value="history+path+ai"]'
    kind: interactive
  - id: ai-command-rewrite-shortcut
    selector: 'input[aria-label="AI command rewrite shortcut"]'
    kind: interactive
-->

- 三档 inline 候选源切换（History / +PATH / +PATH+AI）持久化至 `terminalProfile`
- `Enable AI command rewrite (Ctrl+K)` 开关 + 自定义快捷键输入框
- 选择 `+ai` 时按需下载 FIM 模型（约 400 MB）；本地 PowerShell 终端忽略此功能避免与 PSReadLine 冲突

### 14.3 PTT 语音录制按钮 ✅

<!-- feature
id: F-AI-2.3
status: done
area: ai/voice
components: [PttButton, AsrPanel, TitleBarTrayControls]
files:
  - src/components/window/PttButton.tsx
  - src/components/settings/AsrPanel.tsx
  - src-tauri/src/voice/
controls:
  - id: ptt-button
    selector: '[data-testid="ptt-button"]'
    kind: interactive
    optional: true       # hidden when AI master switch is on (fully_disabled)
-->

- 标题栏托盘内的麦克风按钮：按下开始录音、释放停止 + 转写
- 探测 `voice_capture_supported` 失败时按钮置灰并显示 `MicOff` 图标（`data-state="unsupported"`）
- 转写结果通过 `chatStore.attachToComposer(text)` 暂存到当前可聊天 tab 的 Chat 输入框，便于检视后再发送
- AI 全局禁用 (`fully_disabled`) 时整个按钮被卸载

### 14.4 AI Chat Drawer ✅

<!-- feature
id: F-AI-2.4
status: done
area: ai/chat
components: [ChatDrawer, ChatThreadList, Composer, AttachmentChip, MessageBubble, SearchProgressChip, CodeBlockToolbar, CcAgentBridge]
files:
  - src/components/chat/ChatDrawer.tsx
  - src/components/chat/ChatThreadList.tsx
  - src/components/chat/Composer.tsx
  - src/components/chat/AttachmentChip.tsx
  - src/components/chat/MessageBubble.tsx
  - src/components/chat/SearchProgressChip.tsx
  - src/components/chat/CodeBlockToolbar.tsx
  - src/components/agent/CcAgentBridge.tsx
  - src/lib/chat/attachments.ts
  - src/lib/chat/composerRefs.ts
  - src/lib/chat/renderFormatted.ts
  - src/stores/chatStore.ts
controls:
  - id: ai-chat-drawer
    selector: '[data-testid="ai-chat-drawer"]'
    kind: display
    optional: true       # only mounted when drawerOpen
  - id: ai-chat-drawer-textarea
    selector: '[data-testid="ai-chat-drawer"] textarea'
    kind: interactive
    optional: true
  - id: ai-chat-composer
    selector: '[data-testid="ai-chat-composer"]'
    kind: interactive
    optional: true
  - id: ai-chat-attach-button
    selector: '[data-testid="ai-chat-attach-button"]'
    kind: interactive
    optional: true
  - id: ai-chat-composer-resize
    selector: '[data-testid="ai-chat-composer-resize"]'
    kind: interactive
    optional: true
  - id: ai-chat-attachment-error
    selector: '[data-testid="ai-chat-attachment-error"]'
    kind: display
    optional: true
  - id: ai-chat-new
    selector: 'button[title="New chat"]'
    kind: interactive
    optional: true
  - id: ai-chat-history
    selector: 'button[title="History"]'
    kind: interactive
    optional: true
  - id: ai-chat-copy-all
    selector: 'button[aria-label="Copy entire conversation"]'
    kind: interactive
    optional: true
  - id: ai-chat-close
    selector: '[data-testid="ai-chat-drawer-hide"]'
    kind: interactive
    optional: true
  - id: ai-chat-drawer-ribbon
    selector: '[data-testid="ai-chat-drawer-ribbon"]'
    kind: interactive
    optional: true       # shown when a chat-capable active tab has drawer hidden
  - id: ai-chat-drawer-position
    selector: '[data-testid="ai-chat-drawer-position"]'
    kind: interactive
    optional: true
  - id: ai-chat-drawer-pin
    selector: '[data-testid="ai-chat-drawer-pin"]'
    kind: interactive
    optional: true
  - id: ai-chat-drawer-opacity
    selector: '[data-testid="ai-chat-drawer-opacity"]'
    kind: interactive
    optional: true       # only top/bottom floating drawer
  - id: ai-chat-drawer-opacity-menu
    selector: '[data-testid="ai-chat-drawer-opacity-menu"]'
    kind: display
    optional: true       # only while opacity popover is open
  - id: ai-chat-drawer-opacity-slider
    selector: '[data-testid="ai-chat-drawer-opacity-slider"]'
    kind: interactive
    optional: true       # only while opacity popover is open
  - id: ai-chat-safety-gate
    selector: '[data-testid="ai-chat-safety-gate"]'
    kind: display
    optional: true       # only while a local-agent permission prompt is pending
  - id: ai-chat-acp-permission-card
    selector: '[data-testid="ai-chat-acp-permission-card"]'
    kind: display
    optional: true       # only while an ACP agent requests a native-tool permission
  - id: ai-chat-acp-permission-cancel
    selector: '[data-testid="ai-chat-acp-permission-cancel"]'
    kind: interactive
    optional: true       # only while an ACP native-tool permission is pending
  - id: ai-chat-provider-select
    selector: 'select[aria-label="Thread LLM provider"]'
    kind: interactive
    optional: true       # rendered only when an active thread + at least one provider configured
  - id: ai-chat-mode-image
    selector: '[data-testid="chat-mode-image"]'
    kind: interactive
    optional: true       # disabled when no image-capable provider is configured
  - id: ai-chat-mode-video
    selector: '[data-testid="chat-mode-video"]'
    kind: interactive
    optional: true       # disabled when no video-capable provider is configured
  - id: ai-chat-output-format
    selector: 'select[aria-label="Thread output format"]'
    kind: interactive
    optional: true       # locked into a span once the thread has any messages
  - id: ai-chat-format-cycle
    selector: 'button[aria-label="Convert visible transcript to another format"]'
    kind: interactive
    optional: true
  - id: attachment-chip
    selector: '[data-testid="attachment-chip"]'
    kind: display
    optional: true       # only when composer text contains a parseable @ref
-->

- 全局唯一抽屉（每窗口一个），由 `chatStore.drawerOpen` + `drawerScope/tabId` + `drawerPosition` 控制状态机；线程始终绑定到 tab
- **打开方式**：Welcome 的 `Chat Tao` 卡片、当前 tab 的 `tab-chat-toggle` / `Ctrl+Shift+L`、或隐藏态 `ai-chat-drawer-ribbon` 打开 tab-bound drawer
- **抽屉头部**：位置切换 / 固定切换 / 顶部或底部悬浮透明度 / 复制全部对话 / 新对话 / 历史对话 / 隐藏到 ribbon
- **Thread badge 区**：显示 thread 绑定的 tab (`Link2` 图标 + tab 标题)；Provider 选择器在配置了多 provider 时显示；output format 选择器在 thread 仍空时可改、有消息后锁定
- **Composer**：`Ctrl+Enter` 发送、附件按钮（paperclip）/ 拖拽文件到输入区 / 粘贴剪贴板图片添加本地附件，最多 10 个文件且总计最多 100 MiB；`@terminal:last-N` / `@file:./X` / `@session:Q` 解析为 `attachment-chip`，其中 `@file` 在发送前转为结构化文件附件
- **附件分发**：Claude Code / Codex 分支收到本地文件路径清单并按需读取；普通 LLM 分支不会收到本机路径，文本附件转为内容片段，图片附件转为多模态图片 block，其他二进制仅发送文件名/类型/大小摘要
- **Grok CLI 媒体模式**：启用内置 Grok ACP profile 后，它也会出现在图片和视频模式的 Provider 选择器；参考图片以本机 `file://` ACP `resource_link` 传给 CLI，生成文件会复制进 Taomni 管理的本地媒体目录
- **Composer resize**：输入框高度可通过 `ai-chat-composer-resize` 拖拽调整并持久化
- **Format cycling**：右上角按钮按 `md → html → plain` 循环显示格式
- **AI safety gate**：Claude Code / Codex 权限 prompt 的 `ActionCard` 优先附着到可见 `ai-chat-drawer` 右下角；点击 gate 不会触发悬浮抽屉自动隐藏
- 历史对话面板可删除 thread；删除当前 thread 时自动落到下一个或新建
- 左/右固定时抽屉与原 tab 并列并占用宽度；左/右悬浮以及上/下位置覆盖在 tab 上方；宽度/高度、位置、固定状态，以及顶部/底部悬浮透明度持久化

### 14.5 Web Search Provider 矩阵 ✅

<!-- feature
id: F-AI-2.5
status: done
area: ai/search
components: [WebSearchPanel, SearchProgressChip]
files:
  - src/components/settings/WebSearchPanel.tsx
  - src/components/chat/SearchProgressChip.tsx
controls:
  - id: web-search-section
    selector: 'text="Web Search"'
    kind: display
  - id: web-search-confirm-per-call
    selector: 'text="Confirm every time (default)"'
    kind: display
  - id: web-search-confirm-per-thread
    selector: 'text="Confirm once per thread"'
    kind: display
  - id: web-search-confirm-always
    selector: 'text="Always allow"'
    kind: display
  - id: web-search-confirm-disabled
    selector: 'text="Disabled"'
    kind: display
-->

- 设置面板列出至少 6 个搜索 provider：SearXNG / Tavily / Serper / Brave Search / Exa / Google CSE
- 每次调用前的确认模式四选一：每次确认 / 本 thread 静默 / 总是允许 / 完全禁用
- `SearchProgressChip` 在 Chat 中实时显示搜索进度并可取消

### 14.6 Claude Code & 模型分发设置 ✅

<!-- feature
id: F-AI-2.6
status: done
area: ai/models
components: [ClaudeCodePanel, ModelsAdvancedPanel, ChatHistoryPanel, ChatOutputFormatPanel]
files:
  - src/components/settings/ClaudeCodePanel.tsx
  - src/components/settings/ModelsAdvancedPanel.tsx
  - src/components/settings/ChatHistoryPanel.tsx
  - src/components/settings/ChatOutputFormatPanel.tsx
controls:
  - id: ai-settings-section
    selector: 'text="AI Settings"'
    kind: display
  - id: models-mirror-section
    selector: 'text="Model distribution & GPU acceleration"'
    kind: display
  - id: models-mirror-modelscope
    selector: 'text="ModelScope first"'
    kind: display
  - id: models-mirror-github
    selector: 'text="GitHub direct"'
    kind: display
  - id: models-mirror-ghproxy
    selector: 'text="gh-proxy"'
    kind: display
  - id: models-mirror-custom
    selector: 'text="Custom base URL"'
    kind: display
  - id: chat-history-section
    selector: 'text="Chat history management"'
    kind: display
  - id: chat-history-retention
    selector: 'input[aria-label="Chat history retention days"]'
    kind: interactive
  - id: chat-history-retention-label
    selector: 'text="Retention (days)"'
    kind: display
-->

- 模型分发镜像四选一：ModelScope 优先 / GitHub 直连 / gh-proxy 代理 / 自定义 base URL
- Claude Code 集成面板（账号、CLI 入口、会话引用）
- 对话历史保留天数滑动 + 一键清理（位于 `ChatHistoryPanel`）
- Thread 默认输出格式（`ChatOutputFormatPanel`）

### 14.7 通用 ACP Agent 与 Grok 预设 ✅

<!-- feature
id: F-AI-2.7
status: done
area: ai/agents
components: [AcpAgentsPanel, AcpProxyFields, ChatDrawer]
files:
  - src/components/settings/AcpAgentsPanel.tsx
  - src/components/settings/AcpProxyFields.tsx
  - src/components/chat/ChatDrawer.tsx
  - src/stores/aiStore.ts
  - src/stubs/tauri-core.ts
controls:
  - id: acp-settings
    selector: '[data-testid="acp-settings"]'
    kind: display
  - id: acp-bridge-enabled
    selector: '[data-testid="acp-bridge-enabled"]'
    kind: interactive
  - id: acp-global-proxy-direct
    selector: '[data-testid="acp-global-proxy-direct"]'
    kind: interactive
  - id: acp-global-proxy-app
    selector: '[data-testid="acp-global-proxy-app"]'
    kind: interactive
  - id: acp-request-timeout
    selector: '[data-testid="acp-request-timeout"]'
    kind: interactive
  - id: acp-add-profile
    selector: '[data-testid="acp-add-profile"]'
    kind: interactive
    optional: true
  - id: acp-save
    selector: '[data-testid="acp-save"]'
    kind: interactive
  - id: acp-restore-grok
    selector: '[data-testid="acp-restore-grok"]'
    kind: interactive
    optional: true
  - id: acp-profile-grok
    selector: '[data-testid="acp-profile-grok"]'
    kind: display
  - id: acp-profile-grok-enabled
    selector: '[data-testid="acp-profile-grok-enabled"]'
    kind: interactive
  - id: acp-profile-grok-preferred
    selector: '[data-testid="acp-profile-grok-preferred"]'
    kind: interactive
    optional: true
  - id: acp-profile-grok-command
    selector: '[data-testid="acp-profile-grok-command"]'
    kind: interactive
    optional: true
  - id: acp-profile-grok-args
    selector: '[data-testid="acp-profile-grok-args"]'
    kind: interactive
    optional: true
  - id: acp-profile-grok-probe
    selector: '[data-testid="acp-profile-grok-probe"]'
    kind: interactive
    optional: true
  - id: acp-profile-grok-probe-result
    selector: '[data-testid="acp-profile-grok-probe-result"]'
    kind: display
    optional: true
-->

- 通过通用 ACP v1 stdio profile 接入本机 Agent；Chat Provider ID 使用 `acp:<profile-id>`
- 内置、默认关闭的 Grok profile 使用 `grok agent stdio`，鉴权归本机 CLI 所有，不创建 xAI API Provider
- 内置 Grok profile 声明图片和视频生成能力；聊天可上传本地图片，图片模式调用 Grok 原生 `image_gen` / `image_edit`，视频模式调用 `image_to_video`
- ACP 全局与 profile 级代理支持直连、应用代理、已保存 Proxy 会话和手动 URL；profile 可继承或覆盖全局策略
- 设置页可编辑命令/参数、启停 profile、选择优先 profile，并执行有界的 ACP initialize 握手探测

### 14.8 LLM Provider 列表 ✅

<!-- feature
id: F-AI-11
status: done
area: ai/providers
components: [LlmProvidersPanel]
files:
  - src/components/settings/LlmProvidersPanel.tsx
controls: []   # SettingsPanel-level concern; the provider editor renders inline rows without dedicated testids — covered indirectly via TC-AI-004's "AI 设置" section assertions
-->

- LLM provider 列表（OpenAI / Anthropic / 自定义 base URL 等）
- API key 写入 vault；vault 锁定时整段会话保留但显示锁图标，提示用户先解锁
- 与 `aiStore.providers` 双向同步

---

## 15. 终端分屏

### 15.1 Terminal Split View ✅

<!-- feature
id: F-Split-1
status: done
area: terminal/split
components: [MainLayout, TerminalSplitToolbar]
files:
  - src/layouts/MainLayout.tsx
  - src/stores/appStore.ts
controls:
  - id: split-stage
    selector: '[data-testid="terminal-split-stage"]'
    kind: display
    optional: true       # rendered only when split active
  - id: split-toolbar
    selector: '[data-testid="terminal-split-toolbar"]'
    kind: display
    optional: true
  - id: split-panes
    selector: '[data-testid="terminal-split-panes"]'
    kind: display
    optional: true
  - id: split-pane
    selector: '[data-testid="terminal-split-pane"]'
    kind: display
    optional: true
  - id: split-resize-handle
    selector: '[data-testid="terminal-split-resize-handle"]'
    kind: interactive
    optional: true       # only in horizontal/vertical layouts
  - id: split-grid-column-resize-handle
    selector: '[data-testid="terminal-split-grid-column-resize-handle"]'
    kind: interactive
    optional: true       # only in grid layout
  - id: split-grid-row-resize-handle
    selector: '[data-testid="terminal-split-grid-row-resize-handle"]'
    kind: interactive
    optional: true
  - id: split-layout-horizontal
    selector: '[data-testid="terminal-split-layout-horizontal"]'
    kind: interactive
    optional: true
  - id: split-layout-vertical
    selector: '[data-testid="terminal-split-layout-vertical"]'
    kind: interactive
    optional: true
  - id: split-layout-grid
    selector: '[data-testid="terminal-split-layout-grid"]'
    kind: interactive
    optional: true
  - id: split-input-lock
    selector: '[data-testid^="terminal-split-lock-"]'
    kind: interactive
    optional: true
  - id: terminal-input-locked
    selector: '[data-testid="terminal-input-locked"]'
    kind: display
    optional: true       # rendered when a pane is input-locked
-->

- 标题栏 `tab-split-view` 切换分屏；激活后所有打开的本地/SSH 终端 tab 同时挂载到 `terminal-split-stage`
- 三种布局：horizontal / vertical / grid，分别由 `data-layout` 属性标识
- 拖拽中分割条（`terminal-split-resize-handle` 或 grid 模式下的列/行 handle）调整面板尺寸
- 每个 pane 上的 `terminal-split-lock-<id>` 按钮可单独锁定该 pane 输入
- 与 MultiExec 协同：选 "All" 时计数文案为 `<active>/<total>`

---

## 16. 通用对话框

### 16.1 In-app `ConfirmDialog` ✅

<!-- feature
id: F-Confirm-1
status: done
area: ui/dialog
components: [ConfirmDialog]
files:
  - src/components/sidebar/ConfirmDialog.tsx
controls:
  - id: confirm-dialog
    selector: '[data-testid="confirm-dialog"]'
    kind: display
    optional: true
  - id: confirm-dialog-message
    selector: '[data-testid="confirm-dialog-message"]'
    kind: display
    optional: true
  - id: confirm-dialog-cancel
    selector: '[data-testid="confirm-dialog-cancel"]'
    kind: interactive
    optional: true
  - id: confirm-dialog-confirm
    selector: '[data-testid="confirm-dialog-confirm"]'
    kind: interactive
    optional: true
-->

- 取代 `window.confirm` 的跨平台 React 模态（macOS WKWebView 默认禁用 `window.confirm`/`alert`）
- 支持 `danger` 标志、自定义 confirm/cancel 文案、Esc 取消、Enter 确认
- 当前在 SessionTree 删除文件夹流程中替换原生 confirm

### 16.2 Session Import 预览 ✅

<!-- feature
id: F-ImportPreview-1
status: done
area: sessions/import
components: [SessionImportPreview]
files:
  - src/components/session/SessionImportPreview.tsx
  - src/components/sidebar/SessionTree.tsx
  - src/components/menubar/MenuBar.tsx
controls:
  - id: preview-dialog
    selector: '[data-testid="session-import-preview"]'
    kind: display
    optional: true       # only after triggering an import flow
  - id: preview-summary
    selector: '[data-testid="session-import-preview-summary"]'
    kind: display
    optional: true
  - id: preview-warnings
    selector: '[data-testid="session-import-preview-warnings"]'
    kind: display
    optional: true       # only when result.warnings.length > 0
  - id: preview-table
    selector: '[data-testid="session-import-preview-table"]'
    kind: display
    optional: true
  - id: preview-select-all
    selector: '[data-testid="session-import-preview-select-all"]'
    kind: interactive
    optional: true
  - id: preview-cancel
    selector: '[data-testid="session-import-preview-cancel"]'
    kind: interactive
    optional: true
  - id: preview-confirm
    selector: '[data-testid="session-import-preview-confirm"]'
    kind: interactive
    optional: true
  # Menu-bar leaf items that trigger the preview (under Sessions →
  # Import / Export submenus). Each calls openTextFile/openBinaryFile,
  # which means the preview dialog only renders after a real file picker
  # selects a fixture — but the menu route itself is observable.
  - id: import-json
    selector: '[data-testid="import-json"]'
    kind: interactive
    optional: true
  - id: import-mobaxterm
    selector: '[data-testid="import-mobaxterm"]'
    kind: interactive
    optional: true
  - id: import-csv
    selector: '[data-testid="import-csv"]'
    kind: interactive
    optional: true
  - id: download-csv-template
    selector: '[data-testid="download-csv-template"]'
    kind: interactive
    optional: true
  - id: import-openssh
    selector: '[data-testid="import-openssh"]'
    kind: interactive
    optional: true
  - id: export-json
    selector: '[data-testid="export-json"]'
    kind: interactive
    optional: true
  - id: export-mobaxterm
    selector: '[data-testid="export-mobaxterm"]'
    kind: interactive
    optional: true
  - id: export-csv
    selector: '[data-testid="export-csv"]'
    kind: interactive
    optional: true
  - id: export-html
    selector: '[data-testid="export-html"]'
    kind: interactive
    optional: true
-->

- 第三方会话 / Taomni JSON / MobaXterm / CSV / OpenSSH / Tabby / Xshell / WindTerm / iTerm2 / Terminal.app / Termius / PuTTYCM / SuperPuTTY / mRemote / Exceed / SecureCRT / RDM / WSL / PuTTY / External Bash 等导入入口共用的预览对话框
- 支持每行勾选 + 全选 / 反选；前 80 条出现在表格预览中，剩余仍按选择应用
- Cancel 走遮罩点击 / Esc / Cancel 按钮；Confirm 在没有选中行时禁用
- 摘要区列出待写入 vault 的密码数与 standalone secret 数

### 16.3 第三方 Vault 解锁对话框 ✅

<!-- feature
id: F-ExternalVault-1
status: done
area: sessions/import
components: [ExternalVaultUnlockDialog]
files:
  - src/components/session/ExternalVaultUnlockDialog.tsx
  - src/components/sidebar/SessionTree.tsx
controls:
  - id: dialog
    selector: '[data-testid="external-vault-unlock-dialog"]'
    kind: display
    optional: true       # only when importing a tool that has an encrypted vault (e.g. Tabby)
  - id: description
    selector: '[data-testid="external-vault-unlock-description"]'
    kind: display
    optional: true
  - id: pw-input
    selector: '[data-testid="external-vault-unlock-pw"]'
    kind: interactive
    optional: true
  - id: error
    selector: '[data-testid="external-vault-unlock-error"]'
    kind: display
    optional: true       # only after wrong password / decryption error
  - id: skip
    selector: '[data-testid="external-vault-unlock-skip"]'
    kind: interactive
    optional: true
  - id: confirm
    selector: '[data-testid="external-vault-unlock-confirm"]'
    kind: interactive
    optional: true
-->

- 通用 prop 驱动的第三方主密码输入框（与 Taomni 自身的 `VaultUnlockDialog` 区分，避免误导）
- 用于 Tabby vault 解密：错误密码后保留对话框并显示内联错误（`tabby_vault_bad_password` → "Incorrect Tabby master password (attempt N)"）
- 「Skip」按钮跳过 vault 解密但仍继续走 OS keychain 回退

### 16.4 Folder Name 对话框 ✅

<!-- feature
id: F-FolderName-1
status: done
area: sessions/folder
components: [FolderNameDialog, SessionTree]
files:
  - src/components/sidebar/FolderNameDialog.tsx
  - src/components/sidebar/SessionTree.tsx
controls:
  - id: dialog
    selector: '[data-testid="folder-name-dialog"]'
    kind: display
    optional: true
  - id: parent-readout
    selector: '[data-testid="folder-name-dialog-parent"]'
    kind: display
    optional: true
  - id: input
    selector: '[data-testid="folder-name-dialog-input"]'
    kind: interactive
    optional: true
  - id: cancel
    selector: '[data-testid="folder-name-dialog-cancel"]'
    kind: interactive
    optional: true
  - id: confirm
    selector: '[data-testid="folder-name-dialog-confirm"]'
    kind: interactive
    optional: true
-->

- 替代 `window.prompt` 的文件夹命名 React 模态，新建 / 重命名共用
- 父路径只读显示在顶部
- 空名 / 非法字符（"/"、控制字符）禁用 Confirm

---

## 17. 会话侧边栏与多选

### 17.1 多选会话连接 ✅

<!-- feature
id: F-Sidebar-1
status: done
area: sessions/multiselect
components: [SessionTree, Sidebar, MainLayout]
files:
  - src/components/sidebar/SessionTree.tsx
  - src/components/sidebar/Sidebar.tsx
  - src/layouts/MainLayout.tsx
controls:
  # Base SessionTree rows/context actions are owned by F6.2. These selectors
  # describe only the state/action introduced by multi-selection.
  - id: selected-session-row
    selector: '[data-testid="session-tree-item"][data-selected="true"]'
    kind: interactive
    optional: true
  - id: connect-selected-sessions
    selector: '[data-testid^="context-menu-item-connect-selected-sessions-"]'
    kind: interactive
    optional: true
-->

- 在 SessionTree 中按住 Ctrl / Meta 单击会话条目可累加选中
- 选中状态通过 `data-selected` / `aria-selected` 属性暴露
- 右键菜单首项变成 `Connect selected sessions (N)`，一次性把所有选中会话作为新 tab 打开
- 右键菜单提供 `Set terminal theme...` 预览 flyout，可批量写入所选非 Mail 保存会话的 `terminalProfile.theme`
- 普通点击仍然回到单选语义

---

## 18. 上下文菜单容错

### 18.1 子菜单视口翻转 ✅

<!-- feature
id: F-Submenu-1
status: done
area: ui/menu
components: [ContextMenu]
files:
  - src/components/ContextMenu.tsx
controls: []   # no dedicated testid: the submenu container itself uses class-based positioning, not a testid. behavior-only feature kept here to document the fix.
-->

- 二级 / 三级 子菜单出现时，若按默认 `left-full` 渲染会超出视口右边缘，则通过 `getBoundingClientRect` 切换到 `right-full` 向左展开
- macOS WKWebView 上原本被裁掉的子菜单恢复可见
- 没有 testid，行为通过现有右键菜单链路（如会话树 Import / Export 子菜单）覆盖

---

## 19. 双语 UI

### 19.1 语言切换 (i18n) ✅

<!-- feature
id: F-I18n-1
status: done
area: ui/i18n
components: [LanguageSwitcher, LanguageSection, useT, useLocale]
files:
  - src/components/window/LanguageSwitcher.tsx
  - src/components/settings/LanguageSection.tsx
  - src/lib/i18n/index.ts
  - src/lib/i18n/labels.ts
  - src/lib/i18n/locales/en.ts
  - src/lib/i18n/locales/zh-CN.ts
controls:
  - id: tray-switcher
    selector: '[data-testid="language-switcher"]'
    kind: interactive
  - id: language-option-en
    selector: '[data-testid="language-option-en"]'
    kind: interactive
    optional: true       # only after the tray button opens its menu
  - id: language-option-zh
    selector: '[data-testid="language-option-zh-CN"]'
    kind: interactive
    optional: true
  - id: settings-section
    selector: '[data-testid="settings-language-section"]'
    kind: display
  - id: settings-language-en
    selector: '[data-testid="settings-language-en"]'
    kind: interactive
  - id: settings-language-zh
    selector: '[data-testid="settings-language-zh-CN"]'
    kind: interactive
-->

- 标题栏 `LanguageSwitcher`（地球图标 + EN / 中 缩写）打开 locale 选择上下文菜单
- 设置面板 `LanguageSection` 提供同样的切换入口（适合不熟悉托盘的用户）
- locale 持久化到 `localStorage` (`taomni.locale.v1`)；默认 `en`，已保存的偏好最优先
- 切换时 `document.documentElement.lang` 同步更新
- 字典覆盖范围：menu / ribbon / quick connect / session editor / settings / capture / SFTP toolbar / chat drawer / agent / file browser / tunnel manager / vault / about dialog 等所有用户可见入口
- 未翻译键自动回落到英文，缺失键直接显示 key 路径（便于发现缺漏）

---

## 20. 标签分离到独立窗口（Detach / Reattach）

### 20.1 通用标签分离与重挂载 ✅

<!-- feature
id: F-Detach-1
status: done
area: main/detach
components: [DetachedSessionWindow, TerminalPanel, VncPanel, RdpPanel, MainLayout]
files:
  - src/components/detached/DetachedSessionWindow.tsx
  - src/lib/detachWindowing.ts
  - src/lib/detachedSession.ts
controls:
  # Per-panel "detach to its own window" buttons in each panel's floating toolbar.
  # Each fires window.open (browser) / open_detached_window (Tauri) and drops the
  # source tab — a destructive action, so cases click it LAST (see TC-111).
  - id: terminal-floating-toolbar  # the terminal panel's FloatingToolbar host (F10.1 infra)
    selector: '[data-testid="terminal-floating-toolbar"]'
    kind: display
  - id: terminal-detach
    selector: '[data-testid="terminal-detach"]'
    kind: interactive
    optional: true       # only when MainLayout wires detachToggle (not in terminal split mode)
  - id: terminal-maximize
    selector: '[data-testid="terminal-maximize"]'
    kind: interactive
    optional: true
  - id: vnc-detach
    selector: '[data-testid="vnc-detach"]'
    kind: interactive
    optional: true       # only after a live VNC session shows the canvas
  # NB: rdp-detach ([data-testid="rdp-detach"]) is owned by F9.7 (RDP panel).
  # Declaring it here too would be a duplicate-selector lint error, so this
  # feature only documents it in prose — TC-111 exercises the click.
  # Detached-window shell + the controls that only exist inside it.
  - id: detached-window
    selector: '[data-testid="detached-session-window"]'
    kind: display
    optional: true       # only inside an actual detached OS/popup window
  - id: detached-reattach
    selector: '[data-testid="detached-reattach"]'
    kind: interactive
    optional: true       # only inside a detached window — reattaches the session to the main window
  - id: detached-os-fullscreen
    selector: '[data-testid="detached-os-fullscreen"]'
    kind: interactive
    optional: true
-->

- 终端 / VNC / RDP 标签的浮动工具条均提供「分离到独立窗口」按钮（`terminal-detach` / `vnc-detach` / `rdp-detach`）
- 分离流程：先把凭证 / 会话快照写入 `localStorage` handoff，再 `open_detached_window`（Tauri 真实 OS 窗口）或 `window.open`（浏览器兜底），成功后移除源标签
- 终端分离保留后端 PTY/SSH 会话（`preserveSessionOnUnmountRef` + detach-pending 标志跳过 `closeTerminal`），新窗口通过 `consumeDetachedHandoff` adopt 既有连接而非重新拨号
- 分离窗口由 `DetachedSessionWindow` 承载：镜像主窗口主题 / 字体副作用，提供 `detached-reattach`（把会话送回主窗口）与 `detached-os-fullscreen`
- 终端面板另提供 `terminal-maximize`（在非分屏模式下最大化/还原当前终端 pane）
- **e2e 测试限制**：分离会 spawn 新窗口并销毁源标签，属破坏性操作，用例只在最后一步点击（参照 TC-043/TC-111）；reattach / detached-window 内部控件需真实分离窗口或 Tauri 环境，浏览器冒烟无法挂载，留待 native/手动回归

---

## 21. SSH 多因素认证（Keyboard-interactive MFA）

### 21.1 键盘交互式 MFA 弹窗 `MfaPrompt` ✅

<!-- feature
id: F-Mfa-1
status: done
area: terminal/ssh
components: [MfaPrompt, TerminalPanel]
files:
  - src/components/session/MfaPrompt.tsx
controls:
  - id: prompt
    selector: '[data-testid="mfa-prompt"]'
    kind: display
    optional: true       # only after the server issues a keyboard-interactive challenge
  - id: instructions
    selector: '[data-testid="mfa-instructions"]'
    kind: display
    optional: true       # only when the challenge carries an instruction string
  - id: answer
    selector: '[data-testid="mfa-answer-0"]'
    kind: interactive
    optional: true       # one input per prompt; mfa-answer-${idx}
  - id: cancel
    selector: '[data-testid="mfa-cancel"]'
    kind: interactive
    optional: true
  - id: submit
    selector: '[data-testid="mfa-submit"]'
    kind: interactive
    optional: true
  - id: close
    selector: '[data-testid="mfa-close"]'
    kind: interactive
    optional: true
-->

- SSH `keyboard-interactive` 认证时后端发出挑战事件，`TerminalPanel` 挂载 `MfaPrompt` 弹窗收集每个 prompt 的回答（`mfa-answer-${idx}`，密码型 prompt 自动隐藏输入）
- 多 prompt 挑战渲染多个输入框，可选的 `instructions` / `name` 文案显示在顶部
- Submit 回填答案续认证；Cancel / Close 中止认证流程
- **e2e 测试限制**：弹窗只在服务器主动发起 keyboard-interactive 挑战时出现，需要一台配置了 MFA/OTP 的 SSH 服务器作为 fixture；本地 smoke sshd（密码认证）不触发，TC-113 标记 `live-only` + `needs-review`，默认 fixture 下走「无挑战即跳过」的软断言，真实 MFA 行为需配置专用服务器手动回归

---

## 22. 本地服务器管理（Local Servers）

### 22.1 本地服务器管理窗口 `ServersDialog` ✅

<!-- feature
id: F-Servers-1
status: done
area: servers
components: [ServersDialog, ServerList, ServerRow, ServerSettings, CommonSettings, ServerOutputLog, fields]
files:
  - src/components/servers/ServersDialog.tsx
  - src/components/servers/ServerList.tsx
  - src/components/servers/ServerRow.tsx
  - src/components/servers/ServerSettings.tsx
  - src/components/servers/CommonSettings.tsx
  - src/components/servers/ServerOutputLog.tsx
  - src/components/servers/fields.tsx
  - src/lib/servers.ts
  - src/stores/serversStore.ts
  - src/lib/detachedSession.ts
  - src-tauri/src/windowing/mod.rs
controls:
  # Standalone OS window — opened by ribbon "servers" / Ctrl+Shift+S via
  # open_detached_window(kind=servers). Browser smoke uses ?servers=main.
  - id: dialog
    selector: '[data-testid="servers-dialog"]'
    kind: display
    optional: true       # only inside the servers detached window
  - id: dialog-cancel
    selector: '[data-testid="servers-dialog-cancel"]'
    kind: interactive
    optional: true
  - id: dialog-apply
    selector: '[data-testid="servers-dialog-apply"]'
    kind: interactive
    optional: true
  # Left rail — one selectable row per server type (dynamic: server-row-${type}).
  - id: server-list
    selector: '[data-testid="server-list"]'
    kind: display
    optional: true
  - id: server-row-ssh
    selector: '[data-testid="server-row-ssh"]'
    kind: interactive
    optional: true
  - id: server-row-ftp
    selector: '[data-testid="server-row-ftp"]'
    kind: interactive
    optional: true
  - id: server-row-http
    selector: '[data-testid="server-row-http"]'
    kind: interactive
    optional: true
  - id: server-row-rdp
    selector: '[data-testid="server-row-rdp"]'
    kind: interactive
    optional: true
  # Per-row Start / Stop / Settings actions (dynamic: server-row-${type}-{start,stop,settings}).
  - id: server-row-ssh-start
    selector: '[data-testid="server-row-ssh-start"]'
    kind: interactive
    optional: true
  - id: server-row-ssh-stop
    selector: '[data-testid="server-row-ssh-stop"]'
    kind: interactive
    optional: true       # disabled until the server is running/starting
  - id: server-row-ssh-settings
    selector: '[data-testid="server-row-ssh-settings"]'
    kind: interactive
    optional: true
  # Right pane — settings form + live console for the selected server.
  - id: server-settings
    selector: '[data-testid="server-settings"]'
    kind: display
    optional: true
  - id: server-log
    selector: '[data-testid="server-log"]'
    kind: display
    optional: true
  - id: server-log-autoscroll
    selector: '[data-testid="server-log-autoscroll"]'
    kind: interactive
    optional: true
  - id: server-log-clear
    selector: '[data-testid="server-log-clear"]'
    kind: interactive
    optional: true
-->

- 从 Ribbon `Servers` 按钮（`ribbon-servers`）或 `Ctrl+Shift+S` 打开**独立 OS 窗口**（`open_detached_window` kind=`servers`，系统标题栏/边框可移动可缩放；已打开则 focus 单例窗口 `servers-main`）；浏览器预览走 `window.open(?servers=main)`
- 窗口内：左侧服务器列表 + 右侧设置面板 + Cancel/Apply 页脚；无自定义模态标题栏（由系统 chrome 承担）
- 支持 10 类本地服务器（`SERVER_DEFS` 顺序）：ssh/sftp、ftp、tftp、http、telnet、vnc、nfs、cron、iperf、rdp；每行（`server-row-${type}`）显示运行状态点 + Start/Stop/Settings 按钮
- 右栏：`CommonSettings`（监听端口 / 绑定地址 / 自动停止 / 开机自启）+ 每类专属设置表单（`settings/<X>Settings.tsx`，复用 `fields.tsx` 受控原语）+ `ServerOutputLog` 实时输出控制台（自动滚动 `server-log-autoscroll` / 清空 `server-log-clear`）
- 后端 `src-tauri/src/servers/`：`ServerRegistry` 镜像 Tunnel 架构，配置持久化到 SQLite `server_configs` 表并在启动时 `autostart_servers()`；in-process 纯 Rust（ssh/sftp/http/ftp/tftp/telnet/cron）与受监管系统二进制（vnc/nfs/iperf 经 `which` + `spawn_supervised`，缺工具返回明确错误而非假「运行中」）
- 输出/状态分别通过 `server://output/<type>` / `server://status/<type>` 事件流推送（`app.emit` 全局，detached 窗口可收）；Apply 保存所有 dirty 配置，对运行中且端口已改的服务器提示需重启生效；有未保存修改时 Cancel / 系统关闭按钮会确认丢弃
- i18n key 在 `servers.*`（en / zh-CN 双语）；前端 store 为 `serversStore`，IPC + 类型 + `SERVER_DEFS` 在 `src/lib/servers.ts`
- **e2e 测试限制**：真正 start/stop 一个服务器会绑定真实端口 / 拉起系统二进制，属带副作用操作；浏览器冒烟只验证对话框 chrome（打开 → 选行 → 设置面板/输出控制台挂载 → Cancel 关闭），实际启停留待 native/手动回归

---

## 23. 数据库客户端 — SQL（MySQL / PostgreSQL / PanWeiDB / Oracle / SQLServer / StarRocks / ClickHouse / Presto）

### 23.1 SQL 客户端 `DbClientTab` ✅

<!-- feature
id: F-DB-1
status: done
area: database/sql
components: [DbClientTab, SchemaTree, SqlEditorPanel, QueryResultGrid, SessionEditor]
files:
  - src/components/database/DbClientTab.tsx
  - src/components/database/SchemaTree.tsx
  - src/components/database/SqlEditorPanel.tsx
  - src/components/database/QueryResultGrid.tsx
  - src/components/database/formatSql.ts
  - src/lib/sqlStatements.ts
  - src/lib/queryRegistry.ts
  - src/lib/dbMetadataCache.ts
  - src/lib/sqlEditorDialect.ts
  - src/lib/sqlLocalRelations.ts
  - src/lib/sqlMetadataCompletions.ts
  - src/lib/sqlQueryScope.ts
  - src/lib/databaseTabLimit.ts
  - src/lib/ipc.ts
  - src-tauri/src/database/mod.rs
  - src-tauri/src/database/sql.rs
  - src-tauri/src/database/oracle.rs
  - src-tauri/src/database/panwei.rs
  - src-tauri/src/database/history.rs
  - src/components/session/SessionEditor.tsx
controls:
  # SQL DB session form body inside SessionEditor (proto + section TAB selectors are
  # owned by F6.3). These mount in browser mode and are the smoke-testable surface;
  # the live tab below only mounts on a successful desktop connection.
  - id: database-section
    selector: '[data-testid="session-database-section"]'
    kind: display
    optional: true       # only when a DB proto is selected
  - id: database-settings
    selector: '[data-testid="database-settings"]'
    kind: display
    optional: true
  - id: db-username
    selector: 'input[aria-label="Database username"]'
    kind: interactive
    optional: true
  - id: db-password
    selector: 'input[aria-label="Database password"]'
    kind: interactive
    optional: true
  - id: db-name
    selector: 'input[aria-label="Database name"]'
    kind: interactive
    optional: true       # hidden for Redis; present for MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto
  - id: db-save-in-vault
    selector: '[data-testid="db-save-in-vault"]'
    kind: interactive
    optional: true       # only when the vault is initialized
  # Opened tab — these only mount inside an open SQL DB tab (live desktop connection).
  - id: schema-tree
    selector: '[data-testid="schema-tree"]'
    kind: display
    optional: true       # only inside an open SQL DB tab
  - id: sql-editor
    selector: '[data-testid="sql-editor"]'
    kind: display
    optional: true
  - id: sql-completion-status
    selector: '[data-testid="sql-completion-status"]'
    kind: display
    optional: true       # transient loading/truncation/error feedback inside a live SQL tab
  - id: query-result-grid
    selector: '[data-testid="query-result-grid"]'
    kind: display
    optional: true
  - id: query-result-generated-sql
    selector: '[data-testid="query-result-generated-sql"]'
    kind: display
    optional: true       # only after result-grid filter/sort produces a derived SQL
  - id: query-result-generated-sql-copy
    selector: '[data-testid="query-result-generated-sql-copy"]'
    kind: interactive
    optional: true
  - id: query-result-generated-sql-query
    selector: '[data-testid="query-result-generated-sql-query"]'
    kind: interactive
    optional: true       # applies local result-grid filters/sort to SQL and refreshes the current sheet
  - id: query-result-generated-sql-sync
    selector: '[data-testid="query-result-generated-sql-sync"]'
    kind: interactive
    optional: true       # creates/reuses a Generated SQL query panel as a draft/fallback
  - id: query-history-panel
    selector: '[data-testid="db-query-history-panel"]'
    kind: display
    optional: true       # opened from History toolbar button inside a live SQL tab
  - id: query-history-refresh
    selector: '[data-testid="db-query-history-refresh"]'
    kind: interactive
    optional: true
  - id: query-history-clear
    selector: '[data-testid="db-query-history-clear"]'
    kind: interactive
    optional: true
  - id: query-history-entry
    selector: '[data-testid="db-query-history-entry"]'
    kind: display
    optional: true
  - id: query-history-run
    selector: '[data-testid="db-query-history-run"]'
    kind: interactive
    optional: true
  - id: query-history-select
    selector: '[data-testid="db-query-history-select"]'
    kind: interactive
    optional: true
  - id: query-history-open-tab
    selector: '[data-testid="db-query-history-open-tab"]'
    kind: interactive
    optional: true
  - id: query-history-json
    selector: '[data-testid="db-query-history-json"]'
    kind: interactive
    optional: true
  - id: query-history-ask-ai
    selector: '[data-testid="db-query-history-ask-ai"]'
    kind: interactive
    optional: true
  - id: query-history-delete
    selector: '[data-testid="db-query-history-delete"]'
    kind: interactive
    optional: true
  - id: current-statement-panel
    selector: '[data-testid="db-current-statement-panel"]'
    kind: display
    optional: true       # opened from Current statement toolbar button inside a live SQL tab
  - id: current-statement-run
    selector: '[data-testid="db-current-statement-run"]'
    kind: interactive
    optional: true
  - id: current-statement-select
    selector: '[data-testid="db-current-statement-select"]'
    kind: interactive
    optional: true
  - id: current-statement-open-tab
    selector: '[data-testid="db-current-statement-open-tab"]'
    kind: interactive
    optional: true
  - id: current-statement-json
    selector: '[data-testid="db-current-statement-json"]'
    kind: interactive
    optional: true
  - id: current-statement-ask-ai
    selector: '[data-testid="db-current-statement-ask-ai"]'
    kind: interactive
    optional: true
  - id: query-cell-value-dialog
    selector: '[data-testid="query-cell-value-dialog"]'
    kind: display
    optional: true       # opened from a live query result cell via Ctrl+Enter/context menu
  - id: query-cell-value-text
    selector: '[data-testid="query-cell-value-text"]'
    kind: display
    optional: true
  - id: query-cell-value-copy
    selector: '[data-testid="query-cell-value-copy"]'
    kind: interactive
    optional: true
  - id: query-cell-value-wrap
    selector: '[data-testid="query-cell-value-wrap"]'
    kind: interactive
    optional: true
  - id: schema-select
    selector: 'select[aria-label="Schema"]'
    kind: interactive
    optional: true       # only when the connection exposes >0 schemas
  - id: schema-drawer-handle
    selector: '[data-testid="db-schema-drawer-handle"]'
    kind: interactive
    optional: true
  - id: query-library-tab
    selector: '[data-testid="db-query-library-tab"]'
    kind: interactive
    optional: true       # opened SQL tab, including connection-error mode
  - id: save-query
    selector: '[data-testid="db-save-query"]'
    kind: interactive
    optional: true
  - id: tab-limit
    selector: '[data-testid="db-tab-limit"]'
    kind: interactive
    optional: true       # only inside an open SQL DB tab
  - id: connection-error-banner
    selector: '[data-testid="db-connection-error-banner"]'
    kind: display
    optional: true       # connection failed; editor and Query Library remain mounted
  # Shared tab actions — chat / detach.
  - id: chat-toggle
    selector: '[data-testid="db-chat-toggle"]'
    kind: interactive
    optional: true
  - id: detach
    selector: '[data-testid="db-detach"]'
    kind: interactive
    optional: true       # destructive in browser mode — click LAST (see F-Detach-1)
  # NB: detached-reattach / detached-os-fullscreen testids are owned by F-Detach-1;
  # DbClientTab hosts them inside a detached window but does not re-declare them here
  # (duplicate-selector lint). The SQL editor toolbar buttons (Run/Selection/Cancel/
  # Format/History/Save) use title= only — no stable testid yet; promote when covered.
-->

- DB 会话（MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto）经 `SessionEditor` 创建（proto 选择器 + database section 由 F6.3 拥有），打开后 `MainLayout.openDbTab` 挂载 `DbClientTab`（`type:"database"`），与 SFTP/VNC 一样常驻挂载以便查询跨标签存活
- 左侧 `SchemaTree`：懒加载 schema→table→column/index 展开（`db-schema-drawer-handle` 抽屉折叠）；右侧查询工作区为多 query 面板的 tab 布局，`Tab limit` 同时限制每个 session 的 query tabs 和每个 query 的 result tabs（默认 50）
- `SqlEditorPanel` 封装 CodeMirror 6：按引擎选 dialect，提供语法上下文感知的本地 CTE/函数补全与有界、可缓存的远端元数据补全，覆盖表/列、读取光标后 `FROM/JOIN` 的 `SELECT` 字段补全、通配符展开、`INSERT` 列和外键优先的 `JOIN ON`；补全触发键、输入自动弹出及 Tab/Enter 接受行为可在全局设置中修改，运行中的主/分离窗口会动态重配 keymap；加载、截断与错误会通过 `sql-completion-status` 反馈
- SQL 历史持久化到 SQLite `sql_history`，按 workspace/session + engine 查询；History 面板支持 Run / Select / +Tab / JSON / Ask AI / Refresh / Clear / Delete；当前 editor 语句面板用 cursor/selection 定位多 SQL 文档中的单条语句，并提供同一套 Run / Select / +Tab / JSON / Ask AI 交互
- `QueryResultGrid` 为手写虚拟化网格（行高 24 + overscan）：NULL 徽标、数值右对齐、排序、CSV/单元格复制、完整值查看（Ctrl+Enter / 右键菜单，保留长文本和换行）、列显隐、聚合统计、行筛选、Table/List/Chart 视图、增删改行 + 提交/撤销；过滤/排序先本地生效，显式 `Query` 后优先把 `WHERE` / `ORDER BY` 原位写回仍匹配的来源语句并刷新当前 result sheet，复杂 SQL fallback 为包裹源 SQL 的 derived SQL，`Sync` 可创建/复用 `Generated SQL` query 面板作为草稿
- 查询工作区跨会话持久化（`queryRegistry` + `ef0b686`），结果可经 Export Grid 对话框导出
- 顶部共享 `TabActions`：Chat 入口 / 分离到独立窗口（`db-detach`，分离/重挂载行为属 F-Detach-1）
- **e2e 测试限制**：实际查询需活的 MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto fixture，浏览器冒烟无法连接；smoke 只覆盖「SessionEditor 选 DB proto → 填 host/port → 保存 → 打开标签 → schema-tree / sql-editor / query-result-grid 挂载」的路由路径（参照 TC-111 RDP scaffold 模式），真实查询/编辑留待配置 DB fixture 的手动/native 回归

---

## 24. 数据库客户端 — Redis

### 24.1 Redis 客户端 `RedisClientTab` ✅

<!-- feature
id: F-DB-2
status: done
area: database/redis
components: [RedisClientTab, RedisKeyBrowser, RedisValuePanel, RedisCli, RedisNewKeyDialog]
files:
  - src/components/database/RedisClientTab.tsx
  - src/components/database/RedisKeyBrowser.tsx
  - src/components/database/RedisValuePanel.tsx
  - src/components/database/RedisCli.tsx
  - src/components/database/RedisNewKeyDialog.tsx
  - src/components/session/SessionEditor.tsx
controls:
  # Redis session form body inside SessionEditor (proto + section TAB owned by F6.3;
  # the shared database-settings / session-database-section containers are declared
  # by F-DB-1). These Redis-specific fields mount in browser mode and are the
  # smoke-testable surface. The form's DB-index INPUT is distinct from the tab's
  # DB-index SELECT below (input[...] vs select[...]), so both can be declared.
  - id: form-db-index
    selector: 'input[aria-label="Redis DB index"]'
    kind: interactive
    optional: true       # only when Redis proto selected in SessionEditor
  - id: form-key-prefix
    selector: 'input[aria-label="Redis key prefix"]'
    kind: interactive
    optional: true
  # Opened tab — only mount inside an open Redis tab (live desktop connection).
  - id: db-index
    selector: 'select[aria-label="Redis DB index"]'
    kind: interactive
    optional: true       # only inside an open Redis tab
  - id: key-browser
    selector: '[data-testid="redis-key-browser"]'
    kind: display
    optional: true
  - id: key-pattern
    selector: 'input[aria-label="Key pattern"]'
    kind: interactive
    optional: true
  - id: cli
    selector: '[data-testid="redis-cli"]'
    kind: display
    optional: true
  - id: cli-command
    selector: 'input[aria-label="Redis command"]'
    kind: interactive
    optional: true
  - id: explain-current
    selector: '[data-testid="redis-explain-current"]'
    kind: interactive
    optional: true
  - id: explain-line
    selector: '[data-testid="redis-explain-line"]'
    kind: interactive
    optional: true
  - id: ai-answer-language-toggle
    selector: '[data-testid="redis-ai-answer-language-toggle"]'
    kind: interactive
    optional: true
  - id: ai-answer-language-option-inherit
    selector: '[data-testid="redis-ai-answer-language-option-inherit"]'
    kind: interactive
    optional: true
  - id: ai-answer-language-option-auto
    selector: '[data-testid="redis-ai-answer-language-option-auto"]'
    kind: interactive
    optional: true
  - id: ai-answer-language-option-zh-cn
    selector: '[data-testid="redis-ai-answer-language-option-zh-CN"]'
    kind: interactive
    optional: true
  - id: ai-answer-language-option-en
    selector: '[data-testid="redis-ai-answer-language-option-en"]'
    kind: interactive
    optional: true
  - id: context-ai-explain-syntax
    selector: '[data-testid="redis-context-ai-explain-syntax"]'
    kind: interactive
    optional: true
  - id: context-ai-answer-language
    selector: '[data-testid="redis-context-ai-answer-language"]'
    kind: interactive
    optional: true
  - id: context-ai-answer-language-inherit
    selector: '[data-testid="redis-context-ai-answer-language-inherit"]'
    kind: interactive
    optional: true
  - id: context-ai-answer-language-auto
    selector: '[data-testid="redis-context-ai-answer-language-auto"]'
    kind: interactive
    optional: true
  - id: context-ai-answer-language-zh-cn
    selector: '[data-testid="redis-context-ai-answer-language-zh-CN"]'
    kind: interactive
    optional: true
  - id: context-ai-answer-language-en
    selector: '[data-testid="redis-context-ai-answer-language-en"]'
    kind: interactive
    optional: true
  - id: query-library-tab
    selector: '[data-testid="redis-query-library-tab"]'
    kind: interactive
    optional: true
  - id: save-query
    selector: '[data-testid="redis-save-query"]'
    kind: interactive
    optional: true
  - id: connection-error-banner
    selector: '[data-testid="redis-connection-error-banner"]'
    kind: display
    optional: true
  # RedisNewKeyDialog fields (aria-label only — modal opened by the key browser "Add" button).
  - id: new-key-name
    selector: 'input[aria-label="Key name"]'
    kind: interactive
    optional: true       # only after Add-key dialog opens
  - id: new-key-type
    selector: 'select[aria-label="Key type"]'
    kind: interactive
    optional: true
  - id: new-key-value
    selector: 'input[aria-label="Initial value"]'
    kind: interactive
    optional: true
-->

- Redis 会话经 `SessionEditor`（`session-proto-redis` 由 F6.3 拥有）创建，打开后挂载 `RedisClientTab`（`type:"redis"`），常驻挂载
- 左侧 `RedisKeyBrowser`：SCAN 游标分页（Load more…）、`:`-前缀文件夹树、类型徽标、TTL pill（每 10s 自动刷新），顶部 `Key pattern` glob 输入 + Scan，下方 Add/Delete/TTL 操作
- 右侧 `RedisValuePanel`：按 key 类型分别渲染 String/Hash/List/Set/ZSet/Stream 编辑器 + 元数据栏
- 底部可折叠 `RedisCli`：命令历史、Tab 补全、Monitor 开关（轮询 `INFO commandstats`）；输入区和历史输出行右键可 Ask AI 解释当前命令及返回值，工具栏/右键菜单可为当前 Redis Tab 独立选择 AI 回答语言；DB-index 切换（`Redis DB index`）发 `SELECT n`
- `RedisNewKeyDialog` 模态：Key name / type / 初始值 / TTL 等字段（均 aria-label）
- **e2e 测试限制**：实际 key 操作需活的 Redis fixture，浏览器冒烟无法连接；smoke 只覆盖「SessionEditor 选 Redis proto → 保存 → 打开标签 → redis-key-browser / redis-cli 挂载」的路由路径，真实 SCAN/读写留待配置 Redis fixture 的手动/native 回归

### 24.2 HBase Shell 客户端 ✅

<!-- feature
id: F-DB-3
status: done
area: database/hbase
components: [HBaseShellTab, HBaseSchemaTree]
files:
  - src/components/database/HBaseShellTab.tsx
  - src/components/database/HBaseSchemaTree.tsx
  - src/lib/hbaseCommands.ts
  - src/lib/hbaseCompletions.ts
  - src/lib/hbaseStatements.ts
  - src/lib/databaseTabLimit.ts
controls:
  - id: remote-host
    selector: 'input[aria-label="Remote host"]'
    kind: interactive
    optional: true
  - id: namespace
    selector: 'input[aria-label="HBase namespace"]'
    kind: interactive
    optional: true
  - id: schema-tree
    selector: '[data-testid="hbase-schema-tree"]'
    kind: display
    optional: true
  - id: schema-filter
    selector: '[data-testid="hbase-schema-tree-filter"]'
    kind: interactive
    optional: true
  - id: query-library-tab
    selector: '[data-testid="hbase-query-library-tab"]'
    kind: interactive
    optional: true
  - id: save-query
    selector: '[data-testid="hbase-save-query"]'
    kind: interactive
    optional: true
  - id: tab-limit
    selector: '[data-testid="hbase-tab-limit"]'
    kind: interactive
    optional: true
  - id: run-current
    selector: '[data-testid="hbase-run-current-statement"]'
    kind: interactive
    optional: true
  - id: help-dialog
    selector: '[data-testid="hbase-help-dialog"]'
    kind: display
    optional: true
  - id: sidebar-drawer
    selector: '[data-testid="hbase-sidebar-drawer-handle"]'
    kind: interactive
    optional: true
  - id: connection-error-banner
    selector: '[data-testid="hbase-connection-error-banner"]'
    kind: display
    optional: true
-->

- HBase REST/native/thrift 会话使用同一多面板 shell 工作区、命令补全、写操作确认与结果表格；`Tab limit` 同时限制每个 session 的 query tabs 和每个 query 的 result tabs（默认 50）；连接失败时工作区和 Query Library 继续可用。
- Query Library 以稳定 HBase session id + namespace 过滤命令，打开后仍通过原 HBase statement runner 执行并参与退出 flush。

### 24.3 数据库 Query Library 与草稿持久化 ✅

<!-- feature
id: F-DB-4
status: done
area: database/queries
components: [QueryLibraryPanel]
files:
  - src/components/database/QueryLibraryPanel.tsx
  - src-tauri/src/database/query_workspace.rs
  - src-tauri/src/database/saved_queries.rs
  - src/lib/ipc.ts
  - src/stubs/tauri-core.ts
controls:
  - id: panel
    selector: '[data-testid="query-library-panel"]'
    kind: display
    optional: true
  - id: search
    selector: '[data-testid="query-library-search"]'
    kind: interactive
    optional: true
  - id: create
    selector: '[data-testid="query-library-create"]'
    kind: interactive
    optional: true
  - id: current-namespace
    selector: '[data-testid="query-library-current-namespace"]'
    kind: interactive
    optional: true
  - id: all-namespaces
    selector: '[data-testid="query-library-all-namespaces"]'
    kind: interactive
    optional: true
  - id: show-archived
    selector: '[data-testid="query-library-show-archived"]'
    kind: interactive
    optional: true
  - id: dialog
    selector: '[data-testid="query-library-dialog"]'
    kind: display
    optional: true
  - id: name
    selector: '[data-testid="query-library-name"]'
    kind: interactive
    optional: true
  - id: scope
    selector: '[data-testid="query-library-scope"]'
    kind: interactive
    optional: true
  - id: content
    selector: '[data-testid="query-library-content"]'
    kind: interactive
    optional: true
  - id: save
    selector: '[data-testid="query-library-save"]'
    kind: interactive
    optional: true
  - id: saved-query
    selector: '[data-testid^="saved-query-"]'
    kind: display
    optional: true
-->

- 匿名 SQL 草稿与 tab 顺序写入 SQLite workspace；已命名 Query 支持 connection/engine scope、catalog/database/schema namespace、搜索/标签、revision 冲突、归档与旧 Bookmark 幂等迁移。
- SQL、Redis 与 HBase 共用 Query Library。已保存 Query 与打开的编辑器保持 `savedQueryId` 链接，变更 debounce 落盘，关闭 tab/退出应用时 flush 最后一版。

## 15. Tao Notes 与 Tao Hub

### 15.1 Tao Notes（便签 / 备忘 / 任务）与统一 Tao Ribbon ✅

<!-- feature
id: F-TAO-1
status: done
area: notes
components: [TaoRibbon, NotesPanel, NotesList, NoteEditor, NoteFilters, NoteThemeSettings, FloatingNotesPanel, TaoAlertInbox, TaoAlertPoller]
files:
  - src-tauri/src/notes/db.rs
  - src-tauri/src/notes/commands.rs
  - src/lib/notes.ts
  - src/stores/notesStore.ts
  - src/stores/taoHubStore.ts
  - src/stores/taoAlertStore.ts
  - src/lib/tao/ribbonPlacement.ts
  - src/lib/tao/taoAlerts.ts
  - src/lib/notes/notesTheme.ts
  - src/lib/chat/chatDock.ts
  - src/components/notes/NotesPanel.tsx
  - src/components/notes/NotesList.tsx
  - src/components/notes/NoteEditor.tsx
  - src/components/notes/NoteFilters.tsx
  - src/components/notes/NoteThemeSettings.tsx
  - src/components/notes/FloatingNotesPanel.tsx
  - src/components/tao/TaoRibbon.tsx
  - src/components/tao/TaoAlertInbox.tsx
  - src/components/tao/TaoAlertPoller.tsx
controls:
  - id: tao-hub-tab-chat
    selector: '[data-testid="tao-hub-tab-chat"]'
    kind: interactive
    optional: true
  - id: tao-hub-tab-notes
    selector: '[data-testid="tao-hub-tab-notes"]'
    kind: interactive
    optional: true
  - id: tao-hub-tab-notifications
    selector: '[data-testid="tao-hub-tab-notifications"]'
    kind: interactive
    optional: true
  - id: tao-alert-inbox
    selector: '[data-testid="tao-alert-inbox"]'
    kind: display
    optional: true
  - id: tao-alert-inbox-item
    selector: '[data-testid="tao-alert-inbox-item"]'
    kind: display
    optional: true
  - id: tao-alert-history-search
    selector: '[data-testid="tao-alert-history-search"]'
    kind: interactive
    optional: true
  - id: tao-alert-history-clear
    selector: '[data-testid="tao-alert-history-clear"]'
    kind: interactive
    optional: true
  - id: tao-alert-history-limit-30
    selector: '[data-testid="tao-alert-history-limit-30"]'
    kind: interactive
    optional: true
  - id: tao-alert-history-limit-300
    selector: '[data-testid="tao-alert-history-limit-300"]'
    kind: interactive
    optional: true
  - id: tao-alert-history-result
    selector: '[data-testid="tao-alert-history-result"]'
    kind: display
    optional: true       # only visible when a history search has matches
  - id: notes-panel
    selector: '[data-testid="notes-panel"]'
    kind: display
    optional: true
  - id: notes-new
    selector: '[data-testid="notes-new"]'
    kind: interactive
    optional: true
  - id: notes-search
    selector: '[data-testid="notes-search"]'
    kind: interactive
    optional: true
  - id: notes-list-item
    selector: '[data-testid="notes-list-item"]'
    kind: interactive
    optional: true
  - id: notes-list
    selector: '[data-testid="notes-list"]'
    kind: display
    optional: true
  - id: notes-toggle-complete
    selector: '[data-testid="notes-toggle-complete"]'
    kind: interactive
    optional: true
  - id: notes-filter-menu
    selector: '[data-testid="notes-filter-menu"]'
    kind: interactive
    optional: true
  - id: notes-filter-recent
    selector: '[data-testid="notes-filter-recent_incomplete"]'
    kind: interactive
    optional: true
  - id: notes-filter-completed
    selector: '[data-testid="notes-filter-completed"]'
    kind: interactive
    optional: true
  - id: note-editor
    selector: '[data-testid="note-editor"]'
    kind: display
    optional: true
  - id: note-editor-title
    selector: '[data-testid="note-editor-title"]'
    kind: interactive
    optional: true
  - id: note-editor-back
    selector: '[data-testid="note-editor-back"]'
    kind: interactive
    optional: true
  - id: notes-settings-toggle
    selector: '[data-testid="notes-settings-toggle"]'
    kind: interactive
    optional: true
  - id: note-theme-settings
    selector: '[data-testid="note-theme-settings"]'
    kind: display
    optional: true
  - id: note-theme-select
    selector: '[data-testid="note-theme-select"]'
    kind: interactive
    optional: true
  - id: note-theme-paper
    selector: '[data-testid="note-theme-paper"]'
    kind: interactive
    optional: true       # only visible while the preview dropdown is open
  - id: note-panel-mode-floating
    selector: '[data-testid="note-panel-mode-floating"]'
    kind: interactive
    optional: true
  - id: floating-notes-panel
    selector: '[data-testid="floating-notes-panel"]'
    kind: display
    optional: true
  - id: floating-notes-dock
    selector: '[data-testid="floating-notes-dock"]'
    kind: interactive
    optional: true
  - id: tao-ribbon-badge
    selector: '[data-testid="tao-ribbon-badge"]'
    kind: display
    optional: true
-->

- 统一 `TaoRibbon` 四边任意位置悬浮入口，拖动落点决定 edge + offsetRatio（`localStorage: taomni.chatDrawer.layout.v1`），带节制的临期/过期/AI 完成 badge 与跳动提示
- `Tao Hub`：单一抽屉三个主 tab（`Chat` / `便签` / `通知`），记住上次非通知 tab（`localStorage: taomni.taoHub.lastTab.v1`）
- `便签`：独立 `notes.db` + 统一便签模型（完成 / 置顶 / 归档 / 颜色 / 优先级 / due / reminder / 步骤 / 标签）；默认「最近未完成」视图；搜索、过滤视图；主题 taomni/system/light/dark/paper/compact
- 单例 `FloatingNotesPanel`：hub ↔ floating 模式切换，可拖拽 / 调整大小，Taomni 内部置顶（层级低于 vault / 认证弹窗）
- `TaoAlertInbox` + `TaoAlertPoller`：便签临期(黄)/过期(红) + AI 后台完成(ai_done) + 邮件新消息汇聚，点击跳转目标或打开事件列表；通知历史默认隐藏，可搜索查询，支持 30/300 条保留上限与手工清空（`localStorage: taomni.taoAlerts.history.v1` / `taomni.taoAlerts.historyLimit.v1`）
- Chat 抽屉四边可 pinned：左右为侧栏、上/下为横向条（窄窗自动回退浮动，见 `resolveChatDock`）
- **e2e 测试限制**：Tauri 命令在浏览器模式走 stub（localStorage 模拟 notes.db）；真实持久化、跨进程提醒调度、原生窗口置顶不在浏览器冒烟覆盖，由 Rust / Vitest 单测承担。Ribbon 拖动、上/下 pin、告警优先级与跳转的判定逻辑分别由 `ribbonPlacement`/`chatDock`/`taoAlerts` 单测覆盖

---

## 13. Mail 客户端

### 13.1 写邮件联系人自动提示 ✅

<!-- feature
id: F-MAIL-1
status: done
area: mail/compose
components: [MailClientTab, RecipientField]
files:
  - src/components/mail/MailClientTab.tsx
  - src/components/mail/RecipientField.tsx
  - src/lib/mailRecipients.ts
  - src/lib/mail.ts
  - src-tauri/src/mail/mod.rs
controls:
  - id: mail-client-tab
    selector: '[data-testid="mail-client-tab"]'
    kind: display
  - id: compose-open
    selector: '[data-testid="mail-compose-open"]'
    kind: interactive
  - id: compose-dialog
    selector: '[data-testid="mail-compose-dialog"]'
    kind: display
  - id: recipient-to
    selector: '[data-testid="mail-recipient-to"]'
    kind: interactive
  - id: recipient-cc
    selector: '[data-testid="mail-recipient-cc"]'
    kind: interactive
  - id: recipient-bcc
    selector: '[data-testid="mail-recipient-bcc"]'
    kind: interactive
  - id: recipient-chip
    selector: '[data-testid="mail-recipient-chip"]'
    kind: display
  - id: recipient-suggestions
    selector: '[data-testid="mail-recipient-suggestions"]'
    kind: display
  - id: recipient-suggestion
    selector: '[data-testid="mail-recipient-suggestion"]'
    kind: interactive
  - id: compose-send
    selector: '[data-testid="mail-compose-send"]'
    kind: interactive
    optional: true       # send success/failure depends on SMTP config; recipient autocomplete is covered before send
-->

- `To` / `Cc` / `Bcc` 使用 chip 输入，支持粘贴多联系人、回车/Tab 接受建议、退格删除 chip。
- 联系人建议来自本地邮件缓存联系人索引（`mail_contacts`）和当前已加载邮件头，发送成功后提升 sent 联系人权重。
- 当缓存没有命中且当前输入形如 `si.li@` / `si.li@y` 时，基于当前账号邮箱域名自动提示 `si.li@yourmail.com`，Tab 可完成。
- 前端发送前会拦截空收件人和明显非法邮箱；后端 `lettre` 地址解析继续作为最终校验。

---

### 13.2 富文本写信、附件和本地草稿 ✅

<!-- feature
id: F-MAIL-2
status: done
area: mail/compose
components: [MailClientTab, RichMailEditor, RecipientField]
files:
  - src/components/mail/MailClientTab.tsx
  - src/components/mail/RichMailEditor.tsx
  - src/components/mail/RecipientField.tsx
  - src/lib/mailHtml.ts
  - src/lib/mail.ts
  - src/stubs/tauri-core.ts
  - src-tauri/src/mail/mod.rs
controls:
  - id: drafts-open
    selector: '[data-testid="mail-drafts-open"]'
    kind: interactive
  - id: drafts-dialog
    selector: '[data-testid="mail-drafts-dialog"]'
    kind: display
  - id: draft-row
    selector: '[data-testid="mail-draft-row"]'
    kind: interactive
  - id: compose-menu-bar
    selector: '[data-testid="mail-compose-menu-bar"]'
    kind: display
  - id: compose-subject
    selector: '[data-testid="mail-compose-subject"]'
    kind: interactive
  - id: format-toolbar
    selector: '[data-testid="mail-compose-format-toolbar"]'
    kind: display
  - id: format-block
    selector: '[data-testid="mail-compose-format-block"]'
    kind: interactive
  - id: font-family
    selector: '[data-testid="mail-compose-font-family"]'
    kind: interactive
  - id: font-size
    selector: '[data-testid="mail-compose-font-size"]'
    kind: interactive
  - id: text-color
    selector: '[data-testid="mail-compose-text-color"]'
    kind: interactive
    optional: true       # native color picker behavior is browser/OS dependent; component test covers the callback
  - id: bold
    selector: '[data-testid="mail-compose-bold"]'
    kind: interactive
  - id: italic
    selector: '[data-testid="mail-compose-italic"]'
    kind: interactive
  - id: underline
    selector: '[data-testid="mail-compose-underline"]'
    kind: interactive
  - id: clear-format
    selector: '[data-testid="mail-compose-clear-format"]'
    kind: interactive
  - id: bullet-list
    selector: '[data-testid="mail-compose-bullet-list"]'
    kind: interactive
  - id: number-list
    selector: '[data-testid="mail-compose-number-list"]'
    kind: interactive
  - id: outdent
    selector: '[data-testid="mail-compose-outdent"]'
    kind: interactive
  - id: indent
    selector: '[data-testid="mail-compose-indent"]'
    kind: interactive
  - id: align-left
    selector: '[data-testid="mail-compose-align-left"]'
    kind: interactive
  - id: align-center
    selector: '[data-testid="mail-compose-align-center"]'
    kind: interactive
  - id: align-right
    selector: '[data-testid="mail-compose-align-right"]'
    kind: interactive
  - id: link
    selector: '[data-testid="mail-compose-link"]'
    kind: interactive
    optional: true       # opens a URL prompt; covered by component tests to avoid prompt timing in smoke
  - id: insert-menu
    selector: '[data-testid="mail-compose-insert-menu"]'
    kind: interactive
  - id: insert-image
    selector: '[data-testid="mail-compose-insert-image"]'
    kind: interactive
  - id: insert-hr
    selector: '[data-testid="mail-compose-insert-hr"]'
    kind: interactive
    optional: true
  - id: insert-table
    selector: '[data-testid="mail-compose-insert-table"]'
    kind: interactive
    optional: true       # opens a table-size prompt; covered by component tests
  - id: emoji
    selector: '[data-testid="mail-compose-emoji"]'
    kind: interactive
  - id: emoji-laugh
    selector: '[data-testid="mail-compose-emoji-laugh"]'
    kind: interactive
  - id: compose-editor
    selector: '[data-testid="mail-compose-editor"]'
    kind: interactive
  - id: compose-attach
    selector: '[data-testid="mail-compose-attach"]'
    kind: interactive
  - id: compose-attachments
    selector: '[data-testid="mail-compose-attachments"]'
    kind: display
  - id: compose-attachment-chip
    selector: '[data-testid="mail-compose-attachment-chip"]'
    kind: display
  - id: compose-save-draft
    selector: '[data-testid="mail-compose-save-draft"]'
    kind: interactive
-->

- 写信窗口改为 HTML + 纯文本 fallback 双轨草稿，默认发送模式为 `auto`：只有使用富文本格式或检测到富文本结构时才发送 HTML body。
- 正文使用 `RichMailEditor` contenteditable 编辑器，提供段落、字体、字号、颜色、加粗/斜体/下划线、清除格式、列表、缩进、对齐、链接、Thunderbird 式表情菜单、插入菜单和附件入口。
- 插入菜单第一期支持本地图片内联 CID：正文写入 `<img src="cid:...">`，附件元数据保存 `inline/contentId`，发送时生成 `multipart/related`；普通附件同时存在时外层使用 `multipart/mixed`。
- 展示和编辑都经过 `mailHtml` 清洗；远程图片默认阻断，用户显式加载后才显示。
- 回复和转发保留原始 HTML 内容，回复按 Thunderbird 风格生成 `blockquote type="cite"` 引用和纯文本引用 fallback。
- 附件元数据随本地草稿保存，发送时后端按普通附件和内联 CID 图片分别生成 MIME。
- 本地草稿存入邮件缓存库（浏览器模式用 localStorage stub），支持手动保存、自动保存、Drafts 列表重开、丢弃和发送后删除。

---

### 13.3 邮箱刷新与正文预热 ✅

<!-- feature
id: F-MAIL-3
status: done
area: mail/sync
components: [MailClientTab]
files:
  - src/components/mail/MailClientTab.tsx
  - src/lib/mail.ts
  - src-tauri/src/mail/mod.rs
controls:
  - id: sync-button
    selector: '[data-testid="mail-sync-button"]'
    kind: interactive
  - id: body-warming-progress
    selector: '[data-testid="mail-body-warming-progress"]'
    kind: display
    optional: true       # only visible while recent uncached bodies are warming
-->

- 手工刷新、打开自动刷新和定时刷新默认只同步 headers；headers 写入缓存并重新加载列表后界面即可继续操作。
- 最近正文缓存改为前端后台 warming：按 `bodyRecentLimit` 遍历已缓存 headers，逐封调用 `mail_get_message_body`，并用独立进度显示。
- 邮件正文读取按 `folder:uid` 缓存在前端内存中；点击已缓存正文优先使用内存/SQLite，自动标记已读不再等待正文加载完成。

---

### 13.4 邮件会话外观主题 ✅

<!-- feature
id: F-MAIL-4
status: done
area: mail/settings
components: [SessionEditor, MailAppearanceSettings]
files:
  - src/components/session/SessionEditor.tsx
  - src/components/mail/MailAppearanceSettings.tsx
  - src/components/theme/themePreviews.tsx
controls:
  - id: mail-appearance-settings
    selector: '[data-testid="mail-appearance-settings"]'
    kind: display
  - id: mail-theme-select
    selector: '[data-testid="mail-theme-select"]'
    kind: interactive
  - id: mail-theme-options
    selector: '[data-testid^="mail-theme-option-"]'
    kind: interactive
    optional: true       # only visible while the preview dropdown is open
  - id: mail-appearance-preview
    selector: '[data-testid="mail-appearance-preview"]'
    kind: display
  - id: mail-background
    selector: 'input[aria-label="Mail background hex"]'
    kind: interactive
  - id: mail-foreground
    selector: 'input[aria-label="Mail foreground hex"]'
    kind: interactive
-->

- Mail session 的 Appearance 使用邮件专用主题面板，不再复用 Terminal behavior / cursor / scrollback 控件。
- 主题下拉整合 Match app theme、Code View 色板与 Terminal color themes，但预览统一使用邮件正文语义。
- 底部预览展示邮件列表 + HTML 正文片段。

---

## 14. SocksCap 网络流量路由

### 14.1 SocksCap 控制面板 🟡

<!-- feature
id: F-Sockscap-1
status: partial
area: network/sockscap
components: [SocksCapPanel]
files:
  - src/components/sockscap/SocksCapPanel.tsx
  - src/components/sockscap/SocksCapRootPrompt.tsx
  - src/lib/sockscap.ts
  - src/stubs/tauri-core.ts
controls:
  - id: tools-side-tab
    selector: '[data-testid="side-tab-tools"]'
    kind: interactive
  - id: tools-panel
    selector: '[data-testid="sidebar-tools-panel"]'
    kind: display
  - id: sidebar-entry
    selector: '[data-testid="sidebar-tool-sockscap"]'
    kind: interactive
  - id: panel
    selector: '[data-testid="sockscap-panel"]'
    kind: display
  - id: locked-banner
    selector: '[data-testid="sockscap-locked-banner"]'
    kind: display
    optional: true       # shown only while capture is preparing/running/stopping
  - id: add-profile
    selector: '[data-testid="sockscap-add-profile"]'
    kind: interactive
  - id: start
    selector: '[data-testid="sockscap-start"]'
    kind: interactive
  - id: stop
    selector: '[data-testid="sockscap-stop"]'
    kind: interactive
    optional: true       # shown after a running/degraded start result
  - id: refresh-status
    selector: '[data-testid="sockscap-refresh-status"]'
    kind: interactive
  - id: recover
    selector: '[data-testid="sockscap-recover"]'
    kind: interactive
  - id: profile-section-toggle
    selector: '[data-testid="sockscap-section-profile-toggle"]'
    kind: interactive
  - id: scope-section-toggle
    selector: '[data-testid="sockscap-section-scope-toggle"]'
    kind: interactive
  - id: upstream-section-toggle
    selector: '[data-testid="sockscap-section-upstream-toggle"]'
    kind: interactive
  - id: rules-section-toggle
    selector: '[data-testid="sockscap-section-rules-toggle"]'
    kind: interactive
  - id: test-section-toggle
    selector: '[data-testid="sockscap-section-test-toggle"]'
    kind: interactive
  - id: gfwlist-section-toggle
    selector: '[data-testid="sockscap-section-gfwlist-toggle"]'
    kind: interactive
  - id: domains-toggle
    selector: '[data-testid="sockscap-domains-toggle"]'
    kind: interactive
  - id: tun-warning
    selector: '[data-testid="sockscap-tun-warning"]'
    kind: interactive
    optional: true       # only when a local TUN client is detected
  - id: tun-warning-dialog
    selector: '[data-testid="sockscap-tun-warning-dialog"]'
    kind: display
    optional: true       # opened from the conditional TUN warning icon
  - id: tun-warning-close
    selector: '[data-testid="sockscap-tun-warning-close"]'
    kind: interactive
    optional: true       # shown inside the conditional TUN warning dialog
  - id: launch-only-banner
    selector: '[data-testid="sockscap-launch-only-banner"]'
    kind: display
    optional: true       # Linux only when transparent capture is unavailable
  - id: rootless-mode
    selector: '[data-testid="sockscap-rootless-mode"]'
    kind: display
    optional: true       # Linux launch-only configuration summary
  - id: rootless-app-editor
    selector: '[data-testid="sockscap-rootless-app-editor"]'
    kind: display
    optional: true       # Linux launch-only command editor
  - id: rootless-command
    selector: '[data-testid="sockscap-rootless-command"]'
    kind: interactive
    optional: true       # accepts an executable path or a command resolved through PATH
  - id: rootless-arguments
    selector: '[data-testid="sockscap-rootless-arguments"]'
    kind: interactive
    optional: true       # shell-style argument input for the launch command
  - id: rootless-launch-mode
    selector: '[data-testid="sockscap-rootless-launch-mode"]'
    kind: interactive
    optional: true       # desktop application or integrated-terminal TUI launch
  - id: add-rootless-application
    selector: '[data-testid="sockscap-add-rootless-application"]'
    kind: interactive
    optional: true       # saves the command without starting capture
  - id: pick-linux-application
    selector: '[data-testid="sockscap-pick-linux-application"]'
    kind: interactive
    optional: true       # Linux desktop browse action; launch-only mode only fills the command
  - id: launch-application
    selector: '[data-testid^="sockscap-launch-app-"]'
    kind: interactive
    optional: true       # one control per configured app in Linux launch-only mode
  - id: stop-launched-application
    selector: '[data-testid^="sockscap-stop-launched-app-"]'
    kind: interactive
    optional: true       # replaces Launch while that app is running
  - id: linux-capture-state
    selector: '[data-testid="sockscap-linux-capture-state"]'
    kind: display
    optional: true       # only when the desktop backend reports Linux
  - id: root-prompt-dialog
    selector: '[data-testid="sockscap-root-prompt-dialog"]'
    kind: display
    optional: true       # only after Linux capture requests authorization
  - id: root-password-input
    selector: '[data-testid="sockscap-root-password-input"]'
    kind: interactive
    optional: true       # only after Linux capture requests authorization
  - id: root-prompt-submit
    selector: '[data-testid="sockscap-root-prompt-submit"]'
    kind: interactive
    optional: true       # only after Linux capture requests authorization
  - id: root-prompt-cancel
    selector: '[data-testid="sockscap-root-prompt-cancel"]'
    kind: interactive
    optional: true       # only after Linux capture requests authorization
  - id: root-prompt-close
    selector: '[data-testid="sockscap-root-prompt-close"]'
    kind: interactive
    optional: true       # only after Linux capture requests authorization
  - id: refresh-gfw
    selector: '[data-testid="sockscap-refresh-gfw"]'
    kind: interactive
    optional: true       # shown only while the GFWList rule mode is selected
  - id: import-gfw
    selector: '[data-testid="sockscap-import-gfw"]'
    kind: interactive
    optional: true       # shown inside the collapsible GFWList section
  - id: rules-editor
    selector: '[data-testid="sockscap-rules-editor"]'
    kind: display
    optional: true       # shown inside the collapsible rules section
  - id: block-quic
    selector: '[data-testid="sockscap-block-quic"]'
    kind: interactive
    optional: true       # shown inside the collapsible GFWList section
  - id: test-host
    selector: '[data-testid="sockscap-test-host"]'
    kind: interactive
  - id: test-target
    selector: '[data-testid="sockscap-test-target"]'
    kind: interactive
  - id: helper-start
    selector: '[data-testid="sockscap-helper-start"]'
    kind: interactive
    optional: true       # privileged desktop helper; unavailable in browser preview
  - id: windivert-probe
    selector: '[data-testid="sockscap-windivert-probe"]'
    kind: interactive
    optional: true       # Windows-only helper diagnostic
-->

- 提供全局/按应用 TCP 路由、上游代理、GFWList、规则 dry-run、状态与流量统计的控制面板。
- Linux 有权限时继续通过 nftables + cgroup v2 做透明 TCP 重定向；无 sudo、受限桌面容器等环境自动切换为“从 SocksCap 启动应用”的 loopback 捕获，不注入 HTTP_PROXY/ALL_PROXY 等代理变量。该模式只覆盖由面板启动的动态链接应用及其继承进程。
- 浏览器预览覆盖控制面板状态流转；内核捕获和原始目标恢复由 Rust 单元/集成验证覆盖。

---

## 25. Code Workspace 多语言 Build / Run / Debug

### 25.1 结构化执行目标与工具配置 🟡

<!-- feature
id: F25.1
status: partial
area: code-workspace/execution
components: [CodeWorkspaceTab, RunPanel, BuildPanel, BottomDock, WorkspaceBuildRunToolsDialog]
files:
  - src/components/sidebar/Sidebar.tsx
  - src/components/editor/CodeWorkspaceTab.tsx
  - src/components/editor/workspace/panels/RunPanel.tsx
  - src/components/editor/workspace/panels/BuildPanel.tsx
  - src/components/editor/workspace/panels/BottomDock.tsx
  - src/components/editor/workspace/WorkspaceBuildRunToolsDialog.tsx
  - src/components/editor/workspace/panels/DebugPanel.tsx
  - src/lib/terminal/commandInput.ts
  - src-tauri/src/workspace_execution.rs
  - src-tauri/src/dap.rs
controls:
  - id: sidebar-entry
    selector: '[data-testid="sidebar-tool-code-workspace"]'
    kind: interactive
  - id: workspace
    selector: '[data-testid="code-workspace-tab"]'
    kind: display
  - id: build-current-project
    selector: '[data-testid="code-workspace-build-project"]'
    kind: interactive
    optional: true       # enabled only when the workspace has a project root
  - id: run-current-target
    selector: '[data-testid="code-workspace-run-target"]'
    kind: interactive
    optional: true       # enabled only when the active file maps to a run configuration
  - id: debug-current-target
    selector: '[data-testid="code-workspace-debug-target"]'
    kind: interactive
    optional: true       # desktop-only and requires an available adapter
  - id: run-tab
    selector: '[data-testid="code-workspace-bottom-tab-run"]'
    kind: interactive
  - id: build-tab
    selector: '[data-testid="code-workspace-bottom-tab-build"]'
    kind: interactive
  - id: debug-tab
    selector: '[data-testid="code-workspace-bottom-tab-debug"]'
    kind: interactive
  - id: run-panel
    selector: '[data-testid="code-workspace-run-panel"]'
    kind: display
  - id: custom-command
    selector: '[data-testid="run-panel-custom-command"]'
    kind: interactive
  - id: add-custom-task
    selector: '[data-testid="run-panel-add-custom-task"]'
    kind: interactive
  - id: custom-root
    selector: '[data-testid="run-panel-custom-root"]'
    kind: interactive
    optional: true       # rendered only for a multi-root workspace
  - id: configure-tools
    selector: '[data-testid="run-panel-configure-tools"]'
    kind: interactive
  - id: refresh-run-targets
    selector: '[data-testid="run-panel-refresh"]'
    kind: interactive
  - id: run-configuration
    selector: '[data-testid^="run-panel-configuration-run:"]'
    kind: interactive
    optional: true       # requires a language fixture with a detected run target
  - id: run-configuration-edit
    selector: '[data-testid^="run-panel-configuration-edit-run:"]'
    kind: interactive
    optional: true       # requires a language fixture with a detected run target
  - id: run-configuration-editor
    selector: '[data-testid="run-configuration-editor"]'
    kind: display
    optional: true
  - id: run-configuration-cwd
    selector: '[data-testid="run-configuration-cwd"]'
    kind: interactive
    optional: true
  - id: run-configuration-args
    selector: '[data-testid="run-configuration-args"]'
    kind: interactive
    optional: true
  - id: run-configuration-env
    selector: '[data-testid="run-configuration-env"]'
    kind: interactive
    optional: true
  - id: run-configuration-save
    selector: '[data-testid="run-configuration-save"]'
    kind: interactive
    optional: true
  - id: run-configuration-reset
    selector: '[data-testid="run-configuration-reset"]'
    kind: interactive
    optional: true
  - id: build-panel
    selector: '[data-testid="code-workspace-build-panel"]'
    kind: display
  - id: build-error
    selector: '[data-testid="build-panel-error"]'
    kind: display
    optional: true       # rendered only when target discovery fails
  - id: build-project
    selector: '[data-testid="build-panel-build-project"]'
    kind: interactive
    optional: true       # enabled only after a build target is detected
  - id: rebuild-project
    selector: '[data-testid="build-panel-rebuild-project"]'
    kind: interactive
    optional: true       # currently available only for compatible Java tasks
  - id: refresh-build-targets
    selector: '[data-testid="build-panel-refresh"]'
    kind: interactive
  - id: build-target
    selector: '[data-testid^="build-panel-target-build:"]'
    kind: interactive
    optional: true       # requires a language fixture with a detected build target
  - id: debug-panel
    selector: '[data-testid="code-workspace-debug-panel"]'
    kind: display
  - id: tools-dialog
    selector: '[data-testid="workspace-build-run-tools-dialog"]'
    kind: display
  - id: tools-close
    selector: '[data-testid="workspace-build-run-tools-close"]'
    kind: interactive
  - id: tools-cancel
    selector: '[data-testid="workspace-build-run-tools-cancel"]'
    kind: interactive
  - id: tools-save
    selector: '[data-testid="workspace-build-run-tools-save"]'
    kind: interactive
  - id: tool-cargo
    selector: '[data-testid="workspace-tool-cargo"]'
    kind: interactive
  - id: tool-go
    selector: '[data-testid="workspace-tool-go"]'
    kind: interactive
  - id: tool-node
    selector: '[data-testid="workspace-tool-node"]'
    kind: interactive
  - id: tool-npm
    selector: '[data-testid="workspace-tool-npm"]'
    kind: interactive
  - id: tool-pnpm
    selector: '[data-testid="workspace-tool-pnpm"]'
    kind: interactive
  - id: tool-yarn
    selector: '[data-testid="workspace-tool-yarn"]'
    kind: interactive
  - id: tool-python
    selector: '[data-testid="workspace-tool-python"]'
    kind: interactive
  - id: tool-cmake
    selector: '[data-testid="workspace-tool-cmake"]'
    kind: interactive
  - id: tool-dotnet
    selector: '[data-testid="workspace-tool-dotnet"]'
    kind: interactive
  - id: tool-maven
    selector: '[data-testid="workspace-tool-maven"]'
    kind: interactive
  - id: tool-gradle
    selector: '[data-testid="workspace-tool-gradle"]'
    kind: interactive
  - id: tool-sbt
    selector: '[data-testid="workspace-tool-sbt"]'
    kind: interactive
  - id: tool-swift
    selector: '[data-testid="workspace-tool-swift"]'
    kind: interactive
  - id: tool-lldb-dap
    selector: '[data-testid="workspace-tool-lldbDap"]'
    kind: interactive
  - id: tool-delve
    selector: '[data-testid="workspace-tool-delve"]'
    kind: interactive
  - id: tool-debugpy
    selector: '[data-testid="workspace-tool-debugpy"]'
    kind: interactive
  - id: tool-js-debug
    selector: '[data-testid="workspace-tool-jsDebug"]'
    kind: interactive
  - id: tool-netcoredbg
    selector: '[data-testid="workspace-tool-netcoredbg"]'
    kind: interactive
  - id: maven-jvm-args
    selector: '[data-testid="workspace-maven-run-jvm-args"]'
    kind: interactive
  - id: inherit-maven-argline
    selector: '[data-testid="workspace-maven-inherit-argline"]'
    kind: interactive
-->

- 后端统一发现项目、结构化 Build/Run/Debug 目标和工具可用性；项目 wrapper 优先于 workspace override 和 PATH，缺失工具提供明确安装提示。
- Run/Build 面板区分一等运行配置/构建目标与兼容任务；运行配置的 args、env、cwd 按 workspace 和 stable id 本地保存。
- 顶部 Run/Debug 随当前文件能力启用，内置 argv 按实际终端 shell 安全渲染；DAP 支持 stdio 与托管 TCP adapter 生命周期。
- 当前为部分完成：Rust/Go/Python/Node/Swift 已接入首批 Run/Debug，CMake/.NET/JVM provider 仍有 artifact、BSP/DAP 和跨平台 native smoke 待补。

---


> 下述入口已经在 UI 中可见但点击会显示 "not active in this phase" 占位面板，对应能力**尚未实装**，本清单不视为完成项，仅在此说明以解释 UI 为何存在：
>
> - Ribbon `Tools`（除 Tunneling 之外的网络工具）
> - Ribbon `Packages`、`Macros`
> - SFTP 底部的 "Cross-host transfer (remote ↔ remote)" 按钮（disabled 占位）
