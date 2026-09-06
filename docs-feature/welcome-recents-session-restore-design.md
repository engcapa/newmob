# Welcome 目录最近使用排序与上次 Session 恢复详细设计

## 1. 交付范围与决策状态

- 类型：现有能力扩展；本次交付包含设计修订与功能实现、测试及当前平台真机验证。
- 调研日期：2026-09-05；基线提交：`6d3cfb0c3cf2510395d1b238362671efcf6aadd1`；应用版本：根 `package.json` 的 `0.4.22`。
- 写入前工作树干净，目标同名文档不存在；适用规则为根 `AGENTS.md`，未发现更深层 `AGENTS.md`。
- 平台固定为 Windows、macOS、Linux 的 Tauri 桌面应用。设计撰写时环境为 Windows / PowerShell；**2026-09-06 用户决策：D-01 采用方案 B**（详见 D-01 节），本文 session 章节已按 B 原位修订。实施与真机验证在 Linux 桌面执行；Windows/macOS 结果不外推、保持未验证记录。
- 设计状态：**已定稿并实施**。目录排序契约（TASK-01/02）与 session 运行批次快照契约（TASK-03/04/05）均已确定。实现完成状态见第 5/6 节与 TASK 状态。
- 目标：默认目录与历史目录统一按真实最近使用排序；Welcome 提供独立的一键恢复入口，恢复“上次运行的 session 标签集合（含本地终端，不含整个工作区）”，复用既有会话打开、认证及面板能力。

### 交付记录（2026-09-06，Linux 当前端）

TASK-01 至 TASK-06 已实现并通过本轮自动化；TASK-07 的 Linux 原生核心链路已真机执行，Windows/macOS 未验证（无设备，不外推）。汇总：

| 层 | 结果 |
|---|---|
| Rust 内联测试 | `terminal::local_directories` 8/8、`terminal::` 全量 51/51（3 ignored 既有）、`session::resume` 8/8、`session::` 56/56；集成 `welcome_recents_resume` 5/5（真实 SQLite reopen/回滚/CAS） |
| 前端 Vitest | 全仓 3732/3732 通过（含新增 `useWelcomeDirectories` 7、`useWelcomeSessionResume` 10、`welcomeSessionResume` 7、WelcomePanel 恢复行/目录 V-04 7、TerminalPanel V-03 5、MainLayout 快照收集 3） |
| 类型/构建 | `pnpm exec tsc --noEmit`、`pnpm build`、`pnpm tauri build --debug --no-bundle` 通过 |
| browser 用例 | TC-WELCOME-RS-01/02/03/04 全部通过（Vite dev 5001 + Playwright Chromium；TC-auto-F1-6 在基线上同样失败，属既有环境问题，与本功能无关） |
| native 用例（Linux/WebKitGTK + tauri-driver） | TC-WELCOME-RS-N-01（空态+真实 PTY+快照落库）、N-03（OSC 7 → local-cwd 落库）、N-04（保存 LocalShell 快照恢复定位现有 tab）通过 |
| 原生跨重启（`scripts/welcome_native_restart.py`） | 同一隔离 app-data：Phase A 保存+打开 LocalShell → collector 提交 saved-session 快照（`welcome_run_snapshot` revision=1）+ OSC cwd 记录（`local-cwd`）；Phase B 重启后入口 available → 点击恢复 → 真实新 PTY 出现、`sessions.last_connected_at` 更新、快照未被破坏。产物在 `qa-ui-auto-report/welcome-recents-session-restore/linux/` 与 `qa-ui-auto-report/run-*`（gitignored） |
| DB 证据（隔离 app-data 的 taomni.db） | 4 张 welcome 表创建、迁移标记 complete、目录 usage 行带毫秒时间与来源（local-start/local-cwd）、快照单行含白名单 local-terminal 条目（confirmedCwd=/home/zhyhang） |

真机过程中发现并修复的缺陷：`record_local_directory_use` 在 Tokio 运行时内使用 `RwLock::blocking_read` 导致命令 panic、OSC 确认路径静默失败（改为 `read().await`）；重新进入 Welcome 时 `load()` 覆盖进行中/已完成的恢复状态（违反 AC-13，改为同 revision 保结果、操作中不覆盖）；重试时把断连失败 tab 误判为可定位（`findExistingTab` 排除 disconnected，重试替换 operation 拥有的失败 tab）。

明确偏差（记录为后续接续，不冒充完成）：
- 每协议 readiness 适配未做全：非 terminal 面板（SFTP/RDP/VNC/DB/Mail/ObjectStorage）目前以“tab 存在且存活”给出 view-opened 级结果，connected 级仅 terminal（onSessionReady）覆盖；SQL 子工作区逐项 partial 未实现。
- 白名单 local-terminal 的快照恢复在原生 N-01/N-04 未直接执行（N-01 验证了快照收集与 spawn 链路）；恢复新 PTY 已由 saved-session LocalShell 原生覆盖。
- 认证取消（AuthPrompt/Vault onCancel）会解除 waiter，但“取消后晚到成功需释放新建资源”仅有 waiter 侧防重入，未逐面板验证。
- `git status` 中 `qa-ui-auto-report/` 产物不入库；`coverage-baseline` 的 F25.5 shallow 回归与 release-evidence gate 为 main 既有失败，未动 baseline。

### D-01：Session 恢复范围，已决策为方案 B（2026-09-06）

初始问题：新入口恢复“最近使用的单个 session”，还是“上次应用运行的 session 标签集合，包含本地终端但不包含整个工作区”？**用户于 2026-09-06 确认选择 B**，并确认以下边界。本文第 4.2/4.3/5/6/7 节 session 部分已原位修订为 B 契约；保留原 ID，新增断言向后编号（AC-19、AC-20）。

方案 B 的定义与已确认边界：

- 恢复对象是**上次主窗口运行中、退出（或最后提交）时仍打开的、可恢复的 session 标签集合**：每个条目为已保存 `SessionConfig`（按 4.2.2 能力表判定可恢复性），或满足白名单的临时本地终端（非 WSL、有经 OSC 确认的 native cwd）。不包含 Code Workspace、Git、设置、聊天、LanChat、Browser、placeholder、分离窗口集合，也不恢复整个工作区布局（侧栏、分屏、焦点光标位置等仅按既有全局 UI 偏好加载）。
- 快照包含：运行批次标识（`batch_id`）、非空有序标签条目（身份 + 顺序）、活动项标识、每条目最小恢复载荷；**不得**把最近 N 个 `SessionConfig` 冒充上次运行集合，`last_connected_at` 语义保持不变。
- 临时本地终端白名单：`localShell` 启动参数 + 已确认的 native cwd；WSL 终端不进入快照（无法证明目标目录就绪）。该白名单就是临时终端恢复的全部持久化内容；不保存 PTY 输出缓冲、进程、环境变量。
- 恢复按记录顺序重放既有 opener，恢复完成后将活动项设为记录中的活动条目；逐条目报告成功等级（ready / client-started / view-opened / failed），失败条目不阻断后续条目，且失败重试集允许只重试失败项。
- 不恢复操作系统进程、PTY 输出缓冲、正在执行的命令、传输、数据库事务、运行中任务或现有网络连接；不将 `taomni.detached.*` 短期交接数据改成恢复存档。

目录方案与 TASK-01/02 不受本次决策影响。

## 2. 当前实现与证据

“事实”指本次阅读的源码/执行结果；“推断”不等同真机观测；第 4 节除明确复用项外均为拟新增行为。

| 证据 ID | 代码位置与符号 | 已确认事实及影响 |
|---|---|---|
| E-01 | `src/components/WelcomePanel.tsx`：`WelcomePanel`、`LocalDirectoriesPanel`、`handleStartInDirectory` | Welcome 默认历史页签是 sessions；directories 只过滤，不排序，按 IPC 数组渲染。Welcome 变为 active 时重新读取目录。点目录创建终端，不是打开 Code Workspace。回调当前返回 `void`，不能代表启动成功。 |
| E-02 | `src-tauri/src/terminal/mod.rs:54`：`list_common_local_directories` | 从 `command_history` 读取本地命令，按 `last_used_at` 降序，但 SELECT 仅返回 command，时间被丢弃。优先目录命令 300 条，不足 24 时补一般命令窗口 500 条。DB 锁忙时退回仅默认目录，可能造成刷新列表变化。 |
| E-03 | `src-tauri/src/terminal/pty.rs:68`：`list_common_local_directories`、`push_directory_shortcut`、`directory_shortcut_key` | 固定先加 Home/Desktop/Documents/Downloads/Pictures/Music/Videos，再历史，再主目录下 Code/projects 等候选；最多 24 行。`is_dir()` 过滤失败路径；canonicalize 后 Windows ASCII 小写去重，首个条目获胜。这导致默认目录置顶且其历史使用信息消失。 |
| E-04 | `src/components/terminal/TerminalPanel.tsx:2462`：OSC 7 handler；`src/lib/history.ts`：`useCommandHistory.commit` | 本地 cwd 变化会被改写成 `cd` 命令写回同一命令历史；用户 Enter 提交的命令也写入历史。旧记录无法区分真实 cwd 报告与失败的 `cd`。重复同 cwd 的 OSC 有当前面板内去重。 |
| E-05 | `src/lib/ipc.ts`：`LocalDirectoryShortcut`、`createLocalTerminal`；`src-tauri/src/terminal/mod.rs:280`：`create_local_terminal` | 目录 DTO 只有 label/path/kind。创建本地终端成功返回 `{sessionId,shellId}`；Rust 创建 PTY、登记 runtime、接输出后返回。终端面板的 `handleConnected`/`handleConnectFailure` 是可复用成功/失败位置。 |
| E-06 | `src/lib/terminalCwd.ts`：`normalizeLocalStartCwd`；`WelcomePanel.tsx`：`localShellSelectionFromOption` | 有 Windows OSC/MSYS 路径转换；不能映射的路径返回 null，当前调用者可能丢掉 initialCwd。WSL 在 shell args 中使用 `--cd`，普通 Windows PTY 创建成功并不证明 WSL 已进入目标目录。 |
| E-07 | `src-tauri/src/session/models.rs`：`SessionConfig`、`SessionType`；`session/db.rs`：`init_db`、`save_session`、`update_last_connected` | Session 是已保存的连接/启动配置，SQLite `sessions` 存其 id、协议、地址、认证方式、options_json 和秒级 `last_connected_at`。`save_session` 当前 INSERT OR REPLACE；不要给新增恢复记录加会被 REPLACE 连带删除的级联外键。 |
| E-08 | `src/stores/sessionStore.ts`：`loadSessions`、`markConnected`；`src/layouts/MainLayout.tsx:738` 附近的 `welcomeRecentSessions`、`openQueuedSession`、`continueConnectQueue` | 最近 sessions 来源是 `last_connected_at` 非空的配置，按时间截取设置数量。批量打开逐个分发，遇密码/保险箱暂停；`opened` 表示分发完成，不是连接成功。多个 opener 在 addTab 后立即 markConnected；Browser/File 也可能在异步操作成功前标记。 |
| E-09 | `src/stores/appStore.ts:874`：初始状态、`addTab`、`setActiveTab`、recentWorkspace 读写；`src/types/index.ts`：`Tab`、`RecentWorkspace` | 启动仅有 Welcome；tabs、活动 tab、cwdByTab、终端/DB runtime 不整体持久化。单独有 recentWorkspaces、本地 UI 布局偏好。不能据此推断曾打开的全部标签、分屏成员或连接还在。 |
| E-10 | `src/layouts/MainLayout.tsx`：`openRecentCodeWorkspace`；`src/components/database/DbClientTab.tsx:696` 附近的 `dbLoadQueryWorkspace`；`src-tauri/src/database/query_workspace.rs` | Code Workspace 最近定义有专用重新打开入口；数据库查询工作区另有 SQL 子标签与活动面板持久化。复用各模块自有加载，不将其提升为通用全工作区恢复契约。 |
| E-11 | `src/lib/detachedSession.ts`：`HANDOFF_TTL_MS`、`writeDetachedHandoff`；`src/App.tsx` 路由；`src-tauri/src/state.rs`：`AppState` | detach/reattach 是 60 秒 TTL 的窗口交接，有 runtime ID/凭据交接边界；Rust 活连接、进程与任务在内存 registry。主窗口恢复记录不能由所有分离窗口竞争写入。 |
| E-12 | `src-tauri/src/lib.rs:65`：`resolved_app_data_dir`；setup、`exit_app`；`MainLayout.tsx`：`requestAppExit` | 主 DB 是 app-data 下 `taomni.db`；debug 支持绝对路径 `NEWMOB_DATA_DIR`。退出已有未保存工作/资源清理流程；持久化恢复记录不能只依赖退出回调，异常退出不保证执行。 |
| E-13 | `src/stubs/tauri-core.ts`：`list_common_local_directories`、`create_local_terminal` | 浏览器目录是 VFS Home/Workspace 固定列表，真正的本地终端调用直接报不支持。现有 browser “终端标签出现”用例不能证明真实启动成功。 |
| E-14 | `qa-ui-auto-tests/feature-list.md`：F1.6；`cases/auto/TC-auto-F1-6-welcome-recent-sessions.testcase.yaml`；TC-038 | 已有 Welcome 最近配置、筛选、批量打开和 shell 入口用例，未证明时间排序、上次 session 快照或重启恢复。现有 F1.6 controls 需要补登记 directories 与新恢复入口。 |
| E-15 | `src/components/WelcomePanel.test.tsx`、`src/stores/sessionStore.test.ts`、`src/lib/terminalCwd.test.ts`、`src/layouts/MainLayout.test.tsx` | 本次 Windows 执行 `pnpm test src/components/WelcomePanel.test.tsx src/stores/sessionStore.test.ts src/lib/terminalCwd.test.ts src/layouts/MainLayout.test.tsx`：4 文件、66 测试通过；Vitest 报告时长 9.06s。只证明基线，未执行新功能或原生验证。 |

