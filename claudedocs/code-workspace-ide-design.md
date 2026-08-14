# Code Workspace IntelliJ IDEA Code Editor 对齐方案

> 目标：将 Code Workspace 的代码编辑器能力、交互语义和工程模型做到与 IntelliJ IDEA Code Editor 严格持平。这里的“持平”指同一类代码编辑工作流在三端（Linux、macOS、Windows）具备等价的可发现入口、可预测行为、协议能力和错误处理；不是只完成若干 UI 仿制项，也不把“能打开文件”视为完成。本文档同时作为实现与验收基线。
>
> 日期：2026-08-15 · 版本：v4.17（IntelliJ IDEA 2026.2 真实能力复核；DAP `exceptionOptions`）· 状态：**实施中**。已有 M0–M11 代码保留，所有“已交付”结论仍须通过三端真机工程验收；本轮以 JetBrains IntelliJ IDEA 2026.2 官方文档和当前 DAP 规范重新校准 Build/Compile、Run/Debug、Refactor/PSI、Inspection/Data-flow 基线，并在 v4.16 conditional exception filters 上补齐 capability-gated `exceptionOptions`：adapter-scoped 异常树路径/排除段、四种 break mode、持久化、生命周期、compound scope、binding 状态和 Debug UI 已形成代码闭环，但 adapter-defined 路径语义不等于 IDEA 的完整异常断点模型，项目模型、PSI/index、原生 inspection/data-flow 与三端真实 adapter 证据仍缺，因此**尚未达到 IntelliJ IDEA Code Editor 严格持平**。
>
> 早期版本：v4.16（2026-08-14，DAP conditional exception filters）· v3.2（2026-07-26，M6–M9 代码交付）· v3.1（2026-07-25，M6 代码交付）· v3.0（2026-07-25，新增 §11 M6–M9 计划并修订 §2.3 非目标）。
>
> 早期版本沿革：v2.10（2026-07-12，M0–M5 主线交付与后续收口）。

---

## 1. 现状盘点（As-Is）

| 领域 | 已有能力 | 载体 |
|------|----------|------|
| 工作区模型 | 多根目录（folder/git）+ loose files、布局恢复、最近工作区、tree/compact/flat 文件树 | `CodeWorkspaceTabInfo`、`codeWorkspaceStore`、`useWorkspaceTreeData` |
| 编辑器 | CodeMirror 6：查找替换、多光标/矩形选择、折叠、注释、IDEA 常用编辑键位、大文件降级、二分屏、preview/pin tab | `CodeMirrorHost.tsx`、`EditorGroup.tsx` |
| Markdown | edit/preview/split，Mermaid 渲染 + SVG/PNG 导出 | `MarkdownPreview.tsx` |
| LSP 与分析 | 10 种语言预设 + 自定义命令；文档同步、诊断元数据、补全、签名、文档、导航/引用/层级、格式化、重命名、按 kind 请求 Code Action、inlay/semantic token、动态 capability、跨 root/language 的有界 workspace symbol 聚合、provider-backed inspection profile/related locations/structured evidence | `src-tauri/src/lsp.rs`、`src/lib/editor/lsp.ts`、`useWorkspaceLspSession.ts`、`AnalysisPanel.tsx` |
| 搜索与导航 | Find/Replace in Files、Search Everywhere、Go to File/Class/Symbol、Recent Files、前进/后退、Outline/结构弹窗、Problems | `workspace_search.rs`、workspace panels/hooks |
| 工程执行 | 集成 PTY、结构化 Build/Run/Debug 模型、Build 依赖拓扑、命名运行配置、参数/环境/dotenv/工作目录/Before launch、通用 DAP、line/function/data/exception breakpoint 与 Java 调试/测试基础、SDK/toolchain 探测 | `workspace.rs`、`dap.rs`、Run/Build/Test/Debug panels |
| Git 与恢复 | gutter/diff、inline blame、完整 Git Manager、本地历史、TODO/书签 | `src/lib/git.ts`、workspace chrome/panels |
| 外观与扩展入口 | code view profile、编辑区/树独立缩放、LSP 命令/Java 设置 | `codeViewProfile.ts`、Settings |

**当前明确缺失（严格 IDEA parity）：**

1. IDEA PSI/stub index、原生 inspection/data-flow/nullability 引擎，以及由索引保证语义的重构；当前已有 provider semantic snapshot 的 generation/revision/freshness、跨 provider workspace symbol 覆盖诊断、semantic WorkspaceEdit root guard 和过期写入拒绝，extract/inline/change signature/move 仍只调用 language server 提供的 Code Action，Safe Delete 会在 unresolved/out-of-root 引用时硬阻断但仍不是 IDEA PSI 级声明重构。
2. 完整 project/module/source-set/facet/language-level 模型及 Maven/Gradle 等价导入生命周期。
3. LSP 客户端剩余协议面：更完整的配置模型与跨请求取消边界；diagnostic partial result/即时 refresh 已形成代码闭环，`workspace/didChangeWatchedFiles` 与 watcher 仍需三端原生验收。
4. IDEA 级 dirty 冲突/合并与 crash/restart 恢复中心已形成基础代码闭环（含有界行级三方合并）；跨文件 WorkspaceEdit 已支持有界事务级 undo/redo，语义/token 级合并、目录/symlink/特殊文件历史、网络盘、UNC、大小写-only rename 等文件系统边界仍未完成严格验收。
5. Run/Debug 已共享命名配置、参数、环境、dotenv、工作目录与 Before launch，并支持仓库级 `.taomni/run-configurations.json`（v1 迁移、v2 schema、模板、平台覆盖、provider 引用、诊断、debug-only 选择和嵌套 compound Run/Debug）。Compound Debug 已支持顺序/并行、失败策略、多 DAP 子会话选择和组级 Stop/Restart；标准 DAP function/method breakpoint、data breakpoint/watchpoint、adapter-advertised exception filters 与 capability-gated exception path rules 已形成代码闭环：data breakpoint 通过停驻 Variables/Watch 调用 `dataBreakpointInfo`，按 `canPersist` 分为 adapter-scoped 持久项或 session-scoped 临时项；exception filters 按 adapter 保存默认/显式启停与条件，按 capability 选择 `filters` 或 `filterOptions`；`exceptionOptions` 规则保存异常树 path/negate 和 `always`/`unhandled`/`userUnhandled`/`never`。三类断点均在 `configurationDone` 前恢复、按 compound adapter scope 广播、显示 binding 状态且防止旧响应回写。Inspection profile 已支持 provider rule 启停/severity、文件/行 suppression、稳定 provider-message baseline 的创建/导入/导出/移除，Analysis 面板对 provider 返回的 nullability/taint/data-flow/related-location evidence 做有限分类展示；Tests 面板已接入有界 JUnit XML 结果协议（Surefire/Failsafe/Gradle test-results）、汇总/状态树/失败详情/源码定位/失败重跑；coverage、原生 inspection/data-flow 和完整多语言调试适配矩阵仍缺，编辑器字段声明/地址入口、IDEA 专有断点属性及 DAP 更新扩展字段（如 address/bytes/breakpointModes）也未建模。
6. keymap 编辑器、设置 schema/迁移、无障碍与动作可发现性完整闭环。插件生态/第三方扩展点按用户范围明确为 non-goal，不计入持平门禁。
7. Linux/macOS/Windows 原生工程和发行包验收证据。详细清单以 §2.5–§2.7 为准。

---

## 2. 目标与范围

### 2.1 产品定位

Code Workspace 是 taomni 内的完整代码编辑器和工程工作台：日常改代码、查代码、重构、构建、测试、运行、调试和提交代码都必须在工作区内闭环。终端、SSH/SFTP/AI 是额外优势，不是用来掩盖编辑器能力缺口的替代路径。

### 2.2 范围分级

| 级别 | 内容 |
|------|------|
| **P0（核心补齐）** | 编辑器查找替换；语言智能核心（补全/签名/快速文档/重命名/格式化/Code Action/类与符号查找/实现与类型跳转/文档符号）；Find in Files；Search Everywhere + 导航体系；Problems 面板；Outline；树右键菜单 |
| **P1（体验对齐）** | 编辑区分屏、编辑器 tab 管理、面包屑、集成终端底部面板、调用层级/类型层级、用法高亮、inlay hints、Git gutter/inline blame、Run/Tasks、工作区状态持久化增强 |
| **P2（差异化/加分）** | 本地历史、TODO/书签面板、语义高亮、AI 深度集成（解释/修复/生成 + diff 应用）、远程工作区（SSH 根目录）探索 |

### 2.3 严格持平范围与当前缺口

“严格持平”必须覆盖以下编辑器边界；表中尚未完成的能力是待开发项，不得再登记为非目标：

- 编辑、选择、查找替换、多光标、代码折叠、注释、剪贴板、快捷键、编辑器 tab、分屏、面包屑、导航历史和 Recent Files。
- LSP/IDE 智能：补全、签名帮助、快速文档、诊断、Code Action（含 command-only）、格式化、重命名、引用/实现/类型跳转、符号/类搜索、调用/类型层级、用法高亮、inlay hint、语义 token、selection range，以及完整 WorkspaceEdit 资源操作。
- IDEA 级索引与工程模型：project/module/source set、依赖解析、facet/语言级别、原生 inspection、data-flow/nullability、全项目符号索引、增量失效与重建，以及索引保证的重构语义。
- 运行、测试、调试和构建配置：可命名配置、参数/环境/工作目录、Before launch、模块选择、测试树、断点/变量/调用栈和跨平台生命周期。
- IDE 动作与设置：keymap 编辑、动作上下文/可发现性、设置 schema/迁移和无障碍语义。
- 三端一致性：Linux、macOS、Windows 的路径、快捷键、文件监控、进程生命周期、编码/换行和原生工程冒烟。

以下内容属于产品边界，不属于“Code Editor 严格持平”验收范围：IDEA 插件生态与第三方扩展点、通用数据库客户端、完整 Git 客户端、远程桌面、邮件/聊天、通用 Profiling 产品。它们可以继续作为 taomni 的集成能力，但不得替代上述编辑器能力。

### 2.4 严格持平阶段门禁

每个能力只有在以下门禁全部通过后才能标记为“完成”：

1. **协议门禁**：LSP/DAP/构建工具的请求、通知、反向请求、取消、超时和错误结果均有明确处理；不能以静默 `null` 作为成功。
2. **状态门禁**：磁盘文件、dirty buffer、编辑器 tab、索引、树和 Git 状态在创建/重命名/删除/外部变更后保持一致。
3. **三端门禁**：Linux、macOS、Windows 至少各有一套真实工程冒烟记录；浏览器 stub 只能验证纯前端逻辑，不能证明原生闭环。
4. **回归门禁**：聚焦单测、Rust 集成/协议测试和 `qa-ui-auto --diff` 均通过，并补齐新增可交互控件的覆盖。
5. **可观测门禁**：用户可见的失败原因、取消和部分成功结果可追踪；日志不泄露源码、凭据或完整工作区内容。

### 2.5 当前 Gap 清单（权威基线）

状态定义：`代码闭环` 仅表示当前仓库存在实现和聚焦自动化，不等于严格完成；`严格完成` 必须同时通过 §2.4 五项门禁。2026-08-15 v4.17 复核结论仍是：**没有任何跨平台能力可以只凭当前 Linux/浏览器自动化标记为三端严格完成**。

| 优先级 | 能力域 | 当前可用基线 | 与 IntelliJ IDEA Code Editor 的关键 Gap | 严格状态 |
|--------|--------|--------------|------------------------------------------|----------|
| P0 | 编辑内核 | CodeMirror 6、查找替换、多光标/矩形选择、折叠、注释、soft wrap、列选择模式、UTF-8/UTF-16/常见 legacy charset 读写、BOM/EOL 状态与转换、基础键位 | code style/缩进检测、列选择完整键位、超大文件和二进制文件完整降级语义未形成统一模型；编码识别/转换仍需三端发行包验收 | 代码闭环，未严格完成 |
| P0 | WorkspaceEdit / Code Action | 有序 text/create/rename/delete、edit-before-command、command-only、延迟 `codeAction/resolve`、反向 `workspace/applyEdit`、用户文件操作 `will*/did*Files`、版本与 dirty buffer 防护、`changeAnnotations.needsConfirmation`、多文件/资源操作有序预览确认、事务级 undo/redo、基础冲突 UI | 事务仅覆盖可读普通文件；取消和冲突 UI 的语义合并仍缺 | 代码闭环，未严格完成 |
| P0 | LSP 客户端协议 | initialize/动态 capability、文档同步与智能请求；反向 applyEdit/message/configuration/workDone progress；标准错误/取消；LSP 3.17 workspace pull diagnostics（full/unchanged/related/partial/refresh）；`workspace/didChangeWatchedFiles` 静态/动态注册与 kind/glob 过滤 | 配置仅覆盖当前 session 设置；已开始落盘的资源操作不可安全中断；watcher 的 macOS/Windows 原生行为尚未验收 | 代码闭环，未严格完成 |
| P0 | 文件系统一致性 | 多根、loose file、hash 写入保护；资源 rename 支持跨根与跨文件系统回退；应用内变更通知；Tauri 原生递归 watcher、rename 归一化与前端刷新；dirty 冲突三选一、有界崩溃恢复快照与行级三方合并；普通文件 WorkspaceEdit 事务 undo/redo | 语义/token 级合并、目录/symlink/特殊文件历史、大小写-only rename、锁定文件/权限变化、网络盘/UNC，以及三端打包应用验收 | 代码闭环，未严格完成 |
| P0 | 索引与重构 | 有界 LSP workspace symbol 多 provider 聚合（排序/去重/截断/失败诊断/覆盖计数）；LSP rename；引用感知 Safe Delete；按 `CodeActionKind` 暴露 extract method/function、extract variable/constant、inline、change signature、move；provider semantic snapshot 维护 generation/revision/freshness/coverage，保存/watcher/资源操作/WorkspaceEdit/根变化/LSP 重启统一失效，Rename/Safe Delete/provider refactor 落盘前拒绝过期或 workspace 外结果 | 无 IDEA PSI/stub index 与全项目引用增量索引；snapshot 是 provider 一致性协议而非自有索引，provider 是否提供动作及跨文件正确性仍取决于 language server，尚无 PSI 级语义保证 | 核心差距 |
| P0 | Inspection / data-flow | provider diagnostic tags/related information/code description/data；按 provider source+code 持久化启停和展示 severity；文件/行 suppression；稳定 provider-message baseline 的创建、导入、导出、移除；Analysis 面板展示 capability、semantic token、related locations、structured/text-inferred proof level 与有界 flow steps | 这是 provider-backed 展示与治理层，不是 IDEA inspection engine；baseline 只改变展示/治理，不执行原生规则；无自有规则执行、PSI/stub 索引、跨过程 data-flow、nullability 推断、污点分析和路径证明；结构化 evidence 仅转发 provider metadata，不构造客户端语义图 | 核心差距 |
| P0 | 工程模型与 Build | 多根、SDK 探测、Java module/任务/依赖树；Build/Rebuild 多项目目标去重、依赖拓扑、缺失/循环/工具错误预检、失败即停 | 无统一 project/module/source-set/facet/language-level 模型；Maven/Gradle 增量导入、冲突模型、active profile/source set 和离线状态不等价 | 核心差距 |
| P1 | 导航与编辑器 UX | Search Everywhere、Recent Files、历史、分屏、tab、面包屑、Outline | action 搜索排序/上下文、preview/固定语义边界、导航落点恢复、拖拽停靠、keymap 编辑器、无障碍完整验收尚缺 | 未完成 |
| P1 | Run/Test/Debug | 结构化 provider 配置；命名副本；program/VM arguments、cwd、env、dotenv、Before launch；按源文件保存 Run/Debug 共享选择；仓库共享配置文件/模板/平台覆盖；嵌套 compound Run/Debug；多 DAP 子会话与组级 Stop/Restart；line/function/data breakpoint（discovery、持久化/临时 scope、条件、命中次数、Mute/Remove All、capability/绑定状态）；adapter-scoped exception filter 默认值/启停/条件持久化、legacy `filters`、capability-gated `filterOptions`，以及 `exceptionOptions` path/negate/四种 break mode；通用 DAP、Java 调试和测试发现基础；有界 JUnit XML 结果协议、结果汇总/树、失败详情/定位/重跑 | coverage、完整 hot swap 和 Java/JS/Python/Go/Rust/C++ adapter 矩阵仍缺；data breakpoint 的真实语义、变量/字段声明/地址入口、address/bytes 未统一；异常 path/wildcard/继承匹配由 adapter 定义，尚不能证明 IDEA 的指定异常及子类语义；缺 catch-site/throw-site class filter、caller/instance filter、suspend policy、temporary/dependent breakpoint、pass-count reset、per-rule condition/log 等 IDEA 属性；各类 breakpoint 的 `breakpointModes`、instruction breakpoint、memory/disassembly 也未建模；function name 的 adapter 特定语法、XML 之外的 provider 结果/coverage 协议及三端真实 adapter 行为仍未统一验证 | 代码闭环，未严格完成 |
| P1 | 动作与设置 | LSP 自定义命令、部分语言设置及命令上下文 | 无完整 keymap 编辑、设置 schema/迁移、动作上下文说明和无障碍验收；插件扩展明确不在本次目标 | 核心差距 |
| P1 | 可靠性与可观测 | 请求超时、标准错误、work-done progress/取消、部分结果摘要、部分本地历史；崩溃/重启恢复快照与恢复中心；跨文件事务 undo/redo 失败保留历史 | 协议 trace 脱敏、批量重构恢复、目录/symlink 事务、性能基准门禁和三端发行包验收未闭环 | 未完成 |

### 2.6 Linux / macOS / Windows Gap

| 平台 | 当前证据 | 平台特有 Gap | 严格验收清单 |
|------|----------|--------------|----------------|
| Linux | 当前环境通过 TypeScript/Vitest/Rust 自动化；有 `cfg(unix)` 路径 | 尚无打包后的 Tauri 真机记录；Wayland/X11 快捷键与剪贴板、inotify 上限、跨 mount rename/symlink、PTY shell、JDK/LSP/DAP 进程树需实测 | Ubuntu Wayland + X11；大小写敏感 FS；跨文件系统资源操作；Java/TS/Python/Rust/C++ 工程；安装包升级/恢复 |
| macOS | 无本轮本机执行证据；Tauri WebDriver 本身不支持 macOS | `Cmd`/`Option` keymap 与原生菜单、APFS 大小写模式、quarantine/notarization、zsh/login PATH、应用退出后的子进程清理均未验收 | Intel + Apple Silicon 至少一套；Cmd 系快捷键；大小写-only rename；签名包；JDK/LSP/DAP/PTY 冒烟 |
| Windows | 有条件编译代码和部分 Rust 单测，但本轮未在 Windows 执行 | drive/UNC/长路径/盘符大小写、CRLF、文件占用和杀毒软件竞争、rename overwrite、junction/symlink 权限、PowerShell/cmd、WebView2、Job Object 进程树未闭环 | Windows 11；NTFS + UNC；CRLF/UTF-8 BOM；锁定文件失败恢复；Java/TS/Python/Rust/C++；MSI/NSIS 升级 |

