# Code Workspace IntelliJ IDEA Code Editor 对齐方案

> 目标：以 **IntelliJ IDEA 2026.2 的公开 Code Editor 工作流**为基准，先达到日常代码编辑工作流等价，再以 Java 为首个语言完成可证明的语义对齐。这里的“对齐”要求入口、结果、失败语义、撤销、配置和三端行为均可验证；相似 UI、协议字段存在或快捷键可触发都不等于能力完成。
>
> 日期：2026-08-15 · 版本：v4.30（IDEA 2026.2 editor capability realignment & post-`200d4627`/`2134e783` audit）· 状态：**实施中**。本轮仅更新目标、能力基线和待办，不修改代码。代码审计基线为当前分支 `2134e783`（包含 `200d4627`）；M0–M11 既有实现继续保留，但 Build/Run/Debug/Test/Terminal 等改列为“IDE 伴随能力”，不再计入 Code Editor 对齐分数。
>
> 当前结论：Code Workspace 已具备较完整的 CodeMirror/LSP 日常编辑骨架。最近提交已把 `EffectiveCodeStyle` 接到 CodeMirror 缩进和 LSP formatter，并改善补全输入期性能；但 EditorConfig 仍停留在 parser/test 层，显式缩进覆盖未持久化，保存规范化尚未闭环，`ActionRegistry` 仍未成为运行时 dispatch 真值，编辑命令也只覆盖单主选区。系统仍是 **provider-backed editor**，不是 IDEA 的 PSI/index/inspection/refactoring engine 等价物。
>
> 早期版本：v4.29（2026-08-15，IDEA 2026.2 editor 能力重对齐与 `ca18b396` 审计）· v4.28（2026-08-15，Refactoring usages preview、indentation detection 与 keymap cheatsheet）· v4.27（2026-08-15，Sticky Lines, Ctrl+Shift+F9 & Run Profile overrides）· v4.26（2026-08-15，P0-P2 shortcuts & actions delivery）· v4.25（2026-08-15，IDEA editor parity backlog & execution）· v4.24（2026-08-15，IDEA editor parity & multi-module execution graph）· v4.23（2026-08-15，project model baseline）· v4.22（2026-08-15，DAP adapter contract fixtures）· v4.17（2026-08-15，DAP `exceptionOptions`）· v4.16（2026-08-14，DAP conditional exception filters）· v3.2（2026-07-26，M6–M9 代码交付）· v3.1（2026-07-25，M6 代码交付）· v3.0（2026-07-25，新增 §11 M6–M9 计划并修订 §2.3 非目标）。
>
> 早期版本沿革：v2.10（2026-07-12，M0–M5 主线交付与后续收口）。

---

## 1. 现状盘点（As-Is）

| 领域 | 已有能力 | 载体 |
|------|----------|------|
| 工作区模型 | 多根目录（folder/git）+ loose files、布局恢复、最近工作区、tree/compact/flat 文件树 | `CodeWorkspaceTabInfo`、`codeWorkspaceStore`、`useWorkspaceTreeData` |
| 编辑内核 | CodeMirror 6：查找替换、多光标/矩形选择、折叠、注释、soft wrap、括号匹配/闭合、常用编辑键位、大文件降级、二分屏与同步滚动、preview/pin/溢出 tab | `CodeMirrorHost.tsx`、`workspaceEditorCommands.ts`、`EditorGroup.tsx` |
| 编辑效率 | LSP 补全与 snippet、语法上下文抑制/输入防抖/候选上限、启发式 Complete Current Statement、同词多光标、大小写切换、join/sort/reverse lines（主选区）、内置/自定义 Live Templates 与 Postfix Templates；EffectiveCodeStyle 与状态栏标签 | `lspCompletion.ts`、`syntaxContext.ts`、`workspaceEditorCommands.ts`、`liveTemplates.ts`、`LiveTemplatesSettings.tsx`、`codeStyleModel.ts`、`codeWorkspaceStatusStore.ts` |
| Markdown | edit/preview/split，Mermaid 渲染 + SVG/PNG 导出 | `MarkdownPreview.tsx` |
| LSP 与分析 | 10 种语言预设 + 自定义命令；文档同步、诊断元数据、补全、签名、文档、导航/引用/层级、格式化、重命名、按 kind 请求 Code Action、inlay/semantic token、动态 capability、跨 root/language 的有界 workspace symbol 聚合、provider-backed inspection profile/related locations/structured evidence | `src-tauri/src/lsp.rs`、`src/lib/editor/lsp.ts`、`useWorkspaceLspSession.ts`、`AnalysisPanel.tsx` |
| 搜索与导航 | Find/Replace in Files、Search Everywhere、Go to File/Class/Symbol、Recent/Recently Changed Files、Last Edit Location、前进/后退、Outline/结构弹窗、Problems | `workspace_search.rs`、`SearchEverywhere.tsx`、`useWorkspaceNavigation.ts`、workspace panels |
| 质量与重构 | LSP diagnostics/Code Action、provider-backed inspection profile；Rename、受限 Safe Delete、provider refactor kinds、可勾选 WorkspaceEdit 预览、事务 undo/redo | `inspectionProfile.ts`、`safeDelete.ts`、`RefactoringPreviewDialog.tsx`、`workspaceEditHistory.ts` |
| 编辑器呈现 | breadcrumbs、sticky lines、inlay hints、semantic tokens、Git gutter/inline blame/chunk rollback、coverage gutter、TODO/书签、本地历史 | workspace chrome/panels、`coverageEditorChrome.ts` |
| IDE 伴随能力（不计入 Editor 对齐） | PTY、Build/Run/Test/Debug、DAP、工程拓扑、覆盖率报告、Git Manager、AI、远程工作区 | `workspace_execution.rs`、`dap.rs`、Run/Build/Test/Debug panels |
| 设置入口 | code view profile、编辑区/树缩放、LSP/Java 设置、Live Template 管理、静态 action catalog 驱动的固定命令速查表 | `codeViewProfile.ts`、Settings、`workspaceActionRegistry.ts`、`KeymapCheatSheetDialog.tsx` |

**当前明确缺失或被高估的 Editor 能力：**

1. 没有 IDEA 的 PSI/stub index、inspection/data-flow/nullability engine 和索引保证的重构；provider semantic snapshot 只是过期结果护栏。
2. 没有 Smart Completion、type-matching completion、重复调用扩展候选、语言感知 Complete Current Statement、Surround With、Generate Code 和完整 intention catalog。
3. 没有 Code Workspace 编辑器内的 Full Line/inline suggestion、模型生命周期或逐词/逐行接受；Terminal 的 FIM 建议不是 Code Editor Full Line Completion。
4. 缩进切换现在能通过 `EffectiveCodeStyle` 重配置 CodeMirror `EditorState.tabSize`/`indentUnit`，且格式化请求带 `tabSize`/`insertSpaces`；但覆盖只存于当前 React 生命周期，`continuationIndent` 尚未消费，EditorConfig 没有生产解析，保存时的 EOL/charset/尾随空白/末尾换行也未执行。
5. 现有能力仍只有 LSP format/range format、format on save 和 organize imports；没有 IDEA code-style scheme、生产级 EditorConfig 父目录链/优先级、rearrange、cleanup、formatter marker/exclusion 和 scope formatting。
6. Live/Postfix Templates 已有目录与自定义 UI，但 postfix 只按文本正则提取表达式，没有类型/上下文适用性、template variable function、surround template 和 import shortening 语义。
7. 导航仍缺 Recent Locations（带上下文预览）、Switcher、related/super/sibling/method navigation、Structural Search/Replace；编辑 tab 仍限定两个 group，缺嵌套分屏、拖拽拆分/停靠、detach、tab policy/limit/sort。
8. Keymap 目前是固定命令列表的速查/执行面板，不支持 action tree、按键反查、冲突检测、增删快捷键、scheme copy/reset/import/export；设置 schema/迁移和无障碍验收也未闭环。
9. clipboard history、transpose lines、unwrap/remove、custom folding region、virtual space、smart keys、字体/ligature/color scheme 等 IDEA 编辑器基础项尚无产品级闭环；join/sort/reverse 已有最小单主选区实现，但尚未达到 IDEA 的多选区、边界和排序选项语义。
10. Linux/macOS/Windows 的 IME、非美式键盘、系统快捷键、剪贴板、字体、路径、watcher、编码和打包应用证据仍缺。详细权威状态以 §2.5、§2.8、§2.9、§8.2 和 §8.3 为准。

---

## 2. 目标与范围

### 2.1 产品定位

Code Workspace 是 taomni 内的代码编辑器与工程工作台，但本方案只把 **Code Editor** 作为主验收对象。参考产品固定为 IntelliJ IDEA 2026.2，参考语言固定为 Java；TypeScript/JavaScript、Python、Go、Rust、C/C++ 等语言通过 LSP/provider 提供能力，但只能按实际 capability 和对照用例分别记账，不能由“协议已接入”推导为全语言 IDEA 等价。官方明确标为 Ultimate 且默认随产品启用的 Full Line Code Completion 单独按 P2 参考发行版能力记账，不由此扩大到任意插件兼容。

目标分两层：

1. **发布目标：核心编辑工作流等价。** 用户能高效完成输入、补全、理解、导航、搜索、格式化、修复、重构和恢复，且动作可发现、可配置、可撤销。
2. **北极星目标：Java 语义对齐。** 对声明/引用、inspection、data-flow 和项目级重构给出可证明的完整性、冲突和 freshness 语义；不要求复用 JetBrains 源码，但要求对照 fixture 的结果等价。

Build/Run/Debug/Test/Coverage、Terminal、Git Manager、AI 和远程工作区继续发展为伴随能力；它们能增强编辑体验，但不能用于宣称 Code Editor 已对齐。

### 2.2 范围分级

| 级别 | 内容 |
|------|------|
| **P0（正确性与日常效率）** | 修正无效/夸大的 affordance；真实缩进与 smart keys；编辑命令；Basic/Smart/Type-matching Completion；Live/Postfix Template 语义；Surround/Generate；diagnostics/intention；EditorConfig/code style；Search/Navigation；可编辑 keymap |
| **P1（Java 语义对齐）** | project/dependency context、声明/引用 index、inspection/data-flow、冲突感知 refactor、完整 usages preview、semantic navigation、dumb/smart state、性能与损坏恢复 |
| **P2（高级编辑工作流）** | Structural Search/Replace、Recent Locations/Switcher、Full Line 本地内联补全、Code Vision、复杂 tab/nested split/detach、clipboard history、custom folding、scratch/injected language、完整 appearance/accessibility |
| **X（伴随轨道，不计 Editor 分数）** | Build/Run/Debug/Test/Coverage、Terminal、完整 Git 客户端、AI、SSH/SFTP；仅其编辑器内入口/装饰按相关 Editor 用例验收 |

### 2.3 Code Editor 对齐边界

**纳入主目标：**

- 文本输入/选择/剪贴板、多光标、statement-aware edit、查找替换、折叠、注释、smart keys、编码/EOL/BOM、tab/split、breadcrumbs、scrollbar/gutter 和状态栏。
- Basic/Smart/Type-matching Completion、参数信息、快速文档、Live/Postfix Templates、Complete Statement、Surround With、Generate Code、auto-import 和 optimize imports。
- IDEA Ultimate 默认 bundled plugin 提供的本地 Full Line Completion 作为 P2 参考扩展：单/多行内联建议、整段/逐词/逐行接受、语义过滤、auto-import、离线与隐私行为；只先要求 Java 对照，不要求兼容 JetBrains 插件 API。
- diagnostics、intention/quick fix、inspection/profile/scope/suppression、Problems、data-flow/nullability；provider 结果必须标明来源和完整性。
- declaration/type/implementation/usages、class/file/symbol/action 搜索、hierarchy、Recent/Last Edit/Recent Locations、结构视图、Structural Search/Replace。
- format/range format、code-style scheme、EditorConfig、rearrange、cleanup、save actions 和 formatter exclusion。
- Rename/Safe Delete/Move/Copy/Extract/Inline/Change Signature 等重构的 preview、exclude、conflict、undo 和 freshness。
- keymap scheme、action context、settings schema/迁移、可发现性、键盘/读屏/焦点/对比度以及 Linux/macOS/Windows 一致性。

**作为 Editor 的使能基础纳入，但只验收其编辑影响：** project/module/source-set、dependency/library source、language level、symbol/reference index 和增量失效。完整 build artifact、compiler cache 或运行配置不属于 Editor 主分数。

**不纳入 Code Editor 主目标：** 第三方/任意 IDEA 插件兼容生态、AI Assistant、完整 Build/Run/Debug/Test/Coverage 产品、完整 Git 客户端、Terminal、Profiler、数据库客户端、远程桌面、邮件/聊天。它们独立记账，不得替代上面的编辑器缺口；上面单列的 Ultimate bundled Full Line 能力不代表放开此边界。

### 2.4 能力等级与验收门禁

实现状态统一使用四级，避免继续把 UI/协议入口写成“已交付”：

| 等级 | 含义 |
|------|------|
| **L0 未实现** | 没有用户可用入口，或入口不产生承诺的效果 |
| **L1 表面/协议基线** | UI、命令或协议已接入，但语义、配置、失败或完整性仍依赖外部 provider/固定假设 |
| **L2 工作流可用** | 主路径、取消/失败、状态同步、撤销和聚焦自动化闭环；明确展示 provider/平台限制 |
| **L3 对照等价** | 通过 IDEA 对照 fixture，语义完整性、冲突、性能、配置与 Linux/macOS/Windows 真机证据均满足 |

能力从 L1/L2 升级必须同时通过：

1. **行为门禁**：入口、快捷键、鼠标/键盘流程、结果、取消、失败和 undo 与对照用例一致；不能以静默 `null` 或无效开关作为成功。
2. **语义门禁**：语义功能记录 provider/index、scope、revision、完整性和冲突；LSP/DAP 字段存在不等于 IDEA 行为等价。
3. **状态门禁**：dirty buffer、磁盘、tab、index、tree、diagnostics 与外部变更在资源操作后收敛。
4. **配置与可访问门禁**：设置可持久化/迁移/恢复默认，action 可发现，焦点、读屏名称、缩放、对比度和仅键盘操作可验收。
5. **性能门禁**：定义小/中/大工程基准、输入延迟、索引/搜索时间、内存上限和 large-file 降级，不允许 UI 假死或旧结果回填。
6. **三端与回归门禁**：Linux/macOS/Windows 原生包各有真实 fixture；聚焦 Vitest/Rust 测试与 `qa-ui-auto --diff` 通过，并保存脱敏日志/截图/版本信息。

### 2.5 当前 Gap 清单（权威基线）

状态按 §2.4 的 L0–L3 记录。下表只评价 Editor；X 轨道即使代码更多，也不提升 Editor 等级。

| 优先级 | 能力域 | 当前代码基线 | IDEA 2026.2 关键 Gap | 等级 |
|--------|--------|--------------|----------------------|------|
| P0 | 文本编辑与 smart keys | 查找替换、多光标/矩形选择、注释、fold、soft wrap、括号闭合、复制/删/移动行、大小写切换、selection range、编码/EOL/BOM；join/sort/reverse lines 已覆盖主选区 | join/sort/reverse 仍不处理 multi-range/矩形选择、排序选项或稳定边界；缺 clipboard history、transpose、unwrap/remove、custom fold、virtual space、Tab 跳出括号等语言 smart keys；Complete Statement 只是行文本启发式 | **L2 部分工作流（新增命令为 L1–L2）** |
| P0 | 缩进、格式与 code style | `EffectiveCodeStyle` 已驱动 CodeMirror `tabSize`/`indentUnit`；LSP document/range formatting 带 `tabSize`/`insertSpaces`；format on save、organize imports、缩进状态栏 | `editorConfigParser` 仅 parser/test-only，未从文件树解析 `.editorconfig`；explicit override 不持久化；`continuationIndent`、EOL/charset/trim/final-newline 尚未进入保存 pipeline；无 code-style scheme、rearrange/cleanup、scope format、formatter marker/exclusion | **L2 缩进基线 / L1 EditorConfig 与保存语义** |
| P0 | Completion / Templates / Generate | LSP completion/resolve/snippet/additional edits、signature help；语法上下文抑制、80ms plain-typing debounce、trigger 字符即时触发、候选映射上限 200；内置/自定义 Live/Postfix Templates；Tab 展开 | 仍无 Smart/Type-matching Completion、重复调用扩展候选、completion exclusion/priority、可见性/类型过滤；syntax context 对语言节点名和词法 fallback 有限；postfix 不按类型/上下文过滤；无 template functions、Surround With、Generate constructors/getters/override/toString 等 | **L2 性能基线 / L1–L2 语义能力** |
| P2 | Full Line / Inline Completion | Code Workspace 编辑器内没有 inline suggestion/ghost text、模型管理或部分接受；Terminal FIM source 不计入本项 | IDEA Ultimate 的 bundled plugin 默认启用，本地模型给出单/多行建议，支持整段/逐词/逐行接受、格式/括号补全、基础语义检查、auto-import、smart filtering、模型下载/更新和硬件降级 | **L0** |
| P0 | Diagnostics / Intention / Inspection | push/pull diagnostics、Problems、Alt+Enter Code Action/resolve/command；provider rule 显示启停/severity、file/line suppression、baseline、related evidence | 无 IDEA inspection registry/executor、scope/profile rule engine、自定义 severity 执行、cleanup、CFG/SSA/nullability/taint/interprocedural data-flow 和可证明 path；evidence 只是 provider metadata/文本分类 | **L1，核心差距** |
| P0 | Navigation / Search | declaration/type/implementation/references、call/type hierarchy、Search Everywhere、Go to File/Class/Symbol、Recent/Changed Files、Last Edit、history、Outline/Structure、Problems 跳转 | Last Edit 仅内存单点；缺 Recent Locations 上下文预览、Switcher、related/super/sibling/method navigation、完整 library/dependency index、Structural Search/Replace 和 scope/template 分享 | **L2 部分工作流** |
| P0 | Keymap / Actions / Settings | 新增 `workspaceActionRegistry` metadata/catalog、旧 `WorkspaceCommand` 的 context gate、action search、快捷键速查与点击执行；部分 editor/LSP/template 设置 | registry singleton 尚未在生产注册/执行/订阅；catalog ID/category 与实际 command 有不一致；`when` 仍为字符串且未求值；速查表不是 keymap editor；无 scheme 继承/copy/reset/import/export、按键反查、冲突检测、统一 settings schema/migration；快捷键仍分散在 CodeMirror 与 workspace 两层 | **L1，registry 仅骨架** |
| P1 | Index / Refactor | LSP Rename、受限 Safe Delete、provider extract/inline/change-signature/move；semantic revision/root guard；可勾选 raw text edits 的 preview；普通文件事务 undo/redo | 无声明/引用/type graph、smart/dumb state、language-aware conflict detector 和后置验证；逐 edit 排除可能破坏 provider 重构不变量；缺 Copy、Extract Field/Parameter、Pull/Push、Encapsulate 等 Java catalog | **L1，核心差距** |
| P2 | Tabs / Splits / Editor presentation | preview/pin/scroll/all-tabs，两个 editor group，横/纵 split、同步滚动，breadcrumbs/sticky lines/inlay/semantic/Git/coverage/debug gutter | 缺任意 nested splits、tab drag-to-split/dock、detach、equalize/stretch/splitter navigation、tab limit/order/policy；缺 scrollbar lens、Code Vision/继承提示、完整 font/ligature/color/appearance scheme | **L2 部分工作流** |
| P0 | File state / Recovery | hash 写保护、watcher、dirty conflict、恢复快照、行级三方 merge、WorkspaceEdit 资源操作与普通文件事务 history | 缺语义/token merge、目录/symlink/特殊文件 undo、大小写-only rename、locked file/permission/network/UNC 完整行为和三端打包证据 | **L2** |
| P0 | Accessibility / Performance / 三端 | large-file decoration 降级、部分 ARIA/testid、布局持久化；Linux 自动化与条件编译 | 无统一输入延迟/内存/索引基准；IME、读屏、focus order、200% zoom、非美式键盘、系统快捷键及 Linux/macOS/Windows 原生包矩阵未验收 | **L1–L2** |
| P0 | 编辑响应与外部变更 | CodeMirrorHost `memo`/compartment guard；completion 80ms 防抖、trigger 即时、200 项 cap；tree refresh 200ms debounce；watcher 跳过常见 build/dependency 目录；LSP capability 空摘要合并保护 | 目前只有单测/合成基准，没有真实 typing p95、IPC/内存/大工作区 profile；comparator 假设 callback 通过 ref 稳定，未来新增行为 prop 可能产生 stale closure；capability merge 可能保留新 session 的陈旧能力；watcher/树/排序仍缺三端压力证据 | **L2 性能护栏 / L1 证据** |
| X | Build/Run/Debug/Test/Coverage 等 | 已有结构化 execution/DAP/JUnit/LCOV/JaCoCo/Git/PTY/AI 能力 | 独立按伴随轨道验收；coverage 目前是报告扫描/展示，不是 IDEA Run with Coverage 配置模型 | **不计 Editor 等级** |

