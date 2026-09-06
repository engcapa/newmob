# Welcome 目录最近使用排序与上次 Session 恢复详细设计

## 1. 交付范围与决策状态

- 类型：现有能力扩展；本次仅交付设计，不包含功能实现。
- 调研日期：2026-09-05；基线提交：`6d3cfb0c3cf2510395d1b238362671efcf6aadd1`；应用版本：根 `package.json` 的 `0.4.22`。
- 写入前工作树干净，目标同名文档不存在；适用规则为根 `AGENTS.md`，未发现更深层 `AGENTS.md`。
- 平台固定为 Windows、macOS、Linux 的 Tauri 桌面应用；当前环境为 Windows / PowerShell。浏览器仅作辅助验证。
- 设计状态：**部分可实施**。目录排序契约已确定；session 部分提供完整的单会话推荐方案，恢复范围仍有一个用户决策项 D-01。本文中的“拟新增”均未实现，全部 TASK/V 初始为待执行。
- 目标：默认目录与历史目录统一按真实最近使用排序；Welcome 提供独立的一键恢复入口，复用既有会话打开、认证及面板能力。

### D-01：Session 恢复范围，待用户确认

已提出的具体问题：新入口恢复“最近使用的单个 session”，还是“上次应用运行的 session 标签集合，包含本地终端但不包含整个工作区”？截至本稿未收到选择；继续工作不视为选择某一范围。

**推荐 A，本文 session 章节的实施基准：最近成功使用的单个已保存 `SessionConfig`。** 同一配置的多个运行标签只恢复/定位一个；不包含 Welcome 临时启动且无 `sessionId` 的本地终端、未保存 Quick Connect、Code Workspace、Git、设置、聊天或分离窗口集合。已保存 `LocalShell` 可以补充恢复已确认的主机本地 cwd。选择 A 时需连同这些边界确认，避免将“单个 session”误读为任意临时标签。

选择 B 会改变数据结构和验收：必须新增运行批次标识、非空标签快照、条目身份/顺序/活动项、临时本地终端的配置白名单，以及逐项结果和失败重试集。此时需原位修订第 4.2、4.3、5、6、7 节中 session 部分和相关 AC，保留本文 ID，新增条目向后编号；不能将最近 N 个 `SessionConfig` 当成上次运行集合。目录方案与 TASK-01/02 不受影响。

本设计不恢复操作系统进程、PTY 输出缓冲、正在执行的命令、传输、数据库事务、运行中的任务或现有网络连接，也不新增整个工作区恢复。不将 `taomni.detached.*` 短期交接数据改成恢复存档。

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

AC-08 至 AC-18 中涉及范围的断言以 D-01 推荐 A 为前提，确认前不宣称这些需求已被产品接受。全部 AC 尚未实现验收。