三端共同必须保存同一套验收产物：版本与机器信息、工程 fixture、操作步骤、LSP/DAP trace 摘要、失败截图/日志、结果时间戳。浏览器 stub 和单平台单测不能替代这些证据。

### 2.7 P0-A/P0-B 实施清单（2026-08-11）

- [x] 保留 LSP `documentChanges` 顺序并支持 TextDocumentEdit/CreateFile/RenameFile/DeleteFile。
- [x] Code Action 按 edit 后 command 执行，支持 command-only；edit 部分失败时不执行 command。
- [x] 服务器反向 `workspace/applyEdit` 具备前端桥、30 秒超时、workspace 校验、`failureReason`/`failedChange` 回传；provider command 串行执行，command 回推 edit 在最终 mutation 前重复校验 semantic revision。
- [x] 动态 capability 注册/注销刷新前端 capability 摘要。
- [x] 版本化编辑同时校验 LSP version 与“该文本已完成同步”，避免未发送输入被旧 edit 覆盖；语义查询前等待活跃 editor buffer 的 `didChange` 队列，`didSave` 严格排在同文件已排队 `didChange` 之后，保存期间的新编辑会补发最新 `didChange`。
- [x] Provider semantic snapshot 仅以 workspace `revision` 判定 freshness，`generation` 只仲裁异步查询的可见发布顺序；同 revision 并发结果可继续使用，跨 revision 的查询、resolve、确认后 continuation 和最终 mutation 必须拒绝。这是一致性协议，不是 IntelliJ PSI/stub index。
- [x] WorkspaceEdit 串行执行；资源操作期间双编辑器组只读；后端完成后基于最新 buffer 快照提交 tab/LSP/导航/树/书签状态。
- [x] Create/Rename/Delete 遵循 option 优先级；rename overwrite 失败恢复旧目标；跨文件系统复制保留符号链接；拒绝 CreateFile 覆盖目录和目录移入自身。
- [x] `changeAnnotations.needsConfirmation` 在任何修改前统一确认；拒绝不修改 buffer/磁盘，并按协议回传未应用原因。
- [x] 用户主动创建/重命名/删除接入 `workspace/will*Files` + `workspace/did*Files`；按静态/动态 capability、scheme/glob/kind 和 session root 筛选，`will*` 返回的 edit 复用 `workspace/applyEdit` 前端桥并在落盘前完成。
- [x] server-request/notification 分发：`window/showMessageRequest` 多 action 与超时/取消、`window/showMessage`、work-done progress/取消、workspace configuration/folders、已知 refresh、未知 method `-32601`、无效参数 `-32602`。
- [x] LSP 3.17 `workspace/diagnostic` fallback：按静态/动态 provider 启用、跨 session 并发、resultId full/unchanged、relatedDocuments、partial result token、失败回退 push 缓存、响应原子应用。
- [x] `workspace/diagnostic/refresh`：转发到前端并立即刷新打开文件和 Problems 聚合，不再只依赖轮询。
- [x] 编辑器格式元数据：UTF-8 BOM 无损读写、状态栏显示/切换 BOM，LF/CRLF/CR 状态栏循环转换并进入现有 dirty/hash 保存链路。
- [x] 字符集闭环：自动识别 UTF-8/UTF-16 与常见 legacy charset；状态栏编码入口支持显式 Reload 与 Convert on Save；非 UTF-8 写入拒绝不可表示字符并保留 BOM/hash。
- [x] 应用内文件变更通知：创建/删除/重命名、保存和 WorkspaceEdit 写盘均转发 `workspace/didChangeWatchedFiles`，并抑制短窗口内的重复本地事件。
- [x] `workspace/didChangeWatchedFiles`：动态 watcher 注册/注销、字符串 glob/`RelativePattern`、`kind` 位掩码、Create/Change/Delete 与 rename 拆分、参数校验和去重。
- [x] WorkspaceEdit 预检/预览：统计受影响文件、文本编辑和资源操作，保留 `documentChanges` 顺序，展示资源路径与实际引用的 change annotations；多文件或资源操作在首个 mutation 前确认，拒绝时零修改。
- [x] `codeAction/resolve`：initialize 声明延迟 `edit`/`command` 解析能力；保留原始 CodeAction/data，用户选中后 resolve 并合并结果；请求失败回退原动作且不破坏 edit-before-command。
- [x] Tauri 原生 watcher 代码链路：多根目录与 loose file 递归监控、事件归一化、workspace 生命周期启停、前端外部变更刷新与干净 buffer 自动 reload。
- [ ] macOS/Windows/Linux 打包应用中的原生 watcher 真机验收：锁定文件、权限错误、大小写-only rename、网络盘/UNC、跨文件系统和 watcher 上限。
- [x] dirty buffer 外部变更基础恢复 UI：三选一（保留本地/载入磁盘/手工合并）、删除保护；新增有界本地恢复快照与恢复中心（Recover/Discard/Decide later）。
- [x] 基础行级三方自动合并：非重叠改动自动组合，重叠改动生成可编辑冲突标记。
- [x] 普通文件 WorkspaceEdit 事务级 undo/redo：多文件 text/create/rename/delete 回放、tab/group 恢复、失败保留历史；Safe Delete 通过 prepareRename + definition + references 生成单一可撤销事务。
- [ ] IDEA 级语义/token 合并、目录/symlink/特殊文件 undo、恢复快照的三端打包应用验收。
- [ ] Linux/macOS/Windows 原生工程矩阵与发行包冒烟。

当前协议边界：`workspace/configuration` 对未知 section 返回 `null`，尚无 IDEA 等价的全局设置 schema；WorkspaceEdit 一旦开始磁盘资源操作，不会在操作中途响应取消，以避免主动制造部分落盘状态。事务 undo 只对可读普通文件建立历史，目录、symlink、特殊文件或不可读资源会明确报告不可撤销；原生 watcher、编码转换与恢复中心已有 Linux/浏览器自动化证据，但三端打包应用、网络盘/UNC、大小写-only rename、语义/token 合并仍不能宣称严格完成。

### 2.8 真实能力再对齐（2026-08-15，IntelliJ IDEA 2026.2）