现状调用链：目录行点击 -> MainLayout.openLocalTab -> appStore.addTab -> TerminalPanel -> create_local_terminal -> PTY；会话恢复可复用链是 Welcome -> MainLayout 的连接队列 -> 现有认证/保险箱 -> 协议面板 -> 各协议 IPC/Rust 模块。没有发现可直接调用的“上次运行 session 集合恢复”服务。

## 3. 可观察验收条件

AC-08 至 AC-20 中涉及范围的断言以 D-01 方案 B（2026-09-06 确认）为前提。全部 AC 的验收状态见第 9 节证据表。

| ID | 前置、动作 | 必须观察到的结果 |
|---|---|---|
| AC-01 | 默认 Home 使用于 t2，历史 A 使用于 t3，默认 Downloads 使用于 t1，t3 > t2 > t1 | Local Directories 顺序 A/Home/Downloads；系统/常用标签不影响时间排序；搜索后保留相对次序。 |
| AC-02 | 点击目录、创建 tab、启动成功、启动失败分别观察 | 只有成功创建指定 cwd 的主机本地 PTY或确认 cwd 改变更新使用时间；点击/排队/失败不更新，不将失败改为默认目录成功。 |
| AC-03 | 从未用过的默认项、缺时间旧项、两个相同时间项混合 | 有确认时间的记录在前；其余按第 4.1.3 节固定规则；不使用启动/扫描/迁移时刻填空，刷新和同平台重启结果一致。 |
| AC-04 | 默认目录与历史同路径；三端不同分隔符/大小写/别名输入 | 同一已确认身份仅一行，保留默认名称和类型、最大真实使用时间；不误合并大小写敏感卷上的不同目录，离线时不猜测未知别名身份。 |
| AC-05 | 旧 DB 升级、迁移中断、再次初始化、DB 暂忙 | 旧表/时间保留，迁移原子且幂等；暂忙重试或报错并保留上次列表，不假装只剩默认项；成功写入后重开仍为同一顺序。 |
| AC-06 | 已记录目录被移除、权限收回、盘符/挂载暂离线 | 行保留，展示已知不可用状态和完整路径提示；点击重新检查，可重试；失败不提权、不自动创建目录、不改使用时间。重新可用后可原入口打开。 |
| AC-07 | 成功改变 cwd A -> B -> A；重复 OSC；SSH/WSL 不可映射 cwd；打开本地目录面板 | 主机本地确认 cwd 的实际变化计时，重复报告不刷时间；远程路径/无法确认主机映射不污染本地目录；面板列目录不被当成启动终端使用。 |
| AC-08 | 第一次安装、只有未使用配置、旧最近配置、已有新恢复记录 | 无候选时入口禁用且显示“暂无可恢复会话”；旧最近配置可作标明来源的配置候选；新记录优先，绝不把最近 N 条当上次运行集合。**（B）空快照不产生候选**：上次运行无可恢复条目时同 empty。 |
| AC-09 | 上次运行含保存配置 B（名称后被更新），更早还有 A 的标签，随后进入 Welcome | 入口明确显示快照条目集合（含 B 的名称/协议），一次动作按记录顺序恢复全部条目；更新配置、进入 Welcome、关闭到空状态不将 A 或空内容写为上次记录。**（B）关闭所有可恢复标签后不再写非空快照，旧记录保留。** |
| AC-10 | 快照含保存 LocalShell 有确认 cwd；普通 SSH/SFTP/DB 配置可连；**（B）含一个满足白名单的临时本地终端** | 按记录顺序各打开对应 tab，使用当前保存配置；LocalShell 回到确认的本地 cwd；临时终端以白名单 shell+cwd 启动；连接由现有协议重新建立。SQL 子工作区仅沿用已有持久化，未保存状态不凭空出现。 |
| AC-11 | 无历史/加载中/恢复中/等待认证/成功/失败/部分成功 | 显示 4.2.4 各状态；区分条目已打开、客户端已启动与连接已建立；**（B）按条目聚合为成功/部分成功/失败，partial 列出失败条目明细**。认证等待不算成功。 |
| AC-12 | 连续点击、恢复中再点、已有相同配置 tab、同配置其他版本已打开 | 一次恢复最多为每条目建一个目标；重复操作返回同一 operation；可用现有 tab 被定位且内容不被改写；旧配置实例冲突按明确策略处理。**（B）活动项定位优先，其余条目按 tab 顺序第一个。** |
| AC-13 | 恢复期间切换页面、关闭目标、完成后再进 Welcome | 完成不抢走用户已转移的焦点；留在操作流程内时聚焦目标主要控件；Welcome 历史页签和过滤状态不被恢复器重置；**（B）恢复中途关闭某条目标，该条目标记 cancelled，其余条目继续**。 |
| AC-14 | 正常退出、确认后异常终止、仅启动后退出、失败恢复后退出 | 最近有效提交保留；启动/退出不写空快照；未提交的最后一次事件可丢失但不得破坏上次提交；失败/取消/部分恢复不覆盖有效记录。**（B）快照提交跟随运行内标签变化增量提交，异常退出只保证最后已提交批次。** |
| AC-15 | 目录缺失、配置删除、协议改变、认证失败、存储失败、未知 schema | 原因可见且入口保留重试/编辑/清除所需操作；不自动换成另一个 session，不恢复已删除配置；未知 schema 不覆盖，写失败不谎报记录已保存。**（B）删除配置的条目在恢复中报 missing-session，其余条目不受影响。** |
| AC-16 | SSH 认证/主机确认、保险箱锁定、可选子状态失败、运行中任务曾存在 | 沿用现有认证及资源生命周期；不复制明文密钥、一次性密码、进程/连接/任务 ID；**（B）认证对逐条目暂停，成功后继续下一待认证条目**；旧命令/查询/传输不自动重放。 |
| AC-17 | 恢复 LocalShell 于 A 成功、失败、仅定位已有 tab、明确选择默认 cwd 降级 | 只有新成功使用的真实本地 cwd 推进目录时间；失败和纯定位不推进；降级仅记实际 cwd，A 保持原时间和原恢复记录。**（B）临时终端白名单 cwd 启动成功同样推进目录时间。** |
| AC-18 | 三端正常构建与原生执行；中英文、800x600/1280x800、系统缩放 | 既有 Welcome 视觉和导航保持，按钮/长路径无重叠，键盘可达，状态可被辅助技术读取；无平台专属假设泄漏到其他端。每端原生结果独立记录。 |
| AC-19 | （B 新增）快照含多条目与活动项；恢复后检查 tab 顺序与活动项、失败条目重试集 | 恢复后 tab 顺序与记录一致，活动项为记录的活动条目；partial 时仅失败条目可单独重试且成功后聚合状态推进；重复恢复不产生重复 tab。 |
| AC-20 | （B 新增）白名单边界：WSL 终端、无确认 cwd 的本地终端、Code Workspace/设置/聊天标签在运行中存在 | 这些标签不进入快照；恢复结果不含它们；快照仍含同时存在的其他合格条目。 |

## 4. 推荐方案与共享契约

### 4.1 Local Directories

#### 4.1.1 权威来源与“使用”的定义

新增 `src-tauri/src/terminal/local_directories.rs`，集中提供目录项、身份合并、SQLite 读写、旧数据迁移和排序。继续使用 `list_common_local_directories` IPC 名称及现有列表组件，不新增前端 localStorage 排序真源。命令历史仍服务终端历史，不再实时解析它来猜测新目录成功事件。

“使用目录”在本功能中指**在主机本地目录中成功启动交互式本地终端，或该终端确认其 cwd 已改变到此目录**。普通本地终端入口、保存 LocalShell、复制终端、恢复入口共用此规则。浏览文件、扫描默认目录、点击目录、激活已有 tab、命令文本提交、远程 cd 都不是该事件。Code Workspace 内普通本地交互终端通过同一 create_local_terminal 自然记录；SocksCap 启动的程序/任务 PTY不在此采集范围。

| 触发 | 时间与写入规则 |
|---|---|
| 目录按钮点击、创建 tab、请求进行中 | 不更新。UI 以请求 ID 保持 pending，直到真实启动结果。 |
| 指定 native cwd 的 PTY 创建、runtime 注册和输出通道安装全部成功 | Rust 在成功路径采集系统 UTC Unix 毫秒；事务 upsert。目录/权限验证或 spawn 任一步失败均不写。 |
| 未指定 cwd 的本地启动 | 不假定 Home 或应用目录；首次收到可映射的真实 OSC 7 后记录。后续可由 pty 返回明确有效 cwd，但不得从猜测生成。 |
| 同一存活本地终端 OSC 7 目录变化 | 从现有 parser 获取 cwd，经 shell 种类及主机路径校验后发送结构化 IPC；Rust 验证 runtime 为本地终端；记录确认时刻。A -> B -> A 每次变化记一次。 |
| spawn 与首次 OSC 指向同一路径；同路径重复 prompt/cwd probe | 通过 per-runtime 的 last directory identity 去重，不二次更新。新建另一个终端到相同 cwd 是新的使用。 |
| 输入 `cd` 但失败，或者 shell 无 cwd 报告 | 不按命令文本补写；没有证明就不更新。原命令历史仍按其既有规则工作。 |
| 恢复 session | 新建 native local PTY 成功按同一规则写；失败/认证取消/定位现有 tab 不写。 |

成功打开与历史落盘失败分离：已启动的终端继续可用，显示“终端已打开，最近使用记录保存失败”；保留上次已提交排序。不能为存储失败杀死已成功启动的终端，也不能只在内存伪造一个重启即丢失的新顺序。

#### 4.1.2 数据结构与旧数据

以下为拟新增 schema v1，存入现有 `taomni.db`；不改 `sessions` 和 `command_history` 表结构。