| ID | 前置、动作 | 必须观察到的结果 |
|---|---|---|
| AC-01 | 默认 Home 使用于 t2，历史 A 使用于 t3，默认 Downloads 使用于 t1，t3 > t2 > t1 | Local Directories 顺序 A/Home/Downloads；系统/常用标签不影响时间排序；搜索后保留相对次序。 |
| AC-02 | 点击目录、创建 tab、启动成功、启动失败分别观察 | 只有成功创建指定 cwd 的主机本地 PTY或确认 cwd 改变更新使用时间；点击/排队/失败不更新，不将失败改为默认目录成功。 |
| AC-03 | 从未用过的默认项、缺时间旧项、两个相同时间项混合 | 有确认时间的记录在前；其余按第 4.1.3 节固定规则；不使用启动/扫描/迁移时刻填空，刷新和同平台重启结果一致。 |
| AC-04 | 默认目录与历史同路径；三端不同分隔符/大小写/别名输入 | 同一已确认身份仅一行，保留默认名称和类型、最大真实使用时间；不误合并大小写敏感卷上的不同目录，离线时不猜测未知别名身份。 |
| AC-05 | 旧 DB 升级、迁移中断、再次初始化、DB 暂忙 | 旧表/时间保留，迁移原子且幂等；暂忙重试或报错并保留上次列表，不假装只剩默认项；成功写入后重开仍为同一顺序。 |
| AC-06 | 已记录目录被移除、权限收回、盘符/挂载暂离线 | 行保留，展示已知不可用状态和完整路径提示；点击重新检查，可重试；失败不提权、不自动创建目录、不改使用时间。重新可用后可原入口打开。 |
| AC-07 | 成功改变 cwd A -> B -> A；重复 OSC；SSH/WSL 不可映射 cwd；打开本地目录面板 | 主机本地确认 cwd 的实际变化计时，重复报告不刷时间；远程路径/无法确认主机映射不污染本地目录；面板列目录不被当成启动终端使用。 |
| AC-08 | 第一次安装、只有未使用配置、旧最近配置、已有新恢复记录 | 无候选时入口禁用且显示“暂无可恢复会话”；旧最近配置可作标明来源的配置候选；新记录优先，绝不把最近 N 条当上次运行集合。 |
| AC-09 | 最近成功使用保存配置 B，先前 A 更新过名称，随后进入 Welcome | 入口明确显示 B 的名称/协议，一次动作只恢复或定位 B；更新配置、进入 Welcome、关闭到空状态不将 A 或空内容写为上次记录。 |
| AC-10 | 保存 LocalShell 有确认 cwd；普通 SSH/SFTP/DB 配置可连 | 打开一个对应 tab，使用当前保存配置；LocalShell 回到确认的本地 cwd；连接由现有协议重新建立。SQL 子工作区仅沿用已有持久化，未保存状态不凭空出现。 |
| AC-11 | 无历史/加载中/恢复中/等待认证/成功/失败/部分成功 | 显示第 4.2.4 节各状态；区分面板已打开、客户端已启动与连接已建立。认证等待不算成功，单 session 不显示多项计数。 |
| AC-12 | 连续点击、恢复中再点、已有相同配置 tab、同配置其他版本已打开 | 一次活动恢复最多建一个目标；重复操作返回同一 operation；可用现有 tab 被定位且内容不被改写；旧配置实例冲突按明确策略处理。 |
| AC-13 | 恢复期间切换页面、关闭目标、完成后再进 Welcome | 完成不抢走用户已转移的焦点；留在操作流程内时聚焦目标主要控件；Welcome 历史页签和过滤状态不被恢复器重置；关闭目标释放操作且晚到响应无效。 |
| AC-14 | 正常退出、确认后异常终止、仅启动后退出、失败恢复后退出 | 最近有效提交保留；启动/退出不写空快照；未提交的最后一次事件可丢失但不得破坏上次提交；失败/取消/部分恢复不覆盖有效记录。 |
| AC-15 | 目录缺失、配置删除、协议改变、认证失败、存储失败、未知 schema | 原因可见且入口保留重试/编辑/清除所需操作；不自动换成另一个 session，不恢复已删除配置；未知 schema 不覆盖，写失败不谎报记录已保存。 |
| AC-16 | SSH 认证/主机确认、保险箱锁定、可选子状态失败、运行中任务曾存在 | 沿用现有认证及资源生命周期；不复制明文密钥、一次性密码、进程/连接/任务 ID；部分成功明确缺失状态，旧命令/查询/传输不自动重放。 |
| AC-17 | 恢复保存 LocalShell 于 A 成功、失败、仅定位已有 tab、明确选择默认 cwd 降级 | 只有新成功使用的真实本地 cwd 推进目录时间；失败和纯定位不推进；降级仅记实际 cwd，A 保持原时间和原恢复记录。 |
| AC-18 | 三端正常构建与原生执行；中英文、800x600/1280x800、系统缩放 | 既有 Welcome 视觉和导航保持，按钮/长路径无重叠，键盘可达，状态可被辅助技术读取；无 Windows 专属假设泄漏到 macOS/Linux。每端原生结果独立记录。 |

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

### 4.2 一键恢复最近的单个已保存 Session（D-01 推荐 A）

#### 4.2.1 “上次”的定义与记录

“上次”是同一 app-data 中，**主窗口最后成功呈现并成为活动项的可恢复保存配置**。包括成功新开、用户再次激活已 ready 的该配置 tab；关闭其他 tab 导致其成为活动项也算一次激活。Welcome、编辑配置、后台输出/自动重连、配置列表排序、关闭所有 tab 不算使用。后台尚未活动的连接完成不抢占记录，待其实际成为活动项才记录。

恢复记录持久化到 `taomni.db` 的专用单行表，不借用 `last_connected_at` 作为新语义真源。既有字段及最近列表行为保留，避免本次顺带改变所有“最近连接”含义。拟新增：

```sql
CREATE TABLE IF NOT EXISTS welcome_session_resume (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  use_sequence INTEGER NOT NULL,
  saved_session_id TEXT NOT NULL,
  saved_session_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  used_at_ms INTEGER NOT NULL,
  local_cwd TEXT
);
```

- 只存配置引用、展示摘要、成功使用次序/时间及可选 native local cwd，不复制 options_json、密码、vault 明文、运行句柄、认证回答或终端内容。不添加对 `sessions` 的级联外键。
- `use_sequence` 在 SQLite 事务中递增，决定“最后一次”以避免同毫秒冲突；usedAtMs 为真实系统时钟。系统时间回拨时使用次序仍可判定上次，不把时间强行改为前值+1。目录保持按最大已记录真实时间排序，时钟回拨不会伪造未来时间，可能暂不置顶，应记录为产品边界。
- 主窗口 `useWelcomeSessionResume` 拟新增 hook 接收各面板生命周期，并顺序提交使用事件；只保留本次主窗口最新的激活 generation，较旧异步结果不回写。首次 ready 与同一 activation 去重；后台 cwd 变化不算激活。
- 保存 LocalShell 在 ready 时保存确认 cwd；其仍是当前上次对象时，后续确认 cwd 可仅更新 context/revision，不变更 usedAtMs/useSequence。旧会话的后台 cwd 不抢占上次对象。
- detach 后主窗口保留上次有效记录；分离窗口不参与竞争写入。回到主窗口 reattach 并激活可记录一次。恢复时若该配置仍在已知 detached 窗口，按冲突策略定位，不凭短 TTL handoff 判断窗口已不存在。
- 正常退出不清空记录。主窗口每次 qualifying event 立即发起写入，正常退出在现有确认后等待当前持久化队列完成/报告错误，不绕过已有退出清理。异常退出只保证最后已提交事务；未完成的最后事件可能丢失，这是明确边界。只打开 Welcome 又退出不会覆盖旧记录。