### 2.6 Linux / macOS / Windows Gap

| 平台 | 当前证据 | 平台特有 Gap | 严格验收清单 |
|------|----------|--------------|----------------|
| Linux | 当前环境有 TypeScript/Vitest/Rust 自动化和 `cfg(unix)` 路径 | 无打包 Tauri 记录；Wayland/X11 选区/剪贴板/拖拽、fcitx/ibus IME、非美式键盘、系统快捷键、字体 fallback、inotify 上限与跨 mount rename 未验收 | Ubuntu Wayland + X11；中日韩 IME；US/非 US 键盘；多光标/clipboard/tab/split；大小写敏感 FS；Java/TS 大工程 |
| macOS | 无本轮本机执行证据；Tauri WebDriver 不支持 macOS | `Cmd`/`Option`/dead key、输入法 composition、系统菜单与快捷键、Retina/字体、APFS 大小写模式、quarantine/notarization、应用退出后的 LSP 子进程均未验收 | Apple Silicon 为主、Intel 至少一套；Cmd 系 keymap；IME；大小写-only rename；签名包；Java/TS 编辑主路径 |
| Windows | 有条件编译与部分 Rust 单测，本轮未在 Windows 执行 | WebView2 composition/IME、AltGr/OEM key、CRLF/BOM、drive/UNC/长路径/盘符大小写、锁定文件/杀软竞争、junction/symlink 和高 DPI 未闭环 | Windows 11；中日韩 IME；US/非 US 键盘；NTFS + UNC；CRLF/UTF-8 BOM；200% 缩放；锁定文件失败恢复；Java/TS 编辑主路径 |

三端共同保存同一套验收产物：应用/OS/WebView/字体/键盘/IME 版本、工程 fixture、操作步骤、LSP trace 摘要、性能采样、失败截图/脱敏日志和时间戳。浏览器 stub 与单平台单测不能替代这些证据；DAP/Build 证据只归 X 轨道。

### 2.7 支持性协议实施记录（原 P0-A/P0-B，2026-08-11）

本节保留既有 LSP/文件一致性成果，作为 Editor 的支撑证据；它不是 v4.30 优先级清单，也不能覆盖 §2.5 中的真实产品 Gap。

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

### 2.8 IDEA 2026.2 官方能力再对齐（2026-08-15）

本轮以 JetBrains 2026.2 Help 为准重新建模 Code Editor，而不是从现有实现反推目标。官方页面在 2026-07/08 更新；每个大里程碑开始前必须再次复核 URL 与产品版本。