```sql
CREATE TABLE IF NOT EXISTS welcome_directory_usage (
  directory_id TEXT PRIMARY KEY,
  display_path TEXT NOT NULL,
  last_used_at_ms INTEGER,
  last_use_source TEXT,
  legacy_rank INTEGER,
  legacy_observed_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS welcome_directory_alias (
  path_key TEXT PRIMARY KEY,
  directory_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS welcome_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- `directory_id` 为持久化不透明 UUID，不从本地化 label 生成。alias 引用在同一事务维护，不依赖隐式级联。默认目录的 `defaultId/defaultRank/label/kind` 从 OS 目录提供者派生，不把系统名称当路径。
- 首次发现可展示的默认目录时可以建立 null 时间行和 alias；它是发现元数据，不是使用事件。只有目录集合/身份发生变化才提交元数据 revision，普通 list 不反复写库。默认候选和已有使用记录先关联同一 directory_id，不能每次列举重新生成 UUID。
- `last_used_at_ms: i64 | null` 仅允许确认使用；`last_use_source` 为 `local-start` / `local-cwd`，null 表示未确认。TS 使用安全整数 `number | null`；单位明确为毫秒，不能直接和 sessions 的秒值比较。
- 确认事件 upsert 取已有非空时间和新真实时间的最大值，过期响应不倒退记录；同时间 source 固定优先 local-start，再 local-cwd。alias合并也采用该规则，不能因遍历次序改变时间来源。
- 旧记录保留原 `command_history.last_used_at`。首次迁移读取现有优先目录命令窗口并补足一般命令窗口，改为带 `id/command/last_used_at` 的结构化查询，确定性排序为时间 DESC、id DESC。复用 `directory_from_history_command` 的受限解析，不执行命令、不解析任意 shell 脚本；相对路径不靠当前 cwd 猜测。
- 可解析路径建立 null 使用时间条目。旧时间若为有效非负秒值，仅转换存到 `legacy_observed_at_ms`，并赋连续 `legacy_rank`；它表示命令被观察的时间，不能升级成“成功使用时间”。同一目录多条旧命令取最早的 rank；缺时间/异常时间排在有旧观察时间的候选后，以 path_key 字节序稳定排列。
- 迁移、alias 归并、`welcome_metadata['directory_migration_v1']='complete'` 在一个事务提交。中断整体回滚，下次重试；不先写完成标记。无命令历史也写完成标记，之后新失败 cd 不会再次导入。
- 初始化只创建表，文件系统候选解析在非 UI 线程完成，不能把可能离线的文件探测放进持有主 DB 锁的代码。已有旧记录的成功性无法补证，是数据局限，不要求用户提供迁移时间。
- 不因每次启动、刷新或“清空命令历史”重建新目录时间；目录历史此后独立。现有命令历史清除不会再次触发迁移。新增目录历史清除 UI 不在本次范围。
- 首版不自动删除历史行或 alias，防止保留策略造成默认目录丢失实际时间；展示最多 24 个非默认最近项，加上默认项，统一排序。海量数据优化不修改使用时间，后续若增加删除策略需独立设计。

#### 4.1.3 排序、默认项与合并

处理顺序固定：读取持久化使用/alias -> 枚举默认候选 -> 按目录身份合并 -> 确定非默认最近项展示集合 -> 对全集排序 -> 前端过滤。**禁止先拼默认数组再追加历史数组，禁止按 kind 分区排序。**

比较元组如下；字符串用 UTF-8 二进制序，前端保持后端顺序，不使用受 locale 影响的 `localeCompare`：

1. `lastUsedAtMs != null` 在前，时间降序；相同时间用稳定的 identity sort key 升序。
2. 无确认时间且有 `legacyRank` 的旧记录随后，rank 升序，同 rank 用 identity sort key。
3. 无确认时间、无旧 rank 的默认项随后，defaultRank 升序，再 identity sort key。
4. 其他缺时间且无 rank 的兼容记录最后，identity sort key 升序。

identity sort key 是该目录所有已登记 path_key 的字节序最小值，在合并事务内更新，不依赖 UUID 随机大小。没有新的记录、身份发现或 OS 目录配置变化时刷新/重启必须一致；新确认 alias 归并引起一行合并是解释得通的数据变化，不是假造时间。

默认 rank 保留当前次序：Home、Desktop、Documents、Downloads、Pictures、Music、Videos；然后按现有数组的 Code、code、Projects、projects、Workspace、workspace、work、dev、Developer、src。OS 明确返回的系统目录可展示为 unknown；主目录下猜测的常用候选仅在确认存在后加入，未存在的 guesses 不制造行。使用过的默认目录始终带持久化时间，与所有已用目录一起排序。

默认+历史重合：只保留一行，默认名称/kind 优先；多个默认名称同目录取最小 defaultRank；`lastUsedAtMs` 取所有已确认记录最大值，其 source 跟随该值；`legacyRank` 取最小值且只作为无确认时间排序依据；展示路径取默认路径，否则保留首次登记展示路径。原始 alias 保留，打开实际请求路径，不把系统根路径裁剪为空。

#### 4.1.4 三端路径身份边界

- 使用 Rust `Path/PathBuf`，host 平台决定解析。Unix 的反斜杠是合法文件名字符，不统一替换为 `/`；不 trim 掉实际文件名中的首尾空格。IPC 要求主机绝对路径，拒绝空字符串、NUL、非 UTF-8 无法无损编码的路径；不使用 lossy 文本做唯一身份。
- Windows 识别 drive、UNC share、extended-length drive/UNC 前缀；规范化分隔符、drive 字母和等价前缀，保留 share/root 语义。不把 `C:relative` 当 `C:\relative`。POSIX 保留 `/` 与必要的双斜杠语义；绝对路径含 `..` 时必须真实解析后才能确认等价，不作跨 symlink 的文本折叠。
- 保留现有 canonicalize 作为成功解析证据；替换“Windows 全路径转小写”的无条件合并。拟将锁文件中已有的 `same-file` crate 声明为直接依赖，用其跨平台文件句柄相等判断验证可访问候选身份；不自写三套 file-id API。仅相同 lexical key 或成功确认同目录才合并。
- Windows 普通 NTFS 与 macOS 默认卷的大小写别名通过实际 identity 合并；Windows per-directory case sensitivity、macOS case-sensitive APFS、Linux 上不同实体不得折叠。Unicode 不做未经文件系统确认的大小写/NFC/NFD推导。
- 符号链接、Windows junction、短路径等仅在可访问并确认同一实体时合并；alias map 记下已确认等价关系。断开时保留已知归属，不凭文本猜测新别名；重新可访问时复核，symlink 重新指向其他目录则分离此 alias，不能把旧目标历史转赠给新目标。该分离不改变旧记录时间。
- 盘符映射与 UNC、bind mount、网络共享身份可能不能由底层可靠证明；无法证明就允许独立行，不为了消除重复误合并。此项是明确支持边界，不承诺全局文件实体追踪或跨设备同步。
- `normalizeLocalStartCwd` 只复用于明确 native/MSYS 的 OSC 转换。WSL Linux cwd、SSH cwd 不按主机 Windows 路径解释；WSL `--cd` 保持既有启动方式，但单凭 wsl.exe PTY 成功不更新时间。只有实际报告经可信主机映射确认后才计入，首版不新增 WSL automount 推断或 wslpath 服务。

列表请求不逐行阻塞探测挂载。返回持久化数据和最后已知可用性；默认探测/身份确认在有界后台工作队列中运行，每路径至多一个工作，总并发不超过 4。探测超过 2 秒的 UI 等待预算返回 `unavailable`/`unknown`，继续保留数据；底层 OS 调用可能不可中断，其槽位直到返回才释放，重复刷新不得累积新阻塞任务。这里的 2 秒是拟定等待策略，非现有性能实测。

#### 4.1.5 接口、失败和 UI

在 `src/lib/ipc.ts` 扩展 DTO，Rust `serde(rename_all = "camelCase")`；新增字段在 Rust 明确序列化 null/默认值，旧 browser fixtures 未升级时前端以 null/unknown 读取。

```ts
interface LocalDirectoryShortcut {
  label: string;
  path: string;
  kind: "system" | "personal";
  directoryId: string;
  lastUsedAtMs: number | null;
  timeSource: "local-start" | "local-cwd" | null;
  legacyRank: number | null;
  defaultId: string | null;
  availability: "unknown" | "available" | "missing" | "permission-denied" | "unavailable";
}

// New IPC; Rust validates a live native-local backendSessionId.
recordLocalDirectoryUse(input: {
  backendSessionId: string;
  path: string;
}): Promise<{ changed: boolean; directory: LocalDirectoryShortcut | null }>;
```

`list_common_local_directories` 改为 async，在后台等待 DB 锁或返回明确存储错误，不沿用锁忙时的“成功默认列表”。`record_local_directory_use` 只用于 cwd 报告；spawn 成功写入直接调用 Rust 内部 `record_successful_local_start`，前端不得传任意时间或把点击当成功。per-runtime 去重状态归 `AppState` 中拟新增 `local_directory_runtime` registry，`close_terminal` 清除；失败关闭/晚到 OSC 不得写入。

`LocalTerminalCreated` 拟新增可空 `directoryUseWarning`，表示终端成功而记录未保存；IPC 成功不能因辅助写失败变成一次可被重试而重复 spawn 的错误。`create_local_terminal` 保持原启动参数；Welcome 对传入路径在前端要求可无损 native 归一化，不能通过 `?? undefined` 静默改为默认 cwd。WSL 分支按前节界限处理。

目录任务独立提供最小启动结果：Welcome 的 `onStartLocalTerminal` 改为返回 `Promise<LocalLaunchOutcome>`，其中 outcome 为 `{tabId, status: "started" | "failed" | "cancelled", error?: string}`。MainLayout 在 addTab 前登记本地启动 request，复用 TerminalPanel 已有 `onSessionReady` 完成成功分支，新增可选 `onSessionLaunchFailed` 在 `handleConnectFailure` 完成失败分支；关闭未完成目标时完成 cancelled。Promise 不因历史写 warning 变成 failed。Welcome按directoryId只保留一个pending，不对自身主动切到终端造成的隐藏执行取消。TASK-04随后将这套结果适配到统一SessionOpenOutcome，不另建第二套本地启动状态机；因此TASK-02不依赖D-01。真正无cwd确认的WSL客户端启动结果不触发目录时间写入。

复用 `welcome-local-directory`、`data-directory-path`、目录过滤和列表尺寸。新增 `data-directory-id`、`data-last-used-at-ms` 供验证/稳定 key；时间为空时属性为空字符串，tooltip 文案为“使用时间未知”或“尚未使用”，不能显示当前时间。已用条目可在右侧紧凑显示本地化时间，完整 UTC 时间放 tooltip，排序仍按原始毫秒值。不可用行显示小图标/状态，不置底、不删除；允许点击重检，只有同一目录进行中的按钮暂禁用。错误通过现有 status bar 与行内状态呈现，unknown 不等同 denied。

目录列表 load 错误保留最近成功数组并给重试按钮；初次失败显示错误状态，与真正空目录区分。复用现有 active 刷新，同时监听拟新增 `welcome-directories-changed` Tauri 事件 `{revision}`：仅成功事务后广播，Welcome 可见时合并短时间内的刷新，隐藏时置 dirty 再于 active 加载。listener 卸载释放；请求序号防止旧响应覆盖新数组。后端列表返回 revision（建议 IPC 包装为 `{revision, directories}`，TS wrapper 对组件仍返回目录数组并在专用 hook 内消费 revision）；其确切实现以第 4.3 节统一契约为准。

### 4.2 一键恢复上次运行的 session 标签集合（D-01 方案 B，2026-09-06 修订）

#### 4.2.1 快照的定义、收集与提交

“上次”指**同一 app-data 中，主窗口最近一次有效提交的运行批次快照**：批次内是提交时刻仍打开且可恢复的 session 标签条目（已保存配置标签 + 满足白名单的临时本地终端），含顺序与活动项。快照持久化到 `taomni.db` 专用单行表，不借用 `last_connected_at`，不把最近 N 条 `SessionConfig` 当作上次运行集合；既有字段与最近列表行为保持不变。

快照条目（`SnapshotEntry`）：

```ts
type SnapshotEntry =
  | { kind: "saved-session"; identity: string; savedSessionId: string;
      savedSessionType: string; displayName: string }
  | { kind: "local-terminal"; identity: string; displayName: string;
      shellId: string; shellArgs: string[]; confirmedCwd: string };