旧数据候选规则：若无新表有效记录且没有用户 clear 标记，读取现有 `sessions.last_connected_at` 中有效正数的最大值，同时间按 `id` 字节序；过滤第 4.2.2 节不支持类型。返回 `source: "legacy-open"`，显示“最近会话配置”，不宣称曾连接成功；不写新使用时间、不借旧记录推导 cwd。候选只在实际成功恢复/使用后晋升为新记录。已存在新记录但配置损坏或删除时保留错误对象，不偷偷回退到别的 session。

清除入口只删除恢复记录并在 `welcome_metadata` 写 `session_resume_cleared_v1=true`，阻止下一刷新又从旧最近列表复活；下一次新的正常成功使用可重新建立记录并删除 clear 标记。未来未知 schema 返回不兼容状态，不自动 clear、覆盖或降级读取。

#### 4.2.2 恢复对象与实际能力表

| 保存 SessionConfig 类型/状态 | 本次恢复内容与可复用落点 | 成功等级/明确边界 |
|---|---|---|
| native LocalShell | 当前保存的 shell/args、terminal profile，加本设计新增且已确认 native cwd；`openLocalTab` -> TerminalPanel | `ready` 为 PTY 已创建；shell RC 自行改变 cwd 后以新 OSC 为准。不是恢复旧 shell 进程、环境变量、历史输出、未完成命令。 |
| WSL 形式 LocalShell | 现有 session options 中 distro/argv，经原 opener 启动 | 客户端已启动等级；不保存/注入无法映射的 Linux cwd，不宣称 WSL 内 shell 已就绪。缺发行版显示现有失败，不能换 distro。 |
| SSH | 当前主机/认证/网络/主题配置，复用认证队列与 TerminalPanel | SSH 建连成功等级。远程 cwd 本次不新增持久化，不自动重放 cd；既有显式配置的 startup command/端口转发仍会按普通连接执行，入口 tooltip 标明“重新连接”，不重放临时命令。 |
| SFTP | 当前保存连接，FileBrowser/useSftpStore.attach | attach 成功；浏览初始目录失败为可选状态部分失败；不承诺上次 remote/local 浏览位置、传输队列或进度。 |
| RDP / VNC | 当前连接配置，现有 RdpPanel/VncPanel 与 stores | 收到实际 connected 状态；不绕过证书/认证。分辨率等使用当前配置，远端 OS 是否保留旧登录态由远端决定。 |
| SQL 引擎 / Redis / HBaseShell | `DbClientTab` / `RedisClientTab` / `HBaseShellTab` 原连接入口；继续模块自有查询工作区加载 | 真实 connect 成功。SQL 持久化子标签/活动面板按现有模块能力恢复，不能替代整个应用 tab 布局；失败加载不报告完全成功，不重执行 SQL。 |
| S3 / AzureBlob | ObjectStorageBrowser/useObjectStorageStore.attach，原凭据引用 | attach 成功；bucket/list 权限失败可部分成功，不重放上传下载。 |
| File（嵌入的本地目录） | 当前 session.host 指定目录，LocalFileBrowserPanel/attachLocalOnly | 首次本地目录读取成功；不把上次面板导航位置作为新增持久化，不修改目录终端使用时间。 |
| Mail | 当前账户设置与已有本地缓存，MailClientTab 原 cache/load/sync 流程 | 面板及缓存成功加载即可“会话已打开”；同步按原 sync.onOpen 配置进行并单独展示失败，不强制网络同步/发送邮件，不声称登录成功或恢复旧邮件子标签。 |
| Proxy | 原测试面板及保存配置 | 配置面板呈现成功；不自动执行代理测试，也不宣称远端连接成功。 |
| FTP/Telnet/Rlogin/Mosh/Serial 命令客户端 | 原 `openCommandTerminalTab` 及命令 PTY | 客户端启动成功等级，协议登录/设备握手由客户端负责，不能把 spawn 报告为协议恢复成功。 |
| Browser、外部 File/URL、未知/placeholder 类型；无保存 id 的临时 tab | 本入口不可恢复，不进入新记录候选 | 可继续使用现有普通打开入口。不能为了恢复强行接管外部程序/创建保存配置。 |

标签标题默认由当前保存名称及既有自动标题规则生成；不承诺手工重命名、标签顺序、分屏成员、侧栏展开、主面板布局、焦点光标位置的快照。既有全局 UI 偏好照常加载。恢复目标成为活动 tab 是本设计新增导航动作，不代表旧活动项已持久化。

#### 4.2.3 恢复记录、打开请求与结果契约

新增 `src/lib/welcomeSessionResume.ts`，保持输入与结果使用结构化类型；新增 `src/hooks/useWelcomeSessionResume.ts` 管理主窗口收集和运行中的 operation，Welcome 仅渲染状态。