| 官方能力族 | IDEA 2026.2 真实能力 | 当前 Code Workspace 对比 | 目标修订 |
|------------|----------------------|---------------------------|----------|
| Editor basics / source editing | [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html) 与 [Write and edit source code](https://www.jetbrains.com/help/idea/working-with-source-code.html) 覆盖 tabs/preview/pin/detach、任意 split、breadcrumbs、font/ligature、virtual space、smart keys、clipboard history、statement move/complete/unwrap、custom folding 等 | 已覆盖常用文本操作、两组 split、preview/pin、breadcrumbs/sticky lines；缺口见 §2.5，Complete Statement 仍为启发式 | P0 先补真实缩进/smart keys/高频 edit；复杂 tab/split/appearance 列 P2 |
| Completion / templates / generation | [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) 包含 basic、smart type-matching、重复调用扩展范围与 completion 设置；另有 [Live Templates](https://www.jetbrains.com/help/idea/live-templates.html)、[Postfix Completion](https://www.jetbrains.com/help/idea/postfix-code-completion.html)、[Generate Code](https://www.jetbrains.com/help/idea/generating-code.html) 和 [Surround Code](https://www.jetbrains.com/help/idea/surrounding-blocks-of-code-with-language-constructs.html) | LSP basic completion/snippet 与本地 template catalog 可用；没有 smart/type-matching mode、语义 postfix、Surround/Generate | 这些从“加分项”升为 P0 日常效率，不再只追补快捷键 |
| Full Line code completion（Ultimate bundled plugin） | [Full Line code completion](https://www.jetbrains.com/help/idea/full-line-code-completion.html) 在 Ultimate 中默认 bundled/enabled；模型完全在本机运行，提供单/多行 inline suggestion、整段/逐词/逐行接受、格式/括号/引号修正、基础语义检查、auto-import、smart filtering 与模型更新；Java/Kotlin 模型随 IDEA 提供，其他语言按插件/模型可用性变化；官方硬件门槛为 AVX2 x64 或 ARM64 | Code Workspace 编辑器没有 inline suggestion/model runtime；现有 LSP popup completion 和 Terminal FIM 均不是该工作流 | 作为有 edition/plugin/硬件限定的 P2 参考能力，Java 先行；不将其误归为 AI Assistant，也不要求通用 JetBrains plugin compatibility；不支持硬件时必须显示 unavailable |
| Intentions / inspections | [Intention actions](https://www.jetbrains.com/help/idea/intention-actions.html) 支持查看/禁用/分配 shortcut；[Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html) 支持 project/scope、severity、自定义 profile、suppression 与 quick-fix | Alt+Enter 和 provider diagnostics 已接；profile 主要改变显示，不执行 IDEA inspection | Provider 能力保持 L1/L2；Java inspection/index/data-flow 为 P1 语义主线 |
| Navigation / search | [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html) 覆盖 declaration/type/implementation、last edit、super/sibling/method navigation；[Search Everywhere](https://www.jetbrains.com/help/idea/searching-everywhere.html) 覆盖 class/file/symbol/action/text；[Structural Search](https://www.jetbrains.com/help/idea/structural-search-and-replace.html) 按语法模板搜索替换 | 主流 LSP 导航、Search Everywhere、Recent/Changed/Last Edit 已有；缺 Recent Locations、Switcher、super/sibling/method 与 SSR | 补齐高频导航列 P0，SSR 与复杂位置历史列 P2；library/index 完整性归 P1 |
| Formatting / imports / style | [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html) 覆盖 fragment/file/module/directory、save/commit、exclude/marker、formatter settings；[Auto/Optimize Imports](https://www.jetbrains.com/help/idea/optimizing-imports.html) 与 [EditorConfig](https://www.jetbrains.com/help/idea/editorconfig.html) 提供持久化 style 与优先级 | LSP format、format on save、organize imports 有入口；`EffectiveCodeStyle` 已驱动编辑器缩进与 formatter options，但 EditorConfig parser 未接生产 resolver，override/保存规范化不持久化，无 rearrange/cleanup/scope/marker | 先收口 style provenance、父目录 EditorConfig 链、保存 normalize 与 preview；再扩展 scheme/rearrange/cleanup，不能把 status label 计作完整 style |
| Refactoring | [Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html) 包含 Safe Delete、Copy/Move、Extract method/constant/field/parameter/variable、Rename、Inline、Change Signature，以及 usages preview、exclude、conflict dialog 和统一 undo | provider actions、raw edit preview/exclude 与普通文件 undo 已有；无语义 conflict/完整性保证 | Java index + provider refactor contract 为 P1；preview UI 只能记 L1/L2 |
| Keymap / action system | [Keymap](https://www.jetbrains.com/help/idea/settings-keymap.html) 可 search action、按键反查、copy/rename/reset/delete scheme、添加/删除 shortcut 并处理平台键盘差异 | 新 `workspaceActionRegistry` 提供 metadata 类型、测试和静态 catalog，但生产仍由 `WorkspaceCommand[]` dispatch；catalog 与实际 ID/category 有 orphan/mismatch，cheatsheet 仍是速查/执行面板 | 先做 ID 对账与 migration adapter，再统一 runtime registration/subscription、when 编译、冲突图和 scheme persistence；完成后才开始可编辑 keymap |

官方能力映射只定义“IDEA 有什么”；是否完成仍必须回到 §2.4 的对照 fixture，而不是以页面名称、组件名称或协议 capability 判断。

### 2.9 当前代码证据审计（基线 `2134e783`，2026-08-15）

| 审计项 | 当前代码证据 | 结论与纠偏 | 下一验收点 |
|--------|--------------|------------|------------|
| EffectiveCodeStyle wiring | `codeStyleModel.ts` 定义 `tabSize/indentSize/continuationIndent/insertSpaces`；`CodeWorkspaceTab` 将结果传给 `EditorGroup`/`CodeMirrorHost`；CM 通过 compartment 重配 `EditorState.tabSize` 与 `indentUnit`；`formatFileText` 将 `tabSize`/`insertSpaces` 传给 document/range formatting | 缩进从“错误承诺”提升为 **L2 工作流基线**，但只覆盖当前 tab 的内存 override；`continuationIndent`、逐字段 provenance、save normalization 尚未闭环 | 状态栏切换后真实 Tab/Enter/format 对照；reopen/workspace restore；保存时 EOL/charset/whitespace/final-newline；callback/comparator 生命周期测试 |
| EditorConfig | `editorConfigParser.ts` 实现 parser/glob matcher，调用只出现在 parser 单测；`CodeWorkspaceTab` 只传 `explicitOverride`，没有父目录查找、root stop 或文件变更失效 | parser 是 **L1/test-only**，不能宣称 EditorConfig 支持；且 resolver 目前若仅有 EOL/charset 属性不会进入 EditorConfig 分支 | 实现 `EditorConfigResolver`（父链、nearest merge、`root=true`、cache/invalidation、每字段来源），再接 `resolveEffectiveCodeStyle` |
| Save/style pipeline | format-on-save 只调用 formatter 并保护异步期间的新编辑；`trim_trailing_whitespace`、`insert_final_newline`、`end_of_line`、`charset` 未在保存前执行 | 需要独立的可预览 normalize stage；不能把 formatter 成功等同于 code-style 保存成功 | normalize 顺序、取消/失败/dirty race、编码不可表示字符、外部变更冲突 fixture |
| Runtime actions | `workspaceActionRegistry` 有 `register/get/search`、metadata 和 22 项静态 `DEFAULT_WORKSPACE_ACTIONS`；同一基线下 `CodeWorkspaceTab` 有 81 个 `workspace.*` runtime command，仍由 `WorkspaceCommand[]` + `runWorkspaceCommand`/`dispatchWorkspaceCommandKeydown` 执行；cheatsheet 仅静态查 metadata | **L1 registry skeleton**。已知 ID 不一致：`formatDocument`/`format`、`nextDiagnostic`/`nextError`、`quickDefinitionPeek`/`quickDefinition`、`rename`/`renameSymbol`、`safeDelete`/`safeDeleteSymbol`；category 也有差异。`when` 字符串未编译，缺订阅和动态 disabled reason；cheatsheet 的“multi-platform parity”页脚属于过度承诺 | ID/类别全量对账；migration adapter；单一 executable definition；结构化 `when` evaluator；Search/Menu/Keymap/CheatSheet 共用 registry；先修正文案，再补冲突图和 platform binding resolve |
| Editing commands | `workspaceEditorCommands.ts` 新增 `joinLines`、`sortLines`、`reverseLines`，绑定 `Mod/Ctrl-Shift-J`；均只读取 `selection.main`，sort 使用 JS `localeCompare`，需非空且跨行 | 新命令是 **L1–L2 局部实现**，不是 IDEA 完整 line-edit 语义；缺 multi-range/矩形边界、transpose、unwrap/remove、paste history、virtual space、smart Enter/Backspace | 先冻结 command contract（selection boundary、line endings、undo unit、readOnly/no-op），再实现多选区/选项和跨平台 keymap；每命令加 golden fixture |
| Completion orchestration | `syntaxContext.ts` 优先使用已可用 Lezer tree，未 ready 时走单行 lexical fallback；`lspCompletion.ts` 抑制字符串/注释中的非显式 word completion，plain typing 80ms debounce，trigger chars immediate，处理/展示上限 200，保留 server sort/resolve/snippet/additional edits；`CodeMirrorHost` activate delay 100ms | 性能和侵入性达到 **L2 baseline**，但不是 IDEA Smart/Type-matching；上下文节点名跨语言不稳定，fallback 不覆盖 raw/interpolation/nested comment；无 request reason、truncation 状态、type/visibility/context filter 和重复调用模式 | Java/TS/Python/Go/Rust fixture 矩阵；p95 typing/IPC/paint 指标；显式/trigger/typing 三种 reason；取消代际、`isIncomplete`、cap 截断提示、provider unavailable 语义 |
| Template / statement | Live template 在字符串/注释内抑制，单字符前缀不抢 popup；postfix 仍用 `expr.abbr` 行级正则；`completeCurrentStatement` 仍按行尾/括号/关键字启发式补文本 | 主路径可用但为 **local/text-driven L1–L2**；缺类型/语法上下文、变量函数、import shortening、语义 statement engine | parser/provider-aware context contract；变量生命周期和 Tab stop；Java/TS 语义 postfix、statement/surround/generate fixture |
| Capability lifecycle | `useWorkspaceLspSession` 在收到全空 capability 时保留已有非空摘要，避免状态抖动；watcher 过滤 build/dependency 目录，树刷新 200ms debounce | 解决了响应抖动和 burst refresh，但可能把旧 capability 带入真正的新 session；目前缺 session generation/provenance；性能测试以合成/单测为主 | 新 session 明确 reset；capability provenance + generation；真实大工作区/外部 watcher/重启 provider 压测 |
| CodeMirror memoization | `CodeMirrorHost` 使用自定义 comparator，比较文档、主要装饰数组、codeStyle 和 flags；但未比较 `debugInlineValues`，且忽略多数 callback identity。被 memo 跳过的 render 不会刷新组件内 callback refs | 可减少重建，但现有 inline debug value 可能在其它比较字段不变时停留旧值；callback 只有在父层保证语义稳定或触发其它 render 时才安全，未来新增行为 prop 更易 stale | 先补 `debugInlineValues`/全部行为 prop matrix，再用稳定 event callback 或显式 comparator contract；覆盖 unmount/rapid switch/stale callback |
| Full Line completion | Code Workspace editor 路径无 ghost text/local model/部分接受；Terminal FIM 独立 | **L0**，保持与 popup completion、AI selection、Terminal FIM 分账 | P2 Java 本地模型与隐私/硬件降级 fixture，见 §8.2 A4 |
| Inspection/refactor/navigation | provider diagnostics/profile、raw WorkspaceEdit preview/exclude、revision/root guard；Recent/Changed/Last Edit、双 editor group | 事务保护有效，但无 PSI/index/CFG/conflict-aware refactor；历史与布局仍受单点/双组限制 | J1–J3 semantic contract；Recent Locations context model；递归 layout tree 后再做 P2 |
| Editor chrome / X | breadcrumbs、sticky lines、inlay/semantic/Git/coverage/debug gutter 有实现；coverage 为 LCOV/JaCoCo 展示；Build/Run/Debug/Test 代码归 X | 有效增量不提升语义等级；coverage 不是 Run with Coverage 模型 | 按单项 fixture 保持 L2；X 轨道按 §12 独立验收 |
| 架构可演进性 | `CodeWorkspaceTab.tsx` 约 10.6k 行，命令、状态、LSP、文件、执行和 UI 装配仍集中 | 继续直接加入口会放大 context/keymap/state 竞态；近期新增模块尚未全部接入生产单一来源 | E0.2 先抽 controller，并以依赖图/聚焦测试而非行数作为完成标准 |

**规范优先级：** §2、§8.2、§8.3 与 §12 是当前目标/状态/待办的权威来源。§3–§7、§9–§11 保留设计细节和历史交付记录；若出现“全部已交付”“coverage 缺失”“约 4.4k 行”等旧结论，以本节审计为准。

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
5. **现有 Git Manager 保持独立**，底部不设 Git tab；它按 X 轨道独立验收，状态栏分支段作为编辑器入口。

---

## 5. 功能模块详细设计

### 5.1 编辑器核心增强（P0）

#### 5.1.1 查找 / 替换（编辑器内）

- 引入 `@codemirror/search`，替换默认面板为自绘 UI（与 taomni 主题一致），支持：大小写/整词/正则、替换单个/全部、匹配计数、`F3`/`Shift+F3` 循环。
- 选中文本后按 `Ctrl+F` 自动填充查询词（IDEA 行为）。

#### 5.1.2 编辑命令补齐（纯前端，CodeMirror commands）

`Ctrl+/` 行注释、`Ctrl+Shift+/` 块注释、`Ctrl+D` 复制行（IDEA 语义）、`Ctrl+Y` 删除行、`Alt+Shift+↑/↓` 移动行、`Ctrl+W`/`Ctrl+Shift+W` 扩大/缩小选区（优先 LSP selectionRange，回退 syntaxTree，见 §5.2.13）、`Ctrl+G` 跳转行:列。`200d4627` 新增 `Ctrl/Cmd+Shift+J` join lines、selection 主区 sort/reverse lines；它们当前是局部 command，不应被描述为完整 multi-range/IDEA line-edit 语义。冲突处理见 §7，完整契约见 §8.3.4。

#### 5.1.3 诊断呈现升级

- 引入 `@codemirror/lint` 的 setDiagnostics 通道：波浪线 + gutter 图标 + 右侧 overview ruler 色条（error 红 / warning 黄）。
- 悬停诊断与 hover 信息合并为单浮层（先诊断后文档）。
- 诊断行 gutter 显示灯泡（有可用 Code Action 时），衔接 §5.2.9。

### 5.2 语言智能与代码洞察（P0/P1，本方案核心）

对标 IDEA 日常使用频率最高的语言功能，采用 **provider-first、semantic-evidence-gated** 的路线：LSP 提供跨语言基线；Java P1 为 completion/inspection/navigation/refactor 建立可持久化声明/引用索引与必要的语义分析。没有标准 LSP 映射的 IDEA 能力必须明确使用本地 engine、provider extension 或标为 unavailable，不能用同名按钮伪装。

#### 5.2.0 设计原则：capability 驱动的功能开关

- LSP server `initialize` 返回的 `ServerCapabilities` 由后端缓存，并随 `LspDocumentStatus` 附带 `capabilities` 摘要（如 `{ completion: true, callHierarchy: false, … }`）下发前端。
- **UI 按能力开关**：server 不支持的功能，菜单项置灰 + tooltip 说明（沿用现有 installHint 机制），绝不静默失败或伪造结果。
- 每个请求带取消语义（编辑/切换文件即作废旧请求），防止过期结果回填。

#### 5.2.1 功能 → engine / 协议映射总表

| IDEA 功能 | 快捷键 | engine / 协议 | UI 载体 | 优先级 |
|-----------|--------|---------------|---------|--------|
| 基础补全 | Ctrl+Space / 输入触发 | `textDocument/completion` + `completionItem/resolve` | 编辑器补全浮层 | P0 |
| Smart / Type-matching Completion | Ctrl+Shift+Space / 重复调用 | provider 候选 + type/context filter；Java index 兜底 | 同一补全浮层，显式显示 mode/scope | P0 |
| Full Line / Inline Completion | Tab / Ctrl+Right / End 接受整段/词/行 | 本地模型 runtime + semantic/import/filter service（IDEA Ultimate bundled-plugin 参考） | editor ghost text，可与 popup 同步 | P2 |
| Live / Postfix Templates | Tab / Ctrl+J | 本地 template engine + provider type/context/import service | 补全浮层 + template 变量导航 | P0 |
| Complete Statement / Surround / Generate | Ctrl+Shift+Enter / Ctrl+Alt+T / Alt+Insert | language-aware local engine 或 provider extension/Code Action | editor action / popup / preview | P0 |
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
| Inspection / Data-flow | 自动 / Analyze 菜单 | provider diagnostics + Java inspection/index engine | editor + Problems + Analysis | P1 |
| Structural Search / Replace | —（由 keymap 配置） | parser/query engine + index；不能退化为 regex | 独立 search tool window | P2 |
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
- **当前边界（v4.30）**：上述已实现条目只覆盖 basic popup completion 加性能护栏（上下文抑制、80ms 防抖、trigger 即时和 200 项 cap）。Smart/type-matching、第二/第三次调用的候选扩展、class/package exclusion/priority、type-aware postfix、language-aware statement completion、Surround/Generate 仍按 §8.2 待办执行；Full Line 是独立的 P2 inline/model 工作流，当前为 L0，不能由 LSP popup completion 推导完成。

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

矩阵的工程含义：**P0 六件套（补全/签名/文档/重命名/跳转/CodeAction）是跨语言目标，而不是“全部主流 server 已可用”的承诺**；每个 server 的 capability、scope、freshness 和 completeness 独立记账。调用/类型层级、inlay hints 在部分语言降级隐藏——这正是 capability 驱动开关（§5.2.0）的设计原因。

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

### 5.7 集成终端（X，IDE 伴随能力）

- 底部 dock 的 Terminal tab，内嵌现有 `TerminalPanel`（本地 PTY），**cwd 默认为当前文件所在根目录**。
- 支持多终端实例（左侧竖条列表或下拉切换），"+" 新建时可选根目录。
- 定位：工作区附属终端，不进顶级 tab 栏、不参与会话管理；生命周期随工作区 tab 关闭而销毁（关闭前确认）。
- 联动：文件树/编辑器 tab 右键"在终端中打开"→ 激活底部终端并 cd；Run/Tasks（§5.9）输出复用此处实例。

### 5.8 Git 编辑器内呈现（P1）

- **Gutter 变更标记**：buffer 内容 vs HEAD 版本（`gitBlobPair` 已有能力）做 diff，gutter 渲染 新增(绿条)/修改(蓝条)/删除(红三角)；防抖 500ms 随编辑更新。
- 点击标记弹出内联 diff 浮层：旧文本 + [回滚此块] [复制旧文本] [在 Git 管理器中查看]。
- **Inline blame**（可开关，默认关）：当前行行尾灰字 `author, 3 months ago · commit summary`；按需 `git blame -L <line> --porcelain`，行级缓存，保存后失效。
- 状态栏 Git 段：当前文件所属 repo 分支 + ahead/behind；点击打开 Git 管理器。

### 5.9 Run / Tasks（X，IDE 伴随能力）

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
- 当前代码闭环：Run 配置编辑器支持命名副本、program arguments、VM/runtime options、working directory、显式 env、dotenv 文件、Before launch 依赖选择和按源文件持久化；Run 与 Debug 共享同一配置选择。仓库共享配置位于 `.taomni/run-configurations.json`，schema 见 [`claudedocs/run-configurations.schema.json`](run-configurations.schema.json)，支持 v1 `runs` 迁移、v2 `configurations`、templates、Linux/macOS/Windows overrides、provider/project 可移植引用、原子诊断、debug-only 条目和嵌套 compound Run/Debug（顺序/并行/失败策略）。Compound Debug 为每个子配置维护独立 DAP 会话、断点/异常过滤器/栈/变量，并提供子会话选择和组级 Stop/Restart。Tests 面板已消费有界 JUnit XML 结果协议并支持汇总、失败详情、定位和重跑；coverage 已有 LCOV/JaCoCo 报告扫描、gutter 与面板展示，仍缺 Run with Coverage 的采集/配置/合并模型、非 JUnit provider 统一协议和完整 provider/adapter 矩阵；自定义命令继续作为特殊启动需求的兜底。

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

### 5.12 AI 集成（X，IDE 伴随能力；复用既有 ai/agent 能力）

- 编辑器选区浮动工具条（复用 `SelectionToolbar` 模式）：解释 / 修复诊断 / 生成注释 / 按指令改写。
- 改写类动作产出 diff 预览（复用 DiffPane），确认后应用到 buffer。
- 右侧 AI tab：带当前文件/选区/诊断上下文的会话（复用 chat store）；打通 Claude Code bridge 工作区级会话（工作区根作为 cc cwd）。
- 边界：只定义**入口与上下文注入协议**，不重造 AI 面板。

### 5.13 远程工作区（X，探索项）

- 动机：taomni 本质是远程工作台，"打开 SSH 主机目录为 Code Workspace"是对标 VS Code Remote 的差异化能力。
- 方向：`workspace.rs` 文件操作抽象为 `WorkspaceFs` trait（local / sftp 两实现）；LSP 远程运行（SSH exec + stdio 转发）复杂度高，首期远程根只提供**编辑/搜索/Git**，LSP 标注不可用。
- 本期约束：新代码不写死本地路径假设（路径处理集中化），为 trait 化留缝。**不在本方案内实施。**

---

## 6. 技术架构设计

### 6.1 前置重构（M0，硬前提）

`CodeWorkspaceTab.tsx` 当前约 10.6k 行；树数据、LSP session、Git snapshot、导航和文件动作已有 hook 抽取，但 action/style/completion/X-track 装配仍集中。继续堆功能会放大竞态，重构目标如下（目标结构不是本轮代码已完成的事实）：

```
src/components/editor/
  CodeWorkspaceTab.tsx          // 当前约 10.6k 行；保留装配，按 action/style/navigation/X-track 职责继续拆分
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

- 目标是以 `workspaceActionRegistry.ts` 的 `WorkspaceActionDefinition` 为唯一 runtime truth；当前 `workspaceCommands.ts` 仍是旧执行链，必须按 §8.3.1 先做 migration adapter，再删除第二份 metadata/handler。
- 与现有 `menubar/commands.ts`（AppCommand）对接：工作区激活时把 registry snapshot 桥接进应用菜单动态区，并在 action state 变化时刷新，而不是只在激活时读取一次。
- 快捷键分发：工作区根节点统一 keydown 捕获，按结构化 `when` 上下文（modal/completion/editor/tree/terminal/workspace）路由；CodeMirror keymap 也要通过同一 binding resolver 生成或明确标记为内部编辑命令。

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
| workspace.rs 规划 | `workspace_find_editorconfig_chain` / `workspace_stat_paths` | 从文件路径向父目录查找 `.editorconfig` 并返回 canonical path + mtime/hash；resolver 负责解析/合并，后端不返回未经校验的“最终 style” |
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
- code style override、EditorConfig chain fingerprint、keymap scheme/disabled actions 和 completion privacy/performance preferences 必须有独立 schema/version；不得把它们塞进旧 `RecentWorkspace` 的无版本 JSON。
- LSP capability summary 只缓存当前 session generation；workspace 重开或 provider 重启先清空，再接受新 initialize/dynamic registration。

存储沿用现有模式：UI 偏好走 localStorage，工作区结构走 SQLite。

---

## 7. 快捷键方案（IDEA keymap 为基准）

> 本表保留默认 binding 的设计/实现历史，用于说明预期肌肉记忆与已知冲突；它不是可编辑 Keymap 已完成的证据。当前 `KeymapCheatSheetDialog` 仍是固定速查/执行面板，`workspaceActionRegistry` 也尚未接管 runtime dispatch；权威目标、schema 和迁移步骤见 §2.5、§8.2 E0/E2 与 §8.3.1/§8.3.3。

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
| 参数信息 | Ctrl+P | IDEA 默认键；当前 CodeMirror/command registry 已绑定，scheme/context 统一仍归 E0/E2 |
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

目标约束：所有快捷键最终经 §6.2 的统一 action/when-context 路由。当前 workspace 与 CodeMirror binding 仍分散硬编码；E0/E2 必须交付 IDEA platform defaults、可编辑 scheme、冲突检测、迁移/恢复默认，并让其他 preset 通过同一 schema 扩展。

---

## 8. 实施计划（里程碑）

> M0–M11 是既有实施序列，完成计数只表示对应历史清单出现过代码入口，不是 v4.30 的能力等级或下一步优先级。下表已按当前边界标出混合项：编辑器部分仍按原 P0/P1/P2 追溯，Terminal/Build/Run/Test/Debug/AI/Remote 等统一标 X；权威等级与顺序见 §2.5、§2.9 和 §8.2。

| 里程碑 | 内容 | 规模 | 状态 |
|--------|------|------|------|
| **M0 前置重构** | 组件拆分 + codeWorkspaceStore + 命令系统骨架 + 底部 dock 容器（References 迁入） | M | 🔶 功能前提已交付；树数据、LSP session、Git snapshot、导航与文件动作已抽 hook，但当前装配组件约 10.6k 行；按 §8.2 E0.2 继续按职责拆分 |
| **M1 编辑器智能·上（P0）** | 查找替换、LSP 补全（含 auto-import）/签名/快速文档/格式化、诊断呈现升级、Problems 面板 | L | ✅ 9/9 |
| **M2 导航与搜索（P0）** | Find in Files（后端搜索模块 + 面板）、Search Everywhere（含 Classes/Symbols）、Go to File/Class/Symbol、Recent Files、导航历史、Outline + 结构弹窗、类型/实现跳转 + peek、重命名、Code Actions、树右键/键盘 | L | ✅ 14/14（拖拽仍为 P1） |
| **M3 编辑器布局（历史 P1）+ Terminal/Run（X）** | 分屏、tab 管理/预览 tab、面包屑、集成终端、Run/Tasks | L | ✅ 历史清单代码入口已交付 |
| **M4 语言智能·下 + Git（P1）** | 调用层级、类型层级、用法高亮、inlay hints、智能选区(LSP)、Git gutter、inline blame、状态栏分段、持久化增强 | L | ✅ 10/10（代码已交付；真机冒烟后置） |
| **M5 高级编辑（历史 P2）+ AI/Remote（X）** | 本地历史、AI 集成入口、语义高亮、TODO/书签（可选）、远程工作区 spike | M–L | ✅ 5/5 历史代码入口已交付；各项按当前轨道重新验收 |
| **M6 Java 基础对齐（P0，§11 A+B）** | jdtls 初始化 `java.*` 设置全集（含 Lombok/autobuild/organizeImports/codeGeneration）；大文件性能（大文件降级守卫、增量 diff 提速） | M | ✅ 代码已交付（`c35d963` A + `4a06f91` B；真机冒烟后置；ChangeSet→LSP 全量重写按风险显式后置，见 §11.B） |
| **M7 全项目诊断（历史 P1）+ Build integration（X）** | 全项目诊断（先 spike，后端聚合命令 + Problems 面板切换）；构建集成增强（依赖树、生命周期/任务树、项目重载、模块视图） | L | 🔶 F 构建集成 + C 全项目诊断基础设施代码已交付（`ba037ac` 重载 + `a0d209c` 任务树 + `f9abab5` 依赖树 + 模块视图 + `083999f` 全项目诊断后端 + 前端 Problems 切换）；C 的诊断刷新由 event 改为轮询（Windows 链接约束，见 §11.C），命中语义待用户真机 spike |
| **M8 Test/Debug 基建（X，§11 Bundle+E+D1–D2）** | jdtls bundle 基建（java-debug/java-test 加载与探测）；测试集成（探测 + run-only + JUnit 结果树）；**通用 DAP 内核 + 适配器注册表（dap.rs，语言无关）+ Java 适配器（首个插入）** | L | ✅ 代码已交付：Bundle 基建（`4929467`）+ D1 DAP 内核（`b432f0f`）+ D2 Java 适配器（`9edb7b7`）+ E 测试探测/terminal 运行与 JUnit XML ingestion（`daa20fd`）；真机冒烟后置（jdtls 已在 PATH，bundle jar 待配置） |
| **M9 Debug 主线 + 收口（X，§11 D3–D5+E）** | 断点/单步/调用栈、变量/监视/求值、条件断点/异常断点/热重载、data breakpoint/watchpoint；debug-test；真机冒烟回填 | XL | ✅ 代码已交付：D3 断点/单步/调用栈/当前行 + D4 变量/监视/console（`b141bad`）+ D5 条件/logpoint/异常断点/热重载 + D5.2 data breakpoint/watchpoint（`596759d`）+ D5.3 conditional exception filters（`1f2d93b`）+ D5.4 exception path rules（`4510aa2`）+ debug-test；结构化测试结果树已改为独立 JUnit XML ingestion（`test_results.rs` + TestsPanel 汇总/失败详情/定位/重跑）；真实 adapter 与三端真机冒烟由用户统一验证 |
| **M10 Java Build/Run 闭环（X，§11.G）** | 主类发现与普通运行、Maven/Gradle/单文件启动、多模块 task model、Build/Rebuild、wrapper 跨平台与测试运行修复 | M | ✅ 代码已交付：普通 Run 不依赖 java-debug；顶部 `Ctrl+F9` / `Shift+F10`、Run 主类列表、Build/Rebuild、多模块任务与聚焦 Rust/Vitest 覆盖；真实 Maven/Gradle/JDK 工程冒烟待回填 |
| **M11 Execution（X）+ Analysis（Editor 历史 P1）** | Build 依赖拓扑执行；稳定 module/source-set/language-level/compile-artifact 基线；Run/Debug 共享命名配置、参数/env/dotenv/Before launch；仓库共享配置/模板/平台覆盖；嵌套 compound Run/Debug 与多 DAP 子会话；provider-backed refactor/inspection/Analysis；semantic snapshot freshness；诊断元数据与 code-action kind 透传；结构化 JUnit 测试结果 | M | 🔶 基础代码闭环：coverage 报告展示已补；仍缺真实多模块 import、Run with Coverage、完整 adapter、自有 index/native data-flow 与三端真机。执行相关项按 X 轨道记账 |

依赖关系：M0 是一切前提；M1/M2 内部可并行（后端 LSP 扩展与搜索模块独立）；M3 依赖 M0 的 dock 容器；M4 的层级面板依赖 M0 dock + M2 的 LSP 请求管道。**M6 两条线（A/B）互相独立可并行，且不依赖 M1–M5 之外的新前提；M7 的全项目诊断（C）依赖 M6-A 的 `autobuild`，构建增强（F）独立；M8 的测试/调试依赖 Bundle 基建，DAP 内核（D1）可与 M7 并行起步；M9 的 debug-test 依赖 M8 的 D1–D2；M10 普通 Run 只依赖 M3 PTY + workspace SDK，不依赖 DAP/bundle。** 每个里程碑独立可发布、可验收。M6–M11 的完整拆分见 §11。

### 8.1 进度明细（勾选清单）

> 更新于 2026-08-15（v4.30）；除既有 IDEA 2026.2/Java/工程拓扑/DAP/分析门禁外，本轮复核了 `EffectiveCodeStyle` wiring、EditorConfig parser、ActionRegistry catalog、join/sort/reverse commands、syntax-context completion gating、completion throttle/cap、CodeMirror memoization、tree refresh debounce 和 LSP capability preservation。M0–M5 已由 PR #361 合入 `main`；当前收口位于 `feat/code-workspace-idea-parity`。`200d4627`/`2134e783` 的单测与构建证据不等于三端发行包或 IDEA L3 语义证据：Linux/macOS/Windows 真机冒烟、真实 build import/output、adapter initialize/DAP trace 和大工作区性能采样仍由后续门禁回填。完成度按本节拆分条目计数，部分完成项在下方 v4.30 增量记录中显式标记。

**M0 前置重构 — 🔶 清单项齐，壳体继续瘦身中**

- [x] CodeMirror host 抽取（`CodeMirrorHost.tsx`）— `042d03f`
- [x] 底部 dock 容器 + References 面板迁入 — `09108e2`（`4766f43` 起改为面板常驻挂载）
- [x] `FileTreePane` 展示边界抽取（工具栏、视图/缩放控制、语言服务器面板）+ 组件测试 — `acff8cf`
- [x] `codeWorkspaceStore`（按 `workspaceInstanceId` 分片 UI chrome / openOrder / activeKey / markdownModes）+ `EditorGroup` + `WorkspacePopupsHost` + `codeWorkspaceModel` 纯函数抽取 — `3ddab1b`；**壳体 4674→4113 行**
- [x] `ProjectTree` 控制器抽取（`renderEntries`/`renderFlatEntries`/根与 loose 行/git 徽标）+ 纯函数入 model — `43e5deb`
- [x] buffer / tree chrome / LSP file map 入 store（`openFiles`、`lspFiles`、filter/view/selection/expand keys）+ `MarkdownPreview`/`workspaceChrome` 剥离 — `eb7997b`；**壳体 4113→~3659 行**；目录 listing 缓存（directories/compact/flat）与命令注册表仍在壳内
- [x] `workspaceCommands.ts` 旧注册表、when 判定与统一快捷键分发；Search Everywhere 增加 Files / Actions 双入口 + 测试 — `b3c3d35`；**仅为历史代码入口，目标 runtime truth 迁移见 E0.1**
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
- [x] Go to File（当前主键 `Ctrl+Shift+N`，camelCase 模糊匹配；双 Shift 打开 Search Everywhere；早期 `Ctrl+P` alias 已改为 IDEA Parameter Info）— `972ad00` + `8143aa9`；SE 六分组（All/Classes/Files/Symbols/Actions/Text）— `4040d6f`
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

**M3 编辑器布局（历史 P1）+ Terminal/Run（X）— 历史代码入口已交付**

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

**M5 高级编辑（历史 P2）+ AI/Remote（X）— ✅ 5/5 历史代码入口已交付**

- [x] 本地历史（快照存储 + 时间线 diff + 恢复）— `2b78171`
- [x] AI 集成入口（选区工具条 + diff 应用 + 右栏会话）— `0571bd9`（rewrite/fix preview + 全局 ChatDrawer `attachToComposer`）
- [x] 语义高亮（semanticTokens full + 增量协商、缓存、delta 校验与 full 回退）— `ce4e101` + `420455e`
- [x] TODO / 书签面板（打开文件标记扫描、F11 行书签、工作区持久化与关闭文件重开跳转）— `63a4240`
- [x] 远程工作区 `WorkspaceFs` trait spike（异步 trait、本地实现、路径/符号链接越界防护）— `0d14e06`

**横切事项**

- [x] 交互原型交付（`claudedocs/prototype/code-workspace-prototype.html`）
- [x] 签名帮助键位沿革：`f4d9c15` 初始使用 Ctrl+Shift+Space；当前代码以 IDEA 默认 `Ctrl+P` / `Mod-P` 为主并保留 `Mod-Shift-Space` alias，Go to File 当前主键为 `Ctrl+Shift+N` — `8143aa9`
- [x] 代码与自动化复核（2026-07-12 v2.8）：全量 Vitest **159 文件 / 1267 项**通过（`--testTimeout=15000 --maxWorkers=4`）；`pnpm build` 通过；全量 `cargo test` 通过（lib **748 passed / 11 ignored**，其余 integration/doc tests 全绿）
- [x] **自动化门禁恢复全绿（2026-07-25）**：全量 Vitest **164 文件 / 1304 项**通过；`pnpm build` 通过；全量 `cargo test` 全绿（lib **892 passed / 0 failed / 11 ignored**，其余 integration/doc tests 全绿）。原 v2.10 记录的 3 例 Windows `rdp::cliprdr::uri_list_*` 前导斜杠断言失败已修（测试辅助 `uri_path` 误对 Unix 风格路径剥前导斜杠，生产 `uri_list_to_paths` 保留斜杠属有意行为）；顺带修复 v2.10 后由 `11382ec` 引入的同类 Windows 失败 `chat::acp` grok 图片 `file://` URI 断言（`\\?\` 前缀不对称比较）。两处均只改测试、生产代码零改动 — `d2861f4`
- [x] WorkspaceEdit §5.2.9 三态规则收口（open-clean 应用后保存、open-dirty 保持 dirty、未打开写盘 + hash 预检）— `workspaceEditApply` + `5d87203`
- [x] WorkspaceEdit 事务 undo/redo：普通文件快照、编码/BOM 元数据、跨文件单步回放与 tab/group 恢复；失败时保留原历史。
- [x] 非 UTF-8 编辑闭环：Rust `encoding_rs`/`chardetng` 检测与无损写入、前端状态栏 Reload/Convert 入口、浏览器 UTF-16 stub；二进制与 lossy legacy 保存明确拒绝。
- [x] Safe Delete Symbol：Alt+Delete/右键/命令入口，引用面板预览与确认，声明/引用跨文件删除作为一个事务；无可靠 LSP 范围、library source、unresolved reference 或 workspace 外路径时标记 incomplete 并拒绝猜测/写入。
- [x] Build/Run/Debug 配置与分析代码闭环：Build 目标依赖拓扑、失败即停；命名 Run 配置副本、program/VM args、cwd、env、dotenv、Before launch；Run/Debug 共享 active selection；嵌套 Compound Run/Debug 和 grouped multi-session DAP；标准 function/method、data breakpoint/watchpoint、adapter-advertised exception filters、capability-gated exception path rules 与 `breakpointModes` 跨同 adapter 子会话同步；data breakpoint discovery/`canPersist` scope + `dataBreakpointInfo.mode`，source mode 的 adapter-scoped 持久化，exception filter 的 `filterOptions.mode`，exception filter 默认值/条件持久化/`filterOptions` 兼容，`exceptionOptions` path/negate/四种 break mode，以及 configurationDone 前恢复、启停、Mute/Remove All、binding/unsupported 状态；按 CodeActionKind 的 provider-backed extract/inline/change-signature/move 入口；provider semantic snapshot freshness/coverage 与落盘前过期或 workspace 外路径拒绝；持久化 inspection profile、诊断 metadata、Analysis 面板与 Problems 展示变换（provider 原始诊断仍用于 quick fix）。
- [x] **v4.15 D5.2 自动化门禁**：`dapDebugModel`、`useCodeDebugSession`、`DebugPanel` 聚焦回归通过；单 worker 全量 Vitest **260 文件 / 2210 tests**、`pnpm build`、TypeScript 编译通过；F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] **v4.16 D5.3 自动化门禁**：conditional exception filters 的 model/session/panel 聚焦回归 **88 tests** 通过；单 worker 全量 Vitest **260 文件 / 2214 tests**、`pnpm build`（**4549 modules**）与 TypeScript 编译通过；F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。全局 qa-ui-auto gate 仍有 F5.2 等既有 baseline 漂移，本阶段未重置无关基线；真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] **v4.17 D5.4 自动化门禁**：`exceptionOptions` model/session/panel 聚焦回归 **92 tests** 通过；单 worker 全量 Vitest **260 文件 / 2218 tests**、`pnpm build`（**4549 modules**）与 TypeScript 编译通过；qa-ui-auto lint、F25.1 controls/catalog 定向 audit 无 actionable gap，`TC-auto-F25-1` browser dry-run 通过。未修改 Rust，故未重复 Cargo；全局 qa-ui-auto 仍有 137 个仓库既有 orphan selector 且本阶段未重置无关 baseline；真实 adapter 与 Linux/macOS/Windows 真机留待用户执行。
- [x] **v4.18 D5.5 自动化门禁**：`breakpointModes` model/session/panel 聚焦回归 **98 tests** 通过；全量 Vitest **260 文件 / 2224 tests**、TypeScript 编译与 `pnpm build`（**4549 modules**）通过；qa-ui-auto lint、F25.1 controls/catalog 定向 audit 无 actionable gap，新增 source/data/exception mode 控件均 capability-gated 且 optional。`TC-auto-F25-1` browser dry-run 因本地 Vite 服务未启动而未执行（按 qa-ui-auto 约束待用户许可后运行）；真实 Java/JS/Python/Go/Rust/C++ adapter 矩阵与 Linux/macOS/Windows 真机仍留待用户执行。
- [x] **v4.19 D5.6 自动化门禁**：data breakpoint `bytes`/`asAddress` 的 model/session 持久化与能力门控、DebugPanel expression/address/byte-range 创建入口、LSP field/property declaration context-menu 入口及回归覆盖已完成；聚焦 Vitest **5 files / 114 tests**，全量 Vitest **261 files / 2232 tests**，TypeScript 编译与 `pnpm build`（**4550 modules**）通过；qa-ui-auto lint **130 cases / 0 errors**、F25.1 audit 无 actionable gap、catalog check 通过。lint 仍报告仓库既有 **137 个 orphan selector**，未在本阶段修改 baseline；`TC-auto-F25-1` browser dry-run 因本地 Vite 服务未启动而未执行（按 qa-ui-auto 约束待用户许可后运行）；真实 Java/JS/Python/Go/Rust/C++ adapter 矩阵、地址/范围语义与 Linux/macOS/Windows 真机仍留待用户执行。
- [x] **v4.20 D5.7 自动化门禁（本阶段）**：instruction breakpoint 的 model/session 持久化与 capability gate、`setInstructionBreakpoints` 全量替换、adapter-scoped opaque reference + signed offset identity、condition/hitCondition/mode、configurationDone 前恢复、Mute/Remove All、compound 隔离、binding event、终止/launch failure 清理和 stale-response guard 已完成；DebugPanel 创建/编辑/启停/删除/unsupported/binding 状态及窄 dock 换行布局已覆盖。聚焦 Vitest **3 files / 113 tests**、全量 Vitest **261 files / 2243 tests**、TypeScript 编译与 `pnpm build`（**4550 modules**）、qa-ui-auto lint **130 cases / 0 errors**、F25.1 audit 无 actionable gap 及 catalog check 已通过。lint 的 **137 个 orphan selector** 为仓库既有基线；browser dry-run 未启动服务，真实 adapter/CPU 指令语义与 Linux/macOS/Windows 真机继续留待用户执行。
- [x] **v4.21 D5.8 自动化门禁（本阶段）**：`readMemory`/`writeMemory`/`disassemble` 的 model/session capability gate、bounded response parsing、hex/base64 conversion、session switch/termination stale-response guard 和 DebugPanel memory/disassembly tool surface 已完成；聚焦 Vitest **3 files / 120 tests**、全量 Vitest **261 files / 2250 tests**、TypeScript 编译与 `pnpm build`（**4550 modules**）、qa-ui-auto lint **130 cases / 0 errors**、F25.1 audit 无 actionable gap 及 catalog check 已通过。lint 的 **137 个 orphan selector** 为仓库既有基线；browser dry-run 未启动服务，真实 adapter 的地址/权限/partial-write/symbol/source mapping 语义与 Linux/macOS/Windows 真机继续留待用户执行。
- [x] **v4.22 D5.9 adapter contract fixture 门禁（本阶段）**：新增 Java/JavaScript/Python/Go/Rust/C++ 六项 fixture，覆盖当前注册 adapter id（`java`、`node`、`python`、`delve`、`lldb`）及 Rust/C++ 的共享 lldb 变体；contract 评估器只读取 initialize capability，不按语言或 adapter id 猜测 memory/disassembly 支持。回归固定 opaque memory reference、signed byte offset、read range、显式 `allowPartial:false`、instruction offset/count、symbol/source mapping、sourceReference 和 breakpoint mode applicability；合成 baseline/advertised profile 均有测试。聚焦 Vitest **1 file / 5 tests** 与 TypeScript 编译已通过；synthetic profile 不是真实 adapter 证据，真实 initialize/DAP trace、地址宽度/权限/partial-write/模式语义和 Linux/macOS/Windows 真机仍留待用户执行。
- [x] **v4.23 D5.10 project model baseline（`3dde3e76`）**：`workspace_execution` 为每个 provider manifest 生成稳定 `ProjectModel.moduleId` 与 `ModuleModel`，发现 production/test/generated source roots，提取 Cargo/Go/Python/Node/Maven/Gradle/sbt/.NET/CMake/SwiftPM 声明 language level；build target 关联 module 并声明 provider-specific `CompileArtifact`。artifact 不猜测 provider output path：工具可用但尚未执行真实 build 时为 `pending-provider-output`，配置工具缺失时为 `blocked` 并保留原始诊断；Maven `${java.version}` 属性引用有确定性覆盖。Rust `workspace_execution` **12 tests**、TypeScript 编译通过。明确边界：当前仅单 manifest→单 module，尚无 Maven/Gradle 多模块 import、active profile/source-set override、facet/依赖/SDK 图、真实 build output ingestion、background/incremental/single-file compile 或 Run/Debug module/artifact selection；三端真机继续由用户执行。
- [x] 合并门禁 8 例 Windows 失败已修复（clipboard URI ×4、pushd ×1、git 根 ×3）— `f6c1f36`
- [x] **v4.30 新提交聚焦测试**：`codeStyleModel.test.ts`、`editorConfigParser.test.ts`、`workspaceActionRegistry.test.ts`、`workspaceEditorCommands.test.ts` 覆盖模型/parser/catalog/line-command 基础契约；`syntaxContext.test.ts`、`lspCompletion.test.ts`、`liveTemplates.test.ts`、`editorPerformance.test.tsx`、`useWorkspaceFileActions.test.tsx` 覆盖上下文抑制、debounce/cap、memoization 和树刷新防抖。它们证明局部行为，不替代 runtime integration、Tauri 或三端证据。
- [ ] **⚠ 真机验证欠账（由用户执行）**：M0–M5 能力仍以单测/构建为主；`pnpm tauri dev` 冒烟结果回填本节
- [ ] ⚠ 装配层继续按职责拆分：树数据、LSP session、Git snapshot、导航与文件动作 controller 已抽离；当前 `CodeWorkspaceTab.tsx` 约 10.6k 行，下一步按 §8.2 E0.2 抽 action、code-style、completion orchestration 与 X 轨道装配，不再以 <400 行作为单一完成条件。
- [ ] ⚠ 历史未完成项（已由 §8.2 与 §12 按新轨道重排）：Maven/Gradle 多模块 import snapshot、active profile/source-set override、依赖/facet/SDK 图、真实 build output→artifact 回填、Run/Debug module/artifact selection、single-file/incremental/background compile；PSI/stub index、inspection/data-flow；watcher/编码/事务 undo 三端真机验收、语义/token 合并、目录/symlink undo；树/tab 拖拽停靠；`WorkspaceFs` 生产只读链路

**v4.30 新开发复核增量（`200d4627` + `2134e783`）**

- [~] `EffectiveCodeStyle` 模型与 CM/formatter wiring：已交付 `codeStyleModel.ts`、CodeMirror compartment 重配置和 formatter options；尚未交付 EditorConfig 生产 resolver、逐字段 provenance、持久化和保存 normalize。
- [~] EditorConfig parser：`editorConfigParser.ts` 及单测已交付；尚未接入 workspace root/父目录查找、`root=true` 停止、nearest-to-farthest merge、文件变更失效和错误诊断。
- [~] ActionRegistry：metadata 类型、静态 catalog、注册/搜索单测已交付；运行时仍由 `WorkspaceCommand[]` dispatch，catalog orphan/mismatch、结构化 `when`、动态 enabled/disabled reason、订阅和冲突图待收口。
- [~] 编辑命令：`joinLines`、`sortLines`、`reverseLines` 及 `Mod/Ctrl-Shift-J` 已交付；仅主选区、无 IDEA 排序选项/多选区/transpose/unwrap 等完整语义。
- [~] Completion 响应性：语法节点/词法 fallback、字符串/注释抑制、plain-typing 80ms debounce、trigger 即时、200 项 cap、CM 激活延迟与树刷新 debounce 已交付；缺 request reason、候选截断可见性、Smart/type-matching/重复调用和真实 p95 证据。
- [~] LSP capability 生命周期：空摘要保护和 build/dependency watcher 过滤已交付；需 session generation/provenance，避免新会话继承旧 capability，并补 provider 重启/大工作区压测。
- [~] CodeMirror memoization：自定义 comparator 已降低重建；callback 通过 ref 的假设和未来 prop 漏加 comparator 的 stale risk 仍需契约测试。

### 8.2 下一步待办（v4.30 权威顺序）

> 本轮只更新文档。状态标记：`[x]` 表示完成且已有对应层级证据，`[~]` 表示仅部分代码/测试存在，`[ ]` 表示未完成；执行顺序以 Editor 正确性和用户频率为先，X 轨道不得插队后被计作 Editor 进度。

| 顺序 | 工作包 | 目标等级 | 完成定义 |
|------|--------|----------|----------|
| 1 | E0 真实行为与 action 基础 | L2 | 把新 catalog 接成 runtime truth；统一 action/context/keymap dispatch；功能状态能区分 unavailable/provider/partial/complete |
| 2 | E1 Effective Code Style | L2 | 在已完成的 CM/formatter wiring 上补 EditorConfig resolver、逐字段 provenance、保存 normalize 与持久化 |
| 3 | E2 Keymap Editor | L2 | 可编辑 scheme、录键/反查、冲突解析、when context、平台映射、迁移/恢复默认 |
| 4 | E3 日常编辑效率 | L2 | 收口已新增的 line commands 与 completion 性能护栏，再实现 smart keys、Smart/Type-matching Completion、语义模板、Surround/Generate |
| 5 | E4 Style / Quality / Navigation | L2 | EditorConfig/code-style/rearrange/cleanup；intention 来源/完整性；Recent Locations/Switcher/related navigation |
| 6 | J1 Java semantic foundation | L2→L3 | imported Java context + declaration/reference/type index、增量失效、smart/dumb、损坏恢复与基准 |
| 7 | J2 Inspection / Data-flow | L3（Java fixture） | registry/profile/scope executor + CFG/SSA/nullability/taint/flow evidence，与 IDEA 对照 |
| 8 | J3 Refactoring | L3（Java fixture） | completeness/conflict/exclusion/preview/revision/rollback contract，核心 refactor 对照通过 |
| 9 | A1–A4 Advanced editor | L2 | Structural Search/Replace、recursive split/tab layout、Code Vision、appearance、clipboard history、scratch/injection、Full Line local inline completion |
| 10 | Q1 三端/性能/无障碍 | L3 gate | Linux/macOS/Windows、IME/键盘/读屏/缩放与小中大工程基准形成持续门禁 |

#### 第一批：纠正错误承诺与建立可扩展底座（P0）

- [~] **E0.1 统一 action registry。** `workspaceActionRegistry.ts` 已有 metadata/catalog/test，但生产仍由 `WorkspaceCommand[]` 执行；先完成 ID/category 对账和 migration adapter，再把 workspace、CodeMirror、tree、terminal 的 action id、default binding、structured `when`、enabled reason、handler、provenance/evidence id 收敛到单一注册层；Search Everywhere、菜单、cheatsheet、keymap editor 共用同一来源。
- [~] **E0.2 拆分装配责任。** 树数据、LSP session、Git snapshot、导航和文件动作已抽 hook；`CodeWorkspaceTab.tsx` 仍约 10.6k 行，且 action/style/completion/X-track 装配集中。按 §8.3 的依赖方向抽 controller，以聚焦测试和生命周期契约为完成标准，不使用“装配壳 <400 行”作为唯一指标。
- [ ] **E0.3 能力真值 UI。** 对每个语义 action 显示来源（local/index/provider）、scope、freshness、complete/truncated/unsupported 和失败原因；先移除/修正 `KeymapCheatSheetDialog` 的“multi-platform parity”过度承诺，L1 不使用“IDEA parity/完整/已交付”文案。
- [~] **E1.1 修复缩进切换。** `EffectiveCodeStyle` 已定义并驱动 CodeMirror/LSP formatter；补 `continuationIndent` 的实际消费、override 的 tab/reopen/workspace 持久化和每字段 provenance。状态栏必须显示最终值、来源和 unsupported reason。
- [~] **E1.2 加入 EditorConfig 与优先级。** parser 已存在但未接生产；实现父目录链、`root=true` stop、nearest-to-farthest merge、glob/braces、缓存/mtime 失效，至少支持 `indent_style`、`indent_size`、`tab_width`、`end_of_line`、`charset`、`trim_trailing_whitespace`、`insert_final_newline`。优先级固定为 explicit file override > EditorConfig > language/workspace default > sniffed fallback，并逐字段显示来源。
- [ ] **E1.3 建立 code-style 对照 fixture。** 在已有 parser/model 单测之外，Java/TS/Python/Go 各覆盖 2 spaces、4 spaces、tabs、嵌套 EditorConfig、format selection/file、format/save、external file change、非法值和无 formatter；无 formatter 时不得伪成功。

#### 第二批：Keymap 与日常编辑效率（P0）

- [ ] **E2.1 Keymap scheme。** 支持 IDEA default 与 platform-specific defaults、copy/rename/delete/reset、自定义 shortcut 增删、按键反查、冲突列表、禁用 action、import/export 和 schema migration。
- [ ] **E2.2 Context 与平台键盘。** editor/tree/search/terminal/modal/completion/snippet 等 context 必须确定优先级；覆盖 macOS `Cmd/Option`、Windows AltGr/OEM、Linux non-US layout 与系统保留快捷键。
- [~] **E3.1 编辑命令补齐。** `join/sort/reverse` 已有单主选区实现；先补 command contract 和 multi-range/矩形边界，再实现 transpose lines、unwrap/remove、custom folding region、paste history、virtual space、Tab jump-out、智能 Enter/Backspace；对语言不安全的动作按 capability 置灰。
- [~] **E3.2 Completion modes。** 已有 syntax-context gate、80ms plain-typing debounce、trigger 即时和 200 项 cap；下一步把 Basic、Smart/Type-matching、第二/第三次调用扩展候选建成显式 request mode，保留 provider ranking/resolve/import edits，增加 type/context/visibility filter、exclude/priority、cancel/stale/large-list/truncation reason 门禁。
- [~] **E3.3 Templates / Complete Statement。** 已有字符串/注释抑制和单字符前缀保护；template 仍需 context/type constraint、变量函数、import/shorten、surround template，postfix 要从行级正则升级 parser/provider-aware；Complete Statement 不能只按行尾字符猜测。
- [ ] **E3.4 Surround / Generate。** Java 首批覆盖 surround if/try/loop、constructor、getter/setter、equals/hashCode、toString、override/implement/delegate；provider 缺能力时显示 unavailable，不生成字符串拼接式伪结果。

#### 第三批：Style、质量与导航闭环（P0）

- [ ] **E4.1 Code style pipeline。** 在 E1 resolver/normalize 基线上增加持久化 scheme/language settings、rearrange、code cleanup、optimize imports、format/cleanup on save；支持 file/directory/module scope、formatter marker/exclusion、preview/cancel/partial failure，不能重新定义 E1 的优先级或保存顺序。
- [ ] **E4.2 Intention/inspection 可治理。** Alt+Enter 区分 error fix、intention、refactor、source action，支持 on-the-fly disable/assign shortcut；Problems/Analysis 展示 provider、scope、revision 和 evidence level，不把 display suppression 当规则执行。
- [ ] **E4.3 Navigation history。** 实现带代码上下文的 Recent Locations、多个 edit locations、Switcher、super method、siblings、method up/down、related symbol；library/dependency 目标保留 source/ownership/read-only 语义。
- [ ] **E4.4 搜索语义。** Search Everywhere 明确 All/Class/File/Symbol/Action/Text 的数据完整性、scope、indexing state 和 ranking；Find/Replace 支持 scope/filter/preview/partial result 与可恢复批量替换。

#### 第四批：Java 可证明语义（P1）

- [ ] **J1.1 Java imported context。** 将 source set、language level、SDK、dependency/library source 和 jdtls module 统一成 editor semantic context；不要求先完成 X 轨道 compiler/artifact，但 classpath/source ownership 必须确定。
- [ ] **J1.2 Index。** 建立声明/引用/type relation index、版本 schema、增量 invalidation、smart/dumb state、cancel、损坏重建与 shared-cache 安全边界；记录 10k/100k/1M LOC 基准。
- [ ] **J2 Inspection/Data-flow。** 实现最小 Java registry/profile/scope executor 与 CFG/SSA/nullability/taint/interprocedural summary；覆盖 dead code、probable null dereference、constant condition、possible values、producer/consumer、path proof 和 quick-fix linkage。
- [ ] **J3 Refactor contract。** provider/index 统一返回 usages、completeness、conflicts、dependent edits、excludable groups、revision 和 rollback plan；Rename/Safe Delete/Move/Change Signature/Extract/Inline 用 IDEA fixture 验证结果、冲突、preview 与单步 undo。

#### 第五批：高级能力与持续门禁（P2 / Cross-cutting）

- [ ] **A1 Structural Search/Replace。** 以 parser/query AST 和 typed variables 实现 Java 首个垂直切片，支持 template 保存/分享、scope、preview、replace conflict 与 undo；regex 搜索不能计作 SSR。
- [ ] **A2 Editor layout/presentation。** editor group 改为递归 layout tree，支持 nested split、drag-to-split/dock、detach/equalize/stretch/splitter navigation、tab limit/order/policy；再补 Code Vision、scrollbar lens、font/ligature/color scheme。
- [ ] **A3 边缘编辑工作流。** clipboard history、scratch files、language injection、custom folding 与 read-only/library edit policy 分项设计和验收。
- [ ] **A4 Full Line Completion（IDEA Ultimate bundled-plugin 参考）。** Java 首批建立本地模型下载/更新/禁用/硬件降级与隐私状态，支持单/多行 inline suggestion、整段/逐词/逐行接受、popup 同步、格式/括号/引号修正、基础 unresolved-reference 过滤、auto-import、smart filtering、cancel/stale 与 typing latency/memory budget；必须证明源码默认不出机。其他语言逐模型/provider 记账，AI Assistant 或 Terminal FIM 不计入本项。
- [ ] **Q1 自动化。** 每个新增控件同步 `feature-list.md`/testid catalog/YAML case；核心算法加 Vitest/Rust 测试，Editor 主路径执行 `qa-ui-auto --diff`，失败与不支持状态均需用例。
- [ ] **Q2 三端真机。** 按 §2.6 保存 Linux/macOS/Windows 的 keyboard/IME/clipboard/font/zoom/path/watcher/LSP/packaged-app 证据；只有三端完成后，相应能力才可升 L3。
- [ ] **Q3 性能与隐私。** 固定 typing latency、completion p95、search/index time、memory 与 crash-recovery budget；trace 默认脱敏，不记录源码、补全文本、凭据或完整路径。

X 轨道的 Build/Run/Debug/Test/Coverage、Terminal、Git、AI 继续按各自设计推进，但其待办统一放到 §12，避免再次挤占 Editor P0/P1 顺序。

### 8.3 v4.30 实现级详细设计（供其它 agent 接手）

> 本节是当前代码基线之后的执行规格，不是已经存在的 API。实现 agent 必须先阅读 §2.9 的证据表，再按本节的文件责任边界提交；不得把静态目录、协议 capability 或 mock 测试写成 L2/L3 完成。每个工作包完成时都要补“实现、失败路径、聚焦测试、fixture、QA 控件/用例、状态等级”六项证据。

#### 8.3.0 通用交付协议

**状态与结果模型。** 所有跨 provider 的 action/style/completion 结果都必须携带 `workspaceId`、`fileKey`（若适用）、`documentVersion`（若有文档）、`operationGeneration`、`sessionGeneration`（仅 provider 结果）以及 `source`（`local`/`index`/`provider`/`fallback`）、`scope`、`freshness` 和 `completeness`。`completeness` 至少区分 `complete`、`truncated`、`partial`、`unavailable`、`failed`；UI 不得把 `[]`、`null` 或超时渲染成“没有结果”而隐藏原因。

**异步发布门禁。** 发布前同时检查资源仍属于当前 workspace、文件 key 未改变、文档版本未落后、session generation 未失效；失败只丢弃旧结果，不覆盖新文本/新设置。用户主动取消与 provider 失败要分别显示，前者不记为错误，后者保留可重试入口。

**撤销边界。** 一个用户动作（包括 formatter + save normalize、批量 line edit、多个 WorkspaceEdit）必须产生一个可解释的 undo 单元；预览/确认被拒绝、能力不支持、版本过期时不得留下空 undo 栈项。只读 library/decompiled buffer 的命令必须返回 `disabledReason=readOnly`，不能静默 no-op。

**依赖顺序。** E0（action/context）是 E2/E3 的入口依赖；E1 的 style resolver 可与 E0 并行，但 E4.1 save actions 依赖 E1；J1/J2/J3 只能消费 E0 的状态模型和 E3 的 provider contract，不能在各自模块重新定义一套 enabled/provenance 语义。

#### 8.3.1 E0：运行时 Action Registry 收口

**责任边界。**

- `src/components/editor/workspace/workspaceActionRegistry.ts`：保留 metadata catalog，但扩展为唯一 executable definition、订阅和状态查询；不再只做测试用 singleton。
- `workspaceCommands.ts`：提供旧 `WorkspaceCommand` 到新 definition 的兼容 adapter，迁移完成后只保留键位解析的纯函数，不再拥有第二份 action truth。
- `CodeWorkspaceTab.tsx`：负责当前 workspace 生命周期内的注册/注销和 context snapshot，不再在 `useMemo` 内维护大数组作为长期 registry。
- `SearchEverywhere`、应用菜单、`KeymapCheatSheetDialog`、工具栏/树右键菜单：改为订阅 registry snapshot；不得直接读取 `DEFAULT_WORKSPACE_ACTIONS` 推断可执行性。

**建议数据契约。**

```ts
type ActionId = string;
type ActionAvailability = "available" | "disabled" | "unsupported" | "stale";
type ActionSource = "local" | "index" | "provider" | "partial" | "unsupported";

interface WorkspaceActionDefinition<Ctx = WorkspaceActionContext> {
  id: ActionId;
  title: string;
  category: ActionCategory;
  keywords: string[];
  defaultKeybindings: PlatformKeybindingSet;
  secondaryKeybindings?: PlatformKeybinding[];
  when: WhenExpr;                    // 结构化表达式，禁止任意字符串
  getState: (ctx: Ctx) => ActionState;
  run: (ctx: Ctx, signal: AbortSignal) => Promise<ActionResult>;
}

interface ActionState {
  availability: ActionAvailability;
  disabledReason?: "noEditor" | "noSelection" | "readOnly" | "capability" |
    "providerOffline" | "stale" | "conflict" | "busy";
  source: ActionSource;
  scope: "editor" | "file" | "workspace" | "session";
  freshness: "current" | "stale" | "unknown";
  completeness: "complete" | "truncated" | "partial" | "unavailable" | "failed";
}

interface ActionResult {
  kind: "applied" | "opened" | "no-op" | "cancelled" | "failed";
  undoGroupId?: string;
  message?: string;
  retryable?: boolean;
}
```

**迁移步骤。**

1. 先生成一份 machine-readable ID 对账表，列出 catalog、运行时 command、CodeMirror keymap、菜单和 QA case 的所有 ID；重复 ID 由注册时抛出开发期错误，生产环境将冲突 action 标为 unavailable 并保留首个定义。只有同一 owner/token 的显式 replace 才允许更新 handler，禁止静默 last-wins。
2. 对当前已知别名建立显式映射，不能靠模糊匹配：`workspace.formatDocument → workspace.format`、`workspace.nextDiagnostic → workspace.nextError`、`workspace.prevDiagnostic → workspace.prevError`、`workspace.quickDefinitionPeek → workspace.quickDefinition`、`workspace.rename → workspace.renameSymbol`、`workspace.safeDelete → workspace.safeDeleteSymbol`。迁移日志要能反查旧持久化 key。
3. 把 `when?: string` 编译为有限 AST（`all`、`any`、`not`、`focusIs`、`hasSelection`、`capability`、`debugActive`、`modalOpen` 等），未知谓词在开发期报错、生产期变为 `unsupported`；求值顺序固定为 modal > completion/snippet > editor > tree/search/terminal > workspace。
4. 注册时将 `run` 包装为可取消 promise，并在执行前后发布 `action-state-changed`；Search Everywhere、菜单和 keymap 面板只消费同一 snapshot。动态 provider capability、dirty/readOnly、index freshness 变化必须触发订阅，而不是等待组件重挂载。
5. 将 platform binding 统一成逻辑键（`Mod`、`AltGraph`、物理 `code` 可选）再解析到 macOS/Windows/Linux；同一 action 的默认键、用户键和禁用标记分层存储，供 E2 复用。

**失败语义与验收。** 未找到 action 返回 `unknownAction`；存在但不可用返回 `disabledReason`，不调用 handler；handler 抛错只显示一次可读错误并保留 `retryable`；执行期间 workspace/file 被关闭则返回 `cancelled`，不得把异步结果写回其它 tab。验收至少包括：全部实际 command ID 均可由 registry 查询、catalog 无 orphan、同键冲突图稳定、切换 editor/tree/terminal/modal 时只有最高优先级 action 执行、旧快捷键持久化可迁移、Search Everywhere 与 cheatsheet 显示相同 provenance/state。聚焦测试放在 `workspaceActionRegistry.test.ts`、`workspaceCommands.test.ts` 和 `CodeWorkspaceTab` action integration test；再补一条 `qa-ui-auto` Actions/Keymap case。

#### 8.3.2 E1：Effective Code Style、EditorConfig 与保存规范化

**解析器与 resolver 分工。** `editorConfigParser.ts` 只负责无副作用解析单个文件；新增 resolver 负责文件系统、父目录链和缓存，避免把 Tauri `invoke` 混入 parser。建议接口：

```ts
interface EditorConfigResolver {
  resolveForFile(input: {
    workspaceId: string;
    rootId: string;
    filePath: string;
    explicitOverride?: ExplicitIndentationOverride | null;
    languageDefault: CodeStyleDefaults;
    text?: string;
  }): Promise<ResolvedCodeStyle>;
  invalidate(path: string): void;
  clearWorkspace(workspaceId: string): void;
}

interface ResolvedCodeStyle extends EffectiveCodeStyle {
  provenance: Partial<Record<
    "indent_style" | "indent_size" | "tab_width" | "end_of_line" |
    "charset" | "trim_trailing_whitespace" | "insert_final_newline",
    { source: "explicit" | "editorconfig" | "language" | "sniffed" | "fallback";
      configPath?: string; rawValue?: string; reason?: string }
  >>;
  diagnostics: Array<{ path?: string; property?: string; message: string; severity: "info" | "warning" }>;
}
```

**EditorConfig 合并算法。** 先按 canonical path 最长前缀确定唯一 owning root，再从文件所在目录向该 root 逐级查找 `.editorconfig`；loose file 使用其登记时的边界，拒绝越界读取。查询阶段由近到远收集，应用阶段按最远到最近合并；同一配置文件内按 section 出现顺序覆盖，最近文件的匹配属性胜出；`root=true` 的文件纳入链后停止继续向上。section pattern 相对于配置文件目录计算，basename pattern 只匹配 basename；保留大小写和 `/` 归一化规则。布尔属性只接受 `true/false`，其它值保留诊断并视为 unset；当前 parser 不支持或无法安全实现的 glob（例如复杂转义/否定）必须返回诊断并按“不匹配”处理，不能扩大匹配范围。

**缓存与失效。** 缓存键至少为 `(workspaceId, rootId, configPath, mtime/hash)`，结果缓存为 `(filePath, chain fingerprint)`；收到 watcher 的 create/change/delete、用户在树中重命名 `.editorconfig`、workspace root 变化或 resolver 版本升级时失效。并发 resolve 使用 generation，旧链结果不能覆盖新链。文件只有 EOL/charset 等属性时也必须进入 EditorConfig provenance，不能因为没有 indent 属性而回退到 language default。

**状态迁移。** 每个文件的 resolver 状态为 `unresolved → resolving → resolved | failed`；config 变更把 `resolved` 标记为 `stale` 后触发新 generation。`resolving` 时可暂用同一文件上一代 style（标注 stale）或 language default（标注 provisional），不得把 provisional 写入持久化；`failed` 保留上次可用值和错误路径，提供 retry，并禁止将损坏配置解释为全 false/default 后静默保存。

**优先级与应用。** 最终顺序固定为 `explicit file override > EditorConfig chain > language/workspace scheme > existing-text sniff`。嗅探只用于没有显式配置的字段，不能覆盖 EditorConfig；混合缩进、非 2/4 空格或不规则值返回 `sniffed`/`warning`，不偷偷改写文件。`CodeMirrorHost` 继续由 compartment 更新 `EditorState.tabSize`、`indentUnit`；`continuationIndent` 若当前语言服务不支持，状态中标为 `unsupported`，不能伪装成已生效。formatter 请求必须从同一 resolved object 取 `tabSize`/`insertSpaces`，避免 status、CM、LSP 各自计算。

P0 只承诺 EditorConfig 标准 whitespace/EOL/charset 属性；IDEA 的 `ij_*`/`ij_any_*` formatter properties 要在 E4.1 的 code-style scheme 有稳定字段映射后再逐项支持。未知 `ij_*` 属性保留在 diagnostics/provenance 中，不得被当作已生效设置。

**持久化。** 显式 override 按 canonical file identity 存入 workspace-scoped store（而非组件 `useState`）；记录 schema version、创建平台和手动/自动来源。重命名/复制文件时明确选择继承、复制或清除 override；关闭 workspace 后不得泄漏到同路径的新 workspace。读取旧 schema 失败时回退自动解析并保留迁移诊断。

**保存前 normalize pipeline。** 在 dirty snapshot 和最新 editor text 校验后按以下顺序执行：

1. 可选 language formatter（document/range），失败时保留原文本并记录 `formatterFailed`；无 formatter 时返回 `unavailable`，不显示“已格式化”。
2. 按 `trim_trailing_whitespace` 逐行删除行尾空白（包括空白行）；若语言/文件类型需要 Markdown hard-break 等例外，必须由明确的 formatter policy 记录，而不是隐式跳过。
3. 按 `insert_final_newline` 添加或删除唯一末尾换行。
4. 按 `end_of_line` 将内部 LF 转为目标 EOL；二进制/混合 EOL 先阻断并要求用户选择。
5. 按 `charset`/BOM 编码写盘，遇到不可表示字符必须取消整次保存并保留 dirty buffer。

每一步都要在 formatter 异步期间重新读取当前 `file.text`；若发生新编辑，放弃旧 snapshot 的 normalize 结果并从最新文本重跑或提示重试。用户取消、外部 hash 冲突、权限/锁定文件失败均不改变磁盘；状态栏显示具体阶段和可恢复动作。

**fixture 与完成门槛。** 新增 `code-style-fixtures/`（或等价 Vitest fixture）覆盖：嵌套 config + root stop、`*.java`/`**`/braces、父目录属性覆盖、仅 EOL/charset、非法值、CRLF/CR/UTF-8 BOM/UTF-16、混合缩进、外部 config 变更、无 formatter、dirty race、重命名后 override、三端路径大小写。验收要求同一 fixture 的状态栏 label/provenance、Tab/Enter、format selection/file、save bytes 和 reopen 状态一致；至少一条 Tauri/qa-ui-auto 用例验证真实文件系统链路。

#### 8.3.3 E2：可编辑 Keymap 与冲突解析

**持久化 schema。** 使用版本化 JSON（建议 `keymapSchemaVersion: 1`）：`schemeId`、`parentSchemeId`、`platform`、`bindings`、`disabledActions`、`mouseBindings`、`metadata`。默认 IDEA platform scheme 只读；用户第一次修改时 copy-on-write 生成 workspace/user scheme。删除/重命名 scheme 前检查引用，reset 生成可审计迁移事件；导入只接受已知 schema，未知 action 保留为 orphan 并显示，不静默丢弃。

**绑定解析。** 将 `Ctrl+P`、`Cmd+P`、`Mod-P`、物理 `code` 和 AltGr 分成逻辑层与平台层；先按 modal/completion/snippet/editor/tree/search/terminal context 求值，再按用户 binding > workspace binding > platform default > fallback alias 选择。一个事件命中多个 action 时构建 conflict graph：同 context 选择优先级最高者，跨 context 显示冲突并要求用户删除/禁用；系统保留键（macOS Cmd+Space、Windows Win 键等）不得拦截。

**录键/反查 UI。** 录键时同时保存 `key`、`code`、修饰键和平台；显示标准化结果、不可用原因和冲突 action。按键反查必须从 runtime registry 查询，包含未启用/unsupported action，区分 default 与 user binding。cheatsheet 保留为轻量入口，但其执行按钮调用同一 `run`，不再复制 handler。

**测试。** 纯函数覆盖 parser round-trip、scheme inheritance/copy/reset、平台映射、AltGr/OEM/non-US、冲突优先级和禁用 action；组件覆盖焦点切换、录键取消、导入坏 schema、恢复默认；Linux/macOS/Windows 真机至少各保存一组 Cmd/Ctrl/AltGr/IME 证据。E2 依赖 E0 的 `ActionState` 和订阅，不得在 keymap UI 内复制 when 逻辑。

#### 8.3.4 E3.1：编辑命令契约与实现顺序

所有 CodeMirror command 先定义 `CommandOutcome = applied | unavailable | readOnly | noSelection | cancelled`，所有 range 变换在一个 `state.update` 中提交，标注稳定 `userEvent`，并由 history 合并为一个 undo 单元。多光标/矩形选择必须以 `state.selection.ranges` 为输入；不能只读取 `selection.main` 后声称支持多选区。

| 命令 | 目标语义 | 实现约束 | 最小 fixture |
|------|----------|----------|--------------|
| Join Lines | 当前行或选区覆盖的相邻行合并，按语言/配置决定单空格、无空格或保留空白 | 明确是否包含选区末行；不跨只读/不可见文档；每个 range 独立计算并防止重叠 change | Java chained call、Markdown paragraph、空行、CRLF、多光标 |
| Sort Lines | 对选区完整行排序，支持 ascending/descending、case-sensitive、natural/locale、stable | 默认不改变选区外文本；排序键和选项进入 action context；混合 EOL 保留原 EOL | 大小写混排、重复行、Unicode、矩形选择、无选区 |
| Reverse Lines | 反转完整行顺序 | 与 Sort 共用 line interval/selection policy 和 undo metadata | 多选区、末尾空行、CRLF |
| Transpose / Unwrap / Remove | IDEA 对应高频结构编辑 | 仅在 syntax/provider 能证明边界时启用；否则 `unsupported`，禁止正则猜测破坏代码 | Java/TS 括号、注释、嵌套结构 |
| Paste History / Virtual Space | 剪贴板历史和行尾虚拟光标 | 明确隐私保留、最大条数、跨 workspace 隔离；虚拟空格不写入不可见字符 | 多光标粘贴、敏感文本清理、只读 library |
| Smart Enter/Backspace/Tab jump-out | 语言感知括号/缩进/Tab stop | 先用 CodeMirror syntax tree，再由 provider capability 覆盖；字符串/comment/interpolation 单独 fixture | Java/TS/Python/Rust raw string、嵌套括号 |

当前 `join/sort/reverse` 只作为第一步：sort 的 `localeCompare`、主选区边界和空 selection 行为必须在 API contract 固化后再扩展，避免后续 agent 互相改变快捷键却不改变测试预期。

#### 8.3.5 E3.2：Completion orchestration 与 IDEA 模式

**请求上下文。** 将 completion 请求显式建模为：

```ts
type CompletionRequestReason = "typing" | "trigger" | "explicit" | "reinvoke";
interface CompletionRequestContext {
  reason: CompletionRequestReason;
  syntax: "code" | "string" | "comment" | "character" | "unknown";
  documentVersion: number;
  sessionGeneration: number;
  triggerCharacter: string | null;
  typedPrefix: string;
  mode: "basic" | "smart" | "typeMatching";
  candidateBudget: number;
}
```

触发矩阵固定为：普通输入 `typing` 允许 debounce（当前 80ms），`.`/`:`/server trigger 走 `trigger` 立即请求，Ctrl+Space 走 `explicit` 并绕过自动抑制，同时把 string/comment 等 syntax context 传给 provider/过滤策略；重复调用在同一 popup session 中升级为 `reinvoke` 并切换 basic→smart→typeMatching。每次请求绑定 abort listener、文档版本和 LSP session generation；结果只允许当前三者全部匹配时发布。

**候选处理。** 先保留 server `sortText`、`filterText`、resolve、snippet、additionalTextEdits 和 `isIncomplete` 语义，再做客户端类型/可见性/上下文过滤。候选超过预算时按 provider 排名截断，返回 `completeness=truncated` 和可见的“更多结果/继续输入”状态；不能悄悄只取前 200 项而让用户误以为列表完整。provider 不可用时可回退 `completeAnyWord`，但 UI 必须标注 `source=fallback`，且不应把 fallback 结果和 semantic completion 混排成同一 provenance。

**syntax context。** `syntaxContext.ts` 继续采用“已可用 Lezer tree 优先、未 ready 时 cheap lexical fallback”的非阻塞策略；新增语言前必须提供节点名/字符串插值/raw string/嵌套 comment fixture，不能假设所有 parser 都使用 `String`/`Comment` 命名。fallback 不确定时返回 `unknown`，由策略决定 suppress 或显式请求，并记录 reason，不能把误判当成语义事实。

**性能与验收。** 记录 request reason、debounce wait、provider latency、mapping count、display count、abort/stale count、truncated count、popup paint time；源码和补全文本脱敏。建议预算：小工程普通输入到 popup 可见 p95 ≤ 100ms，中工程 ≤ 150ms，大文件模式 ≤ 250ms；trigger/explicit 不得被 80ms debounce 延迟；连续输入 20 次只允许最后一代结果发布。测试覆盖 Java/TS/Python/Go/Rust：注释、字符串、模板字符串/插值、raw string、block comment、语法树未 ready、server `isIncomplete`、200/1000/10000 候选、provider restart 和 document change race。

#### 8.3.6 E3.3：Templates、Complete Statement、Surround/Generate

**统一 template context。** 在本地 template engine 与 LSP/provider 之间定义 `TemplateContext`：语言、syntax node、表达式 range、预期类型（可选）、可导入符号、selection、readOnly、document version。模板声明 `contextPredicate`、`typePredicate`、`variables`（默认值、函数、Tab stop 顺序）和 `importEdits`；不能再仅凭 `expr.abbr` 行级正则决定 postfix 可用性。无法取得类型/语法证据时显示 local/heuristic 标签，默认不自动展开。

**Complete Statement。** 先请求 provider/language engine 的 statement completion；无能力时只启用安全的 parser tree 变换（补闭合括号、保持缩进），并返回 `partial`。任何按行尾 `;`/`{`/`:` 猜测的 fallback 必须列出语言白名单、字符串/comment 排除和可撤销 preview；不能对未知语言插入 Java 风格分号或两空格缩进。

**Surround/Generate。** Java 首批实现 `if/try/catch/loop` surround 和 constructor/getter/setter/equals/hashCode/toString/override/implement/delegate generate；每项以 provider capability 或 J1 index 结果为前置，预览中展示 import、冲突和生成范围，用户取消零修改。TypeScript/Python 等只在 provider 明确支持时开放，固定文本模板继续标记 `local template`，不计作 IDEA semantic parity。

#### 8.3.7 E4：Style/Quality/Navigation 的统一结果契约

**Intention/inspection。** 当前 `inspectionProfile.ts` 只变换 provider diagnostics 的显示，`inspectionEvidence.ts` 只分类 provider metadata/text；新增执行层不得复用这两个名字冒充本地 inspection engine。统一返回：

```ts
interface EditorInsightResult {
  id: string;
  kind: "quickfix" | "intention" | "inspection" | "refactor" | "sourceAction";
  title: string;
  source: "provider" | "java-index" | "local-heuristic";
  scope: "caret" | "selection" | "file" | "module" | "workspace";
  revision: number;
  completeness: "complete" | "partial" | "truncated" | "unavailable" | "failed";
  evidenceLevel: "structured" | "related-location" | "text-inferred" | "none";
  edit?: LspWorkspaceEdit;
  command?: { id: string; arguments?: unknown };
  disabledReason?: string;
}
```

Alt+Enter 先按 kind/source 分组，再按 severity、applicability 和 provider rank 排序；profile disable/suppression 只能影响对应 executor/rule，不能仅隐藏 UI 后宣称规则关闭。assign shortcut 走 E0/E2 action ID。执行前复核 document/session revision；edit 后 command 的既有顺序保持不变，失败要显示来自哪个 provider/rule。

**Navigation history。** 在 `useWorkspaceNavigation` 之外新增纯模型 `NavigationLocation`：`fileIdentity`、range、symbolId（可选）、before/after context、contentHash、reason、timestamp、workspaceRevision、sourceOwnership。Recent Locations 保存有界多点历史，连续同文件小移动合并；Last Edit 保存多个 edit cluster；文件重命名通过 identity 更新，删除/外部变更后标 stale，用户选择时先按 symbolId，再按 context hash 重定位，失败显示 unavailable。library/dependency 位置始终只读并携带 owner/module/source attachment。

**Search result envelope。** Search Everywhere 的 All/Class/File/Symbol/Action/Text 都返回 `source/scope/indexState/completeness/rankReason`；All 只合并同 generation 结果，单 provider 失败不能被空列表吞掉。Action 结果直接消费 E0 registry，Class/Symbol 消费 J1/provider snapshot，Text/File 消费 workspace search；每组独立显示 truncated/skipped provider。Replace preview 继续走 WorkspaceEdit/hash guard，一个批次一个 undo 单元。

**E4 验收。** Java/TS fixture 分别覆盖 provider online/offline、partial/truncated、旧 revision、profile disable/suppression、quickfix edit+command、Recent Locations 重命名/删除/外部编辑、library source、Search provider 部分失败。E4.1 style pipeline 复用 E1 resolver/normalize，不得另建第二套 precedence；E4.2 依赖 E0 action state，E4.3/4 可与 E2 并行。

#### 8.3.8 J1–J3：Java 可证明语义主线

**现有边界。** `workspaceSemanticIndex.ts`/`useWorkspaceSemanticIndex.ts` 当前只维护 provider query 的 `generation/revision/indexedRevision/coverage` 和 stale guard，没有持久化声明、引用或 type graph。J1 必须建立新的后端 index service，同时让现有 snapshot 变成它的状态投影；禁止仅把 provider 进度设为 `ready` 就登记“Java index 完成”。

**J1 imported context 与索引。** owning module 以 canonical source root 最长匹配确定，输入来自 project/module/source-set、Java language level、SDK/JDK、compile classpath、dependency source 和 jdtls workspace folder；每次 import 生成不可变 `contextGeneration` + `fingerprint`。建议后端记录：

```rust
struct JavaSymbolRecord { symbol_id: String, kind: SymbolKind, owner: Option<String>,
    file_id: String, range: TextRange, modifiers: u32, type_id: Option<String> }
struct JavaReferenceRecord { file_id: String, range: TextRange, target_id: Option<String>,
    role: ReferenceRole, resolution: ResolutionState }
struct JavaTypeEdge { from_type: String, to_type: String, kind: TypeEdgeKind }
struct JavaIndexSnapshot { schema_version: u32, context_generation: u64,
    workspace_revision: u64, file_count: u64, unresolved_count: u64,
    status: JavaIndexStatus, diagnostics: Vec<IndexDiagnostic> }
```

状态机固定为 `uninitialized → importing → indexing(dumb) → smart | degraded | error`；schema/context fingerprint 不匹配进入 `rebuilding`，校验损坏进入 `corrupt` 后隔离旧库再重建。索引写入使用 transaction + generation commit，取消或进程退出不发布半成品；文件编辑只失效该文件及依赖边，classpath/language-level/source-root 变化失效整个 context。查询返回 revision、complete/truncated、unresolved/skipped count 和取消 token；dumb 状态只开放可证明的文本/局部功能，semantic refactor 默认 disabled。

持久化实现优先复用仓库已有 SQLite/存储设施；parser/index 技术选型先做 spike，比对 Java 17/21 语法、错误恢复、annotation processing/generated source 和内存。不得从 regex 或 jdtls UI 文本反推 symbol identity。10k/100k/1M LOC fixture 记录 cold import、单文件增量、classpath change、查询 p95、DB size 和 recovery time。

**J2 inspection/data-flow。** 建立版本化 `InspectionRuleRegistry`：rule id、default severity、language level、scope applicability、required facts、executor version、quick-fix IDs。第一条垂直切片只做可确定的 Java rules（dead code、constant condition、probable null dereference），CFG 按 method 构建，SSA/data-flow fact 附带 source range 和 predecessor path；跨方法 summary 有 depth/time budget，超限返回 partial，不能猜 complete。profile/scope/suppression 在执行前过滤，结果携带 rule/version/context generation/workspace revision/evidence path；taint source/sink 配置需独立 schema。provider diagnostics 可并列显示，但不转写成自有 L3 结果。

**J3 refactor plan。** 所有 Java 重构先返回不可变计划：

```ts
interface SemanticRefactorPlan {
  operation: "rename" | "safeDelete" | "move" | "changeSignature" | "extract" | "inline";
  contextGeneration: number;
  workspaceRevision: number;
  usages: SemanticUsage[];
  completeness: "complete" | "partial" | "truncated";
  conflicts: RefactorConflict[];
  editGroups: Array<{ id: string; dependentOn: string[]; excludable: boolean; edits: LspTextEdit[] }>;
  resourceOperations: LspWorkspaceEditOperation[];
  rollbackPlan: WorkspaceEditRollbackPlan;
}
```

只有 `complete` 且无 blocking conflict 才允许 Apply；partial/truncated 默认硬阻断，除非某个操作契约明确允许局部执行。预览复选框按 `editGroup` 工作，依赖 group 不能单独排除；当前逐 raw edit checkbox 必须迁移，不能破坏 import/signature/reference 原子关系。确认后再次核对 context generation、workspace revision、file hashes 和 dirty buffer versions；任一过期回到 preview，不自动套用。应用完成后重新查询关键 symbol/usages 做 post-condition，失败展示 rollback；整个计划对应一个 transaction undo。

**Java 对照 fixture。** 建立独立可复制工程：多 module/source-set、继承/接口/overload/generic、record/sealed/annotation、static import、same-name symbol、library source、generated source、语法错误、未解析依赖、dirty buffer、外部变更。每个 case 保存 IDEA 2026.2 的 declarations/references/diagnostics/refactor preview/conflict/最终 diff 基线；自动化比较结构化结果，不比较截图文字。交付顺序严格为 J1 context→index→query，再 J2 单 rule 垂直切片，最后 J3 Rename/Safe Delete→Move/Change Signature→Extract/Inline。

#### 8.3.9 A1–A4：高级编辑轨道入口条件

| 工作包 | 硬前提 | 最小技术契约 | 首个可验收切片 |
|--------|--------|--------------|----------------|
| A1 Structural Search/Replace | J1 的 Java parser/symbol/type facts 稳定 | 版本化 AST query、typed variable constraint、scope、match provenance、replace plan/conflict/undo；regex 只作文本搜索 fallback | Java method call pattern，含 subtype/text/count constraint、preview 与单步 undo |
| A2 Layout/Presentation | editor buffer ownership 与 E0 focus context 稳定 | 递归 `SplitNode | LeafGroup` layout tree、v1 双组状态迁移、drag transaction、detach window ownership、tab policy schema | 三层 nested split、drag-to-split、关闭/恢复、键盘切 splitter，无丢 tab/焦点 |
| A3 Clipboard/Scratch/Injection | E3 command outcome、workspace privacy policy 稳定 | clipboard item TTL/size/redaction、workspace/user scope；scratch identity/encoding；injected range 的 host↔virtual mapping/revision | Paste History 的本地有界实现 + 清除/禁用；Java string 中单一 SQL injection 只读语义 fixture |
| A4 Full Line Completion | E3 completion request/generation/telemetry 稳定，Java J1 context 可用 | proven local inference runtime、model manifest/signature/download/update/rollback、AVX2 x64/ARM64 gate、offline/privacy state、ghost-text session、whole/word/line accept actions | Java 单行建议 + 整段/逐词/逐行接受、popup coexist、stale/cancel、auto-import、源码不出机证据 |

A4 不自行实现推理内核；先评估成熟、可离线、许可兼容的 runtime，并把模型/runtime 版本和资源预算写入 manifest。硬件不支持、模型缺失/损坏、下载取消、内存压力和 provider 冲突均显示明确状态；Terminal FIM 和 AI Assistant 继续独立记账。A2 detach 若跨 Tauri window，buffer/LSP ownership 仍只在主 workspace controller，子窗口不得复制保存者。

#### 8.3.10 Q：性能、树刷新与 capability 生命周期

**CodeMirror comparator 契约。** `CodeMirrorHost` 当前忽略多数 callback identity，但 memo 命中时组件函数不会执行，组件内 `ref.current = callback` 也不会更新；因此“放进 ref”本身不足以证明安全。先把遗漏的 `debugInlineValues` 纳入比较，并为每个 callback 明确选择：父层提供语义稳定的 event callback、显式比较 identity，或传入可在父层独立更新的 ref。新增任何影响行为的 prop（尤其 action handler、code style 字段、completion trigger、readOnly）必须同时加入 comparator/lifecycle test。建立 prop matrix，验证无关 rerender 不重建 view、仅 inline value 变化会更新装饰、切 tab 不回填旧 callback、unmount 清理 timer/listener、codeStyle compartment 只在字段变化时 dispatch。

**LSP capability generation。** `mergeDocumentCapabilities` 解决空摘要抖动，但新 session/重启 provider 时必须先发布 `capabilities=null` + 新 `sessionGeneration`，再接受 initialize 摘要；每个 capability 标注 `source=initialize|dynamic|preserved` 和收到时间。旧摘要只能在同 generation 的空增量通知中保留，不能跨 generation 继承。UI 在 reset 窗口显示 initializing/unknown，而不是沿用旧按钮可用状态。

**树与 watcher。** 200ms tree refresh debounce 只合并事件，不得延迟用户显式 reload；build/dependency 目录过滤规则要与文件树、LSP watcher、Search Everywhere 共用 `should_skip_workspace_entry_path` 语义。burst refresh、删除后重建、大小写-only rename、网络/UNC 路径和 watcher 上限要有 Rust + Tauri fixture；旧 generation 的 `loadDir/loadFlatFiles` 结果必须被丢弃且不能留下 Loading 永久态。

**持续性能门禁。** 每个 PR 至少记录小/中/大 workspace（建议 10k/100k/1M LOC）的 typing p95、completion p95、tree refresh settle time、Search Everywhere 首结果时间、内存峰值和 crash/recovery；大文件模式的降级项、候选 cap、装饰关闭原因写入脱敏 trace。没有真实 Tauri/三端采样时，状态最多 L2，不能升 L3。

#### 8.3.11 Agent 接手清单与交付顺序

1. **E0.1 agent** 先提交 ID 对账和 registry adapter，不同时改 E1/E3 业务逻辑；完成后输出 action snapshot fixture 和迁移说明。
2. **E1 agent** 负责 resolver、store persistence、save normalizer 与 code-style fixtures；不得在 `CodeMirrorHost` 内另造 style 计算，所有值来自 `ResolvedCodeStyle`。
3. **E2 agent** 只消费 E0 registry/context，负责 schema、冲突图、录键/反查和平台测试；不要复制旧 `WorkspaceCommand` 数组。
4. **E3 command agent** 先补 `join/sort/reverse` contract/golden tests，再逐项实现剩余命令；每个变换都必须有 undo/readOnly/no-op 断言。
5. **E3 completion agent** 负责 request context、generation、budget/telemetry 和语义 mode；不得通过提高 cap 或取消 debounce 冒充 Smart Completion。
6. **E3 template/Java agent** 依赖 E3 completion context 与 J1 provider contract；先做 Java fixture，再扩展其它语言，缺 capability 时保持 unavailable。
7. **E4 agent** 负责 insight/search/navigation envelope 与 history model，只消费 E0/E1/J1 的状态，不在 UI 层推断 completeness。
8. **J1 agent** 先交 imported-context/parser/storage spike 和 schema，再做最小声明/引用/type query；J2/J3 不得与未稳定的 J1 schema 并行写另一套 index。
9. **J2/J3 agents** 分别拥有 inspection executor 与 refactor plan；二者共用 J1 snapshot/revision，不修改 X 轨道 build/run 模型，跨模块契约变更先更新 fixture/schema。
10. **A-track agents** 只有在 §8.3.9 对应硬前提完成后启动；A1/A4 共用 J1/E3 语义上下文，A2/A3 不得借机重构无关 X 轨道 UI。
11. **Q agent** 负责 comparator/capability/tree 性能契约和三端采样，不以 synthetic test 替代 packaged-app evidence。

每个 agent 的 PR 描述必须列出：改动文件、未改动的边界、状态等级变化、失败/取消语义、测试命令及结果、fixture 路径、QA case/testid 变更、已知 provider/平台限制。文档中的 `[~]` 只有在对应证据齐全后才能改为 `[x]`；不得因为 UI 入口或单元测试数量增加而提前升级。

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| 装配层重构回归 | `CodeWorkspaceTab.tsx` 已约 10.6k 行，action/style/LSP/file/execution 状态耦合 | 行为不变原则 + 聚焦测试 + 回归清单；先抽 action/code-style/navigation controller，再分离 X 轨道装配 |
| LSP 服务器差异 | completion/rename/hierarchy 各 server capability 差异大 | §5.2.0 capability 驱动开关；不支持则置灰 + hint；§5.2.12 矩阵仅作方向参考 |
| WorkspaceEdit 非原子 | 跨文件重命名可能部分成功 | 有序执行在首次失败处停止并呈现结果；单个 overwrite 资源操作使用备份/恢复保护旧目标，但不虚构跨操作事务 |
| 补全性能/竞态 | 高频输入下请求风暴、过期回填 | 防抖 + 请求代际取消；resolve 惰性化；isIncomplete 续查 |
| 快捷键冲突 | IDEA 键位与应用/系统习惯冲突（Ctrl+W/N/P 等） | when-context 路由；冲突项文档化并留别名 |
| 搜索性能 | 超大仓库 Find in Files | 流式分批 + 上限截断 + 可取消；ignore crate 跳过 .gitignore |
| 分屏共享 buffer 复杂度 | 双 view 已可用，递归 layout 后同步/焦点/关闭更易竞态 | 保持单 buffer ownership；先定义递归 layout state 与迁移，再逐步开放 nested split |
| Inlay hints 抖动 | 编辑时 hint 频繁重排 | 视口 range + 滚动/编辑防抖；默认关，用户主动开启 |
| 底部终端生命周期 | 工作区关闭时 PTY 泄漏 | 随 tab 卸载显式销毁；复用现有 TerminalPanel 清理路径 |
| Action registry 双真值 | 静态 catalog、旧 `WorkspaceCommand[]`、CodeMirror keymap 和菜单可能出现 ID/when/handler 分叉 | 先做全量 ID 对账和 migration adapter；registry 订阅快照成为唯一入口；未知/重复 ID 在开发期硬失败 |
| EditorConfig 误解析 | 父目录链、glob 相对路径、`root=true`、外部变更和非法值处理错误会 silently 改变格式 | resolver 与 parser 分层；缓存带 mtime/hash；逐字段 provenance/diagnostic；fixture 覆盖嵌套与 root stop |
| 保存规范化破坏文本 | formatter、EOL、charset、trim/final-newline 顺序错误，或异步期间覆盖新编辑 | 以最新 dirty snapshot 重跑；normalize 失败零落盘；编码不可表示/外部 hash 冲突明确阻断并保留恢复入口 |
| Capability stale merge | 空 capability 摘要保护可能把旧 session 的能力带到新 provider | 用 session generation + provenance；新 session 先 reset 为 unknown，只有同代空增量才允许保留 |
| CM memo comparator stale callback | 忽略 callback identity 后新增 prop 未同步 ref/comparator，旧闭包继续执行 | prop matrix 契约测试；行为 prop 必须有 ref、比较和 unmount/rapid-switch 回归 |
| Completion 过度截断/误判上下文 | 200 项 cap、Lezer 节点名差异、lexical fallback 可能隐藏合法候选或在字符串中误触发 | 返回 truncation/source/reason；显式/trigger/typing 分流；跨语言 syntax fixture 和真实 p95 门禁 |
| 范围蔓延 | “像 IDEA”没有边界，伴随能力容易挤占编辑器主线 | 以 §2.3 能力边界和 §8.2 排序评审；X 轨道独立记账 |

---

## 10. 已定原则与待决实现选择

1. **参考基线已定**：IntelliJ IDEA 2026.2 Core Editor + Java；其他语言逐 provider/fixture 记账，不宣称整体现代 IDEA 等价。
2. **范围已定**：Build/Run/Debug/Test/Coverage、Terminal、Git Manager、AI、远程工作区为 X 轨道；只把其 editor action/gutter/navigation 计入 Editor。
3. **Code style 优先级已定**：explicit file override > EditorConfig > language/workspace default > sniffed fallback；状态栏必须展示最终值与来源。
4. **Keymap 路线已定**：P0 先交付 IDEA platform defaults 与自定义 scheme；schema 为 VS Code/其他 preset 保留扩展，但 preset 内容不阻塞首批。
5. **语义路线已定**：provider-first；Java 建最小声明/引用/type index 和 inspection/data-flow 垂直切片。待决的是 parser/index 技术选型与持久化格式，不是是否需要语义层。
6. **模板/生成路线已定**：只有通过 type/context/provider 校验的变换才计作语义能力；固定文本模板可保留，但必须标为 local template。
7. **布局路线已定**：现有双 group 保持兼容，P2 迁移为递归 layout tree；detach 是否使用 Tauri 独立窗口在 A2 spike 后决定。
8. **默认显示已定**：inlay hints 继续默认关、semantic highlighting 默认按 provider 开、large-file 自动降级；每项必须可解释并可按语言配置。
9. **Full Line 边界已定**：只对齐 IDEA Ultimate 默认 bundled plugin 的 Code Editor 工作流，Java 先行、本地离线和隐私为验收条件；不因此纳入 AI Assistant 或通用插件兼容。
10. **运行时真值已定**：`workspaceActionRegistry` 是目标唯一 action truth；当前静态 catalog/旧 `WorkspaceCommand` 仅视为迁移输入，不能作为完成证据。`when` 必须是可验证的结构化表达式，action state 必须携带来源、freshness 和 completeness。
11. **EditorConfig 解析边界已定**：parser 无文件系统副作用，resolver 负责父目录链、root stop、缓存/失效和 provenance；仅有 EOL/charset 等非缩进属性也必须生效；保存 normalize 与 formatter 是两个可观察阶段。
12. **Completion 性能语义已定**：80ms debounce、trigger immediate、200 项 cap 是性能护栏而非 IDEA Smart Completion；request reason、session/document generation、truncation/source 必须显式可观测，不能用提高 cap 或静默 fallback 宣称语义完成。
13. **仍待决**：Java parser/index 方案、Structural Search query model、Full Line 模型/runtime 选型、clipboard history 的隐私/保留策略、scratch/injection 的文件所有权，以及三端真机设备矩阵的具体机器清单。

---

## 11. Java 深度支持历史计划（v3.0，M6–M11）

> 本节保留 M6–M11 的 Java 工程、测试与调试实施记录。v4.30 起，jdtls 编辑语义、Java index/inspection/refactor 归 Editor 的 J1–J3；Build/Run/Test/Debug/DAP 归 X 轨道。目标、状态和下一顺序以 §2、§2.9 与 §8.2 为准。

### 11.0 现状盘点（As-Is，Java 视角，v4.23 复核）

| 领域 | 现状 | 载体 |
|------|------|------|
| jdtls 初始化 | `settings.java` 已覆盖 runtimes、autobuild、completion/format/import/codeGeneration、CodeLens、signature help、inlay hints、classpath severity；支持 didChangeConfiguration 热更新与可选 Lombok javaagent | `lsp.rs` `lsp_initialization_options`、`lsp_set_java_settings`；仍需真实 jdtls/bundle 验收 |
| 文档同步 | 已支持 incremental sync、large-file guard（语义装饰降级）和全量兜底；ChangeSet→LSP 全量重写仍明确后置，前端仍有受控文本物化成本 | `CodeMirrorHost.tsx`、`useWorkspaceLspSession.ts`、`largeFile.ts`；需三端大文件/外部编辑真机验证 |
| 诊断 | 已有 push diagnostics、LSP 3.17 workspace pull diagnostics、partial/related/refresh 基础和全项目聚合命令；Problems/Analysis 仍以 provider 结果为准，没有自有 inspection/data-flow | `lsp.rs` `lsp_workspace_diagnostics`、`CodeWorkspaceTab.tsx`、`AnalysisPanel.tsx` |
| 库源码 | jdt:// 反编译 + 按需 Download Sources（已实现） | `lsp.rs` `lsp_download_sources`（约 3502 行） |
| Run/Tasks | `workspace_execution_model` 提供 provider targets、shared/local/provider named configuration、runtime/env/dotenv/Before launch/compound；`workspace_task_tree` 提供 wrapper 优先的 task tree；Java main/Maven/Gradle/单文件 Run、Java test discovery/run/debug 和 JUnit XML ingestion 已接入 PTY/DAP | `workspace_execution.rs`、`workspace.rs`、`RunPanel.tsx`、`BuildPanel.tsx`、`javaTestRun.ts`；execution model、task tree、jdtls module 查询尚未统一为 imported module/artifact graph；coverage 报告展示已有，typed Run with Coverage、采集/合并与真实 output 仍缺 |
| 调试 / 测试 | 通用 DAP 内核、Java adapter、line/function/data/instruction/exception breakpoint、memory/disassembly、compound session、变量/栈/console、Java test debug、JUnit 结果树与 LCOV/JaCoCo coverage 展示已形成代码闭环 | 真实 Java/JS/Python/Go/Rust/C++ adapter trace、IDEA 专有 breakpoint properties、Run with Coverage 配置/采集、非 JUnit provider 协议、跨平台进程/路径/权限和真实工程结果仍缺；synthetic fixture 不是 adapter 证据 |

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

**✅ 已交付（`4929467`）**：新 `java_bundles.rs`——`resolve_bundle_jars`/`probe_bundles` 从配置目录按版本号（数值比较,非字典序）选最高版 `com.microsoft.java.{debug,test}.plugin-*.jar`,或接受显式 jar 路径;进程级 `CONFIGURED_JAVA_BUNDLES`。`lsp_initialization_options` 在配置存在时注入 `"bundles":[…]`（否则省略）。命令 `lsp_set_java_bundles`/`lsp_detect_java_bundles`;前端 `LSP_JAVA_BUNDLES_KEY` 持久化 + 启动推送 + Settings「调试与测试扩展」子区（路径输入 + detected/not-found 探测）+ en/zh。**修订**:Lombok **不是 bundle**——仍走 `-javaagent`(§11.A);bundles 只装 java-debug/java-test。**范围**:本期做路径配置 + 探测,自动下载留作 §12 X 轨道发行打包决策。单测 5(版本选择/显式 jar/探测/空);jdtls 实际加载 jar 为真机项。

### 11.F 构建集成（M7，增强现有 Run/Tasks，规模 M–L，风险中）

**现状**：`workspace.rs:115` 已探测任务并 PTY 运行，扁平命令列表。**增强**：

- **依赖树视图**：`mvn dependency:tree` / `gradle dependencies` 解析，或 jdtls `java.project.getClasspaths`；树形展示 + 版本冲突标记。
- **生命周期/任务树**：Maven phases、`gradle tasks --all` 解析为可点击树（现为扁平列表）。
- **项目重载**：pom.xml/build.gradle 变更 → `java/projectConfigurationUpdate`（Download Sources 路径已部分具备），补「检测到构建文件变化 → 提示重载」。
- **模块/源集视图**：多模块工程 module 结构（jdtls `java.project.getAll`）。

**本阶段未完成**：IDEA 级 facet/source-set/language-level 建模仍是工程模型 Gap；复杂运行配置参数、仓库共享配置和 compound Run/Debug 已由 M11 形成基础代码闭环，active profile UI 与 coverage 报告展示后来已补，仍缺 typed Run with Coverage/采集/合并、非 JUnit provider 统一结果协议与完整 adapter 矩阵。这些按 §12 的 X 轨道验收。

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

### 11.G Java Build/Run 可执行闭环（M10，历史 X，规模 M）

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

历史背景：调试曾被早期 §2.3 排除，后作为完整 IDE 的伴随能力实施；v4.29 起统一归 X 轨道。**既有 DAP 架构决策：从 D1 起抽通用 DAP 框架**——语言无关内核 + 适配器注册表；Java 只是首个适配器，D3–D5 的断点/单步/变量/求值全部走**语言无关**的会话状态与前端面板，不写 Java 特判。后续 Node/Go/LLDB 等只需新增一个适配器定义。

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
- **D5.2 data breakpoint/watchpoint（`596759d`）**：**✅ 代码闭环**。停驻的 Variables 或 Watch 行先调用标准 `dataBreakpointInfo`，只有 adapter 返回的 opaque `dataId` 才允许创建；`canPersist=true` 项按 `adapterId` 写入 workspace storage，`canPersist=false` 项只按 owner `sessionId` 存活。初始化恢复严格排在 `configurationDone` 前；标准 `setDataBreakpoints` 采用全量替换，支持 access type、condition、hitCondition、启停、Mute/Remove All、binding verified/pending/failed、compound adapter/session scope、终止清理和 stale-response generation guard。address/bytes 与源代码入口在 D5.6 单独收口，D5.2 的标准 watchpoint 生命周期不因此变成 IDEA 严格完成。
- **D5.3 conditional exception filters（`1f2d93b`）**：**✅ 代码闭环**。完整解析 `exceptionBreakpointFilters` 的 label/description/default/supportsCondition/conditionDescription；用户显式启停与条件按 workspace + adapter + opaque filter id 有界持久化，新 filter 才采用 adapter default。初始化时在 `configurationDone` 前发送全量替换请求：无条件项及旧 adapter 走 `filters`，只有同时声明 filter condition 和 `supportsExceptionFilterOptions` 时才走 `filterOptions`；未广告 filter 的 adapter 不发送协议禁止的请求。运行中编辑只同步同 adapter 的 initialized compound children，并接入 Mute/Remove All、请求失败 console、verified/pending/failed 响应、breakpoint event id 路由、termination 清理和 per-session stale-response guard。**该阶段边界**：adapter filter 集合不是 IntelliJ IDEA 的任意异常类/包规则；标准 `exceptionOptions` 后由 D5.4 形成代码闭环，exception `breakpointModes` 的 `filterOptions.mode` 已由 D5.5 接入，但 IDEA 专有属性、Java/JS/Python/Go/Rust/C++ 的表达式/路径语法、真实绑定与三端行为仍待后续矩阵验收。
- **D5.4 exception path rules（`4510aa2`）**：**✅ DAP 代码闭环**。新增标准 `ExceptionOptions`、`ExceptionPathSegment` 和 `never`/`always`/`unhandled`/`userUnhandled`；规则 id/path/names/negate/mode 按 workspace + adapter 有界持久化，损坏的非空 path 被拒绝而不会意外扩大成 whole-tree。只有 adapter 同时广告 exception filters 和 `supportsExceptionOptions` 才允许创建/发送；请求严格合并为 `filters → filterOptions → exceptionOptions` 的位置绑定顺序，在 `configurationDone` 前恢复，运行中只同步同 adapter 的 initialized compound children，并接入启停、Mute、Remove All、请求失败 console、verified/pending/failed、breakpoint event id、termination cleanup 和 generation guard。DebugPanel 支持类/包 pattern、四种 break mode、多 path segment、name alternatives、negate、编辑/删除和 unsupported/binding 状态。**未完成边界**：DAP 没有规定 adapter 的 exception tree、wildcard 或语言继承语义，因此此提交不能单独证明 IDEA“指定异常及其子类”；也不表达 IDEA catch-site/throw-site class filters、caller/instance filters、pass count reset、condition/evaluate-log/remove-once/suspend-policy/dependency 等属性。exception `filterOptions.mode` 已由 D5.5 统一接入；真实 adapter/三端矩阵仍待验收。
- **D5.5 breakpoint modes（`f3363ad`）**：**✅ DAP 代码闭环**。解析并去重 adapter `breakpointModes` metadata，按 `source`/`exception`/`data`/`instruction` applicability 过滤并以 adapter 顺序提供默认值；source mode 按 adapter id 持久化并写入 `setBreakpoints`，exception mode 在 `supportsExceptionFilterOptions` 时写入 `filterOptions.mode`，data mode 只写入 `dataBreakpointInfo.mode` 并随 adapter-owned watchpoint 保存，instruction mode 由 D5.7 写入 `setInstructionBreakpoints`；compound session 仅向同 adapter 子会话广播，UI 控件均 capability-gated。**未完成边界**：DAP metadata/字段路由不等于硬件/软件断点真实行为；IDEA catch/throw/caller/instance 等属性、各语言 adapter 合约和三端真机仍待验收。
- **D5.6 data address/range 与 source field declaration（`ac42f63`）**：**✅ 客户端代码闭环**。当 adapter 广告 `supportsDataBreakpointBytes` 时，DebugPanel 提供 stopped 状态下的表达式/十进制或 `0x` 地址、正整数 `bytes` 和 address 模式；`dataBreakpointInfo` 只在 capability gate 通过时携带 `bytes`/`asAddress`，地址模式拒绝 `frameId`/`variablesReference`，持久化 watchpoint 保留 discovery 元数据但 `setDataBreakpoints` 不误发 discovery-only 字段。编辑器右键入口基于当前 LSP `documentSymbol` 的 `Property`/`Field`/`Constant`/`EnumMember` 声明识别字段，并复用 selected frame 的 discovery。**未完成边界**：`supportsDataBreakpointBytes`/`asAddress` 属 adapter 扩展能力，不能证明真实 adapter 对地址宽度、字节范围、读/写触发、对齐、生命周期或硬件/软件绑定的解释；LSP symbol kind 也不是 PSI/字段语义，无法覆盖隐式字段、宏/生成代码、重载属性或 IDEA 的 field-read/field-write 属性。真实 data watchpoint、memory read/write、disassembly、语言 adapter contract fixture 与三端真机仍待实现/验收。
- **D5.7 instruction breakpoint（`f5d027ea`）**：**✅ DAP 客户端代码闭环**。解析并持久化 adapter-owned opaque `instructionReference` 与有符号十进制安全整数 `offset`，以 adapter + reference + normalized offset 建立稳定 identity；只有 `supportsInstructionBreakpoints` 为真时才发送全量替换 `setInstructionBreakpoints`，condition/hitCondition 与仅适用于 `instruction` 的 adapter mode 一并传递。初始化恢复严格位于 `configurationDone` 前，运行中只同步同 adapter 的 initialized compound children，并接入启停、Mute/Remove All、verified/pending/failed binding、breakpoint event id 路由、终止/launch failure cleanup、per-session stale-response generation guard 和有界 workspace storage。DebugPanel 提供 reference/offset/mode 创建、编辑和 unsupported 状态，窄 dock 下 option controls 可换行。**未完成边界**：reference 是 adapter-owned opaque string，客户端不能证明它是合法 CPU 地址或 executable instruction；offset 的单位/地址宽度、ASLR/module reload、硬件/软件实现、condition/hit count 支持和错误语义均须真实 adapter contract 验证。memory read/write/disassembly 当时尚未实现，Java/JS/Python/Go/Rust/C++ adapter matrix 与三端真机仍待完成。
- **D5.8 memory read/write 与 disassembly（当前阶段）**：**✅ DAP 客户端代码闭环**。只有 adapter 分别广告 `supportsReadMemoryRequest`、`supportsWriteMemoryRequest` 或 `supportsDisassembleRequest` 时才显示/发送对应请求；`readMemory`/`writeMemory`/`disassemble` 参数采用有界 memory reference、safe integer offsets 和 count，响应 parser 限制 base64/instruction 数量与字段长度。DebugPanel 提供 memory reference、signed byte offset、read count、hex bytes write（转 DAP base64、`allowPartial:false`）、instruction offset/count、resolve symbols 和 bounded disassembly rows；session termination/compound selection stale-response 会被丢弃，错误写入 Debug console。**未完成边界**：DAP 客户端不能证明 adapter 对地址宽度、权限、partial write、target memory consistency、endianness、符号解析、instruction bytes、source mapping 或 running/stopped 生命周期的解释；尚无 memory change event/编辑器地址联动、真实 Java/JS/Python/Go/Rust/C++ adapter contract fixture 与三端真机证据。
- **D5.9 adapter contract fixture（`dfa09b48`）**：**✅ 协议边界代码闭环**。`dapAdapterContracts.ts` 为 Java/java-debug、JavaScript/vscode-js-debug（`node`）、Python/debugpy、Go/Delve、Rust/lldb、C++/lldb 建立六项 fixture；Rust/C++ 共享 `lldb` adapter id 但保留独立 source vector。评估器只读取 adapter initialize 的 `supportsReadMemoryRequest`/`supportsWriteMemoryRequest`/`supportsDisassembleRequest` 与 `breakpointModes`，不按语言、运行时或 adapter id 猜测支持；测试覆盖 opaque memory reference、signed byte offset、read range、显式 `allowPartial:false`、instruction offset/count、hex/base64、symbol/source mapping、sourceReference 和 mode applicability。**未完成边界**：advertised profile 是 synthetic test input，不是真实 adapter 版本证据；仍须用各 adapter 的 initialize/DAP trace 验证地址宽度、读写权限、partial write、target memory consistency、endianness、instruction bytes、符号解析、source mapping、mode 行为及 running/stopped 生命周期，并补 memory change event/编辑器地址联动和三端真机矩阵。
- **D5.10 project/module/source-set/language-level/compile-artifact baseline（`3dde3e76`）**：**✅ 结构化契约代码闭环，非 IDEA 工程模型完成**。`ProjectModel` 具有稳定 `moduleId` 与声明语言级别；`ModuleModel` 连接 project、manifest 和 source sets；`SourceSetModel` 有 production/test/generated kind、根路径、generated 标记及语言级别；`BuildTarget` 绑定 module 并声明 `CompileArtifact`。Cargo、Go、Python、Node、Maven、Gradle、sbt、.NET、CMake、SwiftPM 均可记录 provider 声明的语言级别；Maven 一层属性引用（如 `${java.version}`）会解析到实际值。artifact 的 `path` 保持 `None`，工具可用但未从真实 provider output 回填时为 `pending-provider-output`，工具配置无法解析时为 `blocked` 并保留 command error；这避免把 `target/`、`build/` 或 `bin/` 约定路径伪装成 IDEA 的真实 compiler output。

  **未完成边界**：当前发现器刻意维持单 manifest→单 module，不能代表 Maven/Gradle 多模块 import、父子继承、active profile、variant/source-set override、facet、依赖/SDK/order-entry 图、冲突和离线状态；没有 IDE compiler/cache、background/incremental/single-file compile、真实 build output ingestion、artifact/JAR 源码映射，也没有把 Run/Debug 配置绑定到 module/artifact selection。下一阶段应以 provider-owned import snapshot 和真实 build result ingestion 为入口，先补 Maven/Gradle 多模块，再补通用 artifact 绑定；三端真机 build/run/debug 仍是验收门禁。

**前端**：底部 Debug 面板（调用栈/变量/监视/line/function/data/instruction breakpoint/memory/disassembly/exception filters/exception path rules/console）+ 编辑器断点 gutter + 悬浮运行工具条，**均按 DAP 标准模型渲染，与语言无关**；D5.6 增加 capability-gated 的 stopped 表达式/地址/范围创建入口和基于 LSP symbol metadata 的字段声明右键入口，D5.7 增加 instruction reference/offset/mode 入口，D5.8 增加 capability-gated memory reference/hex read-write/disassembly 工具区。入口可发现性不等于 PSI 字段语义、真实 watchpoint/CPU instruction/memory 绑定；exception path editor 完整保留标准 path segment/name alternatives/negate/break mode，但不能虚构 adapter 未承诺的 Java 类继承或 IDEA 专有 filter 语义。适配器专属能力（如 Java 热重载、data/instruction/memory breakpoint 支持与访问模式、exception filter condition/path）按 D1 下发的 capabilities/适配器能力位开关（沿用 §5.2.0 capability 驱动模式）。

- **D6 IDEA 成熟度收口**（缺陷修复 + 补齐，规模 M）— **✅ 已交付**。
  **历史 X 轨道阻断缺陷**：① 会话中新增/改条件的断点**从不生效**——`toggleBreakpoint`/`setBreakpointOptions` 在 `setBreakpoints` 的 state updater 内同步调用 sync，读到的是**改动前**的 ref，推给适配器的是旧集合；改为「先算新集合 → 同步更新 ref → 显式传 list 给 sync」的单一变更入口（`mutateBreakpoints`），并加 per-path generation 防止旧响应覆盖新集合。② Windows 长 classpath 启动失败（`CreateProcess error=206`）——java-debug 默认不缩短命令行，现默认 `shortenCommandLine: "auto"`（可覆盖），对齐 IDEA 的 shorten command line。③ **stdio 适配器死锁**——`connect_transport` 管道化 stderr 却无人排空，管道写满后适配器永久阻塞；新增 `run_stderr_pump` 转成 `output` 事件（Java 走 TCP 不受影响，但这是多语言框架的通用缺陷）。④ **反向请求无人应答**——内核只转发不回复，发 `runInTerminal`/`startDebugging` 的适配器会一直等；`reverse_response` 统一回失败响应。⑤ `initialize` 无超时 → UI 永久卡「starting」；加 20s 上限。⑥ EOF 时后端会话从 map 移除，前端不在也不泄漏；Stop 优先走 `terminate`（capability 判定）再 `disconnect`。
  **IDEA 对齐（均为语言无关 DAP 层）**：断点视图（全工作区列表 + 单个启用/禁用 + Mute All + Remove All + 点击跳转 + 条件/命中次数/logpoint 内联编辑，取代原先三连 modal prompt）；编辑器悬停求值（停驻时接管 LSP hover）；行尾 inline values（仅渲染到当前执行行）；调试快捷键 F9/F8/F7/Shift+F8/Ctrl+F8/Ctrl+Shift+F8/Alt+F9/Ctrl+F2；`thread` 事件维护线程列表；Stop 后保留 console（含 Clear）；库/反编译栈帧经 DAP `source` 请求打开只读缓冲区。
  **Java 适配器**：远程 attach（IDEA Remote JVM Debug，`hostName`/`port`，跳过 mainClass/classpath 解析）；显式 mainClass 缺 projectName 时回填所属工程（多模块下避免解析错模块）；`sourcePaths`/`stopOnEntry`/`encoding`/`shortenCommandLine` 透传。
  测试：Rust 24（新增 reverse-response、attach 参数、shortenCommandLine/透传）；前端新增 `useCodeDebugSession.test.tsx`（9，含旧缺陷回归）+ `debugEditorChrome.test.ts`（7）+ 模型/面板补充。**真机冒烟仍由用户验证**（需 jdtls + java-debug bundle + Java 工程）。

### 11.E 测试集成（M8–M9，依赖 Bundle 基建 + 部分 D，规模 L）

- **探测**：java-test 命令 `java.test.findTestTypesAndMethods`（JUnit4/5、TestNG）。
- **运行**：非调试 run 经 launch（不依赖 D）；调试 run 经 D 的 DAP（依赖 D2）。Maven Surefire/Failsafe 与 Gradle JUnit XML 结果提供 pass/fail/error/skip、耗时、失败详情、源码定位和重跑；LCOV/JaCoCo 报告已有展示，Run with Coverage 的采集/配置/合并与非 JUnit provider 结果仍待统一。
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
| DAP 工程量失控 | 严格按 D1–D5 分里程碑，每阶段独立可用；沿用本节的**通用内核 + 适配器注册表**历史决策——语言相关代码集中于 D2 一处，D3–D5 走标准 DAP，避免 Java 特判蔓延 |
| Bundle 版本 / 下载 | 探测 + 版本校验 + 手动路径回退（同现有 jdtls 模式）；不强制自动下载 |
| Lombok javaagent 路径 | Settings 显式配置 + 探测；缺失时降级提示而非静默报错 |
| 大文件增量与 server 不同步 | ChangeSet 映射 + 全量兜底（已有 catch）+ 版本代际校验（已有 epoch guard） |
| jdtls 内存（默认 1G） | M6-A 把建议 vmargs（如 `-Xmx2G -XX:+UseG1GC`）写入设置提示；大型工程引导上调 |
| 冷启动慢 | 与本计划正交；可另做「导入进度」可视化（承接 jdtls `language/status` 通知） |
| 静态 main 发现不是完整 Java AST | 先剥离注释/字面量并严格匹配合法 signature；jdtls/java-debug 可用时 Debug 仍走语义解析；后续 Run Configuration model 可增加 jdtls resolve 作为增强而非硬依赖 |
| Gradle 工程高度可定制 | init script 不改工程且使用 sourceSets runtimeClasspath；标准多模块使用 qualified task；自定义 `projectDir`/Android 等明确降级到自定义 task，避免伪支持 |
| Maven exec plugin 首次下载 | 固定 plugin 版本保证可重复；离线缓存缺失时在真实终端显示 Maven 原始错误，不吞错 |
| 范围蔓延 | §2.3 是当前范围基线：只把影响 Editor 语义的工程上下文/index/data-flow 放入 J1–J3；执行与调试按 X 轨道独立记账 |

### 11.10 历史交付记录（原 P0–P3）

以下只记录对应提交中已经出现的代码入口，不代表 §2.4 的 L3 对照等价，也不再作为下一步待办顺序。

#### 原 P0：高频快捷键与动作 — **代码入口已交付**
1. **✅ `Ctrl+Shift+U` 字母大小写切换 (Toggle Case)**：在 `workspaceEditorCommands.ts` 中实现选区或光标所在词的大写/小写/驼峰循环切换，并在 `workspaceEditorKeymap` 中绑定 `Mod-Shift-u` / `Ctrl-Shift-u`（单测覆盖）。
2. **✅ `F2` / `Shift+F2` 诊断错误/警告快速跳转 (Next/Prev Highlighted Error)**：在编辑器内计算下一个/上一个诊断位置并移动光标展示错误气泡，支持环形回卷（wrap-around）；左侧树中保留树重命名逻辑。
3. **✅ `Ctrl+P` 参数信息主动提示 (Parameter Info)**：注册 `workspace.parameterInfo` 命令并在 CodeMirror 中绑定 `Mod-p` / `Ctrl-p`，在编辑器光标处显式唤起 LSP 签名提示浮层（释放 Ctrl+P 快捷键）。
4. **✅ `Ctrl+Shift+I` 快速定义预览 (Quick Definition Peek)**：绑定 `Mod-Shift-I` 直接唤起 `LocationPeek` 浮层预览定义代码，无需改变当前编辑焦点。
5. **✅ `Ctrl+Alt+O` 优化导包 (Optimize Imports)**：向语言服务器发送 `source.organizeImports` 代码操作，自动清理未使用导入并排序。

#### 原 P1：交互质感与上下文感知 — **代码入口已交付**
1. **✅ `Ctrl+Shift+F10` 上下文运行当前文件 (Run Context Configuration)**：注册 `workspace.runContextConfiguration`，根据当前活跃文件类型或 main 方法直接启动当前目标。
2. **✅ `Alt+F1` 定位到项目树 (Select in Project View)**：注册 `workspace.revealActiveFileInTree`，将左侧文件树滚动并选中当前编辑器激活的文件节点，支持在项目树折叠状态下自动展开左侧面板。
3. **✅ Sticky Lines (编辑器头部吸顶上下文/作用域)**：实现 `computeStickyLines` 递归提取包/类/函数声明行并在编辑器顶端展示浮层（支持点击快速跳转与首选项开关），在 `EditorGroup` 与 `CodeWorkspaceTab` 完成无缝挂载并附完整单测。
4. **✅ `Ctrl+Shift+F9` 重新编译当前文件 (Recompile Active File)**：注册 `workspace.recompileActiveFile`（`Mod-Shift-F9`），支持自动保存 dirty 缓冲并对当前工程执行单文件/增量重新编译。

#### 原 P2：重构动作与高级调试 — **provider/代码入口已交付**
1. **✅ `Ctrl+Alt+Shift+T` 重构上下文弹窗 (Refactor This)**：注册 `workspace.refactorThis` 命令，唤起当前光标处的全部重构选项；补齐标准重构快捷键 `Ctrl+Alt+V`（抽取变量）、`Ctrl+Alt+M`（抽取方法）、`Ctrl+Alt+N`（内联）、`Ctrl+F6`（更改签名）、`F6`（移动）。
2. **✅ 调试工具栏与命令静音所有断点 (Mute Breakpoints)**：注册 `workspace.toggleMuteBreakpoints` 命令，与 DebugPanel 工具栏联动切换静音状态；注册 `Ctrl+F8`（切换断点）、`Ctrl+Shift+F8`（查看/编辑断点）。
3. **✅ 多模块 Maven Active Profile / Gradle 属性覆盖界面**：在 `RunConfigurationOverride` 与 `RunPanel` 界面中提供 Active Profiles（Maven `-P` / Spring profiles）与 JVM/Build Properties（`-Dkey=value`）输入与持久化，自动注入运行时参数，并支持临时配置标记与副本命名保存。

#### 原 P3：重构预审、覆盖率、键位速查与图谱 — **界面/协议入口已交付**
1. **✅ 重构预审用法树与复选框过滤 UI**：实现 `RefactoringPreviewDialog` 弹窗，按文件分组呈现 raw WorkspaceEdit、行号和新文本，并可逐 edit 包含/排除。语义依赖、conflict 与安全排除仍属于 §8.2 J3。
2. **✅ 缩进检测与状态栏标签 UI**：`detectIndentation` 可识别 2/4 spaces 与 tabs，状态栏可循环标签；当前没有改变 CodeMirror/LSP formatter 行为，实际切换属于 §8.2 E1.1。
3. **✅ 快捷键速查与物理键帽 UI**：`KeymapCheatSheetDialog` 可分类、搜索和执行固定命令。可编辑 scheme、录键、反查、冲突与迁移仍属于 §8.2 E2。
4. **✅ 测试覆盖率报告解析与编辑器覆盖条 (Test Coverage Ingestion, Gutter & Dock Panel)**：实现 `coverageModel`（支持 LCOV 与 JaCoCo XML 格式报告解析及多模块文件路径匹配）、`coverageEditorChrome`（CodeMirror 侧边栏绿/黄/红三色覆盖指示条）与 `CoveragePanel`（底部 Dock 统计面板、进度条、文件过滤与未覆盖行跳转），注册 `workspace.showCoverage` 命令并与工作区扫描联动。
5. **✅ 多语言 DAP 适配器引导与配置模板 (DAP Debug Adapter Setup Guide & Templates)**：实现 `DapAdapterGuideDialog` 覆盖 Java (JDWP)、JavaScript/Node (`vscode-js-debug`)、Python (`debugpy`)、Go (`dlv`)、Rust (`lldb-dap`)、C++ 适配器的安装指南、运行环境规范与 `.taomni/run-configurations.json` 模板一键复制，注册 `workspace.openDapAdapterGuide` 命令。
6. **✅ 工程模型多模块依赖拓扑与模块层级 (Multi-Module Dependency Topology in BuildPanel)**：在 `BuildPanel` 中呈现多模块工程的完整模块树、模块语言级别徽章与 `dependsOn` 依赖链，打通与底层 `workspaceExecutionModel` 的深度联动。
7. **✅ Debug 变量树与调用栈右键快捷菜单 (Variable Tree & Call Stack Context Menus)**：在 `DebugPanel` 中支持对变量节点右键直接触发「添加数据断点」、「添加到监视」、「复制变量值/名称」、「设置变量值」；支持对调用栈帧右键执行「Jump to Source」、「Drop Frame / 栈帧重置 (`restartFrame`)」、「复制调用栈」等高频动作。
8. **✅ 调试单步过滤配置 (Step Filters: 跳过 JDK/标准库/框架代码)**：在 `WorkspaceBuildRunToolsDialog` 中提供 Step Filters 开关与规则配置（可自定义类与包过滤模式、跳过 synthetic 方法、跳过 `<clinit>` 静态初始块、跳过构造函数），并在启动 DAP 调试时自动装配注入调试器启动载荷。
9. **✅ 分屏编辑器同步滚动联动 (Synchronized Split Scrolling Toggle)**：在顶部工具栏与命令面板（`workspace.toggleSyncSplitScroll`）提供双向视口滚动镜像联动与防递归事件门禁，方便并排对比代码或跨文件审查。
10. **✅ QA UI 自动化端到端用例编目沉淀 (`qa-ui-auto-tests/`)**：在 `feature-list.md` 中为 F25.1 补齐 step filters 与 split sync scroll 交互控件定义，同步刷新 `references/testid-catalog.md` 与 `TC-auto-F25-1` 自动化用例覆盖。

---

## 12. 后续进阶路线与三端真机验收计划

本节只维护 X 轨道和最终真机门禁；Editor P0/P1/P2 待办见 §8.2。

### 12.1 Build / Compile graph

- [ ] 为 Maven/Gradle 多模块建立 provider-owned、可版本化 import snapshot：父子继承、active profile、variant/source set、依赖/SDK/order-entry、冲突、离线和导入诊断。
- [ ] 让 `workspace_task_tree`、`workspace_execution_model`、jdtls module 查询和 `BuildPanel` 消费同一 graph；移除固定 common-task 清单对“已导入任务”的冒充。
- [ ] 解析真实 compiler output、artifact/JAR、generated roots 和 source mapping；失败、取消、部分成功、stale result 不得覆盖新结果。
- [ ] 绑定 module/artifact 到 Before launch、Run/Debug classpath，补 single-file、incremental、background compile 和 run-before-compile。

### 12.2 Run / Test / Coverage

- [ ] 增加 temporary/permanent、folder、typed provider schema、module/artifact/coverage selection、macro/secret/credential 与完整 validation。
- [ ] 将 LCOV/JaCoCo 展示升级为 Run with Coverage 的采集、配置、合并、历史、source mapping 和多模块生命周期；明确 Cobertura、pytest、Go、LLVM 等 provider 的支持边界。
- [ ] 定义统一 test provider protocol，覆盖动态/参数化测试树、history、failure rerun/debug、duration/output 和非 JUnit 结果。
- [ ] 三端保存真实 build/run/test/coverage 证据；报告解析单测不能替代工具真实执行。

### 12.3 Debug adapter matrix

- [ ] 用 Java/JavaScript/Python/Go/Rust/C++ 真实 adapter initialize/DAP trace 替换 synthetic profile，记录地址宽度、权限、partial write、指令引用、异常继承/path、source mapping 和生命周期。
- [ ] 对照 IDEA 验证 method enter/exit、field read/write、caught/uncaught、caller/instance filter、suspend policy、temporary/dependent breakpoint、pass-count/log/condition、smart step、force return、hot swap 和 coverage binding。
- [ ] adapter 失败、能力缺失、旧响应、进程退出和 compound session 必须可见且可恢复；不得用 DAP capability fixture 宣称 adapter 语义完成。

### 12.4 三端最终门禁

- [ ] **Linux**：Ubuntu Wayland/X11，IME、US/非 US 键盘、剪贴板、字体 fallback、大小写敏感 FS、watcher、PTY、Java/TS 大工程和安装包升级/恢复。
- [ ] **macOS**：Apple Silicon（Intel 至少一套），Cmd/Option/dead key、IME、Retina/字体、APFS 大小写模式、签名/quarantine、zsh PATH 和子进程清理。
- [ ] **Windows**：Windows 11，WebView2/IME/AltGr/OEM、CRLF/BOM、NTFS + UNC/长路径、锁定文件、junction/symlink、高 DPI、PowerShell/cmd 和安装包升级。
- [ ] 每个 fixture 保存应用/OS/WebView/工具链版本、操作步骤、脱敏 LSP/DAP trace、性能数据、截图/日志和时间戳；浏览器 stub、jsdom、Vitest、Rust protocol tests 只能作为单元证据。

### 12.5 交付顺序约束

X 轨道不阻塞 Editor E0–E4 的代码正确性工作，但在发布“IDE 全工作台”前必须完成 X 的真实工具与三端门禁。任何 X 轨道新 UI 若影响 editor action、gutter、navigation、state 或 accessibility，必须回到 §2.5 追加对应 Editor fixture。