```

- `saved-session` 条目仅存配置引用与展示摘要（id、类型、名称），不复制 `options_json`、密码、vault 明文、运行句柄或终端内容。`local-terminal` 条目是白名单条目：仅当本地终端拥有经 OSC 7 确认并归一化的 native `cwd`（`normalizeLocalStartCwd` 非 null）且非 WSL（`localShell.id` 不以 `wsl:` 开头、非 `wsl.exe`）时才进入快照；未确认 cwd 的临时终端、SSH 命令终端（`commandTerminal`）、SocksCap PTY 不进入。`identity` 为条目去重键（`saved:<sessionId>` / `local:<tabId>`）。
- **可恢复类型判定**复用 4.2.2 能力表：`saved-session` 覆盖该表支持恢复的全部已保存类型；Browser、外部 File/URL、未知/placeholder 类型不进入快照。Code Workspace、Git、设置、聊天、LanChat、proxy-test、nettools、sockscap 标签不进入。
- 收集器在主窗口运行：`addTab`（合格条目）、`removeTab`、`setActiveTab`（合格条目成为活动项）、以及临时终端首次确认 cwd，均触发快照重建。重建后与上次已提交快照做**深比较**（条目集合、顺序、活动项、cwd/名称均一致则跳过），仅在实际变化时提交。关闭所有合格条目不提交空快照；已有非空记录保留为“上次”。
- 活动项：提交时刻的活动 tab 若是合格条目则记为 `activeIdentity`；活动项不合格（Welcome/设置等）时记 `null`，恢复后保持最后一个恢复条目为活动。
- 恢复期间的收集抑制：恢复 operation 拥有的新建/定位条目标记 `resumeIncomplete`（内存标志，不持久化为 Tab 快照），这些条目不进入普通快照收集；恢复完全成功后清除标志并纳入正常收集。恢复期间用户成功正常使用的新条目按正常规则进入快照。
- 恢复触发的 addTab/active/cwd 事件不产生目录或快照写入副作用（除 4.2.5 第 7 条允许的目录推进）。

```sql
CREATE TABLE IF NOT EXISTS welcome_run_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  run_sequence INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  entries_json TEXT NOT NULL,
  active_identity TEXT
);
```

- `entries_json` 是有序 JSON 数组，条目结构即上方 `SnapshotEntry`；`active_identity` 为条目 `identity` 或 null。`run_sequence` 在事务中递增，决定“最后一次”以避免同毫秒冲突；`committed_at_ms` 为真实系统时钟，时钟回拨时批次序仍可判定，不伪造未来时间。每条目可携带 `usedAtMs`（saved-session 条目）用于展示，来源与 `use_sequence` 同批提交。
- 每次合格变化立即在事务中提交（upsert 单行 + revision 自增 + `welcome_metadata` 中 snapshot revision 推进），提交失败仅记状态栏错误，不影响正在使用的标签；正常退出流程在现有确认后等待挂起的快照写完成，不绕过既有退出清理；异常退出只保证最后已提交批次。
- 只打开 Welcome 又退出、启动后未产生合格条目：不写任何快照，旧记录保留。

旧数据候选规则（B）：若无新表有效记录且没有用户 clear 标记，读取现有 `sessions.last_connected_at` 中有效正数的最大值（同时间按 `id` 字节序），过滤 4.2.2 不支持类型后构造**单条目**快照（`source: "legacy-open"`），显示“最近会话配置”，不宣称曾连接成功；不写新使用时间、不借旧记录推导 cwd。该候选只在实际成功恢复/使用后晋升为新记录。已存在新记录但其中配置损坏或删除时保留条目错误对象，不偷偷回退到别的 session。

#### 4.2.2 恢复对象与实际能力表（沿用，按条目执行）

| 快照条目类型/状态 | 本次恢复内容与可复用落点 | 成功等级/明确边界 |
|---|---|---|
| saved-session: native LocalShell | 当前保存的 shell/args、terminal profile，加快照保存且已确认 native cwd；`openLocalTab` -> TerminalPanel | `ready` 为 PTY 已创建；shell RC 自行改变 cwd 后以新 OSC 为准。不是恢复旧 shell 进程、环境变量、历史输出。 |
| saved-session: WSL 形式 LocalShell | 现有 session options 中 distro/argv，经原 opener 启动 | 客户端已启动等级；不保存/注入无法映射的 Linux cwd。缺发行版显示现有失败，不能换 distro。 |
| saved-session: SSH | 当前主机/认证/网络/主题配置，复用认证队列与 TerminalPanel | SSH 建连成功等级。远程 cwd 不持久化；既有显式 startup command 按普通连接执行，入口 tooltip 标明“重新连接”。 |
| saved-session: SFTP | 当前保存连接，FileBrowser/useSftpStore.attach | attach 成功；初始目录失败为部分失败。 |
| saved-session: RDP / VNC | 现有 RdpPanel/VncPanel 与 stores | 收到实际 connected 状态；不绕过证书/认证。 |
| saved-session: SQL / Redis / HBaseShell | `DbClientTab` / `RedisClientTab` / `HBaseShellTab` 原连接入口 | 真实 connect 成功；SQL 持久化子标签按现有模块能力恢复。 |
| saved-session: S3 / AzureBlob | ObjectStorageBrowser/useObjectStorageStore.attach | attach 成功；bucket/list 权限失败可部分成功。 |
| saved-session: File（嵌入本地目录） | `session.host` 指定目录，LocalFileBrowserPanel/attachLocalOnly | 首次本地目录读取成功；不改目录终端使用时间。 |
| saved-session: Mail | 账户设置与本地缓存，MailClientTab 原 cache/load 流程 | 面板及缓存成功加载即“已打开”；同步失败单独展示。 |
| saved-session: Proxy | 原测试面板及保存配置 | 配置面板呈现成功；不自动执行测试。 |
| saved-session: FTP/Telnet/Rlogin/Mosh/Serial | 原 `openCommandTerminalTab` 及命令 PTY | 客户端启动成功等级。 |
| local-terminal（白名单临时终端） | `localShell`（shell id/args）+ 快照 `confirmedCwd` 经 `openLocalTab` 启动新 PTY | `ready` 为 PTY 已创建；不恢复旧进程/输出缓冲；启动失败不重写白名单 cwd。 |
| Browser、外部 File/URL、未知/placeholder、无保存 id 的临时 tab、Code Workspace/Git/设置/聊天 | 不可恢复，不进入快照 | 可继续使用现有普通打开入口。 |

标签标题默认由当前保存名称及既有自动标题规则生成；不承诺手工重命名、标签顺序细节（恢复后新 tab 按记录顺序追加）、分屏成员、侧栏展开、焦点光标位置的快照。既有全局 UI 偏好照常加载。

#### 4.2.3 恢复记录、打开请求与结果契约

新增 `src/lib/welcomeSessionResume.ts`（类型与 eligible 判定）；新增 `src/hooks/useWelcomeSessionResume.ts` 管理快照收集协调、恢复 operation 与状态机，Welcome 仅渲染状态。

```ts
type RunSnapshotRecord = {
  schemaVersion: 1;
  revision: number;
  runSequence: number;
  batchId: string;
  committedAtMs: number;
  entries: SnapshotEntry[];
  activeIdentity: string | null;
};
type ResumeViewState =
  | { state: "loading" | "empty" }
  | { state: "available"; record: RunSnapshotRecord }
  | { state: "restoring" | "awaiting-auth"; operationId: string; record: RunSnapshotRecord }
  | { state: "succeeded" | "partial" | "failed"; record: RunSnapshotRecord;
      operationId: string; outcomes: EntryOutcome[] }
  | { state: "unavailable"; reason: "storage" | "schema"; message: string };
