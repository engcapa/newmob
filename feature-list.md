# NewMob 已完成功能清单

> 本文档基于当前仓库代码 + `IMPLEMENTATION_PLAN.md` / `TERMINAL_EXPERIENCE_PLAN.md` / `TERMINAL_APPEARANCE_PLAN.md` / `ipc-improve-plan.md` / `replit.md` / `testcase-for-auto.md` 的标记，**仅记录已实现并接入主流程的功能**。
> 标记说明：
> - ✅ 已完成
> - 🟡 已部分完成（关键路径可用，仍有未覆盖的能力，列出具体范围）
> - 未完成的能力不写入本文档（详见各 plan 文档的待办项）
> 当前对照版本：v0.1.0 → v0.1.17（含本仓库 `package.json` 标识的当前版本）。

---

## 1. 应用框架与主界面

### 1.1 工程基座 ✅
- Tauri 2 + React 18 + TypeScript + Vite 桌面工程已搭建
- Rust 后端模块拆分：`terminal / session / filebrowser / tunnel / appearance / config / state`
- 前端目录拆分：`components / layouts / lib / stores / hooks / stubs / types`
- 同时支持 **Tauri 桌面打包模式** 与 **Vite 浏览器开发预览模式**（通过 `TAURI_ENV_PLATFORM` 自动切换 stub/真实后端）

### 1.2 主窗口三栏布局 ✅
- 顶部菜单栏 `MenuBar`（File/Edit/View/Sessions/Tools/Help）
- Ribbon 工具条 `Ribbon`（Session、Servers、Tools、Games、Sessions、View、Split、MultiExec、Tunneling、Packages、Settings、Help、X server、Exit）
- 地址栏式快速连接 `QuickConnect`
- 左侧可拖拽/可折叠 Sidebar
- 中间 Tab 栏 + 内容区
- 底部状态栏 `StatusBar`（活跃连接数、当前应用主题、状态消息）
- 侧边栏宽度通过 `react-resizable-panels` 持久化

### 1.3 自定义标题栏与窗口控制 ✅
- 取消原生 decorations，前端自绘 `AppTitleBar` + `WindowControls`（最小化 / 最大化 / 关闭）
- 标题栏托盘 `TitleBarTrayControls`：主题循环按钮（Light / Dark / Follow system）+ 紧凑模式开关
- `WindowResizeHandles` 在无 decorations 模式下提供 8 向窗口缩放（North/South/East/West/四个角）
- 主菜单 / Sessions / View / Tunneling / Settings / Help / Exit 入口接入

### 1.4 紧凑 UI 模式（Compact mode）✅
- 默认布局 vs 紧凑布局可一键切换，状态持久化到 `localStorage` (`newmob.compactMode`)
- 紧凑模式下使用 `CompactTitleBar`：主菜单按钮 + 标签栏 + 托盘控件统一在一行
- 标题栏内置主菜单：新建本地/远程会话、新建 SFTP、关闭活动标签、Sessions、View、Tunneling、Settings、Help、Exit
- 快捷键 Ctrl+Shift+M 切换紧凑模式

### 1.5 标签页系统 ✅
- 多标签：本地终端 / SSH 终端 / SFTP / VNC / 设置 / 隧道管理 / Welcome / 占位标签
- 标签操作：新建、切换、关闭、中键关闭
- 标签右键菜单：关闭、关闭其他、关闭全部、复制标签、新建本地终端
- SSH / SFTP / VNC 标签 **常驻挂载**（切换标签不销毁，传输/输出/连接不中断）
- 关闭应用前若有终端活跃会弹出确认

### 1.6 欢迎页 `WelcomePanel` ✅
- 启动入口：开始本地终端、新建会话、导入 OpenSSH config
- 显示活跃连接列表

### 1.7 状态栏 ✅
- 显示活跃连接数
- 显示当前应用主题（Light / Dark / Follow system）
- 显示瞬时状态消息（操作反馈）

### 1.8 关于对话框 `AboutDialog` ✅
- Help 菜单入口
- 展示应用图标、`Version` 字段（来自 `__APP_VERSION__` 注入的 `package.json` 版本号）
- Esc / 点击遮罩 / Close 按钮均可关闭

---

## 2. 本地终端（Local Terminal）