本轮重新读取 JetBrains 当前公开文档和 IntelliJ Platform SDK，而不是沿用早期“像 IDEA”的功能印象。验收目标是用户可观察语义等价，不要求复用 JetBrains 源码；但 PSI/index、增量工程模型和 data-flow 若没有等价自有引擎或经验证的 provider contract，就不能用相似 UI 代替。DAP 以 [Debug Adapter Protocol 当前规范](https://microsoft.github.io/debug-adapter-protocol/specification) 为协议边界。

| 能力域 | IntelliJ IDEA 2026.2 真实基线 | 当前 Code Workspace | 重新确认的严格持平 Gap |
|--------|------------------------------|----------------------|--------------------------|
| Project / Build / Compile | [Compile and build applications](https://www.jetbrains.com/help/idea/compiling-applications.html) 支持单文件/类 recompile、module/project 增量 build、递归依赖、全量 rebuild、background auto-build、run 前 compile、编译结果源码跳转、output path 与 artifact/JAR，并可向 Maven/Gradle 委托 | provider 目标发现、Build/Rebuild、依赖拓扑、wrapper 优先、首错停止、PTY 输出和基础 Java/Maven/Gradle/多语言执行 | 尚无统一 project/module/source-set/facet/language-level 图、IDE 增量 compiler/cache、单文件 compile、background build、编译 output/artifact 模型、Maven/Gradle import/reimport/profile/source-set 生命周期 |
| Run / Debug Configuration | [Run/debug configurations](https://www.jetbrains.com/help/idea/run-debug-configuration.html) 区分 temporary/permanent，支持从 editor/template/copy 创建、类型化参数、配置错误、共享 project file、template default、folder 和 Before launch；Compound 只是配置类型之一 | 本地命名副本、仓库 shared v2 schema、模板/平台覆盖/provider 引用、program/VM args、cwd/env/dotenv、Before launch、active selection、嵌套 compound Run/Debug、顺序/并行和失败策略 | 尚缺 IDEA 等价的临时配置生命周期/数量限制、按框架类型化 editor 与 validation、配置 folder、macro/secret/credential、完整 module/artifact/coverage 绑定和每类 provider 行为矩阵 |
| Debug / Breakpoints | [Breakpoints](https://www.jetbrains.com/help/idea/using-breakpoints.html) 包含 line、method enter/exit/implementation、field read/write、任意 `Throwable`/指定异常及子类；通用属性还有 condition、pass count、evaluate/log、remove once hit、suspend policy、dependency、instance/class/caller filter，异常另有 caught/uncaught 与 catch-site/throw-site class filter | DAP source/function/data/filter/path rule、条件/命中次数/logpoint、变量/监视/求值、stack/thread、基础 step/restart frame、Mute/Remove All、compound session；v4.17 已实现 `exceptionOptions` path/negate 与四种 break mode | `exceptionOptions` 只证明标准请求，不证明 adapter 的 wildcard/继承树与 IDEA 一致；仍缺 catch/throw site、caller/instance filter、method enter/exit、temporary/dependent/suspend policy、exception pass-count/log/condition、smart step/force return、instruction/memory/disassembly、完整 hot swap/coverage 与真实 adapter 矩阵 |
| Refactor | [Refactoring source code](https://www.jetbrains.com/help/idea/refactoring-source-code.html) 提供 Safe Delete、Copy/Move、Extract method/constant/field/parameter/variable、Rename、Inline、Change Signature；支持 usages preview、排除条目、conflict dialog、refactor anyway/open in Find 和统一 undo | LSP Rename、引用感知 Safe Delete、按 `CodeActionKind` 请求 extract/inline/change-signature/move、WorkspaceEdit 有序预览/确认/事务 undo、semantic revision/root guard | provider 是否提供动作及语义正确性仍不可控；无自有 declaration/reference graph、language-aware conflict detector、可排除 usage 的重构 preview、PSI 级 move/change-signature/inline 后置验证 |
| PSI / Index | [PSI](https://plugins.jetbrains.com/docs/intellij/psi.html) 是解析文件并生成语法与语义模型的核心层；[Indexing and PSI Stubs](https://plugins.jetbrains.com/docs/intellij/indexing-and-psi-stubs.html) 以 file/stub indexes、序列化声明 stub、smart/dumb mode 和 shared indexes 支撑大型工程查找 | LSP sessions、provider semantic snapshot freshness/coverage、跨 root/language workspace-symbol 聚合、资源/保存/watcher 统一 revision 失效 | snapshot 是一致性护栏，不是 PSI；无自有 AST/PSI、stub schema、声明/引用 index、增量 invalidation/rebuild、smart/dumb mode、共享 index、性能/损坏恢复门禁 |
| Inspection / Data-flow | [Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html) 在编译前执行规则，具备 language/scope、severity、自定义 severity、profile、suppression、共享 IDE/CI profile 与 quick-fix；[Analyze data flow](https://www.jetbrains.com/help/idea/analyzing-data-flow.html) 支持 Data Flow to/from Here、producer/consumer、possible values、nullness、按值分组、刷新及从 stack trace 追踪 | provider diagnostics 的 enable/severity 展示变换、文件/行 suppression、baseline、related locations、proof/flow metadata 展示、原 provider diagnostic 保留给 Code Action | 无自有 inspection registry/executor、scope/profile rule engine、CFG/SSA/value lattice、nullability/taint/interprocedural summary、path proof、stack-trace DFA；当前 evidence 只是 provider metadata，不是本地分析结果 |
| Tests / Coverage | IDEA 将 test configuration、发现、结果树、失败定位/重跑、debug 和 coverage 纳入同一工程/运行配置模型 | Java test discovery/debug 基础、Maven Surefire/Failsafe 与 Gradle JUnit XML ingestion、状态树、失败详情/定位/重跑 | 尚无统一 provider test protocol、动态/参数化测试完整树、test history、coverage 数据/编辑器标记/合并、非 JUnit 生态和三端真实运行矩阵 |
| 三端一致性 | IntelliJ IDEA 在 Linux/macOS/Windows 提供相同工程工作流并处理各平台路径、keymap、watcher、进程与打包差异 | 当前 Linux 自动化、浏览器 stub、条件编译和协议单测 | 三端真机仍全部保留为 TODO；任何上表“代码闭环”均不得升级为“严格完成” |

**目标与验收更新：**

1. “严格持平”继续覆盖上表全部 Code Editor/工程工作流；插件生态和第三方扩展点仍是唯一明确排除项之一，不能再把 project model、PSI/index、inspection/data-flow、Build/Compile 或真实调试矩阵降级为 non-goal。
2. 标准协议支持和 IDEA 行为持平分开记账：例如 v4.17 `exceptionOptions` 标记“DAP 代码闭环”，只有真实 adapter 的类继承、caught/uncaught、路径和错误行为通过矩阵后，才能升级对应 IDEA 能力。
3. 官方基线至少在每个大里程碑开始前复核一次；文档记录产品版本、URL、日期和代码证据，避免 IDEA 新增/变化能力被旧清单遗漏。
4. Linux/macOS/Windows 真机矩阵按用户要求继续后置，但不移出验收门禁，也不以 browser dry-run、jsdom 或单平台协议测试替代。

---

## 3. 交付物与交互原型

本设计阶段交付两件产物：

| 交付物 | 位置 | 说明 |
|--------|------|------|
| 设计文档（本文档） | `claudedocs/code-workspace-ide-design.md` | 功能/技术/交互/计划 |
| **HTML 交互原型** | **`claudedocs/prototype/code-workspace-prototype.html`** | 单文件、零依赖，浏览器直接打开即可交互演示 |

### 3.1 原型覆盖的交互（评审时逐项体验）

1. **总体布局**：左树 / 编辑区 / 右侧 Outline / 底部 dock / 状态栏，三区均可折叠（工具条右侧按钮）
2. **文件树**：展开/折叠、单击预览打开（斜体 tab）、双击固定、右键菜单
3. **编辑器 tab**：切换、关闭、固定 tab 示意、dirty 圆点
4. **面包屑**：路径 + 光标所在符号
5. **Search Everywhere**：双击 `Shift` 或点顶部搜索框，All/Classes/Files/Symbols/Actions/Text 六个分组，实时过滤，Enter 打开
6. **编辑器内查找**：`Ctrl+F` 弹出查找条，实时高亮 + 计数
7. **语言智能演示**（代码中带下划线虚线的标识符为可交互符号）：
   - 悬停 → 快速文档浮层（Quick Documentation）
   - 单击 → 同符号用法高亮（documentHighlight）
   - 右键 → 符号菜单：跳转声明 / 查找用法 / 调用层级 / 类型层级 / 重命名 / 快速文档
   - 重命名 → 内联输入框（Shift+F6 语义）
   - 波浪线行 → 行首灯泡 / `Alt+Enter` → Quick Fix 菜单
8. **底部 dock**：Problems（徽标计数、点击跳转）、Find in Files（结果树、点击定位）、Terminal（占位）、Run（任务列表）、References、Call Hierarchy（Callers⇄Callees 方向切换、懒展开）
9. **Git 呈现**：gutter 变更色条（绿/蓝/红）、inline blame 开关（工具条按钮）
10. **分屏**：工具条按钮切换双栏
11. **导航历史**：工具条 ←/→ 按钮随打开文件记录前进后退
12. **状态栏**：行列、编码、语言 + LSP 状态点、Git 分支，随激活文件联动
13. 右上角 **?** 按钮内置"操作指南"清单

### 3.2 原型的边界（不要拿原型当验收标准）

- 纯前端假数据演示**交互结构与信息架构**，不代表最终视觉规范（最终视觉沿用 taomni 主题体系）
- 不含真实编辑、真实 LSP、真实文件系统；代码区为只读展示
- 键盘交互仅实现演示所需子集（双 Shift、Ctrl+F、Alt+Enter、Esc、Alt+F12）

---

## 4. 总体 UI 布局设计

采用 IDEA 式"工具窗停靠"布局，但保持 taomni 现有 tab 体系不变（Code Workspace 仍是一个顶级 tab）：

```
┌────────────────────────────────────────────────────────────────────┐
│ 顶部：工作区工具条（根管理 · Search Everywhere 入口 · 导航/布局按钮） │
├──────────┬─────────────────────────────────────────────┬───────────┤
│ 左侧工具窗│  编辑区（可水平/垂直分屏）                    │ 右侧工具窗 │
│          │ ┌─────────────────────────────────────────┐ │           │
│ ▸ 项目树  │ │ 编辑器标签栏（可固定/拖拽/中键关闭）        │ │ ▸ Outline │
│          │ ├─────────────────────────────────────────┤ │ ▸ 文档     │
│ (可折叠)  │ │ 面包屑：src > editor > … > 符号路径        │ │ ▸ AI 助手 │
│          │ ├─────────────────────────────────────────┤ │ (可折叠)  │
│          │ │           CodeMirror 编辑器               │ │           │
│          │ │  gutter: 行号/折叠/Git 变更标记/灯泡        │ │           │
│          │ └─────────────────────────────────────────┘ │           │
├──────────┴─────────────────────────────────────────────┴───────────┤
│ 底部工具窗（tab 切换，可折叠）：                                      │
│ [Problems] [Find in Files] [Terminal] [Run] [References]            │
│ [Call Hierarchy] [Type Hierarchy]                                   │
├────────────────────────────────────────────────────────────────────┤
│ 状态栏：光标位置 · 编码/换行符 · 语言/LSP 状态 · Git 分支 · 缩放      │
└────────────────────────────────────────────────────────────────────┘
```

**布局原则：**

1. **三区可折叠**：左/右/底部工具窗都可一键折叠（IDEA 的 stripe 行为简化版：只保留折叠/展开与尺寸拖拽记忆，不做浮动/窗口化）。
2. **底部工具窗是新增结构**：现有 References 面板并入底部 dock；Terminal、Problems、Find in Files、Run、Call/Type Hierarchy 都以底部 tab 呈现。每个 tab 有徽标计数（如 Problems 的错误数）。
3. **右侧工具窗**：Outline（文档符号树）为主；Documentation（固定的快速文档）与 AI 助手为可选 tab。
4. **状态栏**：Code Workspace 激活时向全局状态栏注入分段信息（光标行列、语言与 LSP 状态点、当前文件所属 Git 分支）。点击各分段有对应动作（如点击语言段打开 LSP 服务器选择）。
5. **现有 Git Manager 保持独立**，底部不设 Git tab（待决问题 §10.1），状态栏分支段作为入口。

---

## 5. 功能模块详细设计

### 5.1 编辑器核心增强（P0）

#### 5.1.1 查找 / 替换（编辑器内）

- 引入 `@codemirror/search`，替换默认面板为自绘 UI（与 taomni 主题一致），支持：大小写/整词/正则、替换单个/全部、匹配计数、`F3`/`Shift+F3` 循环。
- 选中文本后按 `Ctrl+F` 自动填充查询词（IDEA 行为）。

#### 5.1.2 编辑命令补齐（纯前端，CodeMirror commands）

`Ctrl+/` 行注释、`Ctrl+Shift+/` 块注释、`Ctrl+D` 复制行（IDEA 语义）、`Ctrl+Y` 删除行、`Alt+Shift+↑/↓` 移动行、`Ctrl+W`/`Ctrl+Shift+W` 扩大/缩小选区（优先 LSP selectionRange，回退 syntaxTree，见 §5.2.13）、`Ctrl+G` 跳转行:列。冲突处理见 §7。

#### 5.1.3 诊断呈现升级

- 引入 `@codemirror/lint` 的 setDiagnostics 通道：波浪线 + gutter 图标 + 右侧 overview ruler 色条（error 红 / warning 黄）。
- 悬停诊断与 hover 信息合并为单浮层（先诊断后文档）。
- 诊断行 gutter 显示灯泡（有可用 Code Action 时），衔接 §5.2.9。

### 5.2 语言智能与代码洞察（P0/P1，本方案核心）

对标 IDEA 日常使用频率最高的语言功能，全部经由 LSP 标准协议实现，**不自建索引**。

#### 5.2.0 设计原则：capability 驱动的功能开关

- LSP server `initialize` 返回的 `ServerCapabilities` 由后端缓存，并随 `LspDocumentStatus` 附带 `capabilities` 摘要（如 `{ completion: true, callHierarchy: false, … }`）下发前端。
- **UI 按能力开关**：server 不支持的功能，菜单项置灰 + tooltip 说明（沿用现有 installHint 机制），绝不静默失败或伪造结果。
- 每个请求带取消语义（编辑/切换文件即作废旧请求），防止过期结果回填。

#### 5.2.1 功能 → LSP 协议映射总表

| IDEA 功能 | 快捷键 | LSP 方法 | UI 载体 | 优先级 |
|-----------|--------|----------|---------|--------|
| 基础补全 | Ctrl+Space / 输入触发 | `textDocument/completion` + `completionItem/resolve` | 编辑器补全浮层 | P0 |
| 参数信息 Parameter Info | Ctrl+P | `textDocument/signatureHelp` | 编辑器浮层 | P0 |
| 快速文档 Quick Documentation | Ctrl+Q / 悬停 | `textDocument/hover`（已有，升级渲染） | 浮层，可固定到右栏 | P0 |
| 跳转声明 | Ctrl+B / Ctrl+Click | `textDocument/definition`（已有） | 跳转 / 多结果 peek | 已有→增强 |
| 跳转类型声明 | Ctrl+Shift+B | `textDocument/typeDefinition` | 跳转 / peek | P0 |
| 跳转实现 | Ctrl+Alt+B | `textDocument/implementation` | 跳转 / peek | P0 |
| 查找类 Go to Class | Ctrl+N | `workspace/symbol`（客户端按 kind 过滤） | Search Everywhere Classes tab | P0 |
| 查找符号 Go to Symbol | Ctrl+Alt+Shift+N | `workspace/symbol` | Search Everywhere Symbols tab | P0 |
| 文件结构弹窗 | Ctrl+F12 | `textDocument/documentSymbol` | 快捷弹窗（可输入过滤） | P0 |
| 结构工具窗 Outline | — | `textDocument/documentSymbol` | 右侧工具窗 | P0 |
| 查找用法 Find Usages | Alt+F7 | `textDocument/references`（已有） | 底部 References（迁移） | 已有 |
| 用法高亮 | 光标停留自动 | `textDocument/documentHighlight` | 编辑器装饰（读/写区分底色） | P1 |
| **调用层级 Call Hierarchy** | Ctrl+Alt+H | `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls` + `outgoingCalls` | 底部面板，方向可切换 | P1 |
| **类型层级 Type Hierarchy** | Ctrl+H | `textDocument/prepareTypeHierarchy` + `typeHierarchy/supertypes` + `subtypes`（LSP 3.17） | 底部面板 | P1 |
| 重命名 | Shift+F6 | `textDocument/prepareRename` + `rename` | 内联输入 + 跨文件预览 | P0 |
| 格式化 | Ctrl+Alt+L | `textDocument/formatting` / `rangeFormatting` | — | P0 |
| 意图动作 / Quick Fix | Alt+Enter | `textDocument/codeAction` + `workspace/executeCommand` | 灯泡菜单 | P0 |
| Inlay Hints（参数名/类型） | 设置开关 | `textDocument/inlayHint`（按视口 range 请求） | 编辑器内嵌只读 widget | P1 |
| 语义高亮 | 自动 | `textDocument/semanticTokens/full` + `delta` | 编辑器装饰 | P2 |
| 智能选区 | Ctrl+W | `textDocument/selectionRange` → syntaxTree 回退 | — | P1 |
| 折叠范围 | — | `textDocument/foldingRange` → 语法回退 | — | P2 |

#### 5.2.2 补全与签名帮助

- 前端用 `@codemirror/autocomplete` 的异步 completion source 接 LSP；LSP 不可用时回退到现有词级补全。
- 补全项渲染：类型图标（method/field/class/keyword…，按 `CompletionItemKind`）+ 主标签 + 右对齐 detail（类型签名）；选中项懒调 `completionItem/resolve` 拉取文档，右侧展开文档浮层。
- 排序遵循 server 的 `sortText`，过滤用 `filterText`；支持 snippet 插入格式（`${1:param}` 占位符 Tab 跳转）。
- **Auto-import**：应用补全项的 `additionalTextEdits`（典型为文件头插入 import）——这是 IDEA 用户感知最强的补全体验之一，必须支持。
- 触发策略：server 声明的 triggerCharacters + `Ctrl+Space` 手动；防抖 + 旧请求取消；`isIncomplete` 时续请求。
- 签名帮助：输入 `(`、`,` 触发（server triggerCharacters），浮层展示当前重载 + 活动参数加粗；`Ctrl+P` 手动唤起；`↑↓` 切换重载。

#### 5.2.3 快速文档（Quick Documentation）

- 现有 hover 升级：markdown 渲染复用 `renderFormatted`（代码块带语法高亮），支持滚动、最大高度限制。
- `Ctrl+Q` 显式弹出（不依赖鼠标悬停），`Esc` 关闭；浮层右上角 **pin 按钮** → 内容固定到右侧工具窗 Documentation tab，随光标符号联动刷新（可锁定）。
- 文档内链接策略：`http(s)` 外链走系统浏览器；`file:` 链接在工作区内打开。

#### 5.2.4 跳转类导航（声明 / 类型声明 / 实现）

- 单结果：直接跳转（进导航历史 §5.3.3）。
- 多结果：**peek 浮层**（编辑器内嵌列表：文件分组 + 目标行预览），`Enter` 跳转、`Ctrl+Enter` 分屏打开、`Esc` 关闭。
- 鼠标手势：`Ctrl+Click` = 跳转声明（下划线 hover 提示）；`Ctrl+Alt+Click` = 跳转实现。
- 结果不在当前打开根内时（如跳进依赖源码/标准库）：以**只读 loose file** 打开并标注"库文件（只读）"横幅。

#### 5.2.5 查找类 / 查找符号（Go to Class / Symbol）

- 数据源 `workspace/symbol`；**Classes tab** 在客户端按 `SymbolKind ∈ {Class, Interface, Struct, Enum, TypeParameter…}` 过滤（各语言映射：Rust trait→Interface、Go struct→Struct 等由 server 决定，客户端不做语言特判）。
- 每次查询聚合所有已就绪、声明 workspace-symbol capability 的 root/language provider；后端稳定排序、去重并限制返回量，同时返回 ready session/provider、跳过/失败 provider、截断与完整性诊断。新查询会令旧 generation 失效，并向仍在执行的 provider 发送标准 `$/cancelRequest`；旧响应不得发布结果或写入 resolve cache。
- LSP 3.17 允许 `WorkspaceSymbol.location` 只有 URI。此类结果保持 unresolved，列表不伪造 `:1`，用户选择后才对声明 `resolveProvider` 的原 provider 调用 `workspaceSymbol/resolve`；resolve 失败、token 缺失或仍无 range 时不打开文件，成功后使用真实 `selectionRange`，`Ctrl+Enter` 保留分屏语义。
- provider 原始 symbol/data payload 只保存在 Rust 后端，webview 仅接收 opaque resolve token。缓存与 workspace/provider session 生命周期绑定，TTL 300 秒、单项 64 KiB、单批 8 MiB、总计 32 MiB、最多 8 批；workspace 关闭、provider 退出、过期或淘汰后 token 必须拒绝解析。
- 客户端二次排序：camelCase 缩写匹配（`CWT` → **C**ode**W**orkspace**T**ab）> 前缀 > 子串；同分按路径长度升序。
- server 的 query 语义差异（有的做模糊、有的做前缀）通过客户端 re-rank 抹平。
- 无可用 LSP 时 Classes/Symbols tab 隐藏（不展示空壳）。
- Linux/macOS/Windows 真机验收仍为 TODO，重点覆盖 symlink/junction、网络盘、UNC/verbatim path、大小写规则与 provider 进程重启；现有测试只证明词法边界和协议生命周期，不替代三端发行包验证。

#### 5.2.6 调用层级（Call Hierarchy）

- 入口：符号右键菜单 / `Ctrl+Alt+H`；`prepareCallHierarchy` 得到根项后在**底部 Call Hierarchy 面板**展示。
- 方向切换：**Callers（谁调用了它，默认）⇄ Callees（它调用了谁）**，切换时以同一根项重查。
- 树节点：`符号名 · 容器名 — 文件名:行`；懒展开（展开时才请求下一层 incoming/outgoing）；每个节点可"设为新根"。
- 环检测：链路上出现重复符号时节点标 `↻` 且不可再展开；展开深度上限 16 层。
- 双击节点跳转到调用点（incoming 的 `fromRanges` 逐条列出，一次调用多处引用时展开为子行）。

#### 5.2.7 类型层级（Type Hierarchy）

- 入口：类/接口符号右键 / `Ctrl+H`；面板结构同调用层级：**Supertypes ⇄ Subtypes** 方向切换、懒展开、双击跳转。
- 仅在 server 声明 `typeHierarchyProvider` 时展示入口（该能力较新，支持面见 §5.2.12 矩阵）；不做 implementation 结果的"伪子类"降级——宁缺毋假。

#### 5.2.8 用法高亮（documentHighlight）

- 光标停留在标识符上 300ms（idle）后请求 `documentHighlight`，同文件内该符号的读用法/写用法用不同底色标出（IDEA 行为）。
- 无 LSP 时回退为"同词文本高亮"（不区分读写，样式更弱化以示区别）。

#### 5.2.9 重命名 / 格式化 / Code Actions

**重命名（Shift+F6）**：`prepareRename` 校验可行性 → 光标处符号内联输入框；跨文件时弹确认面板（文件 → 行变更清单，可取消）。

**WorkspaceEdit 应用规则**（重命名、Code Action 的 applyEdit、Replace in Files 共用）：

- 已打开且干净的 buffer → 应用到 buffer 并保存；
- 已打开且 dirty 的 buffer → 应用到 buffer，保持 dirty，由用户保存；
- 未打开的文件 → 后端直接改盘（带 hash 预检，文件被外部修改则该文件跳过并报告）；
- 任一文件失败不回滚已成功文件，结果面板明确列出成功/失败清单（LSP 语义下无法保证原子性，如实呈现）。
- 普通文件事务历史：首个 mutation 前捕获文本、存在性、编码/BOM 与打开 tab/group；成功后将整组操作压入一个 undo 单元，`Ctrl/Cmd+Z` 与 `Ctrl/Cmd+Shift+Z` 串行回放。目录、symlink、特殊文件或不可读资源不建立历史，并在状态栏说明原因。

**Safe Delete（Alt+Delete）**：先调用 `prepareRename` 确认符号范围，再查询 declaration 与 references；引用面板先展示影响范围，确认后生成删除声明/引用的单一 WorkspaceEdit。缺少可靠范围、引用/重命名能力、目标是 library source、引用没有本地 filesystem path 或引用/声明落在任一 workspace root 外时，结果标记 incomplete 并硬阻断删除，不静默降级到 loose-file 写入。

**格式化（Ctrl+Alt+L）**：整文件/选区；"保存时格式化"为工作区级开关（默认关）。server 无 formatter（如 pyright）时置灰 + 提示外部格式化器方向（P2 规划"外部 formatter 命令"配置，如 ruff/black/prettier）。

**Code Actions（Alt+Enter）**：携带诊断上下文请求；列表按 kind 分组（quickfix 置顶，source.organizeImports 等其后）；执行走 `workspace/executeCommand`，server 回推的 `workspace/applyEdit` 经 Tauri event + oneshot 应答处理（复用 cc_bridge 的 HITL 管道模式）。

#### 5.2.10 Outline 工具窗与文件结构弹窗

- **右侧 Outline**：documentSymbol 层级树，随激活编辑器切换刷新（防抖）；点击跳转；随光标高亮当前所在符号；名称过滤；"按位置/按类型/按名称"排序切换；可选"只显示公开成员"过滤（按 SymbolKind + 命名约定近似，标注为近似过滤）。
- **Ctrl+F12 结构弹窗**：同数据的轻量弹窗形态（IDEA 惯用），输入即过滤、`Enter` 跳转、`Esc` 关闭——高频导航靠弹窗，常驻浏览靠右栏。

#### 5.2.11 Inlay Hints 与语义高亮

- **Inlay hints（P1）**：参数名 hint、类型 hint 两类；请求按**当前视口 range**（滚动防抖后重取），避免大文件全量；渲染为行内只读 widget（样式弱化、不可选中不入剪贴板）；工作区级总开关 + 按语言开关，默认关（保守起步）。
- **语义高亮（P2）**：`semanticTokens/full` + `delta` 增量；与 Lezer 语法高亮叠加：LSP token 优先、Lezer 兜底。明确列为 P2——渲染与增量同步成本高，先验证 P0/P1 的价值。

#### 5.2.12 主流语言服务器矩阵

图例：● 预期支持 ◐ 部分/需较新版本 ○ 不支持或未知。**本表为方向性预估，运行时一律以 server capabilities 探测为准（§5.2.0），UI 按实际能力开关。**

| 语言 | 推荐 server（现有预设） | 补全 | 签名 | 重命名 | 格式化 | CodeAction | 调用层级 | 类型层级 | InlayHint | 语义高亮 |
|------|------------------------|------|------|--------|--------|------------|----------|----------|-----------|----------|
| TS / JS | typescript-language-server | ● | ● | ● | ● | ● | ● | ○ | ● | ● |
| Rust | rust-analyzer | ● | ● | ● | ● | ● | ● | ◐ | ● | ● |
| Python | pyright / basedpyright | ● | ● | ● | ○¹ | ◐ | ● | ○ | ◐ | ◐ |
| Go | gopls | ● | ● | ● | ● | ● | ● | ◐ | ● | ● |
| Java | jdtls | ● | ● | ● | ● | ● | ● | ◐² | ● | ● |
| C / C++ | clangd | ● | ● | ● | ● | ● | ● | ●³ | ● | ● |
| C# | omnisharp / roslyn LS | ● | ● | ● | ● | ● | ◐ | ○ | ◐ | ● |
| Kotlin | kotlin-language-server | ● | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ○ | ◐ |
| Swift | sourcekit-lsp | ● | ● | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ◐ |
| Scala | metals | ● | ● | ● | ● | ● | ○ | ○ | ● | ● |

> ¹ pyright 系不提供格式化，需外部 formatter（P2 配置项）。² jdtls 早期为私有扩展，较新版本支持标准 typeHierarchy。³ clangd ≥ 15。

矩阵的工程含义：**P0 六件套（补全/签名/文档/重命名/跳转/CodeAction）在全部主流 server 可用**，是普适价值；调用/类型层级、inlay hints 在部分语言降级隐藏——这正是 capability 驱动开关（§5.2.0）的设计原因。

#### 5.2.13 智能选区与折叠（收尾项）

- `Ctrl+W/Ctrl+Shift+W`：优先 `selectionRange`（语义准确，尤其宏/模板场景），server 不支持时回退 Lezer syntaxTree 逐层外扩。
- 折叠：现有 Lezer 折叠保留；`foldingRange`（P2）可补足 region 注释、import 块等语言特定折叠。

### 5.3 导航体系（P0）

#### 5.3.1 Search Everywhere（双击 Shift）

单一弹窗，tab 分组：**All / Classes / Files / Symbols / Actions / Text**。

- **Classes / Symbols**：见 §5.2.5；LSP 不可用时隐藏。
- **Files**：文件名模糊匹配（camelCase 缩写匹配），数据源为后端递归文件清单（与 §5.4 索引复用）。
- **Actions**：工作区命令注册表（§6.2），如"格式化""切换树视图""打开终端"。
- **Text**：直接转入 Find in Files 面板并携带查询词。
- 交互：`↑↓` 选择、`Enter` 打开、`Ctrl+Enter` 在分屏另一侧打开；`Tab` 切换分组；记忆最近一次分组。

#### 5.3.2 独立入口

- `Ctrl+N` Go to Class、`Ctrl+Shift+N` Go to File、`Ctrl+Alt+Shift+N` Go to Symbol（直达对应 tab）
- `Ctrl+E` Recent Files 弹窗（含已关闭文件；连按在最近两个文件间切换）
- `Ctrl+G` Go to Line:Column
- `Ctrl+F12` 文件结构弹窗（§5.2.10）

#### 5.3.3 导航历史（前进/后退）

- 工作区级导航栈：记录 (文件, 光标位置)；产生记录的动作：打开文件、各类跳转（声明/实现/引用/搜索结果/行跳转）、大幅光标移动（跨 50+ 行）。
- `Ctrl+Alt+←/→` 后退/前进；栈上限 100，去重相邻同位置项。

### 5.4 全局搜索 Find in Files（P0）

**后端（新增 Rust 模块 `workspace_search`）：**

- 基于 ripgrep 生态 crates：`ignore`（遵循 .gitignore/.ignore，跳过二进制）+ `grep-searcher`/`grep-regex`。
- 命令：`workspace_search_start(roots, query, opts) -> searchId`，结果经 Tauri event 流式推送（批量分片，每批 ≤200 条），`workspace_search_cancel(searchId)` 取消。
- opts：大小写/整词/正则、include glob、exclude glob、是否搜 ignore 文件、单文件匹配上限、总匹配上限（默认 10k，达到即截断并标记）。
- 同一机制顺带提供 `workspace_replace_in_files`：先搜索预览，用户确认后按文件写回（走 §5.2.9 的 WorkspaceEdit 应用规则）。

**前端（底部 Find in Files tab）：**

```
[查询输入 (Aa|W|.*)] [替换输入]  [过滤: include glob | exclude glob]
[范围: 全部根 ▾ | 指定目录…]                       [123 结果 · 45 文件]
─────────────────────────────────────────────────────────────
▾ src/components/editor/CodeWorkspaceTab.tsx (12)
    841:  const setTreeFontSize = useCallback(...    ← 命中行，关键词高亮
▾ src/lib/editor/workspace.ts (3)
    ...
```

- 结果树按文件分组、懒展开；单击预览（编辑器打开为预览 tab，见 §5.6.2），双击固定打开并定位。
- 替换模式下逐条勾选 + 行内 diff 预览（删除线旧词 → 新词）；"全部替换"前给出文件数/命中数确认。
- 从文件树目录右键"在此目录中查找"可预设范围。

### 5.5 Problems 面板（P0）

- 汇总**所有已打开文件**的 LSP 诊断（当前 LSP 架构按打开文档推送诊断，不做全项目后台索引——面板标题注明"打开的文件"，如实呈现边界）。
- 按文件分组，severity 图标 + 消息 + 来源 + 行列；点击跳转；顶部按 severity 过滤。
- 底部 dock tab 徽标显示错误数（红）/警告数（黄）。
- 每条目支持右键：复制消息 / Quick Fix（转 §5.2.9）。

### 5.6 编辑区与标签管理（P1）

#### 5.6.1 分屏

- 支持一次水平或垂直二分（不做任意网格，控制复杂度）；每个分屏是独立 editor group，有自己的 tab 栏与激活文件。
- 入口：tab 右键"右侧分屏打开 / 下方分屏打开"、`Ctrl+Enter`（在 Search Everywhere/树中）、拖拽 tab 到编辑区边缘触发停靠提示。
- 同一文件可在两个 group 打开：**共享同一 buffer**（同一 Text 状态，双视图编辑同步），避免脏数据分叉。
- 关闭 group 内最后一个 tab 时 group 收起，回到单编辑区。

#### 5.6.2 编辑器 Tab 行为

- **预览 tab**：单击树/搜索结果以斜体预览 tab 打开（复用同一个预览位），双击或编辑内容后转正式 tab。
- 固定（pin）：固定 tab 排最前，"关闭其他"不关固定项。
- 中键关闭、`Ctrl+F4` 关闭当前、右键菜单：关闭/关闭其他/关闭右侧/关闭未修改/全部关闭、复制路径（绝对/相对）、在文件树中定位（`Alt+F1`）、在系统资源管理器打开、在终端打开。
- dirty 标记（●）与关闭确认（保存/放弃/取消）；`Ctrl+S` 保存、全部保存入菜单。
- tab 溢出：横向滚动 + 下拉列表按钮（不做多行 tab）。

#### 5.6.3 面包屑

- 编辑器顶部：`根名 > 目录 > … > 文件 [> 符号路径]`；目录段点击弹出同级列表快速切换；符号段来自 documentSymbol 的光标符号链，点击弹出 Outline 快捷列表。

### 5.7 集成终端（P1）

- 底部 dock 的 Terminal tab，内嵌现有 `TerminalPanel`（本地 PTY），**cwd 默认为当前文件所在根目录**。
- 支持多终端实例（左侧竖条列表或下拉切换），"+" 新建时可选根目录。
- 定位：工作区附属终端，不进顶级 tab 栏、不参与会话管理；生命周期随工作区 tab 关闭而销毁（关闭前确认）。
- 联动：文件树/编辑器 tab 右键"在终端中打开"→ 激活底部终端并 cd；Run/Tasks（§5.9）输出复用此处实例。

### 5.8 Git 编辑器内呈现（P1）

- **Gutter 变更标记**：buffer 内容 vs HEAD 版本（`gitBlobPair` 已有能力）做 diff，gutter 渲染 新增(绿条)/修改(蓝条)/删除(红三角)；防抖 500ms 随编辑更新。
- 点击标记弹出内联 diff 浮层：旧文本 + [回滚此块] [复制旧文本] [在 Git 管理器中查看]。
- **Inline blame**（可开关，默认关）：当前行行尾灰字 `author, 3 months ago · commit summary`；按需 `git blame -L <line> --porcelain`，行级缓存，保存后失效。
- 状态栏 Git 段：当前文件所属 repo 分支 + ahead/behind；点击打开 Git 管理器。

### 5.9 Run / Tasks（P1）

**探测（后端命令 `workspace_detect_tasks(root)`）**，按根目录识别：

| 来源 | 任务 |
|------|------|
| package.json | scripts（含包管理器探测：pnpm/yarn/npm，按 lockfile） |
| Cargo.toml | build / test / run / clippy |
| Makefile / justfile | 目标列表 |
| build.gradle(.kts) / pom.xml | 常用生命周期任务（build/test） |
| go.mod | build / test / vet |
| pyproject.toml | scripts（若定义） |

**Java 工程补充（v3.3）**：

- `workspace_java_run_targets(root)` 有界扫描 `.java` 源码，识别真实 `static void main(String[]/String... args)`；扫描前去除注释、字符串、字符与 text block，避免把 Javadoc 示例误当入口。测试源和构建产物不进入应用主类列表。
- Maven 主类运行使用最近的 `pom.xml` 与父级 `mvnw`，先 `compile` 再通过固定版本 `exec-maven-plugin` 启动；Gradle 使用临时目录中的只读 init script 为对应 Java module 注册 `JavaExec`，无需修改用户的 `build.gradle`；无构建系统时使用 JDK 11+ source-file mode。
- `workspace_task_tree(root)` 递归发现 Maven/Gradle 子模块；任务带 `modulePath`，Gradle 子模块使用 `:module:task`，Maven 子模块在模块 cwd 执行并复用父级 wrapper。
- Build 面板提供 **Build project / Rebuild**：Maven 分别为 `compile` / `clean compile`，Gradle分别为 `classes` / `clean classes`。顶部工具条提供 Build、Run current Java file、Debug；快捷键为 `Ctrl+F9`、`Shift+F10`。
- Windows wrapper 显式使用 `.\mvnw.cmd` / `.\gradlew.bat`（PowerShell 默认不搜索当前目录）；测试运行从任务模型复用实际 wrapper，不再回退到全局 `mvn` / `gradle`。

**运行：**

- 底部 Run tab：任务列表（按根分组）+ 运行历史；点击任务 → 集成终端新实例以 PTY 运行（保留颜色与交互），Run tab 显示状态（运行中 / 退出码）。
- `Ctrl+F5` 重跑上一个任务；自定义任务（命令 + cwd，持久化到工作区状态）。
- 普通 Java Run 复用工作区 PTY 与 SDK 环境（`JAVA_HOME`/`PATH` 由后端 workspace SDK resolution 注入），具有交互 stdin、彩色输出和真实退出码；它与 Debug 解耦，未安装 java-debug bundle 也可执行。
- 当前代码闭环：Run 配置编辑器支持命名副本、program arguments、VM/runtime options、working directory、显式 env、dotenv 文件、Before launch 依赖选择和按源文件持久化；Run 与 Debug 共享同一配置选择。仓库共享配置位于 `.taomni/run-configurations.json`，schema 见 [`claudedocs/run-configurations.schema.json`](run-configurations.schema.json)，支持 v1 `runs` 迁移、v2 `configurations`、templates、Linux/macOS/Windows overrides、provider/project 可移植引用、原子诊断、debug-only 条目和嵌套 compound Run/Debug（顺序/并行/失败策略）。Compound Debug 为每个子配置维护独立 DAP 会话、断点/异常过滤器/栈/变量，并提供子会话选择和组级 Stop/Restart。Tests 面板已消费有界 JUnit XML 结果协议并支持汇总、失败详情、定位和重跑；仍缺 coverage、非 JUnit provider 统一协议和完整 provider/adapter 矩阵；自定义命令继续作为特殊启动需求的兜底。

### 5.10 文件树交互完善（P0 部分 + P1 部分）

- **右键菜单（P0）**：新建文件/目录、重命名(`Shift+F6`)、删除(`Delete`)、复制/剪切/粘贴、复制路径/相对路径、在系统资源管理器打开、在终端打开、在此目录查找、（git 根下）Git 忽略此文件。
- **拖拽（P1）**：树内拖拽移动（跨根禁止提示）、系统拖入复制导入、拖文件到编辑区打开。
- **键盘导航（P0）**：`↑↓` 移动、`←→` 折叠/展开、`Enter` 打开、`F2`/`Shift+F6` 重命名、输入字母跳转匹配项。
- **自动定位（P1）**："在树中定位当前文件"按钮 + 可选"始终跟随激活编辑器"开关。
- 现有工具栏按钮保留，降级为次要入口。

### 5.11 本地历史 Local History（P2）

- 每次保存/外部覆盖/批量替换前，旧内容快照到 app-data 工作区目录（内容寻址去重 + SQLite 元数据：路径、时间、触发原因、hash）。
- 保留策略：单文件 50 版 / 7 天（可配置），LRU 清理。
- UI：tab 右键"查看本地历史"→ 版本时间线 + 与当前内容 diff（复用 `DiffPane`），支持恢复。
- 价值：IDEA 用户迁移的安全网，且 diff 组件可复用，性价比高。

### 5.12 AI 集成（P2，复用既有 ai/agent 能力）

- 编辑器选区浮动工具条（复用 `SelectionToolbar` 模式）：解释 / 修复诊断 / 生成注释 / 按指令改写。
- 改写类动作产出 diff 预览（复用 DiffPane），确认后应用到 buffer。
- 右侧 AI tab：带当前文件/选区/诊断上下文的会话（复用 chat store）；打通 Claude Code bridge 工作区级会话（工作区根作为 cc cwd）。
- 边界：只定义**入口与上下文注入协议**，不重造 AI 面板。

### 5.13 远程工作区（P2 探索项）

- 动机：taomni 本质是远程工作台，"打开 SSH 主机目录为 Code Workspace"是对标 VS Code Remote 的差异化能力。
- 方向：`workspace.rs` 文件操作抽象为 `WorkspaceFs` trait（local / sftp 两实现）；LSP 远程运行（SSH exec + stdio 转发）复杂度高，首期远程根只提供**编辑/搜索/Git**，LSP 标注不可用。
- 本期约束：新代码不写死本地路径假设（路径处理集中化），为 trait 化留缝。**不在本方案内实施。**

---

## 6. 技术架构设计

### 6.1 前置重构（M0，硬前提）

`CodeWorkspaceTab.tsx` 当前约 3.7k 行，继续堆功能不可维护。重构为：

```
src/components/editor/
  CodeWorkspaceTab.tsx          // 壳：布局 + 面板编排（目标 <400 行）
  workspace/
    FileTreePane.tsx            // 树 + 右键菜单 + 拖拽
    EditorGroup.tsx             // 单个编辑组（tab 栏 + CM 实例 + 面包屑）
    EditorTabs.tsx
    Breadcrumbs.tsx
    CodeMirrorHost.tsx          // CM 封装：compartment 管理、扩展装配
    lsp/
      completionSource.ts       // LSP → CM autocomplete 适配
      signatureHelp.ts
      quickDoc.tsx
      hierarchyModel.ts         // 调用/类型层级共用树模型
    panels/
      BottomDock.tsx            // 底部工具窗容器
      ProblemsPanel.tsx
      FindInFilesPanel.tsx
      TerminalDockPanel.tsx
      RunPanel.tsx
      ReferencesPanel.tsx       // 迁移现有实现
      CallHierarchyPanel.tsx
      TypeHierarchyPanel.tsx
      OutlinePane.tsx           // 右侧
    SearchEverywhere.tsx        // 弹窗
    StructurePopup.tsx          // Ctrl+F12
    statusbarSegments.tsx
src/stores/
  codeWorkspaceStore.ts         // 按 workspaceInstanceId 分片的 zustand store
```

- **状态迁移**：现组件内 ~30 个 useState 迁入 `codeWorkspaceStore`（keyed by instanceId），面板组件各取所需，消除 props 钻透；refs 同步样板代码随之消失。
- **重构验收**：现有 `CodeWorkspaceTab.test.tsx` 全绿 + 手工回归清单（打开/编辑/保存/LSP/Git 徽标/缩放）。M0 不改行为。

### 6.2 命令系统

- 新建工作区命令注册表 `workspaceCommands.ts`：`{ id, title, keybinding?, when?, run(ctx) }`；Search Everywhere 的 Actions tab、右键菜单、快捷键分发共用此表。
- 与现有 `menubar/commands.ts`（AppCommand）对接：工作区激活时把工作区命令桥接进应用菜单动态区。
- 快捷键分发：工作区根节点统一 keydown 捕获（现有缩放监听已是此模式），按 `when` 上下文（editorFocus/treeFocus/terminalFocus）路由。

### 6.3 CodeMirror 扩展映射

| 功能 | 扩展/实现 |
|------|-----------|
| 查找替换 | `@codemirror/search`（自绘 panel） |
| LSP 补全 | `@codemirror/autocomplete` 异步 source + 自绘 option 渲染 |
| 签名帮助 / peek / 快速文档 | `showTooltip` / 内嵌 widget（StateField 管理） |
| 诊断 | `@codemirror/lint` setDiagnostics |
| 用法高亮 | Decoration mark（读/写两种样式） |
| Inlay hints | 行内 widget Decoration（视口 range 请求） |
| 选区扩展 | selectionRange → `@codemirror/language` syntaxTree 回退 |
| Git gutter | 自定义 `gutter()` + StateField（diff 结果） |
| Inline blame | 行尾 widget Decoration |
| 面包屑符号 | documentSymbol + 光标 StateField |
| 分屏共享 buffer | 两个 EditorView 共享文档：主 view 持权威状态，副 view dispatch 转发同步（CM6 官方 split 模式） |
| 语义高亮（P2） | Decoration set 增量更新，LSP token 优先、Lezer 兜底 |

### 6.4 Rust 后端新增命令清单

| 模块 | 命令 | 说明 |
|------|------|------|
| lsp.rs 扩展 | `lsp_completion` / `lsp_completion_resolve` | 补全 + 惰性文档 |
| | `lsp_signature_help` | 签名帮助 |
| | `lsp_type_definition` / `lsp_implementation` | 类型声明 / 实现跳转 |
| | `lsp_document_highlight` | 用法高亮 |
| | `lsp_prepare_rename` / `lsp_rename` | 返回 WorkspaceEdit（按文件分组序列化） |
| | `lsp_formatting` / `lsp_range_formatting` | TextEdit[] |
| | `lsp_code_actions` / `lsp_code_action_resolve` / `lsp_execute_command` | 延迟 action 解析；applyEdit 回推 → Tauri event `lsp:apply-edit` + oneshot 应答（复用 cc_bridge HITL 模式） |
| | `lsp_document_symbols` / `lsp_workspace_symbols` | Outline / Go to Class·Symbol |
| | `lsp_call_hierarchy_prepare` / `_incoming` / `_outgoing` | 调用层级 |
| | `lsp_type_hierarchy_prepare` / `_supertypes` / `_subtypes` | 类型层级 |
| | `lsp_inlay_hints` | 视口 range 请求 |
| | `lsp_selection_range` / `lsp_folding_range` | 智能选区 / 折叠（P1/P2） |
| | `LspDocumentStatus.capabilities` 扩展 | server capabilities 摘要下发（§5.2.0） |
| workspace.rs | `workspace_read_file_with_encoding` / `workspace_read_loose_file_with_encoding` | 按用户选择的字符集解码并返回 encoding/BOM 元数据 |
| | `workspace_write_file_encoded` / `workspace_write_loose_file_encoded` | 按字符集无损编码写入，保留 hash 预检与原子替换 |
| 新 workspace_search.rs | `workspace_search_start` / `_cancel` | ignore + grep-searcher，事件流式返回 |
| | `workspace_replace_in_files` | 带 hash 预检的批量替换 |
| workspace.rs 扩展 | `workspace_copy_path` / `workspace_move_path` | 树复制/移动 |
| | `workspace_detect_tasks` | 任务探测 |
| 新 local_history.rs | `history_snapshot` / `history_list` / `history_read` / `history_prune` | 本地历史（P2） |
| git.rs 扩展 | `git_blame_lines` | porcelain blame 按行段 |

依赖新增：`ignore`、`grep-searcher`、`grep-regex`（ripgrep 官方 crates，纯 Rust）。

### 6.5 持久化

扩展现有工作区状态（`RecentWorkspace` / workspace state）：

- 打开的编辑器 tab 列表（含 pin 状态、激活项、分屏结构）
- 树展开状态、树视图模式（已有）
- 底部/右侧工具窗：开关状态、尺寸、激活 tab
- Find in Files 搜索历史（最近 20 条）、自定义任务列表、inlay hints 开关
- 导航历史不持久化（会话级）

存储沿用现有模式：UI 偏好走 localStorage，工作区结构走 SQLite。

---

## 7. 快捷键方案（IDEA keymap 为基准）

| 动作 | 快捷键 | 冲突处理 |
|------|--------|----------|
| Search Everywhere | 双击 Shift | 仅工作区 tab 激活时生效 |
| Go to Class | Ctrl+N | 工作区聚焦时截获（app 层"新建连接"类快捷键让位） |
| Go to File | Ctrl+Shift+N | — |
| Go to Symbol | Ctrl+Alt+Shift+N | — |
| Recent Files | Ctrl+E | — |
| 文件结构弹窗 | Ctrl+F12 | — |
| Find in Files | Ctrl+Shift+F | — |
| Replace in Files | Ctrl+Shift+R | — |
| 编辑器内查找/替换 | Ctrl+F / Ctrl+R | Ctrl+R 仅 editorFocus 时截获 |
| 跳转声明 | Ctrl+B / Ctrl+Click | 统一入口 |
| 跳转类型声明 | Ctrl+Shift+B | — |
| 跳转实现 | Ctrl+Alt+B / Ctrl+Alt+Click | — |
| 查找引用 | Alt+F7 | — |
| 调用层级 | Ctrl+Alt+H | — |
| 类型层级 | Ctrl+H | editorFocus 时截获 |
| 快速文档 | Ctrl+Q / 悬停 | Linux 下若与系统冲突提供 F1 别名 |
| 参数信息 | Ctrl+Shift+Space（实现决策：Ctrl+P 已作为 Go to File 的 VS Code 别名） | 触发字符（`(`、`,`）自动弹出 |
| 重命名 | Shift+F6 | 树聚焦=重命名文件；编辑器聚焦=重命名符号 |
| 格式化 | Ctrl+Alt+L | — |
| Quick Fix | Alt+Enter | — |
| 补全 | Ctrl+Space | Windows 输入法冲突 → 备用 Alt+/ |
| 行注释 | Ctrl+/ | — |
| 复制行 | Ctrl+D | editorFocus 时截获 |
| 移动行 | Alt+Shift+↑/↓ | — |
| 扩大/缩小选区 | Ctrl+W / Ctrl+Shift+W | **与"关闭标签"惯例冲突**：editorFocus 归编辑器；关闭 tab 用 Ctrl+F4 |
| 导航后退/前进 | Ctrl+Alt+←/→ | — |
| 保存 | Ctrl+S | 已有 |
| 终端面板开关 | Alt+F12 | — |
| Problems 面板 | Alt+6（IDEA 习惯） | — |
| 在树中定位文件 | Alt+F1 | — |

设计约束：所有快捷键经 §6.2 的 when-context 路由；后续可加"keymap 方案"设置（IDEA/VS Code 两套预设），首期实现 IDEA 单套 + 少量 VS Code 别名（Ctrl+P → Go to File 的提示引导）。

---

## 8. 实施计划（里程碑）

| 里程碑 | 内容 | 规模 | 状态 |
|--------|------|------|------|
| **M0 前置重构** | 组件拆分 + codeWorkspaceStore + 命令系统骨架 + 底部 dock 容器（References 迁入） | M | 🔶 功能前提已交付；树数据、LSP session、Git snapshot、导航与文件动作已抽 hook，壳体约 4.4k 行，命令注册/header/layout 继续下沉 |
| **M1 编辑器智能·上（P0）** | 查找替换、LSP 补全（含 auto-import）/签名/快速文档/格式化、诊断呈现升级、Problems 面板 | L | ✅ 9/9 |
| **M2 导航与搜索（P0）** | Find in Files（后端搜索模块 + 面板）、Search Everywhere（含 Classes/Symbols）、Go to File/Class/Symbol、Recent Files、导航历史、Outline + 结构弹窗、类型/实现跳转 + peek、重命名、Code Actions、树右键/键盘 | L | ✅ 14/14（拖拽仍为 P1） |
| **M3 布局与终端（P1）** | 分屏、tab 管理/预览 tab、面包屑、集成终端、Run/Tasks | L | ✅ 5/5 |
| **M4 语言智能·下 + Git（P1）** | 调用层级、类型层级、用法高亮、inlay hints、智能选区(LSP)、Git gutter、inline blame、状态栏分段、持久化增强 | L | ✅ 10/10（代码已交付；真机冒烟后置） |
| **M5 差异化（P2）** | 本地历史、AI 集成入口、语义高亮、TODO/书签（可选）、远程工作区 spike | M–L | ✅ 5/5（代码已交付；真机冒烟后置） |
| **M6 Java 基础对齐（P0，§11 A+B）** | jdtls 初始化 `java.*` 设置全集（含 Lombok/autobuild/organizeImports/codeGeneration）；大文件性能（大文件降级守卫、增量 diff 提速） | M | ✅ 代码已交付（`c35d963` A + `4a06f91` B；真机冒烟后置；ChangeSet→LSP 全量重写按风险显式后置，见 §11.B） |
| **M7 工程智能（P1，§11 C+F）** | 全项目诊断（先 spike，后端聚合命令 + Problems 面板切换）；构建集成增强（依赖树、生命周期/任务树、项目重载、模块视图） | L | 🔶 F 构建集成 + C 全项目诊断基础设施代码已交付（`ba037ac` 重载 + `a0d209c` 任务树 + `f9abab5` 依赖树 + 模块视图 + `083999f` 全项目诊断后端 + 前端 Problems 切换）；C 的诊断刷新由 event 改为轮询（Windows 链接约束，见 §11.C），命中语义待用户真机 spike |
| **M8 测试与调试基建（P1，§11 Bundle+E+D1–D2）** | jdtls bundle 基建（java-debug/java-test 加载与探测）；测试集成（探测 + run-only + JUnit 结果树）；**通用 DAP 内核 + 适配器注册表（dap.rs，语言无关）+ Java 适配器（首个插入）** | L | ✅ 代码已交付：Bundle 基建（`4929467`）+ D1 DAP 内核（`b432f0f`）+ D2 Java 适配器（`9edb7b7`）+ E 测试探测/terminal 运行与 JUnit XML ingestion（`daa20fd`）；真机冒烟后置（jdtls 已在 PATH，bundle jar 待配置） |
| **M9 调试主线 + 收口（P1/P2，§11 D3–D5+E）** | 断点/单步/调用栈、变量/监视/求值、条件断点/异常断点/热重载、data breakpoint/watchpoint；debug-test；真机冒烟回填 | XL | ✅ 代码已交付：D3 断点/单步/调用栈/当前行 + D4 变量/监视/console（`b141bad`）+ D5 条件/logpoint/异常断点/热重载 + D5.2 data breakpoint/watchpoint（`596759d`）+ D5.3 conditional exception filters（`1f2d93b`）+ D5.4 exception path rules（`4510aa2`）+ debug-test；结构化测试结果树已改为独立 JUnit XML ingestion（`test_results.rs` + TestsPanel 汇总/失败详情/定位/重跑）；真实 adapter 与三端真机冒烟由用户统一验证 |
| **M10 Java Build/Run 闭环（P0，§11.G）** | 主类发现与普通运行、Maven/Gradle/单文件启动、多模块 task model、Build/Rebuild、wrapper 跨平台与测试运行修复 | M | ✅ 代码已交付：普通 Run 不依赖 java-debug；顶部 `Ctrl+F9` / `Shift+F10`、Run 主类列表、Build/Rebuild、多模块任务与聚焦 Rust/Vitest 覆盖；真实 Maven/Gradle/JDK 工程冒烟待回填 |
| **M11 执行配置与分析收口（P0/P1）** | Build 依赖拓扑执行；Run/Debug 共享命名配置、参数/env/dotenv/Before launch；仓库共享配置/模板/平台覆盖；嵌套 compound Run/Debug 与多 DAP 子会话；provider-backed refactor/inspection/Analysis；semantic snapshot freshness；诊断元数据与 code-action kind 透传；结构化 JUnit 测试结果 | M | 🔶 代码闭环：浏览器/单测和 QA 控件已覆盖；coverage、自有 PSI/index、native data-flow 与三端真机仍待完成 |

依赖关系：M0 是一切前提；M1/M2 内部可并行（后端 LSP 扩展与搜索模块独立）；M3 依赖 M0 的 dock 容器；M4 的层级面板依赖 M0 dock + M2 的 LSP 请求管道。**M6 两条线（A/B）互相独立可并行，且不依赖 M1–M5 之外的新前提；M7 的全项目诊断（C）依赖 M6-A 的 `autobuild`，构建增强（F）独立；M8 的测试/调试依赖 Bundle 基建，DAP 内核（D1）可与 M7 并行起步；M9 的 debug-test 依赖 M8 的 D1–D2；M10 普通 Run 只依赖 M3 PTY + workspace SDK，不依赖 DAP/bundle。** 每个里程碑独立可发布、可验收。M6–M11 的完整拆分见 §11。

### 8.1 进度明细（勾选清单）

> 更新于 2026-08-15（v4.17）；IntelliJ IDEA 2026.2 真实能力、DAP `exceptionOptions`、conditional exception filters、结构化 JUnit 测试结果、Compound Debug、function/method breakpoint、data breakpoint/watchpoint、provider semantic snapshot、Inspection suppression/baseline/evidence 与自动化门禁已复核。M0–M5 已由 PR #361 合入 `main`；当前收口位于 `feat/code-workspace-idea-parity`。功能按代码与自动化门禁复核；Linux/macOS/Windows 真机冒烟和真实 adapter 支持矩阵由用户执行并待回填，不能据此宣称严格持平。完成度按本节拆分条目计数，新增代码闭环项在横切事项记录。

**M0 前置重构 — 🔶 清单项齐，壳体继续瘦身中**

- [x] CodeMirror host 抽取（`CodeMirrorHost.tsx`）— `042d03f`
- [x] 底部 dock 容器 + References 面板迁入 — `09108e2`（`4766f43` 起改为面板常驻挂载）
- [x] `FileTreePane` 展示边界抽取（工具栏、视图/缩放控制、语言服务器面板）+ 组件测试 — `acff8cf`
- [x] `codeWorkspaceStore`（按 `workspaceInstanceId` 分片 UI chrome / openOrder / activeKey / markdownModes）+ `EditorGroup` + `WorkspacePopupsHost` + `codeWorkspaceModel` 纯函数抽取 — `3ddab1b`；**壳体 4674→4113 行**
- [x] `ProjectTree` 控制器抽取（`renderEntries`/`renderFlatEntries`/根与 loose 行/git 徽标）+ 纯函数入 model — `43e5deb`
- [x] buffer / tree chrome / LSP file map 入 store（`openFiles`、`lspFiles`、filter/view/selection/expand keys）+ `MarkdownPreview`/`workspaceChrome` 剥离 — `eb7997b`；**壳体 4113→~3659 行**；目录 listing 缓存（directories/compact/flat）与命令注册表仍在壳内
- [x] `workspaceCommands.ts` 注册表、when 判定与统一快捷键分发；Search Everywhere 增加 Files / Actions 双入口 + 测试 — `b3c3d35`
- [x] 活跃工作区命令注册桥 + Windows/Linux 应用菜单动态子菜单 + macOS 原生菜单动态子菜单 — `26b2763`
- [x] 命令系统收尾：树右键/工具栏复用 command id，terminalFocus 上下文接入 — `2312ef8`
- [x] 目录 listing 生命周期抽为 `useWorkspaceTreeData`（目录/compact/flat 缓存、异步过期保护）— `1d9617e`
- [x] LSP 文档 open/change/save/close session 管道抽为 `useWorkspaceLspSession`（共享文档与异步过期保护）— `f574a5d`
- [x] Git 仓库探测、快照轮询、刷新订阅与路径失效抽为 `useWorkspaceGitSnapshots` — `cbc40ec`
- [x] Search Everywhere/Go to File、Recent Files、前进后退与双 Shift 生命周期抽为 `useWorkspaceNavigation` — `057006a`
- [x] 根/松散文件接入、树刷新、创建/重命名/删除、剪切复制粘贴与 Explorer 操作抽为 `useWorkspaceFileActions` — `d97b2cb`

**M1 编辑器智能·上（P0）— ✅ 9/9**

- [x] 编辑器内查找/替换（`@codemirror/search` 自绘面板）— `d346c37`
- [x] IDEA 编辑命令键位（注释/复制行/删除行/移动行/扩选/跳转行）— `19e23f4`
- [x] Problems 面板基础能力（打开文件范围 + severity 过滤 + 徽标 + 点击跳转/复制消息）— `e0135a3`；Quick Fix 入口随 Code Actions 补齐
- [x] capability 摘要下发（§5.2.0，initialize 握手升级 + `LspDocumentStatus.capabilities`）— `fa8ce88`
- [x] LSP 补全（kind 图标、snippet 转换、auto-import via resolve、触发字符、词级回退）— `fa8ce88`
- [x] 签名帮助（触发字符自动弹出 / Ctrl+Shift+Space，活动参数加粗）— `fa8ce88`
- [x] 快速文档升级（Ctrl+Q / F1 显式弹出 + pin 到右栏 Documentation）— `c4e1435`
- [x] 格式化（`lsp_formatting` / `lsp_range_formatting`，Ctrl+Alt+L）— `e210694`；工作区级保存时格式化开关（默认关）— `4ff2ed7`
- [x] 诊断呈现收尾（gutter 图标、overview ruler 色条、灯泡入口）— `b049952`

**M2 导航与搜索（P0）— ✅ 14/14（拖拽仍为 P1）**

- [x] Find in Files 后端（ignore + grep-searcher 流式搜索、取消、截断）— `65ac601`
- [x] Find in Files 面板（Ctrl+Shift+F、大小写/整词/正则、include/exclude glob）— `4766f43`
- [x] Go to File（双 Shift / Ctrl+Shift+N / Ctrl+P，camelCase 模糊匹配）— `972ad00`；SE 六分组（All/Classes/Files/Symbols/Actions/Text）— `4040d6f`
- [x] 文件树右键菜单基础项（新建/重命名/删除/复制路径/Find in Directory）— `6be92f5`
- [x] Recent Files（Ctrl+E，最近优先、连按推进、上一文件预选）— `f5ae894`
- [x] 导航历史（Ctrl+Alt+←/→ + 头部按钮，100 条上限）— `f5ae894`
- [x] 文件结构弹窗（Ctrl+F12，documentSymbol 层级/扁平双格式）— `5939c76`
- [x] 文件树右键菜单补齐（剪切/复制/粘贴、资源管理器打开）— `1d8fa2f`；根感知「终端中打开」— `49c53fc`；文件/目录 Git ignore — `6b41676`
- [x] Go to Class / Go to Symbol（`lsp_workspace_symbols` + SE Classes/Symbols）— `4040d6f`
- [x] 类型声明/实现跳转 + 多结果 peek — `e373d0d`
- [x] 重命名（prepareRename + rename + §5.2.9 WorkspaceEdit 应用规则）— `e7873ef`；open-clean 保存路径 — `5d87203`
- [x] Code Actions / Alt+Enter（客户端 WorkspaceEdit + command-only；server 回推 `workspace/applyEdit` 桥已接入）— `b049952` + `5d87203` + v4.1 P0-A
- [x] 树键盘导航（↑↓←→/Enter/F2/Delete）；拖拽仍为 P1 — `1d8fa2f`
- [x] 替换（Replace in Files via shared WorkspaceEdit applier）— `e7873ef` + `5d87203`

**M3 布局与终端（P1）— ✅ 5/5**

- [x] 编辑区二分屏（共享 buffer/LSP session、水平/垂直、可调整尺寸、末 tab 自动收起；树/搜索 `Ctrl+Enter` 分栏）— `345379f` + `7b29391` + `f8f3665`
- [x] 编辑器 tab 行为（单击预览/双击固定、pin、关闭其他/右侧/未修改/全部、中键与 `Ctrl+F4` 关闭、溢出下拉、路径/树/资源管理器/终端菜单）— `d445d79` + `f8f3665`
- [x] 面包屑（根/目录/文件路径 + 随光标更新的 documentSymbol 符号链）— `81a494b`
- [x] 集成终端底部面板（复用 `TerminalPanel`、当前根 cwd、多实例/根选择、`Alt+F12`、工作区卸载清理）— `49c53fc`
- [x] Run/Tasks（多生态 `workspace_detect_tasks`、按根分组、自定义任务持久化、运行历史、PTY 复用与真实退出码）— `da62223`
- [x] Java Build/Run 可执行收口（v3.3）：主类发现、Maven/Gradle/单文件运行、多模块构建任务、Build/Rebuild、顶部入口、wrapper 与测试运行修复；普通 Run 与 java-debug bundle 解耦 — §11.G

**M4 语言智能·下 + Git（P1）— ✅ 10/10（代码已交付；真机冒烟后置）**

- [x] 调用层级（Ctrl+Alt+H，Callers⇄Callees，懒展开/环检测）— `c26a230` + `f50939d`
- [x] 类型层级（Ctrl+H，Supertypes⇄Subtypes）— `c26a230` + `f50939d`
- [x] 用法高亮（documentHighlight，读/写区分）— `b7b27d9` + `047ceb9`
- [x] Inlay hints（视口 range 请求，默认关）— `b7b27d9` + `047ceb9`
- [x] 智能选区换 LSP selectionRange（syntaxTree 回退已有）— `b7b27d9` + `047ceb9`
- [x] 右侧 Outline 常驻工具窗（结构弹窗已有，常驻形态归此）— `728b50d`
- [x] Git gutter 变更标记 + 内联 diff 浮层 — `ea96ae2`
- [x] Inline blame（`git_blame_lines`）— `ea96ae2`
- [x] 状态栏分段（光标/语言/LSP 状态/分支）— `8b30d88`
- [x] 工作区状态持久化增强（打开 tab/分屏/dock 状态/搜索历史）— `3abe038`

**M5 差异化（P2）— ✅ 5/5（代码已交付；真机冒烟后置）**

- [x] 本地历史（快照存储 + 时间线 diff + 恢复）— `2b78171`
- [x] AI 集成入口（选区工具条 + diff 应用 + 右栏会话）— `0571bd9`（rewrite/fix preview + 全局 ChatDrawer `attachToComposer`）
- [x] 语义高亮（semanticTokens full + 增量协商、缓存、delta 校验与 full 回退）— `ce4e101` + `420455e`
- [x] TODO / 书签面板（打开文件标记扫描、F11 行书签、工作区持久化与关闭文件重开跳转）— `63a4240`
- [x] 远程工作区 `WorkspaceFs` trait spike（异步 trait、本地实现、路径/符号链接越界防护）— `0d14e06`

**横切事项**

- [x] 交互原型交付（`claudedocs/prototype/code-workspace-prototype.html`）
- [x] 签名帮助键位决策：Ctrl+Shift+Space（Ctrl+P 已作 Go to File 别名）— `f4d9c15`
- [x] 代码与自动化复核（2026-07-12 v2.8）：全量 Vitest **159 文件 / 1267 项**通过（`--testTimeout=15000 --maxWorkers=4`）；`pnpm build` 通过；全量 `cargo test` 通过（lib **748 passed / 11 ignored**，其余 integration/doc tests 全绿）
- [x] **自动化门禁恢复全绿（2026-07-25）**：全量 Vitest **164 文件 / 1304 项**通过；`pnpm build` 通过；全量 `cargo test` 全绿（lib **892 passed / 0 failed / 11 ignored**，其余 integration/doc tests 全绿）。原 v2.10 记录的 3 例 Windows `rdp::cliprdr::uri_list_*` 前导斜杠断言失败已修（测试辅助 `uri_path` 误对 Unix 风格路径剥前导斜杠，生产 `uri_list_to_paths` 保留斜杠属有意行为）；顺带修复 v2.10 后由 `11382ec` 引入的同类 Windows 失败 `chat::acp` grok 图片 `file://` URI 断言（`\\?\` 前缀不对称比较）。两处均只改测试、生产代码零改动 — `d2861f4`
- [x] WorkspaceEdit §5.2.9 三态规则收口（open-clean 应用后保存、open-dirty 保持 dirty、未打开写盘 + hash 预检）— `workspaceEditApply` + `5d87203`
- [x] WorkspaceEdit 事务 undo/redo：普通文件快照、编码/BOM 元数据、跨文件单步回放与 tab/group 恢复；失败时保留原历史。
- [x] 非 UTF-8 编辑闭环：Rust `encoding_rs`/`chardetng` 检测与无损写入、前端状态栏 Reload/Convert 入口、浏览器 UTF-16 stub；二进制与 lossy legacy 保存明确拒绝。
- [x] Safe Delete Symbol：Alt+Delete/右键/命令入口，引用面板预览与确认，声明/引用跨文件删除作为一个事务；无可靠 LSP 范围、library source、unresolved reference 或 workspace 外路径时标记 incomplete 并拒绝猜测/写入。
- [x] Build/Run/Debug 配置与分析代码闭环：Build 目标依赖拓扑、失败即停；命名 Run 配置副本、program/VM args、cwd、env、dotenv、Before launch；Run/Debug 共享 active selection；嵌套 Compound Run/Debug 和 grouped multi-session DAP；标准 function/method、data breakpoint/watchpoint、adapter-advertised exception filters 与 capability-gated exception path rules 跨同 adapter 子会话同步；data breakpoint discovery/`canPersist` scope，exception filter 默认值/条件持久化/`filterOptions` 兼容，`exceptionOptions` path/negate/四种 break mode，以及 configurationDone 前恢复、启停、Mute/Remove All、binding/unsupported 状态；按 CodeActionKind 的 provider-backed extract/inline/change-signature/move 入口；provider semantic snapshot freshness/coverage 与落盘前过期或 workspace 外路径拒绝；持久化 inspection profile、诊断 metadata、Analysis 面板与 Problems 展示变换（provider 原始诊断仍用于 quick fix）。
- [x] **v4.15 D5.2 自动化门禁**：`dapDebugModel`、`useCodeDebugSession`、`DebugPanel` 聚焦回归通过；单 worker 全量 Vitest **260 文件 / 2210 tests**、`pnpm build`、TypeScript 编译通过；F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] **v4.16 D5.3 自动化门禁**：conditional exception filters 的 model/session/panel 聚焦回归 **88 tests** 通过；单 worker 全量 Vitest **260 文件 / 2214 tests**、`pnpm build`（**4549 modules**）与 TypeScript 编译通过；F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。全局 qa-ui-auto gate 仍有 F5.2 等既有 baseline 漂移，本阶段未重置无关基线；真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] **v4.17 D5.4 自动化门禁**：`exceptionOptions` model/session/panel 聚焦回归 **92 tests** 通过；单 worker 全量 Vitest **260 文件 / 2218 tests**、`pnpm build`（**4549 modules**）与 TypeScript 编译通过；qa-ui-auto lint、F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。未修改 Rust，故未重复 Cargo；全局 qa-ui-auto 仍有 137 个仓库既有 orphan selector 且本阶段未重置无关 baseline；真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] 合并门禁 8 例 Windows 失败已修复（clipboard URI ×4、pushd ×1、git 根 ×3）— `f6c1f36`
- [ ] **⚠ 真机验证欠账（由用户执行）**：M0–M5 能力仍以单测/构建为主；`pnpm tauri dev` 冒烟结果回填本节
- [ ] ⚠ M0 继续瘦身：树数据、LSP session、Git snapshot、导航与文件动作 controller 已抽离；命令注册、header/layout 大段继续下沉，目标装配壳 <400 行（当前约 4.4k 行）
- [ ] ⚠ 严格持平后续项：watcher/编码/事务 undo 三端真机验收、语义/token 合并、目录/symlink undo；树/tab 拖拽停靠；`WorkspaceFs` 生产只读链路

### 8.2 下一步待办（建议顺序）

> M0–M5 计划项均已交付并合入主干。后续收口已完成自动化门禁固化，Git snapshot、导航与文件动作 controller 抽离，以及保存时格式化和 Git ignore。**原 3 项 Windows `rdp::cliprdr` 门禁失败（及顺带发现的 `chat::acp` 同类失败）已于 2026-07-25 修复，全量 `cargo test` 恢复全绿 — `d2861f4`；真机冒烟仍由用户执行。**

1. **✅ 固化全量前端门禁参数** — `a9f7484`
   `vitest.config.ts` 已统一设置 `testTimeout: 15_000` 与 `maxWorkers: 4`；无额外参数的 `pnpm test` 全绿。

2. **（用户执行）真机冒烟并记缺陷**
   `pnpm tauri dev` 覆盖 M0–M5 快捷键、分屏、PTY、Git gutter/blame、本地历史、AI 入口、语义高亮和 TODO/书签；结果回填本节。

3. **🔶 继续 M0 瘦身（目标装配壳 <400）**
   Git snapshot、导航与文件动作 controller 已抽离 — `cbc40ec`、`057006a`、`d97b2cb`。下一步组件化命令注册和 header/layout；当前壳体约 4.4k 行。

4. **🔶 P0 协议与编辑器收口**
   server 回推 `workspace/applyEdit`、有序资源操作、change annotation 确认、command-only、用户文件操作 `will*/did*Files`、server-request 分发、pull diagnostics、`workspace/didChangeWatchedFiles`/watcher、基础冲突/恢复中心、行级三方合并、字符集转换、事务 undo/redo、workspace symbol 多 provider 覆盖协议、semantic WorkspaceEdit root guard 与 Safe Delete incomplete 阻断已接入。下一步按 §2.7 完成三端原生验收、语义/token 合并和不可回滚资源边界；树/tab 拖拽与 `WorkspaceFs` 生产链路随后推进。

5. **✅ 合入主干**
   M0–M5 已由 PR #361 合入 `main`；后续收口分支待独立合并，真机冒烟结果可在后续独立补录。

6. **🔶 Java 深度支持（M6–M9，§11 新增）**
   突破原 §2.3 非目标，深化 Java 工程能力。**M6–M11 代码已交付**（jdtls 设置/大文件、全项目诊断基础设施、构建集成、Bundle、DAP、测试发现、Java Build/Run，以及执行配置与 provider-backed 分析闭环）；仓库共享 Run/Debug 配置已补齐 schema、迁移、模板、平台覆盖、compound Run/Debug、多 DAP 子会话和前端来源/诊断展示；JUnit XML 测试结果已形成读取、汇总、定位和重跑闭环。真机冒烟仍后置。coverage、非 JUnit provider 统一结果协议、自有 PSI/index、native data-flow 和完整多语言 adapter matrix 仍是后续差距。完整方案、命令清单与风险见 §11。

7. **🔶 M11 执行配置与分析收口（v4.17 状态）**
   Build/Run/Debug 现在统一通过结构化 execution model 传递 executable/argv/cwd/env/source/error；Build 先解析依赖拓扑并在首个失败处停止；Run 配置支持持久化命名副本、仓库共享配置/模板/平台覆盖、嵌套 compound Run/Debug、参数、VM/runtime options、工作目录、env、dotenv 和 Before launch；Compound Debug 支持多 DAP 子会话、子会话选择、失败策略和组级 Stop/Restart；data breakpoint/watchpoint 通过标准 discovery/set 请求闭环，adapter-advertised exception filters 已补齐默认值、条件化 `filterOptions`、持久化和 binding 生命周期，`exceptionOptions` path/negate/四种 break mode 已由 `4510aa2` 补齐。重构入口按 provider 声明的 `CodeActionKind` 请求 extract/inline/change signature/move；provider semantic snapshot 记录 generation/revision/freshness/query coverage，并在 Rename、Safe Delete 和 provider refactor 落盘前拒绝过期结果、unresolved reference 或 workspace 外路径。inspection profile 只改变显示 severity/启停，Code Action 回调保留 provider 原始诊断；`Analysis` 面板展示 LSP capability、semantic token、snapshot freshness、provider coverage、proof level、structured flow steps 和 related locations，不能冒充 PSI 或原生 data-flow。

8. **🔶 严格持平下一实施序列（按 §2.8 复核重排）**
   第一批先完成可独立验收的 DAP `breakpointModes`、data address/bytes、source field declaration 入口和 instruction/memory/disassembly capability，随后建立 Java/JS/Python/Go/Rust/C++ adapter contract fixture；第二批建立统一 project/module/source-set/language-level 与 compile target/artifact 模型，补单文件 compile、增量/background build 和 Maven/Gradle import 生命周期；第三批落地自有 PSI/stub index 最小垂直切片（Java 优先：声明、引用、增量失效、smart/dumb 状态），在此基础上把 Rename/Safe Delete/Move/Change Signature 从 provider best-effort 升级为可证明语义；第四批实现 inspection registry/profile/scope executor 与 CFG/SSA/nullability/taint/interprocedural data-flow。coverage、typed run configuration、IDEA 专有 breakpoint properties 和统一 test provider 协议随对应主线收口。三端真机矩阵继续由用户后置执行，但始终保留为最终门禁。

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| M0 重构回归 | 4.4k 行组件拆迁易碎 | 行为不变原则 + 聚焦测试 + 回归清单；按 controller/面板分多个提交 |
| LSP 服务器差异 | completion/rename/hierarchy 各 server capability 差异大 | §5.2.0 capability 驱动开关；不支持则置灰 + hint；§5.2.12 矩阵仅作方向参考 |
| WorkspaceEdit 非原子 | 跨文件重命名可能部分成功 | 有序执行在首次失败处停止并呈现结果；单个 overwrite 资源操作使用备份/恢复保护旧目标，但不虚构跨操作事务 |
| 补全性能/竞态 | 高频输入下请求风暴、过期回填 | 防抖 + 请求代际取消；resolve 惰性化；isIncomplete 续查 |
| 快捷键冲突 | IDEA 键位与应用/系统习惯冲突（Ctrl+W/N/P 等） | when-context 路由；冲突项文档化并留别名 |
| 搜索性能 | 超大仓库 Find in Files | 流式分批 + 上限截断 + 可取消；ignore crate 跳过 .gitignore |
| 分屏共享 buffer 复杂度 | 双 view 同步易出编辑竞态 | 限定二分屏；CM6 官方 split 模式；dirty/保存收敛到单 buffer 模型 |
| Inlay hints 抖动 | 编辑时 hint 频繁重排 | 视口 range + 滚动/编辑防抖；默认关，用户主动开启 |
| 底部终端生命周期 | 工作区关闭时 PTY 泄漏 | 随 tab 卸载显式销毁；复用现有 TerminalPanel 清理路径 |
| 范围蔓延 | "像 IDEA"没有边界 | §2.3 非目标清单为评审基线；新增诉求走 P2+ 排队 |

---

## 10. 待决问题（评审时确认）

1. 底部 dock 是否需要 Git tab（vs 只留状态栏入口 + 现有 Git Manager）？
2. 右侧 Outline / Documentation / AI 是否首期合并为单栏多 tab（原型按合并形态演示）？
3. 本地历史保留策略默认值（50 版/7 天）是否合适？
4. 是否首期就提供 VS Code keymap 预设？
5. `WorkspaceFs` trait spike 已完成，下一步是否接入一条生产只读链路？
6. Inlay hints 默认开关（方案默认关，rust-analyzer 用户可能期待默认开）？
7. **（v3.0 新增，✅ 已定）** §11 调试（DAP）：**从 D1 起就抽通用 DAP 框架**（语言无关内核 + 适配器注册表），Java（jdtls + java-debug）作为首个适配器插入，为后续语言（Node/Go/LLDB 等）留缝。架构切分见 §11.D。
8. **（v3.0 新增）** jdtls bundle（java-debug/java-test/lombok）是否随发行内置下载，还是仅提供路径配置 + 手动下载入口？

---

## 11. Java 深度支持完善计划（v3.0 新增，M6–M9）

> 目标：在 M0–M5 已达成的「日常编辑逼近 IDEA」基础上，深化 **Java 工程能力**——补齐 jdtls 初始化设置、消除大文件瓶颈，并**突破原 §2.3 非目标**纳入全项目诊断、构建集成、测试与调试（DAP）。本节按「先快赢、后重投入」排序，映射到里程碑 M6–M9。
>
> 定位更新：Code Workspace 的目标是 Code Editor 严格持平；终端/SSH/SFTP/AI 一体化是差异化。Profiler 和插件生态不在本次范围，但 IDEA 级工程/facet 建模仍是已登记 Gap，不能再作为非目标跳过。

### 11.0 现状盘点（As-Is，Java 视角）

| 领域 | 现状 | 载体 |
|------|------|------|
| jdtls 初始化 | 仅下发 `java.configuration.runtimes` + `extendedClientCapabilities.classFileContentsSupport` | `lsp.rs` `lsp_initialization_options`（约 4549 行） |
| 文档同步 | 已支持增量（`buildIncrementalContentChange` + `omitFullText`），但前端每键 `doc.toString()` 出全串、React 持全串、并用两份全串 diff 算增量 | `CodeMirrorHost.tsx:679`、`useWorkspaceLspSession.ts:455` |
| 诊断 | 仅对**已打开文档**推送；Problems 面板只遍历 `openOrder` | `lsp.rs`（per-URI 存储）、`CodeWorkspaceTab.tsx:4669` |
| 库源码 | jdt:// 反编译 + 按需 Download Sources（已实现） | `lsp.rs` `lsp_download_sources`（约 3502 行） |
| Run/Tasks（v3.2 基线问题） | 只探测 npm/Cargo/Make/Gradle/pom/go 的固定任务，经 PTY 运行；Java 仅有 Maven `package/test` 或 Gradle `build/test`，无主类发现、无当前文件运行，Windows wrapper 与测试 runner 还可能绕开项目 wrapper，因此界面有 Run/Build 但 Java 应用实际无法可靠启动 | `workspace.rs` `workspace_detect_tasks`、`RunPanel.tsx`、`javaTestRun.ts` |
| 调试 / 测试 | 无（原 §2.3 非目标） | — |

### 11.A jdtls 初始化设置补齐（M6，快赢，规模 S–M，风险低）

**问题**：`settings.java` 仅含 `runtimes`；VS Code Java 扩展常设的几十项 `java.*` 全缺，导致 Lombok 幻象错误、组织导入/代码生成不可用。

**后端（扩展 `lsp_initialization_options` 的 `settings.java`）**：

- `autobuild.enabled: true`（**全项目诊断 §11.C 的前提**）
- `completion`：`importOrder`、`favoriteStaticMembers`（如 `org.junit.Assert.*`、`org.mockito.Mockito.*`）、`guessMethodArguments`
- `format`：`enabled`、`settings.url`/`settings.profile`（Eclipse/Google 格式配置文件）、`onType.enabled`
- `import`：`maven.enabled`、`gradle.enabled`、`gradle.wrapper.enabled`、`gradle.offline.enabled`、`exclusions`
- `sources.organizeImports.starThreshold/staticStarThreshold`、`saveActions.organizeImports`（工作区开关，默认关）
- `codeGeneration`：`hashCodeEquals.useJava7Objects`、`toString.template`、`useBlocks`、`generateComments`（供 code action 生成 getter/setter/构造器/equals）
- `referencesCodeLens.enabled`、`implementationsCodeLens.enabled`、`signatureHelp.enabled`
- `errors.incompleteClasspath.severity`、`maxConcurrentBuilds`、`inlayHints.parameterNames.enabled`
- **Lombok**：经 §11.Bundle 注入 `-javaagent:lombok.jar`（短期可先在 vmargs 加 `-javaagent` 指向用户 Lombok jar）

**前端 / 设置页**：Settings → Language Servers → Java 增子项（Lombok 开关、保存时组织导入、格式化 profile 路径、导入顺序、autobuild 开关）；复用现有 `workspace/didChangeConfiguration` 通道（`lsp.rs:3536` Download Sources 已用）做**热更新**，无需重启会话。

**交付物**：`java.*` 设置全集 + 设置 UI + 单测（扩展 `jdtls_initialization_*`）。**✅ 已交付 `c35d963`**：`JavaLanguageSettings` 进程级 blob（serde 默认；autobuild/completion/format/import/organizeImports+saveActions/codeGeneration/codeLens/signatureHelp/inlayHints/incompleteClasspath），`lsp_initialization_options` 输出完整 `settings.java` 树；`lsp_set_java_settings` 命令走 `workspace/didChangeConfiguration` 热更新（空 runtimes 省略以免覆盖 initialize 的 JDK 配置）；Lombok 短期经 `-javaagent` 注入 `jdtls_vmargs()`（直连 + JAVA_OPTS 两路径）；前端 `LSP_JAVA_SETTINGS_KEY` 持久化 + Language Servers 设置子区（autobuild/保存组织导入/Lombok+jar/格式化 profile/导入顺序）+ en/zh i18n；Rust 4 新测（全树、默认往返、Lombok 门禁、热更新省 runtimes，共享全局锁串行）+ 前端设置/持久化测试。

### 11.B 大文件性能（M6，快赢，规模 M，风险中）

**瓶颈**（`CodeMirrorHost.tsx:679`、`useWorkspaceLspSession.ts:455`）：每键 `update.state.doc.toString()` 出全串 → React 持全串 → `buildIncrementalContentChange` 对**两份全串**做 diff。三处全串操作在大文件下叠加成卡顿；LSP 线协议本身已是增量，不是问题所在。

**方案**：

1. **ChangeSet 直出 LSP 增量**：改造 `onChange` 传出 `update.changes`（CM6 ChangeSet），前端直接映射为 `LspDocumentContentChange[]`，**去掉「两份全串 diff」**。全串仅在 open/保存/回退时惰性物化。
2. **增量同步默认开**：确认 server 声明 `textDocumentSync=2`（jdtls 满足）时 `incrementalSyncRef` 默认置真。
3. **大文件降级守卫**：阈值（如 >1.5 MB 或 >20k 行）自动降级 compartment——关语义高亮/inlay/documentHighlight，保留 Lezer 基础高亮 + 按需补全/悬停/跳转；状态栏提示「大文件模式」。
4. **保存回传去全量**：补齐 controlled-doc effect 的二次全串转换消除（`lastDocumentTextRef` 已部分缓解）。

**交付物**：ChangeSet→LSP 增量适配、大文件降级 compartment、阈值配置、大文件基准测试。**兜底**：增量与 server 版本不一致时回退全量（已有 catch 路径）+ 版本代际校验（已有 epoch guard）。

**✅ 已交付 `4a06f91`（部分，含一处显式后置）**：
- **大文件降级守卫（本项主干、性能主因）**：`largeFile.ts` 阈值（>1.5 MB 或 >20k 行，字节判定 O(1) + 有界行扫描）；`CodeWorkspaceTab` 的 `activeFileIsLarge` memo 关停 semanticTokens / inlayHints / documentHighlight 三个 per-edit effect（含 documentHighlight 的文本兜底扫描）及其装饰重建，保留 Lezer 高亮与按需补全/悬停/跳转；状态栏「大文件模式」分段（`codeWorkspaceStatusStore.largeFile` + `StatusBar` + en/zh i18n）。
- **增量 diff 提速（安全等价优化）**：`buildIncrementalContentChange` 的变更结束位置改为从 `start` 沿变更跨度续扫，不再对 `previousText` 从 0 再扫一遍——输出完全等价，大文件尾部编辑的端点定位成本约减半。
- **增量默认开 + 全量兜底**：`textDocumentSyncKind===2 → omitFullText` 与失败回退已由既有 `useWorkspaceLspSession` 测试覆盖，本次未改其语义。
- **⏸ 显式后置：ChangeSet→LSP 数组全量重写（彻底去掉「两份全串 diff」）**。原方案的兜底仅捕获 server 报错，无法捕获「静默接受但错误」的增量；要真正安全需一次 O(n) 校验（apply→比对），成本与现有 O(n) 全串 diff 相当，抵消收益。其非安全形态存在静默 LSP 失步风险：外部/程序化编辑（格式化、Git 回滚、WorkspaceEdit）经 `applyingExternalDocRef` 绕过 `onChange`、分屏共享单 buffer、多光标需降序处理——这些只能靠真机 jdtls 冒烟验证（正是本方案尚欠的真机项）。故保留全串 diff 为权威来源（现已更省），把数组重写留作独立决策项。测试：largeFile 阈值、diff 单遍端点等价（深处编辑 + 跨行删除）、StatusBar 大文件分段；`pnpm build` + 相关 vitest 全绿。

### 11.C 全项目诊断（M7，攻坚，规模 L，风险中高，需 spike 前置）

**问题**：诊断仅来自打开的 tab（`CodeWorkspaceTab.tsx:4669`）；IDEA 后台全量编译并对未打开文件报错，本项目做不到。这是最大 Java 对齐差距。

**Spike（前置，硬门槛）**：验证 jdtls `workspace/executeCommand: java.buildWorkspace`（或 `java.project.build` 全量）是否对**未打开的含错文件**主动 `publishDiagnostics`。
- **命中**：走下方后端聚合方案。
- **未命中**：退用 LSP 3.17 pull 诊断 `workspace/diagnostic`（需 server 声明 `diagnosticProvider.workspaceDiagnostics`）；v4.2 已实现此 fallback，仍需真机确认具体 server 返回质量。

**后端**：
- `LspSession.diagnostics` 已按 URI 全量存储（不限打开文档，`lsp.rs:529`）。新增 `lsp_workspace_diagnostics(workspace_id)` 返回**全部已收到诊断**（含未打开文件）。
- 收到 `publishDiagnostics` 继续写入 session 缓存；pull provider 通过 Problems 面板轮询触发，暂不依赖后台 stdout task 持有 `AppHandle`。
- 触发点：项目导入完成、保存、手动「重新构建项目」按钮；防抖合并。

**前端**：Problems 面板加 **「全项目 / 打开的文件」** 切换；未打开文件诊断点击即打开定位；徽标计数含全项目；「重新构建项目」入口（状态栏或面板工具条）。

**交付物**：spike 报告 → 后端全项目诊断命令 + event → Problems 面板切换 + 构建触发入口。

**🔶 已交付基础设施（M7-C，`083999f` 后端 + C-2 前端提交）——spike 无关、优雅降级**：
- **后端 `083999f`**：`lsp_workspace_diagnostics(workspace_id)` 聚合该 workspace 全部 ready session 已收到的诊断（含未打开文件，按 path 去重排序，跳过 `jdt://`/非 file URI）→ `WorkspaceDiagnosticFile{path,uri,diagnostics}`；`lsp_build_workspace(descriptor)` 走 jdtls 自定义 `java/buildWorkspace(full=true)` request 触发「重新构建项目」。v4.2 之前此聚合依赖 server 主动 push，v4.2 起再叠加标准 pull fallback。
- **⚠ 事件推送改为轮询(架构变更)**：原计划的 `lsp:diagnostics-updated` event push **已放弃**——在 LSP session 的 stdout 后台任务里持有 `AppHandle`/`Emitter` 会确定性触发 Windows 测试二进制启动失败(`STATUS_ENTRYPOINT_NOT_FOUND` 0xC0000139,与 emit 调用无关,移除 AppHandle 字段即恢复)。改为**前端轮询**:Problems 面板处于「全项目」且打开时每 ~1.5s 拉 `lsp_workspace_diagnostics` + 重建后重取。与既有按文件诊断同为 pull 式,无功能损失。
- **前端 C-2**：Problems 面板「全项目 / 打开的文件」切换;「全项目」轮询聚合诊断;点未打开文件诊断即 `problemPathToRef`(复用 `relativePathWithinRoot`)映射回 `{kind:root,rootId,path}` → openFile + reveal;徽标随激活 scope 计数;「Rebuild」按钮(仅全项目)→ `lspBuildWorkspace`。文案沿用 ProblemsPanel 既有硬编码英文约定(不引 i18n)。
- **✅ v4.5 pull fallback 代码闭环**：`lsp_workspace_diagnostics` 对声明静态 `diagnosticProvider.workspaceDiagnostics` 或动态 `workspace/diagnostic` 的 session 发起 LSP 3.17 pull；携带 previous resultId 与 partial-result token，支持 full/unchanged、relatedDocuments、分片合并和 `workspace/diagnostic/refresh` 即时失效，跨 session 并发，慢请求去重，失败继续使用 `publishDiagnostics` 缓存，损坏响应不部分覆盖已有状态。
- **⬜ 仍待三端真机 spike**：Maven/Gradle 工程含 A.java（有错且不打开）/B.java（打开）→ 点「Rebuild」→ 验证 push 或 pull 是否稳定列出 A.java，记录 jdtls provider capability、响应与耗时；并在支持 pull diagnostics 的 TypeScript/Rust/Python server 上各做一例真实工程验证。

### 11.Bundle jdtls 扩展加载基建（M8，D/E 共享硬前提，规模 M）

jdtls 经 `initializationOptions.bundles[]`（jar 绝对路径数组）加载扩展。**新增**：

- 后端 bundle 路径解析（用户配置或随发行下载）：`java-debug`（`com.microsoft.java.debug.plugin-*.jar`）、`java-test`（`com.microsoft.java.test.plugin-*.jar`）、`lombok`。
- 注入 `lsp_initialization_options` 的 `bundles`；Settings 暴露路径 + 「自动下载」入口 + 可用性探测（复用现有 jdtls 探测/版本校验模式）。
- 复用 `cc_bridge` 的 oneshot HITL 管道模式处理 server 回推的 `workspace/executeCommand` 结果与 `applyEdit`。

**✅ 已交付（`4929467`）**：新 `java_bundles.rs`——`resolve_bundle_jars`/`probe_bundles` 从配置目录按版本号（数值比较,非字典序）选最高版 `com.microsoft.java.{debug,test}.plugin-*.jar`,或接受显式 jar 路径;进程级 `CONFIGURED_JAVA_BUNDLES`。`lsp_initialization_options` 在配置存在时注入 `"bundles":[…]`（否则省略）。命令 `lsp_set_java_bundles`/`lsp_detect_java_bundles`;前端 `LSP_JAVA_BUNDLES_KEY` 持久化 + 启动推送 + Settings「调试与测试扩展」子区（路径输入 + detected/not-found 探测）+ en/zh。**修订**:Lombok **不是 bundle**——仍走 `-javaagent`(§11.A);bundles 只装 java-debug/java-test。**范围**:本期做路径配置 + 探测,自动下载留作发行打包决策(§10.8)。单测 5(版本选择/显式 jar/探测/空);jdtls 实际加载 jar 为真机项。

### 11.F 构建集成（M7，增强现有 Run/Tasks，规模 M–L，风险中）

**现状**：`workspace.rs:115` 已探测任务并 PTY 运行，扁平命令列表。**增强**：

- **依赖树视图**：`mvn dependency:tree` / `gradle dependencies` 解析，或 jdtls `java.project.getClasspaths`；树形展示 + 版本冲突标记。
- **生命周期/任务树**：Maven phases、`gradle tasks --all` 解析为可点击树（现为扁平列表）。
- **项目重载**：pom.xml/build.gradle 变更 → `java/projectConfigurationUpdate`（Download Sources 路径已部分具备），补「检测到构建文件变化 → 提示重载」。
- **模块/源集视图**：多模块工程 module 结构（jdtls `java.project.getAll`）。

**本阶段未完成**：IDEA 级 facet/source-set/language-level 建模仍是工程模型 Gap；复杂运行配置参数、仓库共享配置和 compound Run/Debug 已由 M11 形成基础代码闭环，剩余 active profiles、coverage、非 JUnit provider 统一结果协议与完整 adapter 矩阵继续按 §2.5 验收。

**✅ 已交付（M7-F，`ba037ac` + `a0d209c` + `f9abab5` + 模块视图提交）**：
- **项目重载（F-3，`ba037ac`）**：`lsp_reload_project` 走 active jdtls session 发 `java/projectConfigurationUpdate`（复用 download_sources 管道）；前端保存 pom.xml/build.gradle[.kts]/settings.gradle[.kts] 且 jdtls 活跃时弹「Reload Java project」确认。
- **任务树（F-2，`a0d209c`）**：`workspace_task_tree` 按 source 分组，Maven 全生命周期（clean…install）、Gradle 常用任务（clean/build/assemble/check/test/jar），其余生态按来源归组——纯离线（不 spawn，`gradle tasks --all` 实时枚举留作后续）；前端 Build 底部 dock 面板渲染可点击树，复用 `runWorkspaceTask`（PTY），原 Run tab 不动。
- **依赖树（F-1，`f9abab5`）**：`workspace_dependency_tree` spawn `mvn dependency:tree` / `gradle dependencies --configuration runtimeClasspath`，解析为 `DependencyNode` 森林并标版本冲突（Maven verbose `(omitted for conflict…)`、Gradle `req -> resolved` 仲裁）；解析器纯函数单测（spawn 为真机项）；前端 Build 面板 Dependencies 区按需加载、懒展开、冲突徽标。**安全**：树装配用索引路径栈，无裸指针（避免 Vec 扩容悬垂）。
- **模块视图（F-4）**：`lsp_java_modules` 走 jdtls `workspace/executeCommand: java.project.getAll` → `JavaModule{name,path,uri}`（解析器去重+按名排序，单测）；前端 Build 面板 Modules 区仅对含 Maven/Gradle 任务的根显示、按需加载（合成 `.java` 路径选中该根的 jdtls session）。
- **边界确认**：尚未做 IDEA facet/source-set/language-level 建模；运行配置参数体系已由 M11 补齐基础模型。真机门槛：spawn `mvn`/`gradle` 与 jdtls `getAll`/`projectConfigurationUpdate` 的端到端结果由用户真机冒烟回填；本期单测覆盖纯解析 + graceful 错误路径。

**v3.3 补强（与 §11.G 共用任务模型）**：

- 固定的根目录 Maven/Gradle 任务扩展为有界递归发现；`WorkspaceTask.modulePath` 标明模块，Build 面板直接展示模块徽标。父工程 wrapper 可被子模块复用，Gradle 任务使用 module-qualified selector。
- Maven 生命周期补 `rebuild = clean compile`；Gradle补 `classes` 与 `rebuild = clean classes`。Build 面板顶部把“展示任务”提升为可直接执行的 Build project / Rebuild。
- 本节仍负责构建模型、依赖与模块视图；“找到并启动 Java 应用”由 §11.G 闭环。

### 11.G Java Build/Run 可执行闭环（M10，P0，规模 M）

#### 11.G.1 根因复盘

v3.2 的功能命名超过了实际语义：Build 是静态生命周期列表，Run 是通用 shell task 列表；两者之间没有 Java application model。具体断点如下：

1. 没有发现 `main` class，编辑器当前 `.java` 文件无法映射为可执行目标。
2. 普通 Run 实际借不到 DAP 的 `resolveMainClass/resolveClasspath`；而 DAP 又依赖 jdtls + java-debug bundle，把“运行”错误地绑在“调试扩展安装完成”之后。
3. Maven/Gradle 只检查 workspace 根，monorepo/多模块子工程没有正确 cwd/task path。
4. Windows PowerShell 不搜索当前目录，原 `mvnw.cmd` / `gradlew.bat` 命令可能直接报“找不到命令”。
5. Java test 虽然通过 task tree 判断构建系统，最后却重新写死全局 `mvn` / `gradle`，wrapper 探测结果被丢弃。
6. 顶部没有 Build/Run 主要操作，用户必须先理解底部 dock 的内部结构；这不符合 IDE 高频操作路径。

#### 11.G.2 As-Built 方案

**主类模型与发现**

- 新增 `JavaRunTarget { id, label, mainClass, filePath, command, cwd, buildSystem, modulePath }`。
- `workspace_java_run_targets(root)` 在最多 25 层 / 5000 文件的受控索引内扫描 Java application 入口；单文件解析上限 2 MiB。
- `workspace_java_run_target(root,file)` 为当前编辑器文件做精确解析，是 `Shift+F10` 的低延迟路径。
- 解析器在匹配 main signature 前移除行/块注释、普通字符串、字符和 Java text block；接受 `String[] args`、`String args[]`、`String... args`，从 package declaration + 文件名形成 FQN。

**三条普通 Run 路径**

| 工程类型 | 启动方式 | 设计理由 |
|----------|----------|----------|
| Maven | 最近模块 cwd；最近父级 `mvnw`；`compile` → 固定版本 `exec-maven-plugin:java` | 不要求 java-debug；依赖与 classpath 交给 Maven |
| Gradle | 最近 settings root + wrapper；临时目录 Groovy init script 注册 `taomniRun: JavaExec`；子模块用 `:module:taomniRun` | 不修改用户 build files，也不要求 application plugin 已声明 `run` |
| 无构建系统 | `java <absolute-source.java>` | 使用 JDK 11+ source-file mode，覆盖教学/脚本型单文件 |

Gradle init script 只写入系统临时目录 `taomni-code-workspace/java-run.init.gradle`，内容固定且按内容校验后覆盖，不在 workspace 产生 `.taomni`、class 或配置文件。实际进程仍运行在工作区集成 PTY 中，因此 stdin、ANSI、Ctrl+C 和 exit code 行为与终端一致。

**Build 与 UI**

- Build 面板：根/模块 Maven 全生命周期，Gradle常用任务；Build project 与 Rebuild 一键入口。
- 编辑器 header：Build project（`Ctrl+F9`）、Run current Java file（`Shift+F10`）、Debug current Java file；运行前若当前 Java buffer dirty，先可靠保存再从磁盘解析。
- Run 面板：Java mains 作为第一类任务列在通用 scripts 之前，运行历史沿用真实 OSC 633 exit marker。
- workspace SDK environment 继续由 terminal backend 按 root + cwd 解析并注入，所以项目 JDK binding 对 `java`、wrapper 及其子进程一致生效。

**跨平台与测试修复**

- Windows 根 wrapper 使用 `.\mvnw.cmd` / `.\gradlew.bat`；父级绝对 wrapper 在 PowerShell 使用 call operator `& 'path'`，Unix 使用单引号安全转义。
- Java test 直接扩展 `workspace_task_tree` 返回的完整 `test` command（再追加 class/method selector），因此同时保留 wrapper 与 Gradle module-qualified task，不再调用 `defaultRunner()` 回退全局工具。
- Rust 单测覆盖：三种 main signature/注释误判、Maven wrapper、Gradle 子模块 selector/init script、test source 排除、多模块 task；Vitest 覆盖 Run target 渲染/启动、Build/Rebuild 选择与终端 exit 状态。

#### 11.G.3 当前边界与后续

- M11 已引入独立于展示命令的结构化 `ExecutionRunConfiguration`/`ExecutionDebugConfiguration`：program args、VM/runtime options、env map、dotenv、working directory、Before launch、配置命名与按源文件 active selection 均形成代码闭环，Run/Debug 共享选择；不再从 `WorkspaceTask.command` 反解析生产 argv。测试命令退出后由 `workspace_test_results` 读取有界 JUnit XML（Maven Surefire/Failsafe、Gradle `build/test-results`），Tests 面板消费稳定的 case/summary/diagnostics schema。
- 仍未达到 IDEA 完整 Run Configuration：compound Run/Debug 已支持嵌套、顺序/并行和失败策略，Debug 具备 grouped multi-session DAP；仍缺 active Maven/Gradle profiles/source set/module selection、coverage 和非 JUnit provider coverage；仓库级共享配置/模板、平台覆盖、配置迁移和校验 schema 已形成代码闭环，但仍需三端发行包验收。
- Maven 首次运行 exec plugin、Gradle首次解析依赖仍可能访问网络；离线行为由构建工具自身配置决定。
- Android Gradle、JPMS module-path、定制 Gradle `projectDir` 映射、非文件名顶层 main class 属高级 project model；发现失败时明确报错并保留自定义 task 兜底。
- Debug 仍走 DAP + java-debug bundle，以保留断点/变量能力；Run 与 Debug 的依赖边界刻意不同。

### 11.D 调试（DAP，M8–M9，最大新项目，规模 XL，风险高，分 D1–D5）

原 §2.3 明确排除，现纳入。**决策（§10.7）：从 D1 起就抽通用 DAP 框架**——语言无关内核 + 适配器注册表；Java 只是首个适配器，D3–D5 的断点/单步/变量/求值全部走**语言无关**的会话状态与前端面板，不写 Java 特判。后续 Node/Go/LLDB 等只需新增一个适配器定义。

**架构切分（内核 vs 适配器）**：

```
dap.rs（语言无关内核）
  ├─ DapSession: spawn/attach adapter, Content-Length 分帧 + JSON-RPC 变体
  ├─ 请求/响应/event 泵 + seq 管理 + capabilities 握手（initialize/launch/attach）
  ├─ 会话状态机: threads / stackFrames / scopes / variables / breakpoints（全部按 DAP 类型，无语言字段）
  └─ 经 Tauri event 转发前端（dap:stopped / dap:output / dap:terminated…）

DebugAdapterRegistry（适配器注册表，类比 lsp_presets）
  └─ DebugAdapterDescriptor { id, 如何启动 adapter 进程, 如何解析 launch config }
       └─ 首个：Java 适配器（见 D2）；后续语言追加 descriptor 即可
```

- **D1 通用 DAP 内核 + 适配器注册表**（新 `src-tauri/src/dap.rs`）：DAP 分帧/收发/事件泵、会话状态机（全 DAP 标准类型）、`DebugAdapterRegistry` 抽象与命令骨架（`dap_start_session`/`dap_send_request`/`dap_terminate` + event 转发）。**不含任何语言特判。规模 L。** — **✅ 已交付**：`Content-Length` 分帧 `encode_message`/`DapDecoder`(粘包/半包/坏帧跳过)、`classify_message`(response/event/reverse-request/unknown)、`DapSession`(seq 管理 + pending oneshot 关联 + `initialize` 握手)、`DapTransport`(Stdio spawn / Tcp connect——java-debug 走 Tcp)、`DebugAdapterRegistry`(空,D2 注册 Java)、`DapManager`(AppState 字段)、三命令。**事件安全**:`AppHandle` 作为命令参数克隆进 reader 闭包,`DapManager`/`DapSession` **不持 AppHandle**——规避 M7-C 的 `STATUS_ENTRYPOINT_NOT_FOUND`(测试二进制启动正常)。单测 8(编解码往返/半包/多帧/坏帧/分类/空注册表/大小写头)。spawn 真实 adapter 的端到端待 D2 + 真机。
- **D2 Java 适配器（首个 registry 插入）**：实现 Java `DebugAdapterDescriptor`——jdtls 命令 `java.resolveMainClass`/`java.resolveClasspath`/`java.resolveJavaExecutable` 组装 launch config；经 java-debug bundle 的 `vscode.java.startDebugSession` 拿到 adapter 端口/句柄交给 D1 内核。**语言相关代码集中于此一处。规模 M。** — **✅ 已交付 `9edb7b7`**（`java_debug_adapter.rs`）：resolve → `DapLaunchPlan{Tcp{port},launch,args}`;`dap_start_session` 返回 `DapStartResult{sessionId,capabilities,request,arguments}`（前端/D3 驱动 launch 时序）;`LspManager::execute_java_command` 共享 jdtls 访问;`DapManager::with_lsp` 注册 Java 适配器。单测 5（mainClass/classpath/port/launch-args/scope）。
- **D3 断点 + 单步**：gutter 断点、run/pause/step in·over·out/continue、当前行高亮、调用栈面板——**经 D1 内核的 setBreakpoints/continue/stepIn… 通用请求，不碰适配器**。**规模 M。** — **✅ 已交付 `b141bad`**：`dap_send`（fire-and-forget，launch 握手需要）;`dapDebugModel`（纯：setBreakpoints/异常过滤 arg、threads/stackTrace 解析、step→command、event reducer，单测 6）;`useCodeDebugSession`（launch→initialized→setBreakpoints→configurationDone 编排、断点持久化、stopped 后 threads+stackTrace）;`debugEditorChrome` 断点 gutter + 当前行高亮;`DebugPanel` 控制条+调用栈。
- **D4 变量 / 监视 / 求值**：variables·scopes 树、watch、debug console `evaluate`、悬停求值——同样走 D1 通用请求。**规模 M。** — **✅ 已交付 `b141bad`（随 D3 hook/panel）**：stopped 后 scopes→variables 懒展开树、watch 表达式（context=watch）、console（context=repl）。
- **D5 进阶**：条件断点、logpoint、异常断点（DAP `setExceptionBreakpoints`，通用）；热重载为 Java 适配器可选扩展（jdtls `redefineClasses`，经 registry 的适配器能力位声明，非内核必备）。**规模 M。** — **✅ 已交付**：条件断点/logpoint（gutter 右键 → 条件/日志消息 prompt → `setBreakpointOptions` 走 `setBreakpoints` 的 condition/logMessage）；异常断点初版（面板按 `capabilities.exceptionBreakpointFilters` 勾选 → `setExceptionBreakpoints`），其完整 filter metadata/condition/binding 生命周期由 D5.3 收口；热重载按钮（`redefineClasses`，best-effort）。
- **D5.1 function/method breakpoint（`cbda8dd`）**：**✅ 代码闭环**。按 `supportsFunctionBreakpoints` 发送标准 `setFunctionBreakpoints`，支持 condition/hitCondition、workspace 有界持久化、启停、Mute/Remove All、adapter 返回的 verified/pending/failed 状态及无 source/line 的 breakpoint event；初始化时严格位于 `configurationDone` 前，运行中修改同步到所有 eligible compound child，并以 per-session generation 丢弃旧响应和终止后响应。**未完成边界**：不同 adapter 的函数名/方法签名语法与真实绑定结果必须在 Java/JS/Python/Go/Rust/C++ 及三端真机矩阵验证，不能仅凭协议单测标记严格完成。
- **D5.2 data breakpoint/watchpoint（`596759d`）**：**✅ 代码闭环**。停驻的 Variables 或 Watch 行先调用标准 `dataBreakpointInfo`，只有 adapter 返回的 opaque `dataId` 才允许创建；`canPersist=true` 项按 `adapterId` 写入 workspace storage，`canPersist=false` 项只按 owner `sessionId` 存活。初始化恢复严格排在 `configurationDone` 前；标准 `setDataBreakpoints` 采用全量替换，支持 access type、condition、hitCondition、启停、Mute/Remove All、binding verified/pending/failed、compound adapter/session scope、终止清理和 stale-response generation guard。**未完成边界**：当前没有编辑器源代码字段声明/地址入口，也未建模 DAP 更新扩展中的 address/bytes/breakpointModes；真实 adapter 是否可 watch、读写触发语义、跨 Java/JS/Python/Go/Rust/C++ 的数据 id 生命周期和三端真机行为仍待验收。
- **D5.3 conditional exception filters（`1f2d93b`）**：**✅ 代码闭环**。完整解析 `exceptionBreakpointFilters` 的 label/description/default/supportsCondition/conditionDescription；用户显式启停与条件按 workspace + adapter + opaque filter id 有界持久化，新 filter 才采用 adapter default。初始化时在 `configurationDone` 前发送全量替换请求：无条件项及旧 adapter 走 `filters`，只有同时声明 filter condition 和 `supportsExceptionFilterOptions` 时才走 `filterOptions`；未广告 filter 的 adapter 不发送协议禁止的请求。运行中编辑只同步同 adapter 的 initialized compound children，并接入 Mute/Remove All、请求失败 console、verified/pending/failed 响应、breakpoint event id 路由、termination 清理和 per-session stale-response guard。**该阶段边界**：adapter filter 集合不是 IntelliJ IDEA 的任意异常类/包规则；标准 `exceptionOptions` 后由 D5.4 形成代码闭环，但 IDEA 专有属性、exception `breakpointModes`、Java/JS/Python/Go/Rust/C++ 的表达式/路径语法、真实绑定与三端行为仍待后续矩阵验收。
- **D5.4 exception path rules（`4510aa2`）**：**✅ DAP 代码闭环**。新增标准 `ExceptionOptions`、`ExceptionPathSegment` 和 `never`/`always`/`unhandled`/`userUnhandled`；规则 id/path/names/negate/mode 按 workspace + adapter 有界持久化，损坏的非空 path 被拒绝而不会意外扩大成 whole-tree。只有 adapter 同时广告 exception filters 和 `supportsExceptionOptions` 才允许创建/发送；请求严格合并为 `filters → filterOptions → exceptionOptions` 的位置绑定顺序，在 `configurationDone` 前恢复，运行中只同步同 adapter 的 initialized compound children，并接入启停、Mute、Remove All、请求失败 console、verified/pending/failed、breakpoint event id、termination cleanup 和 generation guard。DebugPanel 支持类/包 pattern、四种 break mode、多 path segment、name alternatives、negate、编辑/删除和 unsupported/binding 状态。**未完成边界**：DAP 没有规定 adapter 的 exception tree、wildcard 或语言继承语义，因此此提交不能单独证明 IDEA“指定异常及其子类”；也不表达 IDEA catch-site/throw-site class filters、caller/instance filters、pass count reset、condition/evaluate-log/remove-once/suspend-policy/dependency 等属性。exception `filterOptions.mode` 与其他 breakpoint `mode` 仍待统一 `breakpointModes` 建模；真实 adapter/三端矩阵仍待验收。

**前端**：底部 Debug 面板（调用栈/变量/监视/断点/data watchpoint/exception filters/exception path rules/console）+ 编辑器断点 gutter + 悬浮运行工具条，**均按 DAP 标准模型渲染，与语言无关**；data watchpoint 的创建入口目前限定为 stopped Variables/Watch 行，未提供 IDEA 式源代码字段声明/地址入口；exception path editor 完整保留标准 path segment/name alternatives/negate/break mode，但不能虚构 adapter 未承诺的 Java 类继承或 IDEA 专有 filter 语义。适配器专属能力（如 Java 热重载、data breakpoint 支持与访问模式、exception filter condition/path）按 D1 下发的 capabilities/适配器能力位开关（沿用 §5.2.0 capability 驱动模式）。

- **D6 IDEA 成熟度收口**（缺陷修复 + 补齐，规模 M）— **✅ 已交付**。
  **缺陷（P0）**：① 会话中新增/改条件的断点**从不生效**——`toggleBreakpoint`/`setBreakpointOptions` 在 `setBreakpoints` 的 state updater 内同步调用 sync，读到的是**改动前**的 ref，推给适配器的是旧集合；改为「先算新集合 → 同步更新 ref → 显式传 list 给 sync」的单一变更入口（`mutateBreakpoints`），并加 per-path generation 防止旧响应覆盖新集合。② Windows 长 classpath 启动失败（`CreateProcess error=206`）——java-debug 默认不缩短命令行，现默认 `shortenCommandLine: "auto"`（可覆盖），对齐 IDEA 的 shorten command line。③ **stdio 适配器死锁**——`connect_transport` 管道化 stderr 却无人排空，管道写满后适配器永久阻塞；新增 `run_stderr_pump` 转成 `output` 事件（Java 走 TCP 不受影响，但这是多语言框架的通用缺陷）。④ **反向请求无人应答**——内核只转发不回复，发 `runInTerminal`/`startDebugging` 的适配器会一直等；`reverse_response` 统一回失败响应。⑤ `initialize` 无超时 → UI 永久卡「starting」；加 20s 上限。⑥ EOF 时后端会话从 map 移除，前端不在也不泄漏；Stop 优先走 `terminate`（capability 判定）再 `disconnect`。
  **IDEA 对齐（均为语言无关 DAP 层）**：断点视图（全工作区列表 + 单个启用/禁用 + Mute All + Remove All + 点击跳转 + 条件/命中次数/logpoint 内联编辑，取代原先三连 modal prompt）；编辑器悬停求值（停驻时接管 LSP hover）；行尾 inline values（仅渲染到当前执行行）；调试快捷键 F9/F8/F7/Shift+F8/Ctrl+F8/Ctrl+Shift+F8/Alt+F9/Ctrl+F2；`thread` 事件维护线程列表；Stop 后保留 console（含 Clear）；库/反编译栈帧经 DAP `source` 请求打开只读缓冲区。
  **Java 适配器**：远程 attach（IDEA Remote JVM Debug，`hostName`/`port`，跳过 mainClass/classpath 解析）；显式 mainClass 缺 projectName 时回填所属工程（多模块下避免解析错模块）；`sourcePaths`/`stopOnEntry`/`encoding`/`shortenCommandLine` 透传。
  测试：Rust 24（新增 reverse-response、attach 参数、shortenCommandLine/透传）；前端新增 `useCodeDebugSession.test.tsx`（9，含旧缺陷回归）+ `debugEditorChrome.test.ts`（7）+ 模型/面板补充。**真机冒烟仍由用户验证**（需 jdtls + java-debug bundle + Java 工程）。

### 11.E 测试集成（M8–M9，依赖 Bundle 基建 + 部分 D，规模 L）

- **探测**：java-test 命令 `java.test.findTestTypesAndMethods`（JUnit4/5、TestNG）。
- **运行**：非调试 run 经 launch（不依赖 D）；调试 run 经 D 的 DAP（依赖 D2）。Maven Surefire/Failsafe 与 Gradle JUnit XML 结果提供 pass/fail/error/skip、耗时、失败详情、源码定位和重跑；coverage 与非 JUnit provider 结果仍待统一。
- **前端**：测试树面板（按包/类/方法）、gutter run·debug 图标、结果状态、失败堆栈跳转、「重跑失败」。
- **排期**：run-only 可先于 D 交付；debug-test 依赖 D2。

**🔶 已交付（M8 E + M9 收口）**：新 `java_test.rs`——`java_test_discover(workspace_id,root,file)` 走 jdtls `vscode.java.test.findTestTypesAndMethods`（file: URI 后端派生），容错解析（字段别名 fullName/jdtHandler/id、displayName/label/name、testLevel/level、children/tests）为 `JavaTestItem{name,fullName,kind,uri,range,children}` 树；复用 `LspManager::execute_java_command`。前端 `javaTestDiscover` 包装 + Tests 底部 dock 面板（按 class→method 树、run 图标、按活动 .java 文件自动探测）；**run-only 经集成终端**：`javaTestRunCommand`（Maven `-Dtest='Class#method'` / Gradle `--tests 'Class.method'`，构建工具由 `workspace_task_tree` 分组探测）复用 `runWorkspaceTask`（PTY）。`test_results.rs` 读取 Surefire/Failsafe/Gradle JUnit XML，限流文件/字段大小并输出稳定 case/summary/diagnostics；Tests 面板显示状态树、失败消息/堆栈、源码行定位与失败重跑。单测覆盖 parser、result tree 与 panel。**debug-test（M9 补齐）**：Tests 面板每项加 Debug 图标 → `java_test_resolve_launch`（java-test `vscode.java.test.junit.argument`，容错解析 mainClass/classpath/args）→ 以预解析 launch config 走 D2 DAP。真机门槛:探测/运行/调试/真实报告需 jdtls + java-test/java-debug bundle 加载 + Java 工程。

### 11.7 实施顺序与里程碑映射

```
M6 快赢(并行)      : A(jdtls 设置) ‖ B(大文件)                — 2 条独立线，无 M1–M5 之外新前提
M7 工程智能        : C(全项目诊断, 先 spike) ‖ F(构建增强)     — C 依赖 M6-A 的 autobuild
M8 测试/调试基建    : Bundle 基建 → E(测试 run-only) ；D1→D2 起步(可与 M7 并行)
M9 调试主线 + 收口  : D3→D4→D5 ；debug-test(E×D2) ；真机冒烟回填
M10 Build/Run 闭环 : G(main 发现 + Maven/Gradle/单文件 Run + 多模块 Build) — 不依赖 DAP bundle
M11 配置与分析收口 : Build target DAG + Run/Debug configuration + provider refactor/inspection/Analysis
```

硬依赖：C ← M6-A 的 `autobuild`；D/E ← Bundle 基建；debug-test ← D2；G ← M3 的 PTY + workspace SDK environment。A、B、F、G 不依赖 DAP，可独立发布、验收。

### 11.8 后端新增 / 扩展命令清单

| 模块 | 命令 / 改动 | 里程碑 |
|------|-------------|--------|
| lsp.rs | `lsp_initialization_options` 扩展 `settings.java` 全集 + bundles 注入 | M6-A / M8 |
| lsp.rs | `lsp_set_java_settings`（热更新经 didChangeConfiguration） | M6-A |
| lsp.rs | `lsp_workspace_diagnostics` 轮询聚合 + `java.buildWorkspace` 触发 | M7-C |
| 新 dap.rs | 通用内核：`dap_start_session` / `dap_send_request` / `dap_terminate` + DAP event 转发 + `DebugAdapterRegistry` 抽象（**语言无关**） | M8-D1 |
| dap.rs registry | Java `DebugAdapterDescriptor`：resolveMainClass/Classpath/JavaExecutable + java-debug `startDebugSession`（**唯一语言相关处**） | M8-D2 |
| 新 java_test.rs | `java_test_discover` / `java_test_run`（run-only）；debug 复用 dap | M8/M9-E |
| workspace.rs / lsp.rs | `workspace_dependency_tree` / `workspace_task_tree` / `lsp_reload_project` | M7-F |
| workspace.rs | `workspace_java_run_targets` / `workspace_java_run_target`；`WorkspaceTask.modulePath`；Maven/Gradle wrapper 与多模块 task command | M10-G |
| 新 java_bundles.rs | bundle 路径解析 / 探测 / 下载 | M8-Bundle |
| workspace.rs / frontend execution model | 结构化 Build/Run/Debug provider 结果、Build target 依赖计划、命名配置覆盖、dotenv 与 Before launch | M11 |
| lsp.rs / Analysis frontend | diagnostic tags/related information/code description/data、`CodeActionKind` 过滤、capability/inspection/related-location 展示 | M11 |

依赖新增：DAP 用自实现 stdio 客户端（不引第三方 crate）；java-debug / java-test / lombok 为运行期加载的 JVM bundle（jar），非 Rust 依赖。

### 11.9 风险与权衡（M6–M11）

| 风险 | 缓解 |
|------|------|
| 全项目诊断依赖 jdtls 推送语义 | **C 先做 spike**，确认 `buildWorkspace` 是否推送未打开文件；备选 LSP pull 诊断 |
| DAP 工程量失控 | 严格按 D1–D5 分里程碑，每阶段独立可用；**通用内核 + 适配器注册表（§10.7 已定）**——语言相关代码集中于 D2 一处，D3–D5 走标准 DAP，避免 Java 特判蔓延 |
| Bundle 版本 / 下载 | 探测 + 版本校验 + 手动路径回退（同现有 jdtls 模式）；不强制自动下载 |
| Lombok javaagent 路径 | Settings 显式配置 + 探测；缺失时降级提示而非静默报错 |
| 大文件增量与 server 不同步 | ChangeSet 映射 + 全量兜底（已有 catch）+ 版本代际校验（已有 epoch guard） |
| jdtls 内存（默认 1G） | M6-A 把建议 vmargs（如 `-Xmx2G -XX:+UseG1GC`）写入设置提示；大型工程引导上调 |
| 冷启动慢 | 与本计划正交；可另做「导入进度」可视化（承接 jdtls `language/status` 通知） |
| 静态 main 发现不是完整 Java AST | 先剥离注释/字面量并严格匹配合法 signature；jdtls/java-debug 可用时 Debug 仍走语义解析；后续 Run Configuration model 可增加 jdtls resolve 作为增强而非硬依赖 |
| Gradle 工程高度可定制 | init script 不改工程且使用 sourceSets runtimeClasspath；标准多模块使用 qualified task；自定义 `projectDir`/Android 等明确降级到自定义 task，避免伪支持 |
| Maven exec plugin 首次下载 | 固定 plugin 版本保证可重复；离线缓存缺失时在真实终端显示 Maven 原始错误，不吞错 |
| 范围蔓延 | §2.3 是严格持平基线：Profiler 与插件生态不在范围；facet/工程模型、PSI/index 和 native data-flow 必须保留为未完成 Gap |