type EntryOutcome = {
  identity: string;
  kind: SnapshotEntry["kind"];
  displayName: string;
  status: "ready" | "partial" | "failed" | "cancelled";
  readiness: "connected" | "client-started" | "view-opened" | null;
  tabId: string | null;
  issue: ResumeIssue | null;
};
type ResumeIssue = {
  code: "missing-session" | "changed-type" | "missing-directory" |
    "permission-denied" | "unavailable-directory" | "authentication" |
    "connect" | "optional-state" | "storage" | "cancelled" |
    "existing-config-conflict" | "unsupported";
  message: string;
};
type RestoreOperationOutcome = {
  operationId: string;
  status: "succeeded" | "partial" | "failed" | "cancelled";
  outcomes: EntryOutcome[];
};
```

`RunSnapshotRecord` 为只读快照；一次操作锁定 `record.revision` 与 entries。点击时对每个 saved-session 条目 `getSession(id)` 重新读取当前配置，按 `saved_session_type` 校验；协议类型改变报 `changed-type`，配置删除报 `missing-session`——该条目失败，其余条目继续。

MainLayout 连接队列条目扩展为 `{session, requestId, origin, entryIdentity?, resumeContext?}`，origin 为 `normal` / `welcome-resume`。复用 `openQueuedSession`、`continueConnectQueue`、`pendingAuth`、`queueVaultUnlock`、`handleAuthSubmit` 并传递 requestId；密码弹窗取消不得丢失操作归属。`opened` 保留为“已分发”；最终结果由目标面板回调/状态适配器完成，不以 addTab/markConnected 推断。

各 opener 返回实际 tabId 或结构化即时失败，使用 UUID。拟新增 `onOpenOutcome` 可选回调接在对应面板真正完成/失败位置；普通调用者无需处理。TerminalPanel 复用 `handleConnected`/`handleConnectFailure`（新增 `onSessionLaunchFailed`）；SFTP/object storage 检查 attach 后 pane error；数据库收集 connect 与子工作区 load 状态。取消/销毁/新 generation 后旧回调无效。

#### 4.2.4 Welcome 入口、状态与焦点

在品牌标题区之后、既有启动入口之前增加紧凑操作行，不增加大型 ActionCard。主按钮 lucide `RotateCcw` + “恢复上次会话 / Restore last session”；旁显示快照摘要（条目数 + 类型徽标，长名称截断带 tooltip）。右侧小图标提供清除记录（ConfirmDialog 确认）。

| 状态 | 可见内容/操作 | 下一步与焦点 |
|---|---|---|
| loading | 按钮禁用，固定宽度 spinner，“正在读取” | 不抢初始页面焦点。 |
| empty | 禁用按钮；“暂无可恢复会话” | 保留新会话与本地终端原入口。 |
| available | 可点击恢复；显示条目摘要；“最近会话配置”来源标明（若为 legacy 候选） | Enter/Space 与点击同一路径。 |
| restoring | 禁用 + aria-busy；显示目标摘要；可取消 | 逐步分发条目；认证出现时进入 awaiting-auth。 |
| awaiting-auth | “等待认证 (i/n)”，沿用密码/保险箱/MFA UI | 取消当前条目认证后该条目 cancelled，队列继续下一待认证条目。 |
| succeeded | “已恢复 N 个会话” | 焦点落活动项目标主要控件（用户仍在本流程内时）。 |
| partial | “部分会话未恢复” + 失败条目明细行；“重试失败项” | 仅重试失败/取消条目，不重连已成功条目。 |
| failed | 全部失败时行内错误摘要 + 重试 | 不覆盖有效快照。 |
| unavailable | 存储失败可重试；未知 schema 显示版本不兼容 | 不装作 empty，不自动写空值。 |

恢复过程中用户切走，完成/失败只更新 operation 状态和 status bar，不拉回焦点。取消停止后续分发并解除本 operation 认证等待；已创建条目保留，取消不关闭它们（用户可按原 UI 关闭）。连接 IPC 暂不能中断时进入“取消处理中”，保持去重占用直到回调释放。状态用 `aria-live="polite"`，失败用 alert；按钮高 32px、icon 16px、现有 taomni-btn/颜色变量。

#### 4.2.5 重复、冲突、保留与两项功能联动

1. 同一主窗口全局只允许一个 Welcome restore operation；重复点击返回同一 operationId。与普通连接队列按条目去重：条目已有 live tab（同 savedSessionId + 同主视图类型 / 白名单同 cwd 本地终端）时定位而不新建。优先当前活动匹配项，否则按 tabs 顺序第一个；ready 定位，connecting/awaiting-auth 加入同一结果等待；失败条目优先该面板现有 reconnect，若无 reconnect 且原失败 tab 属于本 operation，则等资源关闭后移除并以新 UUID 重建。
2. 相同 id 的现有 tab 若用的是不同当前配置 fingerprint，返回 existing-config-conflict（该条目 issue），提供“定位已打开会话”；不改写 live options、不关现有连接。fingerprint 只比较非敏感身份字段与会话修订标记，不含密码明文。
3. 分离窗口冲突：复用 MainLayout 已有 detach 跟踪，持有/已确认该窗口时聚焦该窗口（该条目记 view-opened）；无法确认 owner 则报冲突。不新增跨主进程唯一性协议；同 app-data 多进程写入最后提交 wins。
4. 操作锁定旧快照；恢复触发的 addTab/active/ready 事件暂不进入普通快照收集。完全成功后提交同一批条目的新快照（清除 `resumeIncomplete`）；partial/failed/cancelled 不提交。恢复期间用户正常成功使用的新条目按正常规则进入快照；恢复完成用 expectedRevision 比较，不覆盖更晚的正常提交。
5. 重试（整体或仅失败项）始终按当前保存配置重新校验，保留 record 副本；若快照已变化，Welcome 主入口显示新对象，旧操作重试仍指旧目标。
6. native LocalShell（含白名单临时终端）成功新开与实际 cwd 变化由第 4.1 节更新目录时间；纯定位 ready tab 不推进目录时间；失败记录写入不会导致再次 spawn。恢复降级产生的真实目录使用可保存，原快照 context 保留。
7. 清除入口原子删除快照并在 `welcome_metadata` 写 `session_resume_cleared_v1=true`，阻止下一刷新复活；下一次正常成功使用可重新建立并删除标记。未知 schema 返回不兼容状态，不自动 clear/覆盖/降级。

### 4.3 IPC 与存储统一约定

所有新 IPC Rust 端放在 `terminal/local_directories.rs` 或 `session/resume.rs` 并在 `src-tauri/src/lib.rs` 注册；新错误使用 `{code,message}` 序列化，前端 wrapper 兼容既有 String 错误。不修改全局 IPC 错误系统。

| 接口（拟新增/扩展） | 输入 | 输出及读写条件 |
|---|---|---|
| `list_common_local_directories`（扩展 wire 返回） | 无 | `{revision: number, directories: LocalDirectoryShortcut[]}`；前端统一 wrapper/hook 接受旧数组作为兼容输入。目录 revision 在持久化事务内递增，不以系统时间代替。 |
| `record_local_directory_use` / `recordLocalDirectoryUse`（新增） | `{backendSessionId,path}` | `{changed,directory}`；只接受 live native-local cwd 确认；成功事务广播目录 revision。 |
| `get_welcome_run_snapshot` / `getWelcomeRunSnapshot`（新增） | 无 | `{record: RunSnapshotRecord\|null, legacyCandidate: SnapshotEntry\|null, issue: ResumeIssue\|null}`；未知 schema/存储失败为结构化错误，不能落为 null。删除配置的条目保留在 record 中由前端预检报 missing-session。 |
| `commit_welcome_run_snapshot` / `commitWelcomeRunSnapshot`（新增） | `{batchId, entries, activeIdentity, expectedRevision?, restored?:boolean}` | `{record,applied:boolean}`；条目经 Rust 侧基本校验（无空 entries、类型合法），时间/sequence/revision 由 Rust 产生；expectedRevision 不匹配时返回当前记录不覆盖。恢复成功提交 restored=true 并同时清 clear 标记。 |
| `clear_welcome_run_snapshot` / `clearWelcomeRunSnapshot`（新增） | `{expectedRevision}` | 原子删除+clear 标记；revision 冲突返回具体错误，防止删除新的记录。 |
| `create_local_terminal`（扩展成功 DTO） | 既有参数 | 原 `{sessionId,shellId}` 加 `directoryUseWarning: string|null`；失败仍由启动路径报告，历史写失败不导致重复创建。 |

目录 DTO/返回 envelope 的消费者已定位于 Welcome、stub 与测试；TASK-02 统一适配，不能让前端把 envelope 误当空数组。`welcome_metadata` 中分别存 directory revision、session clear 标记与 migration 状态，职责不相互覆盖；session resume 被清除后其 revision 仍在 metadata 中单调推进，防止清除再建立造成 ABA 冲突。

SQLite 访问复用现有 `AppState.db`，事务写入完整记录；不得在网络调用、文件探测、认证等待或 async await 期间持有 std MutexGuard。恢复记录读取失败不影响原有手动打开功能。数据向前升级为 additive tables，回退旧代码可忽略新表；不能声称旧版本能维护新历史。再次升级只补读上次迁移之后旧版产生的命令会有成功性歧义，首版不自动再迁移，保留已确认记录并接受这段使用时间未知。

## 5. 准确改动落点与责任

所有“新增”路径/符号是计划，当前仓库不存在，不可据此声称实现已落地。测试按对应生产文件职责分配；共享文件按任务依赖顺序追加，禁止整文件替换其他人的改动。

| 路径/符号 | 具体职责 | 任务 |
|---|---|---|
| `src-tauri/src/terminal/local_directories.rs`（新增） | `init_tables`、`migrate_legacy_history`、`normalize_path_key`、`merge_directory_candidates`、`compare_directories`、`record_successful_local_start`、`record_local_directory_use`、`list_directory_shortcuts`；目录 DTO、事务、revision、探测队列 | TASK-01 |
| `src-tauri/src/terminal/pty.rs` | 拆出默认目录候选生成；复用受限旧命令解析；替换无条件 Windows lowercase identity；保留 shell 枚举/启动行为 | TASK-01 |
| `src-tauri/src/terminal/mod.rs` | 注册子模块；原 list command 委托新模块；create/close 生命周期写入及清除 native runtime 去重；`LocalTerminalCreated` 扩展 | TASK-01 |
| `src-tauri/src/state.rs` | `local_directory_runtime` 和有界探测状态，资源释放及状态初始化 | TASK-01 |
| `src-tauri/src/session/db.rs`：`init_db`；`src-tauri/src/lib.rs`：command 注册/setup | 先加目录表初始化/IPC；session 表初始化/IPC 后由 TASK-03 追加。改动 Rust 状态构造点由对应任务修齐 | TASK-01 -> TASK-03 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 添加 `same-file` 直接依赖，复用已锁定的兼容版本；不改工具链 pin 或无关依赖 | TASK-01 |
| `src/lib/ipc.ts` | TASK-02 负责目录 DTO/envelope/事件和 warning；TASK-03 再追加 session IPC/types，保持旧函数调用者兼容 | TASK-02 -> TASK-03 |
| `src/hooks/useWelcomeDirectories.ts`（新增）、`src/components/WelcomePanel.tsx` | 目录加载/错误/事件/过期请求；目录行状态、实际时间、稳定 ID、重试，保留过滤与页签 | TASK-02 |
| `src/components/terminal/TerminalPanel.tsx`、`src/lib/terminalCwd.ts` | 成功/OSC 的结构化本地使用报告、严格 cwd 边界、WSL/MSYS区分、错误提示；TASK-04 后追加可选 lifecycle outcome | TASK-02 -> TASK-04 |
| `src/layouts/MainLayout.tsx`：`openLocalTab`、TerminalPanel回调接线 | TASK-02先提供独立LocalLaunchOutcome及关闭pending清理；TASK-04复用并扩展到保存session队列，不能使目录工作等待D-01 | TASK-02 -> TASK-04 |
| `src-tauri/src/session/resume.rs`（新增）、`src-tauri/src/session/mod.rs` | run snapshot DTO、schema、legacy 候选、commit/clear、revision CAS、schema 校验；未知协议不得走 SessionType 的默认 SSH 回退 | TASK-03 |
| `src/lib/welcomeSessionResume.ts`（新增） | SnapshotEntry/RunSnapshotRecord 类型、eligible 判定、operation 与 outcome 类型、非敏感配置身份比较；类型与 Rust 契约对齐 | TASK-03 -> TASK-04 |
| `src/layouts/MainLayout.tsx`、`src/types/index.ts` | 队列 requestId/origin、opener 返回结果、认证取消/继续传播、tab outcome/版本标记、快照收集（合格条目/活动项/抑制）；不持久化整个 Tab | TASK-04 -> TASK-05 |
| `src/components/filebrowser/FileBrowser.tsx`、`LocalFileBrowserPanel.tsx`；`src/components/database/DbClientTab.tsx`、`RedisClientTab.tsx`、`HBaseShellTab.tsx` | 从 attach/connect/本地列目录/已有查询工作区加载路径发出 ready/partial/error；不能只看通用 attached/挂载状态 | TASK-04 |
| `src/components/rdp/RdpPanel.tsx`、`src/components/vnc/VncPanel.tsx`、`src/components/objectstorage/ObjectStorageBrowser.tsx`、`src/components/mail/MailClientTab.tsx` | 适配 connected、attach、缓存 load 和失败结果；复用 `rdpStore/vncStore/sftpStore/objectStorageStore` 已有事实，原则上不改 store 的连接协议 | TASK-04 |
| `src/hooks/useWelcomeSessionResume.ts`（新增） | 主窗口 ready+active 收集、单操作去重、revision 冲突、恢复抑制写回、焦点归属、重试/取消/清除、退出队列 flush | TASK-05 |
| `src/components/WelcomePanel.tsx`、`src/layouts/MainLayout.tsx` | 恢复操作行及 hook 接线；复用 ConfirmDialog、现有 status bar，不改已有最近全部/筛选/多选语义 | TASK-05 |
| `src/lib/i18n/locales/en.ts`、`zh-CN.ts` | 新目录状态/恢复文案同步；保持 key 对应关系 | TASK-02 -> TASK-05 |
| `src/stubs/tauri-core.ts` | 目录与 resume 新 schema、CRUD/错误的浏览器辅助实现；继续明确不支持 create_local_terminal，不能添加无条件成功伪 PTY | TASK-02 -> TASK-05 |
| `src-tauri/tests/integration/welcome_recents_resume.rs`（新增）、`src-tauri/tests/integration/main.rs` | 统一 binary 中注册 SQLite/真实目录生命周期集成用例，不增加另一个顶层重型 test binary | TASK-06 |
| `qa-ui-auto-tests/cases/TC-WELCOME-RS-*.testcase.yaml`（新增）；`feature-list.md` 的 F1.6 | 四个明确边界的 browser 用例、controls/covers、邻接回归 | TASK-06 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/welcome_recents.py`（新增）、`fixtures/__init__.py`；`.agents/skills/qa-ui-auto/references/testid-catalog.md` | 专题 browser fixture 和注册、由工具生成目录；不为通过验收修改已有无关 native reset 行为 | TASK-06 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/reset_db.py` | 仅将新增browser存储键加入清理所有权；本专题不调用或修改其native删除路径 | TASK-06 |
| 本文第 7-10 节、`qa-ui-auto-report/welcome-recents-session-restore/`（gitignored 产物目录） | 汇总验证、三端检查、当前 Windows 真机证据和剩余平台接续状态 | TASK-07 |

## 6. TASK 工作包

### TASK-01：目录后端、身份与兼容迁移

- 状态：待执行，可立即开始。输入：第 2 节 E-02 至 E-07、第 4.1/4.3 节、根 AGENTS；依赖：无。
- 文件职责：第 5 节目录 Rust 文件、state、Cargo 依赖、DB 初始化及 command 注册。负责所有新 struct 字段涉及的 AppState 构造点同步，不只修改主构造点。
- 实施要点：先做纯合并/排序与可注入 clock/default-provider；再做 SQLite nullable 时间/alias/migration 事务；最后接成功 spawn/OSC/close。探测必须在 DB 锁外，定义并清理 per-runtime 状态。启动已成功但历史写失败返回 warning。
- 关联验收：AC-01 至 AC-07、AC-17、AC-18。验证：V-01、V-02；与 TASK-06 合作 V-09。
- 完成条件：旧 DB 幂等升级，真文件身份案例不误合并，失败启动不写，序列化 envelope 测试通过；给 TASK-02 实际 DTO 和命令错误样例。仅格式化编辑过的 Rust 文件，不能运行项目全量 cargo fmt。

### TASK-02：目录前端、终端确认与 Welcome 展示

- 状态：待执行，可先实现类型/组件测试，IPC 集成依赖 TASK-01。
- 文件职责：目录 IPC、useWelcomeDirectories、WelcomePanel 目录部分、MainLayout.openLocalTab最小启动结果、TerminalPanel 本地 cwd/结果回调分支、terminalCwd、两个 locale、browser stub 目录部分及同位测试。
- 实施要点：保留列表顺序/过滤；读 envelope 与旧数组兼容；只有 native local 确认调用结构化 IPC；明确 WSL/MSYS 分类，不能沿用 isLocal 便认为路径在主机。保证 failed 状态、retry、pending、listener 清理和 stale response。替换 list 失败清空数组、锁忙默认降级的可见行为。
- 关联验收：AC-01 至 AC-07、AC-17、AC-18。验证：V-03、V-04，与 TASK-06 的 V-08 和 TASK-07 的 V-10。
- 完成条件：验证真实目录顺序而非只检查调用次数；重复 OSC、失败请求、hidden/active 刷新有行为断言；旧 Welcome 筛选和启动选项测试继续通过。

### TASK-03：运行批次快照存储与引用契约（B）

- 状态：已随 D-01=B 确认解除阻塞。独立源码阅读和测试数据准备可先进行。
- 文件职责：session/resume.rs、session/mod.rs、session/db.rs、lib.rs 注册、ipc.ts session 部分、welcomeSessionResume.ts 的数据类型/eligible 判断及同位测试。共享 lib.rs/db.rs/ipc.ts 在目录任务变更之上追加。
- 实施要点：实现单行批次快照（entries_json 有序条目、batch_id、active_identity）、legacy 单条目候选、clear tombstone、未知版本保护、revision/CAS、删除配置条目错误；原 `last_connected_at` 不改语义。entries 经 Rust 基本校验，时间和 sequence 由 Rust 决定。
- 关联验收：AC-08、AC-09、AC-14、AC-15、AC-16、AC-19、AC-20。验证：V-05、V-09。
- 完成条件：legacy 不制造成功时间；REPLACE 保存 session 不删除 snapshot；clear 后不复活；CAS 与未知 schema 不能破坏有效记录；输出与前端类型完全匹配。

### TASK-04：复用连接队列并提供真实打开结果（按条目重放）

- 状态：待执行；依赖 TASK-03 类型；TerminalPanel 修改在 TASK-02 之后集成。
- 文件职责：MainLayout 队列/所有 opener、types/index、各协议面板的可选 onOpenOutcome、welcomeSessionResume 的适配类型、MainLayout 和面板同位测试。
- 实施要点：建立 requestId -> tabId -> lifecycle generation 关联，密码/保险箱/MFA/证书与取消传播不丢失归属；opener 使用 UUID。按 4.2.2 能力表逐条目落实成功等级，明确部分失败。normal 队列可忽略最终 outcome，但不能回归已有认证串行行为。快照收集（合格条目、活动项、恢复抑制）在本任务接线。
- 关联验收：AC-09 至 AC-13、AC-15、AC-16、AC-19、AC-20。验证：V-06、V-12；需要的真实协议依赖在 V-11 单列。
- 完成条件：覆盖所有宣称 eligible 的类型；无泛化“tab 存在即 ready”；没有为恢复添加自动重跑任务/SQL/传输；取消后新 runtime 释放，既有 live tab 不受影响。面板输出结果必须有可观察用户结果断言。

### TASK-05：恢复协调器与 Welcome 入口（批次重放）

- 状态：待执行；依赖 TASK-03/04；与 TASK-02 目录功能集成。
- 文件职责：useWelcomeSessionResume、WelcomePanel 恢复部分、MainLayout hook 接线/退出 flush、locales、browser stub resume 部分、hook 和组件测试。
- 实施要点：单入口/单 operation、按记录顺序逐条目重放、活动项恢复、逐条目 outcome 聚合、恢复暂缓写回、已有 tab/窗口冲突、当前配置读取、revision 条件提交、失败项重试与焦点归属。快照收集去重/抑制由 hook 提供，MainLayout 采集。新正常使用不能被旧恢复结果覆盖。
- 关联验收：AC-08 至 AC-20。验证：V-07、V-08、V-10、V-11。
- 完成条件：全状态用户流程可观察；再次进入 Welcome 不丢 operation 或改过滤；普通启动与恢复相同目录遵守同一时间规则；恢复记录 write error 不重复打开。

### TASK-06：集成测试与 UI 自动化交接

- 状态：待执行；目录测试可随 TASK-01/02 开始；session 测试实现依赖 TASK-03 至 TASK-05。
- 文件职责：Rust welcome 集成模块；新的 TC-WELCOME-RS cases/fixture；F1.6 controls、自动生成 testid catalog；必要的相关回归用例修改限本功能。
- 实施要点：真实 SQLite reopen/rollback、真实路径测试；browser 使用 VFS File session 验证一键打开/去重，用现有“不支持本地 PTY”验证失败保留。fixture 只在隔离 browser context 写明确测试键，YAML 不用 eval_readonly 变更状态。不能让重新 seed 的页面被当成持久化通过。
- 关联验收：全部 AC 的自动化部分。验证：V-08、V-09、V-12。
- 完成条件：schema/lint/catalog/audit 有结果；新用例有行为结果而非仅控件存在；所有 skip 有真实原因，不能改 baseline 抹平回归。本次文档不领取 backlog、不启动多 agent、不修改看板。

### TASK-07：整体集成、三端检查、当前端真机与证据回填

- 状态：待执行；依赖被交付范围内的前序任务。
- 文件职责：最终集成与本文 AC/V/证据表；按 V-10/11 执行原生步骤，产物仅在 gitignored report 目录。
- 实施要点：执行相关自动化及当前 Windows 构建，检查三端 cfg/API；用 debug 独立 app-data 和测试目录完成正常退出/异常终止/重开、权限和联动步骤。macOS/Linux 保留独立未验证计划；发现已知编译不兼容必须处理。
- 关联验收：AC-01 至 AC-18。验证：V-10 至 V-12。
- 完成条件：当前 Windows 原生主流程及本轮必要自动化通过，有脱敏步骤和实际证据；其他平台明确未验证与接续方式，不继承当前平台结果。

## 7. V 验证方案

### 7.1 测试矩阵

全部计划项初始为**待执行**。测试文件中的拟新增对象需随所属任务实现，以下命令不是声称当前已有这些新测试。

| V ID | 层级/文件 | 数据、动作和必须断言 | AC | 状态 |
|---|---|---|---|---|
| V-01 | Rust inline：新增 `terminal/local_directories.rs` tests；保留 pty 的 directory_shortcut_tests | 注入固定时间/OS 默认候选：A=3000、Home=2000、Downloads=1000，另有旧 rank、无时间 default、同时间项；打乱输入仍同顺序。默认+历史合并不失时间；Windows/Linux/macOS分别以真实文件身份确认同/异实体；根/UNC/空格/反斜杠/Unicode不损坏；alias retarget 不转移旧目标时间；24 非默认限额不把默认固定置顶。 | 01/03/04/18 | 待执行 |
| V-02 | Rust inline：目录 SQLite/生命周期 | tempfile DB 装入旧 command_history，有成功性未知 cd、relative、bad timestamp、同秒 id；两次 migration/reopen 数据相同，lastUsed 仍 null；事务中途失败无完成标记。模拟 spawn 失败、注册失败、输出通道失败、DB busy；无假使用写入，成功 spawn 的 write failure 只 warning。clock 回拨不生成未来时间。 | 02/03/05/06/07/17 | 待执行 |
| V-03 | Vitest：`TerminalPanel.test.tsx`、`terminalCwd.test.ts`；新增 `useWelcomeDirectories.test.tsx` | native local 成功/失败，A->B->A 与重复 OSC；同 spawn 首次 OSC 不重复；远程/WSL未知映射不写；Windows /D:/、MSYS /d 与 UNC，Unix含反斜杠按原路径；记录 write warning 不再次 create；事件合并、取消 listener、旧响应晚到不覆盖新列表。 | 02/04/05/07/17 | 待执行 |
| V-04 | Vitest：`WelcomePanel.test.tsx` | 返回排序后的混合默认/历史数组，断言实际 DOM 行路径顺序、时间未知文案；过滤保序；load error 保留旧数组；不可用可重试但时间不动；pending 不重复分发；返回 Welcome 不强制切历史 tab。 | 01/03/05/06/18 | 待执行 |
| V-05 | Rust inline：新增 `session/resume.rs` tests | 旧 sessions 候选取最大有效时间/id；配置更新但 last_connected 空不进入；entries 含原始未知类型/空数组被拒或按校验处理；savedSessionType 原始未知值不默认 SSH；新确认快照优先；clear tombstone、delete session、REPLACE 更新、schema>1、CAS 不匹配、事务失败/reopen 保留有效记录。sequence/revision 单位和冲突验证。 | 08/09/14/15/16/19/20 | 待执行 |
| V-06 | Vitest：`MainLayout.test.tsx` 与受影响面板测试；新增 `welcomeSessionResume.test.ts` | 表驱动逐协议判定最终 readiness，至少实际调用适配器的 fulfilled/rejected/partial 分支；认证暂停/提交/取消/MFA，操作 ID 不串线；反复按钮/普通队列同目标只建一个；不同配置 live tab 冲突；取消 late resolve 关闭自己新资源、不关闭已有资源。快照收集：合格条目增删/激活/关闭全部/空快照不提交/恢复抑制。SQL恢复内容/active panel断言，不能仅数回调。 | 09/10/11/12/13/15/16/19/20 | 待执行 |
| V-07 | Vitest：新增 `useWelcomeSessionResume.test.tsx`、WelcomePanel 测试 | fake DB/可控 Promise：按顺序重放条目；认证暂停逐条目；partial 聚合与仅失败项重试；空/失败/partial 不写快照；恢复抑制写回；旧恢复完成不覆盖较新正常提交；存储错误不重连。断言按钮状态、错误文案、最终 tab 数量/顺序/活动项、focus 和记录内容。 | 08-20 | 待执行 |
| V-08 | browser YAML：第 7.2 节 4 个新 case，现有 TC-038 和 recent-sessions 回归 | VFS 固定目录数据的实际 DOM 顺序；保存嵌入 File session 成功打开/定位，三个 tab 页面都可用恢复入口；本地 PTY 不支持错误不能覆盖 seed 的有效记录；无历史禁用、clear 不复活。新功能失败/成功使用各自真实 browser 能力，不伪造 PTY。 | 01/03/06/08/09/11/12/13/15/17/18 的 UI 部分 | 待执行 |
| V-09 | Rust integration：新增 `tests/integration/welcome_recents_resume.rs` | 真实 tempfile 目录+独立 SQLite：init->旧数据导入->写确认记录->释放 Connection->重开排序/恢复对象一致；未 commit 事务回滚；删除/权限恢复；两连接CAS/并发冲突；spawn 成功/close 后 runtime 不再接受 cwd。使用服务层真实函数，不声称已覆盖 Tauri WebView。 | 01-10/14/15/17 | 待执行 |
| V-10 | Windows 当前端真机，第 8 节步骤 | 真实 WebView2+Rust+本地 PTY、默认目录、保存 LocalShell、正常/异常退出和真实 app-data reopen、未保存临时终端边界、目录失败/重试/联动。 | 01-15/17/18 | 待执行 |
| V-11 | 三端协议/认证及部分成功原生步骤，第 8 节 | Windows 本轮执行 SSH/SFTP 真实服务和 DB 子状态部分失败；macOS/WKWebView、Linux/WebKitGTK执行同样核心链。至少核对重新建连接、认证取消保留、原进程/任务未被复活。其他 eligible 类型安排代表性当前端回归与按协议能力所需服务。 | 10-18 | 待执行 |
| V-12 | 类型/build/回归/catalog及三端代码审查 | pnpm build；当前平台 cargo check；受影响测试；F1.6 catalog/audit gate；检查 cfg(windows/target_os)、Path 规则、same-file依赖、原命令注册；检视 Welcome最小尺寸/缩放/中英文键盘焦点。 | 全部 AC 的集成，尤其18 | 待执行 |

表中的 AC 简写 `01` 指 AC-01，`08-18` 指 AC-08 至 AC-18。模拟 busy/时钟/协议失败使用测试注入，不增加面向普通用户的故障开关。

### 7.2 UI 用例、controls 与 fixture

新用例 ID `TC-WELCOME-RS-01` 至 `TC-WELCOME-RS-04` 在本次目录搜索中未存在，**尚未登记**，实施时再次查重。均 `covers: [F1.6]`、`modes: [browser]`、`fixtures: [reset_db, welcome_recents]`；按 authoring 规则使用 `welcome,p1,auto-generated,needs-review`，无 live 服务的短用例才加 smoke。适用时在RS-03补读取延迟/失败fixture来实际点击cancel、retry、edit；仅允许模拟读取时序/错误，仍不将本地PTY改成成功。不能为操作optional control而声称浏览器具备原生能力。

| 新文件 | 流程与结果 |
|---|---|
| `TC-WELCOME-RS-01-directory-order.testcase.yaml` | fixture 创建 VFS 目录及确认/未知时间种子，点击 directories tab，以 `[data-testid="welcome-local-directory"]` 的 DOM 路径顺序断言 A/Home/Downloads；搜索并清空后顺序不变，检查 default 使用时间未丢；点击不可启动本地终端的行，返回 Welcome 后时间不变。 |
| `TC-WELCOME-RS-02-restore-single.testcase.yaml` | fixture 种子为已保存的嵌入 File session 指向可读 VFS 目录，恢复后看到该目录实际条目和唯一 file-browser tab；进入 Welcome 再恢复只定位原 tab；切换 workspaces/directories 后入口仍同对象，原过滤未被清空。 |
| `TC-WELCOME-RS-03-restore-failure.testcase.yaml` | 已有确认 resume=保存 LocalShell；browser create_local_terminal 的真实不支持错误导致 failed，重试不累积失败 tab；resume JSON 保留原对象/时间；取消不更改；断言明确失败而非“已恢复”。 |
| `TC-WELCOME-RS-04-empty-and-clear.testcase.yaml` | 空库入口禁用；通过当前 UI 创建/成功打开嵌入 File session，返回 Welcome有候选；清除确认后 empty且旧最近列表仍在；重新读取候选不从 legacy 自动复活。 |

拟新增 fixture 使用当前 registry 的 setup/teardown 接口，只在 browser context 的 init script 中给上述 stub 新键/VFS固定测试路径赋值，不向原生 app-data 写入。测试键建议 `taomni.welcome.directoryUsage.v1` 与 `taomni.welcome.sessionResume.v1`，清理需纳入 browser fixture 生命周期及 reset_db 所有权；真实桌面不读取这些键作为权威。各 case 可用自身 ID选择数据，固定 t1/t2/t3 只在 fixture 存在，不在产品中生成假时间。

已读当前 `reset_db.py`：browser init script 每次 page load 清理已登记键；因此这四个 case **不使用 reload 来证明持久化**，更不能每次重新 seed 后声称 restart 通过。真正 restart 由 V-09/10 验证。已读 native reset 路径会先计算常规 app-data 再处理 `NEWMOB_DATA_DIR`；本专题不直接用该 fixture 执行 Windows 原生清理，避免涉及开发者真实数据。原生采用第 8 节独立手工流程；以后若自动化，先实现仅操作已校验隔离路径的专题 fixture 并验证，不把现成脚本存在当作隔离成立。

F1.6 需补/核对的 controls（以下没有声称当前已登记）：

| selector | 类型与断言 |
|---|---|
| `[data-testid="welcome-history-tab-directories"]` | 现有交互，点击进入目录页签 |
| `[data-testid="welcome-local-directory-filter"]` | 现有交互，fill 后实际结果及相对顺序 |
| `[data-testid="welcome-local-directory"]` | 现有交互，多行用 data-directory-path/id 派生；点击及实际时间不变/打开结果 |
| `[data-testid="welcome-directory-retry"]` | 拟新增交互，load 失败重试，不能只 assert_visible |
| `[data-testid="welcome-restore-last-session"]` | 拟新增交互，禁用/重复点击/成功导航 |
| `[data-testid="welcome-restore-status"]` | 拟新增 display，data-state=loading/empty/available/restoring/awaiting-auth/succeeded/partial/failed/unavailable |
| `[data-testid="welcome-restore-retry"]`、`[data-testid="welcome-restore-cancel"]` | 拟新增交互，按操作状态 optional；实际重试/取消不改有效记录 |
| `[data-testid="welcome-restore-clear"]`、`[data-testid="welcome-restore-edit"]` | 拟新增交互，clear 确认/编辑被保存配置；不通过控件可见推断操作成功 |
| `[data-testid="welcome-restore-use-default-cwd"]` | 拟新增交互，仅 missing cwd 可用；默认降级及部分成功主要由组件测试+native 覆盖，若 browser 无真实前置应如实标覆盖缺口 |

YAML 用 `click/fill/wait_for/assert_attribute/assert_count/assert_text/assert_disabled/assert_localstorage`；DOM 顺序可用不超过 400 字符的只读 `eval_readonly` 表达式读取行属性并比较固定值，不能在 expression 内 seed 状态/调用 IPC。新增控件目录由 `qa_ui_auto.gen_testid_catalog` 生成，不能手改生成文件制造通过。现有 `TC-auto-F1-6-welcome-recent-sessions` 保留“批量打开最近配置”的语义，不改成新恢复入口的替代测试。

### 7.3 经源码核对的执行命令

根目录 / PowerShell，前端依赖先 `pnpm install`；新增路径落地后执行：

```powershell
pnpm test src/components/WelcomePanel.test.tsx src/components/terminal/TerminalPanel.test.tsx src/lib/terminalCwd.test.ts src/layouts/MainLayout.test.tsx src/stores/sessionStore.test.ts
pnpm test src/hooks/useWelcomeDirectories.test.tsx src/hooks/useWelcomeSessionResume.test.tsx src/lib/welcomeSessionResume.test.ts
pnpm build
```

在 `src-tauri/`，当前平台有 Rust 1.94+、protoc、完整 Perl、Bash 及 Tauri 原生依赖后：

```powershell
cargo test --lib terminal::local_directories
cargo test --lib terminal::pty::directory_shortcut_tests
cargo test --lib session::resume
cargo test --test integration welcome_recents_resume
cargo check --lib
```

macOS 直接 Cargo 前必须先在根目录执行 `bash scripts/bundle-krb5-macos.sh stage`；其他原生依赖参照 `.github/workflows/release.yml`，不擅自换 edition 或加 toolchain pin。测试报告须显示匹配用例数量；零个用例、忽略或因缺少环境变量提前返回不能算通过。

UI 目录维护及 runner（根目录 / PowerShell）：

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python -m qa_ui_auto.gen_testid_catalog
python -m qa_ui_auto.audit --feature F1.6
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.runner --config qa-ui-auto-report/welcome-recents-session-restore/browser.config.yaml --mode browser --filter TC-WELCOME-RS-01,TC-WELCOME-RS-02,TC-WELCOME-RS-03,TC-WELCOME-RS-04 --workers 1
```