```ts
type ResumeRecord = {
  schemaVersion: 1;
  revision: number;
  source: "confirmed-use" | "legacy-open";
  savedSessionId: string;
  savedSessionType: string;
  displayName: string;
  usedAtMs: number | null;
  useSequence: number | null;
  localCwd: string | null;
};
type ResumeViewState =
  | { state: "loading" | "empty" }
  | { state: "available"; record: ResumeRecord }
  | { state: "restoring" | "awaiting-auth"; operationId: string; record: ResumeRecord }
  | { state: "succeeded" | "partial" | "failed"; record: ResumeRecord;
      operationId: string; tabId: string | null; issues: ResumeIssue[] }
  | { state: "unavailable"; reason: "storage" | "schema"; message: string };
type ResumeIssue = {
  code: "missing-session" | "changed-type" | "missing-directory" |
    "permission-denied" | "unavailable-directory" | "authentication" |
    "connect" | "optional-state" | "storage" | "cancelled" |
    "existing-config-conflict" | "unsupported";
  message: string;
};
type SessionOpenOutcome = {
  operationId: string;
  tabId: string | null;
  status: "ready" | "partial" | "failed" | "cancelled";
  readiness: "connected" | "client-started" | "view-opened" | null;
  issues: ResumeIssue[];
};
```

`ResumeRecord` 为只读快照；一次操作锁定 record.revision 和 savedSessionId。点击时 `getSession(id)` 重新读取当前配置而非使用 Welcome 传入的陈旧 SessionConfig；按 `saved_session_type` 校验。已改变 endpoint/主题/认证配置时以当前已保存配置为准，不恢复旧密码；协议类型改变则报告 changed-type，并提供原会话编辑/普通打开动作，由新的正常成功使用重建记录。

扩展 MainLayout 连接队列条目为 `{session, requestId, origin, resumeContext?}`，origin 为 `normal` / `welcome-resume`。复用 `openQueuedSession`、`continueConnectQueue`、`pendingAuth`、`queueVaultUnlock`、`handleAuthSubmit`，给它们传递 requestId；不能让密码弹窗取消丢失操作归属。`opened` 保留为“已分发”，最终结果必须由目标面板回调/状态适配器完成，不以 addTab、markConnected 或按钮消失推断。

各 opener 返回实际 tabId 或结构化即时失败，使用 UUID 防止同毫秒 ID 碰撞。拟新增 `onOpenOutcome` 可选回调接在对应面板真正完成/失败位置；老普通调用者无需强制处理恢复结果。TerminalPanel 复用 `handleConnected` / `handleConnectFailure`；SFTP/object storage 必须检查 attach 后 pane error，不能仅以 `attached` 掩盖部分失败；Mail 取缓存加载结果而非后台同步触发；数据库同时收集 connect 与已有子工作区 load 状态。取消/销毁/新连接 generation 后旧回调无效。

#### 4.2.4 Welcome 入口、状态与焦点

在品牌标题区之后、既有启动入口之前增加紧凑操作行，不增加大型 ActionCard，不改变三个历史 tab 的顺序/默认选择。主按钮使用 lucide `RotateCcw` + “恢复上次会话 / Restore last session”；旁边显示名称和协议，长文字可截断并带完整 tooltip。右侧复用小图标按钮模式提供清除记录，清除复用 ConfirmDialog。

| 状态 | 可见内容/操作 | 下一步与焦点 |
|---|---|---|
| loading | 恢复按钮禁用，固定宽度 spinner，状态“正在读取” | 不抢初始页面焦点。 |
| empty | 禁用按钮；“暂无可恢复会话” | 保留新会话与本地终端原入口。 |
| available | 可点击恢复，显示明确对象；legacy 候选显示“最近会话配置” | Enter/Space 和点击走同一路径，无新增全局快捷键。 |
| restoring | 按钮禁用并 aria-busy；显示目标名称；可取消当前恢复 | 立即切到目标连接面板供认证/错误反馈，Welcome state 留在 hook。 |
| awaiting-auth | “等待认证”，沿用密码、保险箱、MFA/证书 UI | 焦点由现有认证组件接管；取消返回可重试状态，记录保留。 |
| succeeded | 按 readiness 显示“已连接”“客户端已启动”或“会话已打开” | 若用户仍在本操作目标/Welcome，聚焦终端输入、目录列表或目标面板首个主控件；之后可再次进 Welcome 并定位现有目标。 |
| failed | 行内错误摘要和 lucide 重试按钮；适用时显示编辑/清除操作 | 预检失败留 Welcome 并焦点落重试；已建失败 tab 可保留诊断，重试复用/替换此操作拥有的失败 tab。 |
| partial | “会话已打开，部分状态未恢复”及具体原因；“重试缺失状态”或明确降级动作 | 只重试缺失子状态，不重连成功的主连接；不覆盖有效恢复记录。 |
| unavailable | 读取存储失败可重试；未知 schema 显示版本不兼容 | 不装作 empty，不在此状态自动写空值/迁移。 |

单会话方案没有“恢复 3/5 个会话”状态。partial 用于主连接/面板已可用但既有 SQL 子状态加载失败等场景；认证尚未完成不是 partial。保存 native cwd 不可访问时先失败，允许用户明确点“使用默认目录打开”，成功后标记 partial 并保留原恢复记录；不能默认降级。已知实际默认 cwd 可记录目录使用，不能把缺失的原 cwd 提前。