### 2.1 PTY 后端 ✅
- Rust 端基于 `portable-pty` 创建 PTY（Linux/macOS/Windows）
- 平台默认 shell 自动判定（bash / zsh / powershell）
- 命令：`create_local_terminal` / `write_terminal` / `resize_terminal` / `close_terminal`
- 数据通路：默认通过 `terminal-output-{sid}` event 推送；Tauri 2 IPC channel 改造后改用 `tauri::ipc::Channel<InvokeResponseBody>` 直传二进制，去掉 base64 编解码与字符串拷贝
- 桌面启动器中 `TERM` 缺失的回归已修复（保证 vi、TUI 程序可用）

### 2.2 终端面板 `TerminalPanel` ✅
- xterm.js + FitAddon + WebglAddon（失败回退 canvas）+ SearchAddon + WebLinksAddon
- ResizeObserver + debounce 自动 fit
- 容器卸载时正确 dispose 终端实例与监听器
- 命令历史持久化：每条 host 维度记录到 SQLite (`command_history` 表)，支持 `history_append / history_match_prefix / history_list_recent / history_clear`
- Inline ghost-text 自动补全：基于 host 命令历史的前缀匹配，按右箭头 / End / Tab 接受建议（PowerShell 本地终端关闭以避免与 PSReadLine 冲突）
- Common commands 调色板（`CommonCommandsPalette`）：合并历史 + 用户自定义 + 平台预置命令（Windows / Unix），在本地终端中可调出
- SSH 终端连接进度态 UI（连接中 / 已建立 / 断开）有更连贯的过渡

### 2.3 终端连接状态 ✅
- SSH 终端启动期 UI：占位骨架 + "Connecting…"，连接成功后无缝切换到 xterm 渲染
- 端会话失败时给出错误提示

### 2.4 本地 shell 选择 ✅
- `list_local_shells` 列出系统 shell
- `open_local_shell_as_administrator` 以管理员身份启动（平台支持时）
- 支持选择 shell 启动本地终端

### 2.5 本地真实信号投递 🟡
- 已实现 Unix `SIGINT / SIGTERM / SIGKILL / SIGQUIT / SIGHUP`
- 跨平台对齐尚未完整覆盖

---

## 3. SSH 终端

### 3.1 SSH 后端（russh）✅
- `create_ssh_terminal` / `test_ssh_connection` / `send_terminal_signal`
- 三种认证：Password、PrivateKey（密钥文件）、Agent
- 请求 PTY channel（term=`xterm-256color`），启动 shell
- SSH channel 与本地 PTY 共用相同的 event 推送通道
- Windows 11 上私钥认证失败的兼容性问题已修复

### 3.2 高级 SSH 能力 ✅
- ProxyJump（跳板机）：`forwards.rs` 实现 direct-tcpip 链路
- Agent 转发
- X11 转发（Linux）
- Keepalive 定时包
- 断线检测 + 状态事件
- 网络代理配置（`network.rs` 入口）