`browser.config.yaml` 是 TASK-06 拟生成的专题配置，`app.base_url` 指向本轮独立 `pnpm dev` 的实际 URL，`app.mode: browser`；不改当前仓库默认 native 配置（当前 base_url=1980，mode=native，Windows binary/driver 路径均不能跨端照搬）。前置需 Python runner 依赖及 Playwright Chromium，安装按技能现有 README/requirements；依赖就绪后启动本轮 dev server，端口被占用则用实际新端口并更新专题配置。上述四个 browser case不需要真实 SSH 服务。

新增行为完成后的针对性回归包含现有 66 项基线、TerminalPanel、受影响协议面板、sessionStore、Recent Workspaces、保存连接批量认证/队列、detach/reattach。先运行受影响文件，失败或共享契约变化再扩大范围；设计阶段不要求全仓测试来证明文档正确。

## 8. 三端真机验证手册

### 8.1 环境与隔离

| 平台 | 被测应用与依赖 | 本轮状态/接续 |
|---|---|---|
| Windows（当前端） | 记录实际 Windows版本、CPU架构、WebView2版本；`pnpm tauri dev` 启动本轮 debug Tauri/Rust。PowerShell + cmd/可用 Bash；WSL仅在实际安装 distro 时额外验证边界 | V-10/11 待执行，实施交付时本轮必须完成；本设计阶段没有启动原生应用。 |
| macOS | 记录 macOS/架构/WKWebView；Xcode工具、Rust、protoc、Perl及 Kerberos stage；zsh/bash；case-sensitive APFS测试卷或目录准备 | 未验证，实施后在 macOS开发/测试机执行同样步骤；Tauri WebDriver不支持 macOS，使用手工真实 UI证据。 |
| Linux | 记录发行版、架构、X11/Wayland、WebKitGTK版本；release.yml规定系统包、Rust/protoc/Perl；bash；普通非root用户 | 未验证，实施后在 Linux桌面执行同样步骤；可用 tauri-driver/WebKitWebDriver辅助，但不能用Xvfb browser代替原生。 |