恢复过程中用户切走，完成/失败只更新 operation 状态和 status bar，不把活动 tab/焦点拉回。取消不会影响其他既有 tab；晚到新建连接必须通过该面板已有 disconnect/close 路径释放。取消必须停止队列后续分发并解除本 operation 的认证等待。连接 IPC 暂不能中断时进入“取消处理中”，保持同 target 去重占用直到回调释放资源；不伪称已取消而允许并发新建。普通网络超时沿用协议配置，无统一超时强杀。纯等待认证不设置擅自提交/跳过的超时。

状态用 `aria-live="polite"`，失败用 alert；保持按钮高度 32px，icon 16px，使用现有 taomni-btn/颜色变量，无新说明性教程文本或快捷键说明。最小桌面 800x600、多语言和系统缩放验证不依赖浏览器截图推断。

#### 4.2.5 重复、冲突、保留与两项功能联动

1. 同一主窗口全局只允许一个 Welcome restore operation。重复点击返回其 promise/operationId；与普通连接队列按 savedSessionId 进行 admission 去重，不能只对一次传入数组去重。普通手动“再开一个”在无恢复占用时保持原能力。
2. 查找当前相同 savedSessionId + 相同主视图类型的 live tab；优先当前活动的匹配项，否则按 appStore.tabs 顺序第一个。ready 时定位，connecting/awaiting-auth 时加入同一结果等待。失败时优先调用该面板现有reconnect；若无reconnect（例如首次native LocalShell启动失败），仅在原失败tab属于本operation时，等待其资源关闭后移除并以新UUID建立替代tab。同配置的普通失败tab不自动删除，定位它并给出按原UI关闭/重试的操作。不得重连其他可用匹配项。
3. 相同 id 的现有 tab 若用的是不同当前配置 fingerprint，返回 existing-config-conflict 并提供“定位已打开会话”；这不算成功恢复当前配置。默认不改写 live options、不关现有连接；用户可按原 UI 关闭/重新打开。不以密码明文构造或持久化 fingerprint，比较保存配置的非敏感身份字段及会话修订标记。
4. 与当前 detached 窗口冲突时复用 MainLayout 已有 detach 跟踪，在持有/已确认该窗口时聚焦该窗口；无法确认 owner 则报告冲突，提供 reattach/普通打开路径，不能因 handoff TTL 过期就新建重复连接。本功能不新增跨多个独立主进程的会话唯一性协议；同 app-data 多进程写入由 DB 事务保证完整，最后提交 wins，这不是上次运行集合语义。
5. 操作锁定旧记录；恢复触发的 addTab/active/ready/cwd 事件暂不进入普通上次记录收集。完全成功才提交同一目标的新使用；partial/failed/cancelled 不提交。正常新会话在此期间被用户成功使用，则它可成为新上次记录；旧恢复完成用 expectedRevision 比较，不能覆盖已经更晚的正常使用。
   此抑制从分发前登记，不能等ready后补标记；partial目标保留内存中的`resumeIncomplete`标志，即使再次激活也不能借普通active收集覆盖原有效记录。完整重试成功后清除此标志，或用户明确通过原普通入口重新打开后按新正常使用采集。该标志不持久化为Tab快照。
6. 重试始终用用户选中的失败目标和当前保存配置重新校验，保留 record 副本；若上次对象已变化，Welcome 主入口显示新对象，旧操作的“重试”仍指旧目标，不自动混用。配置删除/目录离线不设置自动 TTL 淘汰；仅显式清除或新正常成功使用取代记录。
7. native LocalShell 成功新开和实际 cwd 变化由第 4.1 节更新目录时间；上次 session 记录提交另行执行。纯定位 ready tab 可更新上次 session 的 usedAtMs，但不改目录时间；失败记录写入不会导致再次 spawn。恢复降级产生的真实目录使用可以保存，原有效 session resume context 仍保留。

### 4.3 IPC 与存储统一约定

所有新 IPC Rust 端放在 `terminal/local_directories.rs` 或 `session/resume.rs` 并在 `src-tauri/src/lib.rs` 注册；新错误使用 `{code,message}` 序列化，前端 wrapper 兼容既有 String 错误。不修改全局 IPC 错误系统。