### 3.3 OSC 7 工作目录广播 ✅
- 终端解析 `\e]7;file://host/path\e\` 序列
- 通过 `onCwdChange` prop 同步给主布局
- 连接成功后自动注入 `PROMPT_COMMAND` (bash) / `precmd_functions` (zsh) 来周期性发出 OSC 7
- 高级设置中可按会话开关 OSC 7 自动注入

### 3.4 浏览器预览模式下的 SSH 桥接（开发用）✅
- Vite 插件 `sshProxy.ts` + WebSocket `/__newmob/ssh-bridge`
- 浏览器内连接真实 SSH 服务器（仅密码与内联私钥）
- 仅 dev 模式启用，不进入 desktop release 包

---

## 4. 终端右键菜单与操作（MobaXterm 同款）

### 4.1 复制粘贴查找 ✅
- Copy / Copy All / Paste / Paste with Shift+Insert
- 跨平台复制/粘贴快捷键：macOS `Cmd+C / Cmd+V`，Windows / Linux `Ctrl+Shift+C / Ctrl+Shift+V`
- **CopyOnSelect**：选区释放后自动复制到剪贴板（开关存在 `terminalProfile`，每会话可覆盖）
- **中键粘贴（middle-click paste）**：当前选区优先，无选区则回退剪贴板内容；read-only 模式下被拦截
- Find（Ctrl+Shift+F），结果计数、上下匹配、关闭
- HTML + 纯文本剪贴板写入（`ClipboardItem` 可用时）

### 4.2 字体与显示 ✅
- 字体设置子菜单：切换字体家族、显示字体连字、字号增大/减小/重置
- Ctrl+滚轮调整字号、Ctrl+0 重置
- Terminal display 子菜单：Reset terminal output、Clear scrollback、Set terminal title、Toggle scrollbar、Fullscreen (F11)、Read-only

### 4.3 语法高亮 ✅
- Default / Error-Warning-Success keywords / Unix shell / Cisco / Perl / SQL
- Read-only 模式下输入被拦截，输出仍正常渲染

### 4.4 宏录制与回放 ✅
- 录制新宏、执行宏（Ctrl+Space）

### 4.5 输出导出 ✅
- Save to file（Ctrl+Shift+S）：浏览器下载导出当前 buffer
- Record terminal output to file：实时记录会话输出

### 4.6 特殊命令 / 信号 🟡
- 已实现：Local 端真实 Unix 信号、SSH channel 信号 + Ctrl+C 兜底 SIGINT、Break、IGNORE message
- 未实现：SSH break request、跨平台完整信号矩阵

### 4.7 事件日志 🟡
- 已记录：connect / auth / resize / disconnect / error / 导出 / 日志 / 宏 / 信号
- 未记录：reconnect 事件（重连流程尚未上线）

### 4.8 快捷键 ✅
- Shift+Insert 粘贴、Ctrl+Shift+F 查找、F11 全屏、Ctrl+0 重置字号、Ctrl+滚轮缩放字号
- macOS Cmd+C / Cmd+V，Windows / Linux Ctrl+Shift+C / Ctrl+Shift+V

### 4.9 Linux 中文输入兼容 ✅
- WebKitGTK 下 IME composition/preedit guard
- 防止中文重复回显，commit 阶段唯一放行
- `compositionend`/`beforeinput` fallback、组合时间窗内的去重

### 4.10 Z-modem 文件收发（rz / sz）✅
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
- Ribbon 入口 + 全局 `Ctrl+Alt+M` 切换
- 选中多个标签后，输入广播到所有被选中的终端
- `MultiExecBar`：紧凑发送条 + 可拖拽的展开编辑器（多行文本、最近命令历史、回车 / Ctrl+Enter 发送）
- 选中状态在 TabBar 上有视觉标记（`isMultiExecTarget`）

### 4.12 Common commands 调色板 ✅
- 本地终端中通过快捷键调出 `CommonCommandsPalette`
- 候选合并三类来源并去重：命令历史（host 维度）、用户自定义命令、平台预置命令（Windows / Unix 各一套，覆盖 nav / git / network / process / system / files / env）
- 选中后注入到当前终端

### 4.13 终端截图 / 滚动截屏 / GIF 录制 ✅
- 终端面板内嵌 `CaptureToolbar`（通过 `FloatingToolbar` 浮窗承载，可拖拽 / 折叠 / 位置持久化）
- **可见区域 PNG**：截取当前可见 viewport，可保存到磁盘或写入剪贴板（`ClipboardItem`）
- **滚动截屏**：滚动捕获整段 scrollback 拼接为单张长图（`startScrollCapture`）
- **GIF 录制**：基于 `gifenc` 的实时录制，工具条显示计时与 Stop；保存为 .gif
- 文件名前缀按上下文（terminal / vnc）自动生成时间戳后缀

---

## 5. 终端外观与配置

### 5.1 OS 字体枚举 ✅
- Tauri 命令 `list_system_fonts`（基于 `font-kit`）
- 前端 IPC 拉取系统字体列表，加载失败时使用安全 fallback
- Source Code Pro 在可用时作为默认字体

### 5.2 终端主题画廊（Termius 风格）✅
- 多套预置主题，带可视化预览
- 主题元数据驱动 UI
- 终端右键菜单可快速切换主题（无需重连重挂载）

### 5.3 共享外观控件 `TerminalAppearanceSettings` ✅
- 字体选择器、字号 stepper、主题画廊、底部预览
- 光标样式（block / underline / bar）+ 闪烁
- Scrollback 行数、日志、关键字高亮、显示项、剪贴板/粘贴策略
- 同一控件复用于全局设置面板与会话编辑器
- 实时预览反映光标样式与闪烁状态

### 5.4 配置持久化 ✅
- 全局终端配置：`localStorage`（默认值，未保存会话使用）
- 每会话 override：`session.options_json.terminalProfile`
- 活跃终端可在不重启的情况下应用主题/字体/字号/连字变化

### 5.5 应用整体主题（Light / Dark / Follow system）✅
- `localStorage` key `newmob.appTheme.v1`
- `data-app-theme` 应用到 root document
- Follow system 监听 `prefers-color-scheme` 变化
- 全局 Settings、Welcome、顶部菜单、会话设置标题栏均可快速切换主题
- MenuBar / Ribbon / QuickConnect / Tabs / Sidebar / StatusBar / Cards / Inputs / Buttons / 右键菜单 / 会话设置 / 认证弹窗 全部接入主题变量

---

## 6. 会话管理

### 6.1 SQLite 会话存储 ✅
- 表：`sessions` + `session_groups`
- 命令：`list_sessions / get_session / save_session / delete_session / mark_session_connected / list_session_groups / save_session_group / delete_session_group`
- 应用启动时初始化于 `app_data_dir/newmob.db`
- 浏览器预览模式回退到 `localStorage`（key `newmob.sessions.v1` / `newmob.groups.v1`）

### 6.2 会话树 `SessionTree` ✅
- 分组树（展开 / 折叠 / 拖拽到分组）
- 搜索框 `session-search`
- 双击 → 触发连接
- 右键菜单：Connect / Edit / Duplicate / Move to folder / Delete
- 「最近连接」区域

### 6.3 会话编辑器 `SessionEditor` ✅
- 协议选择：SSH、SFTP、RDP、VNC（SSH/SFTP 已实装；VNC 为基础 client 支持；RDP 仍占位）
- 基础设置：host、port、username、auth method
- Advanced SSH：SSH-browser type、Auto-inject OSC 7、Execute command、跳板机/代理
- Terminal：复用 `TerminalAppearanceSettings` 全套外观控件
- Network：Keep-alive、proxy 配置、隧道转发列表（local/remote/dynamic 添加）
- Bookmark：name、group、tags、描述备注
- 顶部主题快速切换条
- Session 类型 LocalShell：在编辑器中设置启动参数

### 6.4 快速连接栏 `QuickConnect` ✅
- 地址栏式输入：`ssh://user@host:port`、`ssh user@host:port`
- 自动解析协议/用户/主机/端口
- Enter 提交后弹出认证弹窗（密码场景）

