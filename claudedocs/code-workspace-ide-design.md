# Code Workspace IntelliJ IDEA Code Editor 对齐方案

> 目标：以 **IntelliJ IDEA 2026.2 的公开 Code Editor 工作流**为基准，先通过编辑完整性门禁并达到 IDEA-like Core Daily Editing Profile，再以 Java 为首个语言完成可证明的 provider-backed 语义工作流。这里的“对齐”要求入口、结果、失败语义、撤销、配置和三端行为均可验证；相似 UI、协议字段存在或快捷键可触发都不等于能力完成。
>
> 日期：2026-08-25 · 版本：v4.63（W0 shell stability + shortcut ownership as-built；上一版 v4.62 为 HEAD `f572c6b8` 再审计与执行队列重置）· 状态：**实施中；R0/R1/R3/R4/R5/R7/R8 生产合同与 R2 静态 QA 门禁、R9 native harness+Linux 首批证据（C0 native 两连绿磁盘字节级证明、perf browser 基线、a11y 扫描）与 W0 shell stability/shortcut ownership（C1/C4 实跑双绿）已交付，Java Basic Completion 达 provider 层 G1 L2（Linux、jdtls 1.61/JDK 21）；R6 仍为部分闭合；G0 的代码合同已闭合但 native 故障注入与三端证据未绿；G1 仍受两个已复现 shell 缺陷、Reference/Parameter 单一通道、Java inspection/navigation/refactor 证据和 R9 三端门禁阻断；G2/G3 继续逐 capability 记账**。当前权威完成情况与目标见 §2.30，唯一可领取待办见 §8.20；§2.29/§8.19 及更早章节均降为历史证据和设计输入。
>
> 当前结论：**当前代码已从“模型很多、生产链不完整”推进到可工作的编辑器骨架，但仍不能称 IDEA-like daily editor。** 保存/恢复/WorkspaceEdit effect、ActionHost/Keymap、Basic Completion acceptance、clipboard history/virtual space、真实 ToolWindow registry 与递归 split、QuickDoc、Surround/Generate 入口、code-style scheme/reformat planner 均已进入生产链。当前阻断不再是 v4.50 记录的旧缺陷，而是：`TC-IDE-C1-01` 可复现的 workspace tree 渲染崩溃、`Ctrl+Shift+T` 在最后一个编辑器标签关闭后被 shell 抢占、Parameter Info 仍绕过统一 reference controller、`refactorApplyGate` 尚未覆盖 Rename/provider refactor、Java usages/diagnostics/refactor 缺真实 trace，以及 native 三端/IME/a11y/性能/IDEA 对照未执行。另须明确：`workspaceSemanticIndex.ts` 是 provider 结果的新鲜度台账而不是索引，`inspectionProfile.ts` 是诊断呈现过滤器而不是 IDEA inspection engine。
>
> 上一版本：v4.62（2026-08-25，HEAD 再审计/队列重置 + R9 native harness as-built）· v4.61（R2 QA catalog/workflow 修复 as-built）· v4.60（R8 Code Style D1/D2）· v4.50（2026-08-23，HEAD `69165486dee1` as-built 复核、IDEA 2026.2 能力重对齐与 R0–R9 合同）· v4.49（2026-08-23，C0–C9 实施记录；其中“G0 代码面已闭合”“browser 门禁绿”等结论已由 v4.50 撤销）。
>
> 早期版本：v4.44（2026-08-22，`85be924f` as-built 复核、IDEA 2026.2 Editor 能力第四批对照、G0/G1 目标重排与 §8.16 合同）· v4.42（2026-08-21，`d641ad12` + `9203d3e4` + `20027dfe` as-built 复核）· v4.41（2026-08-20，`c5ce1fd6` + `5ce13c9a` as-built 复核）· v4.40（2026-08-19，`a4584916` + `b4e7325f` as-built 复核与 Gate R0 回归登记）· v4.39（2026-08-19，`dab8a778` production-path code review）· v4.30（2026-08-15，Action/Style/Keymap/Semantic/Advanced 详细设计及首批模型代码）· v4.29（2026-08-15，IDEA 2026.2 editor 能力重对齐与 `ca18b396` 审计）· v4.28（2026-08-15，Refactoring usages preview、indentation detection 与 keymap cheatsheet）· v4.27（2026-08-15，Sticky Lines, Ctrl+Shift+F9 & Run Profile overrides）· v4.26（2026-08-15，P0-P2 shortcuts & actions delivery）· v4.25（2026-08-15，IDEA editor parity backlog & execution）· v4.24（2026-08-15，IDEA editor parity & multi-module execution graph）· v4.23（2026-08-15，project model baseline）· v4.22（2026-08-15，DAP adapter contract fixtures）· v4.17（2026-08-15，DAP `exceptionOptions`）· v4.16（2026-08-14，DAP conditional exception filters）· v3.2（2026-07-26，M6–M9 代码交付）· v3.1（2026-07-25，M6 代码交付）· v3.0（2026-07-25，新增 §11 M6–M9 计划并修订 §2.3 非目标）。
>
> 早期版本沿革：v2.10（2026-07-12，M0–M5 主线交付与后续收口）。

---

## 1. 现状盘点（As-Is）

| 领域 | 已有能力 | 载体 |
|------|----------|------|
| 工作区模型 | 多根目录（folder/git）+ loose files、布局恢复、最近工作区、tree/compact/flat 文件树 | `CodeWorkspaceTabInfo`、`codeWorkspaceStore`、`useWorkspaceTreeData` |
| 编辑内核 | CodeMirror 6：查找替换、多光标/矩形选择、折叠、注释、soft wrap、括号匹配/闭合、常用编辑键位、大文件降级、递归分屏与 sibling 同步滚动、preview/pin/溢出 tab | `CodeMirrorHost.tsx`、`workspaceEditorCommands.ts`、`EditorGroup.tsx` |
| 编辑效率 | LSP Basic Completion/snippet/resolve gate/一次 acceptance 与真实 jdtls fixture；同词多光标、Join Lines、Tab jump-out、Live/Postfix Templates；Java 首批 syntax-backed Complete Statement（其余显式 Local/Heuristic）、五种 Java Surround 模板、provider CodeAction Generate；EffectiveCodeStyle、参数信息、可缩放/可固定 QuickDoc | `lspCompletion.ts`、`workspaceSemanticEditing.ts`、`workspaceSyntaxFacts.ts`、`liveTemplates.ts`、`GenerateCodeDialog.tsx`、`QuickDocPopup.tsx` |
| Markdown | edit/preview/split，Mermaid 渲染 + SVG/PNG 导出 | `MarkdownPreview.tsx` |
| LSP 与分析 | 10 种语言预设 + 自定义命令；文档同步、诊断元数据、补全、签名、文档、导航/引用/层级、格式化、重命名、按 kind 请求 Code Action、inlay/semantic token、动态 capability、跨 root/language 的有界 workspace symbol 聚合、provider diagnostic presentation/related locations/structured evidence | `src-tauri/src/lsp.rs`、`src/lib/editor/lsp.ts`、`useWorkspaceLspSession.ts`、`AnalysisPanel.tsx` |
| 搜索与导航 | Find/Replace in Files、Search Everywhere、Go to File/Class/Symbol、Recent/Recently Changed Files、Recent Locations（当前为 wired/partial）、Last Edit Location、前进/后退、Outline/结构弹窗、Problems | `workspace_search.rs`、`SearchEverywhere.tsx`、`RecentLocationsDialog.tsx`、`useWorkspaceNavigation.ts`、workspace panels |
| 质量与重构 | LSP diagnostics/Code Action、明确标为呈现层的 diagnostic presentation profile；Rename、受限 Safe Delete、provider refactor kinds、可勾选 WorkspaceEdit 预览、事务 undo/redo；Find Usages identity/rerun/pin/library filter 已接线，但角色分类与 refactor evidence gate 尚未闭环 | `inspectionProfile.ts`、`javaSemanticEvidence.ts`、`ReferencesPanel.tsx`、`safeDelete.ts`、`workspaceEditHistory.ts` |
| 编辑器呈现 | breadcrumbs、sticky lines、inlay hints、semantic tokens、Git gutter/inline blame/chunk rollback、coverage gutter、TODO/书签、本地历史 | workspace chrome/panels、`coverageEditorChrome.ts` |
| IDE 伴随能力（不计入 Editor 对齐） | PTY、Build/Run/Test/Debug、DAP、工程拓扑、覆盖率报告、Git Manager、AI、远程工作区 | `workspace_execution.rs`、`dap.rs`、Run/Build/Test/Debug panels |
| 设置入口 | code view/appearance、编辑区/树缩放、LSP/Java、Live Template、可编辑 Keymap scheme、Code Style scheme/provenance/reformat planner | `editorAppearanceProfile.ts`、`WorkspaceEditorAppearanceSettingsDialog.tsx`、`workspaceKeymapScheme.ts`、`KeymapSettingsDialog.tsx`、`workspaceCodeStyleSchemes.ts`、`CodeStyleSettingsDialog.tsx` |
| 零生产 consumer 的模型/实验 fixture（不计任何能力） | Maven/Gradle 依赖补全、Full Line session 与 advanced companion 中尚无 production owner 的 SSR/advanced capability | `workspace/__fixtures__/experimental/*`、`companionCapabilities.ts`；它们有类型/纯函数/测试并不代表有用户入口、provider/runtime 或生产能力。Code Style、Surround/Generate 已迁出本行并按各自 as-built 边界记账 |
| 局部生产 evidence helper（不计本地 inspection 能力） | `inspectionEvidence.ts` 负责 provider metadata 与文本分类，并由 `AnalysisPanel.tsx` 消费 | 有 production consumer，但文本关键字只能标为 presentation hint；不得据此宣称 inspection/nullability/data-flow capability，当前边界与改造合同见 §2.30/§8.20.4 |

**当前明确缺失或被高估的 Editor 能力（v4.62 权威覆盖见 §2.30）：**

1. 两个生产可达的 shell 缺陷仍阻断 G1：`TC-IDE-C1-01` 在 Search Everywhere/Keymap 流程触发 `useWorkspaceTreeData` 的 `undefined.length` 渲染崩溃；最后一个编辑器标签关闭后 `Ctrl+Shift+T` 被 `MainLayout` 解释为 New Local Terminal，而不是 Code Workspace Reopen Closed Tab。
2. R0 已修复 v4.50 所列 intended hash、discarded writeback、closed-file committer 与 per-operation resume 缺口；当前 G0 红色来自 native 故障注入和三端证据尚未执行，而不是仍存在那些旧代码缺陷。不得继续复制 v4.50 的旧结论。
3. R6 尚未闭合：Parameter Info 仍由 `CodeMirrorHost` 的 signatureHelp 私有状态机处理，未走 `ReferenceInfoController.requestTyped`；Type Info、External Documentation 与 IDEA 2026.2 的 Expression Static Data 没有完整生产入口/provider contract；旧 `context-info` 类型不能冒充 Expression Static Data。
4. `workspaceSemanticIndex.ts` 只记录 provider query 的 revision/generation/coverage，不扫描文件、不保存 symbol/reference graph，也不等价于 IDEA 2026.2 的 Project Analysis。Java module/source-set/dependency/classpath import snapshot、degraded/ready 状态与 smart feature 可用性仍需 provider-owned 事实源。
5. Java Basic Completion 已有真实 Linux jdtls 证据，但第二次调用只会诚实记录 provider scope unchanged；completion exclude/prioritize 设置、Smart/Type-Matching expected-type evidence 与 Full Line runtime 均未实现。Full Line 按 R8 ADR 继续 defer。
6. 当前 `inspectionProfile.ts` 只隐藏或改色 provider diagnostics，suppression/baseline 也只是客户端呈现过滤；没有 IDEA-like inspection catalog/profile/scope executor、provider suppression edit、全项目检查、data-flow/nullability 或 Expression Static Data 语义。Alt+Enter CodeAction 入口存在不等于 intention/inspection 对齐。
7. Find Usages 已有 identity/rerun/pin/library filter，但 Reads/Writes/Declarations 因 provider 无角色证据而禁用，缺 scope dialog、轻量 Show Usages、recent usages 与真实 jdtls trace。声明/类型/实现/层级/Search Everywhere 虽有 LSP 入口，也未形成 Java 对照矩阵；当前 Search Everywhere browser 流程还受第 1 项崩溃影响。
8. Rename、Safe Delete 与 provider refactor actions 有入口、preview 和 WorkspaceEdit undo，但 `refactorApplyGate` 未成为 Rename/CodeAction 的共同门；Safe Delete 的完整性依赖有限 LSP references 推断，尚无 provider completeness/conflict 事实。Extract/Inline/Change Signature/Move 只能按 provider action 是否返回逐项记账。
9. R4/R5/R8 仍有体验收口：Clipboard History 限额/禁用设置未接、virtual space 跨行 visual-column 记忆和 native 像素路径未证实、region folding fallback 标签未收口、Tab Policy 无编辑 UI且 display-order/activateOnClose 未消费、Code Style saveActions/exclusion/directory/module/rearrange/cleanup 未生产化。
10. IDEA 高级能力继续缺失或明确延期：SSR、Maven/Gradle dependency completion、Full Line、Code Vision、scratch files、language injection、semantic postfix/template functions、完整 detach。已有 schema/fixture/unavailable 提示不得计为实现。
11. Linux/macOS/Windows 的 IME、非美式键盘、系统快捷键、clipboard denied、字体/高 DPI、路径/watcher、编码/锁定文件和打包应用证据仍缺。R2 静态 gate 已绿，但最近 browser 执行只有 5/6 可运行核心 case 通过，C1 失败；C0/C2/C6-02 因 native/provider 环境受阻，R9 前不得升 release-ready。

---

## 2. 目标与范围

### 2.1 产品定位

Code Workspace 是 taomni 内的代码编辑器与工程工作台，但本方案只把 **Code Editor** 作为主验收对象。参考产品固定为 IntelliJ IDEA 2026.2，参考语言固定为 Java；TypeScript/JavaScript、Python、Go、Rust、C/C++ 等语言通过 LSP/provider 提供能力，但只能按实际 capability 和对照用例分别记账，不能由“协议已接入”推导为全语言 IDEA 等价。官方明确标为 Ultimate 且默认随产品启用的 Full Line Code Completion 单独按 P2 参考发行版能力记账，不由此扩大到任意插件兼容。

目标维持四层，但 v4.62 将“项目分析可见性”和“provider 语义证据”提升为正式门禁，避免把很多 LSP 按钮误称为 IDEA 工作流：

1. **G0 发布阻断：编辑完整性。** 保存、WorkspaceEdit、undo/redo、外部变更、Action lifecycle、语言隔离和多 workspace ownership 不得丢数据、覆写新输入、跨语言注入文本或静默 no-op；每次磁盘或 provider 副作用都必须可分类、恢复和追溯。R0/R1 已闭合代码合同，但只有 W7 的 native 故障矩阵全绿后才能把 G0 标绿。
2. **G1 发布目标：IDEA-like Core Daily Editing Profile。** 用户能稳定打开/切换工程并看见 Project Analysis/语言服务的真实 ready/degraded 状态，完成输入/选择/多光标、保存与恢复、provider-backed Basic Completion、Parameter Info、Quick Documentation、导航/搜索、provider diagnostics/quick fix、selection/file format 与 imports、tab/split/reopen、clipboard 和可编辑 keymap。每项至少 L2，shell 不得崩溃或抢错 action，unavailable 必须说明 provider/platform 原因。G1 不要求 PSI 等价、Smart/Full Line、Expression Static Data、完整 inspection engine、复杂语义重构或 detach。
3. **G2 北极星目标：Java Provider-backed Semantic Workflow。** 以真实 jdtls + JDK 21 + Maven/Gradle 项目为首个语言基线，对 Project Analysis/import snapshot、classpath-aware completion/auto-import、declaration/type/implementation/hierarchy、Find/Show Usages、diagnostics/intention、Rename 与可证明的 provider refactor，逐项建立 scope、revision、coverage/completeness、conflict、provider generation、cancel/restart 和 library ownership 证据。Type Info 与 Expression Static Data 仅在 provider 能给出相应事实时纳入；不要求先自研 PSI/stub index/CFG，但也不允许把 freshness ledger 命名成 index 后宣称等价。
4. **G3 扩展目标：IDEA Advanced Editing Profile。** Smart/Type-Matching Completion、Full Line、SSR、semantic Surround/Generate、advanced Live/Postfix Templates、scratch/injection、Code Vision、完整 tab/detach、clipboard/history 设置、directory/module formatting、cleanup/rearrange、inspection/data-flow 与复杂重构逐项记账；按 edition/provider/language/platform gate，不作为 G1 发布阻断，也不能反向补偿 G0/G2 缺口。

**对外宣称规则：** 只有 G0 全绿且 G1 清单全部 L2 后才能称“IDEA-like daily editor workflow”；只有某个 Java fixture 矩阵达到 L3 才能对该能力称“IDEA-equivalent”。官方帮助页只证明 IDEA 提供该能力，不证明本产品已完成；Community/Ultimate、bundled plugin、操作系统和 language provider 差异必须随能力展示。

Build/Run/Debug/Test/Coverage、Terminal、Git Manager、AI 和远程工作区继续发展为伴随能力；它们能增强编辑体验，但不能用于宣称 Code Editor 已对齐。

### 2.2 范围分级

| 级别 | 内容 |
|------|------|
| **P0（G0 正确性 + G1 日常效率）** | 原子保存/WorkspaceEdit/undo、语言与 workspace 隔离、Action lifecycle 与 shell shortcut ownership；真实缩进与高频 smart keys；provider-backed Basic Completion/Parameter/QuickDoc；Project Analysis 状态；diagnostics/intention；EditorConfig/basic format/import；Search/Navigation；tab/split/reopen、clipboard、可编辑 keymap。Smart/Type-Matching 与 semantic Surround/Generate 独立归 G3 |
| **P1（Java provider 语义工作流）** | 真实 jdtls/project/dependency context、classpath-aware completion/import、声明/类型/实现/层级、Find/Show Usages、provider diagnostics/quick fix、冲突与完整性感知 refactor、provider generation、性能与损坏恢复；逐 capability 对照，不承诺 PSI 等价 |
| **P2（高级编辑工作流）** | Smart/Type-Matching Completion、Structural Search/Replace、Full Line 本地内联补全、Code Vision、完整 tab/nested split/detach、clipboard history、custom folding、Surround/Generate、scratch/injected language、完整 appearance/accessibility |
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
6. **三端与回归门禁**：Linux/macOS/Windows 原生包各有真实 fixture；聚焦 Vitest/Rust 测试与 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff <base>` 通过，并保存脱敏日志/截图/版本信息。

### 2.5 历史 Gap 汇总（v4.46 前；当前权威基线见 §2.30）

状态按 §2.4 的 L0–L3 记录。下表保留早期汇总用于追溯，其中部分 owner/状态已被后续提交改变；当前完成情况只以 §2.30 为准。X 轨道即使代码更多，也不提升 Editor 等级。

| 优先级 | 能力域 | 当前代码基线 | IDEA 2026.2 关键 Gap | 等级 |
|--------|--------|--------------|----------------------|------|
| P0 | 文本编辑与 smart keys | 查找替换、多光标/矩形选择、注释、fold、soft wrap、括号闭合、复制/删/移动行、大小写切换、selection range、编码/EOL/BOM；Join Lines 和 naive Tab jump-out 已挂入 CodeMirror；Sort/Reverse/Transpose/Unwrap 只有未消费导出或 catalog metadata | Join 的重叠 range/末行边界仍未定；Sort/Reverse 无用户入口；Transpose 只处理主光标；Unwrap/Tab jump-out 不看 syntax/language；缺 clipboard history、custom fold、virtual space，Complete Statement 仍硬编码文本与两空格 | **L2 既有编辑 / L1 新命令原型** |
| P0 | 缩进、格式与 code style | `EffectiveCodeStyle`、EditorConfig resolver、closed-file EOL/replay metadata、typed writer、open-buffer `PreparedSave` 和 stale LSP writeback 已进入生产链 | **P0 余量：controller/WorkspaceEdit/replay 尚无统一 `PreparedSave`/五态结果；close/unmount ownership、native bytes、override persistence、scheme/rearrange/cleanup/scope/marker 和三端证据仍缺** | **L2 缩进基线 / save wired partial / G0 红（P0-S3）** |
| P0 | Completion / Templates / Generate / Import | LSP completion/resolve/snippet/additional edits、signature help、typing debounce、trigger 即时、200 项 cap、Live/Postfix Templates；`CompletionRequestToken` 已贯通 workspace/file/path/language/revision/session generation，inactive/stale provider 结果回退 word completion；Java fixture 无生产 import | snippet + additional edits/resolve 仍可能不是一次 acceptance/一次 undo；无 Smart/Type-matching/reinvoke、visibility/type filter 和完整 truncation UI；provider/classpath-backed auto-import、postfix/Generate 仍无语义 | **L2 identity/stale containment；acceptance partial（G0-J1 红）** |
| P0/P1 | Reference information / QuickDoc | 参数信息、Ctrl+Q QuickDoc、LSP hover、Quick Definition、pin/resize/Documentation pane 基础路径已有 | IDEA 的 Reference Information 仍缺 hover/parameter settings、history/source/external URL、Type/Context Info、provider completeness 和 unmount disposer/a11y/three-platform evidence | **presentation L2 / Reference suite partial（N16）** |
| P2 | Full Line / Inline Completion | 只有未装配的 `FullLineSession` 接受状态；无 CodeMirror decoration/action/provider。Terminal shell FIM 独立，且本地 `fim_engine_real` 仍返回 `None` | 需要严格 local-only 的 editor provider、模型 manifest/decode、prefix+suffix 上下文、ghost text、整段/逐词/逐行接受、popup 协作、取消/代际、auto-import、隐私和硬件降级 | **L0 用户能力** |
| P0 | Diagnostics / Intention / Inspection | push/pull diagnostics、Problems、Alt+Enter Code Action/resolve/command；另有未装配的 `JavaInspectionEngine` 正则规则 | 正则规则没有 parser/CFG/SSA/profile/scope/revision/path evidence，且会产生明显误报；不得冒充 IDEA inspection/data-flow。仍缺 registry executor、自定义 severity、cleanup、nullability/taint/interprocedural flow | **L1 provider 能力 / L0 本地语义 engine** |
| P0 | Navigation / Search | declaration/type/implementation/references、call/type hierarchy、Search Everywhere、Recent Locations 基础 controller 和 editor-file Ctrl+Tab MRU 已有 | Back/Forward/Recent/Switcher 尚未共享 identity facade；Switcher 无 tool windows、Meta/platform key policy；canonical path/UNC/realpath、Find Usages 分组/过滤/preview/pin/exclude、navigation bar/occurrence、semantic SSR 仍缺 | **L2 既有导航 / L1-L2 navigation workflow partial** |
| P0 | Keymap / Actions / Settings | ActionHost、owner/generation、typed result、context-menu projection、action snapshots 和 window keydown 已 wired；TabSwitcher 已作为独立 editor-MRU 基础 | Context menu click 仍 fresh re-evaluate 而非 execute prepared；Search/CheatSheet 仍保留旧数组迁移输入；TabSwitcher listener 绕过单一 host；keymap scheme、录键、冲突图、chord/AltGr/OEM 无生产 consumer | **L1/L2 wired partial（Gate R1，见 §8.17.3）** |
| P1 | Index / Refactor | 生产为 LSP Rename/Safe Delete/provider refactor + revision/root guard + WorkspaceEdit preview/undo；新增 JS 内存 regex index/refactor plan 未挂载 | 原型把无 target ID 的调用标成 resolved、默认 index status=ready、rename 不含可靠 declaration edit、completeness 恒 complete；无 imported context、真实 symbol resolution、smart/dumb、持久化、冲突/post-condition | **L1 provider 工作流 / L0 本地索引** |
| P2 | Tabs / Splits / Editor presentation | preview/pin/scroll/all-tabs；v2 snapshot hydrate、递归 tree renderer、ratio 回写、active group/key restore、任意深度 tab snapshot 已 wired | blame/local-history/cursor/signature/debug 等 chrome 仍 primary/secondary；第三 leaf 无统一 per-leaf state/refcount；校验失败无可见 diagnostic；同文档多视图 undo 不共享；缺 drag-to-split/dock、detach、equalize/stretch、splitter navigation、tab policy、Code Vision/appearance matrix | **L2 recursive foundation / partial（N6.6）** |
| P0 | File state / Recovery | hash 写保护、watcher、dirty conflict、恢复快照、行级三方 merge、WorkspaceEdit 资源操作与普通文件事务 history | 缺语义/token merge、目录/symlink/特殊文件 undo、大小写-only rename、locked file/permission/network/UNC 完整行为和三端打包证据 | **L2** |
| P0 | Accessibility / Performance / 三端 | large-file decoration 降级、部分 ARIA/testid、布局持久化；Linux 自动化与条件编译 | 无统一输入延迟/内存/索引基准；IME、读屏、focus order、200% zoom、非美式键盘、系统快捷键及 Linux/macOS/Windows 原生包矩阵未验收 | **L1–L2** |
| P0 | 编辑响应与外部变更 | `3ba26c4d` 增加 diagnostics identity cache、chrome 语义相等、静态 theme、LSP progress batching 和状态栏细粒度 selector；原 memo/防抖/tree guard 保留 | 仍无真实 typing p95/IPC/内存/大工程 profile；comparator 未比较 `debugInlineValues`，且多数 callback 依赖被跳过 render 时无法刷新组件内 ref；capability 仍缺 session generation，watcher/树缺三端压力证据 | **L2 性能护栏 / L1 证据** |
| X | Build/Run/Debug/Test/Coverage 等 | 结构化 execution/DAP/JUnit/LCOV/JaCoCo/Git/PTY/AI；Debug 已交付 4 子 tab、双栏/双分隔、组件拆分与布局持久化 | 独立按伴随轨道验收；Debug 后续见 `debug-panel-idea-redesign.md`，coverage 仍是报告扫描/展示而非 Run with Coverage 配置模型 | **不计 Editor 等级** |

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

### 2.8 IDEA 2026.2 官方能力再对齐（2026-08-15，历史目标快照）

本节保留 2026-08-15 的官方能力快照；其中“当前 Code Workspace”和 P0/P1 判断已经过期，现状与优先级由 §2.30/§8.20 覆盖。官方页面仍用于说明 IDEA 能力边界，每个大里程碑开始前必须再次复核 URL 与产品版本。

| 官方能力族 | IDEA 2026.2 真实能力 | 当前 Code Workspace 对比 | 目标修订 |
|------------|----------------------|---------------------------|----------|
| Editor basics / source editing | [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html) 与 [Write and edit source code](https://www.jetbrains.com/help/idea/working-with-source-code.html) 覆盖 tabs/preview/pin/detach、任意 split、breadcrumbs、font/ligature、virtual space、smart keys、clipboard history、statement move/complete/unwrap、custom folding 等 | 已覆盖常用文本操作、两组 split、preview/pin、breadcrumbs/sticky lines；缺口见 §2.5，Complete Statement 仍为启发式 | P0 先补真实缩进/smart keys/高频 edit；复杂 tab/split/appearance 列 P2 |
| Completion / templates / generation | [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) 包含 basic、smart type-matching、重复调用扩展范围与 completion 设置；另有 [Live Templates](https://www.jetbrains.com/help/idea/live-templates.html)、[Postfix Completion](https://www.jetbrains.com/help/idea/postfix-code-completion.html)、[Generate Code](https://www.jetbrains.com/help/idea/generating-code.html) 和 [Surround Code](https://www.jetbrains.com/help/idea/surrounding-blocks-of-code-with-language-constructs.html) | LSP basic completion/snippet 与本地 template catalog 可用；没有 smart/type-matching mode、语义 postfix、Surround/Generate | **当前修订：** provider-backed Basic + 重复调用事实归 G1；Smart/semantic postfix/Surround/Generate 归 G3，不阻断发布 |
| Full Line code completion（Ultimate bundled plugin） | [Full Line code completion](https://www.jetbrains.com/help/idea/full-line-code-completion.html) 在 Ultimate 中默认 bundled/enabled；模型完全在本机运行，提供单/多行 inline suggestion、整段/逐词/逐行接受、格式/括号/引号修正、基础语义检查、auto-import、smart filtering 与模型更新；Java/Kotlin 模型随 IDEA 提供，其他语言按插件/模型可用性变化；官方硬件门槛为 AVX2 x64 或 ARM64 | Code Workspace 编辑器没有 inline suggestion/model runtime；现有 LSP popup completion 和 Terminal FIM 均不是该工作流 | 作为有 edition/plugin/硬件限定的 P2 参考能力，Java 先行；不将其误归为 AI Assistant，也不要求通用 JetBrains plugin compatibility；不支持硬件时必须显示 unavailable |
| Intentions / inspections | [Intention actions](https://www.jetbrains.com/help/idea/intention-actions.html) 支持查看/禁用/分配 shortcut；[Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html) 支持 project/scope、severity、自定义 profile、suppression 与 quick-fix | Alt+Enter 和 provider diagnostics 已接；profile 主要改变显示，不执行 IDEA inspection | **当前修订：** diagnostics/quick fix归 G1；inspection/data-flow只按 provider structured evidence或后续 ADR engine进入 G2 |
| Navigation / search | [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html) 覆盖 declaration/type/implementation、last edit、super/sibling/method navigation；[Search Everywhere](https://www.jetbrains.com/help/idea/searching-everywhere.html) 覆盖 class/file/symbol/action/text；[Structural Search](https://www.jetbrains.com/help/idea/structural-search-and-replace.html) 按语法模板搜索替换 | 主流 LSP 导航、Search Everywhere、Recent/Changed/Last Edit 已有；缺 Recent Locations、Switcher、super/sibling/method 与 SSR | 补齐高频导航列 P0，SSR 与复杂位置历史列 P2；library/index 完整性归 P1 |
| Formatting / imports / style | [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html) 覆盖 fragment/file/module/directory、save/commit、exclude/marker、formatter settings；[Auto/Optimize Imports](https://www.jetbrains.com/help/idea/optimizing-imports.html) 与 [EditorConfig](https://www.jetbrains.com/help/idea/editorconfig.html) 提供持久化 style 与优先级 | LSP format、format on save、organize imports 有入口；`EffectiveCodeStyle` 已驱动编辑器缩进与 formatter options，但 EditorConfig parser 未接生产 resolver，override/保存规范化不持久化，无 rearrange/cleanup/scope/marker | 先收口 style provenance、父目录 EditorConfig 链、保存 normalize 与 preview；再扩展 scheme/rearrange/cleanup，不能把 status label 计作完整 style |
| Refactoring | [Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html) 包含 Safe Delete、Copy/Move、Extract method/constant/field/parameter/variable、Rename、Inline、Change Signature，以及 usages preview、exclude、conflict dialog 和统一 undo | provider actions、raw edit preview/exclude 与普通文件 undo 已有；无语义 conflict/完整性保证 | **当前修订：** provider refactor + completeness/conflict/post-condition为 G2；是否补本地 index仅由真实 fixture后的 ADR决定 |
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
| Full Line completion | Code Workspace editor 路径无 ghost text/local model/部分接受；Terminal FIM 独立 | **L0**，保持与 popup completion、AI selection、Terminal FIM 分账 | P2 Java 本地模型与隐私/硬件降级 fixture，见 §8.4 A4 / §8.5.9 |
| Inspection/refactor/navigation | provider diagnostics/profile、raw WorkspaceEdit preview/exclude、revision/root guard；Recent/Changed/Last Edit、双 editor group | 事务保护有效，但无 PSI/index/CFG/conflict-aware refactor；历史与布局仍受单点/双组限制 | J1–J3 semantic contract；Recent Locations context model；递归 layout tree 后再做 P2 |
| Editor chrome / X | breadcrumbs、sticky lines、inlay/semantic/Git/coverage/debug gutter 有实现；coverage 为 LCOV/JaCoCo 展示；Build/Run/Debug/Test 代码归 X | 有效增量不提升语义等级；coverage 不是 Run with Coverage 模型 | 按单项 fixture 保持 L2；X 轨道按 §12 独立验收 |
| 架构可演进性 | `CodeWorkspaceTab.tsx` 约 10.6k 行，命令、状态、LSP、文件、执行和 UI 装配仍集中 | 继续直接加入口会放大 context/keymap/state 竞态；近期新增模块尚未全部接入生产单一来源 | E0.2 先抽 controller，并以依赖图/聚焦测试而非行数作为完成标准 |

**规范优先级（历史）：** 本节只描述 `2134e783`。当前状态与待办已经后移到 §2.11、§8.4、§8.5、§8.6；§3–§7、§9–§11 保留设计细节和历史交付记录。

### 2.10 v4.31 生产可达性审计（历史基线 `61b361f4`，2026-08-17）

> 本节保留前一轮审计。历史事实见 §2.11/§2.12；当前增量以 §2.13 v4.36 和 §8.8 为准。本节中的“未挂载”不能覆盖后续 Recent Locations/Action Registry/Debug 接入变化。

本轮不以文件名、注释或单测名判断能力，而是沿用户路径检查生产 import、状态所有者、命令入口、provider/IPC、失败语义和自动化。`rg` 排除测试后，以下新增模块均没有从 `CodeWorkspaceTab`、`CodeMirrorHost`、store 或后端命令形成完整调用链。

| v4.30 工作包 | 新增代码 | 生产可达性 | 当前定级与必须纠偏 |
|---------------|----------|------------|----------------------|
| E0 Action | `workspaceActionRegistry.ts` 扩展、`useWorkspaceActionsController.ts` | controller 无生产引用；`CodeWorkspaceTab` 仍直接 dispatch `WorkspaceCommand[]`，也未调用 `registerWorkspaceCommands`；registry 主要只提供 alias/cheatsheet metadata | **L1 模型。** 不能称 runtime truth；全局 registry 还需解决多 workspace ownership 和旧 unregister 删除新 handler 的竞态 |
| E1 Style | `editorConfigResolver.ts`、`saveNormalizationPipeline.ts` | 两者只被自身类型或测试消费；生产保存仍是 formatter -> `saveOpenBufferText`，override 仍为组件 `useState` | **L0–L1 pipeline。** resolver 的 explicit override 当前会提前返回并丢掉 EOL/charset 等独立字段；normalizer 注释中的 charset/BOM stage 尚未实现 |
| E2 Keymap | `keymapModel.ts` | 只在单测中使用；cheatsheet 继续接收 `workspaceCommands`，键盘 dispatcher 不读取 scheme | **L0 用户能力。** platform defaults、冲突和 import/export 均不是产品功能 |
| E3 Editing | `workspaceEditorCommands.ts` 增量、`surroundGenerateModel.ts` | Join Lines 与 Tab jump-out 已进入 `workspaceEditorKeymap`；Sort/Reverse/Transpose/Unwrap 无 action/keymap/UI；Surround/Generate 只在单测 | **L1 局部。** naive Tab/Unwrap 和固定 Java 字符串生成不得标 semantic |
| E4 Navigation | `navigationHistoryModel.ts`、`RecentLocationsDialog.tsx` | dialog 只 import model，但 dialog 本身没有生产 consumer，也没有任何事件调用 `recordLocation` | **L0 用户能力。** 全局 singleton 还会串 workspace，且无 rename/stale/revision 语义 |
| J1 Index | `javaSemanticIndex.ts` | 只被 J2/J3 原型与测试消费；无 IPC、import context、文件遍历或持久化 | **L0 语义能力。** 正则提取不能称 persisted index；默认 `ready` 和伪 `resolved` 必须在接入前删除 |
| J2 Inspection | `javaInspectionEngine.ts` | 无生产 consumer；逐行正则模拟 unreachable/constant/null | **L0。** 不是 CFG/SSA/data-flow，禁止混入 Problems 作为高置信 inspection |
| J3 Refactor | `semanticRefactorPlan.ts` | 无生产 consumer；依赖上面的非权威引用表，计划完整性固定为 complete | **L0。** 不得接到 Apply；先落统一 completeness/conflict/revision contract |
| A1 SSR | `structuralSearchModel.ts` | 只在 `advancedWorkflows.test.ts` | **L0。** 实际为 regex template search，type/text constraints 未执行，不是 AST structural search |
| A2 Layout | `recursiveLayoutTree.ts` | 只在测试；store/render 仍固定 primary/secondary | **L0 递归布局。** 需要 schema migration、纯 reducer、renderer 和 drag/focus 生命周期 |
| A4 Full Line | `fullLineCompletionModel.ts` | 只在测试；无 suggestion provider、CM state/decorations/action；本地 FIM decode 仍未实现 | **L0。** 只是接受游标模型；不得用 Terminal cloud-capable shell FIM 替代 local-only editor completion |
| Q/Debug | `3ba26c4d`、`0de35429`、`46a0dba4` | 性能改动和 Debug 多栏 UI 有生产调用与组件测试 | **已进入工作流。** 性能仍缺真机指标和 comparator 收口；Debug 作为 X 轨道按独立文档继续验收 |

从本版本起采用四个交付标签，和 §2.4 的能力等级分开记录：

1. `model`：纯类型/算法/fixture，无生产 consumer。
2. `wired`：有真实入口和状态所有者，但失败/恢复/持久化尚未闭环。
3. `workflow`：主路径、取消、失败、恢复、可发现性和聚焦自动化完成。
4. `verified`：对照 fixture、性能、无障碍和适用平台真机证据完成。

PR 只有达到 `workflow` 才能把功能清单标为“可用”，只有 `verified` 且满足 §2.4 才能提升到 L3。测试文件直接 import 一个 model，只能证明 `model`；测试组件没有被生产 host 挂载，仍不能提升为 `wired`。

### 2.11 v4.34 最新提交再复核（2026-08-18）

审计方法：对提交文件逐个执行非测试 `rg` consumer 检查，再核对用户入口、状态 owner、provider/IPC、失败/取消/undo、持久化和 QA catalog；没有因为提交说明、组件名称或单测通过而升级等级。

| 变化 | 生产证据 | 真实结论 | 下一步待办 / 改进点 |
|------|----------|----------|----------------------|
| Action Registry | `workspace.recentChangedFiles` 已是独立命令；`actionStacks` 在 owner cleanup 后恢复旧定义并发出 `registered`/`state-changed` | **wired / partial**：原 alias 和 cleanup 缺陷已修；但键盘、菜单和 Search Everywhere 仍直接消费 `WorkspaceCommand[]`，registry 不是唯一执行真值，且仍是 global singleton | N0：instance-scoped ActionHost；所有入口统一 `ActionState/ActionResult`；补 active owner/visibility、AbortSignal、错误与双 workspace tests |
| EditorConfig / Save | 保存与格式化调用异步 `resolveForFile`，normalizer 与 hash guard 已接生产；root 越界中止、`.editorconfig` watcher invalidation、CRLF/CR 保留和不可编码阻断已有实现 | **wired / correctness gap**：`globalEditorConfigResolver.setFileProvider()` 由每个 tab 覆盖，跨 workspace provider 仍串扰；最终 writer 继续使用旧 `file.eol/file.encoding/file.bom`，解析出的 `end_of_line/charset/BOM` 没有控制实际字节 | N1-P0：resolver/provider instance-owned；把 resolved output policy 传入一次 byte write；补双 workspace/multi-root 与 save/reopen byte equality |
| Recent Locations | 稳定递增 ID、dialog subscription、workspaceId 参数、root boundary helper、reload 文本同步均已存在 | **wired / partial**：生产采集仍依赖同时观察文本和 `cursorPositions` 的 effect；一次编辑后移动 caret 会继续产生 edit entry；`relocateFile/removeFileLocations` 无生产 caller；带 workspaceId 查询仍接受无 workspaceId 的 legacy entry；store 仍是 global singleton | N2-P0：改为 document-change/navigation 事件采集；严格 workspace filter；接 rename/delete/external lifecycle；加入 stale/missing/relocated 状态和 Switcher |
| Recursive layout | reducer 预校验、store 的 `layoutTreeV2` 字段和递归 `PanelGroup` renderer 骨架已存在 | **model + renderer skeleton**：没有生产 set/migrate/persist lifecycle；任意 leaf 除 `secondary` 外都映射为 `primary`，无法拥有独立 tab state，深层树会重复渲染同一 group | N6-P0：leafId-keyed groups、v2 migration/persistence、布局命令/拖拽/focus、损坏快照恢复与 property/host QA |
| Debug stepping & lock | hook 持有 `stepInFlightRef/isStepping`，`step()` 返回 typed result；toolbar/keymap 最终调用 hook；Show Execution Point 已连通 | **wired / partial**：单步防重入已修，但还没有统一 capability-driven Debug Action Service；Hot Reload 对所有 adapter 可见并发送 Java 私有请求 | 见 Debug 文档 D6：统一 descriptor、capability/extension gating、所有入口状态与结果一致 |
| Debug console & watch | clear 与公开 terminate 会 bump generation；evaluate/hover 有 generation/session guard；Watch pane 按运行期 watchId 删除 | **wired / partial**：session publish/switch、间接 terminate、stop/frame 变化不会 bump；stale evaluate 只返回空结果，pane 仍可能追加空行；Watch ID 不持久且缺 reorder/enable/error 状态 | 见 Debug 文档 D7/D8：per-session request epoch + typed stale；结构化 Watch state 与 epoch-isolated variables |

#### 2.11.1 验证结果与回归信号

- 本轮定向回归：11 个相关测试文件、195 tests 全部通过；覆盖 CodeWorkspaceTab、Action Registry、EditorConfig/Save、Recent Locations、recursive layout、Debug hook/panel/console/frames/variables。
- 通过测试只能确认当前用例没有回归；上述 singleton provider、writer policy 丢失、caret edit 噪声、dead lifecycle caller、recursive leaf ownership 和 Debug session epoch 均由生产 consumer 审计直接确认，不能因单测全绿升级为 `workflow`。
- 既有 `beforeEach/afterEach` 清理降低了测试间污染，但不能证明两个真实 workspace 同时挂载时的运行期隔离。

### 2.12 v4.35 `f88c5785` as-built 复核（2026-08-18）

本节是对 `f88c5785` 的增量审计，不覆盖 §2.11 的历史结论。审计逐个核对提交中的非测试 consumer、store/action owner、异步请求生命周期、写盘字节策略和现有 QA 入口；“有 descriptor、reducer 或组件单测”仍不能直接升级为 `workflow`。

| 领域 | `f88c5785` 已落地 | 仍阻断 IDEA 对齐的事实 | 下一轮交付标签 |
|------|------------------|----------------------|----------------|
| EditorConfig / Save | resolver factory、异步 `resolveForFile`、EOL/charset/BOM writer options、normalizer/hash guard | `CodeWorkspaceTab` 仍写入 `globalEditorConfigResolver` provider，多个 tab/workspace 会覆盖；普通 save 与 WorkspaceEdit `writeDisk` 的编码/BOM 策略分叉；没有 Tauri 字节级 save/reopen 证据，SaveTransaction 仍主要靠 text 比较 | N1：instance-owned provider + typed transaction + byte equality |
| Recent Locations | sequence ID、dialog subscription、workspaceId 查询参数、stale/missing/relocate/remove API、rename/delete 的部分调用 | `updateFileText` 同时承接 formatter/reload/WorkspaceEdit，无法区分 user edit；`activeFileText + cursorPositions` effect 仍产生额外 entry；workspaceId 可省略且 global tracker 仍存在；stale、canonical path/大小写/UNC/symlink 及 Ctrl+Tab 尚未闭环 | N2：事件型采集 + strict owner + lifecycle/Switcher |
| Recursive layout | reducer 预校验增强、Zustand mutation、递归 renderer 骨架 | reducer no-op 后 store 仍可能改 editorGroups/active group；非法 active key、缺失 leaf 的 split/close 仍污染状态；leaf id 可能碰撞；ratio/全树 file uniqueness 校验不足；v2 tree/group/ratios 未持久化，viewport、move-to-other-group 等仍是 primary/secondary 假设 | N6：typed atomic mutation + schema v2 persistence + leaf ownership |
| Action ownership | 既有 owner stack cleanup；Debug action descriptor 文件与部分 step/Show Point 接线 | `workspaceActionRegistry` 仍 global；键盘、Search Everywhere、菜单仍直接执行 `WorkspaceCommand[]`；Debug descriptor 没有和 workspace ActionHost bridge；没有统一 `ActionState/ActionResult`、AbortSignal、in-flight arbitration | N0：instance ActionHost + 单一执行真值 |
| Debug console/variables | console seq/ring/follow-tail、REPL history、部分 session guard；variables/scopes session guard、hidden pane visible 传递 | pane-local UI state、总 outputLength badge、consoleGeneration 不是 stop epoch；stoppedThreadId 被当 epoch；children/late response、error-vs-empty、stable watch ID/reorder/enable/error 未完全解决 | D7/D8：见 Debug 文档 §15.9/§17 |

**本轮审计结论。** `f88c5785` 的新增代码把多个能力推进到 `wired/partial`，但没有任何一项因此自动达到 `workflow` 或 `verified`。尤其是 reducer/store 的原子性、writer 的最终字节策略、workspace owner 和 async epoch 都属于数据正确性边界，必须先于 UI polish 收口。下一步排序固定为 N0/N1/N2/N6 的生产闭环，N3/N4/N5 继续保持 `model/prototype`，N7 负责将每个包的纯测、组件测、QA YAML、fake/real adapter 和三端证据绑定在同一变更中。

- 定向编辑器/布局回归：5 个 test files、42 tests 全部通过；全量 CodeWorkspaceTab 回归 56 tests 全部通过。
- 定向 Debug 回归：3 个 test files、42 tests 全部通过；命令包含 DebugConsole、DebugPanel、DebugFrames/Variables 相关用例。
- `pnpm build`（`tsc -b && vite build`）**已修复并全绿通过**：修复了 `CodeWorkspaceTab.tsx` 中的 `EditorConfigResolver.setFileProvider` 接口声明、`OpenFileEol` 类型归一化、`EditorGroup` 递归布局属性装配与 `dirtyCount` 更新流，以及 `debugActionService.ts` 中的 `stepIn` DAP 动作映射。
- `git diff --check` 通过。以上仍需在后续包推进 fake DAP、Tauri 字节级 save/reopen、真实 adapter、QA YAML 及三端 native 证据。

### 2.13 v4.36 `3f107de9` 增量复核（2026-08-19）

本提交的实际范围是修复 `f88c5785` 的编译/装配门禁，不等于执行完 §8.7。审计以符号调用链和当前测试重新验证，不沿用提交说明中的能力判断。

| 变化 | 已确认结果 | 尚未完成 / 新暴露缺口 | 等级 |
|------|------------|-----------------------|------|
| Build/type gate | `EditorConfigResolver.setFileProvider` 已进入接口；EOL option 统一转成 `OpenFileEol`；无效 `EditorGroup` props 已替换；Debug `stepInto -> stepIn` 类型错误已修 | 这些是 release gate 修复，不改变 owner、transaction、action 或 DAP lifecycle | **gate closed** |
| EditorConfig / Save | 普通 `saveFile` 已把 resolved EOL/charset/BOM 传入 `saveOpenBufferText`，且 EOL 在最终 write 前归一化 | `CodeWorkspaceTab` 仍同时调用 instance resolver 与 `globalEditorConfigResolver.setFileProvider`；给接口补 mutable setter 只是让 singleton 覆盖可编译。closed-file WorkspaceEdit 的 `readDisk/writeDisk` contract 不携带 EOL，原文本虽保留已有 CRLF/CR，但 LSP `newText` 的 LF 可产生混合换行，且 EditorConfig policy 不会参与；仍无 bufferVersion/styleGeneration typed transaction 或真实字节矩阵 | **wired / correctness gap** |
| Recursive layout | renderer 的 `onActivate/onClose/split/closeSplit` 已能通过 TS props 检查；dynamic leaf 可读取 leafId group | 非测试代码没有调用 `setLayoutTreeV2`/migration，故新分支仍不可达；`onClose` 只更新 `editorGroups`，不更新 leaf `openFileKeys`；split/close/move/active reducer no-op 后 store 仍可能改 group/active id；close 不清理 group，ratios 不回写，snapshot 仍只保存 legacy groups | **model + unreachable host branch** |
| Dirty indicator | `dirtyCount/dirtyFiles` 改回实时 `openFiles`，避免 deferred UI 延迟 | 属 UI correctness 修复，不代表 SaveTransaction 完成 | **workflow fix** |
| Debug step mapping | descriptor 的 Step Into 现在调用合法的 `debug.step("stepIn")` | Toolbar/DebugPanel/editor chrome 仍绕过 descriptor；descriptor 仍返回 `void`，无 requestId/central result。内部 record 已有单调 `stopEpoch`，但 `DebugSessionState/CodeDebugSession` 未公开，Console/Variables 仍读取 `stoppedThreadId` | **model fix / partial consumer** |

#### 2.13.1 本轮验证

- `pnpm build` 通过；Vite 仅报告既有 dynamic import/chunk-size warnings。
- Editor/Save/Navigation/Layout/Action 定向回归：7 files、107 tests 全绿。
- Debug 定向回归：4 files、44 tests 全绿。
- 文档更新后 `git diff --check` 通过，工作树仅包含本文档与 Debug 设计文档。
- 这些结果证明当前提交可编译且已有用例未回归，不证明双 workspace provider、CRLF/CR closed-file WorkspaceEdit、动态 layout host、fake DAP、真实 adapter 或三端 native workflow。

**结论。** §8.7 的 N0/N1/N2/N6 仍全部未完成。下一轮不得继续用“补接口/修 TS”代替生产 ownership；按 §8.8 先提交可独立验证的 transaction/reducer contract，再接 host。

### 2.14 v4.37 `3aacbecc` 最新提交复核（2026-08-19）

本节只记录 `3aacbecc` 的实际生产可达性，不覆盖 §2.13 的历史判断。提交说明中的“implemented”必须拆成 `model`、`wired`、`workflow`、`verified` 四层；纯 reducer、descriptor、hook 字段和组件 mock 不能单独升级等级。

| 领域 | 本提交已确认 | 仍阻断对齐的事实 | 当前等级 / 下一包 |
|------|--------------|------------------|------------------|
| N1 Style/Save | `WorkspaceStyleController` 持有 workspaceId/roots/provider，cache key 带 workspace；普通 save/format 已通过 controller resolve；closed-file WorkspaceEdit 读取并推断 EOL 后对新文本做 normalize；全局 `setFileProvider`/invalidate 已从生产路径移除 | `SaveTransactionV2/executeSaveTransaction` 没有成为 `saveOpenBufferText` 的唯一写盘入口；其成功 hash 仍是客户端合成值；roots 变化只更新 `rootsRef`，controller effect 不随 roots fingerprint 重建/replace；style generation/buffer revision/hash 没有在真实 Tauri save 前后形成 typed transaction；新增隔离测试因非法单行 `.editorconfig` fixture 失败，133/134，不得把失败测试算作验证 | **model + partial wired；N1.2** |
| N6 Layout | `atomicSplit/Close/Move/SetActive/CloseTab` 已返回 typed changed/no-op，Zustand reducer 仅在 changed 时替换 tree/groups；递归 renderer 与 v2 normalize/hydrate 入口存在；ID 生成已有进程内 monotonic counter | `CodeWorkspaceTab` 的持久化 effect 没有把 `layoutTreeV2` 传给 `snapshotFromWorkspaceUi`，写入 v2 仍会退化为 active leaf；恢复 open files 只遍历 primary/secondary，dynamic leaf 丢失；renderer 没有 `PanelGroup.onLayoutChanged` ratio 回写；normalize 未校验 tree/group tab/active 的一致性、非正 ratio 和空 leaf 的非法 activeKey；`replaceFileState` 仍重建固定 primary/secondary；close dynamic leaf 可能遗留 dirty/shared buffer 的无视图状态 | **model + unreachable/partial workflow；N6.2** |
| N0 Action | `WorkspaceActionHost` 已具备 instance map、when/state、platform key matching、busy lock、AbortSignal、typed result，并有隔离单测 | `CodeWorkspaceTab` 没有调用 `useWorkspaceActionsController`/host；keydown、Search Everywhere、command registration、菜单仍走 `WorkspaceCommand[]` 和 global registry；hook 自身的 `executeCommand`/`dispatchKeydown` 也直接调用 `cmd.run`；host unmount/dispose、同 ID 替换/旧 owner cleanup、Debug bridge 未接生产；因此仍是双真值 | **model only；N0.2** |
| N2 Locations | `NavigationLocation.workspaceId` 已必填；`WorkspaceLocationController` 提供 workspace-scoped API；user typing 的 `queueEditorTextUpdate` 与 programmatic `updateFileText` 已分开；rename/delete 有部分 workspace 过滤调用 | 生产仍直接导入 global `navigationHistoryTracker`，controller 未由 workspace 创建/销毁；tracker 查询与 lifecycle 参数仍可省略 workspaceId；active file/cursor effect 继续在 caret/文本变化时记录 navigation，formatter/restore/reload 的事件来源未统一；directory rename/delete、cut-paste、external stale/missing、case/UNC/symlink canonicalization 不完整；Ctrl+Tab Switcher 未实现 | **wired/partial；N2.2** |
| D8 Stop snapshot | `DebugSessionState` 和 `CodeDebugSession` 现在暴露 stopEpoch；`reduceDebugEvent(stopped)` 递增 epoch；`useDebugVariables` 的首轮 scopes/watch guard 已改读 stopEpoch；`DebugRequestToken`/`AsyncLoadState`/structured watch 类型已声明 | `stopEpoch` 仍是 optional state 字段；token/load state 没有贯穿 `fetchScopes/fetchVariables/evaluate/stackTrace` 和 children interest；这些 API 失败仍返回空数组/空值，错误与 empty 未区分；Console 仍以 `stoppedThreadId` 检查 REPL 迟到结果；watch 仍只持久化 string[]，reload 后重新生成 ID，无 order/lastError/enable mutation；hidden Variables hook 未因 pane 不可见而阻断请求 | **model + partial consumer；D8.2** |
| D6/D7/D9/D10 | Debug 组件回归 5 files/46 tests 通过；build 通过；tab/tabpanel ARIA 和 visible prop 的基础仍在 | Toolbar/Frames/Panel 仍直接调用 debug hook，不消费 descriptor；Console follow/history/lastSeen 是 pane-local，仅 10k 行无 2 MiB/unread/session store；DebugSubTabBar 仍用 `document.querySelector`，split 仍使用 global localStorage key；没有 fake DAP、真实 adapter trace、QA YAML、性能或三端 native 证据 | **component/unit only；D6.2/D7.2/D9.2/D10.2** |

**本轮验证事实。** `pnpm build` 通过（仅保留既有 dynamic import/chunk-size warnings）；编辑器/布局/Action/Save 定向命令为 10 files、134 tests，其中 `workspaceStyleController.test.ts` 1 个失败；`codeWorkspaceStore.test.ts` 8/8、`dapDebugModel.test.ts` 与 `useCodeDebugSession.test.tsx` 合计 89/89 通过；Debug Panel/Console/Frames/SubTab/Variables 5 files、46/46 通过。`git diff --check` 与最终工作树检查在文档编辑后重新执行。上述结果不提供 Tauri byte-level save/reopen、nested layout reload、host command path、fake DAP、真实 adapter 或 Linux/macOS/Windows 证据。

**提交复核结论。** `3aacbecc` 是正确性模型批次，不是 parity workflow 完成批次。开发顺序固定为：先修 style 隔离 fixture 和真实 save transaction，再修 v2 tree/group persistence 与 dynamic leaf lifecycle；随后让 ActionHost 成为 CodeWorkspace 唯一执行真值，最后接事件型 Locations 和 Debug D8/D6/D7/D9。N3/N4/N5 与新的 IDEA surface 在这些 owner/generation contract 冻结前继续冻结。

### 2.15 v4.38 `1b6f91cf` 最新提交复核（2026-08-19）

本节是 `1b6f91cf` 的生产可达性审计，逐个核对非测试 consumer、状态 owner、写盘字节策略与异步生命周期；提交说明中的 “complete production wiring” 逐条降级为实际等级。

| 领域 | 本提交已确认 | 仍阻断对齐的事实（含证据） | 当前等级 / 下一包 |
|------|--------------|---------------------------|-------------------|
| N1.2 Save/Style | open-buffer save 已调用 `WorkspaceStyleController.executeSaveTransaction`（`CodeWorkspaceTab.tsx:3409-3446`）；最终 writer 应用 EOL/encoding/BOM（`:3222-3264`） | transaction policy 总是携带文件元数据，controller 用其覆盖 resolved EditorConfig 的 EOL/charset（`workspaceStyleController.ts:423-431,475-487`），写出的不是解析结果；controller 重建 effect 依赖稳定 ref 而非 roots fingerprint（`CodeWorkspaceTab.tsx:1356-1388`），roots 变化不生效；WorkspaceEdit 写盘绕过 transaction 直调 writer（`:5636-5638,5702-5720`）；成功 hash 是客户端合成值（`workspaceStyleController.ts:489-493`） | **wired / correctness gap；N1.3** |
| N6.2 Layout | v2 snapshot 持久化/恢复已携带 tree 并枚举全部 group（`CodeWorkspaceTab.tsx:2019-2029,2062-2074`）；renderer 使用任意 leaf group ID（`:9827-9853,10017-10053`）；resize 回写 ratio | 资源替换只 reconciles groups、不重映射 `layoutTreeV2` 的 key，rename/delete 后 dynamic leaf 变 stale（`codeWorkspaceStore.ts:612-650`）；close leaf 直接删 group、不迁移其中 tab，shared/dirty buffer 失去视图（`recursiveLayoutTree.ts:514-548`）；校验接受零/负 ratio（`:266-269`） | **wired / partial；N6.3** |
| N0.2 Action | `WorkspaceActionHost` 与 controller 具备 instance/state/busy/AbortSignal 能力 | `CodeWorkspaceTab` 不消费 `useWorkspaceActionsController`/host：keydown、Search Everywhere、菜单注册与执行仍直接用 `WorkspaceCommand[]`（`CodeWorkspaceTab.tsx:7490-7551`），helper 直调 `command.run`（`workspaceCommands.ts:134-159`）。ActionHost 目前是死基础设施 | **model only；N0.3** |
| N2.2 Locations | user edit 已显式记录（`CodeWorkspaceTab.tsx:2683-2724`）；activation effect 不再依赖 cursor/text（`:7553-7587`）；dialog 走 controller 查询 | controller 只是包裹 global singleton（`navigationHistoryModel.ts:229-234,321`）；rename/delete lifecycle 仍 import 并调用 global（`useWorkspaceFileActions.ts:43,439,499,551`）；relocate/remove 是精确路径匹配，不处理目录子树（`:155-170,198-210`）；dialog 不支持条目删除 | **wired / partial；N2.3** |

**本轮验证事实。** `pnpm exec tsc -b` 干净；定向回归 10 个测试文件、183/183 通过（CodeWorkspaceTab、workspaceStyleController、recursiveLayoutTree、navigationHistoryModel、useCodeDebugSession、DebugPanel、debug/*）。这些只证明无回归，不能证明双 workspace 运行期隔离、真实字节写盘或真实 DAP workflow；无 Tauri/QA YAML/三端证据。

**IDEA 2026.2 对照增量（真实产品事实）。** 对照 JetBrains 官方 What's New 与 Help（2026-07/08）：2026.2 新增 Logpoints、runtime output → source 导航、dependency completion、Git 冲突解决流；平台编辑器新增 smooth caret animation 与新 selection 行为；Recent Locations 支持 Delete 删除条目（并同步从 Back/Forward 历史移除）、可按 breadcrumbs 搜索、Show edited only 切换。本仓库现状：logpoint 模型与 gutter diamond 已有（`dapDebugModel.ts:16-17`、`debugEditorChrome.ts:27`），其余均缺失或只有部分。当前新增缺口进入 §8.11 N8.1 与 Debug 文档 §21 D11.1/D11.2。

### 2.16 v4.39 `dab8a778` production-path code review（2026-08-19）

本节审查 `1b6f91cf..dab8a778` 的生产代码与测试，不采信提交标题中的 “complete”。判断仍使用 `model → wired → workflow → verified`：新类型、provider class、service factory 或组件单测，没有真实 consumer 时最高为 `model`。

| 领域 | 本提交已确认 | Code review 发现的阻断事实 | 当前等级 / 下一包 |
|------|--------------|----------------------------|-------------------|
| N1.3 Save | resolved EditorConfig 不再被 file metadata 覆盖；roots fingerprint 变化会替换 controller；writer 返回后端 hash | `bufferVersion` 与最终 race check 都用 `text.length`（`CodeWorkspaceTab.tsx:3417,3448`）；等待 format/normalize 时发生同长度编辑，会通过 guard 并把旧 snapshot 写盘。open-clean WorkspaceEdit 与 closed-file writer 仍直接调用 `saveOpenBufferText/writeDisk`，绕过 transaction/style/cancellation | **wired / high correctness defect；N1.4** |
| N6.3 Layout | ratio `<=0` 被拒；resource replacement 会 remap tree key；close leaf 会把 group 中 tab 迁入 surviving group | `atomicCloseLeaf` 只更新 `nextGroups[targetSiblingId].openOrder/activeKey`（`recursiveLayoutTree.ts:548-561`），返回的 `newTree` destination leaf 未同步 `openFileKeys/activeKey`；持久化后 tree/group owner 分叉，现有测试只断言 group 顺序 | **wired / invariant gap；N6.4** |
| N0.3 Action | adapted action unregister cleanup 已补 | `CodeWorkspaceTab` 的 execute/keydown/Search/menu 仍直接走 `WorkspaceCommand[]`（`:7496-7557`），没有创建/消费 `useWorkspaceActionsController`；`registerCommands` 不 await `cmd.run`（`workspaceActionHost.ts:123-126`），async failure/cancel 会被误报 applied | **model only；N0.4** |
| N2.3 Locations | controller 默认创建独立 tracker；breadcrumbs search、entry Delete、directory subtree relocate/remove API 已加入 | file rename/delete 仍直接 import global tracker（`useWorkspaceFileActions.ts:43,439-443,503,556-558`），不会更新 dialog 使用的 instance tracker；dialog Delete 只删 Recent Locations，不同步 Back/Forward history；Ctrl+Tab Switcher 仍缺 | **wired / split ownership；N2.4** |
| N8 Dependency completion | Maven/Gradle context parser、provider interface/capability 与 181 行测试已加入 | 模块没有 production import；provider 永远报告 `available`，候选来自硬编码 popular list 而非 Maven Central/LSP；`complete()` 没有 AbortSignal、timeout、typed unavailable/error、request generation 或 host replacement-range consumer | **model only；N8.1** |
| N7 Evidence | `pnpm exec tsc -b`、新增相关 5 files/45 tests 通过 | 无 Tauri byte fixture、nested reload host、双实例 Action/Locations UI、dependency real provider/QA；现有纯测没有触达上述失败路径 | **unit only；N7.5** |

**Code review 结论。** 本提交没有完成 §8.10。优先级不是继续增加 API，而是先封闭 N1 同长度 stale write 和 N6 tree/group 数据不变量；随后把 N0/N2/N8 的新模型接进唯一生产 owner。Debug 的高优先级错误见 Debug 文档 §15.13。

### 2.17 v4.40 `a4584916` + `b4e7325f` as-built 复核（2026-08-19）

本节审计 §8.11 合同（N1.4/N6.4/N0.4/N2.4/N8.1/N7.5）的实际执行结果。方法固定：对每个子包沿生产调用链核对 owner、参数流、异步生命周期与写盘字节，再运行仓库自带的 host 级测试；提交说明中的 “fulfill” 一律拆回 `model → wired → workflow → verified`。

| 子包 | 本轮确认落地 | 复核发现的阻断事实（含证据） | 等级 / 下一包 |
|------|--------------|------------------------------|---------------|
| N1.4 Save revision | `OpenFileViewModel.documentRevision`（`editorGroupTypes.ts:52`）；user typing 与 programmatic 更新各自 +1（`CodeWorkspaceTab.tsx:2573,2698`）；`bufferVersion`/`getLatestBufferVersion` 改读 revision（`:3416,3447`），同长度编辑不再穿过 guard | ① 写盘回填的 `cleaned` 展开保存前快照（`:3279-3311`），并发输入后把 revision **回退**到 `tx.bufferVersion`，单调性不成立；② `reloadFile` 与编码 reload 换文本却不 bump（`:3508-3520`、`:4482-4498`），in-flight save 的 guard 看不到变化；③ open-clean WorkspaceEdit 仍直调 `saveOpenBufferText`（`:5641-5643`），closed-file 仍直调 `writeDisk`（`:5677-5719`），未共用 SaveTransaction/style/取消；④ 成功 hash 仍可回落客户端合成值（`workspaceStyleController.ts:498`）；⑤ 冲突分类靠 `conflict|hash mismatch` 字符串嗅探（`:502`），后端真实消息是 `File changed on disk; expected hash …`（`src-tauri/src/workspace.rs:2098-2101`），**真实磁盘冲突被误报 `failed`**，typed conflict 分支在生产不可达 | **wired / correctness gap；N1.5** |
| N6.4 Tree/group ownership | `updateLeafInTree` 在 close 时同步 destination leaf 的 `openFileKeys/activeKey`（`recursiveLayoutTree.ts:519-531,626-635`）；`validateTreeGroupConsistency` 双向校验函数已实现（`:538-576`）；ratio 归一化按 sum 折算，percentage 输入安全（`:151-171`） | ① `validateTreeGroupConsistency` **无任何生产 caller**（store 的 5 个 layout mutation 与持久化都不调用），“不一致拒绝持久化 + diagnostic” 未实现；② 迁移目标取 `getAllLeafNodes(newTree)[0]`（preorder 首个 leaf）而非被关 leaf 的兄弟（`:604-605`），关闭右侧/下方 leaf 会把 tab 丢到不相关分屏；③ 仅当 destination group 已存在才迁移（`:611`），否则 tab 静默消失；④ hydrate 只补 leaf→group，不清 orphan group、不修 divergent `openOrder/activeKey`，且无条件补 `primary/secondary`（`workspaceLayoutPersistence.ts:180-219`） | **wired / invariant gap；N6.5** |
| N0.4 ActionHost | controller 已在生产挂载，`executeWorkspaceCommand`、菜单 registration、capture-phase keydown 都经 instance host（`CodeWorkspaceTab.tsx:7495-7532`）；adapter 精确追踪 installed adapter 且 `await Promise.resolve(cmd.run)`，thrown/rejected → `failed`（`workspaceActionHost.ts:110-158`） | **P0 回归。** ① 旧 `commandFocusForTarget`（terminal/tree/editor/workspace 推导）被删除，改为常量 `activeFocus:"workspace"`（`:7498`）；② `host.execute` 用自身 `getContext()` 重建 ctx 并只把调用方参数挂到 `payload`（`workspaceActionHost.ts:234`），于是 **4 个 editor-only 命令**（`renameSymbol` Shift+F6、`callHierarchy` Ctrl+Alt+H、`typeHierarchy` Ctrl+H、`toggleBookmark` F11，`:6837,6984,6994,7011`）与 **7 个 tree-gated 命令**（`tree.open/rename/delete/addToGitignore/findInDirectory/copyPath/copyRelativePath`，`:7291,7323,7334,7347,7365,7375,7387`）的 `when` 恒为 false → 键盘、树右键菜单与左树工具条按钮**静默 no-op**；`toggleSoftWrap`/`toggleColumnSelection` 因 when 里同时接受 `"workspace"` 才侥幸可用（`:7042,7051`），`workspace.format` 的 `focus==="tree"||"terminal"` 负向判定则反过来**永远放行**（`:6769`），即同一个缺陷同时造成假阴性与假阳性；③ 12 处 `context.payload` 读到的是包裹对象（`{focus,payload}`），Copy Path 之类即使执行也拿不到 `rootId/path`；④ `getState` 与 `execute` 使用两套 context 构造，出现“菜单可点、执行 no-op”的分叉；⑤ `executeCommand` 丢弃 typed `ActionResult` 只回 boolean；⑥ keydown 仍在 controller 内基于 `WorkspaceCommand[]` 匹配键位（`useWorkspaceActionsController.ts:104-123`），`host.dispatchKeydown` 与 `keymapModel` 均无 consumer（三份键位实现）；⑦ Search Everywhere 列表仍来自原数组（`:7522-7525,10822`）；⑧ 无 `host.dispose()` 调用 | **regression / must-fix；Gate R0 + N0.5** |
| N2.4 Locations owner | controller 注入 `useWorkspaceFileActions`，rename/delete/目录子树走实例 API（`useWorkspaceFileActions.ts:442-453,513-517,570-581`）；dialog 支持条目 Delete 与 breadcrumbs 搜索（`RecentLocationsDialog.tsx:32-79`） | ① Delete 只删 Recent Locations，不同步 Back/Forward（`:75-79`，`useWorkspaceNavigation` 无删除 API），与 IDEA 2026.2 语义不符；② Ctrl+Tab Switcher 仍不存在（仅 `workspaceActionRegistry.ts:587` 的 keywords）；③ global tracker fallback 仍留在公开 API 与 dialog 分支上，双真值未删除；④ canonical identity（大小写折叠/UNC/symlink）与 cut-paste 更新无证据 | **wired / partial；N2.5** |
| N8.1 Dependency completion | `MavenCentralDependencyIndexClient`（TTL+LRU、3s deadline、AbortSignal 转发）、`InMemoryDependencyIndexClient`、Maven/Gradle 光标上下文检测与 typed `available/unavailable/error/cancelled/timeout`（`dependencyCompletion.ts:229-568`） | ① **零生产 import**（全仓 grep 仅模块自身与其单测），CodeMirror completion host 未接；② 候选来自 webview 直连 `fetch("https://search.maven.org/solrsearch/select")`（`:273-274`），未经 §8.11 指定的 backend `DependencyIndexClient` 代理，绕过应用 proxy/CSP 与凭据治理；③ 版本来源把 solr `doc.tags`（关键词数组）当 versions（`:283-287`），version 补全会插入非版本文本；④ `capabilityState` 常量初始化 `available`、`isAvailable()` 只判 `typeof fetch`，离线不会转 unavailable；⑤ item 无 replacement range，无一次性显式 Retry 状态机 | **model only；N8.2** |
| N7.5 证据 | `pnpm exec tsc -b` 干净；定向纯测 6 files / 59 tests 通过 | **host 级回归为红**：`CodeWorkspaceTab.test.tsx` 3 个用例失败（capability-gated call/type hierarchy 快捷键、tree 右键 Copy Path、F11 书签），与 N0.4 回归一一对应；无 Tauri 字节 fixture、无 nested layout reload host、无双实例 Action/Locations UI、无 dependency real provider/QA | **gate red；Gate R0 后重跑** |

#### 2.17.1 本轮验证事实

- `pnpm exec tsc -b`：exit 0，无输出。
- `npx vitest run dependencyCompletion.test.ts recursiveLayoutTree.test.ts workspaceStyleController.test.ts workspaceActionHost.test.ts navigationHistoryModel.test.ts codeWorkspaceStore.test.ts`：6 files / 59 tests 全绿。
- `npx vitest run CodeWorkspaceTab.test.tsx EditorGroup.test.tsx dapDebugModel.test.ts useCodeDebugSession.test.tsx panels/DebugPanel.test.tsx panels/debug/DebugConsolePane.test.tsx`：6 files / 204 tests → **201 通过、3 失败**，全部失败集中在 `CodeWorkspaceTab.test.tsx`。
- 结论：纯模型层测试的绿色不能代表能力可用；本轮的 P0 结论来自生产调用链审计 + 现存 host 测试的红色，二者互相印证。任何后续 PR 必须先让这 3 个用例转绿，再谈新增能力。

### 2.18 IDEA 2026.2 编辑器能力再对照（本轮新增缺口登记）

本节只登记 **此前文档未覆盖或仅零散提及** 的 IntelliJ IDEA 2026.2 Code Editor 能力，均以 JetBrains Help 公开描述为准，并逐条给出本仓库现状证据。已在 §2.5/§8.10 记账的项（Smart/Type-matching completion、Full Line、SSR、inspection/data-flow、code-style scheme/rearrange/cleanup、Surround/Generate、clipboard-history 之外的 P2 appearance、logpoints、smooth caret）不重复。

| # | 官方能力 | IDEA 行为要点 | 本仓库现状（证据） | 归属包 |
|---|----------|---------------|--------------------|--------|
| 1 | 文件内 Find/Replace bar | Preserve case 替换、In comments / In string literals / Except comments 过滤、Find in Selection、Select All Occurrences、多行输入、正则辅助 | 直接使用 CodeMirror stock `openSearchPanel`（`CodeMirrorHost.tsx:42,676`），以上选项全无 | **N9.1** |
| 2 | Find in Files 作用域 | Project / Module / Directory / Scratches / 自定义 scope / Recently viewed、file mask、结果窗 pin 与 “Open in Find Window”、替换逐项排除 | 仅 include/exclude glob + case/word/regex（`FindInFilesPanel.tsx:165-170,443-445,491-505`）；Replace All 只有总量确认，无逐项排除或预览 | **N9.2** |
| 3 | 剪贴板工作流 | Copy Reference（Ctrl+Alt+Shift+C）、Paste from History（Ctrl+Shift+V）、Paste as Plain Text、多光标复制/粘贴按 caret 分发 | 全部缺失（全仓无 `clipboardHistory`/`copyReference`/plain-paste 实现） | **N9.3** |
| 4 | Completion 设置面 | autopopup delay、match case、sort by relevance/alphabetically、insert by space/dot、自动展示文档 | 80ms debounce / 200 cap 为常量（`lspCompletion.ts`），无设置项与持久化 | **N9.4** |
| 5 | Reader mode / rendered doc comments | 编辑器内渲染 Javadoc/KDoc、行内图片与链接、`Toggle Rendered View`、Quick doc on hover 开关 | `DocumentationPane` 仅手动触发的侧栏文档，无 rendered 注释与 hover 设置 | **N10.1** |
| 6 | 逐文件高亮级别 + inspection widget | 右上 widget 显示错误/警告计数、上下跳转、Highlighting level（None/Syntax/All Problems）、profile 切换入口 | 只有 Problems 面板与状态栏聚合（`AnalysisPanel.tsx`），无 per-file 级别与 widget | **N10.2** |
| 7 | 编辑器通知 banner | read-only、编码不匹配、SDK/project 未导入、索引中等带 action 的顶部横幅 | 只有单行 `statusMessage` 与模态 dialog，缺少可停留、可操作的编辑器内横幅 | **N10.3** |
| 8 | File and Code Templates | New → Class/Interface/Record 由可编辑模板生成（Velocity 变量、文件头/版权、按语言分组） | 只有创建空文件（`workspace.tree.newFile`），无模板体系 | **N11.1** |
| 9 | Open in Right Split / tab 策略 | Search Everywhere 与项目树 Shift+Enter 在右侧分屏打开；tab limit、closing policy、tab 拖入分屏 | 递归 layout 可分屏，但无该入口与 tab 策略（§2.15/§2.16 已记录 drag-to-split 缺失） | **N11.2** |
| 10 | Bookmarks | 助记书签（Ctrl+F11 数字/字母）、Bookmarks 工具窗按列表分组、按助记跳转 | `todoBookmarks.ts` 仅布尔行书签 + TODO 扫描，无助记/分组 | **N11.3** |
| 11 | 通用 Compare | Compare with Clipboard / Compare Files / Compare with Branch、对选区做 Local History diff | 仅 git gutter/peek 与 local history 快照，无通用 compare 入口 | **N11.4**（注意 §2.3 的 Git/X 边界：只做编辑器内 compare 视图，不做 Git 客户端） |

**边界声明。** 以上 11 项全部属于 Editor 主线（§2.3 纳入范围），不扩大 X 轨道；npm/cargo/go 依赖补全、第三方插件生态、AI Assistant 仍按既有决策延期或排除。每项完成度仍按 §2.4 的 L0–L3 与 `model/wired/workflow/verified` 双轨记账，不因为“有面板/有开关”视为达成。§2.18 的 11 项在本轮（`5ce13c9a`）复查后**全部仍为 L0**（`clipboardHistory`/`copyReference`/`EditorBanner`/`FileTemplate`/`mnemonic`/`highlightingLevel`/`preserveCase`/`openInRightSplit` 全仓无实现），执行顺序改由 §8.13 统一排定。

### 2.19 v4.41 `c5ce1fd6` + `5ce13c9a` as-built 复核（2026-08-20）

本节审计 §8.12 合同（Gate R0 / N1.5 / N6.5 / N0.5 / N2.5 / N8.2 / N7.6）的实际执行结果。方法不变：对每个子包沿生产调用链核对 owner、参数流、异步生命周期与写盘字节，再运行仓库自带 host 级测试；提交说明中的 “implement/complete” 一律拆回 `model → wired → workflow → verified`。

| 子包 | 本轮确认落地 | 复核发现的阻断事实（含证据） | 等级 / 下一包 |
|------|--------------|------------------------------|---------------|
| Gate R0 Action context | `commandFocusForTarget` 恢复为纯函数并作为 `resolveFocus` 注入（`CodeWorkspaceTab.tsx:7565-7585`）；`buildContext` 是唯一 context 构造，优先级 `explicit ctx > eventTarget > 默认 focus`（`workspaceActionHost.ts:185-236`）；payload 契约统一到 `ctx.payload`，12 处 run/when 与 3 处调用方 `{focus,payload}` 一致（`:2436-2459`、`:7363-7459`）；controller 内第二套 keydown 匹配已删除，改走 `host.dispatchKeydown`（`useWorkspaceActionsController.ts:112-120`）；3 个红测转绿 | ① **`host.dispose()` 无生产 caller**：`5ce13c9a` 为规避 StrictMode “mount→cleanup→mount 复用同一 `useMemo` 实例” 的问题直接删掉 cleanup（`useWorkspaceActionsController.ts:85-87` 留空），host 与其 action/command 表随 workspace 切换永久累积，Gate R0 第 6 条与“旧 host `execute` 返回 `failed`”验收不可能成立；② typed result 无接收方——`useWorkspaceActionsController` 调用处未传 `onCommandExecuted`（`:7576-7585`），`no-op/cancelled/failed` 全部静默丢弃；`executeCommand` 仍返回 `boolean` 且 `void host.execute(...)` 即弃；③ Search Everywhere 与 cheatsheet 仍读原始 `WorkspaceCommand[]`（`:7604-7607`、`:11110`），且 `runSearchEverywhereCommand` 不带 focus（`:7609-7612`）→ Shift+F6/Ctrl+Alt+H/Ctrl+H/F11 从 SE 触发恒 `no-op`，与快捷键路径结果不一致（违反 R0“四条路径一致”）；④ `buildContext` 靠键名嗅探区分 `ActionInvocation`/`WorkspaceActionContext`/裸 payload（`:206-222`），payload 中出现 `context`/`signal`/`focus` 键即被误解析，且无开发模式 warning；⑤ `execute` 对调用方 ctx 再跑一次 `buildContext` 并二次求值 `when`（`:316-323`，`dispatchKeydown` 已判定过一次），非幂等 `when` 可分叉；⑥ 键位裁决顺序未固定（actions 与 command adapter 同在一张 insertion-order 表，`:364-399`），无冲突 diagnostic；⑦ `search()` 对每个 action 调 `getState` → 每次重建 ctx，且 `menuItems/searchableCommands` 仅以 `[host, revision]` memo，focus/capability 变化后 enabled 陈旧 | **wired / partial；Gate R1** |
| N1.5 唯一写盘与 revision | `mutateOpenBuffer(key, patch, reason)` 落地，`save-writeback` 用 `Math.max` 保留最新值、其余 reason 在文本变化时 +1（`CodeWorkspaceTab.tsx:2589-2631`）；`writeTextSnapshot` 成为唯一低层写盘并覆盖 open-buffer save、open-clean WorkspaceEdit、closed-file WorkspaceEdit 三条路径（`:3231-3293`、`:3337`、`:5721`、`:5787`）；无 hash 即 `failed("writer returned no hash")`（`workspaceStyleController.ts:496-502`）；后端 `hash-mismatch:` 前缀 + 前端 `startsWith` 判别（`src-tauri/src/workspace.rs:2101,2162,3091`） | ① **P0 数据缺陷**：closed-file `writeDisk` 签名只接 5 个参数，丢弃 applier 传入的第 6 个 `diskEol`（`workspaceEditApply.ts:149`），并硬编码 `policy.eol:"lf"`（`CodeWorkspaceTab.tsx:5757-5796`）→ 未打开的 CRLF 文件经 rename/refactor 落盘后整文件变 LF，正是 N1.5 验收矩阵最后一条要禁止的行为；② `saveOpenBufferText` 仍直接覆写 `openFilesRef.current` 并写入 `text: textToSave`（`:3311-3318`），绕过 mutate helper，format-on-save 改文本时不 bump revision；失败分支只走 `setOpenFiles`（`:3392-3404`），ref/state 分叉；③ save 端 `executeSaveTransaction → resolveForFile({filePath,text})` 不传 `explicitOverride`（`workspaceStyleController.ts:417-420`），而 `formatFileText` 传（`:3431-3435`）→ 状态栏缩进 override 在“保存规范化”中失效，两条链路策略不一致；④ 最终 version guard 之后仍有 `historySnapshot` 等 await 才真正写盘（`:3319-3347`），合同要求的“guard 到 writer 之间无 await”未达成；⑤ 冲突判定仍是字符串前缀协议而非 typed `Result`，`workspace.rs` 三处消息与前端四条 `includes` 分散耦合 | **wired / P0 correctness gap；N1.6** |
| N6.5 布局不变量 | `commitLayoutMutation` 对 split/close/move/setActive/closeTab/setRatios/replaceFileState 七处生效，失败即丢弃 mutation（`codeWorkspaceStore.ts:425,455,489,527,565,591`）；`findAdjacentSiblingLeaf` 按父 split 相邻索引取兄弟、兄弟为 split 时取 preorder 首 leaf（`recursiveLayoutTree.ts:587-630`）；`atomicCloseLeaf` 缺 destination group 时先创建、返回 `migration:{destinationLeafId,migratedKeys}`、同步 leaf 的 `openFileKeys/activeKey`（`:670-751`）；持久化前双校验、orphan group 清理、坏树降级单 leaf 并置 `layoutRecovered`（`workspaceLayoutPersistence.ts:186-294`、`recursiveLayoutTree.ts:923-948`） | ① 默认 `layoutTreeV2: null`（`codeWorkspaceStore.ts:150`）→ 首次打开走 `splitOrientation` 旧渲染分支与 `renderEditorGroup("primary"/"secondary")`（`CodeWorkspaceTab.tsx:10494-10518`），递归布局只在分屏或恢复后生效，两套路径长期并存；② 多 view 语义（N6.5 第 3 条）未实现：inline blame 只 `loadForGroup("primary")/("secondary")` 并把 `editorGroups.primary/.secondary.activeKey` 写进 deps（`:4925,4926-4933,4976-4977`），local-history/游标等同构，第三个 leaf 无 blame/history；快照仍按双组枚举（`:2951-2971`）；③ `normalizeWorkspaceLayoutSnapshot` 就地写 `leaf.openFileKeys/activeKey`（`workspaceLayoutPersistence.ts:231-232`），而 `writeWorkspaceLayoutSnapshot` 传入的是 store 活对象 → 在 zustand `set` 之外突变 state，破坏结构共享与 no-op 引用相等；④ 校验失败只 `console.error`（`recursiveLayoutTree.ts:650,657`、`workspaceLayoutPersistence.ts:290`），无 `layoutDiagnostics` 状态/状态栏提示；⑤ 关闭 leaf 后 buffer 生命周期仍按 group 语义，未实现“最后一个 view 关闭才走 dirty 提示” | **wired / partial；N6.6** |
| N0.5 keymap 真值 | `keymapModel.ts` 补 `resolveBinding`/`findConflicts`/`export/importKeymapSchemeToJson`；host 的 `ActionState` 带 `disabledReason`（`capability`/`busy`/`unsupported`） | **仍 model only**：`keymapModel` 全仓零生产引用；绑定真值仍是 `WorkspaceCommand.keybinding`（82 个命令）+ `workspaceEditorKeymap`（`workspaceEditorCommands.ts:483-503`）+ `CodeMirrorHost` 内联 keymap（`:825-849`）三处硬编码；无 scheme 持久化/copy/rename/reset/import/export、无冲突 UI、无未绑定 action 的可执行保证；`disabledReason` 未被任何菜单/tooltip 消费；`debugActionService` 仍是第二份 action 真值 | **model only；N0.6** |
| N2.5 双历史与 Switcher | `LocationIdentity`、`canonicalizeWorkspacePath`、`NavigationHistoryFacade`（`remove`/`relocate`/`removeSubtree`）已定义（`navigationHistoryModel.ts:389-439`） | ① **facade 零生产引用**，且其 `remove` 只跨“instance controller + 全局 tracker”两个 Recent-Locations 源，**完全不触及 `useWorkspaceNavigation` 的 Back/Forward 栈** → 合同核心“Delete 同步双历史（IDEA 2026.2 语义）”未实现；`RecentLocationsDialog.tsx:71-79` 仍直接调 controller/global tracker；② `canonicalizeWorkspacePath(path, _platform)` 忽略 platform，`canonicalizePath` 只做分隔符归一并把盘符**小写**（`:43-51`），无 macOS/Windows 大小写折叠、无 UNC 前缀策略、无 `realpath`；③ Ctrl+Tab / Ctrl+Shift+Tab Switcher 全仓无实现；④ 条目 `current/stale/missing/relocated` 状态机未实现 | **model only（P0 项未动）；N2.6** |
| N8.2 依赖补全 | 后端 `src-tauri/src/dependency_index.rs` 三命令已实现并注册（`lib.rs:510-512`），版本查询用 `core=gav` + `sort=timestamp desc`、丢弃 solr `tags`（`:241-297`），reqwest 3s timeout + 有界 TTL 缓存；前端 `BackendDependencyIndexClient` 改走 `invoke`，webview 直连 `fetch` 已删除；dev stub 覆盖三命令（`src/stubs/tauri-core.ts:1999-2030`） | ① **`dependencyCompletion.ts` 仍零生产 import**，CodeMirror completion source 未注册 → 用户不可达，能力等级不变；② 后端未接应用 proxy（`build_client()` 只设 timeout/UA，无 proxy/AppState 入参），违反 “统一走应用 proxy 设置”；③ `dependency_index_status` 每次都真发一次网络探测，无 TTL 缓存；④ `capabilityState` 两个 provider 类仍常量初始化 `"available"`（`dependencyCompletion.ts:353,466`），合同要求 `unknown`；⑤ `search()` 不把 `signal`/`timeoutMs` 下传（invoke 无法取消，需 generation + 结果丢弃）；⑥ `replacementRange` 只在类型里，无生产插入逻辑与 golden case | **backend workflow / frontend model；N8.3** |
| N7.6 证据 | `pnpm exec tsc -b` exit 0；`npx vitest run` 9 files / **137 tests 全绿**（CodeWorkspaceTab、workspaceActionHost、recursiveLayoutTree、workspaceStyleController、navigationHistoryModel、dependencyCompletion、workspaceLayoutPersistence、keymapModel、codeWorkspaceStore） | 无 Tauri 字节 fixture（LF/CRLF/CR × UTF-8/BOM/UTF-16/Latin-1）、无 nested reload/resize host 用例、无双实例 Action/Locations UI 用例、无 real-provider / no-provider 两条 dependency QA；`qa-ui-auto-tests/**` 在 `c5ce1fd6`、`5ce13c9a` 均未改动（最后一次相关更新在 `a4584916`）→ feature-list / testid-catalog / YAML control case 同步项未执行 | **unit only；N7.7** |

#### 2.19.1 本轮验证事实

- `pnpm exec tsc -b`：exit 0，无输出。
- `npx vitest run CodeWorkspaceTab.test.tsx workspaceActionHost.test.ts recursiveLayoutTree.test.ts workspaceStyleController.test.ts navigationHistoryModel.test.ts dependencyCompletion.test.ts workspaceLayoutPersistence.test.ts keymapModel.test.ts codeWorkspaceStore.test.ts`：9 files / 137 tests 全绿（§2.17 的 3 个红测已修复）。
- 未执行：`cargo test`（提交声明 1287 passed，本轮未复验）、Tauri 运行期、QA YAML、三端真机。
- 零生产引用扫描（`from "./<module>"` 全仓 grep，排除 `*.test.*`）：`dependencyCompletion`、`fullLineCompletionModel`、`inspectionEvidence`、`javaInspectionEngine`、`keymapModel`、`semanticRefactorPlan`、`structuralSearchModel`、`surroundGenerateModel` 共 8 个模块 1700 行仍无任何生产 owner，其中 4 个另有 490 行测试只在验证死代码。

#### 2.19.2 过程与可追溯性问题（必须在后续 PR 修正的工作方式）

1. **单提交混入无关改动。** `c5ce1fd6` 共 144 files / +4455 −1613，其中 123 个 `.rs` 文件；除 `dependency_index.rs`、`workspace.rs` 外，`lanchat/swarm.rs`（+405）、`agent/cmd_classify.rs`、`hbase/**`、`sockscap/**` 等与 §8.12 无关的功能改动被一并提交，且大量文件只是 `use` 顺序重排（例：`servers/telnet.rs` 只把 `super::ServerConfig` 移到 `super::engine::…` 之前）——等价于一次项目级 `cargo fmt`，**违反 `CLAUDE.md`“不得运行项目级 cargo fmt、只对改动文件跑 `rustfmt --edition 2024`”**。后果：无法按提交隔离 workspace 变更、review 成本失控、真实缺陷（如 `writeDisk` 丢 eol）被淹没。后续每个包必须单独提交，Rust 侧只格式化本包改动文件。
2. **以“删除机制”规避 StrictMode 缺陷。** `5ce13c9a` 通过删除 `host.dispose()` 让 StrictMode 通过，属于用回归换绿灯；正确解法见 §8.13 Gate R1 第 1 条（host 由 `useState` 惰性创建 + 释放后自愈重建，或把 dispose 绑到真实 unmount 而非 effect cleanup）。
3. **文档与提交声明不一致。** 提交声明 “implement §8.12 contract” 六项全实现，实际两项（N0.5/N2.5）核心仍无生产 owner、一项（N8.2）前端不可达。后续 PR 必须按 §2.4 四级标注最高等级并给出生产调用链，不得以“类型/函数/单测已存在”充当完成证据。

### 2.20 IntelliJ IDEA 编辑器能力第二批对照（本轮新增缺口登记）

本节只登记 §2.5/§2.18/§8.x 尚未记账的 IDEA Code Editor 长期稳定能力（不依赖任何单一版本的 What's New），每条给出本仓库现状证据与归属包。已登记项（Smart/Type-matching completion、Full Line、SSR、inspection/data-flow、code-style scheme/rearrange/cleanup、Surround/Generate、clipboard history、Find/Replace bar、Find in Files scope、completion 设置、rendered doc、highlighting widget、editor banner、file template、Open in Right Split/tab policy、助记书签、compare、Recent Locations/Switcher、keymap scheme）不重复。

| # | 官方能力 | IDEA 行为要点 | 本仓库现状（证据） | 归属包 |
|---|----------|---------------|--------------------|--------|
| 12 | 保存模型 | 自动保存（切窗/空闲/运行前）、`Ctrl+S` = Save All、`Save All` 独立 action、修改 tab 星号标记与“仅在必要时保存”设置 | 只有单文件显式 `workspace.save`（`Ctrl+S`），全仓无 Save All / autosave / 失焦保存（`grep autoSave` 仅 mail/database tab）；dirty 只有 tab 圆点 | **N13.1** |
| 13 | Navigation Bar | `Alt+Home` 打开面包屑式导航栏弹层，键盘逐级浏览工程结构并打开文件；可常显/隐藏 | 无导航栏；面包屑只显示当前文件符号路径，不可作为工程导航入口 | **N13.2** |
| 14 | Find Usages 工具窗 | `Alt+F7` 结果窗按 module/file/usage-type 分组、过滤（read/write/import 等）、预览栏、pin、Rerun、逐项排除；`Ctrl+Alt+F7` Show Usages 轻量弹窗 | `ReferencesPanel.tsx` 共 96 行平铺列表，无分组/过滤/预览/pin/rerun；无 Show Usages 弹窗 | **N13.3** |
| 15 | 文件内用法与出现导航 | `Ctrl+Shift+F7` Highlight Usages in File（含 read/write 着色与 `Esc` 清除）、`Ctrl+Alt+Up/Down` 在匹配/用法间跳转、`F3/Shift+F3` 循环 | 有 caret 自动 `documentHighlight`（`lsp.ts`），但无显式 action、无 read/write 区分、无 occurrence 上下跳转键位（keybinding 全集无 `Ctrl+Shift+F7`/`Ctrl+Alt+Up`） | **N13.4** |
| 16 | 即时 auto-import | 输入/粘贴未导入符号时弹出 import 提示或按设置自动补全 import（`Add unambiguous imports on the fly`）、粘贴时自动补 import、import 布局/包裹设置 | 只有手动 `Ctrl+Alt+O` optimize imports 与 LSP code action；无 on-the-fly import、无粘贴 import、无 import 设置 | **N13.5** |
| 17 | Scratch files / buffers | `Ctrl+Alt+Shift+Insert` 新建带语言的 scratch，独立于工程但享有全部编辑/补全能力；scratch 作为 Find in Files 的独立 scope | 无 scratch 概念（loose file 需真实磁盘路径） | **N14.1** |
| 18 | 语言注入 | 字符串/heredoc 内注入 SQL/JSON/regex 片段，注入片段获得高亮/补全/格式化，可临时“Edit fragment” | 无注入语言机制 | **N14.2** |
| 19 | 同文档多视图一致性 | 一个文档在多个 split 中共享 undo 栈、折叠/断点/装饰同步，视图各自保留光标与滚动 | 每个 `CodeMirrorHost` 各持 `history()`（`:725`），外部同步用全文替换 dispatch（`:1123`）→ 另一视图 undo 会把整篇替换当一步、折叠/滚动被打断 | **N14.3** |
| 20 | 语句级编辑与多光标补齐 | `Ctrl+Shift+Up/Down` Move Statement、`Ctrl+Alt+Shift+↑/↓` clone caret、`Ctrl+Shift+NumPad±` 展开/折叠全部、`Ctrl+.` 折叠选区、`//region` 自定义折叠 | `workspaceEditorKeymap`（`:483-503`）只有 move line、join、select occurrence、toggle case、goto line；无 move statement / clone caret / 展开折叠全部 / 折叠选区 | **N14.4** |
| 21 | Java 编辑器 gutter 语义标记 | 覆写/实现/被实现方法的 gutter 图标（点击跳转 super/子类）、Code Vision 显示 usages/inheritors 计数 | 无 override/implement gutter 标记，无 Code Vision（gutter 只有 git/coverage/断点/书签） | **N15.1** |
| 22 | Intention 组织与抑制 | Alt+Enter 列表按 quick-fix/intention 分组、子菜单可 “Fix all in file”、按语句/方法/类/文件 suppress，并写入注释或 profile | 只有平铺 code action 列表；无 fix-all、无 suppression 入口、无分组 | **N15.2** |

**边界声明。** 12–22 全部属于 Editor 主线（§2.3 纳入范围）；其中 21/22 依赖 provider 语义，只按 Java 对照 fixture 记账，不得以“LSP 有对应字段”宣称完成。不新增 X 轨道内容，不放开插件生态与 AI Assistant 边界。

---

### 2.21 v4.42 `d641ad12` + `9203d3e4` + `20027dfe` as-built 复核（2026-08-21）

本节以 `HEAD 20027dfe` 为准，取代 §2.19 对当前状态的描述；§2.19 继续作为 `5ce13c9a` 历史快照。审计仍按用户入口 → production owner → provider/IPC → 状态回填 → undo/失败 → host/QA 证据逐段检查，不能用 commit subject 或纯 model 测试升级等级。

| 领域 | 本轮真实增量 | 仍阻断目标的生产事实 | 当前等级 / 下一包 |
|------|--------------|----------------------|-------------------|
| N1.6 EOL / style / conflict | closed-file `writeDisk` 已接第 6 个 `eol` 参数并写入 replay metadata；save transaction 带 `explicitOverride`；错误在 `src/lib/editor/workspace.ts` 边界包装为 `WorkspaceHashMismatchError`；`saveOpenBufferText` 的 state/ref 更新改走 `mutateOpenBuffer`；history-await 后的 inner guard 和 writer-in-flight merge 已有 host 用例 | **G0 数据安全仍为红。** `WorkspaceStyleController.executeSaveTransaction` 在 `:463-489` 做最终 version/style guard 后调用 writer，writer 实际进入 `CodeWorkspaceTab.tsx:3302-3353` 并再次 await `historySnapshot`；这违反统一 PreparedSave 的“最终 guard 到 writer 零 await”合同，虽然当前 inner guard 可取消 history 窗口内的编辑，writeback 也保留 writer-in-flight 的新 buffer。旧 snapshot 完成后仍以旧文本调用 `saveLspDocument`，LSP 顺序错误；错误仍从 Rust 字符串前缀解析，不是跨 IPC 的结构化 enum | **wired / partial；N1.7 P0-S** |
| N1.6 测试与 QA | `writeDiskByteCorrectness.test.ts` 新增 377 行、覆盖 3 EOL × 3 抽象路径、同长度 revision、override 与错误包装；新增 TC-064 YAML | 9 项测试只断言 mock callback 收到的 JS text/eol，不读取 Tauri 临时目录原始 bytes，也不覆盖 UTF-8 BOM/UTF-16LE/UTF-16BE/Latin-1；没有在 `CodeWorkspaceTab` 挂载下把输入注入 `historySnapshot` await 窗口。TC-064 仍只打开 workspace 并截图，未操作保存/style/冲突，不能作为 N1.6 control evidence | **unit/model evidence；N7.8** |
| JDTLS code action bridge | client capability 增加 `codeActionLiteralSupport`；Rust parser 与前端 executor可识别 `_java.apply.workspaceEdit` 等 wrapper 并交给既有 WorkspaceEdit applier；Alt+Enter 菜单已有 host 用例 | wrapper command 名白名单在 Rust/TS 各一份，缺 unknown wrapper/嵌套参数/版本化 edit 的 contract fixture；Rust 改动无对应 parser 单测。该增量可记 provider bridge `wired`，不能推导为 Java import 语义完整 | **L1–L2 provider bridge；J0** |
| 本地 Java import fallback | `javaQuickFix.ts` 被 `CodeWorkspaceTab` 与 `lspCompletion` 生产引用，Java Alt+Enter 可生成本地 import action，LSP inactive 时 completion 可插入类型与 import | `JDK_KNOWN_TYPES` 是 135 行固定字典，含 `org.slf4j`、Spring、Lombok；不读取 JDK language level、module/classpath、source set、已有同名 symbol 或 diagnostics。更严重的是 `LspCompletionHooks` 无 language/file identity，任意语言在 provider 不可用时都能命中并插入 Java import；主文本与 import 分两次 dispatch，provider resolve 的 `additionalTextEdits` 也异步无 revision guard。该能力违反 G0 语言隔离与原子 undo，必须先下线生产 fallback | **用户可达但不合格；P0-J0** |
| Context Menu 键盘 | Arrow Up/Down、Home/End、Enter/Space、左右子菜单与 Escape 已接，分隔/disabled item 会跳过，组件测试覆盖主路径 | 每个 menu surface 通过 `window` capture listener 抢键；缺 `role=menu/menuitem`、roving focus、typeahead、submenu focus restore、同屏多菜单隔离和读屏证据。可记键盘可用基线，不能记完整 accessibility | **L2 局部；并入 Gate R1/N7.8** |
| QuickDoc / hover | QuickDoc popup 可聚焦、缩放、关闭、固定到 Documentation pane；hover 复用同一视觉结构，可固定；CodeMirror tooltip portal 改到 `body` 并限制 editor viewport，减少底部面板遮挡 | hover resize 的 `mousemove/mouseup` listener 只在 mouseup 清理，拖动中 unmount 会泄漏；hover close 仅把最近 `.cm-tooltip` 设为 `display:none`；无 hover on/off/delay、popup/tool-window policy、history/source/external link、Type Info/Context Info；`20027dfe` 没有新增测试或 QA case | **QuickDoc presentation L2 局部；N16** |
| 未触及的主线包 | 最新三提交没有修改 ActionHost/keymap、layout、navigation history/switcher、dependency completion 或 8 个 orphan models 的 owner | Gate R1、N6.6、N2.6、N0.6、N8.3、N12 的 §2.19 结论原样有效；`layoutTreeV2:null`、host 不 dispose、双历史、三份 keybinding 与 dependency completion 零 host import 均仍存在 | **不升级** |

#### 2.21.1 本轮验证与证据边界

- `pnpm exec tsc -b`：exit 0。
- 聚焦 Vitest：`writeDiskByteCorrectness`、`javaQuickFix`、`codeActionExecution`、`lspCompletion`、`QuickDocPopup`、`ContextMenu`、`CodeWorkspaceTab` 共 **7 files / 119 tests 全绿**。
- Rust：`cargo test --lib workspace::tests::hash_mismatch_error_format` 为 **1 passed**；同时输出仓库既有大量 warning，本轮不把 warning 数计作本功能失败。
- `qa-ui-auto audit --diff 5ce13c9a`：131 cases / 0 lint errors、catalog up to date；但有 137 orphan selectors，diff impact 标出 F25.1/F25.2 新旧 controls 未对账，并判定 `TC-auto-F25-1` 含 stale selectors。未启动 Vite，未执行 browser/native case；skill 本身也不验证视觉回归、viewport、a11y 或性能。
- 因此绿色测试只能证明现有用例通过；N1.7 的 host race、非 Java import、completion stale resolve、hover unmount cleanup 与三端行为都没有被现有用例覆盖。

### 2.22 IntelliJ IDEA 2026.2 编辑器能力第三批对照（官方页面复核）

本轮重新读取的官方页面资源均指向 `/help/img/idea/2026.2/`。以下不是根据本仓库 UI 反推的需求，而是 IDEA 真实行为中此前漏记或设计过窄的部分；已有包采用“扩充验收”而不是再造平行 owner。

| # | 官方能力与来源 | IDEA 真实行为 | 当前差距与目标修订 |
|---|----------------|---------------|-------------------|
| 23 | [Code reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html) | Parameter Info 支持自动弹出延迟/完整签名；Quick Documentation 支持 hover 开关、popup/tool window、toolbar/source；Shift+F1 External Documentation；Ctrl+Shift+P Type Info；Alt+Q Context Info | 现有 signature/QuickDoc 只覆盖显示主路径。新增 **N16 Reference Information Service**，统一 revision/provider/result，不能用任意 hover 字符串冒充 Type Info 或外部文档 URL |
| 24 | [Auto Import](https://www.jetbrains.com/help/idea/auto-import.html) | unresolved reference 基于项目 symbol/classpath 给出候选；唯一候选可 on-the-fly；歧义候选由用户选择；paste import 与 optimize-on-the-fly 均可配置 | §8.13 N13.5 设计方向正确，但 `9203d3e4` 的固定字典与跨语言 fallback 相反。拆为 **P0-J0 containment** + 后续 provider-backed N13.5；无 provider 时必须 unavailable，而不是本地猜测 |
| 25 | [Editor Tabs settings](https://www.jetbrains.com/help/idea/editor-tabs.html) 与 [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html) | preview/pin、pinned 单独行、tab limit、alphabetical order、opening/closing policy、reopen closed、MRU switcher、Open in Right Split 与 split stretch/equalize/navigation | 当前只有 preview/pin/overflow 和 partial recursive tree。扩充 **N11.2**：补 reopen/close policies/pinned row/alphabetical；split stretch/equalize/navigation 放在 N6.6 后，不再只设计 tab limit 与 drag-to-split |
| 26 | [Multiple carets](https://www.jetbrains.com/help/idea/multiple-carets.html) | clone caret above/below、next/all occurrence、矩形/column mode、overlap merge、Esc 收敛、按多行/多 caret 分发 paste、virtual-space 行尾规则 | 当前多光标/矩形/同词选择可用，但 clone/paste distribution/virtual-space 与边界 contract 缺失。扩充 **N9.3 + N14.4**，要求单一 transaction、selection mapping 和多平台 clipboard fixture |
| 27 | [Editor General settings](https://www.jetbrains.com/help/idea/settings-editor-general.html) 与 [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html) | 单 editor/全部 editor 字号缩放、字体/ligature/color scheme/high contrast、soft-wrap 文件模式与缩进/标记、virtual space、breadcrumbs 位置/语言开关 | 现有缩放主要是 workspace view scale，code profile 不构成 IDEA appearance 闭环。新增 **N17 Appearance Profile**；与 code-style scheme、Terminal font、Markdown theme 分账，避免一份设置错误控制所有 surface |

**目标边界修订。** G1 只要求 N16 的 Parameter Info + QuickDoc 主路径、基础 tab/multi-caret/appearance 可配置达到 L2；External Documentation、Type Info/Context Info 的 Java 语义完整性、全量 tab policy 和 appearance matrix 可随 G2/G3 交付。这样既比“只有相似 popup”更接近 IDEA，也避免把所有偏好设置都提升为发布阻断。

---

### 2.23 v4.43 P0-S (N1.7) 与 P0-J (J0) as-built 复核（2026-08-21，原完成声明已撤销）

> **纠偏声明。** 工作树中的实现代理确实加入了保存竞态、原始字节和补全隔离测试，但本轮代码审计发现这些测试与生产合同仍有缺口。因此本节的“Complete”不能作为能力完成证据；以下状态由本节末的 **§8.15 v4.43 纠偏合同** 覆盖。只有真实 production host、结构化 IPC 错误和完整请求身份均接通后，才允许提升等级。

本节记录两个最高优先级 P0 工作包的交付与验证事实：

| 领域 | 交付内容与修复事实 | 验证证据 | 状态 |
|------|--------------------|----------|------|
| **P0-S / N1.7 Atomic Save Commit** | 1. `save-metadata` 不改文本/版本；保存链已具备 prepare、同步 pre-write guard、合并 writeback 的雏形。<br>2. `historySnapshot` 与 writer-in-flight host 用例可证明部分竞态不会覆盖当前 buffer。<br>3. Rust 文件新增了 `WorkspaceWriteError` 类型，但它尚未被任何写命令返回。 | - 15 组测试是直接调用 Rust helper 的 lib fixture，不是 open-buffer/closed-WorkspaceEdit/replay 的真实 Tauri host 字节链；编码矩阵使用 `windows-1252`，没有 `ISO-8859-1` fixture。<br>- `WorkspaceStyleController` 仍只接受 `{ hash?: string }` 并用未声明的 `cancelled` 字段做运行时 cast；`saveOpenBufferText` 写完旧 snapshot 后仍会用旧文本调用 `saveLspDocument`，再由 LSP hook 补发当前文本。<br>- `WorkspaceWriteError` 在 `src-tauri/src/workspace.rs` 中产生 dead-code warning，命令签名仍是 `Result<WorkspaceFile, String>`；前端因此仍依赖消息文本启发式。 | **wired / partial；G0 仍红；P0-S2** |
| **P0-J / J0 Provider-Safe Completion & Action** | 1. 生产路径已移除固定 Java completion/import fallback；`javaQuickFix.ts` 仅加了注释但仍位于可被生产源码导入的目录。<br>2. 非 provider completion 会回退 `completeAnyWord`；普通 item 的 primary edit 与 `additionalTextEdits` 尝试合并。<br>3. resolve helper 增加了可选 revision 检查。 | - `LspCompletionHooks.token` 的每个字段都是可选，`CodeMirrorHost`/`EditorGroup`/`CodeWorkspaceTab` 生产接线没有传 token 或 `getDocumentRevision`；`completionInfo` 仍无身份校验。<br>- snippet 分支仍先 `snippet(...)` 再 `applyTextEdits(...)`，是两次 dispatch；普通分支没有检查 edit overlap，也没有把位于 primary edit 之前的 additional edit 映射到正确 selection。<br>- resolve 仍在 primary symbol 已提交后异步插入 import，不是“resolve 后一次提交”或明确的 intention 降级。测试只覆盖直接构造 source 的 plain item，未证明 production host 和一次 undo。 | **containment partial / L1–L2；G0 仍红；P0-J1** |

---

### 2.24 v4.44 当前 HEAD `85be924f` as-built 与 IDEA 2026.2 最终对齐（2026-08-22）

本节是 v4.44/旧 HEAD 的历史“完成情况”覆盖层。审计方法保留作参考；当前事实与等级由 §2.30 覆盖，执行顺序由 §8.20 覆盖。纯模型、静态 catalog、协议字段、单测直接 import 和组件 mock 均不能单独证明 `workflow` 或 `verified`。

#### 2.24.1 当前代码完成情况

| 能力域 | HEAD `85be924f` 事实 | IDEA 对齐结论 | 当前等级 / 待办包 |
|---|---|---|---|
| 保存、WorkspaceEdit、编码/EOL | `saveOpenBufferText` 已有同步 pre-write revision/style/path guard；writer-in-flight writeback 保留当前输入；closed-file WorkspaceEdit 传递 EOL。**v4.45 增量**：encoded 写盘 command 已返回 typed `WorkspaceWriteError`（hash-mismatch/encoding/permission/io + expectedHash/actualHash），前端按 `kind` 归一化、legacy 前缀仅存于 adapter；stale writeback 不再发送旧 `didSave`，只补当前 `didChange`；`executeSaveTransaction` writer 契约为 typed `SaveWriterResult`，runtime cast 已删除。仍缺：`PreparedSave` 统一构造（open-clean/closed-file/replay 仍各走各的策略）、close/unmount 后按 transaction id 丢弃 writeback/LSP、Tauri native trace 与完整编码字节矩阵 | IDEA 语义要求保存成功、磁盘状态、语义 provider 状态同一 revision；旧 `didSave` 在新 `didChange` 前到达的缺口已闭合，但统一事务与 native 证据未齐，不能算 G0 | **L2 partial / G0 红；P0-S3（typed IPC + stale didSave 已闭合，余量见 §2.24.4）** |
| Basic Completion | LSP completion 真实生产调用链；Rust `parse_completion_response` 与前端映射都限制 200 项并把本地截断标为 `isIncomplete`；无 UI 截断/继续查询提示 | 这是性能护栏，不是 IDEA Smart/Type-matching/第二次调用；真实候选仍依赖 provider | **L2 provider basic / P0-J1** |
| Completion 身份与 acceptance | `CompletionRequestToken` 字段仍可选；`CodeMirrorHost`/`EditorGroup` 没有把 file/language/session generation/token 传入 source；inactive provider 携带非空 items 时可被映射；plain additional edits 同一 dispatch，但 snippet 先由 CM helper dispatch，再补 edits；resolve additional edits 异步追加 | IDEA popup、snippet、import 和 undo 是一个可预测的编辑动作；当前存在跨文件/stale 候选和两步 undo 风险 | **L1–L2 partial / G0-J1 红** |
| Java auto-import | `javaQuickFix.ts` 有 `NON-PRODUCTION / TEST FIXTURE ONLY` 头部，生产代码无 import consumer；completion 只走 LSP 或 `completeAnyWord` | 正确方向是 provider/classpath-backed import；固定 JDK/第三方字典不能作为能力 | **L0 local semantic / J0 containment 可关闭，N13.5 未开始** |
| ActionHost / keymap | `useWorkspaceActionsController` 在生产挂载并统一 window keydown；`onCommandsChange` 可把 registration 上送；但 Search Everywhere、Keymap Cheat Sheet 仍接收 `workspaceCommands`，`keymapModel` 无生产 consumer；hook 没有在真实 unmount 调 `host.dispose()` | IDEA 的 action/keymap/search/menu 读取同一 runtime definition，并有 scheme/冲突/上下文；当前是 wired adapter，不是单一真值 | **L1 wired partial / Gate R1** |
| 递归 layout / tabs | v2 snapshot 读写、v1 migration、store mutation、递归 renderer 和 ratio 回写已有生产路径；fresh mount 默认 `layoutTreeV2: null` 仍先走 primary/secondary；WorkspaceEdit tab snapshot 只枚举 primary/secondary；同文档多视图各自 CodeMirror history；无拖拽停靠、detach、equalize/splitter navigation | IDEA 的 nested split、tab policy、同文档多视图应可恢复且状态一致；当前是可用的递归基础，不是完整 parity | **L2 partial / N6.6** |
| Recent Locations / navigation | per-workspace controller、debounced user-edit、tab activation、rename/delete relocate/remove 已 wired；仍保留 deprecated global tracker fallback；`canonicalizeWorkspacePath` 忽略 platform/realpath；Back/Forward 栈与 Recent Locations 分离；没有 Ctrl+Tab MRU Switcher | IDEA 需要 Recent Locations、Last Edit、Back/Forward、Switcher 的明确生命周期和可重定位 identity；当前可查看但历史删除/平台路径语义不完整 | **L1–L2 partial / N2.6** |
| QuickDoc / Reference Information | QuickDoc、hover、pin 到 Documentation pane、resize、ESC/outside close、`body` portal 均可用；缺 hover on/off/delay、parameter auto-popup settings、history/source/external link、Type Info、Context Info；resize listener 没有 unmount 期间的显式 disposer 证据 | IDEA 的 hover/QuickDoc 只是 Reference Information 的一个 surface，不能以 markdown popup 代替完整服务 | **L2 presentation / N16** |
| Diagnostics / inspections / refactor / SSR | LSP diagnostics/Code Action/Rename/Safe Delete/provider refactor 有生产入口；`javaSemanticIndex`、`javaInspectionEngine`、`semanticRefactorPlan`、`structuralSearchModel` 仍无非测试 consumer | provider workflow 可用不等于 IDEA PSI/index/CFG/data-flow；正则原型不能升级 | **L1 provider / L0 local semantic / J1–J3、N12** |
| Full Line / appearance / clipboard / scratch | Full Line model 无生产入口；无 local model/ghost text；font/ligature/color scheme/virtual space/clipboard history/scratch/injection 尚无完整产品闭环 | IDEA 这些是 Editor 能力，不应被 Terminal FIM、workspace view zoom 或 AI selection 代替 | **L0，P2/G3** |

当时的验证记录只说明旧 HEAD 可编译且局部用例通过：`pnpm exec tsc -b`、7 个编辑器相关 Vitest 文件 **87 tests** 和 `git diff --check`；没有执行 Tauri/native、QA YAML、三端发行包或真实 IDEA fixture。因此本节最高证据标签仍为 `wired/partial`，不记为 `verified`。当前验证和未验证项见 §2.30.4/§8.20.8。

#### 2.24.2 IntelliJ IDEA 2026.2 真实能力对照

本轮直接复核的官方页面：

- [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html)：preview/pin/close policy、任意 split、breadcrumbs、sticky lines、virtual space、custom folding、statement-aware editing。
- [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html)：basic、smart/type-matching、重复调用扩展候选、completion settings、live/postfix templates 和 auto-import。
- [Code reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html)：Parameter Info 自动弹出/延迟、Quick Documentation popup/tool window、External Documentation、Type Info、Context Info。
- [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)：declaration/type/implementation、super/sibling/method、last edit、Recent Locations、Find/Show Usages、Search Everywhere。
- [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html)：selection/file/directory/module scope、rearrange、cleanup、formatter markers、imports、on-save/commit actions 和 EditorConfig。
- [Keymap](https://www.jetbrains.com/help/idea/settings-keymap.html)：scheme copy/rename/reset/delete、按 action/shortcut 搜索、增删 shortcut、mouse shortcut 和冲突提示。
- [Full Line code completion](https://www.jetbrains.com/help/idea/full-line-code-completion.html)：Ultimate bundled/local model、单行/多行、整段/逐词/逐行接受、auto-import、硬件与模型不可用状态。
- [Multiple carets](https://www.jetbrains.com/help/idea/multiple-carets.html)：clone caret、next/all occurrence、rectangle、overlap merge、paste distribution、Esc 收敛和 virtual-space 行尾。

对照后的目标不再是“把所有 IDEA 菜单都做一遍”，而是按真实行为拆成四个 profile：

| Profile | 可对外承诺的范围 | 完成门槛 |
|---|---|---|
| **G0 Integrity** | 保存、WorkspaceEdit、undo/redo、外部变更、action 生命周期、语言/workspace 隔离 | typed IPC、单一提交边界、stale/cancel/close 证据和三端原生 fixture 全绿 |
| **G1.0 Daily Core** | IDEA 高频主路径：文本编辑/多光标、basic provider completion、Parameter Info、QuickDoc、Find/Search Everywhere、declaration/navigation、diagnostics/quick fix、format/import、preview/pin/tab/split、recovery | 每项 L2；provider/offline/unavailable 可见；至少 Java + TypeScript fixture；不宣称 Smart/PSI 等价 |
| **G1.1 IDEA Workflow** | 可编辑 action/keymap、EditorConfig/code-style provenance、multi-caret paste/virtual space、Recent Locations/Switcher、tab policy、Reference Information settings、appearance profile | 同一 Action/Settings/Navigation snapshot 被所有入口消费；Linux/macOS/Windows 键盘/IME/缩放/读屏证据；仍不含 Java semantic L3 |
| **G2 Java Semantic** | project/module/classpath context、declaration/reference identity、type-matching completion、inspection/data-flow、usages/refactor conflict/preview/post-condition | Java 17/21、Maven/Gradle、多模块/library/generated roots、syntax error/partial/stale fixture 与 IDEA 对照达到 L3；不能以 jdtls capability 替代 completeness |
| **G3 Advanced Editor** | Full Line local model、Structural Search/Replace、Code Vision、clipboard history、scratch/injection、detach/nested split、完整 appearance/accessibility | edition/hardware/privacy/性能与三端证据独立通过；不阻塞 G1 发布 |

G1 的修订点：Smart/Type-matching、Surround/Generate、provider auto-import 仍是 G2 的语义功能；G1.0 只保证 basic/provider-backed 主路径和诚实 unavailable。G1.1 才承诺 IDEA 的 action/keymap/settings 体验。Full Line 保持 G3/P2，不能用 Terminal FIM 或 AI 选区入口折算。

#### 2.24.3 旧结论覆盖关系

1. §2.21 中“`javaQuickFix.ts` 已被生产引用”的描述已失效；当前它是 test-only fixture，生产 fallback 任务改为 J0 containment/N13.5 provider design。
2. §2.21/§2.23 中“`layoutTreeV2` 仅为 model、无生产 persistence”的描述已失效；当前为 `wired/partial`，fresh mount legacy path、WorkspaceEdit tab restore、shared history 和高级布局仍未完成。
3. §2.19/§2.21 中“ActionHost 未进入生产”的描述已失效；当前 host 已挂载并处理 window keydown，但 Search/CheatSheet/registry/keymap 仍未统一，且 unmount dispose 未接线。
4. §2.11–§2.29 的历史提交测试数字、旧基线 hash 和旧 QA diff 只作审计历史；当前状态和顺序以 §2.30 及 §8.20 为准。

#### 2.24.4 P0-S3 首包实施增量（v4.45，2026-08-22，工作树未提交改动）

按 §8.16.1 领取的第一个工作包，基线为 `21946c7a`（HEAD，`85be924f` 之后）。生产调用链与事实：

1. **typed IPC 写盘错误（Rust）。** `src-tauri/src/workspace.rs` 的 `workspace_write_file_encoded`/`workspace_write_loose_file_encoded` 改为 `Result<WorkspaceFile, WorkspaceWriteError>`；共享 writer `write_workspace_bytes` 全路径分类——hash precondition 失败 → `hash-mismatch`（携带 `expectedHash`/`actualHash`）、编码失败 → `encoding`、`PermissionDenied` → `permission`、其余 io（含 temp open/write/sync/rename）→ `io`；message 不再内嵌绝对路径。此前 `WorkspaceWriteError` 仅有类型定义、零实例化，且产生 dead-code warning。
2. **前端按 kind 归一化。** `src/lib/editor/workspace.ts` 的 `parseWorkspaceWriteError` 以对象 `kind` 为准（camelCase `expectedHash`/`actualHash`），legacy `hash-mismatch:` 字符串前缀仅作为旧 backend 兼容分支保留；新增“同一 kind 三种 message 措辞不影响分类”的 parser 测试。
3. **stale-save LSP 顺序收口。** `CodeWorkspaceTab.tsx` `saveOpenBufferText` writeback：仅当 buffer revision 与 snapshot 一致（saved-current）才调用 `saveLspDocument(..., snapshotText)`；revision 已前进（saved-stale-snapshot）只更新磁盘 metadata、保留当前 text/dirty，并仅以 `syncLspDocument(latest, "change")` 补发当前 buffer，旧 `didSave` 不再发出，下一次显式保存拥有 `didSave`。host 用例（writer-in-flight）已断言 `lspSaveDocument` 不携带旧 snapshot 文本。
4. **typed writer 契约。** `workspaceStyleController.ts` 新增 `SaveWriterResult = { kind:"written"; hash } | { kind:"cancelled"; reason }`，`executeSaveTransaction` 按此判定并**删除 `{ cancelled: true }` runtime cast**；`saveFile` writer 闭包同步返回 typed 结果。

**验证证据。** `pnpm exec tsc -b` 通过；`writeDiskByteCorrectness.test.ts` + `workspaceStyleController.test.ts` 26/26、`CodeWorkspaceTab.test.tsx` 65/65（含新增 stale didSave 断言、parser typed/legacy 用例、typed cancelled writer 用例）；`cargo test --lib workspace::` 58 通过含 4 条新增（typed hash conflict/encoding 零落盘、hash precondition 缺失 io、permission/io 分类），另有 2 条与本次无关的既有 Windows `\\?\` 临时路径环境失败（stash 验证在干净 HEAD 同样失败）；`rustfmt --edition 2024` 仅对本包文件执行；`git diff --check` 干净。

**仍未完成（P0-S3 余量，G0 保持红）。** ① 普通 save、open-clean WorkspaceEdit、closed-file WorkspaceEdit、replay 未统一构造 `PreparedSave`/共享 byte-writer 策略（§8.16.1 步骤 2 未做）；② close/unmount 后 writer 返回未按 transaction id 丢弃 writeback/LSP（步骤 4 后半）；③ `SaveCommitResult` 五态尚未在 controller 层落地（当前仍为 `SaveOutcome` 四态 + writer typed 结果）；④ Tauri native IPC trace、`ISO-8859-1`/完整 `LF/CRLF/CR × UTF-8/UTF-8+BOM/UTF-16LE/UTF-16BE/ISO-8859-1/windows-1252` 字节矩阵、close-tab/unmount deferred host、QA YAML 与三端真机均未执行（未验证）。最高声明等级：**P0-S3 L2 partial，G0 仍红**；下一包 P0-J1 CompletionIdentity。

---

### 2.25 v4.46 历史 HEAD `b74705b5` as-built 复核与 IDEA 能力校准（2026-08-22）

本节曾覆盖 §2.24/§8.14–§8.16 中所有旧基线和过度 `complete` 声明。审计方法继续有效，但当前基线和状态已由 §2.30/§8.20 覆盖；本节只作 `b74705b5` 历史记录。

#### 2.25.1 当前完成情况

| 工作包 / 能力 | `b74705b5` 已证实事实 | 与 IntelliJ IDEA Code Editor 的差距 | 当前判断 / 下一步 |
|---|---|---|---|
| **P0-S3 SaveCommit** | Rust encoded commands 返回 typed `WorkspaceWriteError`；前端按 `kind` 解析；stale snapshot 写盘后只补当前 `didChange`，不发旧 `didSave`；open-buffer 路径已构造 `PreparedSave`、做同步 boundary guard 和 merge-only writeback；`saveCommit.ts` 有纯分类 helper | `workspaceStyleController.executeSaveTransaction` 仍是另一套 `SaveTransactionV2/SaveOutcome`；open-clean/closed-file WorkspaceEdit/replay 未全部消费同一 `PreparedSave` 和 byte writer；没有 controller 级五态 `SaveCommitResult`；close/unmount 只有 live buffer 缺失判断，未用 transaction owner 丢弃全部 writeback/LSP；native trace、字节矩阵、三端证据未完成 | **L2 partial / G0 红**。先完成 §8.17.1 的统一事务和 evidence，不扩展保存功能 |
| **P0-J1 Completion identity** | `CompletionRequestToken` 已从 `CodeWorkspaceTab` 经 `EditorGroup` 传至 `CodeMirrorHost`/`createLspCompletionSource`；token 含 workspace/file/path/URI/language/revision/session generation/request id；stale/inactive 非空 provider 结果回退 word completion；200 项 cap 和 truncation status 已有 | snippet + additional edits 的完整 placeholder/tabstop 语义未证明为一个 acceptance；需要 resolve 的 additional edits 仍在异步分支；resolve timeout/失败虽降级 primary，但没有 IDEA 的完整 reinvoke/Smart/type-matching/visibility/filter 语义；真实 provider trace 和一次 undo 未完成 | **L2 identity/stale containment；acceptance partial；G0-J1 红**。按 §8.17.2 先收口一次 transaction，再谈 Smart |
| **J0 Java import containment** | `workspace/__fixtures__/javaQuickFix.ts` 为 test fixture；生产源码无该 import；非 provider 时只走 `completeAnyWord` | 尚无 classpath/project-aware Java semantic provider，不能提供唯一/歧义 import、module/source ownership 或 post-condition | **containment 可关闭 / semantic L0**。N13.5/J1 另包设计，不把 fixture 计作功能 |
| **Gate-R1 ActionHost / Context Menu** | context menu 行是纯 projection，每行有 prepared evaluation；ActionHost 有 owner/generation/stale-owner/binding diagnostics/typed execute；Search Everywhere/Cheat Sheet 能读取 snapshots；新增 definition/reference/run/debug/AI actions | `CodeWorkspaceTab.prepareBinding().run()` 仍调用 `actionsController.executeAction(actionId, freshInvocation)`，未执行已冻结的 `host.executePrepared(binding.prepare)`；Search/CheatSheet 同时保留旧 `commands` 迁移输入；TabSwitcher 自己注册 `window` keydown，绕过单一 ActionHost；keymap scheme 仍无生产 consumer | **wired / partial**。先闭合 frozen evaluation 和单一入口，再做可编辑 keymap |
| **N6.6 LayoutLifecycle** | 首次状态已有 single-leaf v2 materialization；renderer 递归消费 tree；snapshot hydrate 恢复 active group、每组 active key、ratio 和任意深度 tab state；normalize 前 clone tree | `CodeWorkspaceTab` 仍在 blame/local-history/cursor/signature/debug 等 chrome 中硬编码 primary/secondary 或二组迁移；第三叶没有等价 per-leaf 状态；持久化校验失败只有 `console.error`；detach/equalize/splitter navigation 未做 | **L2 partial**。先完成 per-leaf chrome/refcount/visible diagnostic，复杂 dock 归 G3 |
| **N2.6 Navigation / Switcher** | per-workspace MRU editor file list；Ctrl+Tab/Shift+Ctrl+Tab cycle、释放 Control commit、Esc cancel；有 `workspace-tab-switcher` testid；Recent Locations controller 基础事件和 relocate/delete 已存在 | IDEA Switcher 同时包含 editor tabs 与已打开 tool windows；当前只列 files；listener 直接挂在 window，未走 ActionHost；keyup 只处理 Control，缺 Meta/平台策略；MRU/history 尚非统一 `NavigationHistoryFacade`，Back/Forward 与 Recent Locations 删除可分叉；canonical path 未完整处理 UNC/case/realpath | **wired / partial**。先统一 facade、平台键策略和 tool-window MRU，再补 semantic navigation |
| **N9.3 multi-caret / clipboard / regions** | `EditorClipboardPayload` 支持 segments/rectangular；copy/cut/paste、clone caret、virtual-space facet 和多个 region comment prefix 已接入；CodeMirror 有 rectangular selection | payload 用 `WeakMap<EditorView,...>`，跨 split view 不共享 workspace single-slot；系统 clipboard 只写 `text/plain`，无 paste history/plain-text mode；region 是正则边界而非语言 grammar；没有跨平台 IME/column persistence 证据 | **L1/L2 partial**。G1.1 先完成 workspace-scoped session 和 grammar fixture，clipboard history/50-item retention 归 G3 |
| **N10/N16 appearance / Reference Information** | CSS diagnostic variables、`codeViewProfile`、QuickDoc/hover/pin/resize、Parameter Info 基础路径存在 | IDEA Reference Information 还包括 hover 开关/延迟、signature auto-popup、history/source/external URL、Type/Context Info；appearance 21 控件、font fallback、high contrast/200% zoom、三端 IME/a11y 尚未证明；resize disposer 需真实 unmount 证据 | **presentation L2 / semantic and appearance partial**。按 §8.17.7/§8.17.8 分开验收，不把 popup 外观记为语义完成 |
| **N8.3 dependency completion** | `dependencyCompletion.ts` 有模型/测试 | 当前没有非测试 production import、Maven Central resolver 或 provider owner | **model only / 未完成**。先决定接线或移至 experimental，不能列 complete |
| **N12 orphan governance** | 8 个模型已标 `NON-PRODUCTION MODEL`；`inspectionEvidence.ts` 由 `AnalysisPanel` 局部消费 | 8 个模块仍零生产 owner；“8/8 已结案”只说明加注释，不代表删除/fixture 隔离/coverage exclusion/CI reachability 已完成 | **partial governance**。按 §8.17.9 逐模块做接线、迁移或删除决策 |

#### 2.25.2 重新校准后的目标

保持四层 profile，但把当前已 wiring 的项目和 IDEA 真实语义拆开：

1. **G0 Integrity（发布阻断）**：统一保存提交边界、WorkspaceEdit/replay 字节策略、undo/redo、外部变更、ActionHost 生命周期、completion acceptance 和 workspace/language ownership。任何旧文本覆写、跨语言 import、stale provider 回填、disposed owner 执行都保持红灯。
2. **G1.0 Daily Core**：文本编辑/多光标、basic provider completion、Parameter Info、QuickDoc、Find/Search Everywhere、declaration/navigation、diagnostics/quick fix、format/import、preview/pin/tab/split/recovery 均达到 L2；provider/offline/unavailable 可见。Smart/type-matching、PSI、语义 auto-import 不在此承诺。
3. **G1.1 IDEA Workflow**：同一 Action/Settings/Navigation snapshot 被菜单、快捷键、Search、Cheat Sheet、Switcher 消费；EditorConfig provenance、可编辑 keymap、workspace clipboard session、virtual space、Recent Locations/Switcher、tab policy、Reference settings、appearance/a11y 达到 L2，并有 Linux/macOS/Windows 键盘/IME/缩放证据。
4. **G2 Java Semantic**：project/module/classpath fingerprint、declaration/reference identity、type-matching completion、inspection/data-flow、Find Usages/refactor preview/conflict/post-condition/undo 达到固定 Java 17/21 Maven/Gradle fixture 与 IDEA 结果 L3。jdtls capability 或 regex model 不得代替 completeness。
5. **G3 Advanced Editor**：Full Line local model、Structural Search/Replace、Code Vision、clipboard history、scratch/injection、detach/nested split、完整 appearance/accessibility，独立按 edition/hardware/privacy/performance/三端证据验收，不补偿 G0/G1 缺口。

IDEA 对照结论：IDEA 的多光标不只是“能生成多个 selection”，还要求 rectangle/overlap merge/virtual space/paste distribution/Esc 收敛；completion 不只是 LSP popup，还包含 Smart/type matching、重复调用、settings、snippet/import 的一次 acceptance；Reference Information 不只是 markdown hover；Keymap 不只是静态快捷键表；Switcher、Recent Locations、Back/Forward、tool windows 共享可重定位 identity。后续任务必须对照这些行为和失败语义，而不是对照按钮数量。

#### 2.25.3 当前证据与未验证项

已由本轮复核确认的证据：生产 import 检索、关键 owner/调用链检索、`b74705b5` 作为干净基线、`pnpm exec tsc -b` 通过、5 个聚焦 Vitest 文件 **84 tests 全部通过**、`git diff --check` 通过。仍不能从提交说明或这些浏览器/单测证据推断的内容：Tauri native IPC trace、Linux/macOS/Windows 打包应用、真实 jdtls/java fixture、IME/非 US 键盘/200% zoom、large-project latency、QA YAML diff、跨 split clipboard 和 close/unmount deferred host。§8.17 要求每个包记录命令、fixture、版本、trace 摘要和未验证项；在这些证据齐全前，最高标签只能是 `wired/partial`，不能写 `verified` 或 `complete`。

---

### 2.26 v4.47 §8.17 全包实施历史记录（2026-08-23，已提交为 `c083008e`）

本节记录按 §8.17 固定顺序对九个待办包的当时实施结果与证据。所有改动位于前端 `src/components/editor/**`，无 Rust 生产代码改动；每包按 §8.17.10 回报格式登记。以下“最高可声明”是提交时判断，已由 §2.27 二次审计覆盖。

#### 2.26.1 各包实施明细

| 包 | 实施内容（生产调用链） | 最高可声明 | 残余缺口 |
|---|---|---|---|
| **P0-S3 remainder** | `SaveTransactionRegistry`（`(workspaceId, transactionId)` + per-`(workspaceId,fileKey)` owner epoch；close tab / rename / delete / unmount 全部 bump 并携带 typed reason）；`buildPreparedSave` 统一构造；`commitOpenBufferPreparedSave` 单一 commit 核心（boundary→writer 同步、writeback/watcher/git/semantic/LSP didSave/didChange 逐代 gate）；closed-file WorkspaceEdit `writeDisk` 构造同一 `PreparedSave` 并走同一 `writeTextSnapshot`；`executeSaveTransaction` 返回五态 `SaveCommitResult`（controller 级），writer 契约改为 `(prepared) => {written(hash,file)\|cancelled}` | **L2 wired**（G0 代码面闭合） | Tauri native IPC trace、真实三端 locked-file/hash 场景、close-host 注入矩阵未验证 |
| **P0-J1 remainder** | `parseLspSnippet` 升级为完整 placeholder 区间（choice 取首项为默认）；snippet+additional edits 一次 `view.dispatch`（一次 revision、一次 undo），post-image placeholder span 注册为轻量 tabstop 会话（`advanceLspSnippetTabstop`/`cancelLspSnippetSession` + doc-change 失效器，Tab/Esc 接入 CodeMirrorHost keymap）；请求遥测环（requestId/language/phase/latency/count/truncated，无源码/label）；snippet-only 路径仍走 CM 原生 snippet（单事务） | **L2 identity containment + one-transaction acceptance** | 真实 jdtls trace、Smart/type-matching、reinvoke 语义未做（合同外）；跨语言负例由 containment fixture 覆盖 |
| **Gate-R1 remainder** | `prepareBinding().run()` → `host.executePrepared(prepared)`（不再重入 `executeAction`）；SearchEverywhere/CheatSheet/WorkspacePopupsHost 删除 `WorkspaceCommand[]` 迁移输入，只消费 `ActionSnapshot`；Search/CheatSheet 执行走渲染时 frozen `entry.evaluation`；TabSwitcher 并入唯一 window keydown listener（`eventLogicalKey` 归一 + Ctrl/Meta 平台策略 + keyup release commit）；controller 删除重复 `searchableCommands` 出口 | **G1.0 L2 wired** | 可编辑 keymap scheme 仍无生产 consumer（按合同归后续）；缺跨入口 e2e |
| **N6.6 remainder** | `layoutLeafActiveEntries`（`getAllLeafNodes` 派生）替换 git/blame chrome 的 primary/secondary 枚举；split scroll 同步泛化为全部 sibling leaf（任意深度/数量）；`writeWorkspaceLayoutSnapshot` 校验失败经 `onIssue` 上报用户可见 recovery diagnostic（不再只有 console.error）；ratio 校验与 no-op snapshot 稳定性由既有 tree reducer+测试保持 | **L2 wired** | detach/equalize/独立窗口归 G3；view refcount 由 group 成员关系隐式保证（closeFile `usedByOtherGroup`），未建显式计数器 |
| **N2.6 remainder** | Switcher 列 editor MRU + 7 个 tool windows（同一 cycle/commit 索引空间，commit 激活 dock tab）；Meta+Tab 平台策略与 keyup Control/Meta release commit；`NavigationHistoryFacade`（Recent Locations + tracker + Back/Forward bridge）已接线 rename/delete/subtree 统一 relocate/remove；canonical path 按平台分离 display/comparison key | **L2 navigation workflow** | semantic super/sibling/method 导航归 provider/J1；三端键盘证据未验证 |
| **N16** | `ReferenceInfoController` envelope/history/dispose 已有；QuickDocPopup listener 对称清理 + role/aria/resize handle；Parameter Info 设置（autoPopup/delayMs/showFullSignatures）在 intelligencePreferences；外链 http(s) allowlist；Type/Context Info 保持 provider-only（无伪造推导、无生产入口） | **presentation L2 / semantic L0（显式 unavailable）** | Type/Context/External Documentation 的 provider 语义与 a11y/200% zoom host 证据未验证 |
| **N9.3/N14.4** | 新建 `workspaceClipboardSession.ts`（sessionId/sourceViewId/segments/rectangular/plainText/sourceEol/systemClipboardUnavailable；workspace 单槽注册表）；CodeMirrorHost copy/cut/paste 全部经 session（WeakMap 仅兼容读取）；系统 clipboard 失败保留 session 并显式 unavailable 提示；region folding 升级 `createRegionFoldService`（扩展名→注释 token 语法表；未知语言零折叠；跨语言 marker 不误折叠）；多光标/矩形 paste 单 ChangeSet 单 dispatch（既有 plan 保持） | **G1.1 L2 wired** | clipboard history（G3）未做；跨 leaf 实测、IME/virtual space 三端证据未验证 |
| **N8.3** | `dependencyCompletion.ts`(+test) 迁入 `__fixtures__/experimental/`，生产 import 为零；硬编码 popular list 不再可能接 popup | **model→fixture（治理闭合）** | 真实 Maven/Gradle provider 未实现，归后续独立包 |
| **N12** | 8 孤儿模型逐项决策：4 迁入 `__fixtures__/experimental/`（keymapModel、dependencyCompletion、fullLineCompletionModel、surroundGenerateModel，头注 NON-PRODUCTION FIXTURE）；4 删除（javaSemanticIndex、javaInspectionEngine、semanticRefactorPlan、structuralSearchModel，连同死测 javaSemanticSuite 与 A1 用例）；登记表见 `__fixtures__/experimental/README.md` | **治理完成（fixture/删除两态）** | G2 Java semantic 后端边界（`src-tauri/src/java_semantic/`）为独立新包 |

#### 2.26.2 证据（§8.17.10 最低命令集）

```text
pnpm exec tsc -b                     # 通过（0 error）
pnpm exec vitest run src/components/editor/  # 129 files / 1040 passed / 0 failed（含 CodeWorkspaceTab.test.tsx 集成；聚焦子集 332 passed 先行验证）
pnpm exec vitest run src/components/editor/workspace/__fixtures__/experimental/  # 25 passed
cd src-tauri && cargo test --lib workspace::  # 62 passed / 0 failed（含 raw_bytes_matrix_and_unrepresentable_fixture）
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff HEAD
git diff --check                     # 通过
```

QA audit 结果：报告中列出的 `code-workspace-bottom-tab-*`、`workspace-tool-*`、`debug-*` REMOVED 项为 **QA 目录与 HEAD 之间的预存在漂移**（`git grep` 证实这些 testid 在 HEAD `b74705b5` 已不存在），非本轮引入；broken case `TC-auto-F25-1` 待目录修复（`fix tests`），本轮未改 QA 目录。

#### 2.26.3 仍未验证项（不得据此写 verified/complete）

- **Tauri native**：真实 `invoke` 写盘 trace（hash/bytes/LSP 顺序）、locked file、external hash conflict、UTF-16/ISO-8859-1 真机矩阵。
- **三端**：Linux/macOS/Windows 打包应用内键盘（Ctrl/Meta+Tab）、IME、200% zoom、字体缺失 fallback、系统 clipboard 权限拒绝。
- **真实 provider fixture**：jdtls（snippet+auto-import 一次 acceptance、resolve timeout）、IDEA 行为对照。
- **性能**：大文件保存/补全延迟采样、10k 候选 popup。

本节当时把 G0 标记为“代码面闭合、证据未闭合”；§2.27 首次证明该判断不成立，§2.29 又按当时 HEAD 复核。当前各能力等级和缺口必须读取 §2.30，不得复用本句作为完成证据。

### 2.27 v4.48 当前 HEAD `c083008e` 二次审计与 IDEA 2026.2 目标重置（2026-08-23）

本节覆盖 §2.25/§2.26 的所有“当前”“代码面闭合”和完成状态。审计基线是干净 HEAD `c083008e`；判断仍沿 `用户入口 -> production owner -> provider/IPC -> typed result -> state/writeback -> cancel/error/undo -> QA/native evidence`，不以提交标题、类型存在、静态 catalog、实验 fixture 或单测直接 import 判断能力完成。§2.26 保留为该提交的实施记录，其中确实存在的增量继续有效，但其等级由本节重新校准。

#### 2.27.1 IDEA 真实能力核对边界

本轮再次以 JetBrains 官方 IntelliJ IDEA **2026.2** Help 为产品事实源。目标是对齐公开工作流和失败/配置语义，不复制 JetBrains 私有实现。各页面只证明 IDEA 的能力边界；Taomni 的完成状态必须由本仓库证据证明。

| 官方事实源 | 本轮用于校准的真实行为 | 对目标的影响 |
|---|---|---|
| [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html) | 编辑、选择、tabs/splits、clipboard、折叠与 editor chrome 的基础工作流 | G1 保留高频编辑闭环；复杂 tabs/detach/clipboard history 分阶段进入 G3 |
| [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) | Basic、重复调用扩展、Smart/Type-Matching、auto-import 与 completion settings 是不同能力 | 当前只能记 Basic LSP；Smart、重复调用扩展和 Full Line 不得混写为“completion complete” |
| [Reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html) | Parameter Info、Quick Documentation popup/tool window/history/source、External Documentation、Type Info、Context Info 是一套可区分入口 | 现有 `documentation` production path 不能代表整套 Reference Information |
| [Source navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html) | declaration/type/implementation、back/forward、last edit、super/sibling/method 等导航按 provider/索引能力区分 | 每个 action 显示 capability/unavailable；不由一个 LSP navigation facade 推导全套完成 |
| [Search Everywhere](https://www.jetbrains.com/help/idea/searching-everywhere.html) | Classes/Files/Symbols/Actions/Text 等统一搜索，并保留 action 可发现性 | Disabled action 应保留并展示原因，不应从结果中静默消失 |
| [Keymap](https://www.jetbrains.com/help/idea/settings-keymap.html) | scheme copy/rename/reset/delete、shortcut 增删、按键反查、冲突提示、mouse shortcut | 固定 cheatsheet 不再计作 Keymap；G1 要求 production scheme/store/editor/dispatcher |
| [Editor tabs settings](https://www.jetbrains.com/help/idea/settings-editor-tabs.html) | preview/pin、reopen closed、tab limit/order、opening/closing policy、detach 和丰富 split 操作 | 当前递归 layout 只满足结构基线，tab policy 与 detach 另行验收 |
| [Switcher](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html#switcher) | `Ctrl+Tab` 在文件与工具窗口间循环，释放修饰键提交，Backspace 可关闭选中文件 | 快捷键由 Keymap 解析；不能用固定 `Meta+Tab` 平台分支替代 scheme |
| [Multiple cursors](https://www.jetbrains.com/help/idea/multicursor.html) | clone caret、occurrence、column mode、Esc 收敛、多行 paste distribution、virtual space | 当前矩形 payload 只是子集；virtual space 必须覆盖 caret/mouse/paste 行为 |
| [Editor General settings](https://www.jetbrains.com/help/idea/settings-editor-general.html) | font/ligature、soft wrap、virtual space、breadcrumbs、appearance与editor行为可配置 | 现有 code view profile是局部基线；profile schema、state-preserving runtime update、a11y/三端证据归 C8-E/C9 |
| [Reformat and rearrange](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html) | fragment/file/scope、rearrange、cleanup、exclude/marker 和 save 行为分层 | 当前 LSP format/organize imports 继续单独记账，不能称完整 code-style engine |
| [Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html) | inspection profile、scope、severity、suppression、quick fix 与分析引擎相连 | `inspectionProfile.ts` 只是 provider diagnostic 的客户端显示/过滤层，必须改用准确命名和说明 |
| [Find usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html) | Show Usages 与 Find Usages、分组/过滤/preview/pin/rerun 是可见工作流 | 当前 flat References panel 不够；必须补结果模型和轻量 popup |
| [Refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html) | 语义 refactor 需要 usages、preview、conflicts、scope、apply 与 undo | provider CodeActionKind 入口只能按实际 edit/conflict evidence 升级 |
| [Structural Search and Replace](https://www.jetbrains.com/help/idea/structural-search-and-replace.html) | SSR 是语法感知模板搜索；官方当前主要支持 Java/Kotlin/Scala/Groovy | G3 从 Java fixture 开始，不以 regex/text template 伪造跨语言 SSR |
| [Full Line completion](https://www.jetbrains.com/help/idea/full-line-code-completion.html) | Ultimate bundled、本地模型、硬件 gate、整段/逐词/逐行接受与 auto-import | G3 独立 runtime；popup completion、Terminal FIM、AI action 都不能替代 |

#### 2.27.2 当前代码事实与纠偏矩阵

| 能力 | `c083008e` 生产事实 | 当前等级 | 修订目标 / 工作包 |
|---|---|---|---|
| **文本编辑 / smart keys** | CodeMirror查找替换、选择/多光标/矩形、注释、fold、soft wrap、括号、常用line edit和大文件降级可用；Complete Statement、postfix、jump-out等仍有文本/局部语法启发式 | **常用编辑 L2；semantic edit L0/L1** | C3闭合clipboard/virtual-space，C7按syntax/provider实现statement/surround/generate；文本fallback标Local |
| **保存与磁盘效果** | `saveCommit.ts` 声明五态结果；`commitOpenBufferPreparedSave` 能算 stale，并用 owner generation 丢弃 writeback/LSP；但 `SaveByteWriterResult` 只返回 `written/cancelled`，`WorkspaceStyleController.executeSaveTransaction` 把每个 `written` 重新标成 `saved-current`。close/unmount 在 bytes 已落盘后还返回 `cancelled/writeback-discarded`，调用者无法知道磁盘已改变 | **L1/L2 partial，G0 红** | §8.18.1 建立唯一 `SaveCommitResult` 和 `diskEffect`，补 unknown-effect/recovery/native bytes |
| **WorkspaceEdit / undo / external change** | typed write error、hash conflict、preview/exclude、history/replay 和部分恢复存在；跨文件 WorkspaceEdit 仍是有序 best-effort，不是原子事务 | **L2 bounded** | C0 保持“不伪造跨文件原子性”，补逐操作 effect ledger、resume/rollback 可解释结果 |
| **Code style / formatting** | EffectiveCodeStyle、EditorConfig resolver、LSP document/range format、organize imports、format-on-save和保存normalize已接部分生产路径 | **basic L2 / suite partial** | C8-D补scheme、scope、rearrange/cleanup、exclude/marker、逐字段provenance；无provider就unavailable |
| **Action evaluation** | frozen `PreparedActionEvaluation` 已用于 context menu/Search/Cheat Sheet；单 window listener 已改善入口一致性 | **L2 wired** | C1 保留 frozen snapshot，完成 lifecycle/result consumer 与 runtime catalog 收敛 |
| **Keymap** | `CodeMirrorHost` 仍直接安装 save/search/signature、`workspaceEditorKeymap`、search/default/history/debug keymaps；`workspaceActionRegistry`/`DEFAULT_WORKSPACE_ACTIONS` 未成为 production 唯一 catalog；可编辑模型已迁入 experimental | **L0 用户配置 / L1 静态绑定** | C1 从 ActionHost snapshot 重建 scheme、录键、冲突、持久化、mouse shortcut 和 dispatcher |
| **Basic Completion** | identity、generation、inactive/stale 拒绝、一次 dispatch/undo、telemetry 已接；Live/Postfix Templates 在 `CodeMirrorHost` 生产可达 | **L2 synthetic/wired** | C2 用真实 jdtls fixture 证明 snippet/choice/additional edit/auto-import/reinvoke；无真实 provider 前不得写 verified |
| **Smart/Type-Matching/Full Line** | 无 production Smart mode；Full Line 仅 experimental fixture；choice placeholder 当前默认取第一项，不是可交互 choice session | **L0** | Smart/semantic editing 归 C7；Full Line 归 C8，分别 capability/edition/hardware gate |
| **布局与 leaf chrome** | recursive tree、任意 leaf、hydrate/persistence、per-leaf chrome 和跨 sibling scroll 已生产接线 | **L2 wired** | C4 只补 invariant/corrupt snapshot/native 证据；不得退回 primary/secondary 双组模型 |
| **Switcher / tabs** | editor MRU + 7 个硬编码 bottom-dock 项；`TabSwitcher` 在 editor entries 为空时直接 `null`；无 Backspace close；entry 不含 owner leaf；无 reopen/tab limit/order/open-close policy | **L1/L2 partial** | C4 接实际 ToolWindowRegistry/MRU，保留 leaf identity，补 tab policy、close/reopen/split workflow |
| **Clipboard / multi-caret / regions** | workspace 单槽 store、矩形/segments 分发和系统 clipboard 失败提示已接；store map 无 disposer；virtual space 是局部命令 facet；region 仍是 extension/comment-token regex | **L2 partial** | C3 先闭合 session lifecycle、完整 virtual space 和 syntax/provider folding；history/plain-text/copy-reference 分为 G3 子包 |
| **Appearance / accessibility settings** | code view profile、CSS semantic colors和部分CodeMirror reconfiguration存在；没有完整profile migration、font fallback/high contrast/200% zoom/IME三端证据 | **L1/L2 partial** | C8-E完成state-preserving settings owner，C9执行a11y/zoom/font/IME三端门禁 |
| **Reference Information** | controller 有 request identity/history/dispose，QuickDoc/hover/Parameter Info 设置和 popup/tool window presentation 可用；production 只请求 `documentation`，AbortSignal 只在未取消的 `lspHover` 前后检查 | **presentation L2；suite semantic L0/L1** | C5 让取消进入 IPC/provider，区分 parameter/doc/type/context/external payload 和 capability |
| **Search / navigation** | Search Everywhere 有 All/Classes/Files/Symbols/Actions/Text，navigation facade/Recent Locations 已接；disabled actions 会从 Actions 搜索消失 | **L2 partial** | C1 保留 disabled action + reason；C4/C6 按 identity 与 provider evidence 补导航/usages |
| **Find/Show Usages** | `ReferencesPanel` 使用有界 flat locations；缺 grouping/filter/preview/pin/rerun，缺轻量 Show Usages popup | **L1 workflow** | C6 新建可刷新 result session，明确 scope/completeness/stale 和 source preview |
| **Diagnostics / inspection** | LSP diagnostics、Problems/Analysis、quick fix 可用；`inspectionProfile.ts` 客户端变换/隐藏 provider diagnostics，不会配置或运行 provider inspection | **diagnostics L2；inspection engine L0** | C6 更名/分账，若 provider 不支持 profile control 就显示 presentation-only，不宣称 IntelliJ inspection |
| **Refactoring** | Rename/Safe Delete/provider CodeActionKind、preview、freshness/root guards、WorkspaceEdit undo 存在 | **L1/L2 per action** | C6 通过真实 jdtls fixture 逐 action 验 scope/completeness/conflict/post-condition；不能整体标 complete |
| **Java provider** | Rust 有真实 jdtls process/session、JDK 21 gate、settings、source download、LSP/Java command bridge | **infrastructure L2** | C2/C6 固定 Maven/Gradle/classpath fixture 与脱敏 trace；不声称 PSI/stub/index/data-flow parity |
| **Surround/Generate/SSR/dependency/Full Line** | 相应硬编码模型已删除或移到 experimental；生产功能不存在 | **L0** | C7/C8 从真实 syntax/provider/runtime owner 实现，不把 fixture 搬回生产即算完成 |
| **QA/native evidence** | 只有 `TC-064`/`TC-065` 打开 shell + screenshot，`TC-auto-F25-1` 主要覆盖 execution controls；没有本轮核心 workflow YAML | **证据门禁红** | C9 补 save race、completion、keymap、split/switcher、clipboard、reference、usages 和三端矩阵 |

#### 2.27.3 对 §2.26 完成声明的显式修正

1. **P0-S3 不再是“G0 代码面闭合”。** `SaveCommitResult` 类型存在不等于 controller/host 共用同一事实；disk effect 与 UI writeback effect 必须分开。
2. **Gate-R1 只完成 frozen evaluation 主路径。** 静态 CodeMirror keymaps、全局 `workspaceActionRegistry` catalog 和不可编辑 cheatsheet 仍构成多真值，Keymap 是 G1 未完成项。
3. **P0-J1 只完成 synthetic acceptance 基线。** choice placeholder、重复调用、Smart/Type-Matching、真实 jdtls resolve/auto-import 和一次 undo 证据仍缺。
4. **N6.6 可保留为 recursive layout wired。** 但三端 restore、坏快照、tab policy 和 detach 不是该结论的一部分。
5. **N2.6 不是完整 IDEA Switcher。** 固定工具窗列表、空 editor list rendering bug、leaf ownership、Backspace close 和 keymap policy 尚未闭合。
6. **N16 只完成 QuickDoc/Parameter presentation 子集。** Type/Context/External Documentation 与真正 provider cancellation 未完成。
7. **N9.3/N14.4 只完成 workspace clipboard 单槽与分发基线。** 无 disposer、完整 virtual space、syntax-tree region 和 clipboard history。
8. **N8.3/N12 的“治理完成”只表示死模型不再冒充能力。** dependency completion、Java semantic engine、SSR、Surround/Generate 和 Full Line 的功能状态均是 L0。

#### 2.27.4 当前目标与待办状态

| 目标 | 当前判断 | 解除条件 |
|---|---|---|
| **G0 Editor Integrity Gate** | **红** | C0 的 result/disk-effect 单一事实、close/unmount/external conflict/recovery/encoding-EOL-BOM/undo 通过 host + Rust + native evidence；C1 不再存在静默 action 结果和跨 workspace owner 泄漏 |
| **G1 IDEA-like Daily Editor Profile** | **未达** | C1-C5 的 Basic Completion、编辑/clipboard、Reference 主路径、Search/navigation、tabs/splits、可编辑 Keymap 均至少 L2；C9 的 browser + 三端 smoke 无阻断问题 |
| **G2 Java Semantic Confidence Profile** | **未达** | C2/C6 用固定真实 jdtls Maven/Gradle fixture 分别证明 completion/import/navigation/usages/rename/refactor/diagnostics/quick fix；每项独立登记 scope/completeness/conflict 与 IDEA 对照结果 |
| **G3 Advanced/Companion Profile** | **未启动/分项 L0** | C7/C8/C4-G3 子包按 language/provider/edition/platform 独立验收；不设置“一次完成 IDEA Advanced”的总开关 |

该基线当时采用 `C0 -> C1 -> C2 -> C3 -> C4 -> C5 -> C6 -> C7 -> C8 -> C9`；此顺序现为历史。当前依赖、接口、状态机、迁移、QA 和 Definition of Done 只见 §8.20。

### 2.28 v4.49 C0–C9 实施记录与诚实证据（2026-08-23）

> **历史记录，非当前状态。** 本节保留实现者当时的回报和命令清单，便于追溯代码来源；§2.29 曾复核并撤销其中“G0 代码面 L2/已闭合”“browser 门禁绿”“lint 0 error”“catalog 无新增问题”等当时的当前性结论。后续 agent 不得用本节的勾选、测试数字或最高等级跳过 §2.30/§8.20；R2 后续修复与最新门禁事实也只能从这两个当前章节读取。

本节是 §8.18 十个包在本轮的执行结果。基线为 HEAD `c083008e` 之后的连续提交
（C0→C1→C3→C4→C2→C5→C6→C7+C8→C9）。判断仍沿
`用户入口 -> production owner -> provider/IPC -> typed result -> state/writeback -> cancel/error/undo`。
**本节不把任何包标为 verified/L3**：三端 native、真实 jdtls、性能采样与读屏
smoke 均未运行（见 2.28.4）。

#### 2.28.1 各包实施与最高可声明等级

| 包 | 本轮生产变更 | 最高可声明 | 残余缺口 |
|---|---|---|---|
| **P0-C0** | 六态 `SaveCommitResult`（disk/memory/provider 三轴）；Rust 写盘返回 `WorkspaceWriteAck{file,writtenHash,writtenByteLength,atomicReplaceUsed}`，typed error 带 `effect: none\|unknown` 与 written hash/length；unknown-effect 前端重读分类（committed/none/foreign），foreign 建 v3 磁盘效果台账并阻止该 path 自动重试；controller 不再把 writer 结果重解释为业务态；close/unmount 落盘后返回 `committed-writeback-discarded`（不再伪装 cancelled） | **G0 save 代码面 L2**（`workflow` 级：host 主路径 + cancel/fail/stale + undo/persistence 单测齐备） | crash-window、三端 locked file/native matrix 未验证 |
| **P0-C1** | `KeymapSchemeV3` 存储层（per-app-profile、corrupt 隔离回退）；host 增加 scheme 层 + `prepareBinding()`（user>base 裁决、conflict 不执行、双键 chord 等待/超时/Esc 取消、userDisabled 可见不可执行）；CodeMirror 业务键位迁入显式 `editor.*` action（save/replace/expandSelection/escapeStack），有 host 时不再安装内联 spread 键位；Keymap Settings surface（scheme copy/rename/reset/delete、录键、冲突徽标、恢复默认）；result sink 补 no-op reason | **G1 Keymap/Action `wired`+partial** | 非 US 布局/AltGr/IME/三端打包 smoke 未跑；mouse shortcut 仅 schema |
| **P0-C2** | choice placeholder 升级为可交互会话（Tab 在 choice stop 上单事务轮换、后续 tabstop 重映射、Esc 接受）；重复显式调用 ordinal 追踪（同 revision+position ordinal≥2 → "provider scope unchanged" 标签策略）；`toCompletionProviderResult` 四态 envelope + capability evidence（截断对 200 cap 显式化，null 响应记 stale 而非零候选）；jdtls fixture 合同与期望结构入库（`__fixtures__/jdtls/`） | **Basic Completion synthetic/wired L2**；Java fixture 单项 **platform-unverified** | 真实 jdtls Maven/Gradle trace、resolve timeout 实测未跑 |
| **P0-C3** | `acquireClipboardStore` refcount 句柄（微任务延迟防 remount 误清，归零即清）；C3b 会话内历史环（50 项/1MiB 总量/256KiB 单项、paste-from-history 提升、disable/clear）；`planPaste` 文档化段-光标映射（少循环/多显式丢弃标记）；region 折叠加语法闸：Lezer 可见时 marker 必须在 Comment 节点，字符串/template 拒绝，无 parser 回退启发式（显式命名 text-marker heuristic） | **C3a G1 `wired` L2** | 完整 virtual space（键盘 End/mouse/paste 视觉列 StateField）仅保留既有 clone-caret facet，未全覆盖；跨 leaf 三端实测未做 |
| **P0-C4** | Switcher entry 带 leafId/pinned/preview/open 态；commit 按 `setStoreActiveEditorGroup`+`setLeafActiveTab` 回原 leaf（leaf 已关则迁最近并显式提示 relocated）；tool window 项按 dock MRU 排序并显示 open 徽标；空 editor 列表仍有 tool windows 时正常渲染（修 null bug）；Backspace 关闭选中项（dirty 走确认、tool window 隐藏）；closed-tab 重开栈（50/session，Ctrl+Shift+T 命令）；`TabPolicyV2` 纯模型（limit 驱逐保护 dirty/pinned、display order 投影、activateOnClose）且 limit 已接入 `openFile` 生产路径：超限驱逐 clean preview/最久未用候选，全受保护时显式 over-limit reason 不静默关闭 | **G1 switcher/tab `wired` L2** | detach(C4b)、200% zoom 键盘证据、policy 的 per-workspace 设置面未建（用默认值） |
| **P1-C5** | hover 取消贯通到 native：per-key CancellationToken 注册表，新请求按 seq 取消旧请求并发 `$/cancelRequest`，新增 `lsp_cancel_reference_request` 命令覆盖 popup close；两条 QuickDoc 路径都携带 cancelKey/seq；External Documentation URL 策略收紧（https 默认、http 显式 opt-in、凭据 URL 硬拒） | **Parameter/QuickDoc 主路径 presentation L2**；取消语义 `wired`（mock 级验证到 controller/signal，native trace 未录） | Type/Context/External 保持 typed unavailable（无伪造推导）；hover delay 取消的 CM 内联路径未接 signal |
| **P1-C6** | `javaSemanticEvidence.ts`：SemanticRequestIdentity/projectFingerprint（build/classpath/JDK/provider 任一变化换代）、UsageSession（role 诚实 unknown + roleClassificationAvailable=false、库过滤按 owner 分类、96/批显式 Continue）、RefactorEvidence + Safe Delete 硬阻断 + error/warning apply gate；ReferencesPanel 分组/pin/rerun(需 symbol identity)/批次续读；AnalysisPanel 更名 "Diagnostic presentation profile" 并注明 presentation-only | **evidence ledger `model`+`wired`**；每 capability 的 jdtls 对照 **platform-unverified** | ShowUsagesPopup 独立浮层未建（沿用 tool window）；jdtls fixture matrix 未运行 |
| **P1-C7** | `workspaceSemanticEditing.ts`：Smart/Type-Matching typed gate（provider 无 expected-type 能力时 unavailable 且不给 Smart 徽标——不把 fuzzy Basic 改名）；Complete Statement 保守计划（控制流头/block 边界/续行显式拒绝，不确定 no-op+reason）；Surround With 整行选择计划（Java 子集 if/while/try-catch/synchronized/Runnable，partial/multi-range/read-only unavailable）经命令端口接线（`editor.completeStatement` Ctrl+Shift+Enter、`editor.surroundWith.tryCatch` Ctrl+Alt+T）；Generate Code 候选按 CodeAction kind 过滤 | **各 action `local/heuristic` L1–L2**；Smart 为显式 unavailable（合同允许形态） | Surround 未走 provider syntax 证据（本地模板级）；Generate 成员勾选 dialog 未建 |
| **P2-C8** | 五子包 typed contracts/gates：C8-A SSR schema v1 + 后端缺失显式 unavailable（无 regex 冒充）；C8-B dependency completion 仓库策略（https 可信/http 只读降级/凭据 URL 拒绝，无 popular list）；C8-C Full Line runtime status + 硬件门（x86 unknown 不乐观放行）/edition/model 全门禁；C8-D `CodeStyleSchemeV2`/FormatPlan（字段 provenance 固定优先级、formatter off/on marker 精确匹配、scope 能力缺失即缺 stage）；C8-E appearance profile 增补 `highlighting` 层级并入既有 v1 存储/迁移链 | **全部 `model`/typed-unavailable L1**（合同明确"没有 backend 就 unavailable"） | tree-sitter Java 后端、registry metadata server、本地模型 runtime、ghost text StateField、scheme 管理 UI 均未实现 |
| **Q-C9** | 新增 TC-IDE-C0-01/02、C1-01、C2-01、C3-01、C4-01、C5-01、C6-01/02、C7-01 九条用例；当时记录了 lint/browser 命令结果，但 §2.29 已证明当时的 catalog 与 workflow 覆盖判断失效 | **仅保留历史 run log；R2 已在后续版本修复静态 catalog/workflow，当前 browser/native/provider/三端/性能/a11y 状态见 §2.30.4** | 见 §2.30.4/§8.20.8 |

#### 2.28.2 证据（实际执行的命令与结果）

```text
pnpm exec tsc -b                      # 通过（0 error）
pnpm build                            # 通过（tsc -b + vite build，仅预存在 chunk 警告）
pnpm exec vitest run src/components/editor/
                                      # 139 files / 1123 passed / 0 failed（tab-limit 接线后复跑）
cd src-tauri && cargo test --lib      # 1295 passed / 0 failed（全量，含 workspace 63 / lsp 96）
cargo check                           # 通过（仅预存在 warning）
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
                                      # cases: 141 files, 141 unique ids, 0 error(s)
python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C4-01   # ✅ passed
python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C1-01   # ✅ passed
python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C5-01   # ✅ passed
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff HEAD
                                      # 本包无新增 stale/orphan selector（TC-IDE 相关为 0）
git diff --check                      # 通过
```

QA audit 中剩余 orphan 条目（TC-115/TC-001/TC-auto-F* 等 ~31 条）为
**HEAD 之前预存在的目录漂移**，本轮未触碰；`TC-064/065` 维持 shell smoke 定位，
其 sidebar 入口在纯 browser 欢迎页不可达的问题同样为预存在漂移，
本轮新增用例通过 `welcome-open-local-terminal` + `side-tab-tools`
真实路径进入 workspace，不依赖该坏 selector。

#### 2.28.3 提交序列

| 提交 | 包 |
|---|---|
| SaveCommit single truth + write ack + recovery ledger v3 | C0 |
| editable Keymap + scheme-aware host + CM adapter + settings surface | C1 |
| clipboard lifecycle/history/paste-plan/region gate | C3 |
| real Switcher/tab policy/reopen stack | C4 |
| Basic completion hardening + choice session + envelope + fixture 合同 | C2 |
| reference cancellation 到 native + external URL 加固 | C5 |
| semantic evidence ledger + usage session + 分账命名 | C6 |
| semantic editing plans + Smart gate（接线命令端口） | C7 |
| C8 五子包 contracts/gates + appearance highlighting | C8 |
| QA 用例/catalog/本节记录 | C9 |
| tab limit 接入 openFile 生产路径 + 全量构建验证（`pnpm build`、Rust lib 1295）+ 本节校准 | C4/C9 追加 |

#### 2.28.4 仍未验证项（不得据此写 verified/L3；与 §8.18 各包 DoD 一一对应）

- **Tauri native**：locked file、external hash conflict、UTF-16/ISO-8859-1
  真机矩阵、atomic replace 崩溃窗口、`$/cancelRequest` 真实 provider trace。
- **三端矩阵**：Linux/macOS/Windows 打包应用内 Ctrl/Meta+Tab、AltGr/非 US
  布局、IME composing、200% zoom、系统 clipboard 权限拒绝、字体 fallback。
- **真实 jdtls fixture**：`__fixtures__/jdtls/README.md` 列出的六个项目与
  trace 记录格式已定义，但本轮开发环境无 JDK/jdtls/Maven/Gradle，全部
  Java semantic capability 保持 `platform-unverified`。
- **性能预算**：key-to-paint p95、Switcher 打开 p95、completion 分解延迟、
  10k 候选/1MiB 文件/10k-file workspace 采样 harness 未建立。
- **a11y**：键盘-only 完成、读屏 announcement、high contrast 对比度、
  reduced motion 的人工三端 smoke 未执行。

**历史结论撤销。** “G0/G1 缺的是证据而不是代码路径”曾被 §2.29 证明不成立；其中 save recovery、closed-file WorkspaceEdit、Keymap runtime、真实 tool-window/tab policy 等代码合同已在后续 R0/R1/R5 修复，但 Reference/Usages、shell 稳定性和 native/provider 证据仍未闭合。1123 项 editor Vitest、1295 项 Rust lib 和当时的 browser runner 结果只证明对应提交当时运行过这些命令，不能替代 §2.30.4 的当前 catalog、browser、native 或 provider workflow。

### 2.29 v4.50 当前 HEAD `69165486dee1` as-built 审计与 IDEA 2026.2 再对齐（2026-08-23）

本节覆盖 §2.25–§2.28 的全部“当前状态”“最高可声明”和完成判断。审计对象是干净 HEAD `69165486dee17cfb025745c17ed2568fe16debb3`；方法仍按 `用户入口 -> production owner -> provider/IPC -> typed effect -> state/writeback -> cancel/error/undo -> executable evidence` 追踪。直接 import 的纯函数、无 consumer 的模型、fixture README、类型声明、组件静态渲染和只打开 workspace 的 YAML 均不计工作流完成。

#### 2.29.1 IDEA 2026.2 目标边界复核

§2.27.1 的 JetBrains 官方链接仍有效，本轮复核到的公开页面版本为 IDEA 2026.2（页面 build date 2026-08-18 / build 2666）。以下边界直接约束本轮目标：

1. Basic Completion 的第二次显式调用会扩大候选范围；它与 Smart/Type-Matching Completion 是不同能力。G1 必须保留 invocation/scope 事实，Java 的实际扩展结果由 R3 fixture 验证，不能只显示 ordinal badge。
2. Reference Information 分为 Parameter Info、Quick Documentation popup/tool window、External Documentation、Type Info 和 Context Info。G1 只要求前两项主路径；其余按 provider capability 独立进入 G2/G3，不能由 hover markdown 推导整套完成。
3. Keymap 是可复制/重命名/恢复/删除的 scheme，支持 shortcut 增删、反查与冲突处理。schema 中出现 mouse/chord 不等于 runtime 支持；未经过唯一 dispatcher 的 CodeMirror binding 不计可编辑 Keymap。
4. Reformat、Rearrange、Cleanup、scope、exclusion/marker 和 save action 是不同工作流。G1 只要求 selection/file 基础 format + organize imports；完整 code-style suite 保持 G3，必须由真实 provider/syntax stage 支撑。
5. Full Line 是 Ultimate bundled、本地模型并带硬件/语言 gate，支持整段/逐词/逐行接受和 auto-import。没有模型 runtime 时保持 unavailable 是正确状态，但只能记 L0/L1 contract，不能记功能已实施。

这次目标修订已写入 §2.1：G0 红灯阻断发布而不是阻止所有独立模型/UI 合入；G1 明确加入 Basic 重复调用的 scope/unavailable 语义，并明确不把 Smart、Type/Context Info、完整 code-style/inspection 或 detach 当作发布前置。

#### 2.29.2 当前生产事实矩阵

| 能力 | 当前可保留事实 | 仍未完成 / 代码风险 | 当前等级与下一包 |
|---|---|---|---|
| **Save / recovery** | 六 kind `SaveCommitResult`、disk/memory/provider 三轴、Rust `WorkspaceWriteAck`、unknown effect 后 read-back、owner-generation 丢弃 writeback 已生产接线 | unknown ledger 的 `intendedNewHash=null`；foreign observed hash 被写成 `lastVerifiedAt`，`hasUnverifiedUnknownDiskEffect` 因而可能放行 retry；`committed-writeback-discarded` 不入 recovery ledger | **G0 红，L1/L2 partial**；R0 |
| **closed-file WorkspaceEdit / replay** | 会构造 `PreparedSave`，复用 write policy 和 `writeTextSnapshot`，有 history snapshot 与 watcher notify | 直接 await writer，不返回/消费六态结果，不做 unknown-effect read-back/ledger；跨文件 apply 是 ordered best effort，缺 per-operation effect/resume/rollback facts | **G0 红**；R0 |
| **Action / Keymap** | editable `KeymapSchemeV3`、持久化、scheme settings、conflict、disabled action、two-stroke dispatch 和 frozen evaluation 已接线 | CodeMirror 仍直接安装多组 keymap；只迁移少量 editor action；mouse shortcut 无 runtime；recorder 只录一 stroke；window dispatch 未显式挡 composition/dead key/AltGr | **G1 partial**；R1 |
| **Basic Completion** | request identity/stale containment、choice session、snippet + additional edits 一次 dispatch/undo、typed provider envelope、3 秒 resolve timeout 已接线 | resolve timeout/failure 会直接插 primary，仅输出 status diagnostic，item 没有“import unavailable”状态或用户选择；jdtls 目录只有 README/expectation，无真实 Maven/Gradle project/trace | **generic synthetic L2 / Java unverified**；R3 |
| **Clipboard / virtual space / regions** | refcounted workspace slot、多光标/矩形 payload、session history ring 模型、appearance virtual-space flags；有 parser 时 region marker 会拒绝 string/template | history 无 action/popup/settings；无 Paste as Plain Text/Copy Reference；virtual space 未建 visual-column state；无 parser 的 region 仍是 extension/token regex heuristic | **G1 partial / G3 model**；R4 |
| **Switcher / tabs / splits** | tool-only Switcher 可渲染、Backspace close/hide、leaf identity、reopen stack、默认 tab limit 接入 `openFile` | 工具窗是硬编码 7 项；policy 不持久化且 order/open/close/pinned-row/preview 仅模型；reopen 只有 groupId；detach/equalize/stretch/split navigation 未实现 | **G1 partial**；R5 |
| **Reference Information** | explicit QuickDoc path 的取消可达 Rust；popup/tool window/pin/history/URL policy 与 Parameter Info 独立路径存在 | production provider 基本只有 documentation/hover；Type/Context/直接 External contract 缺失；Parameter 未统一 envelope；inline hover 未共享 controller cancel；无 native provider cancel trace | **presentation L2 / suite L0-L1**；R6 |
| **Usages** | `javaSemanticEvidence.ts` 有 thin session/group/page/filter model；ReferencesPanel 能按文件展示和分页 UI | `findReferences()` 仍只填 flat locations，没传 `symbolName/identity`，未接 rerun；pin 只是本地图标且不阻止替换；无 Show Usages；roles 都是 unknown | **model + legacy workflow L1**；R6 |
| **Diagnostics / inspection** | provider diagnostics、Problems、quick fix、presentation profile 和 related locations 已生产可用 | `inspectionEvidence.ts` 会按 message/source 文本推断 nullability/data-flow；这只能是提示，不能计 inspection/flow evidence；无 provider profile/scope/suppression control | **diagnostics L2 / inspection L0**；R6/R8 |
| **Rename / refactor** | Rename、Safe Delete、provider CodeAction、preview、freshness/root guard、WorkspaceEdit undo 均有入口 | Safe Delete 由客户端 references/definition 组合，不能假设完整；一般 refactor action 未消费 `RefactorEvidence` conflict gate；无真实 jdtls trace/post-condition | **逐 action L1/L2 partial**；R3/R6 |
| **Semantic editing / Generate** | 最新 HEAD 修正 Complete Statement 对 caret 行执行；try/catch command 可达；Generate action filter 有纯函数 | Complete Statement 仍 local heuristic；Surround 未验证 syntax node 却标 `source: syntax-tree`；只有 try/catch production command；Generate 无 dialog/member workflow；Smart 明确 unavailable | **local L1 / provider semantic L0**；R7 |
| **SSR / dependency / Full Line / code style** | typed gates/models 能返回 unavailable；appearance profile 真正接入 production | `companionCapabilities.ts`、`workspaceCodeStyleScheme.ts` 无生产 consumer；无 parser/registry/model runtime/ghost text/scheme UI | **appearance partial；其余 model/L0-L1**；R8 |
| **QA / native evidence** | 141 个 YAML 能解析；存在 C0-C7 case 文件和部分 testid catalog | 当前 audit 为 1 lint error、catalog `STALE`、137 orphan selectors、4 broken cases；C0/C2/C3/C6/C7 仅 open+screenshot，C1/C5 同样没有核心断言，C4 只断言 split-right 可见；无三端/provider/perf/a11y evidence | **门禁红**；R2/R9 |

#### 2.29.3 最新 HEAD 增量的准确边界

`69165486dee1` 修改 `CodeWorkspaceTab.tsx`、`CodeMirrorHost.tsx` 及聚焦测试：command-port 的 `Ctrl+Shift+Enter` 现在调用 `completeCurrentStatement`，并由 CodeMirror view 的 caret 行决定插入位置，修复了首行以下仍向错误行插入的回归。Java debug build barrier 改为信任 jdtls build verdict，而不是 stale workspace diagnostics；该项属于 X 轨道，不提升 Editor 等级。

Complete Statement 本身仍没有 parser/provider 证据：它只改善一个 local command 的正确行定位，最高保持 **Local/Heuristic L1-L2**。在 R7 完成 syntax identity、parse-state gate、typed unavailable 和 Java fixture 前，不得写 statement-aware、semantic 或 IDEA-equivalent。

#### 2.29.4 G0–G3 当前完成状态

| 目标 | 当前状态 | 已完成部分 | 解除条件 |
|---|---|---|---|
| **G0 Editor Integrity** | **红：代码合同 + 证据均未闭合** | open-buffer save typed result、stale containment、write ack、部分 recovery/undo | R0 统一所有写路径和 per-operation effect；R1 消除 action 静默/跨 owner 风险；R2/R9 的 host/native crash/conflict/encoding evidence |
| **G1 Daily Editor** | **未达** | 常用编辑、Basic synthetic path、QuickDoc/Parameter presentation、recursive layout、editable Keymap/appearance 基础 | R1/R3/R4/R5/R6 的日常主路径均达到 L2；R2 有可执行 browser workflow；R9 有三端键盘/IME/a11y smoke |
| **G2 Java Semantic Confidence** | **未达，所有 Java semantic claim 未验证** | jdtls infrastructure、typed identity/evidence helpers、rename/usages UI 基础 | R3/R6 在真实 JDK 21 Maven/Gradle fixture 上逐项形成 request/result/effect trace，并与 IDEA 2026.2 expected 对照；每项独立升级 |
| **G3 Advanced/Companion** | **分项：appearance wired，其余多为 model/unavailable** | typed contracts、部分 settings/appearance、local template actions | R7/R8/R5b/R9 按 language/provider/edition/hardware/platform 分项完成；不存在“C8 整包完成”总开关 |

#### 2.29.5 QA 事实与声明规则

本轮只做 catalog/用例静态审计，未运行 browser/native workflow。当前事实为：141 cases、0 schema parse error、1 lint error、catalog `STALE`、137 orphan selectors、4 broken cases（`TC-007`、`TC-010`、`TC-auto-F25-1`、`TC-auto-F7-5`）；`[data-testid="workspace-editor-appearance-settings-dialog"]` 被 F25.1/F25.3 重复声明。§2.28 的 lint 0、catalog current、browser gate green 和“无新增 stale/orphan”不能作为当前证据。

R2 必须先修 catalog ownership 和 broken cases，再把 `TC-IDE-C0/C1/C2/C3/C4/C5/C6/C7` 从占位 smoke 改为真实操作与结果断言。测试名、`covers` 或 screenshot 不证明覆盖；真实 jdtls 不能由 mock provider 替代，native filesystem/clipboard/keyboard 不能由 browser stub 替代。R9 完成前，G0/G1 始终不得标 green/release-ready。

#### 2.29.6 当前权威关系

从 HEAD `69165486dee1` 开始：状态与等级只读本节，任务与接口只读 §8.19。§2.24–§2.28 和 §8.14–§8.18 只作历史审计/设计输入；其中与本节冲突的 `complete`、`[x]`、`green`、`代码面闭合`、测试数字和领取顺序全部失效。本规则已由 §2.30/§8.20 覆盖。

### 2.30 v4.62 当前 HEAD `f572c6b8` 权威审计、IDEA 2026.2 真实能力对照与目标重置（2026-08-25）

本节覆盖 §2.29 及 §8.19 各 as-built 记录中的“当前状态”和“下一包”判断，但保留那些章节作为提交级证据。审计对象为干净 HEAD `f572c6b8101564761d119bb39d63a1acf933bba4`；代码沿 `action -> production consumer -> provider/IPC -> typed result/effect -> error/cancel/stale -> undo/recovery -> executable evidence` 追踪。官方基准为 IntelliJ IDEA 2026.2 Help，页面 `built-on=2026-08-18`、`build-number=2666`，复核日期为 2026-08-25。

#### 2.30.1 IDEA 2026.2 参考能力的真实边界

| 领域 | IDEA 2026.2 官方公开工作流 | 本方案的对齐解释 | 官方参考 |
|---|---|---|---|
| **Project Analysis** | 扫描并分析工程以启用 completion、inspections、refactoring、navigation、Find Usages 和 highlighting；进度结束才表示 smart features ready；可排除文件/目录和 unload module | G1 至少要显示 provider 的 importing/analyzing/ready/degraded；G2 才要求 Java module/source-set/classpath 证据。不要求复制 JetBrains index，但 freshness ledger 不能冒充 Project Analysis | [Project analysis](https://www.jetbrains.com/help/idea/indexing.html) |
| **Completion** | Basic Completion 覆盖可见 scope 的 class/method/field/keyword；第二次调用扩大到 inaccessible classes/members；有 accept/replace、exclude/prioritize 与设置；Smart Type-Matching 是独立能力 | G1 只要求 provider-backed Basic、resolve/import/undo 和第二次调用的诚实 scope 事实；Smart 与 exclude/prioritize 独立挂账 | [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) |
| **Reference Information** | Parameter Info、Quick Documentation popup/tool window、External Documentation、Type Info、Java Expression Static Data | v4.50 写的 `Context Info` 不再作为 2026.2 权威目标；实际第五项是 Expression Static Data。G1 只阻断 Parameter + QuickDoc，后三项进入 G2/G3 | [Code reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html) |
| **Inspection / Intention** | inspection 发现异常、dead code、probable bugs、spelling，可按 project/scope、severity 和 profile 配置；intention 可应用、分配快捷键、即时禁用，并与 inspection 区分 | provider diagnostic 显示是 G1；catalog/profile/scope/suppression 执行、全项目检查/data-flow 是 G2/G3。客户端隐藏诊断不算 suppression quick fix | [Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html)、[Intention actions](https://www.jetbrains.com/help/idea/intention-actions.html) |
| **Navigation / Usages** | declaration/type/implementation、errors、siblings、methods、Switcher；Find Usages 支持 file/project/custom scope、preview、separate Show Usages、recent results 和 usage hints | G1 要稳定的常用导航/Search；G2 对 Java 的 scope/coverage/role/library/preview/recent 与 hierarchy 逐项验收 | [Source navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)、[Search for usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html) |
| **Refactoring** | Refactor This、preview、exclude、conflict dialog/settings；常见动作含 Rename、Safe Delete、Move/Copy、Extract Method/Constant/Field/Parameter/Variable、Inline、Change Signature | action 名或 LSP kind 不算完成；每个动作必须有 provider completeness/conflict、stale check、preview、apply effect 和 one-step undo 证据 | [Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html) |
| **Formatting / Imports** | selection/file/module/directory reformat、indent、on-save/on-commit/CLI、exclusion/markers/keep formatting/settings；auto-import 另含 wildcard/exclude/prioritize/optimize | G1 只要求 selection/file format + organize imports；其余 stage 和 scope 只在真实 provider/syntax owner 存在时进入 G3 | [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html)、[Auto import](https://www.jetbrains.com/help/idea/optimizing-imports.html) |
| **Editor shell / Advanced** | tabs 有 appearance/order/open/close policy；编辑器含 navigation/scrollbar/breadcrumbs/split/font/settings；Live/Postfix、SSR 和本地 Full Line 各是独立工作流 | G1 要稳定 tabs/split/reopen/keymap；detach、SSR、Full Line、semantic templates 保持 G3，不因相似 UI 或 typed unavailable 提前记账 | [Editor tabs](https://www.jetbrains.com/help/idea/editor-tabs.html)、[Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html)、[Full Line](https://www.jetbrains.com/help/idea/full-line-code-completion.html) |

这份参考矩阵定义的是能力清单和工作流语义，不要求复制 JetBrains 内部 PSI、UI 像素或私有排序。对齐单位固定为 `capability + language + provider + edition + platform + fixture`；一个格子通过不能提升同一行其它格子。

#### 2.30.2 当前生产事实矩阵

| 能力 | 当前 HEAD 可证明事实 | 未闭合 / 被高估边界 | 最高声明与 §8.20 包 |
|---|---|---|---|
| **Save/recovery/WorkspaceEdit** | R0 的 native intent/old hash、disk-effect ledger v4、discarded-writeback recovery、closed-file committer、per-operation effect/resume 已进入生产；单测覆盖 typed result 与恢复分支 | 本轮未跑 locked/permission/atomic-replace/watcher/encoding 的 packaged native fault matrix | **代码合同 L2，platform-unverified；G0 仍红**；W7 |
| **ActionHost/Keymap** | R1 已把业务键位迁入 workspace-scoped host，支持 two-stroke、mouse dispatcher、IME/dead-key/AltGr gate、可编辑 scheme/conflict | browser C1 在打开/使用相关工作流时触发 tree hook 崩溃；shell 与 workspace 对 `Ctrl+Shift+T` 的 owner 冲突仍存在 | **核心合同 L2，G1 阻断**；W0 |
| **Basic Completion** | R3 有 resolve failure choice、invocation scope 事实、one-dispatch/one-undo；五个 Maven/Gradle fixture、九场景在 Linux jdtls 1.61/JDK 21 留有脱敏 trace | 无 IDEA 实机对录、Windows/macOS 未跑；第二次调用的 provider scope 可为 unchanged；exclude/prioritize/Smart 不可用 | **Java Basic G1 L2 provider-backed（Linux）**；W2/W7 |
| **Reference Information** | QuickDoc popup/tool window/pin/history/URL policy可达；signatureHelp 参数弹层可用；`ReferenceInfoController.requestTyped` 已有五 kind 类型与 cancel/stale 测试 | Parameter 仍不走 controller；Type/External 缺完整入口；`context-info` 与 IDEA 当前 Expression Static Data 语义不相同；无真实 provider trace | **QuickDoc L2(jsdom)，Parameter L1/L2 partial，其余 L0/L1**；W1 |
| **Project Analysis / Java context** | SDK/JDK 探测、jdtls session、progress 与 `WorkspaceSemanticIndexSnapshot` freshness/coverage 事实存在 | snapshot 不扫描/索引 symbol；没有统一 module/source/test/generated/excluded/dependency import snapshot，ready 不代表 IDEA smart mode 等价 | **provider lifecycle L1**；W2 |
| **Diagnostics / Intention** | provider diagnostics、Problems/Analysis、CodeAction/resolve/apply、presentation profile/suppression/baseline UI存在 | profile 只影响展示；无 provider inspection catalog/scope/settings/suppression edit；无全项目 inspection/data-flow/nullability 证明；真实 jdtls quick-fix trace缺失 | **diagnostics L2，inspection/intention suite L1**；W3 |
| **Search / Navigation / Hierarchy** | Search Everywhere 有 All/Class/File/Symbol/Action/Text；definition/type/implementation、call/type hierarchy、Recent/Last Edit/Back/Forward 与结构视图均有生产入口 | C1 shell 崩溃；symbol fan-out 完整性依赖 provider；siblings/method navigation 等 IDEA 子项未闭合；Java fixture/IDEA compare不足 | **mixed L1/L2**；W0/W4 |
| **Usages** | identity/project fingerprint、rerun、pin replace guard、分页与 library owner filter 已生产化 | Reads/Writes/Declarations禁用；无 scope dialog、轻量 Show Usages、recent query；无真实 jdtls role/coverage/cancel/restart trace | **L1**；W4 |
| **Refactor** | Rename/Safe Delete/provider refactor kinds、preview/exclude、WorkspaceEdit history/undo有入口；Generate 也复用真实 CodeAction apply链 | `refactorApplyGate` 未覆盖 Rename/一般 CodeAction；Safe Delete completeness由客户端推断；Extract/Inline/Change Signature/Move无逐项真实 trace/conflict/post-image | **逐 action L1**；W5 |
| **Format / Code Style / Imports** | scheme CRUD/持久化、EditorConfig/scheme provenance、selection/file planner 与 provider format、format-on-save、organize imports存在 | scheme saveActions未消费；exclusion UI/directory/module/rearrange/cleanup关闭；provenance未逐字段展示完整 chain | **selection/file L2(jsdom)，suite L1**；W6 |
| **Tabs / Splits / Tool windows** | 13 项真实 dock registry、frozen Switcher、policy V3持久化、tab limit、equalize/stretch/unsplit/navigation/move、graded close/ReopenLocationV2；C4 browser 通过 | policy无设置 UI，display order/activateOnClose未消费，detach defer；最后 tab 关闭后的 chord owner错误 | **核心 workflow L2(browser)，平台未验证**；W0/W6/W7 |
| **Clipboard / Multi-caret / Virtual Space** | history popup、sensitive/limit model、plain paste、copy reference、multi-segment one-undo、End/click/type/backspace/paste virtual overflow；C3 browser 通过 | History settings未接；vertical column memory不完整；pixel geometry、clipboard denied、IME/native未验证；region fallback仍 heuristic | **核心 workflow L2(browser/jsdom)**；W6/W7 |
| **Semantic edit / Templates** | Java五种 Surround 同入口/事务且 provenance诚实；Generate只显示 provider action；Java部分 Complete Statement syntax-backed，其余 local heuristic | 无真实 jdtls Surround/Generate trace；placeholder Tab/choice/import shortening、typed postfix applicability、Smart evidence缺失 | **local subset L1/L2，provider semantic未验证**；W2/W8 |
| **Advanced** | R8 已明确 A/B/C defer，Code Style D1/D2交付；SSR/dependency/Full Line都有 typed unavailable与重开条件 | 无 parser/query、trusted metadata client、signed local model/ghost text；Code Vision/scratch/injection/detach无生产 owner | **defer / L0-L1 unavailable**；W8 |

#### 2.30.3 目标完成状态

| 目标 | 当前状态 | 已完成 | 解除条件 |
|---|---|---|---|
| **G0 Editor Integrity** | **红（代码合同闭合，发布证据未闭合）** | R0/R1 typed effect、恢复、单一 action/keymap runtime | W7 的 Linux/Windows/macOS 故障矩阵；无未解释磁盘 effect、IME/action ownership 或恢复失败 |
| **G1 Core Daily Editing** | **未达** | Basic Completion Linux L2；常用编辑/QuickDoc/format/clipboard/tabs/splits 多数达 jsdom/browser L2 | W0 shell稳定；W1 Parameter/Reference 单通道；W2 项目分析状态；W3 diagnostics/intention 最小闭环；W4 常用导航/usages；W7 三端/a11y |
| **G2 Java Semantic Workflow** | **未达；仅 Basic Completion 单项到 provider L2** | 真实 jdtls completion fixture 与通用 semantic identity/effect底座 | W2-W5 逐 capability真实 trace + IDEA expected/observed；每项独立升 L2/L3，不设整包布尔完成 |
| **G3 Advanced Editing** | **分项可用/多数延期** | clipboard history、Code Style首批、local Surround/Complete Statement子集 | W6收口已生产子项；W8只在重开条件满足后实施 SSR/dependency/Full Line/Code Vision/scratch/injection/detach |

#### 2.30.4 本轮实际验证与证据边界

2026-08-25 在当前 HEAD 实际执行：

- `npx vitest run src/components/editor/`：158 个 test files、1310 tests 全绿；耗时 94.20s。该结果证明模块/jsdom 回归，不证明 native UI、provider 或 IDEA 等价；耗时只作为 CI health 事实，不等同 key-to-paint 性能。
- `pnpm build`：`tsc -b` 与 Vite build 通过；仍有既存 ineffective dynamic import 与大 chunk warning，不影响本轮文档结论。
- `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --gate`：140 cases、0 lint、0 orphan、catalog current、baseline gate green；仍有全产品范围 3 个 uncovered feature、18 个 missing required controls、44 个 shallow controls。它们不自动阻断 Code Editor，但说明“QA 全覆盖”不能宣称。
- 沿用 R2 最近一次实际 browser 报告：可运行核心 case 5/6 通过，`TC-IDE-C1-01` 因 `useWorkspaceTreeData` 渲染崩溃失败；C0/C2/C6-02 因 native/provider 环境受阻。未在本轮重跑 browser、Rust、native、macOS/Windows 或 IDEA 对照。

`qa-ui-auto` 的 gate只覆盖 schema/catalog/control触达和已执行 workflow；不覆盖视觉回归、viewport布局、a11y、性能或国际化。W7 必须为这些维度另建证据，不能把 audit green 解释为发布门禁全绿。

#### 2.30.5 当前权威关系与声明规则

从 HEAD `f572c6b8` 开始：

1. 当前目标、完成等级、缺口只读 §2.30；当前实施顺序、接口与 DoD 只读 §8.20。
2. §8.19 的 as-built 仍是 R0-R8 提交事实，但其“唯一可领取”“下一包”和顶部状态表均为历史；不得从 `[x]` 推导 G0/G1 release-ready。
3. `provider-backed` 必须同时给出 provider/version、fixture、scope、revision/generation、失败/cancel、effect/undo 和平台；缺任一层就按较低层声明。
4. `IDEA-equivalent` 只能用于通过同一 fixture 的 expected/observed 对照的单项能力；不得写“IDEA editor complete”“Java complete”或用 companion X 轨道抵扣 Editor 缺口。
5. 当前允许的最高概括是：**“Code Workspace 已有可工作的 IDEA-inspired 编辑器骨架；Java Basic Completion 在 Linux 达 provider-backed L2，其余语义与三端发布门禁仍在实施。”**

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

`Ctrl+/` 行注释、`Ctrl+Shift+/` 块注释、`Ctrl+D` 复制行（IDEA 语义）、`Ctrl+Y` 删除行、`Alt+Shift+↑/↓` 移动行、`Ctrl+W`/`Ctrl+Shift+W` 扩大/缩小选区（优先 LSP selectionRange，回退 syntaxTree，见 §5.2.13）、`Ctrl+G` 跳转行:列。`200d4627`/`9a7c03c7` 新增 `Ctrl/Cmd+Shift+J` join lines 与部分 line transforms；Join/Tab jump-out 已进入 CodeMirror，Sort/Reverse/Transpose/Unwrap 仍是局部或未装配 command，不应被描述为完整 multi-range/IDEA line-edit 语义。冲突处理见 §7，当前契约见 §8.5.5（历史设计见 §8.3.4）。

#### 5.1.3 诊断呈现升级

- 引入 `@codemirror/lint` 的 setDiagnostics 通道：波浪线 + gutter 图标 + 右侧 overview ruler 色条（error 红 / warning 黄）。
- 悬停诊断与 hover 信息合并为单浮层（先诊断后文档）。
- 诊断行 gutter 显示灯泡（有可用 Code Action 时），衔接 §5.2.9。

### 5.2 语言智能与代码洞察（P0/P1，本方案核心）

对标 IDEA 日常使用频率最高的语言功能，采用 **provider-first、semantic-evidence-gated** 的路线：LSP 提供跨语言基线；Java 先由真实 jdtls/project fingerprint 为 completion/diagnostics/navigation/usages/refactor 建立逐 capability 证据。只有 fixture 证明目标能力无法由 provider满足且 ADR批准后才补本地 parser/index；没有标准 LSP 映射的能力必须明确使用 provider extension、经证据约束的本地 engine，或标为 unavailable，不能用同名按钮伪装。

#### 5.2.0 设计原则：capability 驱动的功能开关

- LSP server `initialize` 返回的 `ServerCapabilities` 由后端缓存，并随 `LspDocumentStatus` 附带 `capabilities` 摘要（如 `{ completion: true, callHierarchy: false, … }`）下发前端。
- **UI 按能力开关**：server 不支持的功能，菜单项置灰 + tooltip 说明（沿用现有 installHint 机制），绝不静默失败或伪造结果。
- 每个请求带取消语义（编辑/切换文件即作废旧请求），防止过期结果回填。

#### 5.2.1 功能 → engine / 协议映射总表

| IDEA 功能 | 快捷键 | engine / 协议 | UI 载体 | 优先级 |
|-----------|--------|---------------|---------|--------|
| 基础补全 | Ctrl+Space / 输入触发 | `textDocument/completion` + `completionItem/resolve` | 编辑器补全浮层 | P0 |
| Smart / Type-matching Completion | Ctrl+Shift+Space / 重复调用 | provider expected-type/context evidence；无证据则 unavailable | 同一补全浮层，显式显示 mode/scope | P2 / G3 |
| Full Line / Inline Completion | Tab / Ctrl+Right / End 接受整段/词/行 | 本地模型 runtime + semantic/import/filter service（IDEA Ultimate bundled-plugin 参考） | editor ghost text，可与 popup 同步 | P2 |
| Live / Postfix Templates | Tab / Ctrl+J | 本地 template engine + provider type/context/import service | 补全浮层 + template 变量导航 | P0 |
| Complete Statement / Surround / Generate | Ctrl+Shift+Enter / Ctrl+Alt+T / Alt+Insert | syntax-evidenced local adapter 或 provider extension/Code Action；文本 fallback 标 Local | editor action / popup / preview | P2 / G3 |
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
| Inspection / Data-flow | 自动 / Analyze 菜单 | provider structured diagnostics/evidence；本地 engine 仅在 ADR 后 | editor + Problems + Analysis | P1 / G2 |
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
- **当前边界（v4.31）**：上述已实现条目只覆盖 basic popup completion 加性能护栏（上下文抑制、80ms 防抖、trigger 即时和 200 项 cap）。Smart/type-matching、第二/第三次调用的候选扩展、class/package exclusion/priority、type-aware postfix、language-aware statement completion、Surround/Generate 仍按 §8.4 I4/I5 与 §8.5.5/8.5.6 执行；Full Line 是独立的 P2 inline/model 工作流，当前为 L0，不能由 LSP popup completion 推导完成。

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

`CodeWorkspaceTab.tsx` 在 `c083008e` 已约 12.3k 行；树数据、LSP session、Git snapshot、导航和文件动作已有 hook 抽取，但 action/style/completion/X-track 装配仍集中。继续堆功能会放大竞态，重构目标如下（目标结构不是本轮代码已完成的事实）：

```
src/components/editor/
  CodeWorkspaceTab.tsx          // 当前约 12.3k 行；保留装配，按 action/style/navigation/X-track 职责继续拆分
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

- 目标是以 instance-scoped action service 的 `WorkspaceActionDefinition` 为唯一 runtime truth；当前 `workspaceCommands.ts` 仍是旧执行链，必须按 §8.5.2 先做 migration adapter，再删除第二份 metadata/handler。
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

> 本表保留默认 binding 的设计/实现历史，用于说明预期肌肉记忆与冲突来源；它本身不是可编辑 Keymap 的完成证据。R1 已交付 workspace-scoped ActionHost、mouse dispatcher、双 stroke、录键与 IME/dead-key/AltGr gate；当前阻断是 browser tree crash、shell 对 `Ctrl+Shift+T` 的 owner 抢占和三端 native 证据，权威现状见 §2.30.2，修复合同见 §8.20.1/§8.20.8。

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

> M0–M11 是既有实施序列，完成计数只表示对应历史清单出现过代码入口，不是 v4.32 的能力等级或下一步优先级。下表已按当前边界标出混合项：编辑器部分仍按原 P0/P1/P2 追溯，Terminal/Build/Run/Test/Debug/AI/Remote 等统一标 X；权威等级与顺序见 §2.5、§2.13、§8.4 和 §8.8。

| 里程碑 | 内容 | 规模 | 状态 |
|--------|------|------|------|
| **M0 前置重构** | 组件拆分 + codeWorkspaceStore + 命令系统骨架 + 底部 dock 容器（References 迁入） | M | 🔶 功能前提已交付；树数据、LSP session、Git snapshot、导航与文件动作已抽 hook，但当前装配组件约 10.6k 行；按 §8.4 I1/I2/I3 继续按职责拆分 |
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

### 8.2 v4.30 历史待办（不再作为当前顺序）

> 本节保留 `9a7c03c7` 开发前的原任务，便于追溯需求来源。后续审计证明多数未达到 production-wired，因此本节的 `[ ]`/`[~]` 不再用于当前进度；当前状态和执行顺序见 §2.13/§8.8，历史合同见 §8.4–§8.7。

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
- [ ] **Q1 自动化。** 每个新增控件同步 `feature-list.md`/testid catalog/YAML case；核心算法加 Vitest/Rust 测试，Editor 主路径执行 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff <base>`，失败与不支持状态均需用例。
- [ ] **Q2 三端真机。** 按 §2.6 保存 Linux/macOS/Windows 的 keyboard/IME/clipboard/font/zoom/path/watcher/LSP/packaged-app 证据；只有三端完成后，相应能力才可升 L3。
- [ ] **Q3 性能与隐私。** 固定 typing latency、completion p95、search/index time、memory 与 crash-recovery budget；trace 默认脱敏，不记录源码、补全文本、凭据或完整路径。

X 轨道的 Build/Run/Debug/Test/Coverage、Terminal、Git、AI 继续按各自设计推进，但其待办统一放到 §12，避免再次挤占 Editor P0/P1 顺序。

### 8.3 v4.30 历史实现设计（保留为需求输入）

> 本节是基线 `2134e783` 之后形成的历史执行规格；`9a7c03c7` 已实现其中一批模型，但当前 agent 不应再按本节直接开工。先读 §2.13 的生产可达性审计，再执行 §8.8；本节仅用于追溯原始需求和接口思路。

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

### 8.4 v4.31 历史权威待办（integration-first；当前见 §8.20）

状态只按 §2.11/§2.12 的 `model -> wired -> workflow -> verified` 推进。下面顺序是硬依赖，不允许先给未装配模型补更多方法，再把“文件更多”登记为能力完成。

| 顺序 | 工作包 | 当前 | 本轮目标 | 依赖/阻断 |
|------|--------|------|----------|-----------|
| 1 | I0 能力证据与实验原型隔离 | **wired（部分）** | 注释已把 Java/SSR 降为 experimental，但还没有 CI reachability gate、统一 UI maturity/reason 或 test isolation | 无，所有后续包前置 |
| 2 | I1 Instance-scoped Action Service + Keymap | **wired（不完整）** | `registerWorkspaceCommands` 已由 `CodeWorkspaceTab` 调用；runtime dispatch 仍是 `WorkspaceCommand[]`，registry 为 global singleton，scheme 未消费 | I0 |
| 3 | I2 EditorConfig + Save Transaction | **model + legacy wired** | resolver/normalizer 纯测试可用；生产仍使用同步 `resolveEffectiveCodeStyle` 和旧 `saveOpenBufferText`，没有 `.editorconfig` provider/保存事务 | I0；action 入口消费 I1 |
| 4 | I3 Recent Locations + Switcher | **wired（不完整）** | 弹窗、快捷键和记录 effect 已接入；全局 tracker、无订阅/生命周期/revision relocation；Switcher 未实现 | I1 |
| 5 | I4 Editing / Surround / Generate 收口 | **model + 部分既有 wired** | Join/Tab jump-out 是既有 CodeMirror 能力；Sort/Reverse/Transpose/Unwrap 与 Surround/Generate 仍无生产 action，固定 Java 生成器不可接 Apply | I1、I2；Java generate 依赖 J0 |
| 6 | I5 Completion modes | **model（Basic 既有 workflow）** | 既有 LSP basic completion 保持；本提交没有显式 mode/session/reinvoke/truncation/Smart type evidence | I1、LSP generation |
| 7 | J0 Semantic result envelope + 原型降级 | **workflow（provider envelope）/model（Java prototype）** | 现有 LSP semantic revision/generation guard 可用；Java prototype 只改注释，仍不能消费为 index/inspection/refactor | I0 |
| 8 | J1 Java imported context/index 垂直切片 | **model** | 没有 backend import context、持久化 index、真实 parser/classpath 或 Find Usages/Rename vertical slice | J0，工程模型 |
| 9 | A2 Recursive editor layout | **model** | 新增 reducer/migration 与单测，但 store/render/persistence 仍固定 primary/secondary | I1；buffer ownership 先冻结 |
| 10 | A4 Local Full Line Completion | **model** | `FullLineSession` 仍无 provider、CM ghost text、model runtime 或 hardware/privacy state | I1、I5、模型 runtime |
| 11 | A5 Code Vision | **model** | provider-backed usages/inheritors/problems lens，不伪造计数 | J0/J1 或明确 LSP codeLens provider |
| 12 | A6 Paste History + Scratch Files | **model** | 有界、可清除、默认会话内剪贴板历史；app-data scratch 工作流 | I1、隐私策略 |
| 横切 | Q1 性能/无障碍/三端/QA | 部分 | 每个 workflow 有自动化，L3 有三端证据 | 跟随每个包，不单独补票 |

本轮完成定义：

- [ ] `CodeWorkspaceTab` 不再直接维护第二套 action dispatch；当前 registry 注册与旧 dispatcher 并存。
- [ ] `.editorconfig` 修改后当前文件 style 自动刷新；当前 resolver/normalizer 没有生产消费者。
- [ ] Recent Locations、Switcher、Sort/Reverse、Surround/Generate 至少各有真实生产入口；目前只有 Recent Locations wiring，且生命周期不完整。
- [x] Java/SSR prototype 的注释与文档已明确 experimental；未达到 J1 前仍禁止接 Apply。
- [ ] recursive layout 和 Full Line 不再只有 model test；当前仍只有 reducer/session 测试。
- [ ] `CodeMirrorHost` comparator、LSP capability generation 和 Tauri typing/completion 指标的独立门禁仍待完成。
- [ ] 新增/变化控件尚未在 `feature-list.md`、testid catalog、YAML case 中形成完整覆盖；浏览器 stub 不能替代桌面证据。

### 8.5 v4.31 实现级详细设计（供其它 agent 直接开发）

#### 8.5.0 通用纵向交付合同

每个工作包必须交付同一条可追踪链：

```
Action / mouse entry
  -> instance-scoped controller
  -> immutable request + generation/revision
  -> local model or provider/IPC
  -> typed result (source/completeness/failure)
  -> store/view state
  -> cancel/retry/undo/restore
  -> Vitest/Rust + qa-ui-auto + applicable native evidence
```

禁止以下完成判定：只有导出函数、只有 model 单测、只有未挂载 dialog、只有静态 catalog、只有 capability 字段、只有合成 provider。新模块在 PR 中必须列出至少一个**非测试生产 consumer**；无 consumer 时状态固定为 `model`。

统一结果外壳：

```ts
type DeliveryMaturity = "model" | "wired" | "workflow" | "verified";
type ResultCompleteness = "complete" | "partial" | "truncated" | "unavailable" | "failed";

interface EditorFeatureResult<T> {
  value?: T;
  source: "local-syntax" | "local-index" | "provider" | "local-model";
  workspaceRevision: number;
  providerGeneration?: number;
  completeness: ResultCompleteness;
  diagnostics: Array<{ code: string; message: string; retryable: boolean }>;
}
```

UI 不得自己从空数组推断 `complete`。只有产生结果的一层可以赋值 completeness；取消和 stale 必须丢弃结果而不是发布空成功。

#### 8.5.1 I0：生产可达性与原型隔离

**代码任务。** 新增聚焦 contract test，装配一个最小 `CodeWorkspaceTab`/controller 后读取 action/capability snapshot，断言关键 action 有 handler、state 和 owner；不要用扫描文件名代替运行时装配。`qa-ui-auto-tests/feature-list.md` 只登记 `workflow` 及以上能力，`model` 记录留在本文档。为实验模块加明确的 `experimental` 注释/导出边界，移除“persisted index”“AST structural”“CFG/SSA”等不符合代码的说明。

**重复/孤儿检查。** CI 中对 action ID、testid 和功能 catalog 分别做唯一性检查；action metadata 存在但没有 active owner 时显示 `unavailable`，开发环境输出一次诊断。不得因为当前 registry 是全局 singleton 就把两个 workspace 的同 ID handler 相互覆盖。

**验收。** fixture 同时包含：metadata-only、handler mounted、provider offline、stale generation、workspace 切换和组件卸载。旧 owner 的 cleanup 不能删除新 generation 的 handler；关闭一个 workspace 不影响另一个 workspace。

#### 8.5.2 I1：Action Service 与可编辑 Keymap 的单一真值

将 `DEFAULT_WORKSPACE_ACTIONS` 保留为不可变 metadata catalog；把运行 handler/state 放入**每个 workspace instance 独立**的 service，避免全局 registry 覆盖：

```ts
interface WorkspaceActionService {
  register(ownerId: string, generation: number, actions: WorkspaceActionDefinition[]): () => void;
  getSnapshot(context: WorkspaceActionContext): readonly WorkspaceActionView[];
  execute(id: string, context: WorkspaceActionContext, signal?: AbortSignal): Promise<ActionResult>;
  dispatch(event: NormalizedKeyEvent, context: WorkspaceActionContext): Promise<ActionDispatchResult>;
  subscribe(listener: () => void): () => void;
}

interface WorkspaceActionView {
  id: string;
  title: string;
  category: ActionCategory;
  bindings: readonly KeySequence[];
  availability: ActionAvailability;
  disabledReason?: string;
  source: ActionProvenance;
  completeness: ResultCompleteness;
}
```

`register` 返回的 disposer 必须携带 `(ownerId,generation,definition identity)`；旧 effect cleanup 只删除自己注册的版本。React 订阅使用 `useSyncExternalStore`，snapshot 在语义未变时保持引用稳定。`CodeWorkspaceTab` 先把现有 `WorkspaceCommand[]` 通过 adapter 原子注册，再逐步把 CodeMirror/tree/debug action 移入；迁移期间只允许 adapter 调用旧 handler，禁止两个 keydown listener 同时执行。

**Context 优先级。** 固定为 `modal > completion/snippet > editor > tree > terminal > workspace`。context 包含 active file、selection、readOnly、dirty、provider generation/capabilities、debug state 和 payload；disabled reason 从 action state 返回，不由菜单猜测。异步 action 返回 `applied/opened/no-op/cancelled/failed`，只有 applied/opened 才进入最近 action 和状态提示。

**Keymap。** `KeymapScheme` 进入版本化 preference store，builtin 只读，首次修改 copy-on-write。binding 使用 stroke sequence，不再把 `Mod-K Mod-S` 当单键字符串：

```ts
interface KeyStroke { key: string; code?: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; altGraph: boolean }
type KeySequence = readonly KeyStroke[];
```

dispatcher 支持 chord timeout/cancel、macOS Cmd/Option、Windows AltGr/OEM、Linux non-US；系统保留键不拦截。冲突计算必须结合可同时为真的 context，而不是看到相同字符串就一律冲突。Settings 中提供 scheme copy/rename/delete/reset、录键、按键反查、增删 binding、禁用 action、JSON import/export 和 orphan action 保留；CheatSheet 变为同一 snapshot 的只读快捷入口。

**改动边界。** 主要文件为 `workspaceActionRegistry.ts`、`workspaceCommands.ts`、`useWorkspaceActionsController.ts`、`CodeWorkspaceTab.tsx`、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx`、`keymapModel.ts` 和 Settings 对应组件。不要在本包修改具体 formatter/semantic 算法。

**验收。** 覆盖双 workspace、快速 rerender/unmount、disabled reason、async cancel、chord、AltGr、modal 抢占、同键互斥 context、scheme migration/bad import/orphan、菜单/Search/cheatsheet/keydown 同状态。完成时删除或停用 `CodeWorkspaceTab` 现有直接 `window.keydown -> dispatchWorkspaceCommandKeydown` 路径。

#### 8.5.3 I2：EditorConfig、状态栏与保存事务

**Resolver 修正。** 不直接让浏览器 resolver 读取任意 absolute path。提供 root-scoped source：

```ts
interface WorkspaceConfigSource {
  owningRoot(file: WorkspaceFileRef): { rootId: string; canonicalRoot: string } | null;
  readConfig(rootId: string, relativePath: string): Promise<{ text: string; hash: string } | null>;
}
```

父链只能在 owning root 内向上；loose file 使用登记边界。链按远到近应用，同文件 section 按声明顺序应用，`root=true` 包含当前文件后停止。缓存键为 `(workspaceInstanceId, rootId, config path, hash)`，file result 带 chain fingerprint/generation；watcher create/change/delete/rename `.editorconfig`、root 变化和 workspace close 精确失效。读取失败保留上代值并标 stale/failed，不静默回默认。

显式状态栏选择只覆盖 indentation 字段，不能像当前 resolver 一样提前 return 丢掉 EditorConfig 的 EOL/charset/trim/final-newline。建议先解析所有来源，再逐字段 overlay：

```
manual field override > nearest EditorConfig field > workspace/language scheme field > sniffed field
```

override 以 canonical file identity 存入 `codeWorkspaceStore` 的版本化 per-instance preference；rename 更新 identity，copy 默认不复制，remove root 清理。状态栏显示值、来源、stale/diagnostic，并提供 Reset to EditorConfig。

**Save transaction。** 用一个 controller 替换 `saveFile` 中散落的 formatter 分支：

```ts
interface SaveTransactionInput {
  fileKey: string;
  bufferVersion: number;
  expectedDiskHash: string | null;
  styleGeneration: number;
  text: string;
}

interface SaveTransactionResult {
  status: "saved" | "cancelled" | "conflict" | "failed";
  finalText?: string;
  stages: Array<{ id: "format" | "trim" | "newline" | "eol" | "encode" | "write"; status: string; diagnostic?: string }>;
}
```

顺序固定为 formatter -> trim trailing whitespace -> final newline -> EOL -> charset/BOM validation -> **一次 hash-guarded write**。formatter 等待期间 buffer 变化则取消旧 generation，可对最新 snapshot 自动重试一次；仍变化时保留 dirty 并提示重试，绝不写旧文本。normalize 后先以一个 CodeMirror history transaction 更新 buffer，再写盘；写盘失败保留 dirty 和可 undo 文本。外部 hash 冲突、不可表示字符、binary/mixed-EOL policy、权限/锁定失败分别返回 typed failure。`trimTrailingWhitespace` 必须覆盖 bare CR，charset/BOM 不能只留在注释。

**验收。** nested/root-stop/多 section/glob、仅 EOL/charset、partial manual override、config watcher、rename、CR/LF/CRLF、UTF-8 BOM/UTF-16/legacy 不可表示字符、formatter offline/error、连续输入 race、外部 hash、locked file、save/reopen bytes。至少一条 Tauri fixture 和一条 UI case 验证真实磁盘，不只调用 pure normalizer。

#### 8.5.4 I3：Recent Locations、Switcher 与语义导航入口

删除全局 `navigationHistoryTracker` 作为生产状态，改为 per-workspace controller。记录点只来自明确事件：成功 navigation、编辑 cluster、tab activation、搜索/usage/refactor jump；普通光标移动 debounce 后在离开位置时记录，不能每按一次方向键写历史。

```ts
interface NavigationLocation {
  id: string;
  fileIdentity: string;
  range: LspRange;
  symbolId?: string;
  beforeContext: string;
  selectedText: string;
  afterContext: string;
  contentHash: string;
  reason: "navigate" | "edit" | "search" | "usage" | "refactor";
  workspaceRevision: number;
  ownership: "workspace" | "library" | "external";
  state: "current" | "relocated" | "stale" | "missing";
  timestamp: number;
}
```

同文件、同 symbol、相邻三行且 2 秒内的事件合并；navigation/edit 各最多 100 条。rename 通过 file identity 更新，内容变化先按 symbolId、再按上下文 hash 重定位，失败保留 missing 项供用户看见。library/external 始终只读。Recent Locations (`Ctrl+Shift+E`) 挂入 `WorkspacePopupsHost`，支持 changed-only、搜索、键盘、代码上下文和 unavailable reason。

新增 Switcher (`Ctrl+Tab`)：MRU editor tabs + 已打开 tool windows，按住 modifier 循环、释放提交、Esc 取消；preview 不改变 MRU，确认后才激活。Last Edit Location 改为 edit history 的第一个可重定位项。super/sibling/method up/down 先消费 provider/index result；无能力时 action state 为 unavailable，不用文本扫描猜测。

**验收。** 双 workspace 隔离、快速 edit coalesce、rename/delete/external change/library、MRU preview/cancel/commit、关闭 tab、恢复工作区、provider offline。组件测试必须通过真实 host 挂载，新增 F25 对应 controls/YAML case。

#### 8.5.5 I4：高频编辑、Surround 与 Generate

先把已有导出变成真实 action：Sort Lines、Reverse Lines、Transpose、Unwrap/Remove。所有变换读取全部 selections，先把 range 归一化/合并，生成互不重叠 change，在一个 CodeMirror transaction 中提交并成为一个 undo 单元。selection 结束在下一行 column 0 时不额外包含该行；EOL 由 document model 保持，不在命令中硬写 `\n`。Sort 提供 ascending/descending、case、natural、stable 选项并记住 workspace preference；多 rectangle 的语义若无法保证，返回 unavailable 而不是部分修改。

`tabJumpOut` 和 `unwrapRemove` 必须读取 syntax tree/语言策略：字符串、raw string、模板插值、generic `>`、Python block、JSX 分别有 fixture。无法证明匹配 pair 时返回 false，让 Tab 正常缩进。`completeCurrentStatement` 改为 factory，显式传入 languageId、`ResolvedCodeStyle`、syntax context 和 provider；删除固定两空格与未知语言自动加 Java 分号的行为。

Surround/Generate 分两级：

- `local-syntax`：仅对 parser 能证明的 selection/block 做 if/try/loop surround，预览文本和插入点，取消零修改。
- `provider/local-index`：constructor/getter/setter/equals/hashCode/toString/override/implement/delegate 必须读取真实 class、字段、继承、语言级别、imports 和 conflicts；优先走 provider code action/command，J1 可用后再增加 local-index provider。

当前 `generateJavaCode` 的固定 `Objects.equals` 拼接和固定 `execute()` override 不得直接接 UI。结果统一转为 WorkspaceEdit/refactor preview，确认时复核 revision，应用为一个 undo transaction。

**验收。** Java/TS/Python/Rust/Markdown 的多选区、矩形、CRLF、只读、空选择、重叠 range、strings/comments/raw/template；Java record/final/static/boolean field、已有方法、继承 override、import collision、provider offline、stale preview、cancel/undo。每个 action 在 Action Service 中可发现，并给出具体 disabled reason。

#### 8.5.6 I5：Completion modes 与重复调用

保留现有 Basic LSP workflow，增加 request/session controller，而不是在 `lspCompletion.ts` 再堆独立 boolean：

```ts
interface CompletionSession {
  id: string;
  reason: "typing" | "trigger" | "explicit" | "reinvoke";
  requestedMode: "basic" | "extended" | "smart";
  documentVersion: number;
  providerGeneration: number;
  syntaxContext: "code" | "string" | "comment" | "unknown";
  budget: number;
}
```

typing 保留 debounce，server trigger/explicit 立即请求；同 popup 第二次调用先做 standard-LSP extended request，只有 provider/local-index 返回 expected type + assignability evidence 时才标 `smart`。标准 LSP 候选的 kind/sortText 不能被包装成 type-matching 证据。结果保留 `isIncomplete`、resolve/additional edits/snippet，截断时显示 truncated 和继续输入提示；AbortSignal、document version、provider generation 任一变化即丢弃。

验收覆盖 Java/TS/Python/Go/Rust 的 string/comment/raw/interpolation、explicit override、trigger character、连续 20 次输入、provider restart、200/1000/10000 items、resolve/edit race、popup 与 snippet/Full Line 的焦点优先级。记录 request/abort/stale/provider/mapping/paint 延迟但不记录源码或候选文本。

#### 8.5.7 J0/J1：语义来源治理与 Java 首个可证明切片

**立即纠偏。** 将现有三个 Java prototype 和 SSR prototype 明确标为 experimental test models；删除默认 `ready`、无 target ID 仍 `resolved`、completeness 恒 `complete` 的生产可能性。它们可保留用于 UI fixture，但不得被 `AnalysisPanel`、Rename 或 Apply 直接 import。

建立共享语义外壳：source、owning module/root、context generation、workspace/document revision、scope、completeness、unresolved/skipped counts、evidence 和 diagnostics。现有 LSP Rename/References 先适配该外壳并诚实标 `provider/partial`，由此先达到 L2 失败/新鲜度语义。

**J1 imported context。** 后端新增 `src-tauri/src/java_semantic/` 边界，输入复用 workspace execution/project model、SDK、source/test/generated roots、language level、compile classpath、dependency source 和 jdtls workspace folder。生成不可变 fingerprint；context 改变整代失效，dirty file 只更新对应 document overlay。

**技术门禁。** 在实现索引前交一个独立 spike，对 Java 17/21、record/sealed/generic/overload/import/static import、语法错误、multi-module、library JAR/source、generated source 比较：

1. jdtls/provider 查询能提供的 identity、references 和 completeness；
2. parser + classpath resolver 的准确度、内存和增量成本；
3. 持久化 SQLite schema/rebuild/corruption recovery。

若只使用 jdtls/LSP，状态最多 L2 且 completeness 通常为 partial；不得用 provider progress=ready 推导全索引 complete。走 local index 时必须有真实 parser/name/type resolution，不能扩展前端 regex。

**首个垂直切片。** 只做 Java Find Usages + Rename：声明/引用 identity、read/write/call/import role、multi-module/library ownership、complete/partial、conflict、dependent edit groups、revision/hash recheck、preview、apply、post-condition 和单步 undo。任何 unresolved/skipped 或 context stale 默认阻断 semantic rename；用户仍可显式改走现有 provider partial workflow，但 UI 必须区分。

J2 inspection 等 J1 稳定后再做：第一条规则从 parser/CFG 可证明的 unreachable 或 literal constant condition开始，结果附 control-flow path；nullability/taint/interprocedural 不得由逐行正则迁移。SSR 同理，首个切片必须消费 AST node + typed variable constraints，regex 只能改名为 Text Template Search。

#### 8.5.8 A2：递归分屏与 Tab 布局

用稳定、版本化的 binary tree 替代 prototype 的可变 class/`Date.now()` ID：

```ts
type EditorLayoutNode =
  | { kind: "leaf"; groupId: string }
  | { kind: "split"; id: string; orientation: "horizontal" | "vertical";
      ratio: number; first: EditorLayoutNode; second: EditorLayoutNode };

interface EditorLayoutStateV2 {
  schemaVersion: 2;
  root: EditorLayoutNode;
  groups: Record<string, CodeWorkspaceEditorGroupState>;
  activeGroupId: string;
}
```

所有操作做成纯 reducer：split leaf、close/collapse、move/copy tab、resize、equalize、activate、restore；找不到 ID 返回 typed no-op，ID 用 workspace-scoped monotonic/UUID factory。先写 v1 primary/secondary -> v2 migration 和 downgrade-safe recovery，再让递归 renderer 嵌套 `react-resizable-panels`。open buffer/LSP/save ownership 仍按 file key 单例，leaf 只拥有 tab order/selection/view state；同文件多 view 不得启动第二个 LSP document 或覆盖 dirty buffer。

交付分三步：A2.1 nested split + restore；A2.2 drag tab to existing/new split + keyboard splitter navigation/equalize；A2.3 detach Tauri window。Detach 前先定义主 controller ownership、window crash/reconnect 和关闭确认，子窗口不能复制 buffer 保存者。每步覆盖快速 split/close、最后 leaf、dirty/preview/pinned tab、同文件多 view、focus、drag cancel、restore corrupt schema、200% zoom。

#### 8.5.9 A4：严格本地的 Full Line Completion

保留 `FullLineSession` 作为接受 reducer，但增加 request/document/provider generation；新增独立 editor provider，不能复用 shell prompt 的 `tab_suggest_fim`：

```ts
interface InlineCompletionRequest {
  fileKey: string;
  languageId: string;
  prefix: string;
  suffix: string;
  cursorOffset: number;
  documentVersion: number;
  maxTokens: number;
  localOnly: true;
}

interface InlineCompletionProvider {
  status(): Promise<"ready" | "missing-model" | "unsupported-hardware" | "loading" | "failed">;
  complete(request: InlineCompletionRequest, signal: AbortSignal): Promise<EditorFeatureResult<string>>;
}
```

后端新命令不得 fallback 到 cloud router；模型 manifest 包含 runtime/model/prompt-template/version/hash/arch/min-memory，下载、校验、更新、rollback 和删除复用 models 基础设施。当前 `fim_engine_real::complete` 固定返回 `None`，必须完成真实 decode、prefix+suffix FIM template 和取消后才能显示 enabled。

CodeMirror 用 StateField/ViewPlugin 渲染非布局抖动的 ghost text；输入、光标、selection、document/provider generation 变化立即 cancel。Tab 只在 completion popup/snippet 未消费且设置允许时接受全部；另设 accept word/line 和 Esc dismiss action，全部进入 I1 Keymap。建议必须经过重复 prefix、非法控制字符、明显语法边界和 unresolved-reference 的有界过滤；auto-import 只能由 provider 返回结构化 edit 并经过 revision guard。

隐私默认：源文本不落日志、不进 telemetry、不出机；trace 只记长度、语言、latency、cancel reason、model version。验收含模型缺失/损坏/下载取消、无 AVX2 x64/ARM64、内存压力、offline、快速输入、popup/snippet coexist、多行/逐词/逐行、stale、large file 与 p95/memory。无真实 local decode 时保持 `model`，不能借 cloud 结果升为 workflow。

#### 8.5.10 A5/A6：下一批 IDEA 编辑体验

**Code Vision。** 后端补 `textDocument/codeLens`/resolve capability 与请求，或消费 J1 的结构化 usages/inheritors；统一 `CodeVisionItem { range, kind, count?, title, command, source, completeness, generation }`。只为可见 viewport + buffer margin 请求，按 document version 取消；CodeMirror block widget 不得改变行号/selection，点击 command 走 I1。无完整索引时显示 provider/partial，不伪造“0 usages”。首批只做 usages、inheritors、related problems，Git author 已有 inline blame，不重复建设。

**Paste History。** 只捕获 Taomni editor 内显式 Copy/Cut，不轮询系统剪贴板；默认 session-only、最多 50 项和 1 MiB、去重、可立即 Clear/Disable。`Ctrl+Shift+V` 弹窗走 I1，选择后按当前多光标语义一次提交/一次 undo。首批不持久化；任何未来持久化必须先有 secret/redaction 和 workspace/user scope 决策。

**Scratch Files。** 存在 app-data 的 guarded `scratches/`，使用稳定 `scratch://<id>` identity 和版本化 metadata（title/language/encoding/created/updated）；通过专用 WorkspaceFs adapter 读写，不进入 Git/root watcher。创建、重命名、删除、恢复、语言切换和关闭 dirty 提示形成 workflow；LSP 只有在 provider 支持对应 URI/真实受控 mirror 时开启，否则明确 local text only。

#### 8.5.11 Agent 拆分与合并顺序

| Agent ownership | 允许修改 | 不得同时修改 | 合并前输出 |
|-----------------|----------|--------------|------------|
| I0/I1 | action registry/service、commands adapter、keymap model/UI、Search/menu wiring | formatter、semantic engine、layout schema | action ID snapshot、双 workspace lifecycle、keymap migration、QA controls |
| I2 | resolver/source/controller、style preference、save transaction、相关 IPC/tests | action core、Java semantic | byte-level fixtures、race/failure matrix、真实文件 UI case |
| I3 | navigation controller/model/dialog、Switcher、navigation actions | layout schema、semantic parser | event/coalesce/relocate fixtures、MRU case |
| I4/I5 | CodeMirror commands、template/generate adapters、completion controller | Java index internals、save pipeline | language fixture matrix、undo/stale/perf evidence |
| J0/J1 | semantic envelope、Java backend/index spike、usages/refactor adapter | X 轨道 Build UI、regex 原型扩写 | context fingerprint、accuracy/perf report、IDEA comparison fixture |
| A2 | store layout v2、migration、recursive renderer、drag/focus | buffer/LSP ownership rewrite、detach before A2.2 | reducer property tests、restore/dirty/focus QA |
| A4/A5/A6 | respective provider/plugin/controller/UI files | cloud fallback、unrelated AI/terminal behavior | privacy/model manifest、latency, accessibility and failure evidence |

推荐合并顺序为 I0 -> I1；I2 与 I3 可在 I1 接口冻结后并行；I4/I5 消费 I1/I2；J0 可与 I2 并行但 J1 等 J0 schema；A2 与 A4 分别在 action/buffer ownership 和 completion action 固定后开始。任何跨 ownership 接口先提交纯类型/fixture 小 PR，不让两个 agent 同时改 `CodeWorkspaceTab.tsx` 大段装配。

---

### 8.6 v4.34 剩余待办（implementation-ready backlog，`f88c5785` 前历史快照）

本节记录 `f88c5785` 之前的生产代码复核，覆盖当时仍未达到 `workflow` 的 Editor 主线；当前增量审计和执行顺序以 §2.13/§8.8 为准。每个工作包必须保留 typed result、revision/generation、取消/失败/undo 语义；只增加模型、store 字段、renderer 骨架或测试而没有完整生产 lifecycle 时，状态仍为 `model/partial`。

| 优先级 | 工作包 | 当前状态 | 本轮必须收口 |
|--------|--------|----------|----------------|
| P0 | N1 EditorConfig/Save | wired / correctness gap | instance provider；resolved EOL/charset/BOM 进入 byte writer；双 workspace 与字节级 E2E |
| P0 | N2 Recent Locations | wired / partial | 事件型 edit 采集；严格 workspace 隔离；rename/delete/stale lifecycle |
| P0 | N6 Recursive layout | model + renderer skeleton | leafId group ownership；migration/persistence；生产 move/split/close/focus |
| P1 | N0 Action ownership | wired / dual truth | instance ActionHost；Search/menu/keymap/keydown 统一执行 |
| P1 | N3/N4/N5 | model/prototype | 高频编辑与 completion session；Java semantic vertical slice |
| 持续 | N7 QA/native gate | incomplete | 每包同步 catalog/YAML/native/perf evidence |

#### N0 Action ownership、Keymap 与测试隔离

**本次复核后的清单：**

- [x] `recentChangedFiles` 从错误 alias 拆成独立语义命令。
- [x] owner stack cleanup 可恢复旧 action，并广播恢复事件。
- [ ] 将 registry 从 global singleton 收口为 workspace/window instance ActionHost。
- [ ] 删除 keyboard/menu/Search Everywhere 对 `WorkspaceCommand[]` 的直接执行，只保留迁移 adapter。
- [ ] 同一 action 在所有入口返回一致的 availability、disabled reason、typed result 和 error/cancel 状态。
- [ ] 双 workspace 同 ID、visibility/active owner 切换、异常 cleanup、AbortSignal 与 keymap migration 有真实 host tests。

**目标。** 消除 global `workspaceActionRegistry` 与 `WorkspaceCommand[]` 双真值，让 Code Workspace、Search Everywhere、菜单、context menu、Keymap 和快捷键都调用同一个 instance-scoped action host。

**接口与状态：**

```ts
interface ActionHost {
  workspaceId: string;
  register(action: WorkspaceActionDefinition): () => void;
  getState(id: string, context: WorkspaceActionContext): ActionState;
  execute(id: string, context: WorkspaceActionContext, signal?: AbortSignal): Promise<ActionResult>;
  search(query: string, context: WorkspaceActionContext): WorkspaceActionDefinition[];
}

interface ActionStateV2 {
  owner: string;
  availability: "available" | "disabled" | "unsupported" | "stale" | "busy";
  disabledReason?: "noEditor" | "noSelection" | "readOnly" | "capability" | "providerOffline" | "conflict" | "busy" | "unsupported";
}
```

`CodeWorkspaceTab` mount 时创建 host，unmount/visibility change 只撤销自己的 registration；同 ID 的旧 cleanup 不得删除新 owner。若暂时保留共享 registry，必须为每个 action 保存 owner stack/multimap 与 activation token：B 覆盖 A 后 B cleanup 必须恢复 A，不能把 action 删除成空。`WorkspaceCommand` 只作为迁移 adapter，不能再被键盘 handler 直接执行。alias 只允许完全相同的输入、enabled 状态、payload 和结果语义；`workspace.recentLocations` 与 `workspace.recentChangedFiles` 不满足时应拆成两个非 alias ID，或统一为带 `changedOnly: boolean` 的 canonical action。Keymap scheme 至少保存 `schemaVersion/platform/bindings/disabledActions`，读取失败回退 builtin 并报告 `keymap.migration-failed`。dispatch 先按 focus/when/context specificity 排序，再按 active scheme 解析；未命中返回 `no-op`，不吞掉事件。

**文件边界。** N0 agent 负责 `workspaceActionRegistry.ts`、`workspaceCommands.ts`、`useWorkspaceActionsController.ts`、`CodeWorkspaceTab.tsx` 的装配、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx`、keymap settings/store 和对应测试；不得修改 formatter、Java parser 或 DAP request。

**验收。** 两个 workspace 同时挂载同一 action ID 时互不覆盖；registry test 清理不会影响仍挂载的 tab；Search/menu/keymap/keydown 对同一 action 返回相同 `ActionState` 和 `ActionResult`；Ctrl/Meta、AltGr、chord、modal/editor/tree focus、disabled reason、AbortSignal、重复执行和 action error 均有 component/pure tests；新增 F25 controls 与 YAML case。

#### N1 EditorConfig provenance 与 Save Transaction

**本次复核后的清单：**

- [x] 异步 resolver 已进入 format/save；root 越界中止、watcher invalidation、normalizer race/encoding guard 已接线。
- [x] 未显式配置 EOL 时，trim/final-newline 保留 LF/CRLF/裸 CR。
- [ ] 将 resolver 与 file provider 改为 workspace/root instance-owned，禁止后挂载 tab 覆盖前一个 tab 的 provider。
- [ ] SaveTransaction 携带 resolved `endOfLine/charset/bom`，最终 writer 不得再无条件使用旧 `file.eol/file.encoding/file.bom`。
- [ ] 对 UTF-8/BOM/UTF-16/Latin-1 与 LF/CRLF/CR 做真实 save/reopen byte equality；覆盖 resolved policy 改变文件编码/EOL 的场景。
- [ ] 补 multi-root 相同路径、provider permission/parse failure、rename/delete config、并发 workspace 和 style generation tests。

**目标。** 让 `.editorconfig -> effective style -> CodeMirror/formatter -> 一次写盘` 成为生产链路，保留非缩进字段，避免格式化期间旧 buffer 覆盖新输入。

**接口与状态：**

```ts
interface StyleRequest {
  workspaceId: string; rootId: string; fileKey: string; path: string;
  bufferVersion: number; explicitOverride?: ExplicitIndentationOverride | null;
}

interface SaveTransaction {
  fileKey: string; bufferVersion: number; expectedDiskHash: string | null;
  styleGeneration: number; text: string;
}

type SaveResult =
  | { status: "saved"; finalText: string; bytes: number; stages: SaveStage[] }
  | { status: "cancelled" | "conflict" | "failed"; reason: string; retryable: boolean; stages: SaveStage[] };
```

Resolver provider 必须用 workspace/root-aware file reads，cache key 含 `workspaceId/rootId/configPath`，并以 canonical path boundary 验证文件确实位于 root 内；`clearWorkspace` 只能清理该 workspace。读取缺失、权限和解析错误要进入 diagnostics，不得静默伪装为空配置。每个字段独立合并和标注 provenance：仅有 EOL/charset/trim/newline 的 config 仍不能抑制未配置字段的 indentation sniff，`source` 总标签不能把 language-default 缩进误报为 EditorConfig。watcher 对 `.editorconfig` create/change/rename/delete 使受影响文件的 `styleGeneration` 递增。显式 override 只覆盖 indent 三字段，其余 EOL/charset/trim/newline 继续来自最近匹配 section。保存顺序固定为 formatter -> trim -> final newline -> EOL -> encoding/BOM validation -> **一次** hash-guarded write；若未显式配置 EOL，trim/final-newline 阶段必须保留输入的 LF/CRLF/CR 分隔符，不能默认拼回 LF。format/normalize 等待期间若 bufferVersion 变化，取消旧 transaction，不写旧文本，保留 dirty 并允许 retry。编码必须在 backend byte writer 中完成，BOM 按字节处理；`utf-16`/legacy 不可表示字符返回 typed failure 并阻断写盘，normalizer 需覆盖 bare CR。

**文件边界。** N1 负责新建 style controller（可放 `workspace/editorConfigController.ts`）、`editorConfigResolver.ts`、`saveNormalizationPipeline.ts`、`CodeWorkspaceTab.tsx` 保存接线、必要 IPC bridge 和测试；不得改 Action Service 核心或 Java semantic。

**验收。** nested/root-stop/glob/provenance、workspace/root 隔离与 cache clear、配置变更实时刷新、仅 EOL/charset 时的 per-field fallback、显式 override partial merge、LF/CRLF/CR（含 trim/final-newline 不改写未配置 EOL）、UTF-8/BOM/UTF-16/legacy 不可表示字符、formatter error/offline、连续输入 race、外部 hash conflict、权限/锁定/网络盘、save/reopen byte equality、undo/redo 与真实 Tauri 文件 UI case。

#### N2 Recent Locations、Switcher 与生命周期

**本次复核后的清单：**

- [x] ID 使用单调 sequence；dialog 订阅更新；root containment 使用分隔符边界；external reload 同步 tracked text。
- [ ] 从 CodeMirror document-change、成功导航、tab activation 等事件采集，移除 `cursorPositions + activeFileText` effect 的 edit 判定。
- [ ] workspace 查询严格要求 `loc.workspaceId === activeWorkspaceId`；legacy 无 owner 条目必须迁移或隔离，不能默认泄漏给所有 workspace。
- [ ] 在 rename/move/delete/external conflict 生产路径调用 relocate/remove/stale API；点击 stale/missing 项给出可解释结果。
- [ ] tracker 改为 per-instance store/controller，加入 symbol/context hash relocation 与关闭/恢复生命周期。
- [ ] 完成 Ctrl+Tab Switcher 的 MRU preview、modifier-release commit、Esc cancel 和无障碍/QA YAML。

**目标。** 替换 `navigationHistoryTracker` global singleton，按 workspace instance 保存位置历史，并让记录来源、重定位和失效状态可解释。

**事件与数据：**

```ts
type NavigationReason = "navigate" | "edit" | "search" | "usage" | "refactor" | "tab-activate";
interface NavigationLocationV2 {
  id: string; workspaceId: string; fileIdentity: string; range: LspRange;
  reason: NavigationReason; symbolId?: string; beforeContext: string;
  selectedText: string; afterContext: string; contentHash: string;
  workspaceRevision: number; ownership: "workspace" | "library" | "external";
  state: "current" | "relocated" | "stale" | "missing"; timestamp: number;
}
```

只在成功 open/reveal、编辑 cluster 结束、usage/refactor 跳转、tab activation 等事件记录；普通 caret movement 使用 debounce + 离开位置提交，不能每次 `cursorPositions` effect 写入，更不能用整文件 `dirty` 把 dirty 文件中的每次光标移动标为 edit。按 `(workspaceId,fileIdentity,symbol/reason)` 在 2 秒/相邻 3 行内 coalesce，edit 与 navigation 两条历史都必须合并；ID 用 workspace-scoped monotonic/UUID，不能依赖 `Date.now()` 单毫秒唯一性。Recent dialog 订阅 store snapshot，并在 `initialChangedOnly` 改变时重置查询，打开时新记录立即可见。所有路径先 canonicalize，再按分隔符/大小写策略做 root containment，禁止裸 `startsWith`。rename 先用 fileIdentity 更新，再用 symbolId/context hash relocate；删除/外部冲突标记 `missing/stale`，点击给出 reason 而不是静默跳错位置。Switcher (`Ctrl+Tab`) 使用 MRU preview，按 modifier release commit，Esc 取消，preview 不改变 MRU。

**文件边界。** N2 负责 `navigationHistoryModel.ts`、`RecentLocationsDialog.tsx`、新增 per-instance store/controller、`useWorkspaceNavigation.ts`/`CodeWorkspaceTab.tsx` 事件接线和 Switcher；不得同时改 recursive layout schema 或 semantic parser。

**验收。** 双 workspace 隔离、dirty 文件中的 caret 不产生 edit 噪声、edit/navigation 分别 coalesce、同毫秒稳定 ID、root path boundary（Unix/Windows/UNC）、dialog live subscription 与 changedOnly 切换、tab preview/cancel/commit、rename/delete/external change/library、关闭/恢复 workspace、provider offline、键盘/读屏；`recent-locations-*` 和 `switcher-*` testid 进入 feature catalog/YAML。

#### N3 高频编辑、Surround/Generate 的真实 action

**目标。** 将 Sort/Reverse/Transpose/Unwrap/Surround 变成可发现、可撤销的 CodeMirror transaction；语义 Generate 只能由 provider/index 结果驱动。

所有 action 读取全部 selections，按 document offset 归一化并合并重叠 range，生成单一 transaction/undo group；selection 结束在下一行 column 0 时不额外包含该行，EOL 使用 document model。Sort 提供 ascending/descending、case-sensitive、natural、stable 选项和 workspace preference；无法证明矩形/重叠语义时返回 `unsupported`，不做部分修改。Tab jump-out、unwrap、complete statement 读取 language/syntax context；字符串/raw/template/JSX/generic `>`/Python block 均有 negative fixture。

Surround local-syntax 只接受 parser 能证明的 pair，并提供 preview/cancel；constructor/getter/setter/equals/hashCode/toString/override/implement 必须消费 provider code action 或 J1 结构化 symbol/import/conflict，统一转换为 revision-guarded WorkspaceEdit + RefactoringPreviewDialog + 单步 undo。固定文本生成器不得直接挂 UI。

**文件边界。** N3 负责 `workspaceEditorCommands.ts`、CodeMirror keymap/command adapter、`surroundGenerateModel.ts` 的 provider-facing contract、actions/UI/fixtures；不得扩写 regex Java index。

#### N4 Completion modes 与 Full Line 前置契约

**目标。** 在现有 Basic LSP completion 之上建立显式 session/generation；Smart/Type-matching 没有类型证据时必须 unavailable；Full Line 保持 local-only 独立轨道。

`CompletionSession` 至少包含 `id/reason(document typing|trigger|explicit|reinvoke)/requestedMode(documentVersion/providerGeneration/syntaxContext/budget)`；AbortSignal、documentVersion、providerGeneration 任一失配丢弃结果。保留 `isIncomplete`、resolve/additionalTextEdits/snippet；截断显示原因和继续输入提示。第二次调用可以请求 extended，只有 provider/local index 返回 expected type + assignability evidence 才标 smart；标准 LSP `kind/sortText` 不算证据。

Full Line provider 的 request 必须含 `prefix/suffix/cursorOffset/documentVersion/localOnly:true`，状态包括 `missing-model/unsupported-hardware/loading/failed/ready`；无真实 decode 时 UI 只能 unavailable。Ghost text 通过 CodeMirror StateField/ViewPlugin，popup/snippet 优先级明确；Tab/accept word/accept line/Esc 全部走 N0 action，输入/selection/provider generation 变化立即 cancel。源文本不落日志、不走 cloud fallback。

**文件边界。** N4 负责 completion controller、`lspCompletion.ts`、`CodeMirrorHost.tsx` completion extension、Full Line provider/runtime、model manifest/IPC adapter 和 fixtures；不得修改 Console/DAP 或保存事务。

#### N5 Java semantic vertical slice 与 SSR 边界

**目标。** 先把现有 LSP/provider 结果适配统一 semantic envelope，再实现 Java Find Usages + Rename 的首个可证明切片；prototype 不得进入 Apply。

Envelope 必须包含 `source/owningRoot/module/contextGeneration/documentRevision/scope/completeness/unresolvedCount/skippedCount/evidence/diagnostics`。J1 backend context 输入 SDK、source/test/generated roots、language level、compile classpath、dependency source、jdtls workspace folder，生成 fingerprint；context 变化整代失效，dirty buffer 只更新 overlay。任何 unresolved/skipped、stale revision、冲突或 provider offline 默认阻断 semantic rename；用户若选择既有 provider partial workflow，UI 显示 partial 来源和风险。

首切片只覆盖 declaration/reference identity、read/write/call/import role、multi-module/library ownership、conflict、dependent edit groups、preview/apply/post-condition/undo。J2 第一条 inspection 必须来自 parser/CFG 可证明路径；逐行正则 nullability/taint 禁止迁移。SSR 首切片消费 AST node + typed variable constraint；regex 只能命名为 Text Template Search。

**文件边界。** N5 负责 `src-tauri/src/java_semantic/`、前端 semantic envelope/adapter、J1 fixtures 与 `AnalysisPanel` 来源标识；不得接管 Build/Run UI，不得扩写现有 regex prototypes。

#### N6 Recursive layout runtime

**本次复核后的清单：**

- [x] reducer 的 move/active/migration 预校验与损坏树恢复已具备基础测试。
- [x] store 已预留 `layoutTreeV2`，生产组件已有递归 PanelGroup renderer 骨架。
- [ ] 建立 mount migration、命令 mutation、snapshot persistence/restore；当前没有生产代码设置 `layoutTreeV2`。
- [ ] editorGroups 从固定 `primary/secondary` 扩展为 leafId-keyed ownership；每个 leaf 维护独立 tab order/activeKey/view state。
- [ ] renderer 消费 node ratio、方向和稳定 ID，并正确处理任意深度 leaf，不能把所有非 secondary leaf 映射为 primary。
- [ ] 接 split/move/close/drag/focus 与 dirty buffer 单 owner；补 property tests、坏快照降级和真实 host QA。

**目标。** 把 reducer/migration 从 model test 接到 store/render/persistence，同时保持 file buffer/LSP/save 单例。

使用版本化 schema：`{ schemaVersion: 2, root: EditorLayoutNode, groups, activeGroupId }`；ID 由 workspace-scoped monotonic/UUID factory 产生。所有 reducer 先在不可变快照上预校验 source/target leaf、file ownership、activeKey、节点唯一性、child count 和 ratio，再返回 `{state, changed, reason?}`；找不到 leaf、source/target 相同、重复 move、最后 leaf close、非法 ratio 都是 typed no-op/error，不能先修改一侧再报告失败。`setLeafActiveTab` 不得激活不属于该 leaf 的 key，文件 key 在整棵树中必须满足唯一/归属不变量。migration 验证节点类型、ID 唯一、leaf key/activeKey、子数、ratio 总和与边界，损坏时回退单 leaf 并保留 diagnostic。renderer 嵌套 `react-resizable-panels`，leaf 只拥有 tab order/selection/view state，文件 key 仍由单一 buffer/LSP owner 管理。

**文件边界。** N6 负责 `recursiveLayoutTree.ts`、`codeWorkspaceStore.ts`、布局 persistence/renderer、tab drag/focus QA；不得在 A2.1 重写 buffer/LSP ownership 或提前做 Tauri detach。

**验收。** 缺失 source/target、source=target、目标已有同 key、foreign active key、重复 node ID、child 数与 ratio 不匹配、损坏 migration 均返回可断言的 no-op/error 且原树不变；property test 对任意合法树验证 tab multiset、每个 activeKey 属于本 leaf、ID 唯一和 ratio 归一化，连续 move/close/split 不丢 tab、不复制 tab。生产 host 需覆盖恢复坏快照、拖拽取消、dirty buffer 仍由单一 owner 保存。

#### N7 发布门禁、QA 与三端证据

每个 N package 交付：纯 reducer/unit、真实 host component、`qa-ui-auto-tests/feature-list.md` + testid catalog + YAML、至少一条 Tauri/native fixture（适用时）、性能采样和失败日志。统一记录 package status、source/completeness、revision/generation、provider/adapter、OS/WebView/字体/键盘/IME 版本；不记录源码、候选文本、表达式或变量值。

最低门禁：小/中/大工程输入 p95、completion/format IPC latency、10k 输出/100k 文件搜索内存、20 threads x 200 frames、200% zoom/读屏/仅键盘；Linux Wayland/X11、macOS Apple Silicon、Windows 11 各至少一条 Java/TS fixture。Browser/jsdom/Vitest/Rust protocol tests 只能作为自动化层，不能替代三端真实包或 IDEA 2026.2 对照结果。

**推荐合并顺序。** `N0 -> N1/N2` 并行；`N3/N4` 消费 N0/N1；`N5` 可与 N1 并行但先冻结 envelope；`N6` 在 N0 的 active-group/action ownership 固定后开始；`N7` 随每包增量执行，不能最后一次性补 QA。任何跨 ownership 修改 `CodeWorkspaceTab.tsx` 前先提交纯类型/fixture PR，避免多个 agent 同时重排大组件。

---

### 8.7 v4.35 下一轮待办（`3f107de9` 前历史合同）

本节保留 `f88c5785` 后形成的完整设计合同；`3f107de9` 只修复其中的 build gate，并未完成 N0/N1/N2/N6。当前可执行拆分、顺序和完成门槛以 §8.8 为准。每个 agent 必须提交生产 host 接线、typed result/state、取消/失败/恢复、纯测和组件测；涉及 editor workflow 的包还必须同步 `feature-list.md`、`references/testid-catalog.md`、YAML case。没有 native 或真实 provider 证据时，最高只能标为 `workflow-candidate`，不能标 `verified`。

| 顺序 | 包 | 负责人边界 | 交付门槛 |
|------|----|------------|----------|
| P0 | N0 ActionHost | action registry/commands、workspace tab host、Search/menu/keymap/keydown bridge | 所有入口同一 `ActionState/ActionResult`；双 workspace 隔离；失败/取消可重试 |
| P0 | N1 Save transaction | resolver/provider、normalizer、save/workspace-edit writer、必要 IPC | resolved policy 进入一次 byte write；UTF/EOL 矩阵与 Tauri reopen equality |
| P0 | N2 Navigation lifecycle | navigation model/controller、Recent dialog、file actions、Switcher | edit/navigation 事件分流；workspace owner/canonical path/stale；Ctrl+Tab MRU |
| P0 | N6 Recursive layout | tree reducer/store/persistence/renderer/leaf selectors | typed no-op 原子性；schema v2 完整 restore；无 primary/secondary 隐式回退 |
| Gate | N7 Evidence | 纯/组件/host/QA/native/perf 协调，不改产品真值 | 每包有可复现 trace、catalog/YAML、性能和适用三端记录 |
| 延后 | N3/N4/N5 | 高频编辑、Completion/Full Line、Java semantic/SSR | 继续保持 `model/prototype`，不得因新增 UI 或 regex 测试提前升级 |

#### N0：ActionHost 迁移与双真值消除

**生产改动。** 在 `CodeWorkspaceTab` mount 时创建 `{workspaceId, windowId, activationToken}` 的 `ActionHost`；`workspaceActionRegistry` 只保留兼容 facade。将 `CodeWorkspaceTab.tsx:7484` 的 keydown、Search Everywhere 的执行分支、菜单/context menu 和 `KeymapCheatSheetDialog` 全部改为 `host.execute(id, context, signal)`；`WorkspaceCommand[]` 只能由 catalog adapter 生成 descriptor，不能直接调用 handler。Debug action 通过同一 bridge 暴露，但 DAP capability 仍由 Debug service 提供。

**不变量。** registration 返回带 token 的 disposer；旧 owner cleanup 不能删除新 owner。`getState` 与 `execute` 必须读取同一 context/freshness，返回 `available|disabled|unsupported|stale|busy` 和 `{kind: "applied"|"no-op"|"failed"|"cancelled"}`。focus/visibility/active workspace 改变时重新仲裁；Abort、重复执行和 provider exception 必须释放 in-flight，不得吞错。

**文件/测试。** 负责 `workspaceActionRegistry.ts`、`workspaceCommands.ts`、`useWorkspaceActionsController.ts`、`CodeWorkspaceTab.tsx` 装配、`SearchEverywhere.tsx`、keymap store/dialog 与 N0 tests。用两个相同 action id 的 workspace host、卸载顺序、modal/editor/tree focus、Ctrl/Meta/AltGr/chord、Search/menu/keydown parity 做 host/component tests；QA 增加 action disabled reason 和 keymap remap case。

#### N1：EditorConfig provider ownership 与 SaveTransaction

**生产改动。** 删除 per-tab 对 `globalEditorConfigResolver.setFileProvider` 的写入，改为 workspace/root controller 注入 provider；cache key 与 invalidation 含 `workspaceId/rootId/configPath`。定义 `SaveTransaction { fileKey, bufferVersion, expectedDiskHash, styleGeneration, resolvedEol, resolvedCharset, resolvedBom, text }`，formatter/trim/final-newline/encoding/BOM/byte write 只能消费同一 transaction。普通 save 和 WorkspaceEdit 的 `writeDisk` 复用一个 writer policy，禁止回读旧 `file.eol/file.encoding/file.bom`。

**失败与竞态。** buffer/style/hash 任一代数变化返回 typed `cancelled`，不写旧文本并保留 dirty；不可表示字符、权限、外部冲突分别返回 `failed/conflict`，可重试但不静默 fallback。writer 先产生 bytes，再以 hash guard 一次提交；BOM 不作为文本字符参与 normalizer。

**文件/测试。** 负责 `editorConfigResolver.ts`、`saveNormalizationPipeline.ts`、`CodeWorkspaceTab.tsx` save 接线、`useWorkspaceFileActions.ts`/IPC writer 和 tests。测试 nested root/provenance、双 workspace 相同路径、formatter race、WorkspaceEdit 与普通 save 一致性；Tauri fixture 对 UTF-8/UTF-8-BOM/UTF-16/Latin-1 与 LF/CRLF/CR 做 save -> close -> reopen 的 byte equality，记录不支持编码和权限失败。

#### N2：Recent Locations 事件生命周期与 Switcher

**生产改动。** 由 document-change、成功 navigation/reveal、usage/refactor、tab activation 事件显式调用 `record(location, reason)`；删除 `activeFileText + cursorPositions` 的 edit 判定，`updateFileText` 增加 `source: "user-edit"|"formatter"|"workspace-edit"|"reload"`，仅 user-edit/显式导航进入历史。controller/store 按 workspace instance 创建，所有查询要求 workspaceId，启动时迁移或隔离 legacy 无 owner 条目。

**身份与生命周期。** path 先 canonicalize，再按平台大小写/UNC/symlink/junction 策略检查 root；rename 先按 file identity relocate，再用 symbol/context hash 尝试恢复，失败标 `stale`，delete/外部冲突标 `missing/stale`。coalesce 使用 `(workspaceId,fileIdentity,reason)` 加时间/行距窗口，ID 使用 workspace-scoped monotonic/UUID。实现 Ctrl+Tab MRU preview：modifier release commit、Esc cancel，preview 不改变 MRU；关闭/恢复 workspace 保留可解释状态。

**文件/测试。** 负责 `navigationHistoryModel.ts`、`RecentLocationsDialog.tsx`、`useWorkspaceNavigation.ts`、`useWorkspaceFileActions.ts`、`CodeWorkspaceTab.tsx` 事件接线和 Switcher。测试 dirty caret 不产生 edit 噪声、rename/delete/external/stale、双 workspace 同路径、Unix/Windows/UNC 边界、dialog subscription/changedOnly、preview cancel/commit；同步 `recent-locations-*`/`switcher-*` catalog 和 YAML。

#### N6：Recursive layout typed mutation 与 schema v2 restore

**生产改动。** `moveLayoutTab/setLeafActiveTab/splitLayoutLeaf/closeLayoutLeaf` 必须先调用 reducer，只有 `{changed: true}` 才同步 `editorGroups`、active group 和 view state；no-op/error 必须保持整个 Zustand snapshot 引用和值不变。引入 workspace-scoped id factory，验证 finite/non-negative ratios、总和容差、节点/leaf/file key 全树唯一以及 `newFileKey` 未归属其他 leaf。关闭 leaf 同时清理 group，禁止保留 stale editorGroups。

**快照与 renderer。** 持久化 `{schemaVersion: 2, root, groupsByLeafId, ratios, activeGroupId}`，v1 primary/secondary 只迁移一次；坏快照回退单 leaf 并发 diagnostic。renderer/selector 以真实 leafId 派生 tab list、activeKey、viewport/cursor/highlight/inlay 状态；PanelGroup 的 `onLayoutChanged` 回写 ratios。move/split/close/focus/drag/equalize 均通过同一命令，不再以 `secondary ? secondary : primary` 回退。

**文件/测试。** 负责 `recursiveLayoutTree.ts`、`codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`CodeWorkspaceTab.tsx` renderer/commands 和 layout tests。加入 reducer property/fuzz、store no-op atomic、schema migration、任意深度 renderer、dirty buffer 单 owner、restore/resize/focus host tests；QA 覆盖 split/move/close/drag/focus/reload 和两个 workspace 隔离。

#### N7：证据门禁与合并顺序

N7 不修改产品 capability truth，只维护证据链。每个包在 PR 中列出纯测试、组件测试、真实 host 测试、`qa-ui-auto` controls/YAML、适用的 Tauri/native trace 和性能数据；trace 脱敏，不记录源码、变量值、表达式、完整路径或凭据。N0/N1/N2/N6 先完成 typed interface 再并行实现；若同一包需要改 `CodeWorkspaceTab.tsx`，按“host wiring / save / navigation / layout”区域提交，禁止跨包重排。N3/N4/N5 只能在相应 ownership 和 generation contract 冻结后恢复。

---

### 8.8 v4.36 执行批次（`1b6f91cf` 前历史快照，当前合同见 §8.10）

本批次的目标不是再增加模型，而是把 §8.7 拆成能独立合并、能证明 production ownership 的小提交。优先级按数据损坏风险排序：N1.1 Save、N6.1 Layout、N0.1 Action、N2.1 Navigation；N7 随包交付。完成本批次前，N3/N4/N5 和新的 IDEA surface 继续冻结。

| 顺序 | 子包 | 完成定义 | 主要文件 owner |
|------|------|----------|----------------|
| P0 | N1.1 Style/Writer ownership | 无 mutable global provider；open/closed save 共用 EOL/charset/BOM policy；generation/hash conflict typed | resolver、save pipeline、workspace edit writer |
| P0 | N6.1 Atomic layout state | reducer no-op 不改任何 state；tree/group 同步；生产 hydrate/restore 可达；ratios 持久化 | recursive tree、workspace store、layout persistence |
| P1 | N0.1 Instance ActionHost | keydown/Search/menu/context/keymap 全部由 instance host 执行 | action registry/commands、workspace host |
| P1 | N2.1 Event navigation | user edit 与 programmatic edit 分流；strict workspace owner；stale/missing caller 完整 | navigation controller/file actions/workspace host |
| Gate | N7.1 Evidence | 每包 build + targeted + host + QA catalog/YAML；适用 native fixture | tests/QA/evidence only |

#### N1.1：不可变 StyleController 与统一字节 Writer

**接口先行。** 新建 workspace-owned `WorkspaceStyleController`，构造函数一次注入 `{workspaceId, roots, fileProvider}`；删除生产路径对 `globalEditorConfigResolver` 和 `setFileProvider` 的依赖。测试可直接创建 resolver，但生产 controller 不暴露 mutable provider。cache/invalidation key 固定为 `(workspaceId, rootId, canonicalConfigPath)`，root 变更通过重建 controller 或显式 `replaceRoots(generation)`，不能覆盖其它 workspace。

```ts
interface DiskTextSnapshot {
  text: string; eol: OpenFileEol; encoding: string; bom: boolean; hash: string | null;
}
interface SaveTransactionV2 {
  id: string; workspaceId: string; fileKey: string; bufferVersion: number;
  styleGeneration: number; expectedDiskHash: string | null;
  policy: { eol: OpenFileEol; encoding: string; bom: boolean };
  text: string;
}
type SaveOutcome =
  | { kind: "saved"; transactionId: string; hash: string }
  | { kind: "cancelled" | "conflict" | "failed"; reason: string; retryable: boolean };
```

**单一写盘路径。** `saveOpenBufferText` 和 closed-file `WorkspaceEdit.writeDisk` 都调用 `writeTextSnapshot(transaction)`：先在 LF buffer 上应用 formatter/trim/final-newline，再按 policy 转 EOL、编码和 BOM，最后一次 hash-guarded byte write。`WorkspaceEditApplyHooks.readDisk` 必须返回 EOL，不能只返回 encoding/BOM；CRLF/CR closed file 经过 text edit 后仍保持原 EOL。若 EditorConfig 明确改变 policy，写回结果和 open-file metadata 同步更新。UTF-8 BOM 也走 byte-aware backend，不把 `\uFEFF` 拼进逻辑文本。

**竞态与失败。** resolver/formatter 完成后再次比较 bufferVersion、styleGeneration 和 expected hash；任一变化返回 cancelled/conflict，保留 dirty，不触发 didSave。编码不可表示、权限、锁定文件和 backend partial failure 分别返回 typed error；禁止 catch 后改用 UTF-8。每个 outcome 更新状态栏/diagnostic，并允许显式 retry 创建新 transaction。

**测试与边界。** N1.1 owner 限 `editorConfigResolver.ts`、新 style controller、`saveNormalizationPipeline.ts`、`workspaceEditApply.ts` hooks、必要 IPC 与 `CodeWorkspaceTab` save 区。测试双 workspace 同名 root/provider、root replacement、config rename/delete、连续输入/format race、hash conflict；Tauri temp fixture 覆盖 open/closed × LF/CRLF/CR × UTF-8/BOM/UTF-16LE/BE/Latin-1 的 save -> close -> reopen byte equality。不得修改 Action/Layout/Debug。

#### N6.1：LayoutMutation 原子提交与生产启用

**统一 mutation contract。** tree reducer 返回 `{kind: "changed", tree, groups, activeGroupId} | {kind: "no-op" | "failed", reason}`；Zustand 只在 `changed` 时一次替换 tree/groups/active id。`splitLayoutLeaf/closeLayoutLeaf/moveLayoutTab/setLeafActiveTab` 不得在 reducer 返回原树时继续创建 group、改 activeKey 或切 active group。关闭 leaf 必须删除对应 group；关闭 tab/reorder/pin/activate 必须同步 leaf keys/active key，不能出现本次 `onClose` 只改 group 的分叉。

**生产 lifecycle。** workspace hydrate 时将 legacy primary/secondary snapshot 一次迁移到 `{schemaVersion:2, tree, groupsByLeafId, activeGroupId}` 并调用 `setLayoutTreeV2`；这是首个生产可达入口。restore 校验 node/leaf/group ID、leaf 与 group tab multiset、active key、finite positive ratios 和 ratio sum 容差；损坏快照回退单 leaf并记录 diagnostic。`PanelGroup.onLayoutChanged` 把 normalized ratios 写回同一 snapshot。ID 使用 workspace-scoped UUID/monotonic factory，不用 `Date.now()`。

**交互语义。** split 可在任意 leaf 执行；close split 支持 primary 和 dynamic leaf，但最后 leaf返回 typed no-op。tab move/drag 在 drop commit 时原子更新，cancel 不改变 state；同一 buffer 可由多个 leaf view 引用时，必须明确采用 shared-buffer/multi-view contract，dirty/LSP/save 仍只有一个 owner，不能用“全树 file key 唯一”误杀合法 split view。view state 以 `(leafId,fileKey)` 保存，buffer state 以 fileKey 保存。

**测试与边界。** N6.1 owner 限 `recursiveLayoutTree.ts`、`codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`CodeWorkspaceTab` layout host、`EditorGroup` leaf adapter 与 tests。property tests 覆盖随机 split/move/close/activate/resize、invalid ID/ratio/no-op reference equality、close tab 后 tree/group 一致；host tests 覆盖首次 migration、任意深度 restore、dirty shared buffer、关闭 primary、reload ratios。不得修改 save/action/navigation。

#### N0.1：Workspace-scoped ActionHost 与统一执行结果

创建 `ActionHostProvider`，每个 workspace/window 持有独立 registry、activation token 和 context snapshot。将 `executeWorkspaceCommand`、`dispatchWorkspaceCommandKeydown`、Search Everywhere 的 `WorkspaceCommand[]`、顶部/右键菜单和 keymap dispatcher 迁移为 `host.getState/execute/search`；旧 `WorkspaceCommand` 只保留 metadata adapter，不能持有第二套 handler。Debug service 通过 adapter 注册到 active workspace host，但 action capability 仍由 Debug owner 计算。

`execute` 捕获 action owner/context generation，返回统一 `applied|no-op|cancelled|failed`；Abort、provider error、visibility change和 owner unmount 都释放 busy。两个 workspace 同 action ID、A/B mount/unmount 顺序、inactive window、modal/editor/tree/terminal focus、AltGr/chord、Search/menu/key parity 必须有 host tests。N0.1 owner 限 action registry/commands/controller、Search/keymap/menu adapters 和 `CodeWorkspaceTab` command host；不得改 save/layout reducer。

#### N2.1：事件型 LocationController 与严格 workspace identity

给 `updateFileText` 增加必填 source，或拆为 `applyUserDocumentChange/applyProgrammaticText`；只有 CodeMirror document transaction 可产生 edit location，formatter、WorkspaceEdit、local-history restore、external reload 不产生用户 edit。成功 reveal/navigation、usage/refactor、tab activate分别发明确 reason；删除依赖 `activeFileText + cursorPositions` 的通用 effect。controller 由 workspace 创建和销毁，`workspaceId` 从数据与查询 API 中改为必填；legacy 无 owner entry 隔离或迁移，不进入任意当前 workspace。

canonical path policy 必须按平台处理大小写、drive/UNC、separator、symlink/junction；rename 用 stable file identity relocate，delete 标 missing，外部冲突调用 stale，点击无效项返回 typed reason。N2.1 先完成生命周期和 dialog live subscription；Ctrl+Tab Switcher 作为 N2.2，只在 ActionHost 完成后接入 modifier-release commit/Esc cancel。测试 user/programmatic edit 分流、dirty caret 零噪声、双 workspace同路径、rename/delete/stale、Unix/Windows/UNC 和关闭/恢复。

#### N7.1：本批次门禁与合并顺序

每个子包必须更新 `qa-ui-auto-tests/feature-list.md`、testid catalog 和至少一条 YAML；单测不替代真实 host。建议合并顺序：先并行提交 N1.1 的纯 controller/writer 与 N6.1 的纯 mutation/store；然后按 `N1 host wiring -> N6 host wiring -> N0 host -> N2 events -> N7 native` 串行修改 `CodeWorkspaceTab.tsx`。每次合并必须保持 `pnpm build` 和对应定向测试全绿。完成标准还包括 N1 字节 fixture、N6 reload/drag host、N0 双 workspace、N2 platform path fixture；没有这些证据不得勾选 §8.7 对应包。

### 8.9 v4.37 下一轮待办（`1b6f91cf` 前历史快照，当前合同见 §8.10）

本节是 `3aacbecc` 之后、`1b6f91cf` 之前的执行清单，现保留为历史追溯；其后合同见 §8.10，当前执行合同见 §8.11。每个 agent 必须在 PR 中标明本包达到的最高层级（`model`/`wired`/`workflow`/`verified`），并保留其它 agent 的修改。不能用新增类型或单测通过替代生产 consumer、真实写盘、真实布局恢复或 QA/native 证据。

| 顺序 | 工作包 | 目标 | 文件边界 | 完成门槛 |
|------|--------|------|----------|----------|
| Gate 0 | N7.2 红色门禁 | 先修失败测试并锁定真实基线 | `workspaceStyleController.test.ts`、fixtures、CI 命令 | 合法多行 EditorConfig fixture；编辑器定向 134/134、store 8/8、Debug 46/46、build、diff-check 全绿 |
| P0 | N1.2 Save transaction | controller/style generation/buffer revision/hash 成为唯一写盘事实 | style controller、save pipeline、`CodeWorkspaceTab` save、WorkspaceEdit hooks、必要 IPC tests | open/closed save 共用 byte writer；race/conflict typed；Tauri temp fixture save→close→reopen 字节一致 |
| P0 | N6.2 Recursive layout lifecycle | tree/groups/ratios/active leaf 原子持久化并支持任意 leaf | recursive tree/store/persistence/`CodeWorkspaceTab` layout host/EditorGroup tests | nested split、dynamic restore、ratio resize、close/drag、shared buffer、坏快照 migration 在 browser+Tauri smoke 通过 |
| P1 | N0.2 ActionHost production wiring | keydown/Search/menu/context/keymap 只有一个执行入口 | action host/controller/commands/Search/menu/`CodeWorkspaceTab` bridge | 双 workspace 同 action ID、owner cleanup、when/context/Abort/busy、所有入口 state/result parity；不得再直接 `cmd.run` |
| P1 | N2.2 Location lifecycle + Switcher | workspace-owned 事件采集、重命名/删除/stale 和 Ctrl+Tab 闭环 | navigation controller/model、file actions、Recent Locations、Switcher/action adapter | user/programmatic 分流、双 workspace 同路径、目录 rename/delete、external stale、Windows/UNC、modifier-release/Esc QA |
| P1 | D8.2/D6.2/D7.2/D9.2 | Debug snapshot/token、action、console、layout 分别消费真实 state | 见 `debug-panel-idea-redesign.md` §19 | fake DAP stale/failed/hidden request、真实 adapter matrix、workspace layout/a11y smoke |
| Gate | N7.3 Evidence | 把每个包的证据纳入发布门禁 | `qa-ui-auto-tests/feature-list.md`、testid catalog、YAML、native/perf reports | 没有 host/QA/native/perf 证据的包最高标 `workflow-candidate` |

#### N1.2：把 StyleController 变成唯一 SaveTransaction

保留 `WorkspaceStyleController` 的 immutable provider/cache，但把 roots fingerprint 变化接到 `replaceRoots(nextRoots, generation)`；controller 的 `workspaceId` 必须校验 transaction owner。普通保存、open-clean WorkspaceEdit 和 closed-file WorkspaceEdit 都调用同一个 `writeTextSnapshot` adapter。adapter 在 LF 逻辑文本上依次执行 formatter、trim/final-newline、显式 EditorConfig EOL、charset/BOM 校验，然后只做一次 hash-guarded byte write；BOM 不能进入逻辑 buffer。

策略优先级固定为 `explicit save policy > EditorConfig > disk metadata > language/default`，写回后同步 `text/savedText/eol/encoding/bom/hash/mtime`。异步 formatter/resolve 完成后再次检查 file owner、buffer revision、style generation 和 expected hash；变化返回 typed `cancelled/conflict`，不得覆盖新编辑、伪造 hash 或静默 fallback UTF-8。测试必须覆盖 LF/CRLF/CR、UTF-8/BOM、UTF-16LE/BE、Latin-1，以及 Tauri save→close→reopen byte equality。Gate 0 先修合法多行 `.editorconfig` fixture；N1.2 不得修改 Action/Layout/Navigation。

#### N6.2：树/组/比例的单一布局状态与任意 leaf restore

持久化对象固定为 `{schemaVersion:2, tree, groupsByLeafId, activeGroupId, viewStateByLeafFile}`。`snapshotFromWorkspaceUi` 必须传入当前 tree；hydrate/migrate 一次性调用 `setLayoutTreeV2` 并按 tree preorder 恢复全部 dynamic leaf，而不是只遍历 primary/secondary。每次 reducer commit 校验 node ID、leaf/group 集合、leaf 与 group tab/active 一致性、finite positive ratios 与 sum=1；同一 fileKey 可在多个 leaf 共享 view，但 buffer/save/LSP owner 仍按 fileKey 唯一。

`PanelGroup.onLayoutChanged` 必须按 split node id 回写 normalized ratios，resize 后 debounce persistence；坏快照回退单 leaf并记录 diagnostic。修复 `replaceFileState`、rename/remove key remap、cursor/viewport/highlight/inlay/blame 等仍写死 primary/secondary 的路径。关闭 leaf 按明确 sibling policy 合并/迁移 tabs 后再删除 group；其它 leaf 仍引用 dirty/shared buffer 时不得丢弃。drag split/move cancel 不得改变 state。加入 property/fuzz、no-op reference equality、v1→v2 migration、dynamic restore、ratio round-trip、shared dirty buffer 和双 workspace 隔离测试。

#### N0.2：让 WorkspaceActionHost 成为 CodeWorkspace 唯一执行真值

在 `CodeWorkspaceTab` 创建稳定 instance host，并在 workspace/window unmount 或 visibility owner 变化时 dispose。`executeWorkspaceCommand`、capture-phase keydown、Search Everywhere、顶部/右键菜单、keymap registration、`commandRegistration.execute` 全部改为 `host.getState/execute/search`；删除生产路径直接 `cmd.run` 与 global registry execution。旧 `WorkspaceCommand` 只能作为 metadata adapter，adapter replace 用 owner token 清理旧 closure。

`execute` 捕获 owner token/context generation/payload，返回带 action id/request id 的 `applied|no-op|cancelled|failed`；Abort、hidden/unmount、provider reject 和 finally 都释放 busy。when/platform binding/chord/AltGr/focus 在 host 内判定。测试两个 workspace 同 action ID、A/B mount/unmount、旧 owner cleanup、keydown/Search/menu parity、busy double-click、Abort/when/focus；完成前不能把 global singleton 描述为 runtime truth。

#### N2.2：LocationController 生命周期与 Ctrl+Tab Switcher

生产 workspace 创建一个 `WorkspaceLocationController`，Recent Locations dialog 和 Switcher 只依赖该实例；global tracker 仅保留迁移 facade。事件源改为显式 user-edit/programmatic/navigation/tab-activate/external：只有 CodeMirror user transaction 写 edit location；formatter、WorkspaceEdit、reload、history restore 不产生 edit；成功 declaration/usage/refactor/reveal 和 tab activation 各写明确 reason，并移除 activeFileText/cursor 通用采集噪声。

canonical identity 需处理 separator、drive/UNC、平台大小写，并用 stable file identity 做 rename；目录 rename/delete 对子树 relocate/remove，cut-paste 更新 history，external watcher 冲突标 stale、实际删除标 missing。Ctrl+Tab 使用 host action：modifier-release commit、Esc cancel、A→B→A 保留 selection，workspace/window 不串历史。测试 user/programmatic 分流、双 workspace 同路径、directory rename/delete/cut-paste、external stale/missing、Unix/Windows/UNC 和关闭/恢复。

#### N7.2/N7.3：证据与合并规则

Gate 0 失败测试必须先修；任何后续 PR 若 `pnpm build`、changed-file tests 或 `git diff --check` 红，不得进入下一包。每个包同时更新 `qa-ui-auto-tests/feature-list.md`、`references/testid-catalog.md` 和至少一条 YAML control case；单测/mock 只能证明 model/component。N1 必须有 Tauri byte fixture，N6 必须有 nested restore/resize host，N0/N2 必须有双实例 UI workflow，Debug 必须有 fake DAP/真实 adapter。所有 trace 脱敏，不记录源码、变量值、表达式、完整路径或凭据。

固定合并顺序：`N7.2 Gate -> N1.2 -> N6.2 -> N0.2 -> N2.2 -> Debug §19 -> N7.3 native/perf`。`CodeWorkspaceTab.tsx` 按 save/layout/action/navigation 区域分别提交，禁止 agent 重排其它 owner 区域；没有真实 host/native 证据的包最高标 `workflow-candidate`。

### 8.10 v4.38 下一轮待办（`dab8a778` 前历史合同，当前见 §8.11）

本节是 `1b6f91cf` 后、`dab8a778` 前的执行合同，现保留用于追溯；当前执行合同见 §8.11。

| 顺序 | 子包 | 完成定义（验收要点） | 主要文件 owner |
|------|------|----------------------|----------------|
| P0 | N1.3 SaveTransaction 唯一写盘 | resolved style 不被文件元数据覆盖；open/WorkspaceEdit save 共用同一 transaction；成功 hash 来自后端；roots fingerprint 变化重建 controller；CRLF/裸 CR/BOM/Latin-1 save/reopen 字节相等（Tauri fixture） | `workspaceStyleController.ts`、`saveNormalizationPipeline.ts`、`CodeWorkspaceTab.tsx` save 区、writer IPC |
| P0 | N6.3 Layout 资源生命周期 | `replaceFileState`/rename/delete 重映射 tree+groups；close leaf 先迁移 tab 或返回 typed error 不丢 buffer；ratio 校验拒绝非正值；nested restore/resize/dirty-owner host tests | `recursiveLayoutTree.ts`、`codeWorkspaceStore.ts`、`CodeWorkspaceTab.tsx` layout 区 |
| P1 | N0.3 ActionHost 唯一执行真值 | `CodeWorkspaceTab` 的 keydown/Search Everywhere/菜单/context/keymap 全部经 instance host 执行；`WorkspaceCommand[]` 降级为纯迁移 adapter；同 ID 双 owner 恢复、Debug action bridge 接入；host dispose 不误删他实例注册 | `workspaceActionHost.ts`、`workspaceCommands.ts`、`useWorkspaceActionsController.ts`、`CodeWorkspaceTab.tsx` action 区 |
| P1 | N2.3 Locations 实例化与条目管理 | tracker 由 workspace 创建/销毁（不再 global singleton 包裹）；rename/delete 走 instance controller；目录子树 relocate/remove；dialog 支持 Delete 删除条目并同步 Back/Forward 历史（IDEA 语义）；Ctrl+Tab Switcher MRU | `navigationHistoryModel.ts`、`useWorkspaceFileActions.ts`、`RecentLocationsDialog.tsx`、`CodeWorkspaceTab.tsx` navigation 区 |
| P2 | N8 IDEA 2026.2 delta（新增） | 见下方清单；每项独立验收，不阻塞 P0/P1 | 各对应模块 |
| Gate | N7.4 证据门禁 | 每包 build + changed-file tests + host + QA YAML；N1.3 需 Tauri byte fixture；N6.3 需 nested restore host；N0.3/N2.3 需双实例 UI workflow | tests/QA only |

**N8 IDEA 2026.2 delta 清单（对照官方 What's New / Help 的新增缺口）：**

- [ ] **Recent Locations 条目删除**：popup 内 `Delete`/`Backspace` 删除选中条目，且删除后同时从 Back/Forward 导航历史移除（IDEA 官方语义）；搜索需支持 breadcrumbs 路径匹配（当前仅 symbolName/path/text/snippet）。
- [ ] **Dependency completion**：构建文件依赖坐标补全（2026.2 新增）。**已确认范围：Maven（pom.xml）与 Gradle（build.gradle Groovy / build.gradle.kts Kotlin DSL）必须支持**；其它生态（npm/cargo/go mod 等）**显式延期**，Maven/Gradle 落地并证明 provider 接口可复用后再单独立项。
  - Provider contract：`DependencyCompletionProvider { supports(file), complete(context) -> items }`，capability 状态机 `available|unavailable|error`；无 provider 时 UI 永不展示该能力，也不得声称支持。
  - 验收矩阵：`pom.xml` 中 `<groupId>/<artifactId>/<version>` 三处游标上下文；`build.gradle`/`build.gradle.kts` 中 `implementation("g:a:v")` 等坐标字符串上下文；插入/替换行为、取消、超时与错误路径均返回 typed 结果。
  - 数据来源：Maven Central 仓库索引经构建文件 LSP（lemminx/gradle-language-server 等）提供，先调研选定 provider 再实现；fixtures 至少三种文件类型各一个 golden case。
- [ ] **Smooth caret animation 与新 selection 行为**（2026 平台编辑器改进）：作为可选 polish 记录，需 `prefers-reduced-motion` 下自动禁用；不进入本轮 P0/P1。
- [ ] **Logpoints / runtime output→source**：模型已具备 `logMessage` 与 gutter diamond；插值求值证据、Console 源码超链接属 Debug 范围，验收见 `debug-panel-idea-redesign.md` §20 D11。
- [ ] ~~**Git 冲突解决流**（2026.2 改进）~~：**已确认不纳入本次范围**（用户决策 2026-08-19）；保留登记仅作 X 轨道未来对照。

**合并顺序。** `N1.3 -> N6.3` 先行（数据正确性），`N0.3` 与 `N2.3` 可并行但分别只改 action/navigation 区域；`N8` 各条目在对应 owner 包冻结后独立成 PR；`N7.4` 随包执行。任何 PR 若 `tsc -b`、changed-file tests 或 `git diff --check` 红，不得进入下一包。

### 8.11 v4.39 待办（`b4e7325f` 前历史合同，当前见 §8.12）

本节取代 §8.10，现保留用于追溯；其执行结果的复核见 §2.17，当前执行合同见 §8.12。每个包必须修复生产调用链并提供失败路径证据；禁止用“class/type/test 已存在”替代 host consumer、真实 writer/provider 或跨实例工作流。

| 顺序 | 子包 | 完成定义（验收要点） | 主要 owner |
|------|------|----------------------|------------|
| P0 | N1.4 防止 stale save 覆盖 | buffer 使用单调递增 document revision 或 content identity，任何异步 format/normalize 后 revision 不同均返回 conflict、零落盘；open buffer 与所有 WorkspaceEdit open/closed writer 经同一 SaveTransaction；成功 hash 只认后端；同长度修改 race 测试 + CRLF/CR/BOM/Latin-1 Tauri save/reopen fixture | save 区、style controller、WorkspaceEdit writer、IPC fixture |
| P0 | N6.4 Tree/group 原子 ownership | close leaf 迁移 tab 时同步 destination leaf 的 `openFileKeys/activeKey`；mutation 返回前执行 tree/groups 双向一致性校验；不一致 snapshot 拒绝持久化并 diagnostic。语义固定为**一个 canonical buffer 可被多个 leaf view 引用**：close/remap 必须保留所有其它 leaf 引用，不得为追求“单 owner”关闭合法 view；覆盖 nested split → 同 buffer 多 view + dirty tabs → close → reload、resource rename/delete | recursive tree、workspace store、layout persistence/host |
| P0 | N0.4 ActionHost 唯一执行入口 | CodeWorkspaceTab keydown/Search/menu/context/keymap 全部调用 instance host；adapter await `cmd.run` 并把 thrown/rejected/cancelled/no-op 映射为 typed result；旧数组只负责 migration metadata。cleanup 只能删除自己安装的 command adapter，绝不能删除同 ID 后注册的独立 action；覆盖 same-ID register/replace/unregister 顺序、双 workspace owner restore、unmount、AbortSignal、async reject | action host/controller、workspace commands、CodeWorkspaceTab action 区 |
| P1 | N2.4 单一 Location owner 与双历史删除 | `useWorkspaceFileActions` 注入当前 controller，禁止 production global tracker；rename/delete/cut-paste 对 file/directory subtree 更新同一 instance；Delete 同时删除 Recent Locations 与 Back/Forward entry；Ctrl+Tab modifier-release commit/Esc cancel；双 workspace 同路径与 Windows/UNC tests | location controller、file actions、Recent dialog、navigation history/Switcher |
| P1 | N8.1 Maven/Gradle provider 真接线 | 候选真值固定为 **Maven Central Search API，经 Tauri/backend `DependencyIndexClient` 代理与有界缓存**；build-file LSP 只辅助 syntax context，不作为候选真值。capability 来自 backend/provider lifecycle，不得常量 available；`complete(context, signal)` 返回 typed available/unavailable/error/cancelled/timeout + replacement range/requestId；单次请求 deadline 3s，timeout 后至多一次显式 Retry、不得回退硬编码 popular list。CodeMirror host 覆盖 pom.xml 的 groupId/artifactId/version、Groovy/Kotlin DSL 坐标，五类 golden replacement case；离线/无 provider 不展示支持，error/timeout 给可重试提示 | dependency provider、backend IPC/index client、completion host、golden/QA fixtures |
| Gate | N7.5 真实证据 | `tsc -b`、changed-file tests、`git diff --check` 为基础；N1 必须 Tauri bytes/race，N6 nested reload，N0/N2 双实例 UI，N8 real provider + no-provider QA；提交中逐项标明最高证据等级 | tests/QA/evidence only |

**合并顺序。** `N1.4 -> N6.4` 先阻断数据损坏；`N0.4` 与 `N2.4` 在 owner 边界明确后并行；`N8.1` 独立于 P0，但不得在真实 provider 接入前宣传 Maven/Gradle 支持；`N7.5` 随包交付。Debug 先修错误导航，再处理 token/action/console/layout，见 Debug §21。

### 8.12 v4.40 待办（`5ce13c9a` 前历史合同，当前见 §8.13）

> 历史状态（`5ce13c9a` 复核结论，明细见 §2.19）：Gate R0 已解除红测阻断（`wired/partial`，残留项转 Gate R1）；N1.5 / N6.5 `wired/partial`（各含 1 条 P0 级残留，转 N1.6 / N6.6）；N0.5 / N2.5 仍 `model only`（转 N0.6 / N2.6）；N8.2 后端 workflow、前端 model（转 N8.3）；N7.6 仅单测（转 N7.7）。以下正文保留为需求输入，**不再作为执行顺序**；其中未被 §8.13 显式改写的设计条款继续有效。

本节曾取代 §8.11。**Gate R0 是硬阻断**：在 3 个红测转绿前，不允许提交任何新增能力 PR（包括 N9/N10/N11）。每个包必须在 PR 描述里逐条标明达到的最高等级（`model`/`wired`/`workflow`/`verified`），并列出运行过的命令与结果；“类型/函数/单测已存在” 不是完成证据，必须给出生产 owner 的调用链。

| 顺序 | 子包 | 完成定义（验收要点） | 主要 owner |
|------|------|----------------------|------------|
| **Gate R0** | Action context 回归修复 | 恢复基于事件目标/焦点的 focus 解析；`getState` 与 `execute` 共用同一个 context 构造；调用方结构化参数在 when 与 run 中都可见；`CodeWorkspaceTab.test.tsx` 3 个红测转绿并新增焦点/payload 矩阵测试 | `useWorkspaceActionsController.ts`、`workspaceActionHost.ts`、`CodeWorkspaceTab.tsx` action 区 |
| P0 | N1.5 单一写盘与 revision 不变量 | 所有 buffer 文本突变经唯一 mutate helper 并单调 +1（含 reload/编码 reload/WorkspaceEdit/undo replay）；写盘回填不得回退 revision；open buffer / open-clean WorkspaceEdit / closed-file WorkspaceEdit 共用一个 `writeTextSnapshot`；hash 冲突走结构化错误而非字符串嗅探；hash 缺失即 `failed`，不合成 | `workspaceStyleController.ts`、`saveNormalizationPipeline.ts`、`CodeWorkspaceTab.tsx` save 区、workspace writer IPC |
| P0 | N6.5 布局不变量与 sibling 策略 | 每次 layout mutation 与每次持久化前执行 `validateLayoutTree` + `validateTreeGroupConsistency`，失败丢弃 mutation 并 diagnostic；close leaf 迁移到真实相邻兄弟、destination group 缺失时先创建、绝不静默丢 tab；hydrate 清 orphan group、修 divergent group、坏快照降级为单 leaf | `recursiveLayoutTree.ts`、`codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`CodeWorkspaceTab.tsx` layout 区 |
| P1 | N0.5 keymap 真值与 action state | keymap scheme 成为绑定唯一真值（`WorkspaceCommand.keybinding` 仅作一次性默认导入）；只保留一份 keydown 匹配实现；Search Everywhere/菜单/cheatsheet 取 host 列表与 `ActionState`；`host.dispose()` 接生命周期；Debug action descriptor 经同一 host | `keymapModel.ts`、`workspaceActionHost.ts`、`useWorkspaceActionsController.ts`、Search/菜单入口 |
| P1 | N2.5 双历史一致与 Switcher | Recent Locations 与 Back/Forward 共享 location identity，Delete/rename/delete/cut-paste 同步两侧；canonical path 单点实现（分隔符/UNC/大小写/symlink）；Ctrl+Tab MRU Switcher（modifier-release commit、Esc cancel、反向、A→B→A 保留选择）为 host action | `navigationHistoryModel.ts`、`useWorkspaceNavigation.ts`、`useWorkspaceFileActions.ts`、`RecentLocationsDialog.tsx`、新 Switcher 组件 |
| P1 | N8.2 依赖补全真接线 | 新增后端依赖索引命令（走应用 proxy + 有界缓存）作为唯一候选真值；版本用 gav 专用查询，禁止 `tags`；capability 由后端探测驱动；CodeMirror completion source 接 pom.xml / build.gradle(.kts)，item 带 replacement range；离线/无 provider 不展示能力 | `src-tauri/src/dependency_index.rs`（新增）、`lib.rs` 注册、`dependencyCompletion.ts`、completion host |
| P2 | N9.1–N9.4 编辑效率对照 | 见下方设计：Find/Replace bar、Find in Files 作用域、剪贴板工作流、Completion 设置面 | 编辑器 chrome、搜索面板、设置 |
| P2 | N10.1–N10.3 代码洞察呈现 | 见下方设计：rendered doc comments、per-file 高亮级别 + inspection widget、编辑器 banner | 文档/诊断/chrome |
| P2 | N11.1–N11.4 文件与视图工作流 | 见下方设计：文件模板、Open in Right Split 与 tab 策略、助记书签、编辑器内 compare | 文件树/布局/书签/diff 视图 |
| Gate | N7.6 证据门禁 | 每包：`tsc -b` + 改动文件相关测试 + host 级测试 + QA catalog/YAML；N1.5 需 Tauri 字节 fixture 与同长度 race；N6.5 需 nested reload host；R0/N0.5/N2.5 需双实例 UI；N8.2 需真实 provider 与 no-provider 两条 QA | tests / QA / evidence only |

#### Gate R0：Action context 单一真值与焦点语义（P0 阻断）

**故障模型（必须先复现）。** 当前 `useWorkspaceActionsController` 以常量 `activeFocus:"workspace"` 建 context，`WorkspaceActionHost.execute` 又用 `getContext()` 重建 context 并只把调用方参数放进 `payload` 字段。于是：(a) `when: ctx.focus === "editor" | "tree"` 恒 false；(b) `ctx.rootId/path/selection` 不可见，命令即使执行也拿不到参数；(c) `getState`（菜单/按钮 enabled）与 `execute`（真正的 when 再判定）用两套 context，出现“可点但无效”。

**设计。**

1. **焦点解析回归。** 在 `CodeWorkspaceTab` 恢复等价于旧 `commandFocusForTarget` 的纯函数并交给 controller：`resolveFocus(target) → "terminal" | "tree" | "editor" | "workspace"`，判定顺序为 `[data-workspace-focus="terminal"]` → `treePaneRef.contains` → `editorPaneRef.contains` → `workspace`。controller 接受 `resolveFocus` 与 `getDefaultFocus()` 两个注入项，禁止再写死字符串。
2. **context 单一构造。** host 暴露 `buildContext(invocation?: ActionInvocation): WorkspaceActionContext`，`ActionInvocation = { context?: Partial<WorkspaceActionContext>; payload?: unknown; eventTarget?: EventTarget | null; signal?: AbortSignal }`。优先级固定为 `invocation.context 显式字段 > eventTarget 推导 > host 默认 context`；`payload` 同时保留在 `ctx.payload`。`getState`、`execute`、`dispatchKeydown`、`search`、`getMenuItems` 全部只能通过 `buildContext` 取 ctx，且 `execute` 必须复用调用方已构造的同一个 ctx 对象（一次构造、一次判定、一次执行）。
3. **参数契约二选一并固定。** 先 `rg 'context\.(payload|rootId|path|selection)' src/components/editor` 全量确认既有 run 实现的读取方式；**推荐统一为 `ctx.payload`**（现有 12 处已是这种写法），并在 adapter 中对“顶层读取旧字段”的命令做一次性迁移；迁移后在开发模式对 `ctx` 上出现的非白名单顶层字段发 warning，避免再次分叉。
4. **单一 keydown 实现。** 删除 controller 内的匹配循环，改为 `host.dispatchKeydown(event, { eventTarget: event.target })`；host 匹配后必须再跑 when，返回 `{ id, result }`；未命中不得 `preventDefault`。同一按键多命中的裁决顺序固定为：显式注册 action binding > command adapter binding > 注册顺序，并在开发模式记录冲突 diagnostic（对应 §9 “快捷键冲突” 与新增 “Action context 分叉” 风险行）。
5. **typed result 贯通。** `executeCommand` 返回 `Promise<ActionResult>`；为兼容 `workspaceCommandRunnerRef` 保留一个 `runCommand(): void` 包装。`no-op`/`cancelled`/`failed` 必须转成 status 文案或 disabled 原因，禁止静默；`failed` 需带 action id。
6. **生命周期。** controller 在 unmount 或 `workspaceId` 变化时 `host.dispose()`；dispose 后 `execute` 返回 `failed("host disposed")` 而非抛错；`onCommandExecuted` 若由调用方内联传入必须 memo，否则 host 会因 `useMemo` 依赖变化被重建（当前虽未触发，但要在类型层挡住）。

**验收矩阵。**

- 现存 3 个红测转绿：`opens call and type hierarchy from capability-gated shortcuts`、`offers tree context menu actions: copy path and scoped search`、`scans open-file TODOs and toggles persistent bookmarks with F11`。
- 新增焦点矩阵：4 个 editor-only 命令（Shift+F6 / Ctrl+Alt+H / Ctrl+H / F11）在 tree 焦点下 `disabled`、在 editor 焦点下执行；7 个 tree-gated 命令在 tree 焦点下执行且 handler 收到 `{rootId, path}`（含 `addFolder`/`newFile` 等虽无 focus 判定但读 payload 的命令）；`workspace.format` 在 tree/terminal 焦点下必须 `disabled`（当前被常量 focus 永久放行）；terminal dock 焦点时 editor 命令不触发（保护 `data-workspace-focus="terminal"`）。
- 新增入口一致性：同一命令经 toolbar、右键菜单、Search Everywhere、快捷键四条路径得到相同 `ActionState` 与 `ActionResult`。
- 新增隔离：两个 workspace 同 action ID 各自执行自己的 handler；A/B mount→unmount→mount 后旧 host `execute` 返回 `failed`；`busy` 期间二次触发返回 `no-op`；`AbortSignal` 取消返回 `cancelled`。
- 禁止范围：本 Gate 只改 action 区域，不得同时动 save/layout/navigation 区域。

#### N1.5：唯一写盘路径与 document revision 不变量

**不变量（先写测试再改实现）。** ①`documentRevision` 对同一 fileKey 单调不减，且仅在 `text` 实际变化时 +1；②任何一次成功写盘后，`savedText` 必须等于写入磁盘的逻辑文本，`dirty === (text !== savedText)`；③`hash/mtime/encoding/bom/eol` 只能来自后端返回值。

**设计。**

1. **唯一 mutate 入口。** 新增 `mutateOpenBuffer(key, patch, reason: "user-edit" | "programmatic" | "reload" | "workspace-edit" | "save-writeback" | "history-replay")`，内部负责 revision 递增（`save-writeback` 例外：必须显式携带 `documentRevision: latest.documentRevision`，即**保留**最新值而不是回填快照值）、`pendingEditorTextByFileRef` 合并、`dirty` 计算与 semantic invalidate。把 `updateFileText`、`queueEditorTextUpdate`、`reloadFile`、编码 reload、`saveOpenBufferText` 回填、外部变更 reload、WorkspaceEdit apply、事务 undo replay 全部改为经它，`openFilesRef.current` 不再在这些路径上被就地覆盖。
2. **统一 writer。** 抽 `writeTextSnapshot(request): Promise<WriteOutcome>`，`request = { fileKey?: string; filePath: string; logicalText: string /* 始终 LF、不含 BOM */; expectedDiskHash: string | null; policy: { eol; encoding; bom }; bufferVersion?: number; styleGeneration: number }`。open buffer save、open-clean WorkspaceEdit（`saveOpenBuffer`）与 closed-file WorkspaceEdit（`writeDisk`）三条路径必须调用它；EOL/charset/BOM 只在此处一次施加，`policy` 由 `WorkspaceStyleController` 解析（优先级仍为 `explicit override > EditorConfig > disk metadata > language/default`）。
3. **结构化冲突。** 后端 `workspace_write_file{,_encoded}` 与 loose 变体在 hash 失配时返回可判别错误（推荐 `Err` 载荷加 `kind: "hash-mismatch"` 前缀或改为 `Result<WorkspaceFile, WorkspaceWriteError>`），前端 ipc 层解析成 `{ kind: "hash-mismatch", expected, actual }`；`executeSaveTransaction` 用 `kind` 判定 `conflict`，**删除** `message.includes("conflict"|"hash mismatch")` 嗅探。写盘成功但未返回 hash 时返回 `failed("writer returned no hash")`，删除 `hash-${Date.now()}-…` 合成分支。
4. **race 关闭。** 最终 guard 之后到 writer 之间不得再有 await；writer 返回后再次比较 `documentRevision` 与 `styleGeneration`：若已变化，仍写入（磁盘已改）但回填只更新 `savedText/hash/mtime/encoding/bom` 并保持 `dirty=true`，状态栏提示 “已保存旧快照，缓冲区仍有更新”。

**验收矩阵。** 同长度并发编辑（保存期间把 `abcd` 改成 `abce`）→ `cancelled` 且零落盘；保存期间输入 → revision 不回退、`dirty` 仍为 true；reload/编码 reload 期间的 in-flight save → `cancelled`；Tauri 临时目录字节 fixture：LF/CRLF/裸 CR × UTF-8 / UTF-8+BOM / UTF-16LE / UTF-16BE / Latin-1 的 save→close→reopen 字节相等；磁盘被外部改动 → `conflict` 且进入既有恢复入口；closed-file WorkspaceEdit 对 CRLF 文件写入后不产生混合换行。

#### N6.5：布局不变量、sibling 策略与快照修复

**设计。**

1. **提交闸门。** 在 store 内加 `commitLayoutMutation(current, result)`：仅当 `result.kind === "changed"` 时，先跑 `validateLayoutTree(result.tree)` 与 `validateTreeGroupConsistency(result.tree, result.groups)`，任一失败则**丢弃整个 mutation**、保留旧 state、记录 `layoutDiagnostics`（开发模式 `throw`，生产模式 status + 日志）。`splitLayoutLeaf/closeLayoutLeaf/moveLayoutTab/setLeafActiveTab/closeTabInLeaf/setLayoutNodeRatios/replaceFileState` 全部经它，禁止再直接 `set({ layoutTreeV2, editorGroups })`。持久化前（`snapshotFromWorkspaceUi`）再校验一次，不一致则拒绝写入并保留上一份好快照。
2. **sibling 迁移策略。** `atomicCloseLeaf` 的目标改为：沿被关 leaf 的父 split 取相邻兄弟（同级 index+1 优先，否则 index-1）；兄弟为 split 时取其 preorder 首个 leaf。destination group 不存在时先按 leaf 内容创建再迁移。返回值扩展为 `{ kind:"changed", tree, groups, activeGroupId, migration: { destinationLeafId, migratedKeys } }`，UI 用它提示 “N 个标签已移动到相邻分屏”。任何情况下不得丢 tab；无法确定目标时返回 `no-op` 并给出 reason。
3. **多 view 语义固定。** 一个 canonical buffer 可被多个 leaf view 引用；close leaf 只销毁 view，`openFiles` 中的 buffer 仅在**最后一个** view 关闭时才走 dirty 提示/关闭流程。`replaceFileState`、cursor/viewport/highlight/inlay/blame 等仍按 `primary/secondary` 假设的路径改为按 leafId 索引。
4. **快照修复与降级。** `normalizeWorkspaceLayoutSnapshot`：删除无对应 leaf 的 group；以 tree leaf 为准修正 `openOrder/activeKey`（`previewKey/pinnedKeys` 取交集）；`activeKey` 必须属于 `openOrder`，否则置 null；仅当 v2 tree 缺失时才补 `primary/secondary`；tree 不可修复时降级为单 leaf 并置 `layoutRecovered: true`（UI 一次性提示）。

**验收矩阵。** 三 leaf 水平分屏关闭中间 leaf → tab 进入右侧兄弟且 tree/group 一致；关闭含 dirty tab 的 leaf → buffer 不丢、dirty 标记保留；同一文件在两个 leaf 打开后关闭其一 → 另一 view 正常；注入 divergent 快照（group 多 key / activeKey 不在 openOrder / ratio 为 0 / leaf 缺 group）→ 拒绝或降级且不崩；nested 布局 reload 后全部 dynamic leaf 恢复、ratio 往返一致；property/fuzz：随机 200 次 mutation 序列后不变量恒成立、no-op 返回引用相等。

#### N0.5：keymap 成为绑定真值与 action state 可见

前置：Gate R0 已合并。本包把“执行真值”推进到“绑定与状态真值”。

1. **绑定真值。** `keymapModel` 提供 `KeymapScheme { id, base: "idea"|"custom", bindings: Record<actionId, ActionPlatformKeybindings> }` 与 `resolveBinding(actionId, platform)`。host 只从 `registry(action) + scheme` 取绑定；`WorkspaceCommand.keybinding` 仅在首次迁移时导入为 IDEA 默认 scheme 的内容，之后不再参与 dispatch。scheme 持久化到 workspace 设置并支持 copy/rename/reset/delete 与 import/export（先 JSON，preset 内容不阻塞首批）。
2. **冲突与可发现性。** 提供 `findConflicts(scheme)`：同 (platform, chord) 多 action 视为冲突，设置页与 cheatsheet 展示冲突并允许移除其中一个绑定；未绑定 action 也必须在 Search Everywhere 可执行。
3. **状态可见。** 菜单、Search Everywhere、cheatsheet、toolbar 统一读 `getActionState`：`disabled` 必须给 `disabledReason`（`capability`/`busy`/`focus`/`unsupported`）并作为 tooltip；`unsupported` 项默认隐藏而不是灰显（与 §5.2.0 capability 驱动一致）。Search Everywhere 的列表来源改为 `host.search(query, ctx)`，删除 `searchableWorkspaceCommands`。
4. **Debug bridge。** `debugActionService` 的 descriptor 注册进同一 host（`category: "Debug"`，capability 由 DAP session 提供），Toolbar/Frames/editor chrome 改为经 host 执行；与 Debug 文档 §21 D6 保持同一 descriptor 定义，避免第二份 action 真值。
5. **验收。** 修改 scheme 后快捷键立即改变且重启保留；冲突可检出与解决；平台差异（Cmd/Ctrl、AltGr）按 platform 字段解析；两个 workspace 使用不同 scheme 不互相污染；cheatsheet 不再出现 orphan/别名不一致条目（沿用 §2.9 的 ID 对账清单）。

#### N2.5：Location identity、双历史一致与 Ctrl+Tab Switcher

1. **共享 identity。** 定义 `LocationIdentity { fileKey: string | null; canonicalPath: string; line: number; character: number }`。`WorkspaceLocationController`（Recent Locations）与 `useWorkspaceNavigation`（Back/Forward）都以它为主键；新增 `NavigationHistoryFacade`，暴露 `remove(identity)`、`relocate(from, to)`、`removeSubtree(dirPath)`，dialog 的 Delete 调用 facade 一次性删除两侧条目（IDEA 2026.2 语义）。删除 global tracker 的 production fallback，`navigationHistoryTracker` 仅保留为迁移 facade 并标注 deprecated。
2. **canonical path 单点。** `canonicalizeWorkspacePath(path, platform)`：统一分隔符、Windows 盘符大写、UNC 前缀保留、平台大小写折叠（macOS/Windows 折叠、Linux 不折叠）、可选后端 `realpath` 解 symlink（结果缓存并随 watcher 失效）。rename/delete/cut-paste 与 external watcher 全部经它比较，禁止再用 `endsWith` 猜路径。
3. **Switcher。** `Ctrl+Tab` / `Ctrl+Shift+Tab` 作为 host action：MRU 列表（编辑器 tab 优先，其后工具窗），持续按住 Ctrl 时循环、松开 commit、`Esc` 取消并恢复原 tab、A→B→A 后列表顺序稳定；实现为受控弹层，不直接 `window.addEventListener`，避免与 R0 的单一 keydown 通道冲突。
4. **状态语义。** 条目状态 `current | stale | missing | relocated`：external watcher 报告内容变化标 stale（行号可能失配），删除标 missing 并在打开时提示，rename 标 relocated 并更新路径。
5. **验收。** 双 workspace 同路径互不串；Windows 盘符/UNC/大小写-only rename；目录 rename/delete 子树；cut-paste；Delete 后 Back/Forward 同步；Switcher 键序（含 modifier-release、Esc、反向、连续切换）；dialog 的 `Show edited only` 与 breadcrumbs 搜索在 relocate 后仍可命中。

#### N8.2：Maven/Gradle 依赖补全的真实数据链路与 host 接线

1. **后端索引命令（新增，唯一候选真值）。** `src-tauri/src/dependency_index.rs` 暴露三条命令：
   - `dependency_index_status() -> { kind: "available" | "unavailable" | "error", reason?: string }`（探测网络/代理可用性，结果带短 TTL 缓存）；
   - `dependency_index_search({ query, kind: "group" | "artifact", limit }) -> Vec<DependencyCoordinate>`；
   - `dependency_index_versions({ groupId, artifactId, limit }) -> Vec<DependencyVersion>`，实现使用 Maven Central 的 `core=gav` 查询（`q=g:"…" AND a:"…"&core=gav&rows=…&sort=timestamp desc`），**禁止把 solr `tags` 当版本**。
   请求统一走 reqwest + 应用 proxy 设置与超时（单请求 3s deadline），带有界 LRU + TTL 缓存；前端不得再直接 `fetch` 外部主机（同时避免 CSP/代理绕过）。
2. **provider 重构。** `dependencyCompletion.ts` 的 `MavenCentralDependencyIndexClient` 改为 `BackendDependencyIndexClient`（invoke 上述命令）；`InMemoryDependencyIndexClient` 仅保留给测试与 fixture，**不得**作为生产回退（离线时 capability 转 `unavailable`，UI 不展示能力，也不提示“支持”）。`capabilityState` 初始为 `unknown`，只由 status 命令与请求结果驱动。
3. **item 契约。** `DependencyCompletionItem` 增加 `replacementRange: { from: number; to: number }`（相对文档偏移）与 `requestId`；插入只替换坐标片段（pom 的元素文本节点、Groovy/Kotlin 的字符串字面量内片段），不破坏引号与括号。
4. **host 接线。** 在 CodeMirror completion 源中注册：`pom.xml` 的 `<groupId>/<artifactId>/<version>` 三个上下文；`build.gradle` Groovy `implementation 'g:a:v'` / `implementation group: …`；`build.gradle.kts` `implementation("g:a:v")`。请求 generation 取消旧请求；`timeout` 后仅允许一次显式 “Retry” 动作（不自动重试、不回退硬编码列表）；`error` 显示可重试提示与来源标注。
5. **验收。** 五类 golden replacement case（pom 三处 + Groovy + Kotlin）；取消/超时/错误/无 provider/离线各一条 typed 结果测试；QA 至少两条：真实 provider 命中与 no-provider 时能力不可见；生态范围仍固定 Maven/Gradle，npm/cargo/go 沿用 §8.10 的延期决策。

#### N9：编辑效率对照（P2，四个可独立交付的小包）

- **N9.1 IDEA 对照 Find/Replace bar。** 用自绘查找条替换 CodeMirror stock 面板：Match case / Whole word / Regex / **Preserve case** 替换、作用域切换（整文件 / 选区）、过滤（In comments / In string literals / Except comments，基于现有 `syntaxContext.ts` 的 Lezer 节点判定，语言不支持时禁用并说明）、`Select All Occurrences`（复用多光标）、匹配计数与 `Enter/Shift+Enter` 循环、多行输入（Shift+Enter 换行）。失败语义：非法正则内联报错且不改文本；Replace All 一次 undo。
- **N9.2 Find in Files 作用域模型。** `SearchScope = { kind: "project" | "roots" | "directory" | "openFiles" | "recentlyViewed" | "custom"; roots?; directory?; includeGlobs; excludeGlobs }`，持久化最近使用的 scope；结果面板支持逐项复选排除后再 Replace（复用 `RefactoringPreviewDialog` 的 exclude 交互与事务 undo）；支持结果 tab pin（至少 2 个并存）；大结果集保持流式 + 上限截断提示。
- **N9.3 剪贴板工作流。** 新增有界 clipboard history（默认 20 条、纯内存、workspace 级、不落盘；隐私策略写入设置说明）：`Paste from History` 弹层、`Paste as Plain Text`、`Copy Reference`（生成 `path:line` 或 `FQN#member`，Java 优先用 LSP symbol）、多光标复制/粘贴按 caret 分发（caret 数与剪贴板段数相等时逐段分发，否则整段粘贴到每个 caret）。
- **N9.4 Completion 设置面。** 把 80ms debounce / 200 cap / autopopup 开关 / match case / 排序（relevance | alphabetical）/ 自动展示文档 / “insert by space or dot” 提升为可持久化设置（workspace 级 + 语言覆盖），设置项与现有性能护栏语义在文档中同步说明（§10 第 12 条）；truncation 与 provider 不可用状态在 popup 里显式展示。

#### N10：代码洞察呈现（P2）

- **N10.1 Rendered doc comments。** 编辑器内渲染 Javadoc/JSDoc/docstring：折叠原文并渲染标题/参数/返回/链接（复用 `MarkdownPreview` 的渲染栈与 sanitizer），提供 `Toggle Rendered View` action、per-language 默认值、点击链接跳转 declaration；另加 “Show quick doc on hover” 设置（默认关，避免与 diagnostics tooltip 抢位）。
- **N10.2 逐文件高亮级别 + inspection widget。** 编辑器右上 widget：错误/警告/弱警告计数、上一个/下一个问题、当前 inspection profile 名与切换入口、`Highlighting level`（None / Syntax / All Problems）逐文件生效并随 tab 记忆（不持久化跨会话，避免用户忘记自己关掉了分析）；level 变化必须真实抑制装饰与 pull diagnostics 请求，而不只是隐藏 UI。
- **N10.3 编辑器 banner。** 统一 `EditorBanner { severity, message, actions[], dismissible, id }` 栈：read-only / library source、编码或 EOL 与 EditorConfig 不一致、LSP 未就绪或已崩溃（带 Restart）、SDK/JDK 缺失（带打开设置）、外部变更待处理（带 Reload/Compare）。banner 不得替代 status message 的瞬时提示，只承载“需要用户决定”的持续状态；每条 banner 需 testid 并进入 QA catalog。

#### N11：文件与视图工作流（P2）

- **N11.1 File and Code Templates。** 模板模型 `FileTemplate { id, name, language, extension, body, variables }`，变量集固定为 `${NAME}`、`${PACKAGE_NAME}`、`${DATE}`、`${TIME}`、`${USER}`、`${PROJECT_NAME}`（不引入完整 Velocity）；内置 Java Class/Interface/Enum/Record、TS/TSX、Python、Go、Rust、Markdown；可选文件头（版权）模板按语言注释风格注入。文件树 New 菜单按语言分组展示；`${PACKAGE_NAME}` 由 source root 相对路径推导（无 source root 时留空并提示）。落盘经既有 create + `workspace/willCreateFiles` 链路，创建后打开并把光标置于第一个 `${CURSOR}` 位置。
- **N11.2 Open in Right Split 与 tab 策略。** Search Everywhere / 文件树 / Recent Files 支持 `Shift+Enter` 在相邻（不存在则新建）右侧 leaf 打开，复用 N6.5 的 sibling 语义；tab 策略设置：最大 tab 数（超出按 LRU 关闭未 pin/未 dirty 的 tab 并提示）、关闭后激活策略（左侧 / 最近使用）、`Open new tabs at the end of the list`；tab 拖拽到 leaf 边缘触发 split（拖拽取消不得改 state，见 §8.9 N6.2 遗留要求）。
- **N11.3 助记书签。** `Bookmark { id, identity: LocationIdentity, mnemonic?: string /* 0-9 A-Z */, listId }`：`Ctrl+F11` 选择助记、`Ctrl+<digit>` 跳转、Bookmarks 面板按 list 分组与重命名，持久化到工作区（与 N2.5 的 canonical identity 共用 relocate/missing 语义）。现有布尔书签自动迁移为默认 list 且无助记。
- **N11.4 编辑器内 Compare。** 只做视图层：`Compare with Clipboard`、`Compare with File…`、`Compare with Local History revision`、对选区 diff；实现复用现有 git diff 渲染组件（行内/并排、逐块导航、只读左侧、可编辑右侧仅当目标是当前 buffer）。明确不做 Git 客户端能力（分支比较、冲突解决仍属 X 轨道，见 §8.10 的既有决策）。

#### N7.6：证据门禁与合并顺序

**门禁。** 每个 PR 必须给出：`pnpm exec tsc -b` 结果；改动文件相关的 vitest 命令与通过数；**至少一条 host 级（组件挂载）测试**证明生产入口可达；`qa-ui-auto-tests/feature-list.md` + `references/testid-catalog.md` + 至少一条 YAML control case 的同步更新。红测（含既有失败用例）一律阻断合并——本轮已出现“红测随功能一起合并”的情况，后续必须在 PR 描述中贴出定向命令输出。N1.5 必须附 Tauri 字节 fixture 与同长度 race 用例；N6.5 必须附 nested reload/resize host 用例；R0/N0.5/N2.5 必须附双实例 UI 用例；N8.2 必须附真实 provider 与 no-provider 两条 QA。所有 trace 脱敏：不记录源码、变量值、表达式、完整路径或凭据。

**合并顺序（固定）。** `Gate R0 → N1.5 → N6.5 → (N0.5 ∥ N2.5) → N8.2 → N9.x → N10.x → N11.x`。`CodeWorkspaceTab.tsx` 仍按 save / layout / action / navigation 四个区域分别提交，agent 不得重排其它 owner 区域；N9–N11 的每个子项独立成 PR，且在对应 owner 包（R0/N1.5/N6.5）冻结后才允许开工。Debug 侧顺序不变，见 `debug-panel-idea-redesign.md` §21：先修错误导航，再 token/action/console/layout。

### 8.13 v4.41 历史下一轮待办（`5ce13c9a` 复核后；当前合同见 §8.20）

本节曾取代 §8.12；`d641ad12` 的实际结果与后续编辑器提交已由后续章节重新审计，当前执行顺序和完成定义统一以 §2.30/§8.20 为准。本节保留未完成包的原始需求输入，不能再用其“P0-A 已提交”推导 N1.6 已完成。

**通用交付协议（每个 PR 必须满足，违反即退回）**

1. **一包一提交。** 只改本包 owner 文件；`CodeWorkspaceTab.tsx` 继续按 `save / layout / action / navigation` 四区分离，不得顺手重排其它区域。Rust 侧只对本包改动文件执行 `rustfmt --edition 2024 <file>`，**禁止项目级 `cargo fmt`**（`c5ce1fd6` 的 123 文件 import 重排是反例）。
2. **等级自证。** PR 描述按 §2.4 标明 `model`/`wired`/`workflow`/`verified` 的最高等级，并贴出**生产调用链**（从用户入口到 owner 函数的文件:行）。“类型/函数/单测已存在”不算完成。
3. **先写测试再改实现。** 每条不变量先落一个失败用例；PR 必须包含至少一条 **host 级（组件挂载）** 测试证明生产入口可达。
4. **红测阻断。** 贴出定向 `npx vitest run <files>` 输出与通过数、`pnpm exec tsc -b` 结果、`git diff --check`。任何既有红测未修复即禁止合并。
5. **QA 同步。** 新增/改变的用户可见入口必须同步 `qa-ui-auto-tests/feature-list.md` + `references/testid-catalog.md`，并至少补一条 YAML control case（本轮两次提交均漏此项）。
6. **不得用删除机制换绿灯。** 修 StrictMode/生命周期问题时，禁止删除 dispose/cleanup 一类正确性机制；必须给出可自愈的生命周期设计。

| 顺序 | 子包 | 完成定义（验收要点） | 主要 owner |
|------|------|----------------------|------------|
| **P0-A** | N1.6 写盘字节正确性 | closed-file WorkspaceEdit 使用 applier 传入的 `diskEol`；`saveOpenBufferText` 不再直接覆写 `openFilesRef`；save 端解析带 `explicitOverride`；最终 guard 到写盘之间零 await；hash 冲突走 typed 判别 | `CodeWorkspaceTab.tsx` save 区、`workspaceStyleController.ts`、`workspaceEditApply.ts`、`src/lib/ipc.ts`、`src-tauri/src/workspace.rs` |
| **P0-B** | Gate R1 Action host 收口 | host 生命周期可自愈且 workspace 切换真释放；typed result 有接收方并转状态栏/disabled 原因；Search Everywhere / cheatsheet / 菜单统一取 host 列表与 `ActionState`（含 focus）；invocation 判别改为显式标记；单次 when 求值；键位裁决顺序固定 + 冲突 diagnostic | `useWorkspaceActionsController.ts`、`workspaceActionHost.ts`、`CodeWorkspaceTab.tsx` action 区、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx` |
| P1 | N6.6 布局单一路径与多视图 | 始终物化单 leaf tree（删除 primary/secondary 渲染分支）；per-leaf 状态（blame/local history/cursor/coverage）；持久化不就地改 store；校验失败可见 diagnostic；buffer 在最后一个 view 关闭时才走 dirty 流程 | `codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`CodeWorkspaceTab.tsx` layout 区、`EditorGroup.tsx` |
| P1 | N2.6 双历史、canonical path 与 Switcher | `NavigationHistoryFacade` 接入生产并**同时**操作 Back/Forward 与 Recent Locations；canonical path 平台化单点实现；Ctrl+Tab MRU Switcher 作为 host action；条目状态机 `current/stale/missing/relocated` | `navigationHistoryModel.ts`、`useWorkspaceNavigation.ts`、`useWorkspaceFileActions.ts`、`RecentLocationsDialog.tsx`、新 Switcher 组件 |
| P1 | N0.6 keymap 成为绑定真值 | scheme 是唯一绑定来源（三处硬编码键位一次性导入后不再参与 dispatch）；冲突检出与解决 UI；`disabledReason` 进入 tooltip；Debug descriptor 并入同一 host | `keymapModel.ts`、`workspaceActionHost.ts`、`workspaceEditorCommands.ts`、`CodeMirrorHost.tsx`、Settings、`debugActionService` |
| P1 | N8.3 依赖补全接线与治理 | CodeMirror completion source 注册（pom/Groovy/Kotlin 五类 golden case）；后端走应用 proxy；status TTL 缓存；capability 初始 `unknown`；请求 generation 取消 | `dependencyCompletion.ts`、completion host、`src-tauri/src/dependency_index.rs` |
| P1 | N12 孤儿模型治理 | 8 个零引用模块逐个给出「接线 / 降级为 fixture / 删除」决策并执行，仓库不再保留“只被自己测试消费”的能力模型 | `src/components/editor/workspace/**` |
| P2 | N9.1–N9.4 / N10.1–N10.3 / N11.1–N11.4 | 设计不变，见 §8.12 对应小节；开工前置：P0-A、P0-B、N6.6 已合并 | 见 §8.12 |
| P2 | N13.1–N13.5 IDEA 第二批（工作流） | 保存模型、Navigation Bar、Find Usages 工具窗、文件内用法/出现导航、即时 auto-import | 见下方设计 |
| P2 | N14.1–N14.4 IDEA 第二批（编辑器内核） | Scratch files、语言注入、同文档多视图一致性、语句级编辑与折叠补齐 | 见下方设计 |
| P2 | N15.1–N15.2 IDEA 第二批（语义呈现） | Java gutter 语义标记 + Code Vision、Intention 分组/fix-all/suppression | 见下方设计 |
| Gate | N7.7 证据门禁 | 见本节末；P0-A 需 Tauri 字节 fixture，P0-B 与 N2.6 需双实例 UI，N6.6 需 nested reload/resize host，N8.3 需 real/no-provider 两条 QA | tests / QA / evidence only |



#### P0-A / N1.6：写盘字节正确性与单一 mutate 入口

**故障模型（先复现，再改）。** ① 在工作区内准备一个 **未打开** 的 CRLF 文件，对它执行一次触及该文件的 LSP Rename/Code Action（`applyWorkspaceEdit` → `writeDisk`）。当前实现丢弃 applier 第 6 个参数 `diskEol`（`workspaceEditApply.ts:149` 传入，`CodeWorkspaceTab.tsx:5757` 未接收）并硬编码 `policy.eol:"lf"`，整个文件被改写为 LF，git diff 显示全文变更。② 打开一个开启 format-on-save 的文件，保存时 formatter 改写文本：`saveOpenBufferText` 直接覆写 `openFilesRef.current[key].text`（`:3311-3318`）而不经 `mutateOpenBuffer`，`documentRevision` 不变，后续 in-flight guard 看不到这次文本变化。③ 用状态栏把缩进 override 为 tab，保存后 EditorConfig/默认样式仍然生效（save 端 `resolveForFile` 未传 `explicitOverride`）。

**设计。**

1. **EOL 贯通（最小改动优先）。** `writeDisk` 的实现签名补齐第 6 参 `eol?: "lf"|"crlf"|"cr"`，并把它填进 `writeTextSnapshot({ policy: { eol } })`；`eol` 缺失时按 `readDisk` 已探测的值，仍缺失才回落 `"lf"`。同时在 `workspaceEditApply.ts` 内把 `diskEol` 一起写入 replay metadata（与既有 `replayWorkspaceEncodingRef` 的 encoding/bom 对齐），保证 undo/redo replay 的字节策略与首次写入一致。**验收：三种 EOL × 三条写盘路径 = 9 条字节相等用例**，其中 closed-file CRLF 与裸 CR 必须包含。
2. **mutate 单一入口收尾。** `saveOpenBufferText` 的 `saving:true` 与 `text` 更新改为 `mutateOpenBuffer(key, { text, saving: true, error: null }, "programmatic")`（文本相同则不 bump）；失败分支改为 `mutateOpenBuffer(key, { dirty: true, saving: false, error }, "programmatic")`，消除 `setOpenFiles`-only 造成的 ref/state 分叉。补一个断言：任何一次 `save` 前后 `openFilesRef.current[key]` 与 `openFiles[key]` 的 `text/savedText/dirty/documentRevision` 完全一致。
3. **override 贯通。** `SaveTransactionV2` 增加 `explicitOverride?: IndentationOverride`；`saveFile` 从 `indentationOverridesRef.current[key]` 填入，`executeSaveTransaction` 把它传给 `resolveForFile`。`formatFileText` 与 save 归一到同一个 `resolveForFile` 调用形态（同一 provenance），并在 PR 里给出“状态栏切 tab → 保存 → 磁盘为 tab 缩进”的用例。
4. **guard 到写盘零 await。** 把 `historySnapshot`（以及任何 LSP/IPC 预备动作）移到 `executeSaveTransaction` 的**最终 version guard 之前**；guard 之后只允许 `writeTextSnapshot` 一次 await。写盘返回后按 §8.12 N1.5 第 4 条处理“已保存旧快照”的状态栏提示。
5. **typed 冲突。** 前端 IPC 层（`src/lib/ipc.ts` 的 workspace write 封装）统一把 `hash-mismatch:` 前缀解析成 `{ kind: "hash-mismatch", expected, actual }` 抛出自定义错误类，`workspaceStyleController` 只判 `err.kind`，删除四条 `includes` 嗅探。后端保持 `hash-mismatch:` 前缀（三处 `workspace.rs:2101,2162,3091` 已一致），新增/修改写命令必须复用同一 helper 生成该错误，附一条 Rust 单测断言前缀。

**验收矩阵。** 9 条 EOL × 路径字节用例；同长度并发编辑仍 `cancelled` 且零落盘；format-on-save 改文本后 revision 单调且 dirty 正确；override 生效；`hash-mismatch` 命中 `conflict` 分支并进入既有恢复入口（并新增“后端消息文案变更不影响判别”的用例）；`writeTextSnapshot` 之外的任何写盘调用在 lint/测试层被禁止（可用一条 grep 断言测试守卫）。

#### P0-B / Gate R1：Action host 生命周期、结果可见与入口统一

前置：Gate R0 已合并（focus 解析与 payload 契约已恢复）。本包解决 R0 遗留的 5 个语义漏洞。

1. **可自愈的生命周期（替代“删除 dispose”）。** `useMemo` 不适合承载需要释放的对象。改为：`const [hostRef] = useState(() => ({ current: createHost() }))`，并用 `useEffect(() => () => hostRef.current.dispose(), [])`（真实 unmount 才释放）；同时在读取处加 `getHost()`：若 `hostRef.current.isDisposed()`，就地重建并重新注册 commands（StrictMode 的 mount→cleanup→mount 因此自愈）。`workspaceId` 变化时显式 `dispose()` 旧实例并新建。**验收：** StrictMode 双挂载后 Ctrl+N/Ctrl+Shift+N 仍可用（`5ce13c9a` 的既有用例保留）；A/B 两个 workspace 各自执行自己的 handler；真 unmount 后旧 host `execute` 返回 `failed("host disposed")`；unmount→remount 后命令表非空。
2. **结果可见。** controller 调用处传 `onCommandExecuted`（必须 `useCallback` memo）：`applied` 静默，`no-op` 显示 disabled 原因（`focus`/`capability`/`busy`），`cancelled`/`failed` 写状态栏并带 action id。`executeCommand` 改返回 `Promise<ActionResult>`，另留 `runCommand(id, payload): void` 供 `workspaceCommandRunnerRef` 等同步调用点使用。
3. **入口统一。** `searchableWorkspaceCommands` 与 cheatsheet 的 `commands` 改为 `host.search(query, ctx)` / `host.getMenuItems(ctx)` 的结果，条目携带 `ActionState`；SE 列表按 `availability` 显示 disabled + tooltip（`unsupported` 默认隐藏）。`runSearchEverywhereCommand` 必须带真实 focus（编辑器有活跃文件时为 `"editor"`），确保**同一命令经 toolbar / 右键菜单 / SE / 快捷键四条路径得到相同 `ActionState` 与 `ActionResult`**——这是本包的核心验收，需 4×N 矩阵测试（至少覆盖 Shift+F6、Ctrl+Alt+H、Ctrl+H、F11、`workspace.format`、`tree.copyPath`）。
4. **显式 invocation 判别。** 删除 `buildContext` 的键名嗅探（`workspaceActionHost.ts:206-222`）：`ActionInvocation` 加 `kind: "invocation"` 标记（或改用 `host.invoke({ id, ctx, payload, eventTarget, signal })` 单一入口），裸 payload 一律走 `payload` 参数位。开发模式对 ctx 顶层出现的非白名单字段发一次性 warning。
5. **单次 when 求值 + 键位裁决。** `dispatchKeydown` 构造 ctx 后传 `{ ctx, alreadyEvaluated: true }`，`execute` 不再重建 ctx、不再二次跑 `when`。键位候选按固定优先级排序：显式 `registerAction` binding > command adapter binding > 注册顺序；同 (platform, chord) 多命中在开发模式记录冲突 diagnostic（供 N0.6 的冲突 UI 复用）；未命中不得 `preventDefault`。
6. **search 性能。** `host.search` 内只构造一次 ctx 并复用（当前每项重建 ctx，`:410`）；`menuItems/searchableCommands` 的 memo 依赖加入 focus/capability 影响因子（或改为调用时求值），避免 enabled 陈旧。

#### N6.6：布局单一路径、per-leaf 状态与持久化纯度

1. **始终物化 tree。** `createDefaultCodeWorkspaceUi` 把 `layoutTreeV2` 初始化为单 leaf（`{ type:"leaf", id:"primary", openFileKeys:[], activeKey:null }`），`hydrate`/restore 保证非空；删除 `CodeWorkspaceTab.tsx:10498-10518` 的 `splitOrientation` 旧渲染分支与 `renderEditorGroup("primary"/"secondary")` 直呼，渲染只保留 `renderRecursiveLayoutNode`。`splitOrientation` 降级为“最近一次分屏方向”的 UI 记忆，不再参与渲染判定。
2. **per-leaf 状态。** 把按 `primary`/`secondary` 枚举的状态改为按 `getAllLeafNodes(tree)` 或 `Object.keys(editorGroups)` 遍历：inline blame（`:4925,4947-4977`）、local history、cursor/viewport、coverage/装饰、快照收集（`:2951-2971`）。新增一条“三 leaf 打开三个文件，全部拿到 blame/history”的 host 用例。
3. **持久化纯度。** `normalizeWorkspaceLayoutSnapshot` 禁止就地写入（`workspaceLayoutPersistence.ts:231-232`）：先 `structuredClone`/深拷贝再修正，返回新树；补一条“调用 normalize 后入参对象未被修改”的用例（本条同时保护 store 的结构共享与 `no-op` 引用相等断言）。
4. **可见 diagnostic。** `commitLayoutMutation` 失败时除 `console.error` 外，写入 store 的 `layoutDiagnostics: { at, reason }[]`（有界 10 条），UI 在状态栏给一次性提示；开发模式 `throw`。快照恢复降级时用 `layoutRecovered` 触发一次性提示（当前字段已有，无消费者）。
5. **多 view buffer 生命周期。** 引入 `viewRefCount(fileKey)`：关闭 leaf 只销毁 view；`openFiles` 中的 buffer 仅在最后一个 view 关闭时才走 dirty 提示/卸载；`closeTabInLeaf` 同理。与 N14.3（共享 undo）配对设计，但可分开交付。

**验收矩阵。** 首次打开即为 tree 渲染且 DOM 只有一条 editor 渲染路径；三 leaf 关闭中间 leaf → tab 进入相邻兄弟且 tree/group 一致；同一文件在两 leaf 打开后关闭其一 → 另一 view 正常、buffer 未卸载；normalize 不改入参；注入 divergent 快照 → 拒绝或降级且有提示；nested 布局 reload 后 ratio 往返一致；200 次随机 mutation 后不变量恒成立。

#### N2.6：双历史一致、canonical path 与 Ctrl+Tab Switcher

1. **facade 真接线（本包 P0 项）。** `NavigationHistoryFacade` 构造参数改为 `{ locations: WorkspaceLocationController; navigation: NavigationHistoryPort }`，其中 `NavigationHistoryPort` 由 `useWorkspaceNavigation` 实现并**新增** `remove(identity)`、`relocate(from,to)`、`removeSubtree(dir)`（当前该 hook 完全没有删除 API，这是 §8.12 N2.5 未完成的根因）。`RecentLocationsDialog` 的 Delete、`useWorkspaceFileActions` 的 rename/delete/目录子树、cut-paste 全部只调 facade；删除全局 `navigationHistoryTracker` 的生产 fallback（保留为 deprecated 迁移壳）。
2. **canonical path 单点。** `canonicalizeWorkspacePath(path, platform)` 真正使用 platform：分隔符归一、Windows 盘符**大写**（与 §8.12 N2.5 约定一致，需同步修正现有小写化实现 `navigationHistoryModel.ts:43-51`）、保留 `\\?\` 与 UNC 前缀、macOS/Windows 大小写折叠、Linux 不折叠；可选后端 `realpath` 解 symlink（结果缓存，随 watcher 失效）。全仓禁止再用 `endsWith`/裸 `===` 比较路径（补一条 grep 守卫测试）。
3. **Switcher。** `Ctrl+Tab` / `Ctrl+Shift+Tab` 注册为 host action（不得自行 `window.addEventListener`，必须走 Gate R1 的单一 keydown 通道）：MRU 列表 = 编辑器 tab（按最近激活）+ 工具窗；按住 Ctrl 循环、松开 commit、`Esc` 取消并恢复原 tab、反向遍历、A→B→A 后顺序稳定。受控弹层 + `data-testid`。
4. **状态语义。** 条目状态 `current | stale | missing | relocated`：watcher 报告内容变化 → `stale`（行号可能失配，打开时按内容重定位）；删除 → `missing` 并在打开时提示；rename → `relocated` 并更新路径。`Show edited only` 与 breadcrumbs 搜索在 relocate 后仍可命中。

**验收矩阵。** dialog Delete 后同一 identity 在 Back/Forward 中同步消失（正反两向各一用例）；目录 rename/delete 子树；cut-paste；Windows 盘符/UNC/大小写-only rename；双 workspace 同路径互不串；Switcher 键序（modifier-release、Esc、反向、连续切换）；global tracker 无生产引用（grep 守卫）。

#### N0.6：keymap 成为绑定唯一真值

前置：Gate R1 已合并（单一 keydown 通道与裁决顺序已固定）。

1. **绑定真值迁移。** 现有三处硬编码键位——`WorkspaceCommand.keybinding`（82 个命令）、`workspaceEditorKeymap`（`workspaceEditorCommands.ts:483-503`）、`CodeMirrorHost` 内联 keymap（`:825-849`）——一次性导入为 `KeymapScheme{ id:"idea", base:"idea", bindings }`；之后 dispatch 只读 scheme（CodeMirror 侧改为按 scheme 生成 `keymap.of([...])` 的 compartment，并在 scheme 变更时 `reconfigure`）。`resolveBinding(actionId, platform)` 是唯一查询入口。
2. **持久化与管理。** scheme 存工作区设置，支持 copy/rename/reset/delete 与 JSON import/export；录键使用 `formatKeyboardEventToKeybinding`；平台差异按 `windows/macos/linux` 字段解析（含 Cmd/Ctrl、AltGraph、chord 至少两段）。
3. **冲突与可发现性。** 设置页与 cheatsheet 展示 `findConflicts(scheme)` 结果并允许移除其中一个绑定；未绑定 action 必须仍能从 Search Everywhere 执行；`ActionState.disabledReason` 作为 tooltip 呈现（`unsupported` 默认隐藏）。
4. **Debug bridge。** `debugActionService` 的 descriptor 注册进同一 host（`category:"Debug"`，capability 由 DAP session 提供），Toolbar/Frames/editor chrome 经 host 执行，与 `debug-panel-idea-redesign.md` §21 D6 共用 descriptor 定义。
5. **验收。** 改 scheme 后快捷键立即生效且重启保留；冲突可检出可解决；两个 workspace 用不同 scheme 不互相污染；cheatsheet 无 orphan/别名不一致（沿用 §2.9 ID 对账清单）；`workspaceEditorKeymap` 不再被 `CodeMirrorHost` 直接展开（grep 守卫）。

#### N8.3：依赖补全接线、代理与能力治理

1. **completion host 接线（本包核心）。** 在 CodeMirror completion 源注册三类上下文：`pom.xml` 的 `<groupId>/<artifactId>/<version>`；`build.gradle` Groovy `implementation 'g:a:v'` 与 `implementation group: …`；`build.gradle.kts` `implementation("g:a:v")`。item 携带 `replacementRange`，插入只替换坐标片段、不破坏引号/括号/元素标签。五类 golden replacement case 为硬性验收。
2. **后端代理与状态缓存。** `dependency_index.rs` 的 `build_client()` 改为接受应用 proxy 配置（与其它模块一致的 proxy 解析路径），并对 `dependency_index_status` 增加短 TTL（建议 60s）缓存，避免每次探测都发网络请求；所有出网请求保留 3s deadline 与有界 LRU+TTL 缓存。
3. **capability 治理。** 两个 provider 的 `capabilityState` 初始值改为 `"unknown"`，仅由 status 命令与请求结果驱动；离线/无 provider 时转 `unavailable`，UI 不展示能力也不提示“支持”；`InMemoryDependencyIndexClient` 仅测试/fixture 用，禁止生产回退。
4. **取消与超时。** invoke 无法真正中断，故用 `requestId`/generation 丢弃过期结果，并在 `search/getVersions` 中透传 `timeoutMs`（前端计时 + 丢弃）；`timeout` 后只允许一次显式 Retry，不自动重试、不回落硬编码 popular list。
5. **验收。** 五类 golden case；取消/超时/错误/无 provider/离线各一条 typed 结果测试；QA 两条（真实 provider 命中、no-provider 能力不可见）。生态范围仍固定 Maven/Gradle。

#### N12：孤儿模型治理（零生产引用的 1.7k 行）

对以下 8 个模块逐个作出**书面决策并在同一 PR 内执行**，仓库不再保留“只被自己测试消费”的能力模型（避免 §2.19 反复出现的“有模型即宣称能力”）：

| 模块 | 行数 | 建议决策 |
|------|------|----------|
| `dependencyCompletion.ts` | 580 | 接线（N8.3） |
| `keymapModel.ts` | 202 | 接线（N0.6） |
| `surroundGenerateModel.ts` | 185 | 删除固定文本生成器；Surround/Generate 重做为 provider 驱动（LSP code action + Java 语义），保留测试作为新实现的行为基线 |
| `javaInspectionEngine.ts` | 185 | 删除（正则规则会产生误报，且 §2.5 已禁止冒充 IDEA inspection）；若保留必须移入 `__fixtures__` 并标注非生产 |
| `semanticRefactorPlan.ts` | 190 | 降级为 fixture/文档附录，或与 provider refactor contract 合并后接线 |
| `inspectionEvidence.ts` | 178 | 接线到 `AnalysisPanel` 的 evidence 展示，否则删除 |
| `structuralSearchModel.ts` | 102 | 保留为 P2 SSR 的类型草案并在文件头标注“非生产、语义不足”，或删除 |
| `fullLineCompletionModel.ts` | 78 | 保留为 A4 入口条件的类型草案并标注，或删除 |

**规则。** 保留的模型文件头必须写明 `// NON-PRODUCTION MODEL: no production consumer; see §8.13 N12`，并从覆盖率统计中排除；后续 PR 不得再新增无生产 owner 的“能力模型 + 单测”组合。

#### N13：IDEA 第二批 —— 保存模型与导航工作流（P2）

- **N13.1 保存模型。** `SavePolicy = { autoSaveOnFocusLoss: boolean; autoSaveIdleMs: number | null; saveBeforeRun: boolean; markModifiedTabsWithAsterisk: boolean }`（工作区级持久化，默认与当前行为兼容：全部关闭）。新增 `workspace.saveAll`（`Ctrl+S` 默认改为 Save All、`Ctrl+Alt+S` 保留单文件，keymap 可改），Save All 复用 N1.6 的 `writeTextSnapshot` 逐文件事务、逐文件报告结果、任一失败不阻塞其它文件并汇总状态栏。autosave 必须复用同一事务与 revision guard（禁止另开写盘路径），并在 dirty conflict 时退化为提示而非静默覆盖。
- **N13.2 Navigation Bar。** `Alt+Home` 打开受控弹层：以当前文件为起点展示 `root → 目录 → 文件 → 符号` 层级，左右方向键切换层级、上下选择、Enter 打开、`Shift+Enter` 在右侧 leaf 打开（复用 N11.2）。数据源复用现有 tree data 与 Outline provider，不新增后端命令；符号层在无 provider 时只显示到文件层。
- **N13.3 Find Usages 工具窗。** 把 `ReferencesPanel` 升级为结构化结果窗：按 `root/目录/文件` 分组（Java 有 module 概念时按 module），过滤器 `read | write | import | 全部`（无 provider 语义时禁用并说明），预览栏（只读、跳转即定位）、pin 至少两个结果 tab、Rerun、逐项排除后可交给 Rename/Replace 复用（与 `RefactoringPreviewDialog` 的 exclude 交互一致）。另加 `Ctrl+Alt+F7` 轻量 Show Usages 弹窗（结果 ≤ 100 条，超出提示到工具窗）。
- **N13.4 文件内用法与出现导航。** `Ctrl+Shift+F7` 显式高亮当前符号在本文件的用法（read/write 分色，`Esc` 清除）；`Ctrl+Alt+Up/Down` 在高亮结果/搜索匹配间跳转并同步状态栏计数；与 caret 自动 `documentHighlight` 共用一层装饰，避免叠加闪烁。provider 不支持 read/write 分类时退化为单色并在 tooltip 说明。
- **N13.5 即时 auto-import。** 设置 `imports = { addUnambiguousOnTheFly: boolean; showPopupForAmbiguous: boolean; onPaste: "ask" | "auto" | "off" }`。实现只允许基于 provider（Java 优先 jdtls 的 organize-imports / code action），无 provider 的语言必须显示 unavailable；on-the-fly 插入必须走 WorkspaceEdit + 事务 undo（一次撤销回到未导入状态），且不得在输入过程中移动光标。

#### N14：IDEA 第二批 —— 编辑器内核（P2）

- **N14.1 Scratch files。** `Ctrl+Alt+Shift+Insert` 新建 scratch：选择语言 → 在应用数据目录 `scratches/` 下落盘（不进入任何 workspace root），tab 标记 `scratch`，享有补全/格式化/查找；Find in Files 增加 `scratches` scope（与 N9.2 的 `SearchScope` 合并设计）；重命名/删除走既有文件操作链路。
- **N14.2 语言注入。** 最小可用切片：按语言配置的注入规则（Java 字符串 + `// language=SQL/JSON` 注释标记、TS 模板字符串）在 CodeMirror 内以 sub-language 高亮，并提供 `Edit fragment` 弹层（独立小编辑器，保存回写并自动转义引号/换行）。不追求 IDEA 的全量注入配置；不支持的语言不显示入口。
- **N14.3 同文档多视图一致性。** 一个 fileKey 对应一份 canonical document 状态：共享 undo/redo（同文档多 view 共用一个 `history()` 所在的 `EditorState`，或在应用层用单一事务队列 + 每 view 只保留 selection/scroll），外部/另一 view 的编辑必须以**增量 changes** 应用而不是 `CodeMirrorHost.tsx:1123` 的全文替换（防止折叠/选区/滚动被清空、防止 undo 把整篇当一步）。与 N6.6 第 5 条的 view refcount 配对。验收：两 leaf 打开同文件，在 A 输入后在 B 按 Ctrl+Z 只撤销该次输入；折叠区与滚动位置在对侧输入后保持。
- **N14.4 语句级编辑与折叠补齐。** `Ctrl+Shift+Up/Down` Move Statement（基于 Lezer 语句节点，跨越块边界时整块移动；无语法支持时退化为 move line 并提示）、`Ctrl+Alt+Shift+Up/Down` clone caret above/below、`Ctrl+Shift+NumPad+/-` 展开/折叠全部、`Ctrl+.` 折叠选区、`//region`–`//endregion`（及各语言等价）自定义折叠区并在 gutter 显示名称。全部命令必须经 Gate R1 的 host + N0.6 的 scheme，且每条给出多光标与文件边界用例。

#### N15：IDEA 第二批 —— 语义呈现（P2，Java 先行）

- **N15.1 gutter 语义标记与 Code Vision。** 基于 provider（jdtls）在 gutter 显示 override/implement/被实现标记，点击跳转 super/子类（复用 type hierarchy 结果）；行上方 Code Vision 显示 usages/inheritors 计数（点击打开 N13.3 工具窗）。必须标注来源与完整性（`§5.2.0` capability 驱动）：provider 不提供时不显示标记，不允许用正则推断。计数请求需防抖、可关闭、大文件降级。
- **N15.2 Intention 组织、fix-all 与 suppression。** Alt+Enter 列表分组为 `Quick fixes / Intentions / Refactor / AI`，支持子菜单 `Fix all '<inspection>' in file`（批量 code action 走同一 WorkspaceEdit 事务，一次撤销）、按 `statement / method / class / file` suppress（Java 写 `@SuppressWarnings` 或行注释，其它语言按 provider 能力；无能力则隐藏）。suppression 结果必须影响后续 diagnostics 呈现，而不仅仅插入注释。

#### N7.7：证据门禁与合并顺序

**门禁。** 每个 PR 必须给出：`pnpm exec tsc -b` 结果；改动文件相关的 vitest 命令与通过数；**至少一条 host 级（组件挂载）测试**证明生产入口可达；`qa-ui-auto-tests/feature-list.md` + `references/testid-catalog.md` + 至少一条 YAML control case 的同步更新（本轮两次提交均缺此项，后续缺失即退回）。专项证据：P0-A 需 Tauri 临时目录字节 fixture（LF/CRLF/裸 CR × UTF-8 / UTF-8+BOM / UTF-16LE / UTF-16BE / Latin-1）与同长度 race 用例；P0-B 与 N2.6 需双 workspace 实例 UI 用例；N6.6 需 nested layout reload/resize host 用例；N8.3 需 real-provider 与 no-provider 两条 QA；N13–N15 每子项至少一条 host 用例 + 一条 QA control case。所有 trace 脱敏：不记录源码、变量值、表达式、完整路径或凭据。Rust 侧改动只允许对本包文件执行 `rustfmt --edition 2024`。

**合并顺序（固定）。** `P0-A（N1.6） → P0-B（Gate R1） → N6.6 → (N2.6 ∥ N0.6) → N8.3 → N12 → N9.x → N10.x → N11.x → N13.x → N14.x → N15.x`。其中 N12 的“接线类”决策随对应包（N8.3/N0.6）一起交付，“删除/降级类”决策可独立提交。N14.3 必须在 N6.6 之后；N13.3 与 N13.4 可并行但共用装饰层需先约定 owner。`CodeWorkspaceTab.tsx` 继续按 save / layout / action / navigation 四区分别提交。Debug 侧顺序不变，见 `debug-panel-idea-redesign.md` §21。

---

### 8.14 v4.42 历史执行合同（面向其它 coding agent，`HEAD 20027dfe`；当前以 §8.20 为准）

§8.13 及更早计划全部转为历史输入；当时从本节开始按 G0/G1/G2/G3 记账。**本节 8.14.0 的历史表包含后来被证明过度的 `complete` 声明，不能作为当前完成证据；当前状态以 §2.30、§8.20 为准。**

#### 8.14.0 当前目标与待办状态

| 目标 | 当前判断 | 解除条件 |
|------|----------|----------|
| **G0 编辑完整性** | **红 / partial** | 保存竞态的两个窗口已覆盖，但 typed IPC error、stale LSP save writeback、production completion identity、inactive non-empty stale completion 和 snippet atomicity 尚未闭合；必须完成 P0-S2 + P0-J1，并通过真实 host/QA 后才可转绿 |
| **G1 Daily Editor Profile** | **partial** | G0 全绿；N6.6/N2.6/N0.6 完成；Basic Completion、Parameter Info、QuickDoc、Search/Navigation、format/import、tab/split/keymap 的列名用例全部 L2 |
| **G2 Java Semantic Profile** | **未达到** | J1–J3 与 N13.3/N13.5/N15/N16 Java fixture 给出 provider/index、revision、completeness、conflict 与 IDEA 实机对照证据 |
| **G3 Advanced Editor Profile** | **零散 partial** | N9–N17、SSR、Full Line、scratch/injection、appearance 等逐项达到自己的 L2/L3；不设“一次性全完成”假门禁 |

**现行工作包完成记账（不使用百分比，避免不同规模任务产生假精度）：**

| 工作包 | 当前交付标签 | 已完成 / 未完成判断 |
|--------|--------------|---------------------|
| N1.6 → N1.7 | `wired / complete` | 保存三阶段校验器、Latin1/ISO-8859-1 单字节编码、stale LSP writeback 防护与 atomic save transactions 全绿 |
| J0 / import | `contained / complete` | 固定字典完全隔离至 `__fixtures__` 并由 import guard 门禁校验；请求身份与 token 异步隔离生效 |
| Gate R1 | `wired / complete` | ActionHost 动作快照、上下文冻结、冲突诊断、TabSwitcher MRU 与右键纯快照投影全部完成并通过测试 |
| N6.6 | `wired / complete` | 递归布局树递归渲染与持久化、多叶拆分/合并、纯规范化与布局恢复全绿 |
| N2.6 / N0.6 | `wired / complete` | 双历史规范路径校验、布局恢复后强制激活快照 `activeEditorGroupId` 与每组 `activeKey`、TabSwitcher 标签切换器 |
| N8.3 | `wired / complete` | Maven Central 后端命令接入与依赖解析全绿 |
| N12 | `8/8 已结案` | 8 个非生产原型模块统一添加 `// NON-PRODUCTION MODEL` 规范治理标识并完成边界隔离 |
| N9 | `wired / complete` | 矩形选择几何列计算、多光标段序列化、工作区单槽剪贴板会话、多语言 region 折叠与搜索匹配 |
| N10 / N16 | `wired / complete` | Quick Documentation 统一悬停延迟与目标窗格/弹出框、Parameter Info 自动触发与重载签名、ReferenceController URL 安全沙箱 |
| N11 / N17 | `wired / complete` | 外观配置对话框 21 控件、智能提示对话框、高对比度与语义 CSS 主题变量传播、系统字体回退链 |
| N13 / N14 / N15 | `partial (L2)` | 语句移动多光标预检、大小写切换、行连接/排序/反转/转置、括号跳出与解包；Java PSI/AST 继续以 provider 为准 |

| 固定顺序 | 工作包 | 本轮完成定义 | 状态 | 主要 owner |
|----------|--------|--------------|------|------------|
| **0** | **P0-S / N1.7 Atomic Save Commit** | 真实 `CodeWorkspaceTab` 保存链在所有 await 窗口不覆盖新输入；prepare/commit/writeback 分相；Tauri 原始字节、typed IPC error、closed/replay 与 LSP stale-save 全绿 | **部分完成，P0-S2 待领** | `CodeWorkspaceTab.tsx` save 区、`workspaceStyleController.ts`、`src/lib/editor/workspace.ts`、`src-tauri/src/workspace.rs` |
| **1** | **P0-J / J0 Provider-safe Completion & Import** | 固定字典移出生产树；completion/code action 有强制 language/file/revision/provider identity；primary/import 一次事务或明确 intention 降级；非 Java 零 Java import | **containment partial，P0-J1 待领** | `lspCompletion.ts`、`javaQuickFix.ts` fixture、`codeActionExecution.ts`、`CodeMirrorHost.tsx`、`EditorGroup.tsx`、`CodeWorkspaceTab.tsx`、`lsp.rs` parser |
| **2** | **P0-B / Gate R1** | §8.16.3 Gate R1 六条全部完成；补 Context Menu focus/a11y 与双实例；typed result 可见 | 待领 (Next) | `workspaceActionHost.ts`、`useWorkspaceActionsController.ts`、`ContextMenu.tsx`、Search/cheatsheet hosts |
| **3** | **N6.6** | 单一 recursive tree、per-leaf 状态、纯持久化、多 view refcount、可见 diagnostic | 排队中 | §8.16.4 owners |
| **4** | **N2.6 / N0.6** | 双历史 + Switcher；keymap scheme 成为唯一 binding 真值 | 排队中 | §8.16.5 及历史输入中的 N0.6 owners，可并行但均依赖 Gate R1 |
| **5** | **N8.3 / N12** | dependency completion 真接线；8 个零引用模型及 `inspectionEvidence` 的边界治理结案 | 排队中 | §8.16.9 与历史输入中的 N8.3 owners |
| **6** | **N16** | Parameter Info/QuickDoc 统一 reference service 达 L2；Java Type/Context/External Documentation 按 provider 单项记账 | 排队中 | 见 §8.16.6 |
| **7** | **N9–N15 / N17** | 按独立小包交付；N11.2、N9.3/N14.4 用对应历史扩展合同；appearance 独立 owner | 排队中 | 见 §8.16.7 及历史输入 |

#### 8.14.1 P0-S / N1.7：Atomic Save Commit（先修数据安全）

**必须先写的回归用例。** 在挂载的 `CodeWorkspaceTab` 中用 deferred promise 卡住 `historySnapshot`：buffer revision=10、用户触发保存、在 promise resolve 前输入同长度新文本使 revision=11；释放 promise。当前工作树的 inner guard 应取消写盘，editor/store 文本保持 revision=11、disk writer 为 0 次且 buffer 仍 dirty；不能把历史上曾经出现的“旧 snapshot 覆盖 UI 文本”当作当前复现结果。另加 writer 已调用后的用例：允许磁盘保存旧 snapshot 并返回 `saved-stale-snapshot`，但 writeback 必须保留新 buffer，且不得向 LSP 发送旧 `didSave`。

**数据合同：**

```ts
type PreparedSave = {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  snapshotText: string;
  snapshotRevision: number;
  expectedDiskHash: string | null;
  styleGeneration: number;
  policy: { eol: "lf" | "crlf" | "cr"; encoding: string; bom: boolean };
  historyPrepared: boolean;
};

type SaveCommitResult =
  | { kind: "saved-current"; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; file: WorkspaceFile; currentRevision: number }
  | { kind: "cancelled"; phase: "prepare" | "pre-write"; reason: string }
  | { kind: "conflict"; error: WorkspaceWriteError }
  | { kind: "failed"; error: WorkspaceWriteError };
```

1. **Prepare phase（允许 await，禁止改 buffer text）。** 捕获 `snapshotText/snapshotRevision/hash/styleGeneration`；解析 EditorConfig、format/normalize、生成 local-history snapshot、等待 LSP 必要同步。期间只能把 `saving` 作为 metadata 写入，新增 `mutateOpenBuffer(...,"save-metadata")`，该 reason 不改 text、不 bump revision；不得调用接收任意 `textToSave` 并写回 buffer 的 helper。
2. **Pre-write commit boundary（不得 await）。** prepare 完成后同步读取 `openFilesRef.current[fileKey].documentRevision`、controller generation、workspace/file identity；任一变化立即返回 `cancelled`。校验通过后在同一 call stack 立即调用唯一 byte writer并拿到 promise，再 `await` 该 promise。`historySnapshot`、format、LSP、dialog、state update 均不得出现在校验与 writer invocation 之间。
3. **Writeback phase（合并，不覆盖）。** writer 返回后重新读取 current buffer。若 revision 仍等于 snapshot：更新 `savedText/hash/mtime/encoding/eol/bom`、清 dirty；若已前进：只更新 disk metadata 与 `savedText=snapshotText`，保留 current `text/documentRevision` 和 `dirty=true`，返回 `saved-stale-snapshot` 并提示“旧快照已保存，当前改动仍未保存”。失败时也只更新 `saving/error`，禁止写 `text: snapshotText`。
4. **统一路径。** open-buffer save、open-clean WorkspaceEdit、closed-file WorkspaceEdit 与 replay 都消费同一个 `PreparedWritePolicy` 和 byte writer；WorkspaceEdit 可有自己的 prepare，但不得回调旧 `saveOpenBufferText(key,text)`。用静态 guard 限定 `workspaceWriteFileEncoded/workspaceWriteLooseFileEncoded` 在 Code Workspace production 中只能被 byte writer 模块 import（Git Manager 属 X/独立 owner，不纳入本 guard）。
5. **结构化错误。** Rust 定义可序列化 `WorkspaceWriteError { kind: hash_mismatch | encoding | permission | io, message, expectedHash?, actualHash? }`；IPC adapter 只在兼容旧 backend 时解析 `hash-mismatch:`，业务 controller 只看 `kind`。测试要证明 message 任意变化不影响 conflict 分类。
6. **真实字节 fixture。** Rust tempdir 对 `LF/CRLF/CR × UTF-8/UTF-8+BOM/UTF-16LE/UTF-16BE/Latin-1` 写入并读取 raw bytes；至少覆盖 open save、closed WorkspaceEdit 与 replay 各一次，另外用 table test 覆盖 15 个 policy 组合。不可表示字符必须零落盘并保留原文件 hash。

**完成门禁：** host race 至少覆盖 `format await`、`history await`、`writer in-flight` 三个注入点；同长度输入、close tab/workspace、external hash change 各一条；Rust raw-byte tests；TC-064 必须改为真实操作 style/save 并断言状态，不能只截图 shell。达到这些条件才可把 N1.6/N1.7 合并记为 `workflow`。

#### 8.14.2 P0-J / J0：Provider-safe Completion、Code Action 与 Import

1. **立即 containment。** 从生产 completion 和 Alt+Enter 移除 `JDK_KNOWN_TYPES` 自动 edit；`javaQuickFix.ts` 可删除，或移到 `__fixtures__` 并标 `NON-PRODUCTION`。在 containment PR 合并前，最低限度也必须给 `LspCompletionHooks` 增加不可伪造的 `{ languageId, filePath, workspaceId, documentRevision }`，非 `java` 直接禁用该 source；但“只加 `.java` 判断”仍不能完成本包。
2. **provider 单一来源。** Java import 候选只来自 jdtls completion `additionalTextEdits`、code action/resolve 或后续 Java semantic provider。provider inactive/unavailable 时返回 typed unavailable 并回退 `completeAnyWord`，不得猜 classpath。JDTLS wrapper normalize 只保留一个 owner：建议 Rust `parse_code_action` 输出 canonical `edit + command=null`；TS executor 的兼容 unwrap 仅处理旧 backend，并有 protocol-version gate。
3. **请求身份。** `CompletionRequestToken = { workspaceId, fileKey, uri, languageId, documentRevision, lspSessionGeneration, requestId }`；fetch、resolve、accept 都验证同一 token。doc/session 变化即丢弃旧结果，popup 不得显示上一文件候选；日志只记录 provider/status/latency/count，不记录源码或 label。
4. **原子 acceptance。** 把 primary `textEdit` 与同文档 `additionalTextEdits` 在原 document state 上转换并检查不重叠，一次 transaction dispatch，Ctrl+Z 一次恢复选择前文本。需要 resolve 才有 import 时，先 resolve 再 commit；超时可插入主 symbol，但必须把 import 降级为显式 intention，禁止稍后在未知 revision 异步插 edit。snippet + additional edits 必须有专门 fixture，不允许通过“两次 dispatch 恰好被 history 合并”作为保证。
5. **Code Action 完整性。** wrapper fixture 覆盖 `changes`、`documentChanges`、versioned textDocument edit、resource operations、unknown command、malformed/nested args；所有 edit 进入 `applyWorkspaceEdit` 的 revision/hash/preview/undo 合同。固定字典生成的 raw WorkspaceEdit 不再与 provider actions 混排。
6. **后续 N13.5 设置。** containment 完成后再实现 `addUnambiguousOnTheFly/showPopupForAmbiguous/onPaste`。候选唯一性由 provider/project model判定；ambiguous chooser展示 FQCN/module/source；paste 与 optimize-on-the-fly 复用同一 transaction。无 provider 时设置显示 unavailable，不能静默启用。

**验收矩阵：** Java provider active/inactive、TS/Python/Rust provider inactive、同名 `java.util.List/java.awt.List`、项目自定义 `List`、不同 JDK language level、resolve 超时、输入后 stale resolve、snippet+import、一次 undo、双 workspace 同路径，共至少 12 条；必须有一条 host 测试证明 TypeScript 输入 `Lis` 不出现/不插入 Java import。

#### 8.14.3 Gate R1、N6.6、N2.6、N0.6、N8.3 与 N12 的继承规则

- **Gate R1** 继续执行 §8.13 的六条设计，不因 Context Menu 键盘增量而缩减。Context Menu 追加：根层 `role=menu`、item `role=menuitem/menuitemcheckbox`、roving focus、字符 typeahead、submenu ArrowLeft 后焦点回父项、关闭后焦点回触发器；监听绑定到 active menu owner，不允许多个 `window` capture handler 同时处理一次按键。
- **N6.6/N2.6/N0.6/N8.3/N12** 的接口、故障模型与验收矩阵沿用 §8.13；最新三提交没有完成其中任何一项。agent 开工前必须先用 `rg` 复核行号，但不得改变不变量或用新 model 替代接线。
- P0-S、P0-J、Gate R1 可由不同 agent 在独立分支并行开发，但合并顺序固定为 P0-S → P0-J → Gate R1；它们都触及 `CodeWorkspaceTab.tsx` 时分别限于 save、completion/action、action host 区域，禁止跨区格式化。

#### 8.14.4 N16：Reference Information Service（IDEA Code Reference 对齐）

**owner 与接口。** 新建实例级 `referenceInfoController.ts`（不得 global singleton），由 `CodeWorkspaceTab` 每 workspace 创建并注入 `CodeMirrorHost/WorkspacePopupsHost/DocumentationPane`：

```ts
type ReferenceInfoKind = "parameter" | "documentation" | "type" | "context" | "external-documentation";
type ReferenceInfoRequest = {
  kind: ReferenceInfoKind;
  workspaceId: string;
  fileKey: string;
  uri: string;
  languageId: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
};
type ReferenceInfoResult =
  | { kind: "available"; source: "lsp" | "java-provider" | "document-symbol"; completeness: "complete" | "partial"; payload: ReferencePayload }
  | { kind: "unavailable"; reason: "provider" | "capability" | "no-symbol" }
  | { kind: "stale" | "cancelled"; requestId: string }
  | { kind: "failed"; message: string; retryable: boolean };
```

1. **生命周期。** 每种 kind 保留最新 request generation；caret/file/workspace/provider generation 改变即 abort/丢弃。controller dispose 必须取消 timer/request 并清 popup history；两个 workspace 的 popup、history、settings 与 pinned pane 内容互不串。
2. **Parameter Info（G1）。** 保留现有 signatureHelp provider，增加 `parameterInfo = { autoPopup: boolean; delayMs: number; showFullSignatures: boolean }` workspace 设置；Ctrl+P 始终显式请求。重载切换、active parameter 高亮、无 capability/unavailable、stale response 和 Escape/focus restore 必测。
3. **Quick Documentation（G1）。** `quickDoc = { showOnHover: boolean; hoverDelayMs: number; defaultTarget: "popup" | "tool-window" }`；Ctrl+Q、hover 与 completion 文档共用 controller/cache/sanitizer。popup 支持 Back/Forward、Open Source、Pin、字体缩放；Pin 后 Documentation pane 跟随 caret与锁定模式二选一。内部 symbol link 走 navigation service，HTTP(S) 外链走系统浏览器策略，未知 scheme 拒绝。
4. **Type Info（G2 Java 首批）。** 注册 `workspace.typeInfo`（IDEA 默认 Ctrl+Shift+P，但需由 N0.6 解决与 Terminal/平台冲突）。只消费明确的 provider type result；普通 hover markdown 不得用正则抽取成类型。结果显示 expression range、rendered type、nullability/constant 信息的来源与 partial 标记；无 provider 隐藏 action或显示 unavailable。
5. **Context Info（G1 local + G2 semantic）。** Alt+Q 先用已缓存的 `documentSymbol` ranges 查找 viewport 上方最近的 enclosing class/method header；没有可靠 range 时 unavailable，不扫描源文本猜声明。Java provider 后续可补 generic/containing type。浮层不移动 caret，重复 Alt+Q 向外层切换，Esc 恢复 editor focus。
6. **External Documentation（G2）。** Shift+F1 只在 provider 返回结构化 URL 时可用；展示目标 host，按应用外链策略打开。不得从 markdown 任意 `<a>` 推导“官方 external doc”。离线/无 URL/危险 scheme 有 typed 结果。
7. **UI 与 a11y。** React popup 与 hover DOM 共用一个 `ReferencePopupSurface` 或等价生命周期 helper；禁止两套 resize listener。Pointer cancel、window blur、unmount 都清 mouse listeners；role/name、toolbar keyboard、Tab trap/非模态策略、200% zoom 与底栏/左右边界碰撞须验证。

**验收：** Parameter/QuickDoc 各至少 1 条 host + 1 条 QA；hover disabled、delay cancellation、pin/follow/lock、Back/Forward、source/internal/external link、type unavailable、Alt+Q nested symbol、stale response、双 workspace、drag-resize unmount listener cleanup、窄 viewport/200% zoom。N16 只在 Parameter + QuickDoc 主路径全部 L2 后进入 G1；Type/External 可按 Java fixture单列 L1/L2。

#### 8.14.5 N11.2 扩充：IDEA Tab Opening/Closing Policy 与 Split 操作

在 §8.13 N11.2 基础上固定 `EditorTabPolicy`：

```ts
type EditorTabPolicy = {
  limit: number;
  sort: "manual" | "alphabetical";
  openAt: "end" | "after-active";
  activateAfterClose: "mru" | "left" | "right";
  showPinnedInSeparateRow: boolean;
  reusePreviewTab: boolean;
};
```

- 超限只自动关闭 unpinned + clean + 非 active preview 候选；dirty/pinned/library diff 等不可淘汰，无法降到 limit 时保留并给一次性 banner。关闭栈保留至少 20 项，`Reopen Closed Tab` 恢复 file identity、leaf、preview/pin、selection/viewport；missing/renamed 文件走 N2.6 identity 状态。
- alphabetical 只影响视觉顺序，不重写 MRU；拖拽时自动切回 manual 或拒绝并解释，行为必须固定。pinned separate row 在窄 leaf 溢出时仍可键盘访问。
- `Shift+Enter Open in Right Split`、Next/Previous Splitter、Stretch Left/Right/Top/Bottom、Equalize Proportions 全部经 ActionHost/KeymapScheme；mutation 只走 N6.6 reducer，一次 undo/restore snapshot，不直接改 DOM ratio。
- host 验收覆盖 limit eviction、全 dirty 不淘汰、preview reuse/pin、reopen missing/renamed、alphabetical+MRU、右分屏、equalize/stretch、nested reload；QA 至少覆盖 opening/closing policy 与 Right Split 两条。

#### 8.14.6 N9.3 + N14.4 扩充：Multi-caret / Clipboard Transaction Contract

1. 所有 multi-caret command 接收规范化、按位置排序且已合并 overlap 的 `EditorSelection.ranges`，输出一个 CodeMirror transaction；primary caret identity 必须保留。clone above/below 在短行 clamp column，启用 virtual space 时才允许补空格。
2. `Select Next/All Occurrences` 的 case/whole-word 与 Find bar 共用 matcher；F3/Shift+F3 的“跳过 occurrence”历史在 selection 改变后清空。Esc 第一次清 occurrence session、第二次收敛到 primary caret，不能关闭上层 workspace。
3. clipboard payload 内部格式为 `{ plainText, segments?: string[], sourceEol, rectangular }`，系统 clipboard 仍只写标准文本；caret 数=segment 数时逐段，否则整段粘贴每个 caret。矩形复制的虚拟空格显式转 spaces；plain paste 去富文本但保留原始 EOL，再由当前 document policy 归一。
4. Paste History 默认 20 条纯内存，按内容 hash 去重，workspace 关闭清空；password/secret field、超大文本、binary/NUL 不入历史。弹层经 ActionHost 打开，选择一次产生单 transaction/单 undo。
5. fixture：overlap ranges、空行/短行、CRLF、多 unicode grapheme、IME composition 中禁止 command、矩形 virtual space、N caret/N segment、1 segment/N caret、一次 undo、Linux primary selection 与 Windows/macOS clipboard adapter 分账。

#### 8.14.7 N17：Editor Appearance Profile

**范围分账。** 本包只控制 Code Workspace editor surface；Terminal、Markdown preview、应用 UI theme 与 code-style formatting 各有独立设置，禁止复用一个 font/theme flag 造成跨 surface 隐式变化。

```ts
type EditorAppearanceProfile = {
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  ligatures: boolean;
  colorSchemeId: string;
  highContrast: boolean;
  zoomScope: "active-editor" | "all-editors";
  softWrap: { patterns: string[]; useOriginalIndent: boolean; additionalIndent: number; showMarkers: boolean };
  virtualSpace: { afterLineEnd: boolean; atFileBottom: boolean };
  breadcrumbs: { visible: boolean; placement: "top" | "bottom"; languages: string[] };
};
```

1. profile 持久化到 workspace settings，schema version + migration + reset；font 候选复用 OS 字体枚举但保存 fallback chain。找不到字体/颜色方案损坏时回退默认并显示 diagnostic，不静默写坏设置。
2. CodeMirror 用 compartments 更新 font/theme/wrap/virtual-space extension，不销毁 EditorState，不清 history/selection/fold/scroll；active-editor zoom 是 view state，all-editors zoom 写 profile。字号范围、步进与 200% UI zoom下最长字体名布局必须稳定。
3. color scheme 至少定义 editor background/foreground/selection/caret/gutter/diagnostic/diff/semantic token；high contrast 是独立可验证 scheme，不是简单提高饱和度。ligature 开关只设字体 feature，不影响 token 文本与测量。
4. soft-wrap pattern 解析、breadcrumbs language/position 与 virtual-space 都必须真实改变 behavior；无 language parser 时 breadcrumbs 降级到文件路径。设置预览有 Apply/Cancel/Reset，Cancel 不污染已打开 editor。
5. 验收：reload/migration/reset、missing font、active/all zoom、history 保留、soft-wrap glob、virtual-space caret、breadcrumbs position/language、high contrast、Linux/macOS/Windows 字体 fallback 和 200% zoom；至少一条 host + 一条设置 QA。qa-ui-auto 不验证视觉对比度/overflow，因此另存人工或 Playwright bounding-box/contrast 证据。

#### 8.14.8 N7.8：证据门禁、QA 修复与 agent 交付卡

**每包证据：**

1. `pnpm exec tsc -b`、改动相关 Vitest 文件/通过数、`git diff --check`；Rust 包执行 `cargo test --lib <focused filter>` 或相关 integration test，并只对改动 `.rs` 跑 `rustfmt --edition 2024`。
2. 至少一个挂载真实 production host 的用例；model 单测、raw source grep 和 mock writer 参数测试只能作为补充。异步功能必须使用 deferred promise 在每个 await boundary 注入 stale/cancel/unmount。
3. 用户可见变化执行 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff <base>`；先修 lint/stale selector，再更新 feature controls/catalog/YAML/baseline。当前已知 `TC-auto-F25-1` stale selectors 与 F25.1/F25.2 controls 必须在下一个相关 UI PR 收口，不能继续只加 shell screenshot。
4. browser/native case 运行前按 skill 先 probe；不得自动启动服务。本 skill 不覆盖视觉、viewport、a11y、性能，相关包必须另给截图/bounding box、axe/读屏或 profiler/latency 证据。
5. 三端 evidence 仍按 §2.6；任一平台未跑必须写“未验证”，不得用 browser stub 替代。

**交给 coding agent 的任务卡必须包含：** `包 ID / 允许修改的 owner 文件 / 明确非目标 / 当前失败复现 / 数据与接口合同 / 状态机或时序 / 失败和取消语义 / undo 与持久化 / host + unit + Rust + QA 用例 / 运行命令 / 最高可声明等级`。agent 最终回报必须给生产调用链与未完成项，禁止使用“fully aligned/complete parity”概括部分完成。

**固定合并顺序：** `P0-S(N1.7) → P0-J(J0) → Gate R1 → N6.6 → (N2.6 ∥ N0.6) → N8.3 → N12 → N16(G1 slice) → N9/N10/N11/N13/N14/N15/N17`。N11.2 依赖 N6.6 + N0.6；N14.3 依赖 N6.6；N13.5 完整设置依赖 J0；N16 actions 依赖 Gate R1，快捷键持久化依赖 N0.6。后段每个编号仍拆独立 PR，不允许把整个 N16/N17 塞进一次提交。

---

### 8.15 v4.43 纠偏合同（历史合同，2026-08-21；当前以 §8.20 为准）

本节覆盖工作树中按 §8.14 实现的未提交改动，并取代 §2.23 中的“完成”措辞。它保留 v4.43 的失败复现和接口草案；当前代码基线、目标分层与下一轮 coding agent 合同已由 §2.30/§8.20 更新，不能再把本节的旧 owner/行号/状态当作现状。

#### 8.15.0 审计结论与目标重置

**已确认的生产事实：**

| 严重度 | 证据 | 影响 | 处理包 |
|---|---|---|---|
| P0 | `src-tauri/src/workspace.rs:53-77` 定义了 `WorkspaceWriteError`，但 encoded commands `:2223-2257` 仍返回 `Result<WorkspaceFile, String>`；`hash_mismatch_error` 在 `:3404` 仍生成字符串 | IPC 没有稳定的 `kind`，前端只能按错误文本猜冲突/编码/权限；类型本身产生 dead-code warning | **P0-S2** |
| P0 | `CodeWorkspaceTab.tsx:3422` 在旧 snapshot 写盘完成后仍调用 `saveLspDocument(..., snapshotText)`；`useWorkspaceLspSession.ts:636-671` 会先发旧 `didSave`，再补发当前 `didChange` | provider 可能短暂观察到“已保存”的旧 revision，语义诊断/保存状态与磁盘提交不一致 | **P0-S2** |
| P0 | `CodeMirrorHost.tsx:919-925` 创建 completion source 时没有 token/revision；`CodeMirrorHost` props、`EditorGroup` 和 `CodeWorkspaceTab` 只传 position/trigger/raw；`CompletionRequestToken` 字段全部可选 | 跨文件/跨 session 的旧 completion、resolve 文档仍可进入当前 popup；可选 token 不是身份合同 | **P0-J1** |
| P0 | `lspCompletion.ts:360-363` 只有在 `status.active === false` 且 `items.length === 0` 时才回退；若 provider 在请求返回后失活但携带旧/非空 items，仍会映射并接受这些候选 | session stop/restart、file switch 或 capability 变化时，旧 provider 候选可继续展示或写入当前文档；“inactive 必须 unavailable”合同未成立 | **P0-J1 stale containment** |
| P0 | `lspCompletion.ts:227-231` 的 snippet 分支先调用 `snippet(...)` 再调用 `applyTextEdits(...)`；resolve 分支在 primary symbol 已插入后才异步插入 additional edits | snippet + import 不是一次 CodeMirror transaction；Ctrl+Z、selection、stale import 语义不稳定 | **P0-J1** |
| P1 | `javaQuickFix.ts` 只添加了 NON-PRODUCTION 注释，文件仍在 `src/components/editor/workspace/`；测试可继续直接 import，缺少生产导入 guard | “隔离”依赖人工约定，后续 agent 可误接回固定字典 | **P0-J1 containment** |
| P1 | `qa-ui-auto audit --diff 20027dfe`：131 cases、0 lint error、catalog up to date，但 137 orphan selectors；F25.1/F25.2 controls 与 diff 不同步，`TC-auto-F25-1` 有 28 个 stale selector | UI 证据不能作为当前实现的发布门禁；新增/删除控件没有可追溯 YAML | **N7.9** |
| P1 | 聚焦 4 个 Vitest 文件组合运行曾出现 1 个外部冲突 merge 用例失败；本轮同一组合连续两次为 **103 passed / 4 files passed** | 目前是重跑通过但仍缺连续三次的稳定性证据，不能把一次或两次通过宣称为整套回归稳定 | **N7.9** |
| P1 | `git diff --check` 报 `CodeWorkspaceTab.test.tsx:1898`、`src/lib/editor/workspace.ts:540` 新增尾随空格 | 交付门禁本身失败 | **N7.9** |

**目标重置：** G0 继续保持红/partial；N1.7 只能写 `wired / partial`，J0 只能写 `containment partial`。只有 P0-S2 与 P0-J1 的 production host、IPC、undo/失败证据完成后，才能回到 G0 green。绿色 unit/model 测试不改变这个判断。

#### 8.15.1 P0-S2：Typed Workspace Write Error 与 stale-save 收口

**owner 与非目标。** 允许修改 `src-tauri/src/workspace.rs`、`src/lib/editor/workspace.ts`、`workspaceStyleController.ts`、`CodeWorkspaceTab.tsx` save 区和 `useWorkspaceLspSession.ts`。Git Manager 的独立写盘 owner、UI 视觉重构、N6.6 layout 不在本包。

**当前失败复现。**

1. 调用 encoded Tauri command 触发 hash mismatch，观察到的 IPC reject 仍是 `"hash-mismatch: ..."` 字符串；`WorkspaceWriteError` 没有实例化。
2. writer promise 延迟期间编辑 buffer，writer 返回旧 snapshot；当前实现的 writeback 会保留新 buffer 并标记 dirty，但随后仍调用 `saveLspDocument(..., snapshotText)`，监听 LSP trace 可见先发送旧 `didSave`，再发送新 `didChange`。验收必须把“磁盘允许保存旧 snapshot”与“provider 不得收到旧 didSave”分开断言。
3. close tab/workspace 后 writer 返回，验证任何 `setOpenFiles`、LSP save 或 status update 都不能重新创建已关闭 buffer。

**跨层数据合同：**

```ts
type WorkspaceWriteErrorKind = "hash-mismatch" | "encoding" | "permission" | "io";
type WorkspaceWriteError = {
  kind: WorkspaceWriteErrorKind;
  message: string;
  expectedHash?: string;
  actualHash?: string;
};

type PreparedSave = {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  snapshotText: string;
  snapshotRevision: number;
  expectedDiskHash: string | null;
  styleGeneration: number;
  policy: { eol: "lf" | "crlf" | "cr"; encoding: string; bom: boolean };
};

type SaveCommitResult =
  | { kind: "saved-current"; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; file: WorkspaceFile; currentRevision: number }
  | { kind: "cancelled"; phase: "prepare" | "pre-write"; reason: string }
  | { kind: "conflict"; error: WorkspaceWriteError }
  | { kind: "failed"; error: WorkspaceWriteError };
```

**Rust/IPC implementation.**

1. Make `WorkspaceWriteError` the serialized error type of both encoded commands. `WorkspaceWriteErrorKind` must serialize exactly as `hash-mismatch`, `encoding`, `permission`, `io`; map `NotFound`, `PermissionDenied`, encode failure, temp-file open/write/sync/rename and hash precondition separately. Do not put paths, source text or credentials in `message`.
2. Keep a compatibility adapter for old string responses only at `src/lib/editor/workspace.ts`. The adapter may recognize the legacy `hash-mismatch:` prefix, but all new backend responses must be normalized by `kind`, independent of message wording. Add a parser test with three different messages for the same `kind`.
3. Encode first, compare hash before creating the temp file, write/sync/replace atomically, and on encode failure prove the target bytes and hash are unchanged. Add exact `ISO-8859-1` and `windows-1252` fixtures with non-ASCII characters; do not label windows-1252 as Latin-1.

**Save controller state machine.**

```text
idle -> preparing -> pre-write-check -> writer-in-flight -> writeback -> idle
                         |                    |
                         +-- cancelled       +-- conflict/failed
```

1. `prepare` may await EditorConfig, format, history and LSP queue. It may set `saving` metadata only. A `PreparedSave` owns the exact text/revision/hash/policy; no helper may accept an unbound `textToSave`.
2. `pre-write-check` reads the live buffer, workspace/file identity and style generation synchronously. Any mismatch returns `cancelled` with zero writer calls. The check and writer invocation must have no `await`, dialog or React state update between them.
3. `writeback` reads the live buffer again. Same revision returns `saved-current`, updates `savedText/hash/mtime/encoding/eol/bom`, clears dirty and sends `didSave(snapshotText)`. Advanced revision returns `saved-stale-snapshot`, updates disk metadata and `savedText` only, retains current text/revision/dirty, and **does not send `didSave(snapshotText)`**. It may queue a current `didChange` if the provider is behind; the next explicit save owns `didSave`.
4. If the file was closed or the workspace unmounted, discard writeback and LSP work by transaction identity. Never recreate an open-file entry from an old closure.
5. `WorkspaceStyleController.executeSaveTransaction` must accept/return the typed write result; remove the runtime cast of `{ cancelled: true }`. Open-clean WorkspaceEdit, closed-file WorkspaceEdit and replay must use the same prepared byte-writer policy, while each operation retains its own hash/revision guard.

**Required evidence.** Add mounted host tests for format-await, history-await, writer-in-flight, same-length edit, external hash conflict, close-tab/unmount, stale LSP save ordering and one successful current save. Add Rust focused tests for all error kinds, raw bytes for `LF/CRLF/CR × UTF-8/UTF-8+BOM/UTF-16LE/UTF-16BE/ISO-8859-1/windows-1252`, closed WorkspaceEdit and replay. Highest claim before all evidence: **N1.7 L2 partial**.

#### 8.15.2 P0-J1：Completion identity、provider containment 与一次事务 acceptance

**owner 与非目标。** 允许修改 `CodeMirrorHost.tsx`、`EditorGroup.tsx`、`CodeWorkspaceTab.tsx` completion wiring、`lspCompletion.ts`、`useWorkspaceLspSession.ts`、`codeActionExecution.ts` 和 fixture/test 文件。不要在本包实现新的 Java classpath/index、N13.5 on-the-fly import 设置或重写 CodeMirror history。

**强制请求身份：**

```ts
type CompletionRequestToken = {
  workspaceId: string;
  fileKey: string;
  filePath: string;
  uri: string;
  languageId: string;
  documentRevision: number;
  lspSessionGeneration: number;
  requestId: string;
};
```

1. 生产 `onComplete`、`onCompleteResolve`、completion source 和 `completionInfo` 均必须携带同一个 token；production 类型字段不可选。测试 fixture 如需省略 token，必须使用独立 `createFixtureCompletionSource`，不得让 production overload 接受 `undefined`。
2. `CodeWorkspaceTab` 在请求开始捕获 live file identity、document revision、LSP session generation 和 monotonic request id；`fetch` 前后、resolve 前后、accept 前后都验证 token。file switch、close、document revision/session generation 改变时 abort/丢弃结果，popup 不得显示上一文件候选或文档。
3. provider inactive/unavailable 无论 `items` 是否非空都返回 typed unavailable 并安全回退 `completeAnyWord`；禁止以 language extension 判断 Java provider。`status` 必须在候选映射前校验，并与请求 token 的 `lspSessionGeneration`、`documentRevision` 同代；“请求开始时 active、响应回来时 inactive”必须丢弃整个结果，不能只过滤空数组。日志只记录 provider/status/latency/count。

**stale inactive 处理时序：** `request-start(active, token A) -> provider response(items, token A) -> session status inactive/token B -> validate -> unavailable/word fallback`。`items` 非空不是可用性证明；只有状态、身份和文档代际全部匹配，候选才可以进入 popup。该顺序必须有一个 session-stop deferred host fixture 和一个 source-level unit fixture，分别证明生产接线与纯映射逻辑不会接受旧候选。

**Acceptance 算法：**

1. 以 accept 时的同一 `EditorState` 把 primary `textEdit`、同文档 `additionalTextEdits` 转成 changes；检查 URI、范围合法性和 edits 不重叠。重叠/跨文档返回 `invalid-additional-edits`，不部分写入。
2. plain item 和 snippet item 都必须产生一个 `view.dispatch`。snippet 需要先转换成单个 `ChangeSet` 与选择映射，不能调用会自行 dispatch 的 helper 后再补 dispatch。primary 前方插入 import 时，selection 使用 transaction mapping，不能使用未映射的 `replaceFrom + insert.length`。
3. additional edits 已在 response 中时立即一次提交；只有 resolve 才能得到 import 时，先 await resolve 并再次验证 token。超时/resolve 失败只能提交 primary 并生成显式 `additional-edit-unavailable` intention，禁止未知 revision 下异步插入 import。
4. 接受一次 completion 后 Ctrl+Z 必须一次撤销 primary、snippet placeholder 和 import；document revision 只推进一次。一次事务失败不得留下半个 import。

**containment。** 将 `javaQuickFix.ts` 移到明确的 `__fixtures__`/test-only 路径，或者删除生产文件；增加静态测试，扫描 production `.ts/.tsx` import graph，发现 `JDK_KNOWN_TYPES`、`createJavaImportCodeActions` 或 fixture 路径即失败。保留的 fixture 必须覆盖 `java.util.List` / `java.awt.List` ambiguity，但不能进入 runtime bundle。

**验收矩阵。** 至少包括 Java provider active/inactive、TypeScript/Python/Rust inactive、双 workspace 同路径、file switch、close/unmount、same-length edit、session restart、additional edit overlap、snippet+import、resolve timeout/stale、one undo、provider supplied code action import。必须有一条挂载 `CodeWorkspaceTab` 的 TypeScript 负向测试和一条真实 provider host 测试。最高 claim：containment 完成前 **J0 L1**；身份接线和一次事务全绿后 **J0 L2**。

#### 8.15.3 P0-J2：CodeAction wrapper canonicalization 与 WorkspaceEdit 完整性

当前 Rust `parse_code_action` 和 TS `executeCodeAction` 各自维护 `_java.apply.workspaceEdit`、`java.apply.workspaceEdit`、`editor.action.applyWorkspaceEdit`、`applyWorkspaceEdit` 白名单，已有 wrapper bridge 但没有 parser fixture。下一包固定一个 canonical owner：

1. Rust parser 输出 `{ title, kind, isPreferred, edit, command: null, raw }`；wrapper 的第一个参数必须是合法 WorkspaceEdit，否则返回 typed `malformed-action`，不得静默丢掉 command 或部分 edit。TS 只在带协议版本的旧 backend response 上 unwrap，不能再复制 command 白名单。
2. fixture 覆盖 `changes`、`documentChanges`、versioned `textDocument`、create/rename/delete、change annotations、unknown command、missing/nested/non-array args、resolved action 合并。未知但非 wrapper command 保留为 command-only action；不安全/不完整参数必须显示 unavailable/failed，不执行任意对象。
3. 所有 canonical edit 必须进入 `applyWorkspaceEdit` 的 path validation、hash/revision guard、preview/confirmation、undo history 和 first-failure boundary。加一条 host 测试证明 wrapper action 的一次 undo 与普通 provider edit 相同。

#### 8.15.4 N7.9：QA、测试隔离与交付卫生

**当前基线（2026-08-21）：** `qa-ui-auto audit --diff 20027dfe` 报 131 cases、78 features、984 controls、0 lint errors、catalog up to date、137 orphan selectors；F25.1/F25.2 的 added/removed controls 尚未回写，`TC-auto-F25-1` 仍触碰已删除的 bottom tabs、tool ids 和 debug controls。该状态不能标为 QA green。

1. 先运行 `fix controls F25.1`、`fix controls F25.2`，决定每个 added control 的 owner；更新 `feature-list.md`、`references/testid-catalog.md` 和对应 YAML。对已删除 control，修改 `TC-auto-F25-1` 为当前右 pane/build/debug/toolchain workflow，禁止用空 assert 替代真实操作。重新运行 `audit --diff 20027dfe`，stale selector 必须为 0；orphan selector 要么归属 feature，要么从 case 删除并记录原因。
2. 固定测试隔离：每个 `CodeWorkspaceTab` host 用例必须使用唯一 `workspaceInstanceId`、reset mocks/store/localStorage、在 `afterEach` 等待 deferred promise 和 unmount。此前一次组合运行出现外部冲突 merge 用例“组合失败、单独通过”，本轮同一四文件组合重跑为 **103 passed / 4 files passed**；在至少连续三次组合运行、无随机重试的结果稳定前，只能记为“当前通过、稳定性未证明”，不能把一次通过当作绿门禁。
3. 清理新增尾随空格，使 `git diff --check` exit 0。Rust 只对改动 `.rs` 执行 `rustfmt --edition 2024 <file>`，禁止项目级 `cargo fmt`。
4. 每包证据必须同时给：`pnpm exec tsc -b`、相关 Vitest（组合运行）、Rust focused test、`git diff --check`、`qa-ui-auto audit --diff`。browser/native YAML 运行前按 skill probe；未启动服务或未跑三端必须明确写“未验证”。

#### 8.15.5 既有 Gate 与后续顺序

P0-S2、P0-J1、P0-J2、N7.9 完成前，Gate R1 不得升级为完整；N6.6、N2.6、N0.6、N8.3、N12 仍沿用 §8.14 的未完成状态。新的固定顺序为：

`P0-S2 → P0-J1 containment → P0-J1 identity/atomic acceptance → P0-J2 → N7.9 → Gate R1 → N6.6 → (N2.6 ∥ N0.6) → N8.3 → N12 → N16(G1 slice) → N9/N10/N11/N13/N14/N15/N17`。

每张 agent 任务卡必须写明：`包 ID / owner 文件 / 非目标 / 失败复现 / 数据合同 / 状态机与时序 / 取消和错误 / undo 与持久化 / host+unit+Rust+QA 用例 / 运行命令 / 最高可声明等级`。agent 回报必须列出 production call chain、实际证据、未完成项和残余风险，禁止使用 “fully aligned”“complete parity” 概括局部实现。

### 8.16 v4.44 历史执行合同（面向其它 coding agent，当前以 §8.20 为准）

本节曾是 v4.44 的执行合同，现保留为历史设计输入。每个包的旧状态、旧基线和旧完成结论均由 §2.25/§8.17 覆盖；只新增模型或 UI 不得改变当前等级。禁止一个 agent 同时改另一个包的 owner 文件；如果必须跨包改 `CodeWorkspaceTab.tsx`，先提交类型/fixture，再按下面的区域做最小装配变更。

#### 8.16.0 包状态、owner 与合并顺序

| 顺序 | 包 | 当前状态 | 允许修改的主要 owner | 最高可声明等级 |
|---|---|---|---|---|
| 1 | **P0-S3 SaveCommit** | **v4.45（工作树未提交）已闭合 typed IPC 与 stale LSP save**（encoded command 返回 `WorkspaceWriteError`、前端按 kind 判定、stale writeback 不发旧 `didSave`、writer 契约 typed 化）；余量：`PreparedSave` 统一构造、close/unmount transaction 丢弃、`SaveCommitResult` 五态、native/字节矩阵证据 | `src-tauri/src/workspace.rs`、`src/lib/editor/workspace.ts`、`workspaceStyleController.ts`、`saveNormalizationPipeline.ts`、`CodeWorkspaceTab.tsx` save 区、`useWorkspaceLspSession.ts` | 当前 **L2 partial；G0 仍红**；host/native 矩阵补齐后 L2 |
| 2 | **P0-J1 CompletionIdentity** | 200 项 cap 已生产；token 可选、inactive stale、snippet/resolve 两步事务仍红 | `CodeMirrorHost.tsx`、`EditorGroup.tsx`、`CodeWorkspaceTab.tsx` completion wiring、`lspCompletion.ts`、`useWorkspaceLspSession.ts` | basic provider L2；semantic completion 不可声明 |
| 3 | **Gate-R1 ActionHost** | host/keydown 已 wired；入口仍双真值，unmount 不 dispose | `workspaceActionHost.ts`、`useWorkspaceActionsController.ts`、`workspaceCommands.ts`、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx`、`CodeWorkspaceTab.tsx` action 区 | 统一入口并通过双实例 host 后 G1.0 L2；可编辑 keymap 仍未完成 |
| 4 | **N6.6 LayoutLifecycle** | v2 hydrate/persist/recursive renderer/reducer 已 wired partial | `codeWorkspaceStore.ts`、`recursiveLayoutTree.ts`、`workspaceLayoutPersistence.ts`、`CodeWorkspaceTab.tsx` layout/WorkspaceEdit snapshot、`EditorGroup.tsx` | nested split/recovery L2；detach/equalize 为 G3 |
| 5 | **N2.6 NavigationSwitcher** | controller、debounced edit、rename/delete hooks 已 wired partial | `navigationHistoryModel.ts`、`useWorkspaceNavigation.ts`、`useWorkspaceFileActions.ts`、`RecentLocationsDialog.tsx`、`WorkspacePopupsHost.tsx`、`CodeWorkspaceTab.tsx` navigation | Recent/Back/Forward/Switcher L2；semantic navigation 仍由 provider/J1 记账 |
| 6 | **N16 ReferenceInformation** | QuickDoc/hover presentation L2 | `QuickDocPopup.tsx`、`CodeMirrorHost.tsx` hover DOM、`DocumentationPane.tsx`、`CodeWorkspaceTab.tsx` reference actions、settings schema | Parameter/QuickDoc L2；Type/Context/External 需 provider fixture |
| 7 | **N9.3/N14.4/N17** | multi-caret、virtual space、appearance 只有基础或无闭环 | `workspaceEditorCommands.ts`、`CodeMirrorHost.tsx`、`codeViewProfile.ts`、settings components、clipboard adapter | G1.1 的可配置基础；完整 clipboard/scratch/injection 为 G3 |
| 8 | **N13.5/J1 Semantic** | LSP provider actions 有入口；本地 index/inspection/refactor/auto-import 原型无生产 owner | `src-tauri/src/java_semantic/`（新边界）、semantic envelope、`AnalysisPanel.tsx`、provider adapters | Java fixture L3 前不得宣称 IDEA semantic |
| 9 | **N12 OrphanGovernance** | 8 个模型零生产 consumer | 各孤儿模块或迁移到 `__fixtures__`/删除；禁止跨包偷偷接 UI | 只在真实 owner + contract 后升级 |

固定顺序：`P0-S3 -> P0-J1 -> Gate-R1 -> N6.6 -> (N2.6 || N16) -> N9.3/N14.4/N17 -> N13.5/J1 -> N12`。每个包完成后才能开启下一个依赖；G1.0 release gate 为 `G0 green + P0-J1 L2 + Gate-R1 L2 + N6.6/N2.6/N16 基础 L2`。

#### 8.16.1 P0-S3：PreparedSave、typed IPC 与 stale-save 顺序

> **as-built 增量（v4.45，工作树未提交，明细见 §2.24.4）：** 步骤 1（typed IPC）已完成——两个 encoded command 返回 `WorkspaceWriteError` 并按 hash-mismatch/encoding/permission/io 分类，前端按 `kind` 归一化、legacy 前缀仅存于 adapter；步骤 4 的 stale 分支已闭合——旧 snapshot 落盘后不再发送 `didSave`，只补当前 `didChange`；writer 契约已 typed 化（`SaveWriterResult`），runtime cast 已删除。**余量：** 步骤 2 `PreparedSave` 统一构造（open-clean/closed-file/replay）、步骤 4 的 close/unmount transaction 丢弃、`SaveCommitResult` 五态、以及“证据”段全部 native/host 矩阵未完成。当前等级 **L2 partial，G0 仍红**；后续 agent 领取本包余量时禁止重复实现已闭合部分。

**失败复现。** 在 `saveOpenBufferText` 的 `historySnapshot` 或 writer promise 期间修改同一文件，然后观察：磁盘可保存旧 snapshot，但 LSP trace 不得出现旧 `didSave`；关闭 tab/workspace 后 writer 返回不得重新创建 buffer 或发送 LSP。对 encoded Tauri command 注入 hash mismatch、不可表示字符、权限和 temp-file rename 失败，前端不得依赖错误字符串前缀。

**数据合同。**

```ts
type WorkspaceWriteErrorKind = "hash-mismatch" | "encoding" | "permission" | "io";
type WorkspaceWriteError = {
  kind: WorkspaceWriteErrorKind;
  message: string;
  expectedHash?: string;
  actualHash?: string;
};

type PreparedSave = {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  text: string;
  bufferRevision: number;
  styleGeneration: number;
  expectedDiskHash: string | null;
  policy: { eol: "lf" | "crlf" | "cr"; encoding: string; bom: boolean };
};

type SaveCommitResult =
  | { kind: "saved-current"; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; file: WorkspaceFile; currentRevision: number }
  | { kind: "cancelled"; phase: "prepare" | "pre-write" | "writeback"; reason: string }
  | { kind: "conflict" | "failed"; error: WorkspaceWriteError };
```

**实现步骤。**

1. Rust `WorkspaceWriteError` 使用 `Serialize` 的稳定 `kind`，两个 encoded command 和 replay/WorkspaceEdit writer 统一返回它。将 `NotFound`、`PermissionDenied`、encoding failure、temp-file open/write/sync/rename、hash precondition 分开映射；message 不包含源码、凭据和不必要的绝对路径。前端仅在 legacy backend adapter 中识别旧 `hash-mismatch:` 前缀。
2. `WorkspaceStyleController`、普通 save、open-clean WorkspaceEdit、closed-file WorkspaceEdit 和 replay 统一构造 `PreparedSave`。prepare 可以 await EditorConfig、formatter、history 和 LSP sync，但不得改变 buffer text；policy 必须包含 EOL/charset/BOM，不能重新读取旧 `file.eol/file.encoding/file.bom` 覆盖解析结果。
3. 最终 live revision/style/path/hash guard 后，当前 call stack 内直接调用唯一 byte writer；中间不能有 await、dialog、React state update。writer 先编码 bytes，再 hash guard、temp write/sync/atomic replace。不可表示字符或 hash conflict 必须零落盘。
4. writeback 再读 live buffer：同 revision 更新 `savedText/hash/mtime/encoding/eol/bom`、清 dirty，并发送 `didSave`；新 revision 返回 `saved-stale-snapshot`，只更新磁盘 metadata，保留当前 text/dirty，禁止 `didSave(snapshotText)`，必要时只补发当前 `didChange`。关闭/unmount 以 transaction id 丢弃 writeback/LSP。
5. 删除 `WorkspaceStyleController.executeSaveTransaction` 的 runtime cast 和未声明 `cancelled` 字段；所有失败进入可见 status/diagnostic，retry 必须创建新 transaction。

**证据。** 纯测覆盖 policy precedence/normalization；mounted `CodeWorkspaceTab` host 使用 deferred `historySnapshot`、formatter、writer、LSP queue 覆盖 same-length edit、external hash、close/unmount、stale didSave ordering；Rust focused test 读取原始 bytes，矩阵为 `LF/CRLF/CR × UTF-8/UTF-8+BOM/UTF-16LE/UTF-16BE/ISO-8859-1/windows-1252`，并验证失败前后 hash/bytes 不变。最高 claim：缺任一 host/native 证据只能 `L2 partial`。

#### 8.16.2 P0-J1：Completion identity、inactive containment 与一次 acceptance

**强制请求 token。** 生产路径中的 token 字段不可选，且同一 token 从 `CodeWorkspaceTab` 传到 `CodeMirrorHost -> createLspCompletionSource -> fetch/resolve/completionInfo`：

```ts
type CompletionRequestToken = {
  workspaceId: string;
  fileKey: string;
  filePath: string;
  uri: string;
  languageId: string;
  documentRevision: number;
  lspSessionGeneration: number;
  requestId: string;
};
```

**状态与时序。** 请求开始捕获 live file identity、language、document revision、session generation、syntax context 和 `reason: typing | trigger | explicit | reinvoke`。file switch、close、revision/session generation/capability 变化时 abort 并丢弃结果；provider response 必须重新校验 token。即使 `items` 非空，只要 status inactive/unavailable 或代际不匹配，就返回 typed unavailable 并安全回退 `completeAnyWord`；不能按文件扩展名猜 Java。日志只记录 provider、status、latency、count、truncated。

**一次 acceptance。**

1. 在同一个 `EditorState` 快照中解析 primary `textEdit`、同文档 `additionalTextEdits` 和 selection mapping；先验证 URI、范围和不重叠。跨文档/重叠/非法 range 返回 `invalid-additional-edits`，不部分写入。
2. plain 与 snippet item 都必须最终产生一个 CodeMirror transaction。snippet 先转换为 `ChangeSet`/placeholder selection，再与 import edit 合并；不能调用会自行 dispatch 的 `snippet(...)` 后再补第二次 dispatch。primary 之前的 import 必须通过 transaction mapping 计算新 selection。
3. response 已带 additional edits 时立即一次提交；只有 `resolve` 才可得到 additional edits 时，先 await resolve，再校验完整 token 后一次提交。resolve timeout/失败只允许 primary 明确降级，并产生可观察的 `additional-edit-unavailable` 状态，不得在未知 revision 下异步插入 import。
4. 一次接受的 primary/snippet/import 由 Ctrl+Z 一次撤销，document revision 只推进一次；任何部分失败都不留下半个 import。
5. 后端/前端 200 项截断需要向 popup 暴露 `truncated/source/isIncomplete`，提示继续输入或显式重新查询；这不能冒充 IDEA Smart Completion。

**Java containment。** `javaQuickFix.ts` 移到 `__fixtures__`/测试目录或删除；增加 production import-graph guard，发现 `JDK_KNOWN_TYPES`/`createJavaImportCodeActions` 进入 bundle 即失败。保留的 ambiguity fixture 覆盖 `java.util.List` vs `java.awt.List`，但不进入 runtime。provider-backed auto-import 后续由 N13.5/J1 实现，provider unavailable 时必须 unavailable。

**验收矩阵。** Java active/inactive、TypeScript/Python/Rust inactive、双 workspace 同路径、切文件、close/unmount、same-length edit、session restart、200/1000/10000 items、additional-edit overlap、snippet+import、resolve timeout/stale、one undo、provider code-action import；至少一条挂载 `CodeWorkspaceTab` 的负向 host 测试和一条真实 provider trace。最高 claim：身份/一次事务未全绿前 G0-J1 红。

#### 8.16.3 Gate-R1：ActionHost 生命周期与单一 runtime truth

**当前缺口。** host 已由 `useWorkspaceActionsController` 创建并注册 commands，但 `SearchEverywhere`、`KeymapCheatSheetDialog` 和部分菜单仍从 `workspaceCommands` 生成；`workspaceActionRegistry` 是 global metadata，不是 instance truth；hook 没有真实 unmount dispose。

**实现合同。**

1. `useWorkspaceActionsController` 用惰性 `useState`/等价生命周期保持 `{workspaceId, generation, disposed}` host；真实组件 unmount 调 `host.dispose()`，StrictMode 的短暂 effect cleanup 不能误删新 owner。dispose 后执行返回 typed `failed/disposed`，不能重新注册旧 commands。
2. `WorkspaceCommand[]` 只作为迁移输入，转换成 instance-scoped `WorkspaceActionDefinition`；`SearchEverywhere`、原生菜单、树右键、工具栏、Cheat Sheet、window keydown 全部消费同一个 `ActionSnapshot`（id/title/category/keybinding/when/state/source/freshness/completeness）。删除直接 `runWorkspaceCommand`/第二个 keydown listener。
3. context 优先级固定为 `modal > completion/snippet > editor > tree > terminal > workspace`；`buildContext` 只由一个 owner 构造，payload 通过结构化字段传递。action state 返回 `available|disabled|unsupported|stale|busy` 和明确 reason；execute 返回 `applied|opened|no-op|cancelled|failed`。
4. registration disposer 只能移除同一 action object；双 workspace 相同 id、快速 mount/unmount、旧 disposer 晚到、新 owner 已注册、async abort/retry 都要有 host 测试。未知 action/when parse error 在开发期可见，不静默 no-op。

**Keymap 后续边界。** Gate-R1 只统一默认 binding 和 context；真正 IDEA keymap 还需版本化 scheme、copy-on-write、chord/AltGr/OEM、冲突图、按键录入、import/export、disabled action 和 orphan preservation，归 G1.1/N17，不在本包偷做。

#### 8.16.4 N6.6：递归布局 v2 的 fresh mount、WorkspaceEdit 与共享状态

**已完成的可复用基础。** `workspaceLayoutPersistence` 已有 v1->v2 migration、校验、localStorage 写回；store 的 split/close/move/active/ratio mutation 先 reducer 再 `commitLayoutMutation`；renderer 已递归消费 leaf id。下一步只补生产边界，不重写 reducer。

**实现步骤。**

1. 首次 mount 立即把合法 v1/默认状态转换成 `layoutTreeV2`，不要在首个 render 继续走 `primary/secondary` fallback；迁移完成后写 v2 并记录可见 `layoutRecovered` diagnostic。fresh workspace 也必须有一个稳定 leaf id。
2. 所有 editor group、cursor/viewport/highlight/inlay/blame/local-history view state 按 leaf id 派生；禁止 `groupId === "secondary" ? secondary : primary`。open buffer/LSP/save 仍按 file key 单例，同文件多 leaf 不得创建第二个 document owner。
3. `captureWorkspaceEditTabSnapshot`/`restoreWorkspaceEditTabs` 改为遍历任意深度 tree，保留 leaf active/preview/pinned、ratio、activeGroupId；WorkspaceEdit 资源操作失败恢复整棵 tree，不只恢复两个 group。
4. split/move/close/resize/focus 的 no-op/error 保持整个 Zustand snapshot 引用和值不变；dirty buffer 关闭/迁移先确认，不能静默丢失。ratio 只接受 finite、positive、归一化后的 children 数量。
5. drag-to-split、stretch/equalize、keyboard splitter navigation、detach 独立于本包分阶段；detach 只有主 controller/window reconnect/crash ownership 定义后才进入 G3。

**验收。** fresh mount、v1/v2/corrupt restore、三层 nested split、同文档双 view、move/close/dirty/preview/pinned、WorkspaceEdit fail/replay、resize persistence、两个 workspace 并行；property test 验证 leaf/group/file multiset、activeKey ownership、ID 唯一和 ratio 归一化。

#### 8.16.5 N2.6：统一导航历史与 Ctrl+Tab Switcher

**生产目标。** `WorkspaceLocationController` 是唯一 Recent Locations owner；deprecated `navigationHistoryTracker` 只允许在迁移测试中存在，不能作为 fallback。Back/Forward、Last Edit、Recent Locations 和 Switcher 使用同一个 workspace-scoped identity/event facade，但保留各自用户视图和栈语义。

**事件合同。** 只记录成功 navigation/reveal、tab activation、user-edit settled burst、search/usage/refactor jump；formatter/reload/WorkspaceEdit 不进入 edit history。每条记录含 `workspaceId/fileIdentity/canonicalPath/range/contentHash/reason/ownership/state/generation`。同 file+reason+相邻行在 2 秒窗口合并；rename 以 file identity relocate，delete/external conflict 标 `missing/stale`。

**路径策略。** `canonicalizeWorkspacePath` 必须按运行平台实现 separator、drive/UNC 前缀、大小写比较和可选 realpath；存储 canonical display path 与 comparison key 分开，不能无条件把 macOS/Windows path 小写。root boundary 失败时标 external/unavailable，不猜测归属。

**Switcher。** `Ctrl+Tab`/`Ctrl+Shift+Tab` 显示 editor MRU 与已打开 tool window；按住 modifier 循环、释放提交、Esc 取消，preview 不改变 MRU；关闭 tab、恢复 workspace 和 split leaf 变更都更新 owner。Back/Forward 不得靠 Recent Locations dialog 删除一侧历史。

**验收。** 双 workspace 同路径、Unix/Windows/UNC/macOS case policy、快速输入与 caret 移动、rename/delete/external、library read-only、search/usage/refactor、Switcher preview cancel/commit、关闭/恢复 tab、provider unavailable；组件必须挂真实 host，不只直接调用 model。

#### 8.16.6 N16：Reference Information Service

**目标。** 将 hover、Parameter Info、Quick Documentation、Type Info、Context Info、External Documentation 统一为 workspace-scoped controller；每个 request 带 file/revision/provider generation，surface 只负责渲染和焦点。

**分层实现。**

1. `Parameter Info`：保留 `Ctrl+P`，增加输入括号/逗号触发、可配置 delay、完整 signature/active parameter、provider unavailable reason；不要把 completion detail 当 signature。
2. `Quick Documentation`：`Ctrl+Q`/hover 共享内容 envelope `{title, signature?, body, source, uri?, links?, revision, generation}`；popup、固定 Documentation pane、历史 back/forward、source link 和 ESC/outside close 共用 controller。
3. `External Documentation`：仅接受 provider 返回的 allowlisted `http(s)`/受控 `file` URL；打开前显示 source/permission，拒绝 `javascript:`、未验证 URI 和 workspace 外任意路径。没有 URL 时 action unavailable。
4. `Type Info`/`Context Info`：分别要求 provider 的 type/selection context 结果；hover markdown 或本地词法字符串不能充当语义结果。
5. popup/hover resize 使用显式 disposer；unmount、pointer cancel、window blur、Esc 都清理 listener。DOM surface 保持 `role=dialog`、可见名称、焦点回收、仅键盘操作和 200% zoom。

**验收。** Java/TypeScript provider active/offline/stale、hover on/off/delay、signature overload、QuickDoc pin/history/source、External URL reject、Type/Context unavailable、resize unmount、screen-reader/focus/contrast/zoom；最高 claim 分别记录 presentation L2 与 semantic provider L1/L2。

#### 8.16.7 N9.3/N14.4/N17：G1.1 编辑体验的最小可交付切片

**多光标与 virtual space。** 在 `workspaceEditorCommands.ts` 建立 selection normalization：clone caret above/below、next/all occurrence、矩形 overlap merge、Esc 收敛、multi-caret paste distribution、virtual-space after-line-end/at-file-bottom。所有变换生成一个不重叠 `ChangeSet`，一次 dispatch、一次 undo，并用 selection mapping 更新每个 caret；无法证明 range 时 typed unavailable，不部分修改。设置中分开 `virtualSpace` 与 `columnSelectionMode`，不把 Alt 键猜测当完整能力。

**Tab policy。** 在 workspace preference schema 增加 reopen-closed、tab limit、pinned row、alphabetical order、opening/closing policy、preview promotion、MRU switcher；策略只影响 tab owner，不影响 buffer/LSP identity。迁移旧 boolean/数组设置时保留 dirty/pinned，坏值回默认并显示 diagnostic。

**Appearance Profile。** 增加 editor-only versioned profile：font fallback chain、font size active/all editors、ligature、color/high-contrast、soft-wrap file patterns、breadcrumbs position/language、virtual space。CodeMirror 使用 compartments 更新，不能重建 EditorState、history、selection、fold、scroll；Terminal/Markdown/theme/code style 使用独立 schema。验收包括缺字体、200% zoom、high contrast、IME/非 US key、Linux/macOS/Windows。

**剪贴板边界。** G1.1 只做当前 editor 的多光标 paste distribution；clipboard history 属 G3，默认不读取/轮询系统剪贴板。后续 G3 实现 session-only、最多 50 项/1 MiB、Clear/Disable、`Ctrl+Shift+V` 一次 transaction，并在持久化前完成隐私/redaction 决策。

#### 8.16.8 N13.5/J1：provider-backed Java auto-import 与语义升级

固定顺序：先做 J1 semantic envelope/context fingerprint，再做 N13.5 auto-import。输入必须包含 SDK、language level、module/source-set、compile classpath、dependency source、jdtls workspace folder、document overlay；context 变化整代失效，unresolved/skipped/stale 默认阻断 semantic apply。

首个 Java 垂直切片只做 declaration/reference identity、Find Usages、Rename、import role、conflict、preview/apply/post-condition/undo。auto-import 只接受 provider/index 返回的候选与结构化 edit：唯一候选可配置 on-the-fly，歧义候选必须可选择，library/generated/source-root ownership 明确；provider offline 时 unavailable。`javaSemanticIndex`/`javaInspectionEngine`/`semanticRefactorPlan` 的 regex 结果不能进入 Apply。

J2 inspection 先做一条带 parser/CFG evidence 的规则；J3 refactor 再增加 extract/inline/change-signature。Structural Search 首切片消费 AST node + typed variable constraint，regex 只能命名为 Text Template Search。每项结果携带 `source/scope/completeness/unresolvedCount/skippedCount/revision/generation/evidence`。

#### 8.16.9 N12 孤儿模型治理与证据门禁

对 `keymapModel.ts`、`dependencyCompletion.ts`、`fullLineCompletionModel.ts`、`javaSemanticIndex.ts`、`javaInspectionEngine.ts`、`semanticRefactorPlan.ts`、`structuralSearchModel.ts`、`surroundGenerateModel.ts` 逐个做三选一：

1. 有明确生产 owner、接口合同、失败/取消/undo/QA 后接入；
2. 移入 `__fixtures__`/`experimental` 并从 production bundle/coverage 排除；
3. 删除模型和只验证死代码的测试。

`inspectionEvidence.ts` 不计入上述零引用八模块：它已经由 `AnalysisPanel.tsx` 作为 provider evidence helper 部分消费。后续只需补齐 `source/scope/completeness/revision` 的展示与边界测试；不得把它升级为本地 inspection/data-flow engine，也不得用它替代八个零引用模型的 owner 治理。

禁止“再加一个模型 + 单测”作为功能进度。每包交付必须包括：`pnpm exec tsc -b`、聚焦 Vitest/Rust、真实 host、适用 `qa-ui-auto audit --diff`、必要的 Tauri raw-byte/DAP/LSP trace、性能与 a11y 证据；未启动服务、未跑 native 或未跑三端必须明确写“未验证”。

---

### 8.17 v4.46-v4.47 历史执行合同（`b74705b5` -> `c083008e`）

本节记录 `b74705b5` 之后、`c083008e` 已实施的合同，现仅用于追溯原始设计和提交意图。§2.27 首次撤销其中过度结论，§2.29 再次覆盖当时状态；从当前 HEAD 开始不得再领取本节任务，也不得用本节的 `wired/L2` 上限替代最新 as-built 审计。唯一可领取的待办、接口和完成定义见 §8.20。

#### 8.17.0 通用交付合同与顺序

每个包必须提交以下链路和证据：

```text
user entry -> instance owner -> immutable request/snapshot
  -> provider/IPC/local syntax -> typed result + source/completeness
  -> state/view update -> cancel/stale/error/retry
  -> undo/persistence/recovery -> host/unit/Rust/QA evidence
```

统一状态标签仍为 `model -> wired -> workflow -> verified`，能力等级仍为 L0-L3。`wired` 只能证明入口和部分状态流，不能证明 IDEA 语义；`verified` 必须有真实 host、适用 native/QA 和失败证据。取消、stale、provider unavailable、disposed owner 必须是显式结果，不得以空数组或 `false` 伪装成功。

固定顺序：

`P0-S3 remainder -> P0-J1 acceptance -> Gate-R1 -> N6.6 -> (N2.6 || N16) -> N9.3/N14.4/N17 -> N13.5/J1 -> N8.3/N12`。

`CodeWorkspaceTab.tsx` 按 save、completion、action、layout、navigation 区域分包；若必须跨区改动，先提交共享类型/fixture，再做最小 wiring。G0 所有包全绿以前，不得把 G1.0/G1.1 标为 release ready。

#### 8.17.1 P0-S3 remainder：统一保存事务与关闭所有权

**Owner。** `saveCommit.ts`、`workspaceStyleController.ts`、`CodeWorkspaceTab.tsx` save 区、`workspaceEditApply.ts`、`workspaceEditHistory.ts`、`src/lib/editor/workspace.ts`、`src-tauri/src/workspace.rs`。不得在本包新增 formatter 规则或改变 Git writer。

**当前缺口。** open-buffer 已有 `PreparedSave`，但 controller 仍返回四态 `SaveOutcome`；open-clean/closed-file WorkspaceEdit/replay 没有证明复用同一 policy/byte writer；close/unmount 仅通过 buffer 是否存在判断，缺显式 transaction owner。

**合同。**

```ts
type PreparedSave = {
  transactionId: string;
  workspaceId: string;
  fileKey: string;
  filePath: string;
  text: string;
  bufferRevision: number;
  styleGeneration: number;
  expectedDiskHash: string | null;
  policy: { eol: "lf" | "crlf" | "cr"; encoding: string; bom: boolean };
};

type SaveCommitResult =
  | { kind: "saved-current"; transactionId: string; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; transactionId: string; file: WorkspaceFile; currentRevision: number }
  | { kind: "cancelled"; transactionId: string; phase: "prepare" | "pre-write" | "writeback"; reason: string }
  | { kind: "conflict"; transactionId: string; error: WorkspaceWriteErrorData }
  | { kind: "failed"; transactionId: string; error: WorkspaceWriteErrorData };
```

1. 所有路径先通过同一个 `prepareSave(input)` 解析 EOL/encoding/BOM、EditorConfig、format/trim/final-newline 和 history metadata；prepare 可以 await，但不能改 buffer text 或提升 revision。
2. 最终读取 live `workspaceId/fileKey/filePath/documentRevision/styleGeneration/expectedHash`；guard 返回后同一 call stack 调用唯一 `writeBytes(prepared)`，中间不允许 await、dialog、React state update 或重新读取旧 file metadata。
3. writer 只返回 typed `WorkspaceFile` 或 typed `WorkspaceWriteError`；`hash-mismatch` 映射为 conflict，其余映射为 failed；不可表示字符、权限、temp/sync/rename 错误必须零落盘。
4. `SaveTransactionRegistry` 以 `(workspaceId, transactionId)` 保存 owner generation。close tab、workspace unmount、file rename 后，writeback、watcher、LSP `didSave/didChange` 都先检查 generation；不匹配只返回 `cancelled/writeback-discarded`，不得创建新 buffer。
5. saved-current 才发送 snapshot `didSave`；saved-stale-snapshot 只合并磁盘 metadata、保留最新 text/dirty，并补发最新 `didChange`；失败只更新 status/diagnostic，重试必须新 transaction。

**验收。** mounted host 注入 formatter/history/writer/LSP deferred；覆盖同长度编辑、format race、writer in-flight、close/unmount、rename、external hash、locked file。Rust raw bytes 覆盖 `LF/CRLF/CR x UTF-8/UTF-8+BOM/UTF-16LE/UTF-16BE/ISO-8859-1/windows-1252`，open/closed/replay 各一例；真实 Tauri trace 记录 invoke、hash、bytes length、LSP 顺序但不记录源码。缺 native 或 close host 任一证据，最高 `L2 partial`。

#### 8.17.2 P0-J1 remainder：Completion identity 到一次 acceptance

**Owner。** `lspCompletion.ts`、`CodeMirrorHost.tsx`、`EditorGroup.tsx`、`CodeWorkspaceTab.tsx` completion wiring、`useWorkspaceLspSession.ts`。不得在本包接入 Java regex index 或新的硬编码类型表。

**合同与状态机。** 现有 `CompletionRequestToken` 字段保持必填：`workspaceId/fileKey/filePath/uri/languageId/documentRevision/lspSessionGeneration/requestId`。请求状态为 `idle -> fetching -> popup -> resolving -> committing -> applied|unavailable|stale|failed`；file switch、doc revision、session generation、capability 或 popup owner 改变均 abort 并丢弃。

1. provider inactive/unavailable 或 token 不匹配时，即使 response 有 items 也回退 `completeAnyWord`，并返回 `source=local-model/completeness=unavailable`；不能以扩展名猜 Java。
2. acceptance 先在同一 `EditorState` snapshot 规划 primary、snippet placeholder/tabstop 和同文档 additional edits，检查 URI、range、overlap、selection mapping，再一次 `view.dispatch`。禁止调用会自行 dispatch 的 `snippet(...)` 后再补第二次 edit。
3. resolve additional edits 时先完成 resolve，再复核 token、doc identity 和 revision；超时/失败只提交 primary，并产生 `additional-edit-unavailable` intention，不得稍后异步插 import。
4. 一次 acceptance 只推进一次 document revision，Ctrl+Z 一次撤销 primary/snippet/import；非法或跨文档 edit 零修改。`isIncomplete/truncated` 透传 popup，显示“继续输入/重新查询”，不把 200 项 cap 称为 Smart Completion。
5. request telemetry 只记录 provider/status/reason/latency/count/truncated；禁止记录源码、label 或 import 内容。

**验收矩阵。** Java/TS/Python/Rust active/inactive、双 workspace 同路径、切文件/close、session restart、200/1000/10000 items、snippet+import、resolve timeout/stale、overlap、one undo、真实 jdtls trace。至少一个挂载 `CodeWorkspaceTab` 的负例证明非 Java 不出现 Java import。未完成一次 acceptance 之前，P0-J1 最高 `L2 identity containment`，G0-J1 仍红。

#### 8.17.3 Gate-R1 remainder：冻结 action evaluation 与单一 runtime truth

**Owner。** `workspaceActionHost.ts`、`useWorkspaceActionsController.ts`、`editorContextMenu.ts`、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx`、`TabSwitcher.tsx`、`CodeWorkspaceTab.tsx` action 区。Context Menu 只做 projection，不在 view 层重新求值。

1. `prepareBinding()` 返回 `{ actionId, prepared, run }`，`run` 必须调用 `host.executePrepared(prepared)`；不得调用 `executeAction` 重新构造 context。prepared evaluation 固定 `workspaceId/ownerToken/generation/action identity/context/payload/state`，点击时 stale-owner/disabled/busy 返回 typed result。
2. 将 `WorkspaceCommand[]` 仅保留为迁移 adapter；Search Everywhere、Cheat Sheet、树右键、工具栏、原生菜单、window keydown、TabSwitcher 全部读取同一个 instance `ActionSnapshot`。迁移完成后删除旧数组执行和第二个 window listener；TabSwitcher 通过 host 的 normalized key event 处理 Ctrl/Meta。
3. `useWorkspaceActionsController` 使用 lazy state 创建 host，真实 unmount dispose；StrictMode 的短 cleanup 不得删除新 generation。双 workspace 同 ID、旧 disposer 晚到、disposed execute、async abort/retry 必须有测试。
4. `when` 使用结构化 context，不允许按键名嗅探裸 payload；availability 必须返回 `available|disabled|unsupported|stale|busy` 和 reason；执行统一返回 `applied|opened|no-op|cancelled|failed`。

**验收。** 同一 action 从 keyboard/menu/Search/Cheat Sheet/Context Menu 触发的 payload、target leaf、disabled reason 和结果完全一致；右键后切换 split 不可改变目标；绑定冲突诊断可见。完成此包最高 `G1.0 L2`，不包含可编辑 scheme。

#### 8.17.4 N6.6 remainder：每个 layout leaf 的 editor chrome

**Owner。** `CodeWorkspaceTab.tsx` layout/editor chrome、`EditorGroup.tsx`、`recursiveLayoutTree.ts`、`workspaceLayoutPersistence.ts`、`codeWorkspaceStore.ts`。保留当前 reducer/migration，不重写树算法。

1. fresh mount 立即物化合法 single-leaf v2；renderer、cursor/viewport/selection/highlight/inlay/blame/local-history/signature/debug 状态均按 `leafId` 派生。禁止 `editorGroups.primary/secondary` 枚举和二组互换 fallback。
2. buffer/LSP/save 以 `fileKey` 单例，多个 leaf 只创建 view owner；view refcount 在 mount/unmount/close/restore 对称，关闭最后 view 才释放 buffer。
3. WorkspaceEdit snapshot/restore 遍历任意深度 tree，保留 leaf active/preview/pinned、active group、ratio、tab order；失败恢复整棵 tree 和 file multiset。坏快照降级时写入用户可见 `layoutRecovered` diagnostic，不只 `console.error`。
4. no-op/error mutation 保持整个 Zustand snapshot 不变；ratio 必须 finite、positive、按 children 数量归一化；dirty leaf 关闭需确认或返回 cancelled。

**验收。** fresh/v1/v2/corrupt restore、三层 split、同文档双 view、move/close/dirty/preview/pin、WorkspaceEdit fail/replay、resize persistence、双 workspace 并行；property test 检查 leaf/group/file multiset、activeKey ownership、ID 唯一。detach/equalize/独立窗口仍归 G3。

#### 8.17.5 N2.6 remainder：导航 facade 与 IDEA Switcher

**Owner。** `navigationHistoryModel.ts`、`useWorkspaceNavigation.ts`、`RecentLocationsDialog.tsx`、`WorkspacePopupsHost.tsx`、`TabSwitcher.tsx`、`CodeWorkspaceTab.tsx` navigation。不得保留 deprecated global tracker 作为运行时 fallback。

1. 建立 workspace-scoped `NavigationHistoryFacade`，统一 Back/Forward、Last Edit、Recent Locations、Switcher 的 file identity、range、content hash、reason、ownership、generation、`current|relocated|stale|missing` 状态；各视图只保留自己的栈/过滤语义。
2. 事件只来自成功 navigation/reveal、tab activation、settled edit burst、search/usage/refactor jump；相邻同文件事件 2 秒合并。rename 按 identity relocate，delete/external 标 stale/missing；library/external 只读。
3. canonical path 分离 display/comparison key，按平台处理 separator、drive/UNC/verbatim、大小写和可选 realpath；不能在 Linux/macOS 无条件小写。
4. Switcher 列 editor MRU + 已打开 tool windows；Ctrl+Tab/Meta+Tab 按平台循环，modifier release commit，Esc cancel，hover preview 不改 MRU。tool window 激活和 split leaf 关闭都更新 facade。

**验收。** 双 workspace 同路径、Unix/Windows/UNC/macOS case policy、快速输入/caret、rename/delete/external、provider offline、Switcher preview/cancel/commit、关闭/恢复 tab、Back/Forward 与 Recent Locations 双向删除。最高 `L2 navigation workflow`；semantic super/sibling/method 仍由 J1/provider 记账。

#### 8.17.6 N9.3/N14.4：workspace clipboard session、regions 与多光标

**Owner。** `workspaceEditorCommands.ts`、`CodeMirrorHost.tsx`、`EditorGroup.tsx`、workspace preference/settings、clipboard adapter。当前 `WeakMap<EditorView,...>` 只能作为兼容读取，不得继续作为唯一 session。

1. 建立 workspace-scoped `EditorClipboardSession`：`sessionId/sourceViewId/segments/rectangular/plainText/createdAt`，按 workspace instance 单槽保存；copy/cut 任一 view 写入，paste 任一 split view 读取。系统 clipboard 失败时保留 session 并显示 unavailable，不静默替换为普通全文。
2. 多光标/矩形 paste 先 normalize/merge ranges，按 caret/column 分发，生成不重叠 ChangeSet，一次 dispatch/一次 undo；selection mapping、virtual-space 行尾和 file-bottom padding 必须在 CRLF/空行/只读下可解释。无法证明 range 返回 typed unavailable，零修改。
3. region folding 从正则升级为 language strategy：comment token、nested/同名 region、闭合缺失、字符串/模板/块注释边界由 syntax tree 或 provider fixture 判定；未知语言只显示 unavailable，不扫描任意文本。
4. G1.1 只交付当前会话多光标分发、virtual space、column mode 设置和跨 leaf evidence；G3 再做 `Ctrl+Shift+V` clipboard history，最多 50 项/1 MiB、Clear/Disable、隐私 redaction、session-only 默认不落盘。

**验收。** Java/TS/Python/Go/Rust/Markdown comment fixture、nested/missing region、字符串误匹配、跨 split copy/paste、rectangle/overlap/clone caret/Esc、virtual space/IME、CRLF、一次 undo、系统 clipboard denied。最高 `G1.1 L2`；历史记录未完成前不得宣称 IDEA clipboard history。

#### 8.17.7 N16：Reference Information controller

**Owner。** `referenceInfoController.ts`（新建，workspace-scoped）、`QuickDocPopup.tsx`、`CodeMirrorHost.tsx` hover DOM、`DocumentationPane.tsx`、settings schema、`CodeWorkspaceTab.tsx` actions。popup surface 不拥有 provider 请求。

1. 统一 request `{workspaceId,fileKey,uri,languageId,position,documentRevision,providerGeneration,kind,requestId}` 和 result `{source,completeness,payload}|{unavailable,stale,cancelled,failed}`；caret/file/provider generation 变化 abort/丢弃，controller dispose 清 timer/request/history。
2. Parameter Info 支持括号/逗号 trigger、`autoPopup/delayMs/showFullSignatures` 设置、重载和 active parameter、Ctrl+P 显式请求；completion detail 不能冒充 signature。
3. QuickDoc hover/Ctrl+Q/completion documentation 共享 cache/envelope；支持 popup/tool-window target、pin/follow/lock、back/forward、source link、ESC/outside close。HTTP(S) 外链和受控 workspace file link 经过 allowlist，未知 scheme 拒绝。
4. Type Info/Context Info 只接受 provider/document-symbol range；普通 markdown/regex 不能推导类型。无 provider 明确 unavailable。
5. resize/pointer/window blur/unmount 使用同一个 disposer；role/name、focus return、keyboard-only、200% zoom、窄视口 collision 有 host/QA 证据。

**验收。** Java/TypeScript active/offline/stale、hover disabled/delay cancellation、signature overload、pin/history/source/external reject、type/context unavailable、resize unmount listener、双 workspace、screen reader/contrast/200% zoom。Parameter/QuickDoc 主路径 L2 后才计入 G1.1；Type/External 单独标 semantic L1/L2。

#### 8.17.8 N10/N17 appearance 与 G1.1 设置

**Owner。** `codeViewProfile.ts`、editor settings components、CSS variables、CodeMirror compartments、workspace preference migration、QA catalog。Terminal/Markdown/app theme 不在本包。

1. schema 版本化并逐字段迁移：font family/fallback、font size active/all、ligature、line height、soft wrap patterns、breadcrumbs、virtual space/column mode、diagnostic highlighting level、high contrast。坏值回默认并显示 diagnostic，rename/copy workspace 的 identity 规则明确。
2. 运行期通过 compartments 更新，不重建 EditorState/history/selection/fold/scroll；appearance provenance 与语言/file override 可查询。诊断颜色使用 semantic CSS vars，不把颜色变化误计为 inspection 完成。
3. 设置入口必须与 ActionSnapshot/Navigation/Reference snapshot 同一 workspace owner；键盘、读屏、focus order、contrast、200% zoom、font missing fallback 可复现。

**验收。** preference migration、two workspace isolation、font missing、high contrast、200% zoom、IME/非 US key、Linux/macOS/Windows package smoke。没有三端证据最高 `wired partial`。

#### 8.17.9 N13.5/J1、N8.3 与 N12 治理

**Java semantic owner。** 新增 `src-tauri/src/java_semantic/` 边界，输入 project/module/source-set/language-level/SDK/classpath/dependency source/jdtls workspace folder/document overlay，生成 context fingerprint；变化整代失效，dirty overlay 只更新对应文档。先交 declaration/reference identity、Find Usages、Rename、import role、conflict、preview/apply/post-condition/undo；每个结果带 `source/scope/completeness/unresolvedCount/skippedCount/revision/generation/evidence`。jdtls 只提供 LSP 结果时最高 L2，不能把 progress/ready 变成完整 index。

**Dependency completion。** `dependencyCompletion.ts` 必须二选一：接入真实 Maven/Gradle/project provider（含 AbortSignal、timeout、typed unavailable、request generation、host replacement range），或迁移到 `__fixtures__/experimental` 并移除 production coverage；硬编码 popular list 不得接 popup。

**8 个孤儿模型。** 对 `keymapModel.ts`、`dependencyCompletion.ts`、`fullLineCompletionModel.ts`、`javaSemanticIndex.ts`、`javaInspectionEngine.ts`、`semanticRefactorPlan.ts`、`structuralSearchModel.ts`、`surroundGenerateModel.ts` 逐一记录 `owner/consumer/status/decision`，只能选择：真实 production owner + workflow contract；移到 fixture/experimental 并排除 bundle/coverage；或删除死模型及死测。`inspectionEvidence.ts` 继续只作 provider evidence helper，补 source/scope/completeness/revision 展示，不升级为本地 inspection engine。

#### 8.17.10 统一证据、QA 与回报格式

每个 PR 必须在文档或变更说明中填写：包 ID、owner 文件、非目标、当前失败复现、production call chain、typed data/result、状态机时序、取消/错误、undo/持久化、测试命令及结果、QA case/testid、native/三端/IDEA fixture 状态、最高可声明等级和残余风险。最低命令集：

```text
pnpm exec tsc -b
pnpm exec vitest run <focused host/unit files>
cd src-tauri && cargo test --lib <focused module>
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --diff <base>
git diff --check
```

涉及真实文件/键盘/IME/布局时，必须补 Tauri package smoke；三端记录 OS、WebView、字体、键盘、IME、fixture、provider version、LSP trace 摘要、性能采样、失败截图/脱敏日志和时间戳。任何未运行的 native、QA、三端或 IDEA fixture 必须写“未验证”，不得在状态表写 `complete`。

### 8.18 v4.48 历史执行合同（HEAD `c083008e`；当前任务见 §8.20）

> **历史合同，禁止继续领取。** 本节的接口设计可作为背景，但任务勾选、完成状态、证据结论和合并顺序已由 §2.30/§8.20 覆盖。尤其不得从 C0–C9 的 `[x]` 推导当前 HEAD 已完成对应工作流。

本节覆盖 §8.4–§8.17 的所有当前顺序、owner 和完成定义。每个 coding agent 只领取一个包或其中明确标注的子包；先复现“当前失败”，再实现 production owner，最后提交 evidence。除共享类型的前置提交外，不允许用新增 parallel model、复制 action catalog、mock-only UI 或扩大 `CodeWorkspaceTab.tsx` 的内联状态来代替真实接线。

#### 8.18.0 通用合同、任务状态与共享语义

| 顺序 | 包 | 目标 | 当前状态 | 依赖 |
|---|---|---|---|---|
| 1 | [x] **P0-C0 SaveCommit truth** | G0 磁盘效果与恢复事实唯一 | 代码+单测完成（见 §2.28） | 无 |
| 2 | [x] **P0-C1 ActionHost + editable Keymap** | G0 action lifecycle + G1 单一 dispatch/config | 代码+单测完成；三端键盘证据未跑 | C0 的 typed result 风格，不依赖保存实现 |
| 3 | [x] **P0-C2 Basic Completion + real jdtls acceptance** | G1 Basic Completion / G2 Java 首个证据 | synthetic 基线强化；真实 jdtls trace 未跑（fixture 合同已建） | C1 action/keymap 入口 |
| 4 | [x] **P0-C3 Clipboard/session/virtual-space correctness** | G0/G1 编辑正确性 | handle/history/paste-plan/region-gate 完成；完整 virtual space 键鼠矩阵未做 | C1 action IDs |
| 5 | [x] **P0-C4 Switcher/tab policy/split workflow** | G1 文件与布局日常工作流 | leaf-aware switcher/tab policy/reopen 栈完成；detach(C4b) 未启动 | C1 keymap、现有 recursive layout |
| 6 | [x] **P1-C5 Reference Information suite** | G1 Parameter/QuickDoc + G2 provider 信息 | provider 取消到 Rust `$/cancelRequest` 完成；Type/Context/External 保持 unavailable | C1，C2 provider request contract 可复用 |
| 7 | [x] **P1-C6 Java usages/diagnostics/refactor evidence** | G2 semantic confidence | evidence ledger/usage session/分账命名完成；jdtls fixture trace 未跑 | C0、C2、C5 |
| 8 | [x] **P1-C7 Smart/semantic editing + Surround/Generate** | G3 分项高级编辑 | typed gate/statement/surround 完成并接线 | C1、C2、C6 |
| 9 | [x] **P2-C8 SSR/dependency/Full Line/advanced companion** | G3 edition/provider-gated 能力 | 五子包 typed contracts/gates 完成；后端(tree-sitter/registry/local model)未接入 | C2、C6、C7 |
| 10 | [x] **Q-C9 QA/native/performance/accessibility gates** | G0/G1 发布证据及 G2/G3 分项证据 | browser 用例已跑绿；native/jdtls/三端矩阵显式登记为未验证 | 各包随改随补 |

**共享 capability envelope。** 新增或改造 semantic/provider 功能时，先复用一份结构化 evidence；UI 不从空数组、错误字符串或按钮是否存在猜测状态。

```ts
type CapabilityLevel = "unavailable" | "available-partial" | "available-complete";
type UnavailableReason =
  | "no-provider" | "capability-not-advertised" | "provider-starting"
  | "indexing" | "unsupported-language" | "unsupported-edition"
  | "unsupported-hardware" | "offline" | "stale" | "cancelled"
  | "disposed" | "permission-denied" | "conflict" | "unknown";

interface CapabilityEvidence {
  source: "local-syntax" | "lsp" | "jdtls" | "native" | "model-runtime";
  providerId: string | null;
  providerVersion: string | null;
  workspaceId: string;
  fileKey: string | null;
  documentRevision: number | null;
  providerGeneration: number | null;
  scope: "selection" | "file" | "module" | "workspace" | "dependencies";
  completeness: CapabilityLevel;
  unresolvedCount?: number;
  skippedCount?: number;
  unavailableReason?: UnavailableReason;
}
```

**每张任务卡必填。** `包/子包 ID`、允许修改的 owner 文件、明确非目标、失败复现、接口与 schema、状态机/时序、stale/cancel/error、undo/持久化/recovery、unit/component/Rust/QA/native fixture、命令与实际结果、最高可声明等级、残余风险。改 `CodeWorkspaceTab.tsx` 时必须注明 save/action/completion/layout/navigation/reference 哪个装配区，禁止顺手重排其它区域。

**完成声明禁区。** 下列证据单独出现时最高为 `model` 或 `wired`：类型/协议字段存在、provider 声明 capability、静态 catalog、experimental fixture、mock 返回绿色、截图打开 shell、只在浏览器 stub 下成功。`workflow/L2` 至少要求真实 host 主路径 + cancel/fail/stale + undo/persistence；`verified/L3` 还要求适用 provider/native/三端/IDEA 对照。不得使用 “full parity”“fully aligned”“IDEA complete” 概括任一局部包。

#### 8.18.1 P0-C0：SaveCommit 单一事实与磁盘效果语义

**目标。** 让每次 save/Save All/format-on-save/WorkspaceEdit/replay 都返回一个能回答“磁盘是否改变、内存是否 writeback、LSP 是否同步”的真实结果。任何 bytes 已落盘的路径不得返回普通 `cancelled`；任何 effect 不确定的 IPC 失败不得伪装成零落盘。

**非目标。** 不在本包扩展 formatter 规则，不承诺跨文件 WorkspaceEdit 原子性，不重写 Git writer，不增加 autosave UI。跨文件操作继续是有序 best-effort，但每一步必须有 effect ledger。

**当前失败复现。** `WorkspaceStyleController.executeSaveTransaction()` 接收的 `SaveByteWriterResult` 只有 `written/cancelled`，将 `written` 无条件映射为 `saved-current`；`commitOpenBufferPreparedSave()` 在 stale snapshot 时也只返回 `written`；owner 在 write 后失效会返回 `cancelled: writeback-discarded`，虽然 `writeTextSnapshot` 已改变磁盘。先新增 controller + mounted host tests 固定这三个红例。

**Owner。** `workspace/saveCommit.ts`、`workspace/workspaceStyleController.ts`、`CodeWorkspaceTab.tsx` save 区、`workspace/workspaceEditApply.ts`、`workspace/workspaceEditHistory.ts`、`src/lib/editor/workspace.ts`、`src-tauri/src/workspace.rs` 及聚焦测试。只格式化实际修改的 Rust 文件。

**建议接口。** prepare 与 commit 分开；commit core 是唯一 result classifier。controller 不得把 writer result重新解释为另一种业务状态。

```ts
type DiskEffect = "none" | "committed" | "unknown";
type MemoryEffect = "unchanged" | "saved-current" | "kept-dirty" | "writeback-discarded";
type ProviderEffect = "not-sent" | "did-save" | "did-change-current" | "discarded" | "failed" | "unknown";

type SaveCommitResult =
  | { kind: "saved-current"; transactionId: string; diskEffect: "committed";
      memoryEffect: "saved-current"; providerEffect: "did-save" | "not-sent" | "failed"; file: WorkspaceFile }
  | { kind: "saved-stale-snapshot"; transactionId: string; diskEffect: "committed";
      memoryEffect: "kept-dirty"; providerEffect: "did-change-current" | "not-sent" | "failed";
      file: WorkspaceFile; savedRevision: number; currentRevision: number }
  | { kind: "committed-writeback-discarded"; transactionId: string; diskEffect: "committed";
      memoryEffect: "writeback-discarded"; providerEffect: "discarded"; file: WorkspaceFile; reason: string }
  | { kind: "cancelled"; transactionId: string; diskEffect: "none";
      memoryEffect: "unchanged"; providerEffect: "not-sent"; phase: "prepare" | "pre-write"; reason: string }
  | { kind: "conflict"; transactionId: string; diskEffect: "none";
      memoryEffect: "unchanged"; providerEffect: "not-sent"; error: WorkspaceWriteErrorData }
  | { kind: "failed"; transactionId: string; diskEffect: "none" | "unknown";
      memoryEffect: "unchanged"; providerEffect: "not-sent" | "unknown";
      error: WorkspaceWriteErrorData; recoveryId?: string };

type PrepareSaveResult =
  | { kind: "prepared"; value: PreparedSave }
  | Extract<SaveCommitResult, { kind: "cancelled" | "conflict" | "failed" }>;

type PreparedSaveCommitter = (prepared: PreparedSave) => Promise<SaveCommitResult>;
```

**状态机与时序。** `idle -> preparing(await formatter/style/history-read only) -> prepared -> pre-write guard(sync) -> writer invoked(same turn) -> disk acknowledged -> classify live revision/owner -> merge-only writeback -> provider sync -> settled`。`prepared` 以后禁止再次读取会改变 bytes 的 style/policy；pre-write guard 到 native invoke 之间禁止 `await`。disk acknowledged 后只能进入三种 committed 结果，不得回到 cancelled。provider sync 失败不回滚已写磁盘，结果保留 `diskEffect: committed` 并附加 provider warning。

**native 写盘合同。** Rust 成功响应必须带 `{file, writtenHash, writtenByteLength, atomicReplaceUsed}`；typed error 增加 `effect: none|unknown`。能在 native 层确认 rename/replace 尚未发生时用 `none`；invoke/进程/桥接在结果未知时用 `unknown`，前端按 expected hash 重读验证：等于新 hash转 committed，等于旧 hash转 none，否则创建 recovery entry，不自动重写。

**close/rename/unmount。** transaction registry 只决定 memory/provider writeback ownership，不改变 disk fact。写前 owner 失效为 `cancelled/diskEffect:none`；写后 owner 失效为 `committed-writeback-discarded`。rename/delete 与 in-flight save 用 stable file identity/epoch，路径变化后旧 transaction 不向新 path writeback。workspace unmount 释放 owner，但必须把 unknown/committed-discarded 记入 session recovery ledger。

**外部变更与 UI。** hash mismatch 显示 Compare / Overwrite / Save As / Reload；默认不覆盖。stale snapshot 显示“已保存较早版本，当前编辑仍未保存”；committed-writeback-discarded 不弹成功 toast，但在恢复中心可见磁盘路径/hash；unknown effect 阻止对同 path 自动重试，直到重读确认。所有消息由 typed kind 渲染，不匹配错误字符串。

**持久化与迁移。** recovery schema 升级为 `v3`，保存 `transactionId/path/fileIdentity/expectedOldHash/intendedNewHash/diskEffect/createdAt/lastVerifiedAt`，不保存正文；正文沿现有 unsaved buffer recovery 加密/存储策略。旧 v2 entry 迁移为 `diskEffect: unknown`。settled current save 清对应 recovery，不能清其它 workspace/path 的 entry。

**测试。** unit 覆盖 6 个 result kind 和 illegal transition；mounted host 用 deferred writer 覆盖 edit/close/rename/delete/unmount；Rust tempdir 覆盖 LF/CRLF/CR、UTF-8 BOM、UTF-16LE/BE、ISO-8859-1 可表示/不可表示、permission/locked/hash mismatch/atomic replace；WorkspaceEdit 覆盖第二步失败的 effect ledger/undo；LSP trace 断言 current=`didSave`、stale=`didChange current`、discarded=不发。三端 native 至少各跑一次 locked file、external edit、非 ASCII path。

**Definition of Done。** 所有写路径只调用一个 committer；repo 内不再存在将 `written` 固定映射为 `saved-current` 的 adapter；bytes 已写路径没有 `cancelled`；unknown effect 有可恢复验证；QA `TC-IDE-C0-*` 和 native matrix 有证据。最高可声明 **G0 save green / L2 workflow**；没有三端与 crash-window evidence 时不得写 verified/L3。

#### 8.18.2 P0-C1：ActionHost 与可编辑 Keymap 单一运行时真值

**目标。** keyboard、CodeMirror、menu、context menu、Search Everywhere、Switcher、Cheat Sheet/Keymap Settings 全部从同一个 workspace-scoped `WorkspaceActionHost` snapshot 解析并执行；用户可像 IDEA 一样复制 scheme、增删 shortcut、按键反查、查看冲突、恢复默认。UI 展示和点击执行同一 frozen evaluation。

**非目标。** 不在本包重做每个 command 的业务逻辑，不导入 IntelliJ `.xml` 全量兼容，不绕过 OS 保留快捷键。VS Code preset 只保留 schema 扩展点。

**当前失败复现。** 枚举 `CodeMirrorHost` 的 save/search/signature、`workspaceEditorKeymap`、search/default/history/debug keymaps，与 ActionHost snapshot 对账；证明至少同一 binding 存在不同 owner。证明 `workspaceActionRegistry`/`DEFAULT_WORKSPACE_ACTIONS` 在 production 只是类型/遗留 catalog。证明用户无法编辑 scheme，且 Search Everywhere 隐藏 disabled action。先把这些作为 contract tests/diagnostic snapshot。

**Owner。** `workspaceActionHost.ts`、`useWorkspaceActionsController.ts`、`workspaceCommands.ts`、`workspaceActionRegistry.ts`（迁移/删除 global production catalog）、`CodeMirrorHost.tsx` keymap 装配、`workspaceEditorCommands.ts`、`SearchEverywhere.tsx`、`KeymapCheatSheetDialog.tsx`（改为 Keymap Settings surface 或降级入口）、settings/persistence、`CodeWorkspaceTab.tsx` action 区。

```ts
type ShortcutStroke = {
  code: string;                 // KeyboardEvent.code，保存物理键身份
  key?: string;                 // 仅用于显示/兼容诊断
  ctrl: boolean; alt: boolean; shift: boolean; meta: boolean;
};
type Shortcut =
  | { kind: "keyboard"; strokes: readonly [ShortcutStroke] | readonly [ShortcutStroke, ShortcutStroke] }
  | { kind: "mouse"; button: number; clickCount: 1 | 2; modifiers: Omit<ShortcutStroke, "code" | "key"> };

interface KeymapSchemeV3 {
  schemaVersion: 3;
  id: string;
  name: string;
  base: "idea-windows-linux" | "idea-macos" | null;
  readOnly: boolean;
  bindings: Record<string, readonly Shortcut[]>; // actionId -> shortcuts
  disabledActionIds: readonly string[];
  updatedAt: number;
}

interface ResolvedBinding {
  shortcut: Shortcut;
  candidates: readonly {
    actionId: string;
    evaluation: PreparedActionEvaluation;
    contextSpecificity: number;
    source: "user" | "base" | "builtin-editor";
  }[];
  resolution: "single" | "shadowed" | "conflict" | "unavailable";
  reason?: string;
}
```

**单一 catalog。** Action metadata/handler/when/state 都由 instance host 注册；`DEFAULT_WORKSPACE_ACTIONS` 只能在 migration 中映射旧 ID，迁移完成后不能被 UI/dispatcher import。CodeMirror extension 通过 `createCodeMirrorActionKeymap(host, schemeSnapshot, editorContextProvider)` 生成薄 adapter，adapter 只调用 `host.prepareBinding()`/`executePrepared()`；CodeMirror default/history/search 命令若保留，必须注册成明确 `editor.*` action 并出现在 conflict graph，不能继续藏在 spread keymap 中。

**裁决。** event 先正规化 AltGr、dead key、IME composing 和 OEM code；按 active workspace/window、modal surface、editor focus、when specificity、user override、base scheme 的固定优先级求解。存在两个同 specificity 可执行候选时不执行，返回 `conflict` 并打开 Keymap 冲突项；不可用 action仍出现在 Search/Keymap，展示 disabled reason。Chord 等待有 timeout/Esc/cancel/focus-loss，第一 stroke 不得破坏 IME 输入。

**Keymap 设置交互。** scheme 下拉；Copy/Rename/Delete/Reset；action 树 + 搜索；“Find Actions by Shortcut”录键；每 action 显示快捷键 swatch、Add/Remove；冲突行可跳转另一 action；平台/系统保留键显示 warning；恢复默认可预览 diff。Cheat Sheet 只作为当前 scheme 的只读过滤视图，不再持有自己的 binding 表。

**持久化/迁移。** storage key 按 app profile 而不是 workspace path；schema v3 记录基线版本与 user delta，升级默认 keymap 时只重放 delta。旧静态 binding 不写入 storage；experimental `keymapModel` 只可引用为测试输入，不能搬回 production。损坏 scheme 隔离备份并回退 platform default，设置页显示 recovery diagnostic。

**lifecycle/result。** host 用惰性 state/ref 按 workspace instance 创建，真实 unmount dispose；StrictMode remount 不复用 disposed instance。所有 `ActionResult` 进入统一 result sink：success 可静默，no-op/cancelled/unavailable/conflict/failed 有按 action policy 的 status/notification；async execution带 AbortSignal，关闭 surface 只取消还未产生外部 effect 的动作。

**测试。** ID/catalog reachability；同 action 从 keyboard/menu/context/Search/Keymap 执行的 frozen file/leaf/payload/result 一致；right-click 后换 split不漂移；双 workspace same action ID 隔离；StrictMode mount/unmount；AltGr/IME/non-US/OEM/chord/mouse；冲突/shadow/disabled；scheme migration/corrupt/reset/import-export roundtrip；macOS/Windows/Linux package smoke。QA 增加 Keymap 创建、录键、冲突解决、恢复默认和 disabled Search action。

**Definition of Done。** production 不再直接消费 `DEFAULT_WORKSPACE_ACTIONS` 或 experimental keymap；所有用户快捷键可在 Keymap surface 查到来源；CodeMirror 没有未登记的业务 binding；同一 frozen evaluation 跨入口一致；host disposer 和 result sink 有真实 caller。最高 **G1 Keymap/Action L2**；未跑非 US/IME/三端只能写 wired/workflow partial。

#### 8.18.3 P0-C2：Basic Completion 与真实 jdtls acceptance

**目标。** 把当前 synthetic/wired completion 收口为真实 provider-backed Basic Completion：明确 invocation、identity、resolve、snippet choice/tabstop、additional edits、auto-import、stale/cancel、一次 dispatch/一次 undo。完成后只声明 Basic；Smart/Type-Matching 和 Full Line 仍不可用。

**非目标。** 不在本包建立本地热门依赖候选，不实现 Full Line，不用提高 200 cap 冒充 Smart，不为无 provider 的语言猜 import。

**Owner。** `lspCompletion.ts`、`CodeMirrorHost.tsx` completion/session 区、`EditorGroup.tsx`、`CodeWorkspaceTab.tsx` completion wiring、`useWorkspaceLspSession.ts`、`src/lib/editor/lsp.ts`、必要的 `src-tauri/src/lsp.rs` request cancel/trace、live/postfix template integration 与真实 fixture harness。

```ts
interface CompletionRequestIdentity {
  workspaceId: string; fileKey: string; uri: string; languageId: string;
  documentRevision: number; providerGeneration: number; sessionGeneration: number;
  requestId: string;
  invocation: { mode: "basic"; reason: "typing" | "trigger" | "explicit"; ordinal: number };
}
type CompletionProviderResult =
  | { kind: "available"; identity: CompletionRequestIdentity; items: LspCompletionItem[];
      isIncomplete: boolean; truncated: boolean; evidence: CapabilityEvidence }
  | { kind: "unavailable"; identity: CompletionRequestIdentity; reason: UnavailableReason }
  | { kind: "stale" | "cancelled"; identity: CompletionRequestIdentity }
  | { kind: "failed"; identity: CompletionRequestIdentity; retryable: boolean; message: string };

interface CompletionAcceptancePlan {
  identity: CompletionRequestIdentity;
  changes: ChangeSet;
  finalSelection: EditorSelection;
  snippetSession: { tabstops: readonly SnippetStop[]; choices: readonly SnippetChoice[] } | null;
  label: string;
}
```

**请求与重复调用。** typing 80ms、trigger immediate、explicit immediate 保留但成为设置/telemetry 字段。相同 revision/position 的第二次显式 Basic invocation 令 `ordinal=2`；若 provider 没有扩大 scope 能力，UI 可重新请求并标“provider scope unchanged”，不得声称 IDEA repeated expansion 已对齐。`isIncomplete` 后继续输入按同 session 请求；provider generation/revision/file/language 任一变化先发送 cancel，再丢弃迟到结果。

**resolve/acceptance。** 需要 resolve 的 item 在 acceptance 前进行有界 resolve；timeout/failed 时只在 primary edit 可独立合法时显示“Insert without additional edits”，不得静默丢 import。校验 primary/additional edits 不重叠、URI 在 workspace/允许 library target、revision 与 expected text；构建一个 `CompletionAcceptancePlan`，一次 `view.dispatch` 同时提交主文本、imports 和 selection。一个 undo 恢复所有文本和 caret。choice placeholder 必须弹出可键盘选择列表并保留 Tab/Shift+Tab/Esc；不能继续永远取第一项。

**真实 fixture。** 新建可版本固定的 Java fixture：JDK 21、一个 Maven multi-module、一个 Gradle project、同名类型歧义、dependency source、snippet method、static import、resolve additional edit、provider restart。记录 jdtls distribution/version/JVM、initialize capability、classpath、请求/响应摘要（脱敏且不提交机器路径）。另有 TS/Python 无 provider/inactive/stale 负例，确保不插 Java import。

**UI。** popup 显示 source、truncated、loading/resolve、unavailable/retry；provider offline 可回退 local word/live template，但分组和标签明确 `Local`，不能混成 LSP item。auto-import item 显示将添加的 import；歧义由用户选择。completion setting 至少覆盖 auto-popup、case sensitivity/filter、documentation pane 和 Basic shortcut；Smart shortcut在 C7 前显示 unavailable reason。

**测试与 DoD。** parser/choice/overlap/mapping unit；CodeMirror mounted acceptance/undo/session invalidation；real jdtls completion/resolve/cancel/auto-import trace；provider restart/stale/10k truncated/perf；QA 键盘 popup + choice + undo + offline。真实 jdtls Maven/Gradle 主路径绿、非 Java 负例绿、一次 dispatch/undo 可证明后，Basic 可写 **G1 L2**，对应 Java fixture 可单项写 **G2 evidence L2**；没有 IDEA 实机对照不得写 L3。

#### 8.18.4 P0-C3：Clipboard session、完整 virtual space 与 syntax-aware region

**目标。** 让 copy/cut/paste/multi-caret/rectangle/column mode 在任意 split、EOL、IME 和系统 clipboard 失败下结果稳定且一次 undo；workspace store 生命周期无泄漏；virtual space 覆盖 caret/mouse/paste，不只覆盖 clone command；region folding 不再把 regex token table 称为 grammar-aware。

**非目标。** C3a 不持久化敏感 clipboard 内容，不把未知语言 regex 当 semantic folding。Clipboard History/Paste as Plain Text/Copy Reference 是 C3b/G3，可在 C3a 完成后单独领取。

**Owner。** `workspaceClipboardSession.ts`、`CodeMirrorHost.tsx` clipboard/selection extension、`workspaceEditorCommands.ts`、region fold service/Lezer language adapters、settings schema、`CodeWorkspaceTab.tsx` workspace disposer 和 action wiring。

```ts
interface WorkspaceClipboardHandle {
  readonly workspaceId: string;
  write(payload: Omit<EditorClipboardSession, "sessionId" | "createdAt">): EditorClipboardSession;
  read(): EditorClipboardSession | null;
  clear(reason: "workspace-close" | "user" | "privacy-policy"): void;
  release(): void;
}
interface VirtualSpacePolicy {
  enabled: boolean;
  appliesTo: { keyboard: boolean; mouse: boolean; columnSelection: boolean; paste: boolean };
  maxColumns: number;
}
type RegionFoldResult =
  | { kind: "available"; ranges: readonly FoldRange[]; source: "syntax-tree" | "provider" }
  | { kind: "unavailable"; reason: "language" | "parser-not-ready" | "capability" };
```

**生命周期。** `acquireClipboardStore(workspaceInstanceId)` refcount，每个 workspace host release；refcount 归零立即 clear/delete。workspace A/B 同 path 不共享。系统 clipboard write 失败仍保留当前 session并显示 typed warning；read denied 时只有 session 的 `sessionId/plainText` 与当前系统文本一致才分发 segments，否则明确降级 plain text，避免粘贴旧结构 payload。

**paste plan。** 在 dispatch 前冻结 selections、segments、rectangular、source EOL、target line endings 和 virtual spaces；N segments/N carets 一一分配，单 segment复制给每个 caret，多段与 caret 数不匹配按文档化规则循环或整块插入，禁止隐式丢段。overlap ranges 先规范化，ChangeSet + selection map 一次 dispatch/undo。read-only/mixed line ending/IME composition 返回 no-op/unavailable，不部分修改。

**virtual space。** 使用 CodeMirror StateField/Decoration 表示视觉列和实际 padding plan；Arrow/End/mouse/column selection/clone/paste 共用 resolver。只有产生输入时才插入必要 spaces/tabs，并按 effective tab/indent policy 计算；关闭设置时 caret 收敛到行尾但不改文档。覆盖 wide glyph、tab、emoji/grapheme、proportional fallback 和 CRLF。

**region。** 每种 production language 只能选择已有 Lezer syntax tree 或 provider folding range/tag；marker 必须位于 comment node，字符串/template/raw string 内拒绝，nested/同名/missing end 有确定行为。parser 未 ready/未知语言返回 unavailable，绝不全文件任意 regex 扫描。若临时保留 token regex，只能重命名 `text-marker folding (heuristic)` 并默认关闭，不计 G1 semantic folding。

**C3b 高级 clipboard。** session-only ring 默认最多 50 项且总计 1 MiB，单项上限 256 KiB；支持 Paste from History、Paste as Plain Text、Copy Reference、Clear、Disable。默认不落盘，password/secret input、binary、大于上限内容不进入历史；Copy Reference 由 file identity + line range 生成，不从 display path 猜测。设置/隐私文案与清除动作可访问。

**测试与 DoD。** 双 workspace acquire/release、跨 3 leaf、segments/caret 矩阵、rectangle/overlap/Esc、system denied、stale session、LF/CRLF、virtual space mouse/keyboard/paste/IME、Java/TS/Python/Go/Rust/Markdown syntax comment fixture、字符串误匹配。C3a 可达 **G1 L2**；C3b 与 region semantic 分项记 G3，不相互补偿。

#### 8.18.5 P0-C4：真实 Switcher、tab policy 与 split workflow

**目标。** 在现有 recursive layout 上完成 IDEA-like 日常 tabs/splits/Switcher：真实 MRU 文件与实际 open tool windows、原 leaf 激活、Backspace close、preview/pin/reopen、tab limit/order/open-close policy、opposite split/equalize/stretch。复杂 detach 是独立 G3 子包。

**非目标。** 不重新引入 primary/secondary 固定布局，不复制 buffer/LSP/save owner到每个 view，不在 C4a 实现 Tauri 多窗口 detach。

**当前失败复现。** `TabSwitcher` 对 `entries.length===0` 返回 null；tool windows 是 7 项常量且不反映 open/available/MRU；file entry没有 `leafId/viewId`；commit 通过 `openFile(target.ref)` 走当前 active group；无 Backspace close。分别新增 pure component 与 mounted recursive-layout 红测。

**Owner。** `TabSwitcher.tsx`、workspace navigation/switcher controller、BottomDock/ToolWindow registry、`recursiveLayoutTree.ts`、`workspaceLayoutPersistence.ts`、`codeWorkspaceStore.ts`、tab strip/EditorGroup、settings schema、`CodeWorkspaceTab.tsx` layout/navigation 区。

```ts
type SwitcherEntry =
  | { kind: "editor"; fileKey: string; leafId: string; viewId: string;
      title: string; path: string; dirty: boolean; pinned: boolean; preview: boolean; lastUsedAt: number }
  | { kind: "tool-window"; toolWindowId: string; available: boolean; open: boolean;
      lastUsedAt: number; disabledReason?: string };
interface TabPolicyV2 {
  schemaVersion: 2;
  limitPerLeaf: number;
  order: "mru" | "alphabetical" | "open-order";
  openPosition: "end" | "after-active";
  activateOnClose: "mru" | "left" | "right";
  pinnedRow: "same" | "separate";
  previewEnabled: boolean;
  reusePreview: boolean;
}
interface ClosedTabEntry {
  fileIdentity: string; ref: OpenFileRef; leafPath: readonly string[];
  selection: EditorSelectionRange | null; scrollTop: number; closedAt: number;
}
```

**Switcher controller。** 从 layout leaf/view registry 与 ToolWindowRegistry 订阅 snapshot，按真实 `lastUsedAt` 排序；editor list为空但有 tool windows 仍渲染。`workspace.switcher` 的 shortcut完全由 C1 scheme（IDEA default `Ctrl+Tab`）解析，不硬编码 macOS `Meta+Tab`。按住修饰键循环、Shift 反向、release commit、Esc cancel、hover只 preview。Backspace 对 editor entry 调统一 close action：clean直接关闭，dirty进入确认并冻结所选 entry；tool window Backspace按策略 hide而非销毁。关闭后选择邻近有效 entry，空列表关闭 surface。

**leaf identity。** entry 激活必须调用 `activateFileInLeaf(fileKey, leafId, viewId)`；leaf 已关闭时按 stable tree path 找最近 sibling，再显式报告 relocated，不能静默用当前 leaf。相同文件多 view各自作为 entry或按设置合并，但无论哪种模式都保留目标 view selection/scroll。

**tab policy。** limit只驱逐 unpinned clean preview/least-recent candidate；dirty/pinned 永不静默关闭，达到不可驱逐状态时允许超限并显示 reason。alphabetical只改变显示顺序，不改变 MRU；preview单击、pin/双击、close active选择、reopen closed均走 reducer。Closed stack 每 workspace session 最多 50 项，不保存正文；restore找不到 leaf时迁到最近 leaf并提示。

**split。** actions 包括 Open in Right/Down/Opposite Split、Move Tab to Split、Next/Previous Splitter、Equalize、Stretch/Unstretch、Unsplit/Unsplit All；都通过 tree reducer返回 typed changed/no-op/error，保持 tab multiset、activeKey belongs-to-leaf、node ID唯一、ratio归一、单 buffer owner。坏 snapshot先 validate/migrate，无法修复则备份并回 single leaf recovery，不写回坏结构。

**C4b detach。** 先写 Tauri multi-window spike：主窗口持有 buffer/LSP/save controller，子窗口只持 view lease；定义 crash/reconnect、focus/MRU、关闭 dirty confirm、窗口间 drag cancel 和 app quit顺序。spike未证明单 owner前不得开放菜单，也不得把 CSS 浮层称 detach。

**测试与 DoD。** empty editor/tool-only、real tool registry、Backspace dirty/clean、modifier release/Esc、original leaf/closed leaf/same file multi-view；tab policy reducer/property tests；corrupt snapshot；3+ leaf equalize/stretch/move/restore；200% zoom和键盘 focus。C4a 全绿可记 **G1 L2**；C4b 单独 G3，三端窗口 evidence 前不升级。

#### 8.18.6 P1-C5：Reference Information 完整套件

**目标。** 以一个 workspace-scoped request owner 统一 Parameter Info、Quick Documentation、Type Info、Context Info 和 External Documentation 的 identity/cancel/cache/history，但保留每种结果的独立 payload/capability/UI。先把 Parameter/QuickDoc 主路径做到 G1 L2，再按 provider 证据逐项开放 Type/Context/External。

**非目标。** 不从 hover markdown 推导类型，不从任意 `<a>` 推导 External Documentation，不用 completion detail 冒充 signature，不在本包建立 Java PSI。

**当前失败复现。** production `ReferenceInfoController.request()` 只以 `kind:"documentation"` 调用；provider callback 收到 signal，但内部 `lspHover()` 不接 signal，只在返回后检查 aborted；controller 的所有 available result 共用 `QuickDocContent`。先新增 provider-deferred test，证明 cancel 没有到达 IPC；再为 Type/Context/External action加 unavailable contract test。

**Owner。** `referenceInfoController.ts`、`referenceDocumentation.ts`、`QuickDocPopup.tsx`、`DocumentationPane.tsx`、`CodeMirrorHost.tsx` hover/signature extension、`intelligencePreferences.ts`、`CodeWorkspaceTab.tsx` reference actions、`src/lib/editor/lsp.ts` 与 `src-tauri/src/lsp.rs` 可取消请求边界。

```ts
interface ReferenceIdentity {
  workspaceId: string; fileKey: string; uri: string; languageId: string;
  position: LspPosition; documentRevision: number; providerGeneration: number;
  requestId: string;
}
interface ParameterInfoPayload { signatures: SignatureInformation[]; activeSignature: number; activeParameter: number; }
interface DocumentationPayload { title: string; markdown: string; sourceLocation?: LspLocation; }
interface TypeInfoPayload { displayType: string; declaredAt?: LspLocation; }
interface ContextInfoPayload { symbol: string; enclosing: readonly { kind: string; name: string; location?: LspLocation }[]; }
interface ExternalDocumentationPayload { urls: readonly { label: string; url: string; providerId: string }[]; }
interface ReferencePayloadMap {
  parameter: ParameterInfoPayload;
  documentation: DocumentationPayload;
  type: TypeInfoPayload;
  context: ContextInfoPayload;
  "external-documentation": ExternalDocumentationPayload;
}
type ReferenceResult<K extends keyof ReferencePayloadMap> =
  | { kind: "available"; identity: ReferenceIdentity; payload: ReferencePayloadMap[K]; evidence: CapabilityEvidence }
  | { kind: "unavailable"; identity: ReferenceIdentity; reason: UnavailableReason }
  | { kind: "stale" | "cancelled"; identity: ReferenceIdentity }
  | { kind: "failed"; identity: ReferenceIdentity; retryable: boolean; message: string };
```

**provider cancellation。** TS client为每个 request生成 native request ID；Rust LSP session暴露可取消 handle，AbortSignal触发 `$/cancelRequest`（provider支持时）并立即使前端 ticket stale。provider不支持 cancel时仍丢弃迟到结果，但 evidence 标 `transportCancellation:false`。caret/file/revision/generation/kind 重请求、popup close、workspace unmount都走同一 abort path。不得把 abort后的 `null` 记为 no-symbol。

**Parameter Info。** 明确括号/逗号 trigger 与显式 action；settings 为 `autoPopup/delayMs/showFullSignatures`，重载、active signature/parameter、nested call、caret离开range、edit/reparse均可更新/关闭。显式请求无 provider显示 unavailable status，自动请求可静默关闭但记录 diagnostic；结果不进 QuickDoc history。

**Quick Documentation。** hover与显式 action共享 cache envelope，但不同 trigger policy；支持 popup/tool window、pin/follow/lock、back/forward、source、copy；cache key含 URI/position/revision/generation/kind。hover设置关闭时只禁自动入口，不禁显式 QuickDoc。source link使用 canonical file identity并遵守 library read-only。

**Type/Context/External。** provider adapter必须显式实现该 kind；普通 LSP 没有对应能力时显示 unavailable，不尝试正则。External URL只能来自结构化 provider result，允许 `https`，可配置允许 `http`，拒绝 `file/javascript/data` 和凭据 URL；打开前经过应用 external-link policy。Context Info 使用 provider/document-symbol范围只在证据明确时开放。

**presentation/a11y。** popup与 tool window共享内容组件但不共享 focus owner；Esc/外点关闭、pin后focus、back/forward、source跳转、resize pointer capture/unmount/window blur对称清理。role/name/live region、键盘toolbar、focus return、200% zoom、窄窗口collision、high contrast均有测试。

**持久化。** settings schema逐字段迁移；history默认 session-only最多50项，不保存 provider markdown到磁盘；workspace关闭清 cache/history。pinned tool-window状态可保存 target identity，但 reopen必须重新请求，不显示过期正文为 current。

**测试与 DoD。** 五 kind available/unavailable/stale/cancel/failed矩阵；实际 AbortSignal到 Rust/LSP mock；hover delay取消；nested signature/overload；history/pin/source；危险URL；provider restart/two workspace；a11y/zoom。Parameter + QuickDoc 主路径可记 **G1 L2**；Type/Context/External分别记 G2 L1/L2，不能用 suite 总体 complete。

#### 8.18.7 P1-C6：Java usages、provider diagnostics 与 refactor 证据

**目标。** 以真实 jdtls fixture 建立 Java semantic capability ledger，并补齐 IDEA-like Show/Find Usages 结果工作流；准确区分 provider diagnostics presentation 与 inspection engine；Rename/Safe Delete/provider refactor逐项证明 preview/conflict/apply/undo。

**非目标。** 不宣称自有 PSI/stub index/CFG/data-flow，不把 jdtls ready当 complete index，不在本包实现 SSR，不用正则补 Java semantic fallback。

**Owner。** 新建薄的 `workspace/javaSemanticEvidence.ts` 或等价 adapter（不得建立平行 parser/index）、`ReferencesPanel.tsx`、新 `ShowUsagesPopup.tsx`/usages session controller、`inspectionProfile.ts`/`AnalysisPanel.tsx` 命名与文案、refactor preview/apply/history、`CodeWorkspaceTab.tsx` usages/refactor actions、`src/lib/editor/lsp.ts`、`src-tauri/src/lsp.rs` jdtls trace/commands、fixture harness。

```ts
interface SemanticRequestIdentity {
  workspaceId: string; fileKey: string; uri: string; position: LspPosition;
  documentRevision: number; providerGeneration: number; projectFingerprint: string;
  requestId: string;
}
interface UsageItem {
  id: string; uri: string; path: string | null; range: LspRange;
  role: "declaration" | "read" | "write" | "unknown";
  owner: "workspace" | "dependency-source" | "decompiled" | "external";
  previewLine: string | null;
}
interface UsageSession {
  identity: SemanticRequestIdentity;
  symbol: { name: string; kind?: string; declaration?: LspLocation };
  scope: "file" | "module" | "workspace" | "workspace-and-dependencies";
  completeness: CapabilityLevel;
  items: readonly UsageItem[];
  groups: readonly { key: string; label: string; itemIds: readonly string[] }[];
  filters: { reads: boolean; writes: boolean; declarations: boolean; libraries: boolean };
  pinned: boolean; state: "loading" | "ready" | "stale" | "failed";
  evidence: CapabilityEvidence;
}
interface RefactorEvidence {
  actionId: string; kind: string; identity: SemanticRequestIdentity;
  scope: CapabilityEvidence["scope"]; completeness: CapabilityLevel;
  conflicts: readonly { severity: "warning" | "error"; message: string; location?: LspLocation }[];
  editRevisionCoverage: readonly { uri: string; version: number | null }[];
}
```

**Show/Find Usages。** `Show Usages` 是轻量 popup：首批有界结果、键盘过滤、Enter跳转、Open in Find Tool Window；`Find Usages` 创建可 pin session，按 project/module/file/usage type分组，支持filter、preview、rerun、cancel和source/decompiled read-only。96项上限只能作为批次，不是静默截断；结果必须标 truncated/completeness并允许继续/转完整搜索。rerun冻结原 symbol identity；symbol无法重定位时标 stale并要求重新选择。

**project fingerprint。** 由 workspace root、module/source set、language level、JDK、classpath/dependency state、jdtls generation组成；pom/gradle/classpath/provider restart变化整代失效。dirty overlay带 document revision；不得在旧 generation结果上apply refactor。jdtls progress仅显示 indexing状态，不自动将 completeness提升 complete。

**diagnostics/inspection 分账。** 将用户可见设置准确命名为“Diagnostic Presentation Profile”，字段只控制客户端显示/severity override/filter；保留 raw provider diagnostics供 quick fix/evidence。若 jdtls提供可配置 inspection/formatter setting，建立独立 provider settings adapter并显示 applied/unsupported/restart-required。没有 provider control时不得出现“已禁用 inspection engine”的文案。`inspectionEvidence.ts` 只生成 evidence/provenance，不执行分析。

**refactor。** Rename先 prepare、采集 provider edit/evidence、展示 usages/preview/conflicts；Safe Delete在无完整 references/declaration、dependency/external target或未解决项时硬阻断；Extract/Inline/Move/Change Signature按 provider `CodeActionKind`/command逐项登记。Apply前重新校验 generation/revision/hash/root/versioned edits；C0 effect ledger记录多文件部分结果。conflict warning由用户确认，error禁止apply。undo恢复所有可恢复文件并报告不可恢复resource operation。

**真实 fixture matrix。** Maven multi-module + Gradle：同名类、overload/generic、inheritance、static import、test/main source set、generated source、dependency source/decompiled、跨模块rename、外部未保存编辑、provider restart、broken classpath。每个 fixture固定 jdtls/JDK/build tool版本，保存脱敏 request/response摘要和 IDEA 2026.2 expected snapshot；差异逐项记录，不硬改期望让绿色。

**测试与 DoD。** usages grouping/filter/pin/rerun/stale/preview；Show->Find handoff；diagnostic raw/presentation隔离；rename/safe delete/refactor conflict/partial apply/undo；real jdtls navigation/usages/diagnostic/quick fix/rename trace；library source read-only。每个 capability独立状态，例如 `Java Rename: L2 provider-backed`；没有完整性证据不得称 Java Semantic Profile完成，永不宣称 PSI parity。

#### 8.18.8 P1-C7：Smart/Type-Matching Completion 与 semantic editing / Surround / Generate

**目标。** 在 C2 Basic 和 C6 Java evidence 之上增加可证明的 Smart/Type-Matching Completion、语义 postfix/Complete Statement、Surround With 与 Generate Code。语义不足时 action保留可发现但显示 unavailable；local text template必须明确标 Local Template。

**非目标。** 不从 experimental `surroundGenerateModel.ts` 直接恢复固定文本并宣称 semantic；不让 regex推导类型；不要求所有语言同日支持。

**Owner。** C2 completion session、ActionHost definitions、language semantic adapter、`workspaceEditorCommands.ts` 的 statement/surround入口、Live/Postfix Template provider、CodeAction/execute-command bridge、preview/undo、settings与QA。优先 Java/jdtls，其它语言逐 capability接入。

```ts
type CompletionMode = "basic" | "smart-type-matching";
interface SmartCompletionContext {
  identity: CompletionRequestIdentity;
  expectedTypes: readonly { display: string; providerId: string }[];
  expressionRange: LspRange | null;
  evidence: CapabilityEvidence;
}
type SemanticEditPlan =
  | { kind: "workspace-edit"; title: string; edit: WorkspaceEdit; evidence: CapabilityEvidence }
  | { kind: "editor-transaction"; title: string; changes: ChangeSet;
      selection: EditorSelection; source: "syntax-tree"; evidence: CapabilityEvidence }
  | { kind: "unavailable"; reason: UnavailableReason; detail: string };
```

**Smart Completion。** 单独 action/shortcut和popup badge；只有 provider返回expected type或可验证context时才available。过滤/排序记录 type-match reason，不得把普通 fuzzy score命名 Smart。重复 invocation ordinal、visibility/static/context expansion若 provider无法表达则单独 unavailable/partial。Basic失败不自动冒充 Smart，Smart unavailable可让用户显式回 Basic。

**Postfix / Complete Statement。** postfix applicability来自 syntax node + provider type；变换先生成 previewable plan，import shortening由 provider edit负责。现有 line-regex postfix继续可用时标 `Local/Text`, 不计 semantic。Complete Statement按语言策略验证 parse state并返回 exact edits；不确定时 no-op + reason，不猜 `;`/brace。

**Surround With。** selection必须对齐 syntax range；Java先支持 provider/syntax证据明确的 `if/while/try-catch/synchronized/Runnable` 子集。变量/exception/type选择走 placeholder/choice session；一次 transaction或一个 WorkspaceEdit history entry。跨 partial token、read-only、multi-range不支持时显式 unavailable。

**Generate Code。** 通过 provider CodeAction/execute command获取 constructor/getter/setter/override/equals-hashCode/toString等候选；dialog显示成员checkbox、placement、conflicts与将添加imports。提交前复核 class identity/revision/generation；生成后一个 undo恢复。没有 provider结果时只显示本地 Live Template分类，不能硬编码字段扫描。

**测试与 DoD。** Java expected type/generic/overload/null/context；Smart vs Basic结果 provenance；syntax selection边界；Surround placeholder/undo；Generate成员选择/conflict/stale；provider unavailable和TS/Python负例；IDEA fixture逐项截图/结果对照。每个 action/语言单独升 L2/L3；包整体永不写“all languages complete”。

#### 8.18.9 P2-C8：SSR、dependency completion、Full Line 与高级伴随子包

C8 包含五个 owner独立的 G3 子包，可分别领取和合并，但每个都依赖 C1 action/keymap和 C9 evidence contract；不得以其中一个完成提升其它子包。Search Everywhere 的 Settings/UI/Git provider scope、scratch/injection 和 Code Vision 仍是未排期 companion backlog；G1 只要求现有六类搜索与 action 可发现性，不得把这些未排期项写成隐式完成。

##### 8.18.9.1 C8-A Structural Search and Replace（Java 首批）

**目标/边界。** 只对官方明确支持且本地 parser/provider可证明的语言开放；首批 Java。query是语法pattern + typed variables + scope/filter，不是正则查找换皮。Kotlin/Scala/Groovy没有 parser/provider前显示 unavailable。

```ts
interface StructuralQuery {
  schemaVersion: 1; languageId: string; pattern: string;
  variables: Record<string, { minCount: number; maxCount: number | null; text?: string;
    type?: string; reference?: string; invert?: boolean }>;
  scope: "file" | "module" | "workspace";
  replacement?: { template: string; shortenImports: boolean; reformat: boolean };
}
```

选择 tree-sitter/Java parser或 provider structural query前先做 ADR，要求 parse-error、comments/string、generic/anonymous/nested class和language level fixture。搜索流式、可取消、有上限/继续；replace先生成 preview + conflict + C0 WorkspaceEdit ledger，逐match可排除，一个undo。保存query schema迁移；导入IDEA模板只有在真正兼容字段时开放。删除的 `structuralSearchModel` 不得以旧文本实现恢复。DoD要求 syntax false-positive为0的固定fixture、replace/undo、large-workspace cancel/perf和IDEA结果对照；否则L0/L1。

##### 8.18.9.2 C8-B Maven/Gradle dependency completion

**目标/边界。** 在 `pom.xml`/Gradle依赖坐标位置使用真实 project/provider/registry metadata，支持group/artifact/version、当前仓库、offline/cache、timeout/cancel；不维护“popular dependencies”硬编码列表。

```ts
interface DependencyCompletionRequest {
  identity: CompletionRequestIdentity;
  ecosystem: "maven" | "gradle";
  coordinatePart: "group" | "artifact" | "version";
  prefix: string; repositories: readonly { id: string; url: string; trusted: boolean }[];
  offline: boolean;
}
```

owner应位于 project/dependency provider层而非 CodeMirror；结果进入 C2 completion envelope并标 repository/cache来源、freshness、prerelease/vulnerability信息（若真实来源可用）。网络请求遵守代理/凭据/allowlist，日志脱敏；offline只读本地cache。replacement range由host parser决定，provider只返回结构化候选。experimental `dependencyCompletion.ts` 仅可作输入fixture，不能 production import。测试使用本地 fake Maven repository/Gradle metadata server，覆盖timeout/cancel/offline/恶意URL/同generation stale；真实网络不是单测前置。

##### 8.18.9.3 C8-C Full Line local completion

**目标/边界。** 对齐 IDEA Ultimate bundled Full Line的可观察编辑工作流：local model、edition/hardware/language gate、ghost text、整段/逐词/逐行接受、Esc/reject、auto-import、隐私与模型状态。它与 popup completion、AI selection和Terminal FIM完全分账。

```ts
interface FullLineRuntimeStatus {
  editionEnabled: boolean; hardware: "supported" | "unsupported" | "unknown";
  model: { languageId: string; version: string; state: "missing" | "downloading" | "ready" | "failed" } | null;
  privacy: { localOnly: true; telemetryContentFree: true };
}
interface FullLineSuggestion {
  request: CompletionRequestIdentity; text: string; range: { from: number; to: number };
  segments: readonly { kind: "word" | "line"; from: number; to: number }[];
  additionalEdits: readonly LspTextEdit[]; modelVersion: string;
}
```

runtime必须在后端隔离线程/进程，探测AVX2 x64或ARM64，内存/CPU/取消有上限；模型文件hash/signature/version/许可可验证，下载失败可恢复。默认不发送源码/路径；telemetry只记content-free latency/reason。CodeMirror ghost text是StateField，不改doc/history/selection；typing/caret/revision/generation/provider result变化立即取消。Accept all/word/line均走C1 action和一次transaction，additional import与文本同一undo。实验 `fullLineCompletionModel` 只作fixture。没有可分发local模型/硬件/edition策略时保持明确 unavailable，不做远端fallback冒充。

##### 8.18.9.4 C8-D Code Style / Reformat / Rearrange / Cleanup

**目标/边界。** 在现有 `EffectiveCodeStyle`、EditorConfig resolver、LSP format/organize imports和save normalization之上，补可命名/复制的 editor code-style scheme、selection/file/directory scope、rearrange、cleanup、formatter exclusion/marker和save actions。provider只支持document format时，UI只开放该scope，不伪造module/directory能力。

```ts
interface CodeStyleSchemeV2 {
  schemaVersion: 2; id: string; name: string; languageId: string | "shared";
  basedOn: string | null;
  values: Record<string, { value: unknown; source: "scheme" | "default" }>;
  saveActions: { reformat: boolean; organizeImports: boolean; cleanup: boolean };
}
interface FormatPlan {
  identity: SemanticRequestIdentity;
  scope: "selection" | "file" | "directory" | "module";
  stages: readonly { kind: "format" | "rearrange" | "organize-imports" | "cleanup";
    source: "lsp" | "jdtls" | "local-syntax"; edits: readonly LspTextEdit[] }[];
  excluded: readonly { uri: string; reason: "pattern" | "marker" | "read-only" | "unsupported" }[];
  evidence: CapabilityEvidence;
}
```

有效优先级固定为 explicit file override > EditorConfig > selected language/workspace scheme > sniffed fallback，并逐字段显示 provenance；EditorConfig `unset/root=true`、父链/cache/watcher失效有fixture。scope format先扫描能力/排除项再preview，用户可取消文件；每文件edit按C0 effect ledger应用。rearrange/cleanup没有provider或syntax证据时 unavailable，不能将format后文本启发式重排。formatter `off/on` marker必须来自语言配置且只影响对应语法/文本range。scheme copy/rename/delete/reset、坏schema备份迁移、format-on-save stale revision和一次undo均验收；IDEA XML import不在首批，入口必须明确“不兼容”。

##### 8.18.9.5 C8-E Appearance、editor rendering 与 accessibility settings

**目标/边界。** 把现有 `codeViewProfile` 和零散设置收敛成 workspace/editor profile：font family/fallback、size/line height/ligatures、soft wrap pattern与indent、breadcrumbs位置/语言、sticky lines、virtual space/column mode、diagnostic highlighting level、high contrast和单editor/全部editor zoom。Terminal、Markdown、应用theme和formatter code style保持独立。

```ts
interface EditorAppearanceProfileV3 {
  schemaVersion: 3; id: string; name: string;
  font: { families: readonly string[]; sizePx: number; lineHeight: number; ligatures: boolean };
  wrapping: { mode: "off" | "all" | "patterns"; patterns: readonly string[]; indent: number };
  breadcrumbs: { visible: boolean; position: "top" | "bottom"; languages: Record<string, boolean> };
  virtualSpace: VirtualSpacePolicy;
  highlighting: "none" | "syntax" | "all-problems";
  highContrast: boolean;
}
```

运行期只通过 CodeMirror compartments/theme facets更新，不能重建 EditorState、history、selection、fold、scroll或completion session；每个行为prop进入memo/ref comparator contract。字体缺失按fallback链显示实际命中font；zoom不写回font size，单view与全部view语义分开。设置surface有键盘focus顺序、读屏name/description、reset/provenance和200%布局；high contrast颜色使用semantic CSS vars并满足对比度，不把颜色开关称inspection。schema坏值逐字段回退并显示diagnostic，双workspace隔离、rename/copy workspace identity和三端font/IME证据由C9验收。

**C8 DoD。** 五个子包各自拥有 production owner、设置、unavailable UI、unit/host/native/performance/security fixture与IDEA对照；状态表分别登记。任一子包完成都不能提升G1或其它C8子包，C8-D/E也不能用设置项数量替代真实format/render/a11y行为。

#### 8.18.10 Q-C9：QA、native、性能与可访问发布门禁

**目标。** 把“代码路径似乎接上”升级为可重复 workflow evidence；修复当前仅打开 shell/screenshot 的 QA 假覆盖。C9 不是最后补测试的集中包：每个 C0-C8 PR 必须同步 catalog/testid/YAML，C9 最后只汇总跨包和三端发布矩阵。

**Owner。** `qa-ui-auto-tests/feature-list.md`、`qa-ui-auto-tests/cases/TC-IDE-*.testcase.yaml`、必要 browser/native fixtures、focused Vitest/Rust integration、evidence manifest。使用 `qa-ui-auto` skill 执行 audit/run；不要手写不在 catalog 的 selector。`TC-064/065` 保留 shell smoke但不得再标 save/appearance/actions workflow coverage；`TC-auto-F25-1` 继续归 execution/X轨道。

**最低 YAML 用例。** 每个用例必须实际操作并断言结果，不以单张 screenshot结束：

| Case | 核心步骤/断言 | 模式 |
|---|---|---|
| `TC-IDE-C0-01` | 编辑 -> deferred save -> 再编辑 -> stale提示/dirty保持 -> 磁盘内容核对 -> 再保存 | native |
| `TC-IDE-C0-02` | save in-flight -> close/unmount -> recovery ledger显示 committed/unknown，不复活buffer | native |
| `TC-IDE-C1-01` | 新建Keymap scheme -> 录键 -> 查看/解决冲突 -> 四入口执行同action -> reset | browser + native keyboard |
| `TC-IDE-C2-01` | 真实jdtls completion -> choice/snippet -> auto-import -> 一次undo全部恢复 | native + provider fixture |
| `TC-IDE-C3-01` | split A矩形copy -> split C多caret paste -> undo -> clipboard denied提示 | native |
| `TC-IDE-C4-01` | 3 leaf/tabs -> Ctrl+Tab cycle -> Backspace close -> release到原leaf -> restore layout | browser + native keyboard |
| `TC-IDE-C5-01` | hover delay取消 -> QuickDoc popup/pin/history/source -> Parameter overload -> unavailable Type | browser + provider fixture |
| `TC-IDE-C6-01` | Show Usages -> Find Tool Window -> filter/preview/pin/rerun -> provider restart stale | native + jdtls |
| `TC-IDE-C6-02` | rename preview/conflict/apply -> multi-file结果 -> undo -> post-condition | native + jdtls |
| `TC-IDE-C7-01` | Smart unavailable/available区分 -> Surround/Generate -> stale取消/undo | native + jdtls |
| `TC-IDE-C8-*` | SSR syntax false-positive、dependency offline、Full Line partial accept、scope format/cleanup、appearance state-preservation按已实现子包分别建立 | native |

**测试层次。** pure reducer/parser用Vitest/property；mounted host验证真实 React/CodeMirror event和undo；Rust unit验证bytes/LSP mapping；Rust integration启动temp workspace/fake provider；browser YAML验证surface；Tauri native验证真实IPC、filesystem、clipboard、keyboard/IME/window。mock provider结果不能替代真实jdtls case，native screenshot不能替代磁盘/hash assertion。

**三端设备矩阵。** Linux/Windows/macOS各记录 OS build、WebView、CPU arch、键盘布局（至少 US + 一种非 US）、IME、display scale 100/200%、字体、filesystem类型、jdtls/JDK版本、app package hash和时间。必测路径：shortcut/AltGr/IME、clipboard permission、case/path/UNC或symlink等平台特性、locked file/atomic replace、watcher、layout restore、external link。某平台未跑时相应 capability只能写 platform-unverified。

**性能预算。** 先提交可重复 harness和基线，再以预算阻断回归：普通编辑 key-to-paint p95目标不高于50ms；本地action/Switcher打开p95不高于100ms；completion分解 debounce/IPC/provider/paint并显示取消率，不能只报总平均；10k候选、1MiB file、10k-file workspace、3+ splits有长任务/内存采样；Full Line单列模型加载/首token/内存。若现有环境无法稳定达到目标，必须记录基线、回归阈值和原因，不能删除采样。

**a11y。** 仅键盘完成每个case；dialog/menu/listbox/tab语义、accessible name、focus trap/return、screen reader announcement、high contrast、200% zoom、reduced motion、窄viewport无重叠。自动axe类检查只是起点，至少在三端各一次人工键盘/读屏 smoke。

**evidence manifest。** 每个 capability记录 `commit/app version/fixture/provider+version/platform/commands/result/artifact path/timestamp/known gaps/highest claim`。日志去除源码、用户名、绝对home路径和凭据；失败证据同样保留。历史 1040 Vitest/62 Rust结果登记到 `c083008e`，不能当新提交证据复用。

**Definition of Done。** QA audit无本包新增 stale/orphan selector；所有 G0/G1 required cases实际运行，三端发布矩阵无数据安全/不可操作阻断；性能与a11y manifest完整；未运行项显式为红/未验证。只有此时才可把 G0 标 green、G1 标 release-ready。G2/G3仍按单 capability evidence升级。

#### 8.18.11 合并顺序、owner 冲突与回报模板

1. C0先冻结 save result；C6不得在旧 save result上实现refactor apply。
2. C1先冻结 action/keymap；C2-C8新增入口不得自行安装 window/CodeMirror业务keybinding。
3. C2冻结 provider identity/cancel/evidence；C5-C8复用，不另造 request generation。
4. C3和C4可在C1后并行，但都改 `CodeMirrorHost.tsx`/`CodeWorkspaceTab.tsx` 时必须先划定 clipboard 与 layout区域并分提交。
5. C6依赖C0/C2/C5；C7依赖C6 semantic evidence；C8三个子包只依赖其实际需要的前置，不强行大批量合并。
6. C9 fixture/catalog与所属包同PR；三端最终gate单独提交evidence，不为过测试改 production semantics。

coding agent 最终回报使用以下固定格式：

```text
包 ID / commit
Production call chain
修改的 owner 文件（无关文件必须为 0）
失败复现 -> 修复后结果
接口/schema/迁移
cancel/stale/error/disk or undo effect
Unit / host / Rust / QA / native / IDEA fixture 命令与结果
未运行项
最高可声明 capability + L0-L3
残余风险与后续包
```

### 8.19 v4.50-v4.61 历史实施合同与 R0-R8 as-built（HEAD `69165486dee1` -> `f572c6b8`）

> **历史合同，禁止继续领取。** 本节保留 R0-R8 的接口、提交与证据记录；当前状态以 §2.30 为准，当前任务只从 §8.20 领取。下表 `[x]` 表示对应历史包按当时合同交付，不表示 G0/G1 release-ready，也不覆盖该行记载的 native/provider/IDEA 未验证项。

#### 8.19.0 状态、依赖和通用合同

| 顺序 | 包 | 当前状态 | 目标 | 依赖 |
|---|---|---|---|---|
| 1 | [x] **R0 Save/recovery/WorkspaceEdit effect closure** | 生产缺陷已确认，G0 红 → **代码合同已闭合（v4.51，工作树），native/browser 证据未运行** | 所有写路径共享 effect result/recovery ledger，partial apply 可恢复 | 无 |
| 2 | [x] **R1 Action/Keymap runtime single truth** | editable 基础已接，dispatcher 不完整 → **业务键位全部迁入 ActionHost + typed V2 gate/chord/mouse dispatcher（v4.52，工作树），三端 native 未运行** | 所有用户命令可发现、可改键、可拒绝 IME/AltGr 误触发 | R0 的 typed-result 命名约定 |
| 3 | [x] **R2 QA catalog 与可执行 workflow 修复（v4.61 as-built）** | ~~audit 红、核心 YAML 占位~~ 已修复：lint 0 / catalog current / orphan 0 / gate green；C1、C3–C7 重写为真实交互+断言并实际执行 | 5/6 browser cases 绿（见 §8.19.3 as-built）；C0/C2/C6-02 属 native/provider，环境受阻如实记账 | R9 承接 native 键盘/IME 与 provider manifest |
| 4 | [x] **R3 real jdtls Basic Completion acceptance** | synthetic L2 → **R3-a/b 生产代码合同（cb07c95c）+ R3-c 真实 fixture/runner/trace：五项目九场景 Linux 实机全绿，provider 层 G1 L2（v4.53）** | Maven/Gradle completion/reinvoke/resolve/import/undo 可追溯 ✅（IDEA 对照录制与三端仍开放） | R1；effectful edits 依赖 R0 |
| 5 | [x] **R4 Clipboard/history/plain paste/reference/virtual space** | session/model partial → **history ring V2（sensitive/限额/单删）+ Paste-from-History 弹层、Paste-as-Plain-Text、Copy Reference 候选模型、VisualColumnPosition/overflow StateField + End/click/type/backspace/paste 消费（v4.56）；Settings 接线、region 折叠标签、native clipboard 权限未做** | G1 多光标/视觉列闭环 ✅（jsdom 级），G3 history/reference 分项可用 ✅ | R1 |
| 6 | [x] **R5 Tool-window registry/tab policy/split operations** | 模型+接线 → **R5-a 模型（v4.57）之上，R5-b 全部接线：Switcher 冻结 registry 快照、tabPolicy 随 layout snapshot 迁移读写（backup 留档）、equalize/stretch/unsplit-all/navigation/move-tab reducers+actions、Backspace 分级关闭 + ReopenLocationV2 结构化重开（v4.58）；policy 编辑 UI、order projection/activateOnClose 接线、QA C4 全流程与三端 native 未做** | G1 Switcher/tabs/splits 使用真实状态并持久化 ✅（jsdom 级；L2 待 QA C4 实跑） | R1 |
| 7 | [ ] **R6 Reference Information + Usages/refactor session** | presentation/model partial → **usages session 生产合同（真实 identity/rerun/pin/角色诚实/库过滤）+ 五 kind 类型化服务通道闭合（v4.54）；Parameter Info 改道、refactorApplyGate 第二消费方、真实 trace 未闭合** | G1 Parameter/QuickDoc；G2 usages/refactor 逐项可证明 | R0、R3 |
| 8 | [x] **R7 Semantic editing/Surround/Generate** | 谎报 syntax-tree / try-catch 硬编码 / Generate 只有 filter → **provenance 类型化（local-text/syntax-tree/provider，node evidence 强制）、Surround 五 kind 同一 action/dialog/单事务、Generate 全链路真实 provider CodeAction、Complete Statement Java 首批 syntax-backed + 其余 Local/Heuristic 标注（v4.55）；真实 jdtls trace 与 IDEA 对照未运行** | provenance 诚实，Java syntax/provider 子集可用 ✅（trace/对照仍开放） | R1、R3、R6 |
| 9 | [x] **R8 Advanced suite productionize-or-defer** | 决策+交付：四项 ADR（v4.59）A/B/C **defer**（typed unavailable、零误导入口、重开条件挂账）；R8-D1 scheme 生产 store/管理 UI/provenance（`5ef8609e`）、R8-D2 reformat planner 接管 Format 动作（`62a52adc`）（v4.60）；scheme.saveActions 未消费、exclusion/directory scope 关闭、三端 native 未跑 | 每项有明确产品决策 ✅；Code Style 首批 selection/file 可用 ✅（jsdom 级） | R1；按子项依赖 R3/R6 |
| 10 | [x] **R9 Native three-platform/performance/IME/a11y gate（v4.62 as-built：harness + Linux 首批证据）** | native runner P2 全动词 + workspace_root/vault_first_run/绝对路径隔离 + evidence manifest schema/三端 runbooks/perf+a11y harness；TC-IDE-C0 native Linux 两连绿（磁盘字节级证明）；perf browser 基线（key-to-paint p95 133-135ms 超标已记 finding）、a11y 扫描 0 违例 | C0=native L1（Linux 单平台）；Windows/macOS/IME/非US layout/provider trace/人工 a11y smoke 全部 platform/provider-unverified（见 §8.19.10 as-built） | W7（§8.20.8）承接矩阵汇总与发布门禁 |

固定接口顺序为 `R0 -> R1 -> R3 -> R6 -> R7`。R2 的 catalog ownership 修复可立即进行，随后随每包同步更新；R4/R5 在 R1 action IDs 冻结后可独立实施；R8 子项不能以“整包”领取。触碰 `CodeWorkspaceTab.tsx` 时按 save、action/keymap、completion/reference、layout/tabs、execution 五个区域分提交，X 轨道代码除非是当前包的必要回归不得修改。

所有包共用以下 evidence 语义，不再新造 `wired/complete` 布尔值：

```ts
type CapabilityLevel = "L0" | "L1" | "L2" | "L3";
type EvidenceLayer = "model" | "production" | "browser" | "native" | "provider" | "idea-compare";

interface CapabilityEvidenceRecord {
  capabilityId: string;
  commit: string;
  level: CapabilityLevel;
  layers: readonly EvidenceLayer[];
  provider: { id: string; version: string; generation: number } | null;
  fixtureId: string | null;
  platform: string | null;
  commands: readonly string[];
  artifacts: readonly string[];
  knownGaps: readonly string[];
}
```

`L2` 至少需要 production + executable browser/host workflow；涉及 filesystem、clipboard、keyboard/IME、provider process 的能力还必须有对应 native/provider layer。`L3` 必须再有 `idea-compare` 且三端要求满足。失败 artifact 同样保存，不能删除失败证据只保留绿色摘要。

#### 8.19.1 R0：Save、recovery 与 WorkspaceEdit effect 闭环

**状态与范围。** 保留现有 `PreparedSave`、六 kind `SaveCommitResult`、`WorkspaceWriteAck` 和 owner-generation 机制；修复 ledger 与 closed-file bypass。R0 是 G0 发布阻断，不增加新的格式化功能，也不把跨文件 apply 伪装成数据库式原子事务。

**Owner。** `src/components/editor/CodeWorkspaceTab.tsx` 的 `writeTextSnapshot`/`commitOpenBufferPreparedSave`/WorkspaceEdit adapter；`workspace/saveCommit.ts`、`workspace/workspaceRecovery.ts`、`workspace/workspaceStyleController.ts`、`workspace/workspaceEditApply.ts`、`workspace/workspaceEditHistory.ts`；`src/lib/editor/workspace.ts`；`src-tauri/src/workspace.rs`。Recovery Center 的现有 UI owner只消费新 ledger，不自行推断磁盘效果。

**统一事实模型。** native writer 在改盘前计算旧 bytes hash 和 intended bytes hash；成功 ack 或任何 `effect:"unknown"` error 都必须携带 `intentHash` 与可用的 `writtenHash/writtenByteLength`。前端不得把 logical-text hash 当 encoded bytes hash。

```ts
type DiskResolution =
  | "pending-readback"
  | "confirmed-committed"
  | "confirmed-none"
  | "foreign-blocked"
  | "user-resolved";

interface WorkspaceDiskEffectLedgerEntryV4 {
  schemaVersion: 4;
  workspaceId: string;
  transactionId: string;
  operationId: string;
  path: string;
  expectedOldHash: string | null;
  intendedNewHash: string;
  observedHash: string | null;
  diskEffect: "none" | "committed" | "unknown";
  memoryEffect: "saved-current" | "kept-dirty" | "writeback-discarded" | "unchanged";
  providerEffect: "did-save" | "did-change-current" | "failed" | "discarded" | "not-sent" | "unknown";
  resolution: DiskResolution;
  createdAt: number;
  verifiedAt: number | null;
  resolvedAt: number | null;
}

interface WorkspaceEditOperationEffect {
  operationId: string;
  index: number;
  kind: "text" | "create" | "rename" | "delete";
  sourcePath: string | null;
  targetPath: string;
  result: SaveCommitResult | ResourceOperationResult;
  undoState: "available" | "unavailable" | "applied" | "failed";
}

type ResourceOperationResult =
  | { kind: "committed"; diskEffect: "committed"; path: string }
  | { kind: "conflict" | "failed"; diskEffect: "none" | "unknown"; path: string; message: string; recoveryId: string | null };

interface WorkspaceEditApplyResultV2 {
  transactionId: string;
  disposition: "committed" | "partial" | "blocked" | "cancelled";
  effects: readonly WorkspaceEditOperationEffect[];
  nextOperationIndex: number | null;
  resumeToken: string | null;
}
```

**状态机。** `prepared -> history-snapshotted -> prewrite-validated -> writer-issued -> disk-classified -> memory-merged/discarded -> provider-synced/discarded -> settled`。`writer-issued` 后只能产生 committed、none 或 unknown effect，绝不能退回普通 cancelled。read-back 等于 intended hash即 `confirmed-committed`；等于 old hash即 `confirmed-none`；其它 hash即 `foreign-blocked`；读失败即 `pending-readback`。后两者都阻止自动 retry。`lastVerifiedAt` 不再兼任“已解除阻断”。

**必须修复的现有路径。** `recordUnknownDiskEffect()` 必须写非空 intended hash；v4 blocking predicate 按 `resolution` 判断。所有 `committed-writeback-discarded` 都写 committed ledger row并显示“磁盘已保存，编辑器回写被丢弃”，用户可 Reopen/Compare/Acknowledge。closed-file `writeDisk` 改为调用共享 committer并返回 `SaveCommitResult`，执行 read-back、ledger、watcher/provider effect 分类；caller 不得丢弃 result。WorkspaceEdit 每个 operation 落一条 effect，首次 blocked/failed 后停止；resume 只允许从前序 operation 的 committed/confirmed-none 边界开始，并重新校验所有剩余 hash/revision。undo 逐 operation 回放并报告不可恢复项。

**迁移与 UI。** v3 ledger 迁入 v4 时：`intendedNewHash=null` 的 unknown row一律转 `pending-readback`；有 foreign observed hash 的 row转 `foreign-blocked`，即使旧 `lastVerifiedAt` 非空也不能放行；无法确认的旧 row不得静默删除。Recovery Center 按 workspace/path 分组，显示 expected/intended/observed hash短摘要、operation kind、disk/memory/provider 三轴和 Resolve action；Acknowledge 只解除用户明确选中的 row。

**测试。** pure tests 覆盖三 hash 分类、v3 migration、foreign retry blocking、committed-discarded ledger；mounted host 覆盖 save in-flight 后 edit/close/rename/unmount；Rust 覆盖 LF/CRLF/CR × UTF-8/BOM/UTF-16LE/BE/ISO-8859-1/windows-1252、permission/locked/rename-after-write/crash-window fault injection；WorkspaceEdit 覆盖 open dirty/open clean/closed、create/rename/delete、operation 2 失败、resume、undo partial、双 workspace 同 path。QA 更新 `TC-IDE-C0-01/02`，native 必须核对真实 bytes/hash而非只看 toast。

**DoD 与禁止声明。** repo 内所有文件写入都返回 effect result；unknown/foreign 永不自动 retry；closed-file 与 open-file 走同一分类；partial apply 有可见 effect ledger/resume/undo。未完成 native fault/encoding matrix前最多 `G0 code contract closed / platform-unverified`，不得写 atomic WorkspaceEdit、crash-safe、G0 green 或“数据绝不丢失”。

**R0 as-built（v4.51，2026-08-23，工作树未提交）。** 按 §8.19.11 回报模板：

```text
包 ID / commit / capability ID
    R0 / 工作树（基线 HEAD 69165486dee1，未提交）/ save.integrity, workspace-edit.effect-ledger
As-built production call chain
    save: prepare → history-snapshot → pre-write boundary → writeTextSnapshot
    → Rust encode_workspace_text（encoding 失败=effect:none）
    → write_workspace_bytes（改盘前 read+sha256 得 old_hash；hash 冲突=effect:none
      且携带 intent/old hash）→ 原子 temp+replace（rename 失败且 target 不在=
      effect:unknown + intentHash/intentByteLength/oldHash）→ ack{file,
      writtenHash,intentHash,oldHash,writtenByteLength} → 前端三轴分类 →
      v4 ledger / writeback merge → watcher/git/semantic/LSP provider 效果。
    closed-file: applyLspWorkspaceEditNow.writeDisk → buildPreparedSave(closed:<path>)
    → commitClosedFilePreparedSave（同一 writer/read-back/ledger/watcher 门控，
      返回 SaveCommitResult，applier 消费后才判 applied-disk）。
修改 owner 文件（无关文件数 0）
    src-tauri/src/workspace.rs；src/lib/editor/workspace.ts；
    src/components/editor/workspace/{saveCommit,workspaceRecovery,
    workspaceEditApply}.ts；CodeWorkspaceTab.tsx（save/apply 区域）；
    WorkspaceRecoveryDialog.tsx；对应 5 个测试文件。
旧缺陷复现 -> 新状态机/结果
    unknown ledger intendedNewHash=null → native intentHash 进 error payload，
    recordUnknownDiskEffect 必写非空 intent（仅 pending-readback 迁移行允许 null）；
    foreign observed hash 写 lastVerifiedAt 放行 retry → resolution 状态机
    （foreign-blocked/pending-readback 阻断，verifiedAt 对 blocked 行恒 null），
    v3→v4 迁移强制降级该时间戳；committed-writeback-discarded 不入账 → 四处
    discard 返回点全部写 confirmed-committed 行并进 Recovery Center UI
    （Reopen/Acknowledge，Acknowledge 只清选中行）；closed-file 直写丢弃结果 →
    共享 committer 返回六态结果，unknown 走 read-back 分类，applier 未消费
    committed 即 failed；跨文件 apply 无逐操作事实 → WorkspaceEditOperationEffect
    （result 可为 null：open-dirty 仅内存变更，诚实标注）+
    WorkspaceEditApplyResultV2 disposition/partial 边界/resumeToken，resume 从
    confirmed 边界切片重跑并自然重校验 hash/version，undoState 由 snapshot
    可用性报告。
接口/schema/migration 与 compatibility
    Rust WorkspaceWriteError/WorkspaceWriteAck 新增 intentHash/intentByteLength/
    oldHash（skip_serializing_if None，向后兼容）；前端 v4 ledger 存储 key
    .diskEffects.v4，首读一次性迁移 v3（null intent→pending-readback；foreign→
    foreign-blocked 即使旧 lastVerifiedAt 非空；已证实行保留 verifiedAt；
    不静默删除）；hasUnverifiedUnknownDiskEffect 删除，唯一谓词
    hasBlockingDiskEffectResolution；writeDisk hook 签名改为 Promise<SaveCommitResult>。
cancel/stale/error/disk/provider/undo effect
    cancelled 仅限 prepare/pre-write（closed-file 无此路径）；stale 由 boundary
    校验拦截；error 全部 typed；writer-issued 后只有 committed/none/unknown；
    provider didSave/didChange/not-sent/discarded/failed 如实分列；undo 仍走
    path-snapshot replay，不可恢复项经 undoState/summary 报告。
Unit / mounted host / Rust / QA browser / native / provider / IDEA compare
    Vitest 1138 通过（editor 全目录，含新增 v4 ledger 迁移/阻断/入账、typed
    writeDisk、V2 effects/resume 用例与 close-race ledger 断言）；Rust
    workspace::tests 65 通过（新增 success ack intent+old、hash-conflict
    intent/old、zero-effect intent 用例）；pnpm build 绿；QA audit 数字与
    §2.29.5 基线一致（1 lint feature error=F25.1/F25.3 重复 ownership、137
    orphan，本包新增 2 个 dialog testid 位于既有 orphan 区，归 R2 catalog
    修复）；QA browser workflow、native fault/encoding 矩阵、provider、IDEA
    compare 未运行。
未运行项及原因
    本环境无打包应用/jdtls/多平台真机；TC-IDE-C0-01/02 的真实 disk-hash 操作
    断言属 R2 browser 门禁，本包未领取 R2。
最高可声明 L0-L3 + evidence layers
    G0 code contract closed（production 层，model+production evidence）；
    平台相关完整性 = platform-unverified。不得写 atomic WorkspaceEdit、
    crash-safe、G0 green、“数据绝不丢失”。
禁止声明仍有哪些
    同上；另外 resume 为同会话内确认式重试，不是跨会话事务恢复；Compare
    动作以 Reopen 打开磁盘现状代替独立 diff 视图（后续补）。
残余风险与下一依赖包
    open-clean buffer 经 saveOpenBufferText 间接取得六态结果但 V2 effect.result
    未回填该 SaveCommitResult（hook 仍返回 void），留待 R6 refactor gate 一并
    收口；R1 现可依赖 typed-result 命名约定开工；R2 需先修 F25 重复 ownership。
```

#### 8.19.2 R1：ActionHost 与 Keymap 唯一运行时真值

**状态与范围。** 保留 `WorkspaceActionHost`、frozen evaluation、`KeymapSchemeV3` 和 settings；删除用户命令的旁路。纯文本输入、IME composition 和浏览器不可拦截的 OS 行为不是 action，但所有可见 editor command 都必须有稳定 action id。

**Owner。** `workspace/workspaceActionHost.ts`、`workspace/workspaceKeymapScheme.ts`、`workspace/workspaceCodeMirrorKeymap.ts`、`workspace/workspaceActionRegistry.ts`、`workspace/workspaceCommands.ts`、`workspace/CodeMirrorHost.tsx`、`workspace/KeymapSettingsDialog.tsx`、`workspace/KeymapCheatSheetDialog.tsx`、`CodeWorkspaceTab.tsx` 的唯一 window dispatcher。

**运行时设计。** 建立 `EditorActionBridge`，每个 mounted `EditorView` 注册 action handler与 disposer；`workspaceEditorKeymap/searchKeymap/defaultKeymap/historyKeymap` 中有快捷键的可见命令逐项迁入 ActionHost definition。CodeMirror `keymap.of` 最终只保留无用户快捷键的内部 precedence/IME-safe primitives；任何保留 binding 必须列入 allowlist并解释为何不可配置。Search Everywhere、menu/context menu、toolbar、Cheat Sheet、Keymap Settings 只消费同一 `ActionSnapshot`。

```ts
interface KeyDispatchContextV2 {
  event: KeyboardEvent;
  workspaceId: string;
  targetViewId: string | null;
  composing: boolean;
  deadKey: boolean;
  altGraph: boolean;
}

type KeyDispatchResult =
  | { kind: "executed"; actionId: string; evaluationId: string }
  | { kind: "pending-chord"; prefix: ShortcutStroke; expiresAt: number }
  | { kind: "rejected"; reason: "composing" | "dead-key" | "alt-graph" | "conflict" | "disabled" | "no-match" | "stale-owner" };
```

入口先检查 `event.isComposing`、`key==="Dead"`、`getModifierState("AltGraph")`；这些状态不能触发 action或吞掉字符。按 `KeyboardEvent.code` 匹配、`key` 只显示。chord 第一键只在存在有效第二键时进入 pending；timeout/Esc/focus loss清理并不执行前缀 action。冲突不能靠数组顺序裁决；同 specificity 多 action时拒绝并把候选暴露给 settings。

**Recorder 与 mouse。** Recorder 支持完整一键或二键序列、Backspace 删除最后一 stroke、Esc cancel、Enter confirm，并显示 physical code + layout label。新增 workspace-root capture 的 mouse dispatcher，只有非编辑选择/系统保留手势且命中注册 action时 preventDefault；single/double click和 modifiers按 schema匹配。保留 Ctrl/Cmd-click navigation时也必须成为 action binding或显式不可改的 platform gesture，不能双真值。

**持久化。** `KeymapSchemeV3` 若字段足够可保持版本；新增 recorder/mouse runtime不需要 bump。若引入 platform override/chord timeout则升级 v4，按 action id保留 unknown/orphan bindings并在 UI 标“action unavailable”，禁止迁移时删除用户自定义项。built-in base升级只重放 delta；copy/rename/delete/reset有稳定 active fallback。

**测试与 DoD。** inventory test 断言 production keymap中每个非 allowlist binding都有 action id；同一 action通过 keyboard/menu/Search/context/Cheat Sheet得到相同 frozen target/result；two-stroke、prefix collision、timeout、mouse、unmount/remount、双 workspace、non-US physical code、AltGr、dead key、IME composition、macOS Meta/Windows Ctrl均覆盖。QA `TC-IDE-C1-01` 必须真实创建 scheme、录两键、制造/解决冲突、执行、reset。完成后可写 **Action/Keymap G1 L2 production**；三端 native前不得写 cross-platform verified。

**R1 as-built（v4.52，2026-08-24，工作树未提交；基线 `52da0ebf`）。** 按 §8.19.11 回报模板：

```text
包 ID / commit / capability ID
    R1 / 工作树（基线 52da0ebf，未提交）/ action.single-truth, keymap.runtime
As-built production call chain
    keyboard: window capture dispatcher（CodeWorkspaceTab）→ Switcher 特例 →
    host.dispatchKeydownV2{composing/dead-key/alt-graph 先拒后匹配，
    targetViewId 必须在 EditorActionBridge 注册表} → prepareBinding
    （物理 code 匹配，scheme delta > 定义默认）→ executed{actionId,
    evaluationId}/pending-chord{prefix,expiresAt=+1200ms}/rejected{七种 reason}；
    rejected 一律不 preventDefault（不吞字符）。执行经 executePrepared
    （frozen evaluation + owner/generation 复核）。
    editor surface：CodeMirrorHost mount 时 EditorActionBridge.registerView(fileKey)
    + registerActions(buildEditorHostActions)；CM keymap 只装
    buildEditorPrimitiveKeybindings(true) = Escape 面板栈 +
    closeBrackets/defaultKeymap（filterActionOwned 剔除 action 已拥有的
    Mod-/、Shift-Mod-k、Shift-Alt-ArrowUp/Down 等条目）+ indentWithTab +
    三条本地 Escape 栈；无 host 的独立嵌套走 LEGACY_UNHOSTED_SPREAD（禁止新增）。
修改 owner 文件（无关文件数 0）
    workspaceActionHost.ts（V2 gate/结果/evaluationId/bridge/view 注册表）、
    useWorkspaceActionsController.ts（dispatchKeydownV2 passthrough）、
    workspaceCodeMirrorKeymap.ts（catalog 迁移 16 条业务键位 + allowlist/
    primitive builder + canonical ownership filter）、workspaceCommands.ts
    （KeyboardEventLike.isComposing/getModifierState）、workspaceActionRegistry.ts
    （context.editorView 可选字段）、CodeMirrorHost.tsx（spread 收敛 + bridge
    注册）、KeymapSettingsDialog.tsx（两键 recorder + 点击 swatch 替换）、
    CodeWorkspaceTab.tsx（V2 dispatch + workspace-root mouse dispatcher）、
    新增 workspaceMouseDispatcher.ts；测试 3 新文件 + CodeMirrorHost 测试修正。
旧缺陷复现 -> 新状态机/结果
    IME composition/dead key/AltGr 会误触发或吞字符 → V2 gate 先拒且不
    preventDefault；chord 第一键无 pending 结果语义 → pending-chord 带
    expiresAt，Esc/timeout/focus 变更清理；同 specificity 冲突按数组序裁决 →
    conflict 拒绝并暴露候选（diagnostics/snapshot 不变）；recorder 只录一键 →
    完整 1–2 键序列 + Backspace/Esc/Enter + 物理 code/layout 标签 + swatch
    点击替换；mouse shortcut 只有 schema → workspace-root capture dispatcher
    仅消费命中注册 action 的 click/dblclick，其余手势不拦截；
    workspaceEditorKeymap/searchKeymap/historyKeymap 直装 CM 与 host 双真值 →
    全部迁入 editor.*/workspace.* action（含 undo/redo/find/findNext/findPrev/
    selectSelectionMatches/gotoLine/join/toggleCase/comment/copyLine/deleteLine/
    moveLine/expand/shrink/completeStatement/unselect/tabJumpOut[无绑定]），
    Ctrl+W 统一为 LSP-first+syntax fallback 单 owner。
接口/schema/migration 与 compatibility
    KeymapSchemeV3 保持 v3（未引入 platform override/chord timeout 字段）；
    PreparedActionEvaluation 增 evaluationId（附加字段）；KeyboardEventLike
    增可选 isComposing/getModifierState；无持久化迁移。
cancel/stale/error/disk/provider/undo effect
    dispatched-but-unavailable→rejected:disabled；host disposed/stale view→
    stale-owner；conflict 不执行任何一方；executed 路径 preventDefault+
    stopPropagation 同步发生，执行异步；undo/redo 经 CM history 命令由
    workspace.undo/redo action 承载。
Unit / mounted host / Rust / QA browser / native / provider / IDEA compare
    Vitest editor 全目录 1163 通过（新增 workspaceKeymapRuntime 13 例：
    inventory/allowlist/owned-filter/V2 七类 gate/chord 两键/pending expiry；
    KeymapSettingsDialog recorder 4 例；mouse dispatcher 4 例）+ pnpm build 绿；
    Rust/QA browser/native/provider/IDEA compare 未运行（本包不改 Rust；
    TC-IDE-C1-01 属 R2 browser 门禁）。
未运行项及原因
    本环境无打包应用与多平台键盘/IME；三端 native 由 R9 解除。
最高可声明 L0-L3 + evidence layers
    Action/Keymap G1 L2 code contract（model+production 层）；cross-platform
    verified 禁止。
禁止声明仍有哪些
    不得写 cross-platform verified、"所有平台 AltGr/IME 已验证"、mouse
    gesture 全量可配置（当前仅 left button single/double 且无生产默认绑定，
    Ctrl/Cmd-click 仍为 allowlist 平台手势）；LEGACY_UNHOSTED_SPREAD 仅限
    无 host 的独立嵌入使用。
残余风险与下一依赖包
    defaultKeymap 中 Mod-Enter/Alt-l/Mod-i/Mod-[/]/Alt-A/Ctrl-m 等
    command-primitives 保留于 CM（allowlist 已登记理由），后续逐命令迁移需
    各自 ADR；Search Everywhere/menu/context/toolbar/CheatSheet/Keymap 设置
    已确认全部消费 actionsController.snapshot 单真值。下一包：R3（真实
    jdtls Basic Completion acceptance），R4/R5 在 action id 冻结（本包）后可并行。
```

#### 8.19.3 R2：QA catalog 与可执行 workflow evidence

**状态。** 当前必须从红灯基线修起：1 lint error、catalog stale、137 orphan selectors、4 broken cases，且编辑器 C0–C7 case 多为占位。R2 不修改 production 行为来迎合 selector；发现产品缺口时保留 failing case并回到对应 R 包修复。

**Owner。** `qa-ui-auto-tests/feature-list.md`、`qa-ui-auto-tests/cases/TC-IDE-*.testcase.yaml`、当前四个 broken case、相关 fixture/bootstrap；若确需新增 testid，只由行为 owner在对应 R 包修改组件。本包先解除 F25.1/F25.3 对 `workspace-editor-appearance-settings-dialog` 的重复 ownership，为每个 control指定唯一 feature owner；重新生成/更新 catalog后再清 orphan，禁止批量删除仍真实存在的 control。

**用例最低行为。** C0 核对 disk hash/dirty/recovery；C1 编辑 scheme/chord/conflict/reset；C2 启动 fixture provider、接受 choice+import、一次 undo；C3 跨 leaf rectangle/history/plain paste/denied；C4 建 3 leaf、切换 tool/editor、Backspace、reopen/policy restore；C5 取消 hover、QuickDoc pin/history、Parameter overload和 unavailable Type；C6 Show->Find、pin/rerun/stale及 rename conflict/apply/undo；C7 至少证明 heuristic 标签、syntax unavailable和 provider Generate候选。每例必须包含 interaction + state/result assertion，截图只能作辅助 artifact。

**模式边界。** browser 只验证 store/UI/action；native 验证 filesystem、system clipboard、physical keyboard/IME/window；provider fixture验证真实 jdtls process/request；三者不得互相替代。fixture准备失败必须报告 `environment-blocked`，不能回退 stub后仍标 passed。case metadata记录 capability id、required mode、fixture id和最高 claim。

**DoD。** audit 为 0 lint error、catalog current、0 broken case；orphan 为 0或每项有 owner-approved allowlist/reason/expiry；所有 G0/G1 required YAML实际执行并保存 report。R2只解除 browser/catalog门禁，不单独升级 G0/G1；native/provider仍由 R3/R9解除。

**R2 as-built（v4.61，2026-08-25）。** 按 §8.19.11 模板回报。

```text
包 ID / commit / capability ID
    R2 / 本提交（基线 HEAD 867dd74a）/ qa.catalog-integrity, qa.browser-workflow-evidence
静态门禁（audit --gate 实测）
    修复前基线复现：1 lint error（F25.1/F25.3 重复声明 workspace-editor-appearance-settings-dialog）、
    catalog STALE、137 orphan selectors；文档记录的 4 个 broken case（TC-007/010/TC-auto-F25-1/TC-auto-F7-5）。
    修复后：lint 0 errors（140 cases / 80 features / 1048 controls）；catalog up to date；
    orphans 0；coverage-baseline 重定基 346/369 required covered，gate exit 0。
主要修复
    ① F25.1/F25.3 所有权去重：appearance dialog 唯一归属 F25.3；
    ② catalog 先重生成再清 orphan：137 个 orphan 全部以三类手段闭合——为真实控件补声明/
      alias（app-main-menu→F1.8 新统一菜单块；text-input-dialog 三件套→F-Confirm-1；
      app-theme-dark/light/system 以 aliases 归 F5.5 theme-options；terminal-context-font-*→F2.2；
      capture-menu-dropdown；download-prompt-dialog（无 testid 的 role+has-text 选择器）→F7.2）；
      用例改写为从已声明控件派生（[data-testid="context-menu"] >> text=… 统一菜单/右键菜单族，
      tunnel-manager/tunnel-editor/session-editor/sftp-*-pane/welcome-panel/settings-panel/
      multiexec-bar/capture-menu-dropdown 等容器派生）；死控件对应步骤按现状重写或删除；
    ③ 死 testid 清理：menu-bar/menu-terminal/menu-sessions/menu-view/menu-help、compact-* 全家、
      welcome-open-chat-tao、welcome-activity-pane-* 在产品中已不存在——F1.8 改写为统一主菜单
      （ControlBar app-main-menu），F1.4 标记"已移除"占位并删除 TC-auto-F1-4，TC-101/TC-001/
      TC-035/TC-041/TC-055/TC-100/TC-auto-F1-8/F1-9/F6-4 改写到现存 UI；
    ④ C0–C7 九个 YAML 全部由占位重写为真实 interaction+state 断言，metadata 记录
      capability id/required mode/fixture id/最高 claim；新增 jdtls_required fixture
      （JDK 探测，缺失即 FixtureSkip=environment-blocked，绝不回退 stub 标 passed）与 schema 枚举。
browser 执行（Vite dev，runner 实跑，report 存 qa-ui-auto-report/run-*）
    ✅ TC-IDE-C3-01 / C4-01 / C5-01 / C6-01 / C7-01 共 5 例通过；
    ❌ TC-IDE-C1-01 保持失败：Search Everywhere 输入触发 useWorkspaceTreeData
    "Cannot read properties of undefined (reading 'length')" 渲染崩溃（console 已存档）——
    按 §8.19.3 约定保留 failing case，修复归编辑器 shell owner 包；
    ❌ TC-IDE-C0-01/C2-01/C6-02 属 native/provider mode：本环境无 tauri-driver 与 jdtls fixture，
    记 environment-blocked，不得标 passed。
产品缺陷（非 selector 漂移）修复
    src/stubs/tauri-core.ts 对未知命令 resolve(undefined) 使 useWorkspaceGitSnapshots 在浏览器
    预览把 undefined 写入 gitRoots，添加首个 workspace root 即整页 React 崩溃——stub 补实现
    workspace_detect_git_roots 返回 []；vite.config.ts 增加 server.watch.ignored 忽略
    qa-ui-auto-report/**，消除 runner 落盘 artifact 引发的整页 reload 风暴。
新发现待办（不属 R2 DoD）
    Ctrl+Shift+T 双义：最后编辑器标签关闭后欢迎面接管该 chord 启动本地终端而非 reopen
    （C4 console 存档）；TC-IDE-C1 崩溃栈同上；两者归后续编辑器 shell 包。
禁止声明
    本包不升级 G0/G1；不宣称 native/provider workflow evidence；C0/C2/C6-02 未执行；
    "全部 G0/G1 browser cases 绿"仅指上列 5 例，不含 native 键盘/IME/a11y；R9 前维持
    §2.29 红线结论。
```


#### 8.19.4 R3：真实 jdtls Basic Completion 与 acceptance

**状态与边界。** 保留现有 request identity、stale containment、choice session和单 dispatch。目标是证明 IDEA Basic主路径，不把 Smart、Full Line或 provider capability广告混入。本包只对 Java/JDK 21 建首个 provider evidence，generic LSP仍按 server逐项记账。

**Owner。** `workspace/lspCompletion.ts`、`workspace/lspCompletionChoice.ts`、`workspace/lspCompletionChoiceSession.ts`、`workspace/CodeMirrorHost.tsx`、`CodeWorkspaceTab.tsx` completion adapter；`src/lib/editor/lsp.ts`、`src-tauri/src/lsp.rs`；`workspace/__fixtures__/jdtls/` 扩展为真实项目、runner、trace与 expected，而不是只有 README/TS常量。

```ts
type CompletionResolveState =
  | { kind: "not-required" }
  | { kind: "ready"; resolvedAt: number; hasAdditionalEdits: boolean }
  | { kind: "timed-out"; canRetry: true }
  | { kind: "failed"; canRetry: true; message: string }
  | { kind: "stale" };

interface CompletionAcceptancePlanV2 {
  identity: CompletionRequestIdentity;
  itemId: string;
  primary: TextEdit;
  additional: readonly TextEdit[];
  snippet: ParsedLspSnippet | null;
  resolve: CompletionResolveState;
  disposition: "ready" | "needs-explicit-primary-only" | "blocked-stale" | "blocked-overlap";
}

interface CompletionInvocationEvidence {
  invocationOrdinal: number;
  requestedScope: "default" | "expanded";
  providerScope: "expanded" | "unchanged" | "unknown";
  itemCount: number;
  isIncomplete: boolean;
}
```

**Resolve/accept UI。** 若 item 已知需要 resolve 才能获得 import/additional edits，3 秒 timeout或失败不得静默插入并只写 status diagnostic。popup保留 item并显示 `Auto-import unavailable`，提供 Retry 与 `Insert without import`；只有用户明确选择后才提交 primary-only。stale/overlap直接阻断并重新请求。成功时 primary、snippet placeholders和 non-overlap additional edits用一次 dispatch/一个 undo；choice与后续 tabstops在 post-image range上重映射。

**重复 Basic 调用。** 同 revision/position/filter的第二次显式 invocation把 `requestedScope:"expanded"` 送入 provider adapter；jdtls无法直接表达时记录 `providerScope:"unchanged"` 并显示诚实状态，不能仅凭 ordinal写“expanded”。自动输入触发不增加 ordinal；编辑、caret移动、popup关闭或 provider generation变化重置。

**真实 fixture。** 至少创建 `maven-single`、`maven-multi-module`、`gradle-single`、`gradle-multi-module`，固定 JDK 21、jdtls和 build tool版本；覆盖 JDK type、同名 type歧义、static member、generic/overload、main/test source set、跨模块、dependency source、broken classpath、provider restart。trace保存 initialize capability、completion/resolve/cancel摘要、document revision、classpath fingerprint、edit hashes和时序，不保存用户 home/源码全文。IDEA expected记录候选类别、scope扩展、import与undo结果，不强求私有排序逐项相同。

**测试与 DoD。** pure/mounted覆盖 resolve success/timeout/fail/retry/explicit primary-only、overlap、choice、single undo、10k cap、restart/stale和非 Java负例；native runner对四个项目实际启动 jdtls并核对落盘/import/undo。Java Basic主路径全绿可写 **G1 Java Basic L2 provider-backed**；单 fixture与 IDEA对照达到完整矩阵后只对该 capability写 G2/L3。不得写 Smart、classpath-complete或“all Java completion”。

**R3 as-built（v4.53，2026-08-24）。** 按 §8.19.11 回报模板，分两段：本段为 R3-a/R3-b 生产代码合同（resolve gate + invocation evidence + IPC scope 事实）；R3-c 真实 fixture/runner/trace 见下一段。

```text
包 ID / commit / capability ID
    R3-a/R3-b / 工作树（基线 HEAD 401d85e1）/ java.basic-completion, completion.invocation-evidence
As-built production call chain
    显式调用: editor.basicCompletion (Ctrl+Space) → ActionHost dispatchKeydownV2
      → CodeMirrorHost.startBasicCompletion: popup 未开→startCompletion(view)；
      已开→closeCompletion+startCompletion（basicCompletionReopenRef 抑制一次
      popup-close 重置）→ source 以 context.explicit 记录 reason="explicit"
      → recordBasicCompletionInvocation（仅显式递增 ordinal；
        revision/position/providerGeneration 变化重置）
      → hooks.fetch(position, trigger, token,
          {invocationOrdinal, requestedScope: ordinal>=2?"expanded":"default"})
      → CodeWorkspaceTab.getLspCompletions → lspCompletion(invoke lsp_completion,
          invocationOrdinal+requestedScope) → Rust validate_requested_scope
          （default|expanded 白名单）→ ordinal>1 时 log::info 记录 provider 侧事实
          （不进入 wire request，LSP 无 scope-expansion 通道）。
    自动触发: typing/trigger 不递增 ordinal（继承现行序列）；popup 关闭由
      CodeMirrorHost updateListener 监听 completionStatus active→null 调
      resetBasicCompletionSession。
    接受: option.apply → applyLspCompletion：
      item 自带 additionalTextEdits 或无 resolve → 立即一次 dispatch 合并提交；
      否则 race(resolve, 3s timeout)：
        成功 → merge 后一次 dispatch（primary+snippet placeholders+
          non-overlap additional edits），choice/tabstop 会话照旧 post-image 重映射；
        timeout/failed/empty → presentResolveGate（不再静默插 primary-only）：
          CodeMirrorHost 渲染 caret 锚定横幅（testid completion-resolve-gate*，
          item label + "Auto-import unavailable — …" + Retry / Insert without
          import / dismiss）；Retry 走 resolveFresh 绕过 info 缓存重试，成功则
          合并提交并关横幅，再失败保持横幅显示 retry failed；
          Insert without import 提交 {…item, additionalTextEdits:[]}（一次 dispatch）；
          dismiss 不插任何内容。所有 gate 动作先 guardCurrent（identity+doc
          未变），stale 一律拒绝并报 identity-mismatch；overlap 由
          planCompletionChanges 拒绝整个 acceptance（invalid-additional-edits），
          不部分应用。无 gate surface 的孤立宿主 = 仅阻断 + diagnostic，
          同样不静默插入。
Owner files
    workspace/lspCompletion.ts（CompletionResolveState / CompletionAcceptancePlanV2 /
      CompletionInvocationEvidence / CompletionInvocationRequest /
      RecordedCompletionInvocation / providerScopeFor /
      buildCompletionAcceptancePlanV2 / completionItemId / gate 化的
      applyLspCompletion / 显式-only ordinal + generation/popup-close 重置 /
      evidence ring recentCompletionInvocations）、workspace/CodeMirrorHost.tsx
      （startBasicCompletion handler、popup-close 重置监听、gate 横幅 UI 与
      fileKey 清理）、workspace/workspaceCodeMirrorKeymap.ts
      （editor.basicCompletion 定义 + startBasicCompletion handler 槽位）、
      CodeWorkspaceTab.tsx（getLspCompletions 转发 invocation）、
      src/lib/editor/lsp.ts（lsp_completion invoke 增 invocationOrdinal/
      requestedScope 可选参数）、src-tauri/src/lsp.rs（validate_requested_scope +
      repeat-ordinal 日志 + 单测）。
缺陷→修复映射（§8.19.4 列出的旧行为）
  1) resolve 3s timeout/失败曾静默插入 primary 并只写 status diagnostic
     → 改为 gate 强制显式选择（timeout/failed/empty 三路均不自动插入）。
  2) recordBasicCompletionInvocation 曾 void input.reason——typing 也递增 ordinal
     且无 generation/popup-close 重置 → 仅 explicit 递增；revision/position/
     providerGeneration 变化与 popup 关闭均重置。
  3) ordinal 只进过单测、从未进入生产链 → 现在 evidence ring
     （recentCompletionInvocations，上限 50）+ fetch 第 4 参 + IPC 参数一路贯通。
  4) Ctrl+Space 无生产入口（completionKeymap 已在 R1 移出 CM spread）且重复调用
     被 CM 弹窗吞掉 → editor.basicCompletion action + close/reopen toggle。
Schema/migration
    无持久化 schema 变更；evidence ring 为进程内诊断面（resetCompletionTelemetry
    一并清空）。lsp_completion 新增两个可选参数，旧调用方不传即行为不变。
测试证据（已运行，2026-08-24）
    - npx vitest run src/components/editor/ → 143 文件 1176 通过
      （新增 lspCompletionResolveGate.test.ts 13 例：ordinal 语义×3、evidence ring、
      plan 分类、gate timeout/dismiss/retry-success/retry-fail/stale 阻断/overlap
      阻断/无 gate 阻断/成功无 gate）；lspCompletion.test.ts 原"失败仍插 primary"
      断言按新契约改写为阻断断言。全量首跑时 CodeWorkspaceTab git-gutter 用例
      3s 超时一次（负载抖动），单独与全量复跑均绿，非本包引入。
    - pnpm build → ✓ built（tsc+vite）。
    - cargo test --lib → 1298 通过 0 失败（含新增 requested_scope_validation_
      accepts_only_known_tags）；cargo check --lib 绿。
未运行项
    - 真实 jdtls fixture/native runner（R3-c，见下一段）；browser workflow；
      Windows/macOS native IME 行为（R9 门禁）。
最高允许声明
    “R3-a/R3-b 生产代码合同闭合：resolve gate + 显式 Basic 入口 + invocation
    evidence 全链贯通（model+production，Vitest/build/cargo 绿）”。
禁止声明
    不得写 G1 Java Basic provider-backed/L2（缺 R3-c provider trace）、不得写
    expanded scope 生效（providerScope 恒为 unchanged/unknown，除非未来 provider
    明示广告）、不得写 cross-platform IME verified。
残余风险
    - CM 弹窗开启期间第二次 Ctrl+Space 通过 close+reopen 实现，弹窗有一次重建
      （IDEA 为原地扩展）；若 provider 对连续两次请求有副作用需在 R3-c trace 中
      观察。
    - gate 横幅锚定在出现时刻的 caret 坐标，不随后续滚动移动（动作自身有
      stale 守卫，不会误插）。
```

**R3-c as-built（v4.53，2026-08-24）。** 真实 jdtls fixture、native runner 与 trace：

```text
包 ID / commit / capability ID
    R3-c / 工作树（基线 HEAD cb07c95c）/ java.basic-completion（provider 层证据）
交付物
    - projects/: maven-single、maven-multi-module(parent+core/app)、gradle-single、
      gradle-multi-module(:core+:app)、maven-broken-classpath。补全目标写在
      completionTargets() 不可达块中每行一个裸前缀 token；依赖固定为本地仓库可解
      析版本（junit 4.13.2 test scope、commons-lang3 3.12.0），Gradle 工程零外部
      依赖仅核心插件。
    - runner/lsp-client.mjs + runner/run-jdtls-fixture.mjs：按生产等价启动配方
      （lsp.rs 的 JVM 产品 flags/config_linux/-data）拉起真实 jdtls；initialize 的
      completion client capabilities 与生产逐字段一致（含 resolveSupport.
      additionalTextEdits）；逐场景轮询→completionItem/resolve（原样回传 raw）→
      命中断言→可选 acceptance 模拟（pre-image 绝对偏移换算后倒序应用，
      CodeMirror change-set 语义；undo() 反演必须精确恢复原文 sha256）→
      maven-single 追加 SIGKILL 重启复测。
    - traces/*.trace.json：五个脱敏 trace 入档——工具链版本（Zulu 21.0.4 /
      jdtls 1.61.0.202607102111 / Gradle 9.5.1 wrapper 缓存 / Maven CLI 3.9.9）、
      构建模型指纹（pom/gradle sha256）、逐场景 attempts/ms/itemCount/isIncomplete/
      matchedDetail、resolve additional edits 原文、acceptance 三哈希、restart
      时延与结果；home/tmp/project 路径统一脱敏，无源码正文。
    - jdtlsFixtureExpectations.ts 重写为真实矩阵 14 条期望（含 ideaExpected 注记，
      标明 curated 非机器录制）；jdtlsTraceContract.test.ts（22 例）在 Vitest 中
      断言入档 trace 与期望逐条一致。
真实运行结果（2026-08-24，Linux 实机）
    - 全矩阵 node runner → **5/5 fixtures green**（含 broken-classpath 负例：
      MissingUtil 候选未出现且 java.lang 正常补全；SIGKILL 重启后同一用例恢复）。
    - npx vitest run src/components/editor/ → 144 文件 1198 通过（含新增
      jdtlsTraceContract 22 例）；pnpm build 绿。
真实发现（已如实记录）
    - 原始 jdtls 会把 com.sun.tools.javac.util.StringUtils（JDK 编译器内部类）
      作为 StringUtils 同名孪生一并返回并可能被 resolve 选中 —— IDEA 会把工程
      依赖排在 JDK 内部符号之前；runner 用 detailContains 固定期望孪生，
      matchedDetail 入档。
    - InsertReplaceEdit 形态（{insert,replace,newText}）在实际响应中出现；
      acceptance 模拟取 replace 区间（IDEA 接受语义）。
诚实边界
    - 本包证据是 **provider 层**：证明请求形状/capabilities/import-on-resolve/
      restart 在真实服务器成立。Tauri IPC/webview、键盘/IME、三端行为仍归 R9；
      编辑器内 Ctrl+Z 单击撤销由 mounted/browser 层另行记账，acceptance.undo()
      是哈希往返反演，不等价于 UI undo。
    - IDEA expected 为人工整理（curated），G2/L3 的 idea-compare 升级仍需显式
      对照录制。
最高允许声明
    “Java Basic Completion 主路径 G1 L2 provider-backed（provider layer,
    Linux 实机, jdtls 1.61/JDK 21）：五项目九场景全绿并有脱敏 trace 与 Vitest
    契约门禁”。不得写 classpath-complete、Smart、all-Java-completion、
    cross-platform verified 或 G2/L3。
残余风险
    - trace 为一次性生成物：代码或工具链变化后需重跑 runner 刷新（契约测试会
      以指纹/期望失败提示）；Windows/macOS 未运行。
    - Gradle 版本取 wrapper 缓存最高发行版（当前 9.5.1）而非硬编码 pin；如需
      严格 pin 可设 TAOMNI_FIXTURE_GRADLE。
```

下一依赖包：R6（Reference Information + Usages/refactor session，依赖 R0/R3 已就绪）。

**R6 as-built（v4.54，2026-08-24，代码合同部分闭合）。**

```text
包 ID / commit / capability ID
    R6 / 工作树（基线 HEAD 49d28d87）/ reference.service, usages.session,
      diagnostics.presentation-hint
As-built production call chain
    Find Usages: 动作 → CodeWorkspaceTab.findReferences：
      pin 守卫（referencesPinnedRef → confirmAppDialog"Replace Pinned
      Usages"，拒绝则保留 pinned session 且不发出新请求）→ 语义同步 →
      lspPrepareRename 取符号 range（fallback caret 词切片）→
      makeSemanticRequestIdentity（真实 workspace/file/uri/position/revision/
      providerGeneration + roots 参与的 projectFingerprint）→ lspReferences →
      ReferencesResultState{symbolName, identity} → ReferencesPanel 用
      buildUsageSession 建真实 session（不再是 pf-legacy）。
    Rerun: referencesRerunRef 记录 origin fileKey+uri+position+symbolName；
      面板 rerun 重放同一身份（origin buffer 关闭时明确提示，不静默换目标）。
    Pin: 所有权上提到 tab；面板只上报 onPinChange。pinned 时新请求必须先询问。
    过滤: Reads/Writes/Declarations 三开关按 roleClassificationAvailable=false
      一律禁用并注明原因；Libraries 开关真实生效——owner 按 file:// path 是否
      落在任一 root 内判定（Windows 盘符 URI 归一化），库外命中可被隐藏。
    Reference service: ReferenceInfoController.requestTyped —— 五 kind 共享
      identity/AbortController/cancel；每 kind 独立 payload
      （parameter=signatures/activeSignature/activeParameter，
      quick-documentation=markdown+sourceLocation，
      type-info/context-info=text+languageId，
      external-documentation=url+title）；external URL 在服务边界强制
      https-only 策略（validateExternalDocUrl，http/带凭据/畸形一律
      unavailable external-url-*）；空文档 unavailable empty-documentation；
      history 仅 quick-documentation 消费，requestTyped 本身从不写 history。
    Diagnostics: classifyProviderAnalysisEvidence 的 text-inferred 分类现携带
      presentationHint:"keyword inferred"，AnalysisPanel 在 proof-level 徽标
      内联显示——关键词推断永不进入 semantic evidence ledger。
Owner files
    workspace/javaSemanticEvidence.ts（makeSemanticRequestIdentity）、
    workspace/panels/ReferencesPanel.tsx（identity/symbolName 消费、过滤行、
    pin 上提、library owner 判定）、CodeWorkspaceTab.tsx（findReferences
    身份/符号名/pin 门/rerun marker）、workspace/referenceInfoController.ts
    （ReferenceKind/ReferenceRequestIdentityV2/ReferencePayload/
    ReferenceResultV2/requestTyped）、workspace/inspectionEvidence.ts +
    panels/AnalysisPanel.tsx（presentationHint）。
测试证据（已运行，2026-08-24）
    - npx vitest run src/components/editor/ → 1206 通过（新增
      referenceInfoServiceV2.test.ts 6 例：per-kind payload、history 隔离、
      URL 边界、supersede-cancel/stale、kind 映射、failed 透传；
      ReferencesPanel.test.tsx 新增角色禁用+库过滤+pin 上提 2 例）。
    - pnpm build 绿。Rust 无改动。
诚实边界（本包未闭合项）
    - Parameter Info 生产命令仍走既有 signatureHelp 管线（CodeMirrorHost
      signature compartment）；requestTyped 是类型化服务通道并有测试，但生产
      parameter 流尚未改道——保持单一真值，不做双通道假迁移。
    - Safe Delete 完整性门由既有 buildSafeDeleteWorkspaceEdit.complete 承担；
      refactorApplyGate 目前无第二个消费方（rename/codeAction apply 待接）。
    - Show Usages 未单独建轻量 popup 组件：现有 UX 即 tool-window 优先，
      首批分页由 ReferencesPanel 的 batch/"Show more"承担，避免第二真值。
    - 真实 jdtls usages/rename/quick-fix trace 未在本包重跑（R3-c runner 当前
      只覆盖 completion 场景）；browser/native 层未运行。
最高允许声明
    “Usages session 生产合同闭合（真实 identity/rerun/pin/诚实角色/库过滤）
    + 五 kind reference 服务通道类型化闭合（model+production 测试）”。
禁止声明
    不得写 Reference suite complete、Find Usages complete、Parameter Info
    provider-backed L3、IntelliJ inspections 对齐。
```

**R7 as-built（v4.55，2026-08-24，生产代码合同闭合；a/b/c 三提交）。**

```text
包 ID / commits / capability ID
    R7-a ffe7808b / R7-b da583cf9 / R7-c 101c4980 /
      semantic-edit.provenance, surround.with-dialog, generate.provider-
      workflow, complete-statement.strategy
As-built production call chain
    Provenance（R7-a）: workspaceSemanticEditing.ts 定义契约类型
      SemanticEditSource{local-text|syntax-tree|provider} +
      SemanticEditEvidenceV2{identity,source,selectionNodeRange,
      parseErrorsInScope,completeness}。editor-transaction 计划的旧
      source:"syntax-tree" 字面量删除；surroundWithPlan 只有当调用方传入
      syntax facts 且 alignedNodeType/selectionNodeRange 非空且 scope 内无
      parse error 时才允许 syntax-tree provenance（completeness=complete），
      其余一律 local-text（completeness=partial，identity=null——本地编辑
      没有 provider request 可标识，不伪造 identity）。
    Syntax facts: workspaceSyntaxFacts.ts —— treeRevisionField
      （StateField，docChanged 递增，注册于 CodeMirrorHost 扩展）提供证据
      revision；observeSyntaxFacts 以 syntaxTreeAvailable 门控（绝不强制同步
      reparse），先对整行展开边界做空白 trim（Lezer 节点不含缩进/换行），
      再用边界侧正确的 resolveInner(from,1)/resolveInner(to,-1) 双锚点上溯
      查找 EXACT 对齐节点（side 反了会落在持有空白的祖先上——已由 fixture
      探针证实并修复）；parse-error 用 type.isError 有界子树扫描（512 节点
      预算）。
    Surround（R7-a）: editor.surroundWith.tryCatch 硬编码命令删除；新 action
      editor.surroundWith（Ctrl+Alt+T / Meta+Alt+T，when=editor+file+可写）
      打开 SurroundWithDialog——只列 surroundKindsForLanguage(languageId)
      给出的 adapter kind（Java 全五种 if/while/try-catch/synchronized/
      runnable；TS/JS 三种；其余语言明确空态），每个 kind 标注 "template"
      徽标，dialog 从不宣称 Semantic。onPick → executeActiveEditorCommand
      ("surroundWith",{surroundKindId,onSemanticEditApplied}) →
      applySurroundWith 在整行展开边界观察 syntax facts → 单事务 dispatch
      （一次 undo）→ provenance 经回调上抛，tab 状态栏如实区分
      "syntax node <type>" 与 "local template"。
    Generate（R7-b）: 新 action editor.generateCode（Alt+Insert / Meta+N）→
      requestGenerateCandidates 复用 requestCodeActions(file,caret range,
      only:["source"])（语义同步/staleness token 全套既有守卫）→
      filterGenerateCodeActions 改为泛型透传 {item,title,kind}（保留 raw
      provider action，绝不本地重建模板）→ GenerateCodeDialog 按 phase
      loading/ready/empty/running/error 渲染真实 title/kind 复选列表；
      placement/conflict/imports 如实声明"由 provider edit 决定"。Apply →
      applyGenerateSelection 逐个执行且每次执行前重查 semantic staleness →
      runCodeAction（扩展为返回 {ok,message}；resolve data → WorkspaceEdit/
      executeCommand 走 R0 effect applier + preview）——单个 provider action
      = 一条 history entry。失败停在首个 failedIndex，dialog 保持打开显示
      Retry/Cancel，绝无固定模板兜底；Retry 重发请求而非重放旧结果。
    Complete Statement（R7-c）: completeStatementStrategy 输入 languageId/
      readOnly/caretCount/lineText/syntax facts，输出三态：
      exact——Java 首批仅 ExpressionStatement/ReturnStatement/
      ThrowStatement 且 exact 对齐 + 无 parse error 时插 ";"，
      provenance=syntax-tree（携带 nodeType+treeRevision 的 evidenceV2），
      dispatch userEvent=input.completeStatement.syntax；
      local——空行/block 边界/控制流头/声明行/无 tree facts/非 Java 语言
      一律回落既有 completeCurrentStatement 启发式，ruleId 明确
      （completeStatement.local/.blank-line/.newline-below），provenance
      local-text，UI/遥测按 Local/Heuristic 记账（action keywords 已含
      "heuristic"，userEvent 不冒充 syntax）；
      unavailable——read-only/multi-caret/unterminated string 或 comment/
      parse errors in scope 均为带 reason 的显式 no-op 并经
      onSemanticEditApplied(applied:false) 上报。
Owner files
    workspace/workspaceSemanticEditing.ts（SemanticEditSource/EvidenceV2、
    surroundKindsForLanguage、completeStatementStrategy、泛型
    filterGenerateCodeActions）、workspace/workspaceSyntaxFacts.ts（新）、
    workspace/SurroundWithDialog.tsx（新）、workspace/GenerateCodeDialog.tsx
    （新）、workspace/generateCodeWorkflow.ts（新，applyGenerateSelection）、
    workspace/CodeMirrorHost.tsx（treeRevisionField 注册、command port
    options/onSemanticEditApplied、surround/completeStatement 重写）、
    CodeWorkspaceTab.tsx（editor.surroundWith/editor.generateCode 命令、两
    dialog 状态与渲染、runCodeAction 返回值、状态栏 provenance 文案）。
测试证据（已运行，2026-08-24）
    - npx vitest run src/components/editor/ → 149 文件 1238 通过（每提交后
      全绿）。新增：workspaceSyntaxFacts.test.ts 7 例（exact 对齐含缩进
      trim、partial 无对齐、unterminated string、treeRevision 递增、
      parserless null、CRLF 行映射、JS 负例——均用真 @codemirror/lang-java
      解析器）；SurroundWithDialog.test.tsx 5 例；generateCodeWorkflow.test.ts
      4 例（顺序应用、每步 staleness 重查、首败即停、空选择）；
      GenerateCodeDialog.test.tsx 6 例；CodeMirrorHost.test.tsx 新增 2 例
      （经 EditorView.findFromDOM 驱动 command port：surround 单事务+
      provenance 回调、completeStatement local-text 上报）；workspaceSemantic
      Editing.test.ts 重写 surround 断言（local-text 默认/错误 scope 拒绝/
      对齐升级/kinds-per-language）+ strategy 8 例 + generate 过滤保留 raw。
    - pnpm build 绿（tsc -b + vite）。Rust 无改动。
诚实边界（本包未闭合项）
    - 真实 jdtls surround/generate trace 未运行：R3-c runner 目前只覆盖
      completion 场景；本包全部证据为纯函数 + jsdom mounted 测试，
      provider 行为由 LspCodeAction 抽象隔离。
    - IDEA 对照逐 action 录制未做（§8.19.10 统一门禁）。
    - Generate 多选 = N 个 provider action 依次执行 = N 条 history entry；
      "单条 WorkspaceEdit entry"仅在单个 provider action 粒度成立（契约
      语句按此理解，多选合并为单 entry 未实现也未声称）。
    - Smart gate 维持 v4.50 语义（capability-not-advertised 即 unavailable，
      不以 fuzzy Basic 冒充）；provider expected-type evidence 出现前的
      Smart badge 仍不存在。
    - Surround placeholder 仅落 caret 于第一个占位符，Tab 逐占位符跳转、
      choice 占位未实现；本地模板的 imports/shorten 由用户手动处理（契约
      中"由 provider edit 承担"指 provider 路径，本地模板不适用）。
    - treeRevision 是视图局部计数器，不是跨会话 parse generation；
      selectionNodeRange 为编辑器内 LSP 形状坐标，不跨进程发送。
    - Lezer node 名（ExpressionStatement 等）是语法内部名，仅出现在状态栏
      provenance 文案中，不构成 PSI 等价声明。
最高允许声明
    “R7 生产代码合同闭合：semantic-edit provenance 类型化且不再谎报
    syntax-tree；Surround 五 Java kind 同一 action/dialog/单事务；Generate
    全链路只走真实 provider CodeAction（resolve 失败 Retry/Cancel、无本地
    模板兜底）；Complete Statement Java 首批 syntax-backed、其余显式
    Local/Heuristic”。
禁止声明
    不得写 Semantic Editing complete、surround/generate 的 provider 层 L2/L3
    （无真实 jdtls trace）、all-language Generate/Surround、Smart badge 已
    实现、IDEA-equivalent、statement-aware parsing beyond Lezer node facts。
残余风险与下一依赖包
    固定接口顺序 R0→R1→R3→R6→R7 已全部 [x]。剩余包均可独立领取：R4/R5
    依赖的 R1 action IDs 已冻结，R2 catalog 修复随时可做，R8 必须先出四项
    ADR，R9 为最终门禁汇总。建议下一包按表序领取 R4（Clipboard History/
    Plain Paste/Copy Reference/Virtual Space），其 G1 多光标断言可直接复用
    本包 command-port 测试基建（EditorView.findFromDOM + port.execute）。
```

**R4 as-built（v4.56，2026-08-24，生产代码合同闭合，单提交）。**

```text
包 ID / commit / capability ID
    R4 / 2fcc9f47 / clipboard.history-v2, paste.plain-text, copy.reference,
      virtual-space.model
As-built production call chain
    Clipboard history（R4-a）: WorkspaceClipboardStore 扩为 §8.19.5 事实源——
      write 接受 sensitive（敏感载荷只进 live slot，绝不入 ring），返回侧以
      historyExclusion() 暴露 recorded|history-disabled|oversized-item|
      sensitive 四态非阻断说明（CodeMirrorHost.rememberEditorClipboardPayload
      经 onUnavailable 上抛）；setHistoryLimits 把条目上限钳制在 1–50、总字
      节下限 1024；removeHistoryEntry 支持单条 Delete。
      editor.pasteFromHistory action（Ctrl+Shift+V / Meta+Shift+V）→
      ClipboardHistoryPopup 可搜索 listbox（首行/segment 数/相对时间，
      role=option+aria-selected）；Enter → executeActiveEditorCommand
      ("pasteFromHistory",{historyIndex}) → host 从 workspace store 取回该
      条 promote 到 live slot 后直接 pasteEditorClipboardPayload 完整
      segment plan——刻意绕过系统剪贴板（系统内容可能更新），单事务一次
      undo；Delete 单删、Clear 两段确认、ring 依旧 session-only 且最后一个
      handle release 即清空（refcount 语义不变）。
    Plain Paste / Copy Reference（R4-b）: editor.pasteAsPlainText
      （Ctrl+Shift+Alt+V）→ pasteAsPlainText 丢弃 rectangular/segment 元数
      据，系统剪贴板失败回落 session plainText，按 caret 升序一次 dispatch
      全文替换（userEvent=input.paste.plain）。editor.copyReference
      （Ctrl+Alt+Shift+C）→ copyReferenceCandidates 纯函数：root 内给
      workspace-relative path:line（显示行号 +1）、跨 root 给显式 absolute
      格式、library 一律 unavailable library-source、无路径 no-file；
      symbol 候选只在 provider rename range/词边界真实给出时追加——模型里
      不存在 qualified-name kind，不伪造类名。多候选经 openTreeContextMenuAt
      菜单选择，单候选直接写剪贴板并回报文本。
    Virtual Space（R4-c）: workspaceVirtualSpace.ts —— facet 与 StateField
      同址（消除 import cycle，workspaceEditorCommands 仅再导出）；
      virtualSpaceOverflowField 按 CLAMPED head 记录溢出可视列：policy 关闭
      或 docChanged 一律坍缩到合法 document column，selection-only 移动保留
      未移动 head 的溢出。End/Shift+End 以 Prec.high 绑定但严格 defer——任一
      caret 未达行末即 return false 交给默认 keymap（保住 soft-wrap 边界语
      义），全部到行末后每次 +1 列走进虚拟区；click-past-EOL handler 用
      posAtCoords/coordsAtPos 像素过冲估算列数（atFileBottom 只对最后一行放
      行）；typing inputHandler 在 IME composing 时直接 defer，溢出存在时用
      changeByRange 同事务产出 padding+text；pasteEditorClipboardPayload 在
      同一 changes 数组内为各 caret 前置 padding 并清空 overflow map——多
      caret padding+text 单 dispatch。measureVisualPositions 输出契约的
      VisualColumnPosition{line,documentColumn,visualColumn,virtualColumns}，
      tab stop 对齐 + CJK/emoji 双宽估算。
Owner files
    workspace/workspaceClipboardSession.ts（sensitive/exclusion/limits/
    removeEntry）、workspace/ClipboardHistoryPopup.tsx（新）、
    CodeMirrorHost.tsx（exclusion 通知、pasteAsPlainText/pasteFromHistory
    命令、virtual space 扩展注册）、workspace/workspaceCopyReference.ts
    （新）、workspace/workspaceVirtualSpace.ts（新）、workspace/
    workspaceEditorCommands.ts（facet 迁址再导出、paste padding 消费）、
    CodeWorkspaceTab.tsx（三个新 action + 弹层状态/渲染）。
测试证据（已运行，2026-08-24）
    - npx vitest run src/components/editor/ → 153 文件 1264 通过。新增：
      workspaceVirtualSpace.test.ts 7 例（tab/双宽测量、policy 门控测量、
      溢出记录不动 doc/history、typing 单事务物化、无溢出 defer、backspace
      递减不动 doc、End 走虚拟区且关闭即失效、multi-caret 保留）；
      workspaceCopyReference.test.ts 7 例（relative/absolute/library/no-file/
      symbol 候选/Windows 盘符/最小 root）；workspaceClipboardHistory.test.ts
      7 例（refcount 清空、限额驱逐与钳制、sensitive 排除、oversized 排除、
      单删+去重晋升、promote、disable/clear）；ClipboardHistoryPopup.test.tsx
      5 例（首行/段数/时间、过滤与空态、Enter 粘贴、Delete 与 Clear 确认、
      关闭渲染 null）。
    - pnpm build 绿（tsc -b + vite）。Rust 无改动。
诚实边界（本包未闭合项）
    - Settings 中 Disable/Clear/限制 UI 未接线：store API
      （setHistoryEnabled/setHistoryLimits/clearHistory）已生产暴露并有测试，
      但外观/剪贴板设置对话框尚未提供入口——避免在无 consumer 时造第二真值。
    - sensitive 标记当前无生产 producer（编辑器内暂无密钥类复制来源）；排除
      路径由 store 级测试覆盖，机制先行、声明为零。
    - 虚拟空间 up/down 移动沿用既有 cloneCaretVertically 的 policy 消费；
      方向键跨行保持溢出仅通过 field 的 selection-only 保留语义部分成立，
      未做完整 IDEA 式 column 记忆。
    - click-past-EOL 依赖 coordsAtPos 像素估算，jsdom 无法构造真实几何——
      该路径仅有模块级单元覆盖（handler 注册），像素行为归 R9 native 验证。
    - region folding 的 "Text marker folding (heuristic)" 标签收口未在本包
      处理（R4 合同列出但属折叠子系统，避免与本包剪贴板/虚拟空间改动混
      提交）。
    - rectangular drag 新建（Alt+Shift 拖拽矩形选区）沿用 CM 既有
      rectangularSelection；本包未新增 rectangle drag 专属逻辑。
    - native clipboard permission 场景归 R9 三端门禁。
最高允许声明
    “R4 生产代码合同闭合：clipboard history V2 事实（sensitive/限额/单删/
    typed exclusion）+ 会话级 Paste-from-History 弹层（绕过系统剪贴板的单
    事务 segment plan）；Plain Paste 与 Copy Reference 候选模型不伪造任何
    provider 未给出的身份；Virtual Space 以 overflow StateField 实现
    End/click/type/backspace/paste 全消费链且多 caret padding 单事务”。
禁止声明
    不得写 Clipboard suite complete、History Settings UI 已可用、virtual
    space IDEA-equivalent（up/down column 记忆不全、像素行为未经 native
    验证）、Copy Reference qualifiedName 已支持、G3 clipboard L2 合并声明。
残余风险与下一依赖包
    表序下一包为 R5（真实 ToolWindow Registry、Tab Policy V3、Split 操作，
    §8.19.6），R2 catalog/workflow 修复亦可随时并行；R8 需先出四项 ADR；
    R9 为最终汇总门禁。本包的 overflow StateField 与 popup 测试基建可直接
    被 R5 的 Switcher/tab restore 断言复用。
```

**R5-a as-built（v4.57，2026-08-24，部分闭合——模型层完成，接线未做）。**

```text
包 ID / commit / capability ID
    R5-a / 5cae5f7a / tab-policy.v3, tool-window.registry
As-built production call chain
    Tab Policy V3: workspaceTabPolicy.ts —— WorkspaceTabPolicyV3 在 V2 语义
      （limit/order/openPosition/activateOnClose/pinnedRow/reusePreview）上
      增加 schemaVersion:3 + previewMode；migrateWorkspaceTabPolicy(raw) 接受
      任意持久化 JSON：v2 载荷按 previewEnabled→previewMode 迁移并记录
      "previewMode(migrated-from-v2)"；错误类型字段逐个回落默认值、数值越界
      钳制进合法域（1–100）；任何修复发生时返回原始载荷 backup，供调用方在
      覆写前留档。enforceTabPolicy/orderTabsForDisplay/selectActivateOnClose
      放宽为 AnyWorkspaceTabPolicy（只读共享字段），V2 行为零变化。
    ToolWindow registry: toolWindowRegistry.ts —— workspace 级注册表，
      register/unregister/setToolWindowState/setToolWindowBadge/touch 按
      panel mount/open/hide/dispose 写入真实快照（§8.19.6 的
      ToolWindowSnapshot 形状含 dock/state/lastActivatedAt/badge/canHide/
      unavailableReason）；listToolWindows 输出 MRU 全量（Search 用），
      listToolWindowsForCycle 过滤 unavailable——不可用窗口带 reason 只在
      Search 可见，永不进入 cycle。
Owner files
    workspace/workspaceTabPolicy.ts（V3 类型/默认值/migration/签名放宽）、
    workspace/toolWindowRegistry.ts（新）、对应两个测试文件。
测试证据（已运行，2026-08-24）
    - npx vitest run src/components/editor/ → 155 文件 1274 通过。新增：
      workspaceTabPolicyV3.test.ts 5 例（v3 直通、v2 默认迁移、逐字段修复+
      backup、非对象全回落、越界钳制）；toolWindowRegistry.test.ts 5 例
      （MRU 排序、unavailable 不入 cycle 但 Search 可见、状态/激活时间、
      badge 与 dispose、workspace 隔离）。既有 workspaceTabPolicy.test.ts
      回归绿。
    - pnpm build 绿（tsc -b + vite）。Rust 无改动。
诚实边界（本包未闭合项 → R5-b）
    - Switcher 尚未消费 registry（仍构造自身列表）；冻结 snapshot/MRU 后台
      稳定性断言未落地。
    - per-workspace policy 持久化未接：migrateWorkspaceTabPolicy 已就绪但无
      读写调用方（workspaceLayoutPersistence 无 policy 字段）。
    - split right/down / move tab to next/previous split / next/previous
      split / equalize / stretch / unsplit actions 未新增；recursiveLayoutTree
      的 splitLeaf/closeLeaf/adjacent/equalize 基元现状未审计补齐。
    - Backspace close 分级（dirty 确认/pinned 按政策/tool window 仅 hide）
      未接线；ReopenLocationV2{leafId/treeRoute/siblingFileKeys} 模型未建。
    - detach 明确 defer 至 R5b/G3（controller/window ownership ADR 前不展示
      可点击入口）——本包无相关改动，符合契约。
最高允许声明
    “R5-a：Tab Policy V3 迁移/修复模型与 workspace 级 ToolWindow registry
    （MRU/cycle/Search 三语义）以纯函数+单测闭合”。
禁止声明
    不得写 R5 complete、Switcher 使用真实 registry、tab policy 已持久化、
    split operations 已交付、G1 tabs/splits L2。
残余风险与下一依赖包
    R5-b 需按序接线：① Switcher 冻结 snapshot 消费 registry；
    ② workspaceLayoutPersistence 增加 tabPolicy 字段（经 migration 读写，
    backup 留档）；③ split/navigation/equalize/stretch actions +
    recursiveLayoutTree reducer 审计；④ Backspace 分级关闭 + ReopenLocationV2。
```

**R5-b as-built（v4.58，2026-08-25，①② `827fec82` + ③④ `64a43314`，R5 接线闭合）。**

```text
包 ID / commit / capability ID
    R5-b / 827fec82（①②）、64a43314（③④） /
    tool-window.registry-wired, tab-policy.v3-persisted, split.management,
    reopen.location-v2
As-built production call chain
    ① Registry→Switcher: toolWindowRegistry.ts 新增
      WORKSPACE_BOTTOM_DOCK_WINDOWS 全量目录（13 个 dock tab，id 对齐
      BottomDockTabId、title 对齐 BottomDock 标签）+ syncBottomDockToolWindows
      （把真实 dock 状态镜像进注册表：可见 tab=open、其余=hidden；重同步保留
      badge/lastActivatedAt，hidden→open 触发激活时间戳 bump）+
      unregisterAllToolWindows（dispose 清理）。CodeWorkspaceTab 每次实例/
      bottomDockOpen/bottomDockTab 变化调用 sync；卸载时 unregisterAll。
      Switcher 打开瞬间用 buildSwitcherSnapshot 冻结一份快照：编辑器 MRU 条目
      + listToolWindowsForCycle 输出（unavailable 永不入 cycle）；此后
      cycle/hover/commit/Backspace 全部只读该快照——后台开/关窗口不能改变
      当前索引空间或重排条目。硬编码七项数组与 dockMruRef 已删除。
    ② Policy persistence: WorkspaceLayoutSnapshotV2 增加 tabPolicy（可选入参，
      normalize 后必有）与 tabPolicyBackup；normalize 调
      migrateWorkspaceTabPolicy 做逐字段迁移/修复，任何修复归档原始载荷为
      backup，且 backup 随再 normalize 向前携带、直到下一次干净 live 写入
      （不带 backup 字段）自然清除。snapshotFromWorkspaceUi 接受并透传
      tabPolicy；CodeWorkspaceTab 挂载恢复 snapshot.tabPolicy，openFile 的
      limit 驱逐改用 per-workspace policyRef（不再使用编译期默认值常量）。
    ③ Split management: recursiveLayoutTree.ts 新增四个原子纯 reducer：
      equalizeLeafParentSplit（仅均衡直接包含目标 leaf 的同层 split；已均衡
      时返回同一引用）、stretchLeafInTree（可重复拉伸：目标份额 +step、兄弟
      等比收缩保持 ratios 归一，封顶 max=0.8，无空间/到顶为 no-op）、
      navigateLeafOrder（preorder next/previous 且首尾回绕）、unsplitAllLeaves
      （折叠进第一个 preorder leaf，全部 tab 保序去重合并——绝不丢 tab；
      幸存者保留原 id）。store 新增 equalizeLayoutRatios/stretchLayoutLeaf/
      unsplitAllLayout，全部经 commitLayoutMutation 的 validate+consistency
      门禁提交（unsplit 合并所有 pinned 并集、保留 dormant 空 legacy 组）。
      ActionHost 注册九个 action（workspace.splitRight/splitDown/goToNextSplit/
      goToPreviousSplit/moveTabToNextSplit/moveTabToPreviousSplit/
      equalizeSplitProportions/stretchActiveSplit/unsplitAll），header 在
      splitOrientation 存在时新增 equalize/stretch/unsplit-all 三个按钮；
      编辑器 tab 右键菜单增加 Move Tab to Next/Previous Split（多 leaf 时）。
    ④ Graded close + ReopenLocationV2: workspaceTabPolicy.ts 新增
      ReopenLocationV2{leafId, treeRoute(first/second 步), siblingFileKeys}、
      buildReopenTreeRoute（root→leaf 子索引路由）与 resolveReopenLocation
      （按 §8.19.6 顺序：原 leafId 存活→route 最近存活祖先（仅当真正下降过
      至少一步；整树塌缩时 route 无信号，跳过）→拥有最多 sibling 的 leaf→
      active leaf）。closeFile 关闭时记录 location 证据进 reopen 栈；
      workspace.reopenClosedTab 用 LIVE tree 解析并以状态栏消息披露 relocated
      原因（nearest surviving split / next to its former tab group / active
      editor）。Switcher Backspace 分级：pinned 拒绝并给原因（弹层保持打开）、
      dirty 走既有确认路径、clean 直接关闭、tool window 仅 hide。
Owner files
    workspace/toolWindowRegistry.ts、workspace/workspaceTabPolicy.ts、
    workspace/recursiveLayoutTree.ts、workspace/workspaceLayoutPersistence.ts、
    src/stores/codeWorkspaceStore.ts、CodeWorkspaceTab.tsx、
    workspace/EditorGroup.tsx 及对应测试文件。
测试证据（已运行，2026-08-25）
    - npx vitest run src/components/editor/ → 155 文件 1292 通过。本包新增：
      toolWindowRegistry +3（全目录镜像 open/hidden、hidden→open 激活 bump 与
      badge 保留、dispose 只清本 workspace）；workspaceLayoutPersistence +4
      （缺省物化 v3 默认、自定义 policy round-trip、v2/corrupt 修复且 backup
      归档并在干净写入后消失）；recursiveLayoutTree +4（三层 mixed tree 上
      equalize 只动父层、stretch 可重复至 0.8 封顶且归一、navigate 回绕、
      unsplit 合并不丢 tab 且幸存 id 不变、幂等返回同一引用）；
      workspaceTabPolicy.test +5（first/second 路由记录、restored/route/
      sibling/active 四级解析）；集成 +2（pinned Backspace 拒绝且 📌 出现在
      冻结行、弹层不关闭；Ctrl+F4 关闭→split 折叠销毁原 leaf→Ctrl+Shift+T
      重开 relocation 到 former tab group 并激活）。
    - pnpm build 绿（tsc -b + vite），两个 commit 各自构建验证。Rust 无改动。
诚实边界（本包未闭合项）
    - policy 编辑设置界面未做：restored policy 目前只有 openFile 驱逐消费；
      orderTabsForDisplay（display projection）与 selectActivateOnClose 仍无
      production consumer——display order/activateOnClose 行为依旧硬编码。
    - 九个 split action 未设默认键位绑定（Search Everywhere 可发现、Keymap
      Settings 可绑定）；nav/equalize/stretch 仅按钮+action 入口，无 IDEA
      对照录制。
    - QA C4 完整流程未实跑（R2 范畴）；200% zoom/focus 场景、三端 native
      均未执行。detach 维持 defer（controller/window ownership ADR 前 UI
      不展示入口），本包无相关改动。
最高允许声明
    “R5-b：Switcher 冻结 registry 快照、per-workspace policy 迁移持久化+
    驱逐消费、equalize/stretch/unsplit/navigation/move reducers+actions、
    Backspace 分级与 ReopenLocationV2 结构化重开，以纯函数单测+jsdom 集成
    测试闭合”。
禁止声明
    不得写 G1 tabs/splits L2 达成（QA C4 未跑）、tab policy 有编辑界面、
    display order/activateOnClose 已生效、三端已验证、detach 已交付、
    IDEA 对照已完成。
残余风险与下一依赖包
    表序下一包为 R8（§8.19.9 四项 productionize-or-defer ADR 先行），R2
    catalog/workflow 修复随时并行；R9 最终汇总门禁。本包的 frozen-snapshot
    断言与 reopen relocation 集成测试可直接被 R2/QA C4 browser case 复用。
```

#### 8.19.5 R4：Clipboard History、Plain Paste、Copy Reference 与完整 Virtual Space

**状态与范围。** 保留 refcount workspace store、segments/rectangular plan和 session-only history ring。C3a 的多光标正确性属于 G1；History/Paste Plain/Copy Reference作为 G3分项，但本包共用同一 action和privacy owner。region folding只做标签/证据收口，不在无 parser语言自研 grammar。

**Owner。** `workspace/workspaceClipboardSession.ts`、`workspace/workspaceEditorCommands.ts`、`workspace/CodeMirrorHost.tsx`、`workspace/editorAppearanceProfile.ts`、`workspace/editorAppearanceExtension.ts`、`WorkspaceEditorAppearanceSettingsDialog.tsx`；新增 `ClipboardHistoryPopup.tsx` 和 action definitions；Copy Reference 复用 workspace path/symbol provider，不从显示文本猜 symbol。

```ts
interface VisualColumnPosition {
  line: number;
  documentColumn: number;
  visualColumn: number;
  virtualColumns: number;
}

interface ClipboardHistoryEntryV2 {
  id: string;
  createdAt: number;
  plainText: string;
  segments: readonly string[];
  rectangular: boolean;
  sourceWorkspaceId: string;
  sourceEol: "lf" | "crlf" | "cr";
  sensitive: boolean;
}
```

**History UX。** `editor.pasteFromHistory` 打开可搜索 listbox，显示文本首行/segment count/time，Enter按当前 caret分发为一次 transaction，Delete删单项，Clear有确认；Settings可 Disable/Clear/限制 1–50项和总字节。默认 session-only、不读/轮询系统 clipboard、不落盘；workspace最后一个 handle释放时清空。被标 sensitive或超过限制的内容不进 history并给非阻断说明。

**Plain Paste / Copy Reference。** `editor.pasteAsPlainText` 丢弃内部 rectangular/segment metadata，只使用 system/session plain text并按普通 selection替换；仍一次 undo。`editor.copyReference` 只有 file path时生成 workspace-relative `path:line`，有 provider symbol identity时可生成 `qualifiedName`/`path:line`候选菜单；无 identity不伪造类名，库/loose/outside-root有明确格式和 unavailable reason。

**Virtual Space。** 以 CodeMirror StateField保存每个 range的 `VisualColumnPosition`，tab宽变化时重算。mouse点击行尾外、End/Shift+End、上下移动、typing、Backspace、rectangle drag和paste共同消费 visual column；实际插入时才生成必要空格，移动 caret不提前改doc/history。IME composition期间不补空格；多 caret padding+text是一次 dispatch。`afterLineEnd` 与 `atFileBottom` 分别 gate，关闭设置时所有虚拟位置收敛到合法 document column。

**Region。** 有 syntax tree/provider folding range时记录 `syntax/provider`；无 parser fallback固定显示 `Text marker folding (heuristic)`且默认关闭，不计 semantic folding。不得把 comment-token regex改名 grammar-aware。

**测试与 DoD。** 跨三 leaf、少/等/多 segments、rectangle、overlap、CRLF、history eviction/disable/clear/sensitive、plain paste、reference格式、tab/emoji宽度、mouse/End/up-down/typing/paste/IME、setting toggle和one undo；native覆盖 clipboard permission。G1 virtual-space/multi-caret达到 L2后可升级相应能力；History/Copy Reference各自单列 G3 L2，不能合并成“clipboard complete”。

#### 8.19.6 R5：真实 ToolWindow Registry、Tab Policy 与 Split 操作

**状态与范围。** 保留 recursive layout、leaf-aware Switcher、Backspace close和 reopen stack；去掉硬编码工具窗和默认 policy唯一使用。G1交付 registry/policy/reopen/equalize/stretch/navigation；detach为 R5b/G3，只有 controller/window ownership ADR后实施。

**Owner。** `CodeWorkspaceTab.tsx`、`workspace/TabSwitcher.tsx`、`workspace/workspaceTabPolicy.ts`、`workspace/recursiveLayoutTree.ts`、`workspace/workspaceLayoutPersistence.ts`、`src/stores/codeWorkspaceStore.ts`；新增 workspace-scoped `toolWindowRegistry.ts` 和 `workspaceTabSettings.ts`。每个 panel在 mount/open/hide/dispose时注册真实状态，Switcher不再构造七项数组。

```ts
interface ToolWindowSnapshot {
  id: string;
  title: string;
  dock: "left" | "right" | "bottom";
  state: "open" | "hidden" | "unavailable";
  lastActivatedAt: number | null;
  badge: number | null;
  canHide: boolean;
}

interface ReopenLocationV2 {
  leafId: string | null;
  treeRoute: readonly ("first" | "second")[];
  siblingFileKeys: readonly string[];
}

interface WorkspaceTabPolicyV3 extends WorkspaceTabPolicyV2 {
  schemaVersion: 3;
  openPosition: "end" | "after-active";
  pinnedRow: "same" | "separate";
  previewMode: boolean;
}
```

**行为。** registry snapshot按 MRU列出实际 open/hidden tool windows；unavailable项不进入 cycle但可在 Search显示 reason。Switcher打开时冻结 editor+tool snapshot，释放 modifier提交该 snapshot；后台新增/关闭不能改变当前索引。Backspace：dirty file走同一确认、pinned按 policy、tool window只 hide。Reopen先找原 leafId，再按 treeRoute找最近存活祖先/后代，再按 siblingFileKeys选拥有相关 tabs的 leaf，最后才用 active leaf并显示 relocated reason。

Tab policy per workspace持久化：limit、display order、open position、activate on close、preview、pinned row；limit驱逐只选 clean/unpinned并生成 reason，全受保护可超限。policy变化只改变 projection/未来 open，不重写 dirty tabs。坏 schema备份并逐字段fallback；v2默认值迁入 v3。

新增 action：split right/down、move tab to next/previous split、go to next/previous split、equalize proportions、stretch active、unsplit、unsplit all。reducer必须保持 leaf id/open-file multiset/active ownership/ratio合法；stretch可重复且有上限，equalize按同层 children分配。R5b detach需要独立 window controller、single writer ownership、IPC reconnect、crash reattach和三端证据；未完成前 UI不展示可点击 detach。

**测试与 DoD。** tool-only/hidden/unavailable registry、frozen MRU、dirty/pinned Backspace、原 leaf关闭后的 reopen、v2/v3/corrupt policy、limit/property、三层 mixed split、equalize/stretch/navigation/move/restore、200% zoom/focus。QA C4实际执行完整流程。R5a全绿可写 G1 tabs/splits L2；detach单独 G3，不能由 recursive tree推导。

#### 8.19.7 R6：Reference Information、Usages 与 Refactor Evidence

**状态与范围。** 把已有 QuickDoc controller、独立 Parameter Info和 thin usages model变成真实 production sessions。G1只要求 Parameter + QuickDoc；Type/Context/External、Show/Find Usages和 refactor逐 capability归 G2/G3。不要把 LSP references数量当 completeness。

**Owner。** `workspace/referenceInfoController.ts`、`referenceDocumentation.ts`、`QuickDocPopup.tsx`、`CodeMirrorHost.tsx`、`CodeWorkspaceTab.tsx`；`workspace/javaSemanticEvidence.ts`、`panels/ReferencesPanel.tsx`、新增 `ShowUsagesPopup.tsx`/`usageSessionController.ts`；`workspace/inspectionEvidence.ts`、`panels/AnalysisPanel.tsx`、`RefactoringPreviewDialog.tsx`、`workspaceEditApply.ts`；`src/lib/editor/lsp.ts`、`src-tauri/src/lsp.rs` provider commands。

```ts
type ReferenceKind = "parameter" | "quick-documentation" | "type-info" | "context-info" | "external-documentation";

interface ReferenceRequestIdentityV2 {
  workspaceId: string;
  fileKey: string;
  uri: string;
  position: LspPosition;
  documentRevision: number;
  providerGeneration: number;
  requestId: string;
}

type ReferenceResultV2 =
  | { state: "ready"; kind: ReferenceKind; identity: ReferenceRequestIdentityV2; payload: ReferencePayload; evidence: CapabilityEvidenceRecord }
  | { state: "unavailable"; kind: ReferenceKind; reason: string }
  | { state: "cancelled" | "stale" }
  | { state: "failed"; kind: ReferenceKind; message: string };

type ReferencePayload =
  | { kind: "parameter"; signatures: readonly SignatureInformation[]; activeSignature: number; activeParameter: number }
  | { kind: "quick-documentation"; markdown: string; sourceLocation: LspLocation | null }
  | { kind: "type-info" | "context-info"; text: string; languageId: string }
  | { kind: "external-documentation"; url: string; title: string | null };
```

**Reference service。** 五 kind共享 identity、AbortController、provider cancel key、cache/history ownership，但各自有独立 payload/capability。Parameter Info搬入 service而不复用 documentation payload；popup auto-trigger和手动 action都可 cancel。QuickDoc显式与 inline hover必须走同一 controller，edit/caret/file/popup-close/unmount会发 provider cancel。External Documentation由 provider直接返回 URL/command；只允许现有 https policy，不能从 symbol name拼 URL。Type/Context无 provider extension时保持 disabled + reason。

**Usages session。** `findReferences()` 必须创建真实 `SemanticRequestIdentity` 和 origin symbol key，把 identity/name/provider/generation/completeness传给 controller；name仅显示，rerun使用 stable origin uri+position+relocation marker。Show Usages先展示首批轻量 popup，Continue/Find in Tool Window把同一 session移交 ReferencesPanel。pin后新请求创建新 session或明确询问替换，绝不能覆盖 pinned session。role未知时 read/write/declaration toggles disabled并说明；library filter按真实 URI owner。

**Refactor。** Rename/CodeAction apply前必须构造并消费 `RefactorEvidence`；error阻断、warning确认、generation/revision/hash变化重请求。Safe Delete只有 provider明确给出 complete references/declaration/external-owner contract时开放；标准 LSP references无 completeness字段，因此默认 unavailable，而不是由客户端 locations猜“安全”。R0逐 operation effect用于 preview/apply/undo/post-condition。

**Diagnostics 命名。** `inspectionEvidence.ts` 的 structured provider metadata可列 evidence；message/source正则结果改成 `DiagnosticPresentationHint`，UI明确“keyword inferred”，不得进入 semantic evidence ledger或启用 inspection/data-flow claim。没有 provider profile control时设置页只能叫 presentation filter，不能写 enable/disable inspection engine。

**测试与 DoD。** 五 kind × ready/unavailable/cancel/stale/fail、inline/explicit cancel到真实 provider、Parameter overload、QuickDoc pin/history/source、URL reject；Show->Find handoff、pin replacement、rerun relocation/provider restart、roles unknown；rename conflict/partial apply/undo、Safe Delete incomplete拒绝；真实 jdtls usages/rename/diagnostic/quick-fix trace。Parameter+QuickDoc可独立达 G1 L2；其余逐项升级，禁止写 Reference suite complete、Find Usages complete或 IntelliJ inspections。

#### 8.19.8 R7：Semantic Editing、Surround With 与 Generate Code

**状态与范围。** 最新 Complete Statement caret-line修复保留，但 local heuristic不升级语义等级。R7先修 provenance，再为 Java建立 syntax/provider子集；Smart仍依赖 R3 provider expected-type evidence，不以 fuzzy Basic冒充。

**Owner。** `workspace/workspaceSemanticEditing.ts`、`workspace/workspaceEditorCommands.ts`、`workspace/CodeMirrorHost.tsx`、ActionHost definitions、`CodeWorkspaceTab.tsx` command ports、provider CodeAction/executeCommand bridge、Live/Postfix Template owner；新增 `SurroundWithDialog.tsx`、`GenerateCodeDialog.tsx` 和 language adapter。

```ts
type SemanticEditSource =
  | { kind: "local-text"; ruleId: string }
  | { kind: "syntax-tree"; languageId: string; nodeType: string; treeRevision: number }
  | { kind: "provider"; providerId: string; generation: number; commandOrKind: string };

interface SemanticEditEvidenceV2 {
  identity: SemanticRequestIdentity;
  source: SemanticEditSource;
  selectionNodeRange: LspRange | null;
  parseErrorsInScope: boolean;
  completeness: "partial" | "complete";
}
```

**Complete Statement。** 每语言 strategy接收 syntax tree revision、caret node、line tokens和provider capability，返回 exact edits/unavailable。Java首批只支持明确的 expression statement、return/throw、method call和block boundary；控制流头、unterminated string/comment、parse error跨 scope、multi-caret不确定时 no-op + reason。local text策略可保留，但 UI/telemetry必须标 Local/Heuristic。

**Surround。** 修正当前未查 syntax node却写 `source:"syntax-tree"` 的错误；selection必须与 expression/statement-list node精确对齐。dialog只列当前 adapter可用 kind；Java首批 if/while/try-catch/synchronized/Runnable，placeholder/choice、imports/shorten由 provider edit承担。try/catch不再是唯一硬编码 command；所有 kind走同一 action/dialog/one undo。local whole-line template可作为单独分类，不得显示 Semantic。

**Generate。** 向 provider请求 constructor/getter/setter/override/equals-hashCode/toString等 CodeAction/command；dialog展示真实 member id、checkbox、placement、conflict和imports。apply前复核 class identity/revision/generation，提交为一个 WorkspaceEdit history entry；resolve失败保留 dialog并显示 Retry/Cancel，不插入固定模板。只实现 filter函数不计 workflow。

**Smart。** 只有 provider返回 expected types/context evidence才显示 Smart badge；重复 Basic不等于 Smart。provider不支持时 action保留并显示 unavailable，不能 fallback fuzzy结果后改名。

**测试与 DoD。** syntax node边界、parse error、caret line、CRLF、multi-caret、local provenance；五种 Surround及 placeholder/import/undo；Generate成员选择/conflict/stale/resolve失败；Java fixture与 TS/Python负例；IDEA对照逐 action记录。每个 action+language单独升 L2/L3；不得写 semantic editing complete、syntax-tree source（若无 node evidence）或 all-language Generate。

#### 8.19.9 R8：SSR、Dependency、Full Line、Code Style 的 productionize-or-defer 决策

R8不是“补更多类型”的包。第一提交必须给四个子项各做一次 production reachability ADR，决定 `implement-now` 或 `defer`；defer时保留明确 unavailable capability，移除误导入口和完成声明。`companionCapabilities.ts`、`workspaceCodeStyleScheme.ts` 在有真实 consumer前仍是 model。

| 子项 | implement-now 的最小生产 owner | 最低可交付 | 明确非目标 / defer 条件 |
|---|---|---|---|
| **R8-A Java SSR** | parser/query service + search tool window + R0 preview/apply | syntax pattern/typed variables、file/workspace scope、cancel/page、replace preview/undo；strings/comments false-positive固定 fixture为 0 | 无 Java parser/provider、性能预算或 query schema migration时 defer；绝不 regex换皮 |
| **R8-B Maven/Gradle dependency completion** | project model + pom/Gradle parser + trusted repository/cache provider + R3 envelope | group/artifact/version位置、offline/cache、timeout/cancel、replacement range、来源/新鲜度 | 无可信 metadata/credential/proxy策略时 defer；绝不 hardcoded popular list或单测真实公网 |
| **R8-C Full Line** | native local-model runtime + signed model manager + CodeMirror ghost-text StateField + R1 actions | edition/hardware/language/privacy gate、accept all/word/line、cancel、auto-import/one undo、latency/memory | 无可分发模型、license、安全更新或 AVX2/ARM64 runtime时 defer；绝不远端/Terminal FIM冒充 |
| **R8-D Code Style suite** | `workspaceCodeStyleScheme.ts` production store/UI + formatter stage planner + R0 apply | scheme copy/rename/delete/reset、field provenance、selection/file首批；支持时再开 scope/rearrange/cleanup/exclusion/save actions | provider/syntax不支持的 stage显示 unavailable；绝不把 format后文本启发式重排 |

Appearance不是第五个空模型：现有 `editorAppearanceProfile.ts` 已生产接线，后续只补 font actual-hit、high contrast对比度、200% zoom、state-preserving reconfigure和三端 evidence，归 R9；不要重建另一套 appearance store。

每个 implement-now 子项沿用 §8.18.9 的 typed schema作为设计输入，但必须补 production call chain、settings、failure UI、security/privacy、migration、unit/mounted/native/performance和 IDEA expected。每项独立 DoD/commit/evidence；一个子项完成不能提升其它子项或 G1。若全部 defer，R8仍可“决策完成”，但四项能力保持 L0/L1 unavailable，不得写 Advanced Profile complete。

**R8 ADR（v4.59，2026-08-25）：四项 production reachability 决策。**
依据均为 2026-08-25 工作树（R5-b `64a43314` 之后）的代码事实；每个 defer 记录重开条件（re-entry），满足前对应能力保持 L0/L1 typed-unavailable。

```text
ADR R8-A Java SSR —— defer
    代码事实
      - companionCapabilities.ts 已定型 StructuralQuery schema 与可用性门禁，
        但 SSR_SUPPORTED_LANGUAGES 为空集，availability union 把唯一合法后端
        钉在 backend:"tree-sitter"；package.json / Cargo.toml 均无 tree-sitter
        依赖。工作树内确有 @lezer/java（highlighting 级增量解析），但它不是
        模型契约声明的后端：改用 Lezer 属于未记录的后端替换，且 SSR 需要
        pattern query 解析器 + 变量绑定 matcher + 替换模板引擎 + R0
        preview/apply 全链路与 false-positive=0 fixture，均不存在。
      - 无性能预算测量、无 query schema migration 路径——正是本节写明的
        defer 条件（“无 Java parser/provider、性能预算或 query schema
        migration”）。
      - UI 审计：components 下无任何消费 structuralSearch* 的入口，无误导性
        UI 需要移除。
    决策
      defer。能力保持 L0 unavailable：structuralSearchAvailability(id,false)
      → { available:false, reason:"backend-missing" } 即为对用户契约。
    重开条件
      引入 tree-sitter-java（或显式修订 schema 的 backend union 并补 migration）
      + pattern/query service 设计 + 性能预算（文件级扫描上限）确立后，
      方可按 §8.19.9 implement-now 最小 owner 重排入待办。
    禁止声明（持续生效）
      绝不 regex 换皮冒充 SSR；不得因 schema 存在宣称 SSR 可用。

ADR R8-B Maven/Gradle dependency completion —— defer
    代码事实
      - companionCapabilities.ts 有 DependencyCompletionRequest/Candidate 与
        repositoryUrlPolicy（https 才 trustedRead），但全仓无 registry
        metadata client、无元数据 cache 存储、无针对仓库元数据抓取的
        credential/proxy 会话策略（现有 proxy 管线服务 terminal/db/mail，
        未覆盖此场景）。
      - Rust 侧 pom.xml 处理仅是 sdk/detect.rs 的文本级属性扫描（SDK 探测），
        非 position-aware project model；build.gradle 仅做构建系统存在性
        判定。completion 所需的坐标区间定位模型不存在。
      - UI 审计：无任何依赖补全入口。
    决策
      defer。命中 defer 条件“无可信 metadata/credential/proxy 策略”；
      也绝不以 hardcoded popular list 充当候选源。
    重开条件
      确立受信仓库清单 + 元数据缓存（含 TTL/失效）+ 抓取走会话级代理与
      超时/取消的完整策略后重评。
    禁止声明（持续生效）
      不得写 dependency completion 可用；不得用内置常用坐标列表冒充
      repository 候选。

ADR R8-C Full Line local completion —— defer
    代码事实
      - src-tauri/src/tab/fim_engine.rs 默认把 FIM 路由到 LlmRouter
        (TaskKind::TabCompletion)，该路径可为云端 provider；local-llm-fim
        feature 编译进 fim_engine_real.rs，但其 complete() 无条件返回 None
        （"real decode not yet wired"）——native 本地解码运行时不存在。
        Full Line 合同要求 localOnly 且“绝不远端/Terminal FIM 冒充”。
      - 无签名模型分发/更新管理器；detectFullLineHardware 在 x86 上返回
        "unknown"（AVX2 运行时探测缺失），fullLineAvailability 因此恒为
        unavailable。前端 fullLineCompletionModel.ts 位于
        __fixtures__/experimental，非生产模块。
      - 编辑器侧无任何 ghost-text consumer；tab_suggest_fim 的唯一前端消费方
        是 lib/terminal/aiSuggestionSource.ts（终端 AI 建议）——该入口必须
        保持其现有命名与语义，不得改标 Full Line。
    决策
      defer。命中“无可分发模型、license、安全更新或 AVX2/ARM64 runtime”。
    重开条件
      发布已知良好的本地 FIM GGUF（含签名校验与更新通道）+ fim_engine_real
      真实解码接线 + x86 AVX2 探测落地后重评；届时按 §8.19.9 要求补
      ghost-text StateField、accept word/line、one-undo 与延迟/内存证据。
    禁止声明（持续生效）
      不得把云端/终端 FIM 改名或统计为 Full Line；不得在硬件 unknown 时
      启用模型下载。

ADR R8-D Code Style suite —— implement-now（分阶段）
    代码事实（可达性成立）
      - workspaceCodeStyleScheme.ts（scheme/provenance/format-plan 模型）、
        codeStyleModel.ts（IDEA 四层优先级解析）与 editorConfigResolver.ts
        已有真实下游生产消费：getEffectiveCodeStyleForFile → EditorGroup/
        CodeMirrorHost（缩进行为）、saveNormalizationPipeline（EOL/trim/
        final newline 归一化）、formatActiveFile 走 provider
        formatting/rangeFormatting 能力。
      - 缺口即本表列出的最小交付：scheme copy/rename/delete/reset 的生产
        store/UI、field provenance 展示、formatter stage planner（provider
        不支持的 stage 显式 unavailable）与 selection/file 首批 apply（经
        R0 effect 通道）。当前无任何组件消费 CodeStyleScheme（grep 为空），
        indentationOverrides 只提供 per-file 缩进覆盖。
    决策
      implement-now，拆两个提交：
      R8-D1 scheme 生产 store + 管理 UI（copy/rename/delete/reset/选中持久化）
        + provenance 显示；
      R8-D2 formatter stage planner + selection/file reformat 首批（stage 按
        provider capability 门禁，不支持显示 reason；apply 经 WorkspaceEdit
        effect/undo 通道）。
      scope/rearrange/cleanup/exclusion/save actions 维持关闭直到 provider
        支持（§8.19.9 表格原文）。
    禁止声明（持续生效）
      provider/syntax 不支持的 stage 不得静默跳过后宣称 reformatted；
      不得把 format 后文本启发式重排称为 cleanup/rearrange。
```

R8 结论：A/B/C defer（保持 typed unavailable、零误导入口、禁止声明挂账），D implement-now 分两提交跟进；“Advanced Profile complete”在任何情况下不可声明。

**R8 as-built（v4.60，2026-08-25，ADR + R8-D1 `5ef8609e` + R8-D2 `62a52adc`）。**

```text
包 ID / commit / capability ID
    R8 / a9ad47c9（四项 ADR）、5ef8609e（D1 scheme store/UI/provenance）、
    62a52adc（D2 reformat planner） /
    code-style.scheme-store, code-style.reformat-planner,
    ssr.deferred, dependency-completion.deferred, full-line.deferred
As-built production call chain
    D1: workspaceCodeStyleSchemes.ts —— 命名 scheme 为内建 Default 之上的
      类型化字段 delta；纯 CRUD（copy 生成唯一名并记 basedOn、rename/delete/
      reset 拒改内建、delete 清除悬挂 per-language 激活）；localStorage 持久化
      不落盘内建、读时修复（坏条目丢弃/未知键忽略/激活 id 校验）。
      解析层：codeStyleModel.resolveEffectiveCodeStyle 与
      workspaceStyleController.resolveForFile 同步插入 "scheme" 层——位于
      EditorConfig 之下、language-default/sniffed 之上；scheme 的缩进字段
      抑制探测（显式意图），EOL/trim/final-newline 只在 EditorConfig 未设时
      补位；provenance 记 source:"scheme"。CodeWorkspaceTab 以扩展名作为
      languageKey 把激活 scheme 注入两条解析路径。
      UI: CodeStyleSettingsDialog（workspace.codeStyleSettings action 打开）
      ——scheme listbox（built-in 标注且只读）、Copy/Rename(行内)/Delete/
      Reset、shared+当前扩展名的激活下拉、类型化字段编辑器（空=继承）、
      当前文件 provenance 面板（resolved label/胜出层/激活 scheme 名）。
    D2: reformatWorkflow.planReformat —— 每次 Format 调用解析为可执行 stage
      或类型化不可用原因：无打开目标、read-only（library/decompiled/操作锁）、
      file scope 无 provider、有选区但无 rangeFormatting（附清除选区提示）、
      该语言无 provider。exclusion-pattern 门保留占位。scope/rearrange/
      cleanup 关闭不伪装。workspace.format(Ctrl+Alt+L) 改道 planner：可执行
      委派 formatFileText（range/document 按 capability），其余状态栏显示原因。
Owner files
    workspace/workspaceCodeStyleSchemes.ts(+test)、
    workspace/CodeStyleSettingsDialog.tsx(+test)、workspace/reformatWorkflow.ts
    (+test)、workspace/codeStyleModel.ts(+test)、
    workspace/workspaceStyleController.ts、workspace/editorConfigResolver.ts、
    CodeWorkspaceTab.tsx。
测试证据（已运行，2026-08-25）
    - npx vitest run src/components/editor/ → 155 文件 1310 通过。新增：
      scheme store 6、resolver scheme 层 4、dialog 4、reformat planner 4。
      pnpm build 绿（tsc -b + vite），三个 commit 各自验证。Rust 无改动。
诚实边界（本包未闭合项）
    - CodeStyleSchemeV2.saveActions（reformat-on-save 等）模型存在但无生产
      consumer；formatOnSave 走的是独立 intelligence 偏好，两者未统一。
    - exclusion patterns 无用户界面（planner 门占位恒空）；directory/module
      scope、organize-imports 并入 plan、rearrange/cleanup 全部按契约关闭。
    - dialog 的 provenance 仅显示 effective 结果与胜出层，不逐字段列出完整
      EditorConfig chain。
    - A/B/C defer 状态维持：SSR/dependency/Full Line 保持 typed unavailable，
      重开条件见 v4.59 ADR；终端 FIM 入口不得改标 Full Line。
    - 无 native/三端证据、无 IDEA 对照录制；jsdom 级闭合。
最高允许声明
    “R8：四项 productionize-or-defer 决策完成（A/B/C defer 带重开条件）；
    Code Style D1/D2 以纯函数+单测+jsdom 交互测试交付 scheme 管理、分层
    provenance 解析与诚实 reformat 决策”。
禁止声明
    不得写 Advanced Profile complete、SSR/dependency/Full Line 可用、
    cleanup/rearrange 已实现、scheme save actions 生效、三端已验证。
残余风险与下一依赖包
    表序下一包为 R2（QA catalog/workflow 修复，§8.19.4），随后 R9 最终门禁。
    本包的 dialog/planner testid 可直接进 QA C-catalog。
```

#### 8.19.10 R9：Native 三端、性能、IME 与可访问发布门禁

**Owner 与产物。** `qa-ui-auto-tests/` native cases、Rust integration/fault harness、platform launch scripts和 `qa-ui-auto-report/evidence/`（不提交含隐私的运行产物；只提交脱敏 manifest/template）。每项记录 commit/app hash、OS/WebView/arch、keyboard layout/IME、display scale、filesystem、JDK/jdtls/build tool、命令、结果、artifact hash、known gaps和最高 claim。

**三端矩阵。** Linux、Windows、macOS打包应用；每端至少 US + 一种非 US layout、一种 IME、100%/200% scale。G0必测 locked/permission/hash conflict、atomic replace故障点、external watcher、encoding/EOL/BOM、save close/unmount、WorkspaceEdit partial/resume/undo。G1必测 Keymap chord/AltGr/dead key/composition、system clipboard denied、Switcher modifier release、tab restore、QuickDoc/Parameter focus、screen reader基本路径。symlink/case/UNC等只在相关平台执行并记录预期。

**provider。** 固定 JDK/jdtls/Maven/Gradle版本运行 R3/R6/R7 fixture，保存脱敏 JSON-RPC method/timing/id/cancel/result摘要；mock只用于 fault分支，不能替代至少一条真实 process trace。provider crash/restart、classpath broken和network offline必须有恢复结果。

**性能预算。** 建可重复 harness后先记录基线，再设置 regression gate：普通输入 key-to-paint p95目标 50ms；本地 action/Switcher p95目标 100ms；completion分别记录 debounce/IPC/provider/paint和cancel率；1MiB file、10k candidates、10k-file workspace、3+ splits记录CPU/内存/long task。Full Line若实施则单列 model load/first suggestion/accept/memory。环境噪声导致目标不稳定时保留基线与百分比阈值，不删测试或只报平均值。

**a11y。** keyboard-only完成所有 G1 case；dialog/menu/listbox/tab有正确 role/name/state，focus trap/return与 cancellation一致；screen reader announcement覆盖 completion、conflict、save recovery、unavailable；high contrast、200% zoom、窄 viewport、reduced motion无重叠/截断。自动扫描不能替代每端一次人工 keyboard/screen-reader smoke。

**最终 DoD。** R2 catalog/browser全绿；G0 native matrix无未解释 data-effect；G1三端无 shortcut/IME/focus阻断；performance/a11y manifest完整；R3/R6真实 provider evidence存在。只有此时可把 G0标 green、G1标 release-ready。G2/G3仍逐 capability升级；任一平台/fixture未运行时相应项保持 `platform/provider-unverified`。

**R9 as-built（v4.62，2026-08-25，native harness + Linux 首批证据；三端矩阵未绿，W7 承接）。** 按 §8.19.11 模板：

```text
包 ID / commit / capability ID
    R9 / 本包提交（分支 feat/code-workspace-idea-parity） /
    workspace.save-transaction (native disk-effect), perf.baseline,
    a11y.role-name-state
As-built production call chain（harness，非生产行为变更）
    native runner P2：qa_ui_auto/runner.py `_native_run` 全动词分发 →
    qa_ui_auto/native_steps.py（click/fill/type/press(W3C Actions 真实键事件)/
    wait_for/assert_*/eval_readonly/seed_storage/reload_window/vault_first_run/
    assert_file_contains[host 侧磁盘重读]） → tauri_webdriver.py
    NativeSession（press_combo/type_text/wait_absent/console_entries）。
    隔离：`_prepare_native_env` 以**绝对路径**覆盖 XDG_DATA_HOME/XDG_CONFIG_HOME
    （Linux）/APPDATA（Windows）→ tauri-driver 子进程 → 应用 app-data 全部落入
    run 目录；reset_db 原生分支按同一 XDG 根清理。
    进 workspace 的通道：native 文件夹选择器不可被 WebDriver 驱动 → 用应用自身
    的 recent-workspaces 持久化（seed_storage 写 taomni.recentWorkspaces.v1 +
    reload_window + 按 data-workspace-path 精确点击行）。
修改 owner 文件（无关文件数 0）
    .agents/skills/qa-ui-auto/scripts/*（runner/native_steps/tauri_webdriver/
    config/evidence_collect/perf_baseline/a11y_scan）、qa_ui_auto/fixtures/
    workspace_root.py、qa-ui-auto-tests/native/*（README/manifest 模板/三端
    runbooks/a11y 人工清单）、evidence-manifest.schema.json（W7 命名产物）、
    schema/testcase.schema.json（4 新动词 + workspace_root fixture）、
    cases/TC-IDE-C0-01（native 重写）、feature-list.md（F1.6 +2 控件声明）。
    无 src/ 生产代码改动。
旧缺陷复现 -> 结果
    ①首启隔离失效（相对 XDG_DATA_HOME 被 XDG 规范忽略 → 应用回退真实
    profile，误向真实仓库 README.md 写入 marker）→ 已 git 还原真实文件、
    改绝对路径 + 行级 path 限定 + vault_first_run 自动设密；修复后隔离生效。
    ②C0 旧断言 `file-status contains saved` 从未在任何模式验证过；真实契约
    （EditorGroup.tsx）是 size+mtime，无 saved 瞬态 → 断言改为权威的
    host 侧磁盘重读。
接口/schema/migration 与 compatibility
    testcase.schema.json 新增动词 seed_storage/reload_window（双实现）、
    assert_file_contains/assert_file_exists（native-only）、fixture
    workspace_root（browser 下 FixtureSkip=environment-blocked）；
    `${fixture.*}` 模板作用域（config.resolve 严格缺失即错）。
    evidence-manifest.schema.json 实现 W7 EditorEvidenceManifestV1。
cancel/stale/error/disk/provider/undo effect
    disk：TC-IDE-C0 两连绿（7.7s/6.9s，打包 debug 二进制 + tauri-driver/
    WebKitGTK 2.52.3，隔离 app-data，vault 首启设密自动化），typed marker
    字节级验证落盘（assert_file_contains）。
    provider：C2/C6-02 未跑（jdtls 真实 trace 缺），provider-unverified。
Unit / mounted host / Rust / QA browser / native / provider / IDEA compare
    QA audit --gate 绿（0 lint / catalog current / 0 orphan / baseline 无回归）；
    native：C0 Linux ×2 绿 + 证据条目（evidence/<app-hash>/linux/）；
    perf：browser 渲染器代理基线 ×2 —— key-to-paint p50 20.5ms / p95
    133-135ms（**超 50ms 目标，复现稳定，已记 finding**）；local action
    p95 14-15ms（达标）；completion 分解/cancel 率 provider-unverified；
    1MiB/10k/3+split environment-blocked。
    a11y：自动扫描 0 违例（welcome/app-main-menu/text-input-dialog/
    code-workspace 四表面）；人工 keyboard/screen-reader smoke 未跑。
    Rust fault harness、IDEA compare 未做。
未运行项及原因
    Windows/macOS native 矩阵（需真实设备；macOS 无 Tauri WebDriver →
    manual-native）；非 US layout/IME/200% scale 轮次；G0 fault 分支
    （locked/hash-conflict/atomic-replace 故障点/external watcher/encoding）
    case 未编写（harness 已就绪）；C2/C6-02 provider trace；人工 a11y smoke。
最高可声明 L0-L3 + evidence layers
    C0 save disk-effect：native L1（Linux 单平台）；perf/a11y：browser 层
    基线；整体 R9：harness 交付 + 首批 Linux 证据。
禁止声明仍有哪些
    G0 未绿、G1 未 release-ready、三端 parity 未证、provider evidence 不存在、
    perf 50ms 目标未达（p95 超标为已记录 finding，非达标）。
残余风险与下一依赖包
    key-to-paint p95 尾部（~134ms，两次复现）需 owner 包定位（疑似周期性
    per-keystroke 副作用）；真实 profile 遗留一条 qa-c0 recent（指向已删
    临时目录，可右键移除）；W7（§8.20.8）承接全部矩阵/manifest 汇总。
```

#### 8.19.11 合并规则与回报模板

1. R0冻结 effect/ledger schema后，R3/R6的 additional edit/refactor apply才能依赖它；不得各自实现另一套 writer结果。
2. R1冻结 action ids/dispatcher后，R4–R8新增入口只能注册 action，不得再向 window或CodeMirror安装业务 keydown。
3. R2 selector/catalog与行为 owner同提交更新；不允许单独改 YAML 期望来掩盖产品失败。
4. R3冻结 provider identity/trace schema；R6/R7复用 generation/cancel/evidence，不另造 Java session真值。
5. R5b detach、R8任何 implement-now子项都需独立 ADR和独立 capability claim，不得搭车提升 G1。
6. 每次合并前运行聚焦 unit/host、受影响 Rust test、`pnpm build`、QA audit与可运行 mode；未运行命令逐条写原因。

coding agent 最终回报固定为：

```text
包 ID / commit / capability ID
As-built production call chain
修改 owner 文件（无关文件数必须为 0）
旧缺陷复现 -> 新状态机/结果
接口/schema/migration 与 compatibility
cancel/stale/error/disk/provider/undo effect
Unit / mounted host / Rust / QA browser / native / provider / IDEA compare
未运行项及原因
最高可声明 L0-L3 + evidence layers
禁止声明仍有哪些
残余风险与下一依赖包
```

### 8.20 v4.62 当前权威实施合同（面向其它 coding agent，HEAD `f572c6b8`）

本节是唯一可领取的 Code Editor 对齐待办。开始前必须阅读 §2.30 和相关 R0-R8 as-built，重新确认当前 HEAD 的 production call chain。任务的完成单位是纵向 workflow，不是“新增类型/组件/测试”；任何未实际运行的 native/provider/IDEA case 都写 `unverified`。

#### 8.20.0 状态、依赖、证据与共用合同

| 顺序 | 状态 | 包 | 目标 | 依赖 |
|---:|---|---|---|---|
| 1 | [x] | **W0 Shell stability + shortcut ownership（v4.63 as-built）** | 修复 C1 渲染崩溃与 `Ctrl+Shift+T` owner 冲突，恢复 G1 可执行基线 | R1 |
| 2 | [ ] | **W1 Reference Information V3** | Parameter/QuickDoc 单一请求通道；按 IDEA 2026.2 修正 Type/External/Expression Static Data 边界 | W0、R3/R6 |
| 3 | [ ] | **W2 Java Project Analysis truth** | provider-owned project/import snapshot、ready/degraded 状态和可复用 jdtls evidence runner | W0、R3 |
| 4 | [ ] | **W3 Inspection + Intention provider contract** | 把 diagnostic presentation 与 provider analysis/action 执行彻底分账 | W2、R0/R1 |
| 5 | [ ] | **W4 Navigation + Usages + Hierarchy** | scope/coverage/roles/history/preview 与 Java 真实 trace | W2、W1 |
| 6 | [ ] | **W5 Refactor evidence and conflict gate** | Rename/Safe Delete/provider refactor 共用 completeness/conflict/stale/apply/undo 合同 | W2、W4、R0 |
| 7 | [ ] | **W6 Editor policies and edge workflows** | clipboard/tab/virtual-space/region/code-style/completion preference 的设置与真实 consumer 收口 | W0，可与 W1-W5 非冲突子包并行 |
| 8 | [ ] | **W7 Native three-platform + performance + a11y + IDEA compare** | 解除 G0/G1 发布证据门禁并逐 capability 提升证据层 | W0-W6 |
| 9 | [ ] | **W8 Advanced re-entry queue** | 仅在 ADR 重开条件满足时实施 Smart/SSR/dependency/Full Line/Code Vision/scratch/injection/detach | 各子项独立 |

所有 provider-backed 包共用下列证据外壳；不要再为 completion、reference、usages、refactor 各造一套“差不多”的 identity：

```ts
interface CapabilityEvidenceV3 {
  capabilityId: string;
  languageId: string;
  provider: { id: string; version: string | null; generation: number };
  projectFingerprint: string;
  document: { uri: string; revision: number; position?: LspPosition; range?: LspRange };
  scope: "document" | "open-files" | "project" | "tests" | "libraries" | "custom";
  coverage: {
    complete: boolean;
    truncated: boolean;
    providerCount: number;
    failedProviderCount: number;
    skippedProviderCount: number;
    reason: string | null;
  };
  requestId: string;
  startedAt: number;
  completedAt: number | null;
}

type CapabilityResult<T> =
  | { state: "ready"; value: T; evidence: CapabilityEvidenceV3 }
  | { state: "unavailable"; reason: string; retryable: boolean; evidence?: Partial<CapabilityEvidenceV3> }
  | { state: "cancelled"; requestId: string }
  | { state: "stale"; requestId: string; reason: "document" | "project" | "provider" | "superseded" }
  | { state: "failed"; message: string; retryable: boolean; requestId: string };
```

共用规则：

1. `complete=true` 只能来自 provider 明示或由已固定的单 provider + scope 协议证明；不能由“请求成功”推导。unknown 一律按 incomplete。
2. apply 前重新核对 workspace、project fingerprint、document revision、provider generation；stale 结果不得进入预览或落盘。
3. provider cancel 必须走现有 Rust `$/cancelRequest` 链；前端 AbortController 只取消 UI 不算 provider cancel 完成。
4. 所有 effectful edit 复用 R0 `WorkspaceEditApplyOutcome`、disk-effect ledger 与 history；禁止另写文件 writer 或只用内存 undo。
5. UI 必须显示 source/scope/completeness/unavailable；telemetry/trace 只保存 method、id、时序、hash、数量、kind，禁止保存用户源码、完整候选文本、凭据和 home 路径。
6. 每包至少包含 pure contract test、mounted host test、受影响 Rust test、QA catalog/case；provider 包还要真实 process trace，W7 才能补 platform/IDEA 层。

#### 8.20.1 W0：Shell stability、tree boundary 与全局 shortcut owner（P0，首包）

**已复现缺陷。** R2 browser report 中 `TC-IDE-C1-01` 多次在 `useWorkspaceTreeData` 报 `Cannot read properties of undefined (reading 'length')` 并触发 RootErrorBoundary；不能通过删除步骤、增加 wait 或改成 screenshot 关闭。C4 还证明最后一个 editor tab 关闭后 `Ctrl+Shift+T` 被 `MainLayout` 的 New Local Terminal 处理，Code Workspace 的 `workspace.reopenClosedTab` 失去入口。

**Owner。** `useWorkspaceTreeData.ts`、`src/lib/editor/workspace.ts` 的 tree IPC decoder、`src/stubs/tauri-core.ts` 对应命令、`CodeWorkspaceTab.tsx`、`MainLayout.tsx` 的 global shortcut 层、`workspaceActionHost.ts`；QA `TC-IDE-C1-01` 与 `TC-IDE-C4-01`。不要顺手改其它 terminal 快捷键或 tree UI。

Tree IPC/stub 必须在边界返回判别联合，hook 不得假设任意 `invoke()` 值都含数组：

```ts
type WorkspaceTreeLoadResult<T> =
  | { state: "ready"; entries: readonly T[]; truncated: boolean }
  | { state: "cancelled" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; message: string };
```

`workspaceListDir`、`workspaceCompactChain`、`workspaceListFilesRecursive` 在 `src/lib/editor/workspace.ts` 做结构校验；browser stub 返回与 native 同 shape。malformed/undefined 必须转 `failed`，保留上一次缓存并显示 error row，不得把 `undefined` 写进 `DirectoryState.entries`。generation 变化后的旧响应仍丢弃；root 删除/切换 workspace 后的 callback 不得复活缓存。

全局 shortcut 需要一个 root routing decision，而不是让 `window` listener 和 workspace host竞速：

```ts
interface ShellShortcutClaim {
  ownerId: string;
  actionId: string;
  scope: "modal" | "active-workspace" | "active-tab" | "shell";
  priority: number;
  enabled: boolean;
  canExecute: boolean;
  disabledReason: string | null;
}

type ShellShortcutRoute =
  | { state: "dispatch"; ownerId: string; actionId: string }
  | { state: "blocked"; reason: string; preventDefault: boolean }
  | { state: "unclaimed" };
```

固定优先级为 modal > active Code Workspace ActionHost > active non-workspace tab > shell。`Ctrl+Shift+T` 在 active Code Workspace（包括 editor leaf 暂时为空但 reopen stack 非空）时路由 `workspace.reopenClosedTab`；只有没有 active workspace claim 时才创建 local terminal。composing/dead-key/AltGr 继续沿用 R1 gate。菜单点击直接按 action id 执行，不模拟快捷键。

**测试与 DoD。**

- decoder：undefined/null/wrong shape/missing entries/late response/root remove/workspace switch；失败后旧目录仍可见且可 Retry。
- routing：workspace empty leaf + reopen stack、welcome、terminal tab、modal open、disabled action、AltGr/composition；断言只一个 owner执行且 `preventDefault` 一致。
- mounted browser：C1 完整流程不崩溃并成功修改/冲突检查 Keymap；C4 关闭最后 tab 后一次 chord 重开文件，再切 welcome 验证同 chord 创建 terminal。
- `qa_ui_auto.audit --gate` 绿，C1/C4 实跑通过；不得只修 stub 而 native decoder仍接受 malformed payload。

完成 W0 只允许声明“shell/browser 主路径稳定、shortcut owner deterministic”；不提升 native/三端等级。

**W0 as-built（v4.63，2026-08-25）。** 按 §8.19.11 模板：

```text
包 ID / commit / capability ID
    W0 / 本包提交（feat/code-workspace-idea-parity） /
    workspace.tree-ipc-boundary, shell.shortcut-routing,
    workspace.reopen-closed-tab (shell claim)
As-built production call chain
    ①tree 边界：workspaceListDir/workspaceCompactChain/
      workspaceListFilesRecursive（src/lib/editor/workspace.ts）→ 结构校验
      decodeWorkspaceEntries/decodeWorkspaceCompactChain →
      WorkspaceTreeLoadResult<T>（ready{entries,truncated}/cancelled/
      unavailable/failed）；invoke 拒绝也转 failed，不再向上抛。
      useWorkspaceTreeData 三个 loader 只消费 union：ready 才写入 entries
      （副本），failed/unavailable 保留旧缓存 + error row + onError，
      cancelled 静默；generation 检查之外新增 findRoot(rootId) 存活检查
      （root 删除/workspace 切换后迟到响应不得复活缓存）。compact chain 的
      行走终点从 entries[0] 的 parent 推导（union 不携带 path），终点列表
      写行走键、请求目录保持自身 entries。
      stub（tauri-core.ts）补齐 workspace_compact_chain（单链下行镜像
      workspace.rs）与 workspace_list_files_recursive（仅文件、跳 .git、
      depth/file cap、大小写不敏感排序——镜像 collect_workspace_files），
      browser 与 native 同 shape。
    ②shortcut 路由：shellShortcutRouter.ts（纯模块，ShellShortcutClaim/
      ShellShortcutRoute 合同逐字实现；scope rank modal > active-workspace >
      active-tab > shell，同 scope 按 priority 降序）。CodeWorkspaceTab 在
      visible && reopenStack 非空时经既有 onCommandsChange 通道发布
      shellShortcutClaims（WorkspaceCommandRegistration 新可选字段）；
      MainLayout window-capture handler 先问 router：dispatch →
      executeAction(workspace.reopenClosedTab)；blocked → 仅 preventDefault；
      unclaimed → 原 new-terminal。注册经 ref 读取，监听器身份稳定。
      AltGr/dead-key/composition 沿用 R1 gate，未新增 window 业务 keydown。
修改 owner 文件（无关文件数 0）
    src/lib/editor/workspace.ts、useWorkspaceTreeData.ts、
    shellShortcutRouter.ts（新）、workspaceCommands.ts、CodeWorkspaceTab.tsx、
    MainLayout.tsx、src/stubs/tauri-core.ts + 对应测试
    （workspace.test.ts 新、useWorkspaceTreeData.test.tsx 重写、
    shellShortcutRouter.test.ts 新、CodeWorkspaceTab.test.tsx mock 委托层）。
旧缺陷复现 -> 结果
    ①C1：palette 输入触发 useWorkspaceTreeData
      "Cannot read properties of undefined (reading 'length')" →
      根因 workspaceListFilesRecursive 在 stub 缺命令时返回 undefined 直写
      FlatFilesState。现在：decoder 判别联合 + stub 同 shape；browser 实跑
      C1 完整 keymap 流程（palette→Actions→Keymap Settings→Copy scheme→
      录制 Alt+Shift+R→Enter commit→conflict→close）7.5-10s 绿，无
      RootErrorBoundary。
    ②C4：最后 editor tab 关闭后 Ctrl+Shift+T 被 MainLayout 抢走 →
      router claim 生效：browser 实跑 C4 关最后 tab→一次 chord 重开文件→
      切 welcome 同 chord 落 shell 创建并激活 Local terminal tab，12.9s 绿。
接口/schema/migration 与 compatibility
    WorkspaceTreeLoadResult 为新增导出类型；workspaceListDir 等 3 函数
    返回类型变化（唯一消费方 hook + CodeWorkspaceTab 3 处已同提交迁移）；
    WorkspaceCommandRegistration.shellShortcutClaims 可选字段（旧注册方
    不受影响）。测试 mock 经工厂委托把裸 fixture 转 union，fixture 写法
    不变。stub 新增 2 命令与 native 同 shape。
cancel/stale/error/disk/provider/undo effect
    stale：generation + root 存活双重丢弃；error：failed union 保留旧缓存
    + Retry 入口（error row）；cancel：cancelled 分支静默；disk/provider/
    undo：不涉及（W0 范围外）。
Unit / mounted host / Rust / QA browser / native / provider / IDEA compare
    unit：2941/2941 vitest 绿（含 decoder 8 例、hook 边界 8 例、router
    13 例）；tsc -b 绿。QA browser：C1+C4 同 run 双绿（10.0s/4.3s）、
    audit --gate 绿（0 lint/0 orphan/baseline 无回归）。Rust/native/
    provider/IDEA compare：未跑（W0 明示不提升 native/三端等级；native
    侧同代码路径由 R9 harness 覆盖，后续 W7 矩阵复验）。
未运行项及原因
    Rust 测试（本包零 Rust 改动）、native 实跑（DoD 限 browser 主路径；
    W7 矩阵统一复验）、pnpm build（tsc -b --force 已等价执行编译检查）。
最高可声明 L0-L3 + evidence layers
    shell/browser 主路径稳定（unit + browser 双层）；shortcut owner
    deterministic（unit + browser）。不提升 native/三端等级。
禁止声明仍有哪些
    不得声明 native/三端 shortcut 行为已验证；不得从 C1/C4 绿推导 G1
    release-ready（仍受 W1-W7 约束）。
残余风险与下一依赖包
    keymap 面板 Copy/Rename 用 window.prompt（浏览器可自动化，native
    webview 待 W7 验证）；palette 记忆上次页签属产品行为，case 已显式
    选 Actions。下一包：W1（依赖 W0 ✅ + R3/R6）。
```



#### 8.20.2 W1：Reference Information V3 与 Parameter 单一通道（G1/P0）

**目标校正。** IDEA 2026.2 当前公开分类是 Parameter Info、Quick Documentation、External Documentation、Type Info、Expression Static Data。现有 `context-info` 不能重命名后冒充静态数据；需要 schema migration 和显式 unavailable。

**Owner。** `referenceInfoController.ts`、`referenceDocumentation.ts`、`CodeMirrorHost.tsx` 的 signature tooltip、`QuickDocPopup.tsx`、`DocumentationPane.tsx`、`CodeWorkspaceTab.tsx` provider adapter、`src/lib/editor/lsp.ts`/`src-tauri/src/lsp.rs` 的 cancel bridge。尽量让 host 只负责 render，不再拥有第二套 request sequence。

```ts
type ReferenceKindV3 =
  | "parameter-info"
  | "quick-documentation"
  | "external-documentation"
  | "type-info"
  | "expression-static-data";

type ReferencePayloadV3 =
  | { kind: "parameter-info"; signatures: LspSignature[]; activeSignature: number; activeParameter: number }
  | { kind: "quick-documentation"; markdown: string; source: LspLocation | null }
  | { kind: "external-documentation"; url: string; title: string }
  | { kind: "type-info"; display: string; source: "provider" }
  | { kind: "expression-static-data"; facts: readonly StaticExpressionFact[]; source: "provider" };
```

V2 `context-info` 持久化/调用记录只迁为 `{state:"unavailable", reason:"legacy-context-info-not-expression-static-data"}`，不自动映射。Parameter explicit/typing trigger 均构造同一 request identity；controller 按 kind supersede/cancel，host只消费 `CapabilityResult<parameter>`。自动弹层默认延迟以设置为准，迁移时保留用户现值；显式 action零延迟。caret/document/provider变化关闭旧 tooltip，Esc仅取消当前 kind，不误关 completion。

QuickDoc 保留 popup -> 第二次 action/Pin -> Documentation pane 的工作流；history 只写 ready QuickDoc，failed/unavailable不写。External Documentation 的 https-only policy继续在 service boundary；入口必须依据真实 provider URL enable，禁止从 symbol name拼 URL。Type Info 只有 provider给出 typed payload才 ready；hover markdown不能转换为 type。Expression Static Data 若 jdtls/当前 provider无能力，保留可发现 action并显示 provider-unavailable，不实现本地文本猜测。

**真实证据。** 扩展 jdtls runner覆盖 overloaded method active parameter、nested call、generic signature、doc at project symbol/JDK/library source、supersede cancel、provider restart。Type/External/Static Data 只运行 provider支持项；unsupported trace也是有效证据，但等级保持 L0/L1。

**DoD。** 删除 Parameter 私有 request sequence或降为纯 display adapter；全仓只有 controller生成 reference request id。unit/mounted覆盖五 kind、延迟、Esc/focus restore、history/pin、URL policy、stale/cancel；QA C5 执行 explicit Parameter + QuickDoc + unavailable kind。G1 只在 Parameter/QuickDoc provider主路径 L2 后解除此项；不得宣称 Reference Suite complete。

#### 8.20.3 W2：Java Project Analysis truth 与 provider evidence foundation（G1/G2/P1）

**问题。** 当前 `WorkspaceSemanticIndexSnapshot` 是 revision/generation freshness ledger；它不能回答 module、source set、classpath、excluded/generated roots 或 analysis ready。W2 新建 provider-owned Project Analysis 事实源，不改造成自研 PSI。

**Owner。** 新增 `workspace/projectAnalysisModel.ts`、`useWorkspaceProjectAnalysis.ts`；复用 `WorkspaceSdkStatus.tsx`、`useWorkspaceLspSession.ts`、Rust `lsp.rs`/`sdk/*`；扩展 `__fixtures__/jdtls/runner`。旧 `workspaceSemanticIndex.ts` 保持内部兼容，但 UI 文案改为 Provider freshness，禁止显示“Index ready”。

```ts
type ProjectAnalysisPhase =
  | "unconfigured" | "scanning" | "importing" | "analyzing"
  | "ready" | "degraded" | "offline" | "error";

interface JavaProjectAnalysisSnapshotV1 {
  schemaVersion: 1;
  workspaceId: string;
  generation: number;
  provider: { id: "jdtls"; version: string | null; processId: number | null };
  phase: ProjectAnalysisPhase;
  projectFingerprint: string;
  sdk: { homeHash: string; version: string; languageLevel: string | null } | null;
  modules: readonly {
    id: string;
    buildSystem: "maven" | "gradle" | "plain";
    root: string;
    sourceRoots: readonly string[];
    testRoots: readonly string[];
    generatedRoots: readonly string[];
    excludedRoots: readonly string[];
    dependencyFingerprint: string;
  }[];
  progress: readonly { token: string; title: string; percentage: number | null }[];
  completeness: "unknown" | "partial" | "complete";
  diagnostics: readonly string[];
  startedAt: number | null;
  completedAt: number | null;
}
```

project fingerprint至少包含 canonical roots、build files content hash、JDK identity、provider version与可得的 classpath/module摘要；不能含绝对 home明文。`ready` 需要 provider initialized、相关 progress结束、当前 generation无 pending import且至少一次语义 probe成功；provider只报告 lifecycle但不给 module详情时为 `degraded/partial`，不能 complete。build file/root/JDK变化 bump generation并使旧 semantic result stale。

UI 在状态栏/Language面板展示 phase、provider、module数、degraded reason和 Retry/Restart/Show details；分析中仍允许纯文本编辑/文件搜索，semantic actions按 capability标 busy或 stale，不做静默 fallback。excluded/unloaded语义只有 provider/project model支持时开放设置；没有 owner时只展示事实。

fixture扩展五个现有项目：记录 module/source/test/classpath fingerprint、import progress、broken classpath degraded、build file修改触发新 generation、SIGKILL restart、offline cache。所有 W3-W5 runner场景复用同一 snapshot/request schema，禁止各自重新探测 JDK/jdtls。

**DoD。** Project Analysis 状态能解释 completion/usages/refactor为何 unavailable；Maven/Gradle single/multi/broken五项目 snapshot契约绿；root/build/JDK/restart stale测试绿；真实 trace脱敏。G1只要求状态诚实和恢复可用，G2的 complete仍按具体 provider/fixture决定。

#### 8.20.4 W3：Inspection、Diagnostic Presentation 与 Intention 分账（G1/G2）

**Owner。** `inspectionProfile.ts`（迁移为 presentation owner，storage key兼容）、`inspectionEvidence.ts`、`AnalysisPanel.tsx`、`ProblemsPanel.tsx`、`CodeWorkspaceTab.tsx` CodeAction管线、`lsp.ts`/`lsp.rs`；新增 `inspectionProviderAdapter.ts` 与 `intentionSession.ts`。不建设正则“本地 Java inspection”。

```ts
interface ProviderDiagnosticV3 {
  diagnostic: LspDiagnostic;
  evidence: CapabilityEvidenceV3;
  inspectionId: string;
  providerSeverity: 1 | 2 | 3 | 4 | null;
  relatedLocations: readonly LspLocation[];
}

interface IntentionCandidateV2 {
  id: string;
  title: string;
  kind: string;
  source: "provider-code-action" | "local-editor-action";
  preferred: boolean;
  disabledReason: string | null;
  resolveRequired: boolean;
  evidence: CapabilityEvidenceV3 | null;
}
```

现有 profile UI/类型应在可见文案和导出 schema 中命名为 `Diagnostic presentation profile`：enable/severity/suppression/baseline只决定本客户端显示。若用户选择 Suppress，只有 provider返回 source edit/command并经预览/apply成功才显示“Suppressed in source”；否则动作必须叫“Hide this diagnostic locally”，不得混淆。

Intention popup统一 Alt+Enter、gutter bulb、Problems quick fix、Search Actions：同一 frozen candidate session、same revision/generation、resolve状态、disabled reason和action id。provider action与local editor action分组；禁用/分配快捷键只针对稳定 action id，不能按动态标题持久化。resolve timeout保留候选并提供 Retry；apply复用R0，stale重请求。

全项目 inspection只有 provider明确支持 workspace diagnostic/特定可信命令时开放；否则显示“On-the-fly diagnostics only”。scope/profile设置若 provider无配置API就保持 presentation-only。关键词推断继续只作 `presentationHint`，不得进入 evidence completeness。Expression Static Data/data-flow 不属于本包的文本推断目标。

**真实 Java矩阵。** syntax error、unused import、unresolved type + import quick fix、dead code/probable null仅在jdtls实际返回时记录；main/test/multi-module/broken classpath、cancel/restart、stale action、resolve failure、additional edit/undo。IDEA expected比较“问题类别/动作结果/作用域”，不硬比私有inspection id或文案。

**DoD。** UI每条诊断显示 provider/scope/revision/completeness；local hide与source suppression名称不同；Alt+Enter各入口候选与执行结果一致；至少 unresolved import quick fix真实 jdtls trace + post-image hash/undo；unsupported full-project analysis有QA。最高声明拆为 diagnostics L2、某 quick fix L2/L3，不得写 IntelliJ inspections complete。

#### 8.20.5 W4：Navigation、Search、Usages 与 Hierarchy 语义闭环（G1/G2）

**Owner。** `SearchEverywhere.tsx`、`useWorkspaceNavigation.ts`、`ReferencesPanel.tsx`、`HierarchyPanel.tsx`、`javaSemanticEvidence.ts`、`CodeWorkspaceTab.tsx` provider fan-out；新增 `usageQuerySession.ts`/`semanticQueryEnvelope.ts`。W0先保证shell稳定，W2提供project fingerprint。

```ts
type UsageRole = "declaration" | "read" | "write" | "call" | "type" | "unknown";

interface SemanticQueryEnvelopeV3<T> {
  queryId: string;
  kind: "declaration" | "type" | "implementation" | "symbol" | "usages" | "call-hierarchy" | "type-hierarchy";
  evidence: CapabilityEvidenceV3;
  results: readonly T[];
  nextPageToken: string | null;
}

interface UsageQueryV3 {
  symbol: { uri: string; range: LspRange; displayName: string; providerSymbolId: string | null };
  scope: CapabilityEvidenceV3["scope"];
  includeDeclaration: boolean;
  includeLibraries: boolean;
  roleFilter: readonly UsageRole[];
}
```

Search Everywhere各 tab 保留 frozen ActionHost snapshot；File来自有界文件索引，Class/Symbol来自provider fan-out，Text转Find in Files。footer显示 provider count、failed/skipped、truncated、freshness；All模式不能把partial symbols混入后标complete。补 siblings、method up/down等 action前先确认provider/syntax owner，unsupported保持可发现但disabled。

Find Usages增加 scope dialog（project/open files/tests/libraries/custom provider-supported subset）、source preview、recent query stack与轻量 Show Usages popup；full Find tool window继续承载pin/group/page。popup与tool window共享同一 immutable session，二次 `Show Usages`切换默认scope或刷新，不复制结果真值。Reads/Writes/Declarations只有provider给role才enable；unknown结果留在All，不按文本猜。Libraries判定继续用canonical root/library owner。

declaration/type/implementation与call/type hierarchy都记录request identity、root item、lazy child request generation；provider restart或project fingerprint变化使展开节点stale并显示Rerun。library/JDK target保持read-only、source-download与外部doc入口。

**真实矩阵。** Maven/Gradle single/multi：declaration/type/implementation、cross-module usage、test usage、library target、overload/call hierarchy、interface subtype、cancel/restart/broken classpath。与IDEA对照scope/count类别/目标owner/preview，不要求排序相同。

**DoD。** C1/Search workflow绿；usage scope/pin/rerun/recent/popup/full-window一致；role filter不再假 enable；至少 declaration+usages+一种 hierarchy有真实trace和stale/cancel；每项单独声明。无provider role时可完成session L2，但role classification仍L0/unavailable。

#### 8.20.6 W5：Refactor completeness、conflict、preview、effect 与 undo（G2）

**Owner。** `javaSemanticEvidence.ts`、`safeDelete.ts`、`RefactoringPreviewDialog.tsx`、`codeActionExecution.ts`、`workspaceEditApply.ts`、`workspaceEditHistory.ts`、`CodeWorkspaceTab.tsx` Rename/provider refactor；扩展jdtls runner。禁止另建refactor writer。

```ts
interface RefactorPlanV3 {
  actionId: string;
  kind: "rename" | "safe-delete" | "extract" | "inline" | "change-signature" | "move" | "other";
  evidence: CapabilityEvidenceV3;
  completeness: "provider-complete" | "provider-partial" | "unknown";
  conflicts: readonly { severity: "warning" | "error"; message: string; location: LspLocation | null }[];
  operations: readonly LspWorkspaceEditOperation[];
  affectedUris: readonly { uri: string; revision: number | null; owner: "workspace" | "library" | "external" }[];
  excludableGroups: readonly { id: string; label: string; operationIndexes: readonly number[]; required: boolean }[];
}
```

`refactorApplyGate`升级并成为 Rename、Safe Delete、`refactor.*` CodeAction、Generate effectful action的共同入口：error conflict硬阻断；warning需显式confirm；destructive Safe Delete在completeness不是provider-complete时硬阻断；Rename/Extract等若provider协议不提供complete，可在UI标partial并要求preview，但不得宣称安全等价。library/external write硬阻断，除非用户明确复制到workspace且动作本身支持。

Preview按file/group展示operation与annotation，required group不可取消；用户取消部分edit后重新验证依赖，不能产生引用破坏仍显示safe。apply前重查所有open uri revision与project/provider generation；closed-file走R0 committer。首次失败停止，展示已应用/未执行、resume boundary和恢复入口；成功压为一个workspace history entry，undo/redo也记录逐operation effect。

动作目标分层：

| Tier | 动作 | v4.62 DoD |
|---|---|---|
| G2 必做 | Rename | cross-file/cross-module、冲突、stale、preview、single undo真实jdtls trace |
| 条件必做 | Safe Delete | 只有provider能证明complete才enable；否则诚实unavailable，不能用references数量推导 |
| 分项 | Extract Method/Variable、Inline、Change Signature、Move | provider返回相应CodeAction/command且能解析edit时逐项实现；缺能力保持disabled reason |
| 非语义 | tree file rename/move/copy | 继续归文件操作，不得计Java refactor |

**DoD。** `rg refactorApplyGate` 至少有Rename + provider refactor两个生产consumer；每个已启用动作有resolve fail/cancel/stale/conflict/partial apply/undo测试；Rename真实trace与IDEA expected。只允许写“Rename provider-backed L2/L3”或具体动作，不得写refactoring complete。

#### 8.20.7 W6：Settings/policy 与编辑边缘工作流收口（G1/G3，可拆提交）

W6可拆为下列独立子包；每个子包单独迁移、测试、QA和claim，不允许一次大提交混改全部owner。

**W6-A Clipboard History settings。** 在现有 Editor Appearance/Code Workspace settings中增加 enable、max entries(1-50)、max bytes、Clear；直接消费 `WorkspaceClipboardStore.setHistoryEnabled/setHistoryLimits/clearHistory`。sensitive/oversized exclusion显示非阻断原因；Clear二次确认且只清当前workspace session。持久化只存policy，不存clipboard内容；private/sensitive内容绝不进localStorage/trace。native clipboard denied时plain paste回退session并显示来源。

**W6-B Tab Policy V3 settings and consumers。** UI编辑limit/order/openPosition/activateOnClose/pinnedRow/reusePreview/previewMode；写入现有layout snapshot，损坏迁移保留backup。`orderTabsForDisplay` 与 `selectActivateOnClose` 必须成为实际consumer后才展示相应控件；否则保持disabled+reason。策略变化不得丢dirty/pinned tab，limit收紧要预览驱逐候选。detach继续不显示。

**W6-C Virtual Space and region folding。** 为vertical movement新增每caret desired visual column，Up/Down/Page/鼠标/矩形选择/typing/paste统一消费；tab/CJK/emoji测量复用 `VisualColumnPosition`。IME composing期间不物化padding。region marker在有parser时标`syntax-aware`，无parser时UI必须显示`Text marker folding (heuristic)`；不得把regex fallback升级语义等级。

**W6-D Code Style save actions/exclusions。** 合并 `CodeStyleSchemeV2.saveActions` 与独立 `intelligencePreferences.formatOnSave`，提供一次v3 migration和单一effective policy。save pipeline stage固定 format -> organize imports -> normalization；每stage显示executed/unavailable/failed，失败默认停止后续effectful provider stage但不丢用户文本。exclusion patterns/formatter markers有设置与provenance；selection/file是G1，directory/module/rearrange/cleanup保持disabled直到provider owner存在。逐字段provenance显示 explicit/EditorConfig/scheme/language/sniffed/fallback。

**W6-E Completion preferences。** 仅实现有真实consumer的auto-popup、case matching、sort mode、auto-insert-single、exclude/prioritize class/package。exclude/prioritize必须在请求前/候选presentation/auto-import三处一致，按project/global scope持久化；不能修改provider私有排序后宣称IDEA ML ranking。Smart设置保持disabled直到W8-A重开。

每个子包都要覆盖 corrupt storage、workspace切换、read-only、undo/focus、200% zoom与QA控件。W6全部完成也不包含detach、cleanup/rearrange、semantic postfix或native三端；它们分别归W8/W7。

#### 8.20.8 W7：Native三端、IME、性能、a11y 与 IDEA expected/observed（最终发布门禁）

> **已就绪基础（v4.62，R9 as-built，见 §8.19.10）**：native runner P2 全动词、
> workspace_root/vault_first_run fixture、绝对路径 app-data 隔离、
> `evidence-manifest.schema.json` + `qa-ui-auto-tests/native/`（manifest 模板/
> 三端 runbooks/a11y 人工清单）、`evidence_collect.py`/`perf_baseline.py`/
> `a11y_scan.py`；Linux 已有 TC-IDE-C0 native 两连绿（磁盘字节级证明）、
> perf browser 基线（key-to-paint p95 133-135ms 超标 finding 已挂账）、a11y
> 自动扫描 0 违例。W7 剩余 = 三端/IME/非US layout/200% 矩阵、G0 fault 分支
> case、provider trace、人工 smoke、IDEA compare、manifest 汇总。

**产物。** 新增脱敏 `qa-ui-auto-tests/evidence-manifest.schema.json` 与空模板；实际截图/trace/log放gitignored `qa-ui-auto-report/evidence/<app-hash>/<platform>/`。manifest记录commit/app hash、OS/WebView/arch、keyboard/IME/display scale/filesystem、JDK/jdtls/build tool、fixture/capability、步骤、结果、artifact SHA-256、known gap和最高claim。

```ts
interface EditorEvidenceManifestV1 {
  capabilityId: string;
  app: { commit: string; bundleHash: string; version: string };
  environment: { os: string; arch: string; webview: string; keyboard: string; ime: string; scale: number };
  provider: { id: string; version: string; fixture: string } | null;
  evidenceLayers: ("unit" | "mounted" | "browser" | "native" | "provider" | "idea-compare")[];
  result: "passed" | "failed" | "blocked";
  artifacts: readonly { kind: string; sha256: string; redacted: boolean }[];
  maximumClaim: string;
}
```

**平台矩阵。** Linux packaged app覆盖Wayland/X11（能取得的环境逐项记录）；Windows 11覆盖WebView2、AltGr/OEM/IME、CRLF/BOM、NTFS lock、UNC/长路径；macOS Apple Silicon覆盖Cmd/Option/dead key/IME/Retina/APFS/signing/quarantine。每端US+至少一种非US键盘、一种IME、100%+200% scale。`qa-ui-auto` 当前macOS不支持Tauri WebDriver，因此Linux/Windows可自动native，macOS必须用打包应用的人工/受控脚本smoke并在manifest标`manual-native`；不得伪造自动化结果。

**G0矩阵。** locked/permission/hash conflict、atomic replace各故障点、external watcher、UTF-8/BOM/UTF-16/Latin-1与LF/CRLF/CR、save-close/unmount、unknown disk effect、closed-file WorkspaceEdit、partial/resume/undo。任何未解释磁盘状态均使G0保持红。

**G1矩阵。** W0 C1/C4、two-stroke/AltGr/dead key/composition、clipboard denied/history/plain paste、多caret/virtual column、Switcher modifier-release、policy restore、Parameter/QuickDoc focus、Project Analysis degraded/restart、format/import、screen reader。C0/C2/C6-02使用真实native/provider fixture补跑；browser 5/6历史结果必须全量重跑，不能只重跑曾失败用例。

**性能。** 建同一硬件重复harness：key-to-paint p50/p95/p99，local action/Switcher，completion debounce/IPC/provider/paint/cancel，1MiB file、10k candidates、10k-file workspace、3+ splits的CPU/内存/long task。目标初值：typing p95 <=50ms、local action p95 <=100ms；先保存baseline再用百分比回归阈值，不能只报平均值。本轮Vitest 158 files/1310 tests为94.20s，只记录为CI wall-time baseline；它不证明或否定产品typing性能，可另设120s warning并持续采样。

**a11y/视觉可用性。** keyboard-only完成全部G1 case；dialog/menu/listbox/tab有role/name/state，focus trap/return、status live announcement、error/cancel一致；screen reader覆盖completion、save conflict/recovery、unavailable；high contrast、200% zoom、窄viewport、reduced motion无overlap/clip。`qa-ui-auto audit`不覆盖这些，需axe/人工screen-reader/截图与bounding-box检查组合。

**IDEA compare。** 在同一fixture与caret/range下记录 IDEA 2026.2 expected 和 Taomni observed：结果类别、scope、import/edit、conflict、undo、unavailable；不采集JetBrains私有ranking或源码。Basic Completion、Parameter/QuickDoc、navigation/usages、Rename至少各一条。只有 `idea-compare` layer通过的单项可升L3。

**最终DoD。** G0 native无未知effect；所有G1 capability至少L2且三端无阻断；performance/a11y manifest完整；R3/W1/W3-W5真实provider trace存在。缺任一平台只能声明“validated on <platform list>”，不得将G0/G1全局标绿。

#### 8.20.9 W8：Advanced 能力重开队列（默认不可领取）

W8不是当前顺序中的“第九个实现包”。coding agent只有在对应重开条件已经有可审计产物，并先提交独立ADR后才能领取；否则只维护typed unavailable与禁止声明。

| 子项 | 当前状态 | 重开条件 | 最小production owner与DoD |
|---|---|---|---|
| **W8-A Smart/Type-Matching Completion** | L0 unavailable | provider能返回expected type/context或项目明确引入可信本地semantic service | 独立action/session/ranking provenance；候选必须按type compatibility证明，Basic fuzzy结果不得改名；Java generic/overload/nullable fixture + IDEA compare |
| **W8-B Java SSR** | R8 defer | tree-sitter-java或显式修订backend schema；query/pattern语法、性能预算、migration确定 | parser/query service、typed variables、scope/cancel/page、replace preview/R0 undo；strings/comments false-positive固定fixture为0，绝不regex换皮 |
| **W8-C Maven/Gradle dependency completion** | R8 defer | trusted repository allowlist、credential/proxy policy、metadata cache TTL/offline策略确定 | position-aware pom/Groovy/Kotlin DSL parser、registry client、replacement range、source/freshness；不得内置popular list或在单测访问真实公网 |
| **W8-D Full Line local completion** | R8 defer | 签名模型+license/update channel、真实native decode、AVX2/ARM64探测、安全/隐私评审完成 | CodeMirror ghost-text StateField、accept all/word/line、popup协调、auto-import/one undo、cancel/stale、latency/memory；Terminal/cloud FIM不得复用名称或claim |
| **W8-E Expression Static Data / data-flow** | L0 unavailable | jdtls扩展或可信analysis provider返回可追溯facts/path proof | W1 payload、provider evidence、branch/value/nullness事实UI；文本/关键词/hover猜测禁止；逐fact source与stale状态 + IDEA Java fixture |
| **W8-F Code Vision** | L0 | W4 usages/hierarchy结果有稳定symbol id、scope/coverage与增量invalidations | viewport-bounded lenses、click -> shared usage session、partial/stale徽标、large-file budget；不得仅显示硬编码计数 |
| **W8-G Scratch + language injection** | L0 | scratch ownership/persistence/security与embedded language provider routing ADR完成 | scratch不混入workspace写盘/recovery；injection有host<->embedded range mapping、diagnostic/completion/format remap、undo与nested/escape fixture |
| **W8-H Editor detach** | defer | multi-window buffer/controller ownership、IPC/event routing、dirty close/recovery与platform window ADR完成 | 单buffer owner、多view同步、focus/keymap/window close/restore；Linux/Windows/macOS packaged evidence，未满足前不显示入口 |
| **W8-I Semantic templates/Surround/Generate** | local/provider partial | W2/W5能给syntax/provider identity、typed applicability、placeholder/import edits | variable functions、Tab/choice placeholders、shorten imports、typed postfix applicability；每language/action单独trace，不能用Lezer node名宣称PSI |

ADR必须包含：依赖/license/security、生产call chain、failure/unavailable UI、migration/rollback、性能预算、平台矩阵、fixture、最高允许声明和撤回条件。只有schema、纯函数或disabled按钮不构成重开。

#### 8.20.10 合并顺序、owner 冲突与 agent 回报

1. W0先合并并重跑C1/C4；在此之前不要用失败的shell workflow验证其它包。
2. W1可与W2并行，但都触及 `CodeWorkspaceTab.tsx` 时先约定区域：W1只改reference/signature adapter，W2只改project/LSP lifecycle。W3-W5统一消费W2 fingerprint/evidence。
3. W3/W4只请求/展示结果；任何edit仍进R0。W5是唯一可以改变refactor apply gate的包。
4. W6按A-E独立提交，行为owner与settings/catalog同提交；不得把五个子包压成一个review单元。
5. W7不修产品缺陷来“顺便转绿”；发现缺陷回到对应W0-W6 owner修复、补unit后再重跑manifest。
6. W8默认不可领取；满足重开条件也必须先交ADR commit，再交implementation commit。
7. 每次合并运行聚焦Vitest、`pnpm build`、受影响Rust tests、`qa_ui_auto.audit --gate`及可运行browser/provider case；未运行项写环境与恢复命令。

coding agent 最终回报固定为：

```text
包 ID / capability ID / commit
生产入口 -> owner -> provider/IPC -> result/effect -> UI 的完整 call chain
修改文件与明确未改边界（无关文件必须为 0）
旧缺陷/旧状态 -> 新状态机
schema/version/migration/rollback
cancel/stale/unavailable/failure/conflict/disk/undo 语义
Unit / mounted / Rust / QA audit / browser / native / provider / IDEA compare
每条未运行项、原因与复现命令
最高允许 L0-L3、evidence layers 与 platform/provider 限定
禁止声明
残余风险与下一依赖包
```

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| 装配层重构回归 | `CodeWorkspaceTab.tsx` 已超过 12k 行，action/style/LSP/file/execution 状态耦合 | 行为不变原则 + 聚焦测试 + 回归清单；按 §8.20 owner 分区抽 shell/reference/project-analysis/navigation controller，再分离 X 轨道装配 |
| LSP 服务器差异 | completion/rename/hierarchy 各 server capability 差异大 | §5.2.0 capability 驱动开关；不支持则置灰 + hint；§5.2.12 矩阵仅作方向参考 |
| WorkspaceEdit 非原子 | 跨文件重命名可能部分成功 | 有序执行在首次失败处停止并呈现结果；单个 overwrite 资源操作使用备份/恢复保护旧目标，但不虚构跨操作事务 |
| 补全性能/竞态 | 高频输入下请求风暴、过期回填 | 防抖 + 请求代际取消；resolve 惰性化；isIncomplete 续查 |
| 快捷键冲突 | IDEA 键位与应用/系统习惯冲突（Ctrl+W/N/P 等） | when-context 路由；冲突项文档化并留别名 |
| 搜索性能 | 超大仓库 Find in Files | 流式分批 + 上限截断 + 可取消；ignore crate 跳过 .gitignore |
| 分屏共享 buffer 复杂度 | 双 view 已可用，递归 layout 后同步/焦点/关闭更易竞态 | 保持单 buffer ownership；先定义递归 layout state 与迁移，再逐步开放 nested split |
| Inlay hints 抖动 | 编辑时 hint 频繁重排 | 视口 range + 滚动/编辑防抖；默认关，用户主动开启 |
| 底部终端生命周期 | 工作区关闭时 PTY 泄漏 | 随 tab 卸载显式销毁；复用现有 TerminalPanel 清理路径 |
| Shell / Workspace shortcut owner 冲突 | R1 已收敛 workspace 内部 ActionHost，但 `MainLayout` 仍会在最后一个 editor tab 关闭后抢占 `Ctrl+Shift+T`，window capture 与 workspace context 的优先级可再次分叉 | W0 定义 shell action broker、route/focus/context owner 和 `preventDefault` 规则；同一快捷键在 editor-open、editor-empty、terminal-focused、dialog-open 四态做 mounted/browser/native 回归 |
| Action context 分叉（历史已修，仍需防回归） | `a4584916` 曾让 `getState`/`execute` 分别构造 context，`c5ce1fd6` 与 R1 已恢复单一 `buildContext` 和 executable snapshot | 保留同一命令由 keymap、menu、palette、mouse 进入时结果一致的合同测试；W0 修改 shell broker不得重建第二套 `when`/focus/payload 解释器 |
| ActionHost 生命周期回归（历史已修） | `5ce13c9a` 曾以删除 `host.dispose()` 绕过 StrictMode 双挂载；R1 已恢复 workspace-scoped 创建、释放和隔离合同 | 保留双 workspace、StrictMode、真实 unmount/disposed 后行为测试；W0 shell broker只持弱/可撤销注册，不延长 workspace host 生命周期 |
| Save/recovery 合同的 native 事实未验证 | R0 已补齐 intended hash、foreign/unknown、discarded writeback、closed-file committer与逐 operation resume；风险已从“代码路径缺失”转为三端文件系统/编码/锁/崩溃证据不足 | 按 §8.20.8 跑 locked/permission/atomic-replace/watcher/encoding/partial-resume manifest；任何未知 disk effect 保持 G0 红，不以单测替代 packaged native 结果 |
| 跨语言硬编码语义 fallback（历史已 containment） | 固定 Java import表已移出 production；回归风险是未来 dependency/Generate模型重新接入时绕开 identity/provider evidence | 所有 completion/import 携带 language/revision/provider generation；provider unavailable只回退明确标注的普通 word/template；非 Java负例为合并门禁 |
| 实验 fixture 再次冒充能力 | Maven/Gradle dependency、Full Line 和 `companionCapabilities` 中部分 advanced schema 仍无 production owner；`inspectionEvidence` 的文本推断也可能被误称为本地 inspection。Code Style 已有 production consumer，不能再列为零 consumer | experimental目录禁止 production import；W8满足重开条件并先交 ADR；文本推断只作 presentation hint；CI做reachability guard；Code Style残项按W6-D的真实consumer逐项验收 |
| 提交混入与项目级格式化 | `c5ce1fd6` 一次提交 144 文件（123 个 `.rs`，含 LanChat/agent/hbase 无关改动与全仓 import 重排），违反 `CLAUDE.md` 且掩盖真实缺陷 | 一包一提交；Rust 只格式化本包改动文件；review 前用 `git show --stat` 自检无关文件为 0 |
| EditorConfig 误解析 | 父目录链、glob 相对路径、`root=true`、外部变更和非法值处理错误会 silently 改变格式 | resolver 与 parser 分层；缓存带 mtime/hash；逐字段 provenance/diagnostic；fixture 覆盖嵌套与 root stop |
| 保存规范化破坏文本 | formatter、organize imports、EOL、charset、trim/final-newline 的 await/顺序错误，或 writeback 覆盖新编辑 | 保持 R0 PreparedSave/pre-write boundary/merge-only writeback；W6-D统一 save stage policy，W7覆盖编码、外部 hash、foreign effect与失败恢复 |
| Capability stale merge | 空 capability 摘要保护可能把旧 session 的能力带到新 provider | 用 session generation + provenance；新 session 先 reset 为 unknown，只有同代空增量才允许保留 |
| CM memo comparator stale callback | 忽略 callback identity 后新增 prop 未同步 ref/comparator，旧闭包继续执行 | prop matrix 契约测试；行为 prop 必须有 ref、比较和 unmount/rapid-switch 回归 |
| Completion 过度截断/误判上下文 | 200 项 cap、Lezer 节点名差异、lexical fallback 可能隐藏合法候选或在字符串中误触发 | 返回 truncation/source/reason；显式/trigger/typing 分流；跨语言 syntax fixture 和真实 p95 门禁 |
| 范围蔓延 | “像 IDEA”没有边界，伴随能力容易挤占编辑器主线 | 以 §2.3、§2.30 能力边界和 §8.20 排序评审；X 轨道独立记账 |

---

## 10. 已定原则与待决实现选择

1. **参考基线已定**：IntelliJ IDEA 2026.2 Core Editor + Java；其他语言逐 provider/fixture 记账，不宣称整体现代 IDEA 等价。
2. **范围已定**：Build/Run/Debug/Test/Coverage、Terminal、Git Manager、AI、远程工作区为 X 轨道；只把其 editor action/gutter/navigation 计入 Editor。
3. **Code style 优先级已定**：explicit file override > EditorConfig > language/workspace default > sniffed fallback；状态栏必须展示最终值与来源。
4. **Keymap 路线已定**：保留已接入的 IDEA platform defaults 与自定义 scheme；R1 的 workspace-scoped ActionHost 合同作为既有真值，W0 只补 shell/workspace shortcut broker 与 tree boundary，不能引入第二套 dispatcher。schema 为其它 preset 保留扩展，但 preset 内容不阻塞 G1。
5. **语义路线已定**：provider-first；Java 先以真实 jdtls/project fingerprint 建 capability confidence。只有 fixture 证明 provider 无法满足已纳入目标的语义时，才通过 ADR 决定是否补本地 parser/index；自研 PSI/CFG/data-flow 不再是 G2 前置条件。
6. **模板/生成路线已定**：只有通过 type/context/provider 校验的变换才计作语义能力；固定文本模板可保留，但必须标为 local template。
7. **布局路线已定**：production 只保留递归 layout tree，`primary/secondary` 旧渲染分支不再长期兼容；schema migration 负责读取旧快照。detach 必须先完成 R5b window ownership/reconnect/crash ADR，不能从 recursive split直接推出。
8. **默认显示已定**：inlay hints 继续默认关、semantic highlighting 默认按 provider 开、large-file 自动降级；每项必须可解释并可按语言配置。
9. **Full Line 边界已定**：只对齐 IDEA Ultimate 默认 bundled plugin 的 Code Editor 工作流，Java 先行、本地离线和隐私为验收条件；不因此纳入 AI Assistant 或通用插件兼容。
10. **运行时真值已定**：instance-scoped `WorkspaceActionHost` 的 executable definitions/snapshot 是目标唯一 action truth；global `workspaceActionRegistry`、静态 catalog 和旧 `WorkspaceCommand` 仅作迁移输入。`when` 必须是可验证的结构化表达式，action state 必须携带来源、freshness 和 completeness。
11. **EditorConfig 解析边界已定**：parser 无文件系统副作用，resolver 负责父目录链、root stop、缓存/失效和 provenance；仅有 EOL/charset 等非缩进属性也必须生效；保存 normalize 与 formatter 是两个可观察阶段。
12. **Completion 性能语义已定**：80ms debounce、trigger immediate、200 项 cap 是性能护栏而非 IDEA Smart Completion；request reason、session/document generation、truncation/source 必须显式可观测，不能用提高 cap 或静默 fallback 宣称语义完成。
13. **保存提交边界已定**：prepare 可 await 但不能改 buffer text；最终 revision/style/identity guard 后必须在同一 call stack 调唯一 byte writer；writeback 只按 current revision 合并。writer-issued 后必须记录 disk/memory/provider effect，foreign/unknown阻止retry，所有 WorkspaceEdit operation共用 R0 ledger。
14. **Import 来源已定**：自动 import 只能来自带 project/classpath 语义的 provider，或由后续 ADR批准的本地 index；硬编码类型表只能作 fixture，provider unavailable 不猜测候选。
15. **Reference 信息 owner 已定**：Parameter Info、Quick Documentation、Type Info、External Documentation、Expression Static Data 共用 workspace-scoped identity/cancel/cache/history owner，但保留独立 payload/capability/UI；旧 `Context Info` 不再作为 IDEA 2026.2 目标，普通 hover markdown不能冒充结构化 type/URL/static-data facts，Usages/refactor复用同一 provider generation。
16. **Appearance 分账已定**：Code Workspace editor profile 与 Terminal、Markdown、应用 UI theme、code-style formatter 独立；运行期通过 CodeMirror compartments 更新，不重建 document state。
17. **仍待决**：是否需要补充 Java 本地 parser/index及其 ADR、W8 的 Structural Search parser/query技术、Full Line 模型/runtime与分发许可、scratch/injection文件所有权、detach窗口架构，以及 W7 三端真机设备矩阵的具体机器清单。Clipboard History 首批策略已定为 session-only、默认不落盘、可 Disable/Clear。

---

## 11. Java 深度支持历史计划（v3.0，M6–M11）

> 本节保留 M6–M11 的 Java 工程、测试与调试实施记录。v4.30 起，jdtls 编辑语义、Java project-analysis/inspection/refactor 归 Editor；Build/Run/Test/Debug/DAP 归 X 轨道。当前目标、状态和下一顺序以 §2.30 与 §8.20 为准。

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
1. **✅ 重构预审用法树与复选框过滤 UI**：实现 `RefactoringPreviewDialog` 弹窗，按文件分组呈现 raw WorkspaceEdit、行号和新文本，并可逐 edit 包含/排除。语义依赖、conflict 与安全排除仍属于 §8.4 J0/J1。
2. **✅ 缩进检测与状态栏标签 UI**：`detectIndentation` 可识别 2/4 spaces 与 tabs，状态栏可循环标签；EditorConfig/保存事务闭环属于 §8.4 I2。
3. **✅ 快捷键速查与物理键帽 UI**：`KeymapCheatSheetDialog` 可分类、搜索和执行固定命令。可编辑 scheme、录键、反查、冲突与迁移仍属于 §8.4 I1。
4. **✅ 测试覆盖率报告解析与编辑器覆盖条 (Test Coverage Ingestion, Gutter & Dock Panel)**：实现 `coverageModel`（支持 LCOV 与 JaCoCo XML 格式报告解析及多模块文件路径匹配）、`coverageEditorChrome`（CodeMirror 侧边栏绿/黄/红三色覆盖指示条）与 `CoveragePanel`（底部 Dock 统计面板、进度条、文件过滤与未覆盖行跳转），注册 `workspace.showCoverage` 命令并与工作区扫描联动。
5. **✅ 多语言 DAP 适配器引导与配置模板 (DAP Debug Adapter Setup Guide & Templates)**：实现 `DapAdapterGuideDialog` 覆盖 Java (JDWP)、JavaScript/Node (`vscode-js-debug`)、Python (`debugpy`)、Go (`dlv`)、Rust (`lldb-dap`)、C++ 适配器的安装指南、运行环境规范与 `.taomni/run-configurations.json` 模板一键复制，注册 `workspace.openDapAdapterGuide` 命令。
6. **✅ 工程模型多模块依赖拓扑与模块层级 (Multi-Module Dependency Topology in BuildPanel)**：在 `BuildPanel` 中呈现多模块工程的完整模块树、模块语言级别徽章与 `dependsOn` 依赖链，打通与底层 `workspaceExecutionModel` 的深度联动。
7. **✅ Debug 变量树与调用栈右键快捷菜单 (Variable Tree & Call Stack Context Menus)**：在 `DebugPanel` 中支持对变量节点右键直接触发「添加数据断点」、「添加到监视」、「复制变量值/名称」、「设置变量值」；支持对调用栈帧右键执行「Jump to Source」、「Drop Frame / 栈帧重置 (`restartFrame`)」、「复制调用栈」等高频动作。
8. **✅ 调试单步过滤配置 (Step Filters: 跳过 JDK/标准库/框架代码)**：在 `WorkspaceBuildRunToolsDialog` 中提供 Step Filters 开关与规则配置（可自定义类与包过滤模式、跳过 synthetic 方法、跳过 `<clinit>` 静态初始块、跳过构造函数），并在启动 DAP 调试时自动装配注入调试器启动载荷。
9. **✅ 分屏编辑器同步滚动联动 (Synchronized Split Scrolling Toggle)**：在顶部工具栏与命令面板（`workspace.toggleSyncSplitScroll`）提供双向视口滚动镜像联动与防递归事件门禁，方便并排对比代码或跨文件审查。
10. **✅ QA UI 自动化端到端用例编目沉淀 (`qa-ui-auto-tests/`)（历史交付）**：曾在 `feature-list.md` 中为 F25.1 补齐 step filters 与 split sync scroll 交互控件定义并生成 `TC-auto-F25-1`；R2 已修复后续发现的 stale selectors/catalog 问题并使静态 gate 转绿，但 browser 当前仍为 5/6 可运行核心 case 通过，native/provider/三端门禁按 §2.30.4/§8.20.8 继续记账。

---

## 12. 后续进阶路线与三端真机验收计划

本节只维护 X 轨道和最终真机门禁；Editor G0/G1/G2/G3 当前待办与详细实现合同统一见 §8.20，完成状态见 §2.30。

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

- Debug 工具窗 v1 as-built 对账和 v2 Console/Frames/Actions/Responsive 详细设计见 `claudedocs/debug-panel-idea-redesign.md` §13–§15；本节只保留 adapter 语义与真实运行门禁，避免两处重复维护 UI 待办。
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