| 接口（拟新增/扩展） | 输入 | 输出及读写条件 |
|---|---|---|
| `list_common_local_directories`（扩展 wire 返回） | 无 | `{revision: number, directories: LocalDirectoryShortcut[]}`；前端统一 wrapper/hook 接受旧数组作为兼容输入。目录 revision 在持久化事务内递增，不以系统时间代替。 |
| `record_local_directory_use` / `recordLocalDirectoryUse`（新增） | `{backendSessionId,path}` | `{changed,directory}`；只接受 live native-local cwd 确认；成功事务广播目录 revision。 |
| `get_welcome_session_resume` / `getWelcomeSessionResume`（新增） | 无 | `{record: ResumeRecord|null, issue: ResumeIssue|null}`；未知 schema/存储失败为结构化错误，不能落为 null。删除配置可返回 record + missing-session。 |
| `record_welcome_session_use` / `recordWelcomeSessionUse`（新增） | `{sessionId,localCwd?:string|null,expectedRevision?:number}` | `{record,applied:boolean}`；重新查保存配置；仅经过主窗口成功收集器调用。expectedRevision 不匹配时不覆盖，返回当前记录。系统时间和 sequence 由 Rust 产生。 |
| `update_welcome_session_context`（新增） | `{sessionId,localCwd,expectedRevision}` | 同目标且 revision 匹配才更新 cwd/revision，usedAtMs/sequence 不变；不接受远程/WSL cwd 冒充 native cwd。 |
| `clear_welcome_session_resume` / `clearWelcomeSessionResume`（新增） | `{expectedRevision}` | 原子删除+clear 标记；revision 冲突返回具体错误，防止删除新的记录。 |
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
| `src-tauri/src/session/resume.rs`（新增）、`src-tauri/src/session/mod.rs` | resume DTO、schema、候选读取、record/context/clear、revision CAS；复用 db::get_session，未知协议不得走 SessionType 的默认 SSH 回退 | TASK-03 |
| `src/lib/welcomeSessionResume.ts`（新增） | eligible session 判定、类型映射、operation 与 outcome 类型、非敏感配置身份比较；类型与 Rust 契约对齐 | TASK-03 -> TASK-04 |
| `src/layouts/MainLayout.tsx`、`src/types/index.ts` | 队列 requestId/origin、opener 返回结果、认证取消/继续传播、tab outcome/版本标记、native cwd context 传递；不持久化整个 Tab | TASK-04 |
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

### TASK-03：上次单 Session 存储与引用契约

- 状态：待执行；**实施前依赖 D-01 选择 A**。独立源码阅读和测试数据准备可先进行；选择 B 需先修订 schema。
- 文件职责：session/resume.rs、session/mod.rs、session/db.rs、lib.rs 注册、ipc.ts session 部分、welcomeSessionResume.ts 的数据类型/eligible 判断及同位测试。共享 lib.rs/db.rs/ipc.ts 在目录任务变更之上追加。
- 实施要点：实现单行记录、legacy 候选、clear tombstone、未知版本保护、revision/CAS、删除配置与变更协议错误；原 `last_connected_at` 不改语义。localCwd 只接受 native LocalShell 合法绝对路径，当前配置/协议重新校验。时间和 sequence 由 Rust 决定。
- 关联验收：AC-08 至 AC-10、AC-14 至 AC-17。验证：V-05、V-09。
- 完成条件：legacy 不制造成功时间；REPLACE 保存 session 不删除 resume；clear 后不复活；CAS 与未知 schema 不能破坏有效记录；输出与前端类型完全匹配。

### TASK-04：复用连接队列并提供真实打开结果

- 状态：待执行；依赖 D-01=A、TASK-03 类型；TerminalPanel 修改在 TASK-02 之后集成。
- 文件职责：MainLayout 队列/所有 opener、types/index、各协议面板的可选 onOpenOutcome、welcomeSessionResume 的适配类型、MainLayout 和面板同位测试。
- 实施要点：建立 requestId -> tabId -> lifecycle generation 关联，密码/保险箱/MFA/证书与取消传播不丢失归属；opener 使用 UUID。逐一落实第 4.2.2 节的成功等级，明确部分失败。normal 队列可忽略最终 outcome，但不能回归已有认证串行行为。
- 关联验收：AC-09 至 AC-13、AC-15 至 AC-18。验证：V-06、V-12；需要的真实协议依赖在 V-11 单列。
- 完成条件：覆盖所有宣称 eligible 的类型；无泛化“tab 存在即 ready”；没有为恢复添加自动重跑任务/SQL/传输；取消后新 runtime 释放，既有 live tab 不受影响。面板输出结果必须有可观察用户结果断言。

### TASK-05：恢复协调器与 Welcome 入口

- 状态：待执行；依赖 D-01=A、TASK-03/04；与 TASK-02 目录功能集成。
- 文件职责：useWelcomeSessionResume、WelcomePanel 恢复部分、MainLayout hook 接线/退出 flush、locales、browser stub resume 部分、hook 和组件测试。
- 实施要点：单入口/单 operation、活动 ready 采集、恢复暂缓写回、部分/失败保留、已有 tab/窗口冲突、当前配置读取、revision 条件提交、局部重试与焦点归属。新普通成功使用不能被旧恢复结果覆盖。默认 cwd 降级必须由用户单独操作触发。
- 关联验收：AC-08 至 AC-18。验证：V-07、V-08、V-10、V-11。
- 完成条件：全状态用户流程可观察；再次进入 Welcome 不丢 operation 或改过滤；普通启动与恢复相同目录遵守同一时间规则；恢复记录 write error 不重复打开。

### TASK-06：集成测试与 UI 自动化交接

- 状态：待执行；目录测试可随 TASK-01/02 开始；session 测试实现依赖 D-01=A、TASK-03 至 TASK-05。
- 文件职责：Rust welcome 集成模块；新的 TC-WELCOME-RS cases/fixture；F1.6 controls、自动生成 testid catalog；必要的相关回归用例修改限本功能。
- 实施要点：真实 SQLite reopen/rollback、真实路径测试；browser 使用 VFS File session 验证一键打开/去重，用现有“不支持本地 PTY”验证失败保留。fixture 只在隔离 browser context 写明确测试键，YAML 不用 eval_readonly 变更状态。不能让重新 seed 的页面被当成持久化通过。
- 关联验收：全部 AC 的自动化部分。验证：V-08、V-09、V-12。
- 完成条件：schema/lint/catalog/audit 有结果；新用例有行为结果而非仅控件存在；所有 skip 有真实原因，不能改 baseline 抹平回归。本次文档不领取 backlog、不启动多 agent、不修改看板。