### 6.5 认证弹窗 `AuthPrompt` ✅
- 密码输入弹窗
- 空密码不可提交（防 Enter 误触）

### 6.6 OpenSSH 配置导入 ✅
- 解析 `~/.ssh/config` 并批量导入会话
- Welcome 页提供入口

### 6.7 会话 import/export 工具 ✅
- `src/lib/sessionImportExport.ts` 提供导入导出能力（含单元测试）

---

## 7. SFTP 文件浏览器

### 7.1 SFTP 后端（russh-sftp 2.x）✅
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
- 远程面板 + 本地面板（左右或上下，可切换 orientation）
- 列：图标 / 名称 / 大小 / 修改时间 / 类型 / 权限 / 所有者
- 列头点击排序
- 路径面包屑 + 路径输入框（Enter 跳转）
- 工具条：刷新、上一级、Home、新建文件、新建文件夹、上传、下载、预览、删除
- 多选 + 全选
- 本地新建文件、本地删除、本地上传到远程
- 远程预览（`sftp_remote_preview`）

### 7.3 文件传输队列 ✅
- 状态：进度条、速度、ETA、状态徽章
- 操作：暂停 / 恢复 / 取消 / 重试
- 暂停事件 `sftp-paused-{id}` 即时反馈
- 文件夹传输：双向 `sftp_upload_dir` / `sftp_download_dir`（预先 dir_size 计算总量，按文件聚合进度）
- 跨窗口同步：`BroadcastChannel newmob.sftp.sync` 镜像同源窗口的传输队列
- 入队时记录 `kind: file | dir`，重试路由到正确命令
- 批量上传 / 下载吞吐优化：合并复制粘贴和拖拽路径，减少多文件场景下的 IPC 抖动
- 复制粘贴：跨面板复制粘贴文件（参考 OS 行为，配合 `application/x-newmob-files` MIME）