使用独立测试用户的 Home 和系统常用目录最容易验证默认目录而不污染开发者目录。若使用当前用户，Home/Desktop等只作为目录打开对象，所有文件与 chmod 故障只在本轮测试根下创建。记录默认目录的真实 OS解析路径，不写死用户名/磁盘。

Windows 根目录 / PowerShell 示例（仅生成本轮路径，不更改 `$HOME`）：

```powershell
$welcomeRunRoot = Join-Path (Get-Location) ("qa-ui-auto-report/welcome-recents-session-restore/native-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $welcomeRunRoot -Force
$env:NEWMOB_DATA_DIR = Join-Path $welcomeRunRoot "app-data"
New-Item -ItemType Directory -Path $env:NEWMOB_DATA_DIR -Force
New-Item -ItemType Directory -Path (Join-Path $welcomeRunRoot "workspace/A"),(Join-Path $welcomeRunRoot "workspace/B"),(Join-Path $welcomeRunRoot "workspace/has space") -Force
pnpm tauri dev
```

执行者保存并在结束后还原原有 `NEWMOB_DATA_DIR` 环境值。启动前验证其为本轮根下绝对路径；就绪后读取该路径中新建的 `taomni.db`，确认数据库和界面来自同一实例。Windows debug 主 WebView 的 data directory override 可在 lib.rs 观察；其他端不要推断同样隔离，使用独立 OS测试用户保证 WebView偏好也隔离。**NEWMOB_DATA_DIR 仅 debug 生效**；打包 release验证必须使用独立 OS用户，不能用该变量声称隔离成功。

macOS/Linux在独立测试用户下，根目录 Bash 分别创建绝对测试根后 `export NEWMOB_DATA_DIR="<本轮绝对路径>/app-data"`、`pnpm tauri dev`；macOS先 stage。占用1980的其他服务不得停止，使用 Tauri支持的本轮配置 override 配套修改 devUrl/Vite端口，记录具体配置和实际URL。

V-11真实依赖：隔离SSH/SFTP服务器、测试账号与可撤销凭据，按现有 `TAOMNI_LIVE_SSH_HOST/PORT/USER/PASSWORD` 或 `QA_SSH_PASSWORD` 名称引用，文档/产物不能包含值。数据库子工作区使用可丢弃的本地 PostgreSQL/MySQL/其他实际支持实例及只读/测试库账号；记录服务版本和后端ready探针结果。VNC/RDP/ObjectStorage/Mail等若运行对应原生回归，准备相应测试服务/设备，缺少时逐项记录未验证，不能称所有协议实测通过。

### V-10：目录、保存本地会话及重启（Windows 本轮必做）