### TASK-07：整体集成、三端检查、当前端真机与证据回填

- 状态：待执行；依赖被交付范围内的前序任务；完整 session 交付依赖 D-01=A。
- 文件职责：最终集成与本文 AC/V/证据表；按 V-10/11 执行原生步骤，产物仅在 gitignored report 目录。
- 实施要点：执行相关自动化及当前 Windows 构建，检查三端 cfg/API；用 debug 独立 app-data 和测试目录完成正常退出/异常终止/重开、权限和联动步骤。macOS/Linux 保留独立未验证计划；发现已知编译不兼容必须处理。
- 关联验收：AC-01 至 AC-18。验证：V-10 至 V-12。
- 完成条件：当前 Windows 原生主流程及本轮必要自动化通过，有脱敏步骤和实际证据；其他平台明确未验证与接续方式，不继承 Windows 结果。D-01 未决时只能报告目录部分交付，不能把完整功能标完成。

## 7. V 验证方案

### 7.1 测试矩阵

全部计划项初始为**待执行**。测试文件中的拟新增对象需随所属任务实现，以下命令不是声称当前已有这些新测试。

| V ID | 层级/文件 | 数据、动作和必须断言 | AC | 状态 |
|---|---|---|---|---|
| V-01 | Rust inline：新增 `terminal/local_directories.rs` tests；保留 pty 的 directory_shortcut_tests | 注入固定时间/OS 默认候选：A=3000、Home=2000、Downloads=1000，另有旧 rank、无时间 default、同时间项；打乱输入仍同顺序。默认+历史合并不失时间；Windows/Linux/macOS分别以真实文件身份确认同/异实体；根/UNC/空格/反斜杠/Unicode不损坏；alias retarget 不转移旧目标时间；24 非默认限额不把默认固定置顶。 | 01/03/04/18 | 待执行 |
| V-02 | Rust inline：目录 SQLite/生命周期 | tempfile DB 装入旧 command_history，有成功性未知 cd、relative、bad timestamp、同秒 id；两次 migration/reopen 数据相同，lastUsed 仍 null；事务中途失败无完成标记。模拟 spawn 失败、注册失败、输出通道失败、DB busy；无假使用写入，成功 spawn 的 write failure 只 warning。clock 回拨不生成未来时间。 | 02/03/05/06/07/17 | 待执行 |
| V-03 | Vitest：`TerminalPanel.test.tsx`、`terminalCwd.test.ts`；新增 `useWelcomeDirectories.test.tsx` | native local 成功/失败，A->B->A 与重复 OSC；同 spawn 首次 OSC 不重复；远程/WSL未知映射不写；Windows /D:/、MSYS /d 与 UNC，Unix含反斜杠按原路径；记录 write warning 不再次 create；事件合并、取消 listener、旧响应晚到不覆盖新列表。 | 02/04/05/07/17 | 待执行 |
| V-04 | Vitest：`WelcomePanel.test.tsx` | 返回排序后的混合默认/历史数组，断言实际 DOM 行路径顺序、时间未知文案；过滤保序；load error 保留旧数组；不可用可重试但时间不动；pending 不重复分发；返回 Welcome 不强制切历史 tab。 | 01/03/05/06/18 | 待执行 |
| V-05 | Rust inline：新增 `session/resume.rs` tests | 旧 sessions 候选取最大有效时间/id；配置更新但 last_connected 空不进入；savedSessionType 原始未知值不默认 SSH；新确认记录优先；clear tombstone、delete session、REPLACE 更新、schema>1、CAS 不匹配、事务失败/reopen 保留有效记录。usedAt/sequence 单位和冲突验证。 | 08/09/14/15/16 | 待执行 |
| V-06 | Vitest：`MainLayout.test.tsx` 与受影响面板测试；新增 `welcomeSessionResume.test.ts` | 表驱动逐协议判定最终 readiness，至少实际调用适配器的 fulfilled/rejected/partial 分支；认证暂停/提交/取消/MFA，操作 ID 不串线；反复按钮/普通队列同目标只建一个；不同配置 live tab 冲突；取消 late resolve 关闭自己新资源、不关闭已有资源。SQL恢复内容/active panel断言，不能仅数回调。 | 09/10/11/12/13/15/16 | 待执行 |
| V-07 | Vitest：新增 `useWelcomeSessionResume.test.tsx`、WelcomePanel 测试 | fake DB/可控 Promise：ready+active 才写；Welcome/空状态/失败/partial 不写；重复事件去重；旧恢复完成不覆盖较新正常使用；缺 cwd 默认降级需显式动作；存储错误不重连。断言按钮状态、错误文案、最终 tab 数量/活动项、focus 和记录内容。 | 08-18 | 待执行 |
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
7. 打开一个没有保存sessionId的临时终端，随后回Welcome。按推荐A，它不覆盖上次保存配置记录；既有最近目录仍可因真实cwd使用变化。此步骤是D-01边界的实物验收。
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
| AC-08 | 4.2.1/4.2.2 | 03/05/06 | V-05/07/08/10 | empty/legacy/confirmed候选，D-01待决+待执行 |
| AC-09 | 4.2.1/4.2.5 | 03/04/05 | V-05/06/07/08/11 | 活动对象/非空保护，D-01待决+待执行 |
| AC-10 | 4.2.2/4.2.3 | 03/04/05/07 | V-06/09/10/11 | cwd/配置/SQL子状态真实结果，D-01待决+待执行 |
| AC-11 | 4.2.3/4.2.4 | 04/05/06 | V-06/07/08/11 | 全状态及readiness文案，D-01待决+待执行 |
| AC-12 | 4.2.5 | 04/05/06 | V-06/07/08/11 | tab/连接数及冲突行为，D-01待决+待执行 |
| AC-13 | 4.2.4/4.2.5 | 04/05/07 | V-06/07/08/10/11 | 焦点/取消late callback资源归属，D-01待决+待执行 |
| AC-14 | 4.2.1/4.2.5/4.3 | 03/05/06/07 | V-05/07/09/10 | 正常/异常退出DB保留，D-01待决+待执行 |
| AC-15 | 4.2.3/4.2.5/4.3 | 03/04/05/07 | V-05/06/07/10/11 | 删除/版本/认证/CAS/存储失败，D-01待决+待执行 |
| AC-16 | 4.2.1/4.2.2/4.2.4 | 03/04/05/07 | V-05/06/07/11 | 脱敏存档及未重放真实结果，D-01待决+待执行 |
| AC-17 | 4.1.1/4.2.5 | 01/02/03/05/07 | V-02/03/07/09/10 | 同目录成功/失败/纯定位时间对比，联动依赖D-01 |
| AC-18 | 4.1.4/4.2.4/第8节 | 01/02/04/05/07 | V-10/11/12，三端 | 当前端build+native；另两端明确未验证 |