### 7.4 SFTP 入口（三种）✅
- **附加侧边栏**：每个 SSH 终端右上角 `attached-sftp-toggle`，与终端共用凭证；远程面板首次跟随 OSC 7 跳转一次，工具条 Sync 按钮可手动重跳
- **独立标签页**：从会话编辑器选择 `SessionType::SFTP` → 全标签 `FileBrowser`，未激活时仍挂载以保持传输
- **分离窗口**：附加 / 独立两种均提供 Detach 入口
  - Tauri：通过 `open_sftp_window` 打开真实 OS WebviewWindow
  - 浏览器：`window.open` 兜底
  - 使用独立 sessionId（`__detached`）避免与父窗口共享 SFTP channel
  - 通过 `localStorage` `newmob.sftp.detached.<sid>` 传递凭证
  - 父窗口 OSC 7 cwd 通过 `BroadcastChannel` 同步给分离窗口

### 7.5 面板交互 ✅
- 右键菜单：
  - 远程：Download to local、Rename、Permissions（chmod）、Delete、New folder、New file
  - 本地：对应操作
- chmod 对话框：Owner / Group / Other 三组权限位 + Apply
- 跨面板拖拽（REMOTE↔LOCAL）：HTML5 drag-drop + `application/x-newmob-files` MIME，支持多选与文件夹
- OS 文件拖入面板：**已禁用**（占位提示用工具栏 Upload）；Tauri 主窗口与分离窗口都设置 `dragDropEnabled=false`
- 双击文件：下载后用系统编辑器打开（"先下载"确认）
- Open terminal here：把远程当前路径发到关联终端（`cd 'path'`）

### 7.6 同步与方向控制 ✅
- 终端 cwd → 远程面板：一次性首次同步 + 手动 Sync 按钮（不再连续追踪）
- Pane orientation：横向/纵向布局切换 + per-scope 持久化（`newmob.sftp.orientation.<scope>`）
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
- 列表展示：类型、状态徽章（运行/错误/停止）、本地端口 → 远程地址、关联会话、认证图标
- 操作：启动 / 停止 / 启动全部 / 停止全部 / 测试 / 编辑 / 复制 / 删除 / 显示隐藏认证 / 拖拽排序
- 实时状态订阅 `listenTunnelStatus`
- 编辑器 `TunnelEditor`：填写所有字段、验证

---

## 9. VNC 客户端

### 9.1 嵌入式 VNC client（RFB 协议引擎）✅
- Rust 端 VNC 模块：`src-tauri/src/vnc/{mod, rfb, ws, encodings, clipboard}.rs`
- Tauri 命令：`vnc_connect / vnc_disconnect / vnc_test_connection`
- 本地动态端口 WebSocket relay：VNC server ↔ 前端 Canvas（前端不再直接持有 TCP 套接字）

### 9.2 RFB 握手与认证 ✅
- 安全类型：None、VNC password、RealVNC RA2 / RA2ne（128 / 256 位 AES）
- RA2 子模式：USER_PASS、PASS-only；公钥位长度合法性校验（1024–8192 bit）

### 9.3 编码与画面 ✅
- 解码器：Raw（0）、CopyRect（1）、Hextile（5）、ZRLE（16，单一持久 zlib 流）
- 伪编码：DesktopSize（-223）+ 自动 SetDesktopSize 回写，远端分辨率切换不掉线
- ZRLE 单 zlib 状态贯穿整个 session，已修复历史的 "zrle: eof cpixel" 间歇性断连
- 像素格式 `set_pixel_format_rgba()` 协商成 little-endian RGBA，前端按位图直接渲染
- Tight 编码暂未启用（解码器尚未 RFC-conformant，避免 stream 失步）

### 9.4 ExtendedClipboard 互通 ✅
- 实现 ExtendedClipboard 伪编码（`0xC0A1E5CE` + 旧 draft 值 `-1063` 双广告兼容）
- 支持 actions：caps / request / peek / notify / provide
- 支持 formats：text (UTF-8)、HTML、RTF（zlib 压缩）
- 老服务器（vino 等）回落 legacy `ServerCutText / ClientCutText` 路径，并已修复中文剪贴板丢失 / Windows 11 端到端粘贴乱码 / 非 ASCII 粘贴丢失等回归
- 前端 ↔ 后端剪贴板桥：`vncStore` 协调，文本/HTML/RTF 选择性传输