1. 清空仅本轮隔离数据后首次启动。Welcome恢复入口empty；Local Directories默认项没有伪使用时间。记录目录DTO/SQLite rows及截图。
2. 在本地终端中以真实 `cd`/`Set-Location` 访问测试A、B并等待实际cwd确认；从Welcome启动Home，再启动A。查询新表真实毫秒值，回Welcome观察 A/Home/B按成功时间倒序。每次操作间等待不同实际毫秒只是手工观测辅助；相同时间由V-01固定clock验证。
3. 同cwd重复prompt/查询，时间不变化；B再A则更新。输入不存在的路径和不可执行的启动配置，失败后原顺序/时间不变；返回Welcome过滤路径再清空，顺序不变。
4. 用系统常用目录的另一个路径写法访问同目录，确认只有一行且默认名称保留。Windows大小写、UNC根和空格必测；junction需测试权限，不能创建时记录未执行，并用普通大小写测试+Rustidentity测试证明已有覆盖范围。Linux/macOS分别测symlink、实际case-sensitive/insensitive卷。
5. 成功记录A后关闭相应终端，将A在本轮根内暂改名，或断开本轮专用挂载；回Welcome行保留并打开失败。还原路径再原行重试，成功才更新时间。权限故障在测试子目录上对测试用户撤销遍历/读取权限，记录并还原ACL；不得修改真实Home权限。Unix非root测试用户使用受限目录，root绕过权限不算有效失败测试。
6. 经会话编辑器新建并保存 `LocalShell` 配置 `qa-welcome-local`；成功打开后进入测试A，等待resume记录写入。关闭该tab，再从Welcome恢复：新PTY ID且实际 `pwd`/`Get-Location` 为A，目录A时间推进。再次进Welcome点恢复，tab/进程数不增加且目录时间不变。
7. 打开一个没有保存sessionId的临时本地终端并确认cwd，随后回Welcome。按方案B，它应进入快照（白名单条目）；WSL/无确认cwd终端不进入。既有最近目录仍可因真实cwd使用变化。此步骤是D-01=B边界的实物验收。
8. 从窗口X正常退出，再使用相同隔离app-data启动。无自动建连，Welcome候选仍为qa-welcome-local，目录排序/毫秒值与退出前一致；恢复后仅一个tab。先只打开Welcome又退出，第三次启动记录仍在。
9. 成功提交记录后，通过OS任务管理器/进程管理工具终止**本轮已记录PID的应用实例**，不操作其他Taomni进程。重启确认最后已提交记录可恢复；待提交事件可能丢失但表不能变空/半写。检查旧PTY是否被应用清理/OS终止，新恢复PTY必须新ID；遗留进程即便存在也不可自动接管。
10. 将resume指向的A暂改名，恢复先明确失败；不操作降级时记录不变。点“使用默认目录打开”后标记partial，只记录真实确认的新cwd，原A使用时间与resume context不变；还原A并重试原上下文可完整恢复。
11. 使用脱敏的旧版独立taomni.db副本，包含默认目录命令、相对路径和无时间兼容种子，在隔离app-data升级。旧时间保留为legacy，不用启动时间填充；第二次启动无重复导入，顺序一致。种子修改仅在应用关闭后用SQLite工具执行，不能编辑开发者数据库。
12. 以800x600、1280x800、系统100%与至少一个高DPI缩放检查中英文，长名称/UNC路径不覆盖按钮；Tab/Enter/Space、取消认证后焦点、成功后终端可立即输入。切去其他tab再等恢复完成，焦点不得被抢回。

每步同时保存用户可见结果和必要的系统副作用：DTO/脱敏SQLite查询、tab与runtime ID关系、目标cwd输出、目标PID记录。截图仅证明可见状态，不能独自证明SQLite/进程/认证恢复。

### V-11：真实连接、认证、失败与部分恢复

1. 保存两个SSH配置A/B，真实连接B并成为活动tab，退出后恢复B。验证服务端新连接/客户端新backend ID，而不是旧ID被重新使用；配置A即使名称编辑时间更晚也不能取代B。
2. 将测试凭据放入既有vault引用，锁定保险箱后恢复。出现原有unlock/MFA流程；取消时有效记录不变。再次恢复并完成认证，target ready后按钮结果为“已连接”。SSH未配置startup command时不应出现旧shell命令；若有显式startup command，记录这是当前保存配置的连接副作用，不是进程续跑。
3. 停止本轮SSH服务或撤销测试凭据，恢复失败；旧record/revision不被失败结果覆盖，重试不堆叠tab。修复服务后原入口重试成功；后台恢复过程中在另一个保存session正常成功使用，再让旧恢复完成，CAS保护新的上次记录。
4. SFTP成功attach但初始目录读取被拒，主连接仍在，显示partial及具体路径问题；重试缺失目录不得重新创建SSH连接。普通配置打开和批量认证仍按原流程运行。
5. 保存SQL会话并在现有查询工作区持久化两个查询子标签/活动面板，退出恢复，检查实际子标签内容及活动项；不自动执行SQL。用隔离fixture制造子状态缺失/读失败而数据库可连，必须显示partial；仅重试加载子状态，旧有效恢复记录不被部分结果覆盖。
6. 已打开目标tab时恢复只定位；修改保存配置后仍有旧live实例时显示配置冲突，不改旧连接。分离窗口持有目标时按已知owner定位/提示，不因TTL到期重复建立。取消新建操作后晚到成功必须释放该操作新资源。
7. 按实际环境对RDP/VNC connected、命令客户端started、Mail view-opened/ObjectStorage部分失败各记录代表性回归；只有确有协议服务/设备并完成实际握手才记录为该协议原生通过。当前轮的核心SSH/SFTP及DB步骤如缺依赖，是这些V的实际缺口，不能以mock pass替代。

macOS与Linux独立执行V-10/11，额外覆盖它们的真实shell/case sensitivity/权限与WebView焦点。设备缺少时标“未验证，后续在对应OS测试机执行上述步骤”，不阻塞已经完成Windows及必要检查的本轮交付，但不能存在已知三端代码不兼容。

### 8.2 证据与清理

产物目录：`qa-ui-auto-report/welcome-recents-session-restore/<platform>/<run-id>/`。每个V记录AC/V、提交及相关diff、构建版本/模式、OS架构/WebView、执行时刻、命令或手工步骤、真实依赖、实际结果/skip、截图/日志/脱敏SQL摘要路径。需要打包回归时记录二进制路径与hash；开发运行不伪装release验证。本文只链接脱敏摘要，原始凭据、用户路径、服务日志不提交。

清理顺序：正常关闭本轮应用/测试服务；核对并结束只属于本轮的遗留PID；还原本轮目录ACL/挂载/别名与环境变量；撤销测试账号/密钥；保留脱敏证据后删除**已解析并确认在本轮report根内**的隔离app-data、VFS/测试工作目录。Windows在同一PowerShell中用LiteralPath处理删除，不把计算路径传给另一shell。不得清理常规com.taomni.app、用户Home或未知目标；不要运行现有native reset_db来代替这套限定清理。

## 9. AC -> 方案 -> TASK -> V -> 证据追踪

以下所需证据均**待生成**，E-01至E-15是现状证据，不能填作新增AC通过证据。回填时在本表保留ID并添加实际产物/结果摘要。

| AC | 方案位置 | TASK | V/平台 | 所需证据与当前缺口 |
|---|---|---|---|---|
| AC-01 | 4.1.2/4.1.3 | 01/02/06/07 | V-01/04/08/10 | DOM顺序+SQL时间，待实现/执行 |
| AC-02 | 4.1.1/4.1.5 | 01/02/07 | V-02/03/10 | 成功/失败PTY与DB差异，待实现/执行 |
| AC-03 | 4.1.2/4.1.3 | 01/02/06 | V-01/02/04/09 | null/相同时间/重开固定次序，待实现/执行 |
| AC-04 | 4.1.3/4.1.4 | 01/02/07 | V-01/03/09/10，三端 | 身份/alias/大小写实际目录结果，待实现/执行 |
| AC-05 | 4.1.2/4.1.5/4.3 | 01/02/06 | V-02/03/04/09 | migration回滚/幂等、busy不清空，待实现/执行 |
| AC-06 | 4.1.4/4.1.5 | 01/02/07 | V-02/04/08/10 | 缺失/权限/离线与恢复截图+时间，待实现/执行 |
| AC-07 | 4.1.1/4.1.4 | 01/02/07 | V-02/03/10 | cwd事件和非本地主机不写记录，待实现/执行 |
| AC-08 | 4.2.1/4.2.2 | 03/05/06 | V-05/07/08/10 | empty/legacy/confirmed候选，D-01=B已决，待实现/执行 |
| AC-09 | 4.2.1/4.2.5 | 03/04/05 | V-05/06/07/08/11 | 活动对象/非空保护，D-01=B已决，待实现/执行 |
| AC-10 | 4.2.2/4.2.3 | 03/04/05/07 | V-06/09/10/11 | cwd/配置/SQL子状态真实结果，D-01=B已决，待实现/执行 |
| AC-11 | 4.2.3/4.2.4 | 04/05/06 | V-06/07/08/11 | 全状态及readiness文案，D-01=B已决，待实现/执行 |
| AC-12 | 4.2.5 | 04/05/06 | V-06/07/08/11 | tab/连接数及冲突行为，D-01=B已决，待实现/执行 |
| AC-13 | 4.2.4/4.2.5 | 04/05/07 | V-06/07/08/10/11 | 焦点/取消late callback资源归属，D-01=B已决，待实现/执行 |
| AC-14 | 4.2.1/4.2.5/4.3 | 03/05/06/07 | V-05/07/09/10 | 正常/异常退出DB保留，D-01=B已决，待实现/执行 |
| AC-15 | 4.2.3/4.2.5/4.3 | 03/04/05/07 | V-05/06/07/10/11 | 删除/版本/认证/CAS/存储失败，D-01=B已决，待实现/执行 |
| AC-16 | 4.2.1/4.2.2/4.2.4 | 03/04/05/07 | V-05/06/07/11 | 脱敏存档及未重放真实结果，D-01=B已决，待实现/执行 |
| AC-17 | 4.1.1/4.2.5 | 01/02/03/05/07 | V-02/03/07/09/10 | 同目录成功/失败/纯定位时间对比，联动依赖D-01=B |
| AC-18 | 4.1.4/4.2.4/第8节 | 01/02/04/05/07 | V-10/11/12，三端 | 当前端build+native；另两端明确未验证 |

TASK列简写`01`为TASK-01。各层级通过的含义独立：Vitest/mock不证明网络成功；Rust服务层不证明真实WebView；browser/VFS不证明本地PTY；当前Windows结果不外推macOS/Linux。

完整实施交付条件：D-01已确定为B且文档契约一致；相关TASK实施完成；本轮必要自动化/三端代码兼容检查通过；当前平台（Linux）原生核心步骤真实通过；证据表已回填。其他两端缺设备可保留未验证及接续步骤。E-15的66项基线通过不能替代任何新AC。

## 10. 未决项、风险与回退

| 项目 | 依据/影响 | 决策、最小验证与解除条件 | 阻塞范围 |
|---|---|---|---|
| D-01 已决策为方案 B（2026-09-06）：恢复上次运行的 session 标签集合 | 现有session是配置，tabs不整体持久化 | 契约已按 B 修订（4.2 节、AC-19/20），实现按批次快照执行，不拿最近列表冒充集合 | 无阻塞；目录TASK-01/02与本项并行 |
| 旧命令历史无法证明cd成功 | 输入历史与OSC模拟cd混存 | 保留旧时间为legacy观察，lastUsed=null；V-02/09证明不伪造。无需用户另选数据迁移时刻 | 不阻塞，是已确定兼容取舍 |
| 路径identity/网络探测的三端差异 | 现有无条件小写可能误合并；OS调用可能阻塞 | 同实体确认才合并、有界任务、离线保留；V-01/10三端实测，无法证明的别名允许独立行 | 不阻塞设计；实测发现不兼容时阻塞对应实现完成 |
| 每协议没有统一ready/failed契约 | opener/markConnected过早，Mail/命令客户端也不等同网络连接 | TASK-04明确readiness，不依赖无证据的tab出现；V-06及V-11覆盖 | 已纳入实施任务，不是外部审批阻塞 |
| native测试数据隔离不能照搬现成fixture | reset_db当前会计算默认app-data；debug override不是release保证 | 第8节采用隔离手工流程；后续自动化须专题fixture先验证路径，不操作真实用户数据 | 不阻塞当前设计/手工原生计划 |
| 当前端及其他端真机/服务尚未验证 | 本轮只运行现状Vitest，没有检验Rust工具链/服务/设备就绪 | 实施时执行环境preflight并记录实际缺口，不预先宣称环境不足；macOS/Linux保留接续计划 | 当前没有已证实的环境阻塞；不能将待验证假设写成已失败 |

回退采用代码回退和保留新增表：旧版本忽略welcome新表，不删除它们、不重写原sessions/command_history。若单条新恢复记录不可解析，保留其数据并禁用新入口，原普通打开和目录访问可继续；数据库文件整体损坏交由已有备份恢复能力，本功能不自动替换数据库。升级后再次降级运行产生的历史间隙不伪造补齐。

当前可开始：TASK-01目录Rust实现与V-01/02、TASK-02目录组件/契约测试、TASK-03批次快照存储、TASK-06集成用例。D-01已决，无剩余决策阻塞；实现与验证完成状态以各 TASK 状态行为准。