TASK列简写`01`为TASK-01。各层级通过的含义独立：Vitest/mock不证明网络成功；Rust服务层不证明真实WebView；browser/VFS不证明本地PTY；当前Windows结果不外推macOS/Linux。

完整实施交付条件：D-01已确定且文档契约一致；相关TASK实施完成；本轮必要自动化/三端代码兼容检查通过；Windows V-10/11核心原生步骤真实通过；证据表已回填。其他两端缺设备可保留未验证及接续步骤。**当前交付只有设计，以上均未完成；E-15的66项基线通过不能替代任何新AC。**

## 10. 未决项、风险与回退

| 项目 | 依据/影响 | 决策、最小验证与解除条件 | 阻塞范围 |
|---|---|---|---|
| D-01 恢复单个保存配置还是上次运行集合 | 现有session是配置，tabs不整体持久化；用户目标存在实质范围歧义 | 已提出具体选择；建议A，连同临时tab不纳入的边界确认。选B先修订session契约与验收，不拿最近列表冒充集合 | TASK-03至05实施、TASK-06/07的session部分；目录TASK-01/02不受阻 |
| 旧命令历史无法证明cd成功 | 输入历史与OSC模拟cd混存 | 保留旧时间为legacy观察，lastUsed=null；V-02/09证明不伪造。无需用户另选数据迁移时刻 | 不阻塞，是已确定兼容取舍 |
| 路径identity/网络探测的三端差异 | 现有无条件小写可能误合并；OS调用可能阻塞 | 同实体确认才合并、有界任务、离线保留；V-01/10三端实测，无法证明的别名允许独立行 | 不阻塞设计；实测发现不兼容时阻塞对应实现完成 |
| 每协议没有统一ready/failed契约 | opener/markConnected过早，Mail/命令客户端也不等同网络连接 | TASK-04明确readiness，不依赖无证据的tab出现；V-06及V-11覆盖 | 已纳入实施任务，不是外部审批阻塞 |
| native测试数据隔离不能照搬现成fixture | reset_db当前会计算默认app-data；debug override不是release保证 | 第8节采用隔离手工流程；后续自动化须专题fixture先验证路径，不操作真实用户数据 | 不阻塞当前设计/手工原生计划 |
| 当前端及其他端真机/服务尚未验证 | 本轮只运行现状Vitest，没有检验Rust工具链/服务/设备就绪 | 实施时执行环境preflight并记录实际缺口，不预先宣称环境不足；macOS/Linux保留接续计划 | 当前没有已证实的环境阻塞；不能将待验证假设写成已失败 |

回退采用代码回退和保留新增表：旧版本忽略welcome新表，不删除它们、不重写原sessions/command_history。若单条新恢复记录不可解析，保留其数据并禁用新入口，原普通打开和目录访问可继续；数据库文件整体损坏交由已有备份恢复能力，本功能不自动替换数据库。升级后再次降级运行产生的历史间隙不伪造补齐。

当前可开始：TASK-01目录Rust实现与V-01/02、TASK-02目录组件/契约测试准备、TASK-06目录集成用例准备。当前确实存在的决策阻塞只有D-01；没有证据表明其他端代码已不兼容或当前端工具链不可用。设计完成不表示实现、验收或真机验证完成。