### 9.5 输入处理 ✅
- 鼠标：左/中/右键、滚轮、拖拽（pointer capture）
- 键盘：包含 RealVNC 输入修复，组合键正确转发
- 剪贴板：双向同步，自动切换 Extended / Legacy

### 9.6 前端 `VncPanel` ✅
- Canvas 画面渲染 + fit / 1:1 缩放
- 浮动 `FloatingToolbar`：可拖拽 / 折叠 / 位置持久化
- 内嵌 `CaptureToolbar`：可见区域 PNG / 全帧 PNG / GIF 录制（与终端共用截图链路）
- 断开提示 + Reconnect、错误分类（区分用户主动断开 / 服务端断开 / 网络异常）
- 保存的 VNC 会话可从会话树双击连接，密码场景复用 `AuthPrompt`
- VNC tab 常驻挂载，切换标签时连接不主动销毁
- 已修复 VNC 剪贴板与输入延迟、Windows 11 上的 client→server 文本粘贴

### 9.7 已知限制
- RDP 未实装（仍占位）
- QuickConnect 的 VNC URL 尚未接入主流程（已保存的 VNC 会话连接路径不受影响）
- 浏览器预览模式没有 VNC stub（仅 Tauri 桌面下可用）

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
- Application Theme 切换（Light / Dark / Follow system）
- Terminal Appearance 区块（与会话编辑器 Terminal 段一致的完整外观与行为控件）
- 终端预览
- 设置项即时持久化

---

## 12. 自动化测试基线

### 12.1 单元测试（Vitest）✅
- 测试文件 15 个，覆盖：
  - `ChmodDialog`、`FileToolbarWiring`、`SftpPolish`
  - `SessionEditor`
  - `AppThemeSwitcher`、`SettingsPanel`、`TerminalAppearanceSettings`
  - `MainLayout`
  - `CommonCommandsPalette`、`TerminalPanel`
  - `clipboard`、`zmodem`、`terminalOutputFilter`、`terminalImeGuard`、`sessionImportExport`

### 12.2 Rust 测试 ✅
- `appearance::lists_installed_font_families` 验证 OS 字体枚举
- VNC `encodings` 模块单元测试（Hextile / ZRLE 解码、跨 rectangle 共享 zlib 状态）
- VNC `clipboard` 模块单元测试（Extended caps body 编/解码）
- `cargo check` 通过

### 12.3 端到端测试用例（`testcase-for-auto.md`，被 `qa-ui-auto` 消费）✅ 63 条
- 覆盖 TC-001 ～ TC-063：主界面、设置、会话编辑器、SSH/SFTP/QuickConnect 全流程、终端右键菜单与快捷键、SFTP 多种交互（chmod / rename / 拖拽 / 多选 / 双击下载 / 列宽 / 创建文件夹）、独立 SFTP 标签、open-terminal-here、会话树搜索 / 复制 / 拖拽、标签栏右键、应用主题循环、隧道编辑器与重排、终端字体连字 / 语法高亮、本地管理员启动、tab 中键关闭、会话 import/export 多格式、OpenSSH config 导入、Welcome active connections 等

### 12.4 部署 ✅
- Replit 上验证通过：Tauri 桌面构建（`pnpm tauri build --debug --no-bundle`）通过 VNC 查看；Web 模式作为静态站点构建到 `dist/`
- GitHub Actions：`release.yml` 推送 `v<version>` tag 触发跨平台打包

---

## 附：占位但未实装的入口

> 下述入口已经在 UI 中可见但点击会显示 "not active in this phase" 占位面板，对应能力**尚未实装**，本清单不视为完成项，仅在此说明以解释 UI 为何存在：
>
> - Ribbon `Split`
> - Ribbon `Tools`（除 Tunneling 之外的网络工具）
> - Ribbon `Packages`、`Games`、`Macros`
> - 会话协议 RDP（仅保留会话存储与编辑表单，连接动作打开占位 tab）
> - QuickConnect 的 VNC URL 入口（已保存 VNC 会话可连接，QuickConnect 尚未接入 VNC client）
> - SFTP 底部的 "Cross-host transfer (remote ↔ remote)" 按钮（disabled 占位）

