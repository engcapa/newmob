# Code Workspace 轻量 IDE 化设计方案

> 目标：在现有 Code Workspace 基础上做功能与交互完善，达到"日常代码开发够用"的 IntelliJ IDEA 级体验（非全量对标）。本文档为设计稿，不含实现代码。
>
> 日期：2026-07-25 · 版本：v3.1（M6 Java 基础对齐代码交付：`c35d963` jdtls `java.*` 设置全集 + `4a06f91` 大文件降级守卫/增量 diff 提速；ChangeSet→LSP 全量重写按失步风险显式后置，见 §11.B。M7–M9 未开工）· 状态：**实施中**（M0–M5 已合入 `main`；M6 代码已交付于 `feat/code-workspace-m6-java`，真机冒烟后置；M7 全项目诊断需先 spike，M8–M9 测试与调试(DAP)详见 §11）
>
> 早期版本：v3.0（2026-07-25，新增 §11 M6–M9 计划并修订 §2.3 非目标）。
>
> 早期版本沿革：v2.10（2026-07-12，M0–M5 主线交付与后续收口）。

---

## 1. 现状盘点（As-Is）

| 领域 | 已有能力 | 载体 |
|------|----------|------|
| 工作区模型 | 多根目录（folder/git）+ 松散文件（loose files）、最近工作区 | `CodeWorkspaceTabInfo`，tab 类型 `code-workspace` |
| 文件树 | tree/compact/flat 三种视图、名称过滤、新建/重命名/删除、Git 状态徽标、树字号缩放 | `CodeWorkspaceTab.tsx`（当前约 3.7k 行单文件，文件树视图壳已抽离） |
| 编辑器 | CodeMirror 6：行号、折叠、括号匹配、多光标、历史、词级补全、活动行高亮 | 同上 |
| Markdown | edit/preview/split，Mermaid 渲染 + SVG/PNG 导出 | 同上 |
| LSP | 10 种语言预设 + 自定义命令；didOpen/Change/Save/Close、publishDiagnostics、hover、definition、references；服务探测 | `src-tauri/src/lsp.rs`、`src/lib/editor/lsp.ts` |
| Git | 快照/暂存/提交/日志/diff/分支/标签/stash/merge/rebase/cherry-pick/冲突/远端认证 —— 已相当完整 | `src/lib/git.ts`、`components/git/WorkspaceGitManager` |
| 外观 | code view profile（主题/字号）与设置页共享，编辑区/树独立缩放 | `codeViewProfile.ts` |

**明确缺失（vs 日常 IDE 开发）：**

1. 编辑器内查找/替换（未引入 `@codemirror/search`）
2. 语言智能只有"只读四件套"（诊断/悬停/定义/引用）——无补全、签名帮助、快速文档、重命名、格式化、Code Actions、类/符号查找、调用层级、类型层级、实现跳转、用法高亮、inlay hints
3. 全局内容搜索（Find in Files）——只有文件名过滤
4. 导航体系：Search Everywhere、Go to File/Class/Symbol、Recent Files、前进/后退
5. Problems 汇总面板、Outline/结构视图
6. 编辑区分屏、编辑器 tab 管理（固定/关闭其他/中键关闭）、面包屑
7. 集成终端（终端目前是独立 tab，与工作区无联动）
8. Git 编辑器内呈现：gutter 变更标记、inline blame
9. Run/Tasks（脚本探测与运行）
10. 本地历史（Local History）
11. 树右键菜单、拖拽（文件操作目前依赖工具栏按钮）
12. 仅支持本地文件系统（`workspace.rs` 全部走本地路径）

---

## 2. 目标与范围

### 2.1 产品定位

Code Workspace 是 taomni 内的"轻量 IDE 面"：日常改代码、查代码、提交代码的主战场。重活（调试、重型重构、Profiling）仍交给外部 IDE，taomni 的差异化是**与终端/SSH/SFTP/AI 的一体化**。

### 2.2 范围分级

| 级别 | 内容 |
|------|------|
| **P0（核心补齐）** | 编辑器查找替换；语言智能核心（补全/签名/快速文档/重命名/格式化/Code Action/类与符号查找/实现与类型跳转/文档符号）；Find in Files；Search Everywhere + 导航体系；Problems 面板；Outline；树右键菜单 |
| **P1（体验对齐）** | 编辑区分屏、编辑器 tab 管理、面包屑、集成终端底部面板、调用层级/类型层级、用法高亮、inlay hints、Git gutter/inline blame、Run/Tasks、工作区状态持久化增强 |
| **P2（差异化/加分）** | 本地历史、TODO/书签面板、语义高亮、AI 深度集成（解释/修复/生成 + diff 应用）、远程工作区（SSH 根目录）探索 |

### 2.3 非目标（明确不做）

> **v3.0 范围变更**：原列为非目标的「完整调试器（DAP）」与「构建系统模型」已纳入 §11 的 Java 深度支持计划（M6–M9）。调试改为通用 DAP 框架分阶段实现；构建集成只做依赖树/生命周期/模块视图，不做 IDEA 级 facet 建模。下表为更新后的非目标清单。

- **索引式重构**（move class、change signature 等超出 LSP 能力的重构）——只做 jdtls code action 提供的重构
- **IDEA 级 project model / facet 体系**——构建集成止于依赖树/生命周期/模块视图（§11 F），不建完整 facet 模型
- **插件系统 / 市场**
- **Profiler / 内存分析器**
- 不替代现有 Git Manager 的完整功能，只做编辑器内的轻量呈现与入口
- **远程 jdtls**（在 SSH 主机上运行语言服务器）——仍在 §5.13 spike 之外

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
- 客户端二次排序：camelCase 缩写匹配（`CWT` → **C**ode**W**orkspace**T**ab）> 前缀 > 子串；同分按路径长度升序。
- server 的 query 语义差异（有的做模糊、有的做前缀）通过客户端 re-rank 抹平。
- 无可用 LSP 时 Classes/Symbols tab 隐藏（不展示空壳）。

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

**运行：**

- 底部 Run tab：任务列表（按根分组）+ 运行历史；点击任务 → 集成终端新实例以 PTY 运行（保留颜色与交互），Run tab 显示状态（运行中 / 退出码）。
- `Ctrl+F5` 重跑上一个任务；自定义任务（命令 + cwd，持久化到工作区状态）。
- 不做：运行配置对话框的复杂参数体系、环境变量管理 UI。

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
| | `lsp_code_actions` / `lsp_execute_command` | applyEdit 回推 → Tauri event `lsp:apply-edit` + oneshot 应答（复用 cc_bridge HITL 模式） |
| | `lsp_document_symbols` / `lsp_workspace_symbols` | Outline / Go to Class·Symbol |
| | `lsp_call_hierarchy_prepare` / `_incoming` / `_outgoing` | 调用层级 |
| | `lsp_type_hierarchy_prepare` / `_supertypes` / `_subtypes` | 类型层级 |
| | `lsp_inlay_hints` | 视口 range 请求 |
| | `lsp_selection_range` / `lsp_folding_range` | 智能选区 / 折叠（P1/P2） |
| | `LspDocumentStatus.capabilities` 扩展 | server capabilities 摘要下发（§5.2.0） |
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
| **M8 测试与调试基建（P1，§11 Bundle+E+D1–D2）** | jdtls bundle 基建（java-debug/java-test 加载与探测）；测试集成（探测 + run-only + 结果树）；**通用 DAP 内核 + 适配器注册表（dap.rs，语言无关）+ Java 适配器（首个插入）** | L | 🔶 Bundle 基建（`4929467`）+ D1 通用 DAP 内核（`dap.rs`：分帧编解码/消息分类/session 泵/注册表/start·send·terminate 命令，语言无关、空注册表）代码已交付；D2 Java 适配器 + E 测试 run-only 后续；真机冒烟后置 |
| **M9 调试主线 + 收口（P1/P2，§11 D3–D5+E）** | 断点/单步/调用栈、变量/监视/求值、条件断点/异常断点/热重载；debug-test；真机冒烟回填 | XL | ⬜ 未开工（依赖 M8 的 D1–D2） |

依赖关系：M0 是一切前提；M1/M2 内部可并行（后端 LSP 扩展与搜索模块独立）；M3 依赖 M0 的 dock 容器；M4 的层级面板依赖 M0 dock + M2 的 LSP 请求管道。**M6 两条线（A/B）互相独立可并行，且不依赖 M1–M5 之外的新前提；M7 的全项目诊断（C）依赖 M6-A 的 `autobuild`，构建增强（F）独立；M8 的测试/调试依赖 Bundle 基建，DAP 内核（D1）可与 M7 并行起步；M9 的 debug-test 依赖 M8 的 D1–D2。** 每个里程碑独立可发布、可验收。M6–M9 的完整拆分见 §11。

### 8.1 进度明细（勾选清单）

> 更新于 2026-07-12（v2.10）；自动化门禁于 2026-07-25 在 `fix/code-workspace-nav-history-and-library-goto` 复核恢复全绿（见下方横切事项）。M0–M5 已由 PR #361 合入 `main`；后续收口位于 `feat/code-workspace-followups`。功能按代码、提交与自动化门禁复核；真机冒烟由用户执行并待回填，M0 壳拆分技术债继续消化。完成度按本节拆分条目计数，已完成项附提交号。

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
- [x] Code Actions / Alt+Enter（客户端 WorkspaceEdit 应用；server 回推 applyEdit oneshot 仍可增强）— `b049952` + `5d87203`
- [x] 树键盘导航（↑↓←→/Enter/F2/Delete）；拖拽仍为 P1 — `1d8fa2f`
- [x] 替换（Replace in Files via shared WorkspaceEdit applier）— `e7873ef` + `5d87203`

**M3 布局与终端（P1）— ✅ 5/5**

- [x] 编辑区二分屏（共享 buffer/LSP session、水平/垂直、可调整尺寸、末 tab 自动收起；树/搜索 `Ctrl+Enter` 分栏）— `345379f` + `7b29391` + `f8f3665`
- [x] 编辑器 tab 行为（单击预览/双击固定、pin、关闭其他/右侧/未修改/全部、中键与 `Ctrl+F4` 关闭、溢出下拉、路径/树/资源管理器/终端菜单）— `d445d79` + `f8f3665`
- [x] 面包屑（根/目录/文件路径 + 随光标更新的 documentSymbol 符号链）— `81a494b`
- [x] 集成终端底部面板（复用 `TerminalPanel`、当前根 cwd、多实例/根选择、`Alt+F12`、工作区卸载清理）— `49c53fc`
- [x] Run/Tasks（多生态 `workspace_detect_tasks`、按根分组、自定义任务持久化、运行历史、PTY 复用与真实退出码）— `da62223`

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
- [x] 合并门禁 8 例 Windows 失败已修复（clipboard URI ×4、pushd ×1、git 根 ×3）— `f6c1f36`
- [ ] **⚠ 真机验证欠账（由用户执行）**：M0–M5 能力仍以单测/构建为主；`pnpm tauri dev` 冒烟结果回填本节
- [ ] ⚠ M0 继续瘦身：树数据、LSP session、Git snapshot、导航与文件动作 controller 已抽离；命令注册、header/layout 大段继续下沉，目标装配壳 <400 行（当前约 4.4k 行）
- [ ] ⚠ 下列增强项可选收口：server 回推 `workspace/applyEdit` oneshot；树/tab 拖拽停靠（P1）；`WorkspaceFs` 生产只读链路

### 8.2 下一步待办（建议顺序）

> M0–M5 计划项均已交付并合入主干。后续收口已完成自动化门禁固化，Git snapshot、导航与文件动作 controller 抽离，以及保存时格式化和 Git ignore。**原 3 项 Windows `rdp::cliprdr` 门禁失败（及顺带发现的 `chat::acp` 同类失败）已于 2026-07-25 修复，全量 `cargo test` 恢复全绿 — `d2861f4`；真机冒烟仍由用户执行。**

1. **✅ 固化全量前端门禁参数** — `a9f7484`
   `vitest.config.ts` 已统一设置 `testTimeout: 15_000` 与 `maxWorkers: 4`；无额外参数的 `pnpm test` 全绿。

2. **（用户执行）真机冒烟并记缺陷**
   `pnpm tauri dev` 覆盖 M0–M5 快捷键、分屏、PTY、Git gutter/blame、本地历史、AI 入口、语义高亮和 TODO/书签；结果回填本节。

3. **🔶 继续 M0 瘦身（目标装配壳 <400）**
   Git snapshot、导航与文件动作 controller 已抽离 — `cbc40ec`、`057006a`、`d97b2cb`。下一步组件化命令注册和 header/layout；当前壳体约 4.4k 行。

4. **（可选）体验补丁**
   工作区级保存时格式化与 Git ignore 已交付 — `4ff2ed7`、`6b41676`。剩余：server 回推 `workspace/applyEdit` oneshot；树/tab 拖拽停靠；评估把 `WorkspaceFs` 接入一条生产只读链路。

5. **✅ 合入主干**
   M0–M5 已由 PR #361 合入 `main`；后续收口分支待独立合并，真机冒烟结果可在后续独立补录。

6. **🔶 Java 深度支持（M6–M9，§11 新增）**
   突破原 §2.3 非目标，深化 Java 工程能力。**M6 代码已交付**（`c35d963` A：jdtls `java.*` 设置全集 + 热更新 + Lombok；`4a06f91` B：大文件降级守卫 + 增量 diff 提速；ChangeSet→LSP 全量重写按失步风险显式后置，见 §11.B）——真机冒烟随 M0–M5 一并后置。下一步 **M7** 工程智能：全项目诊断需**先 spike** jdtls `java.buildWorkspace` 是否对未打开含错文件推送 `publishDiagnostics`（§11.C 硬门槛），构建集成增强（§11.F）独立可并行；**M8/M9** 为测试与调试（DAP）——分 D1–D5 阶段推进，通用 DAP 框架而非 Java 特判。完整方案、命令清单与风险见 §11。

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| M0 重构回归 | 4.4k 行组件拆迁易碎 | 行为不变原则 + 聚焦测试 + 回归清单；按 controller/面板分多个提交 |
| LSP 服务器差异 | completion/rename/hierarchy 各 server capability 差异大 | §5.2.0 capability 驱动开关；不支持则置灰 + hint；§5.2.12 矩阵仅作方向参考 |
| WorkspaceEdit 非原子 | 跨文件重命名部分失败 | 如实呈现结果清单（§5.2.9），不承诺原子性 |
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
> 定位不变：Code Workspace 仍是「轻量 IDE 面」，与终端/SSH/SFTP/AI 一体化是差异化；本计划把「够用」提升到「Java 主力开发够用」，但不做 Profiler、不做 IDEA 级 facet 建模（见修订后 §2.3）。

### 11.0 现状盘点（As-Is，Java 视角）

| 领域 | 现状 | 载体 |
|------|------|------|
| jdtls 初始化 | 仅下发 `java.configuration.runtimes` + `extendedClientCapabilities.classFileContentsSupport` | `lsp.rs` `lsp_initialization_options`（约 4549 行） |
| 文档同步 | 已支持增量（`buildIncrementalContentChange` + `omitFullText`），但前端每键 `doc.toString()` 出全串、React 持全串、并用两份全串 diff 算增量 | `CodeMirrorHost.tsx:679`、`useWorkspaceLspSession.ts:455` |
| 诊断 | 仅对**已打开文档**推送；Problems 面板只遍历 `openOrder` | `lsp.rs`（per-URI 存储）、`CodeWorkspaceTab.tsx:4669` |
| 库源码 | jdt:// 反编译 + 按需 Download Sources（已实现） | `lsp.rs` `lsp_download_sources`（约 3502 行） |
| Run/Tasks | 已探测 npm/Cargo/Make/Gradle/pom/go 任务，经 PTY 运行，扁平命令列表 | `workspace.rs` `workspace_detect_tasks`（约 115/286 行） |
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
- **未命中**：退用 LSP 3.17 pull 诊断 `workspace/diagnostic`（需 server 声明 `diagnosticProvider.workspaceDiagnostics`）。

**后端**：
- `LspSession.diagnostics` 已按 URI 全量存储（不限打开文档，`lsp.rs:529`）。新增 `lsp_workspace_diagnostics(workspace_id)` 返回**全部已收到诊断**（含未打开文件）。
- 新增 Tauri event（如 `lsp:diagnostics-updated`），在收到 `publishDiagnostics` 时通知前端刷新（现为轮询/按文档拉取）。
- 触发点：项目导入完成、保存、手动「重新构建项目」按钮；防抖合并。

**前端**：Problems 面板加 **「全项目 / 打开的文件」** 切换；未打开文件诊断点击即打开定位；徽标计数含全项目；「重新构建项目」入口（状态栏或面板工具条）。

**交付物**：spike 报告 → 后端全项目诊断命令 + event → Problems 面板切换 + 构建触发入口。

**🔶 已交付基础设施（M7-C，`083999f` 后端 + C-2 前端提交）——spike 无关、优雅降级**：
- **后端 `083999f`**：`lsp_workspace_diagnostics(workspace_id)` 聚合该 workspace 全部 ready session 已收到的诊断（含未打开文件,按 path 去重排序,跳过 `jdt://`/非 file URI）→ `WorkspaceDiagnosticFile{path,uri,diagnostics}`;`lsp_build_workspace(descriptor)` 走 `workspace/executeCommand: java.buildWorkspace(full=true)` 触发「重新构建项目」。诊断本就按 URI 全量存储,故此为纯读聚合——**对 spike 结果不敏感**:命中则「全项目」显示未打开文件诊断,未命中则等同「打开的文件」。
- **⚠ 事件推送改为轮询(架构变更)**：原计划的 `lsp:diagnostics-updated` event push **已放弃**——在 LSP session 的 stdout 后台任务里持有 `AppHandle`/`Emitter` 会确定性触发 Windows 测试二进制启动失败(`STATUS_ENTRYPOINT_NOT_FOUND` 0xC0000139,与 emit 调用无关,移除 AppHandle 字段即恢复)。改为**前端轮询**:Problems 面板处于「全项目」且打开时每 ~1.5s 拉 `lsp_workspace_diagnostics` + 重建后重取。与既有按文件诊断同为 pull 式,无功能损失。
- **前端 C-2**：Problems 面板「全项目 / 打开的文件」切换;「全项目」轮询聚合诊断;点未打开文件诊断即 `problemPathToRef`(复用 `relativePathWithinRoot`)映射回 `{kind:root,rootId,path}` → openFile + reveal;徽标随激活 scope 计数;「Rebuild」按钮(仅全项目)→ `lspBuildWorkspace`。文案沿用 ProblemsPanel 既有硬编码英文约定(不引 i18n)。
- **⬜ 仍待你真机 spike**:验证 jdtls `java.buildWorkspace` 是否对**未打开含错文件**推送 `publishDiagnostics`。`pnpm tauri dev` → Maven/Gradle 工程含 A.java(有错,不打开)/B.java(打开) → 点「Rebuild」→ 看「全项目」是否列出 A.java 的错。**命中**:C 完整可用。**未命中**:补 LSP 3.17 pull 诊断 `workspace/diagnostic` 回退(需 server 声明 `diagnosticProvider.workspaceDiagnostics`)。测试:后端 `file_path_from_uri`;前端 ProblemsPanel scope 切换/rebuild/空态/加载态。`cargo test` 902、`pnpm test` 205 文件 / 1633 全绿。

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

**不做**：IDEA 级 facet 建模、复杂运行配置参数体系（承接 §5.9 边界）。

**✅ 已交付（M7-F，`ba037ac` + `a0d209c` + `f9abab5` + 模块视图提交）**：
- **项目重载（F-3，`ba037ac`）**：`lsp_reload_project` 走 active jdtls session 发 `java/projectConfigurationUpdate`（复用 download_sources 管道）；前端保存 pom.xml/build.gradle[.kts]/settings.gradle[.kts] 且 jdtls 活跃时弹「Reload Java project」确认。
- **任务树（F-2，`a0d209c`）**：`workspace_task_tree` 按 source 分组，Maven 全生命周期（clean…install）、Gradle 常用任务（clean/build/assemble/check/test/jar），其余生态按来源归组——纯离线（不 spawn，`gradle tasks --all` 实时枚举留作后续）；前端 Build 底部 dock 面板渲染可点击树，复用 `runWorkspaceTask`（PTY），原 Run tab 不动。
- **依赖树（F-1，`f9abab5`）**：`workspace_dependency_tree` spawn `mvn dependency:tree` / `gradle dependencies --configuration runtimeClasspath`，解析为 `DependencyNode` 森林并标版本冲突（Maven verbose `(omitted for conflict…)`、Gradle `req -> resolved` 仲裁）；解析器纯函数单测（spawn 为真机项）；前端 Build 面板 Dependencies 区按需加载、懒展开、冲突徽标。**安全**：树装配用索引路径栈，无裸指针（避免 Vec 扩容悬垂）。
- **模块视图（F-4）**：`lsp_java_modules` 走 jdtls `workspace/executeCommand: java.project.getAll` → `JavaModule{name,path,uri}`（解析器去重+按名排序，单测）；前端 Build 面板 Modules 区仅对含 Maven/Gradle 任务的根显示、按需加载（合成 `.java` 路径选中该根的 jdtls session）。
- **边界确认**：均未做 IDEA facet 建模 / 运行配置参数体系。真机门槛：spawn `mvn`/`gradle` 与 jdtls `getAll`/`projectConfigurationUpdate` 的端到端结果由用户真机冒烟回填；本期单测覆盖纯解析 + graceful 错误路径。

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
- **D2 Java 适配器（首个 registry 插入）**：实现 Java `DebugAdapterDescriptor`——jdtls 命令 `java.resolveMainClass`/`java.resolveClasspath`/`java.resolveJavaExecutable` 组装 launch config；经 java-debug bundle 的 `vscode.java.startDebugSession` 拿到 adapter 端口/句柄交给 D1 内核。**语言相关代码集中于此一处。规模 M。**
- **D3 断点 + 单步**：gutter 断点、run/pause/step in·over·out/continue、当前行高亮、调用栈面板——**经 D1 内核的 setBreakpoints/continue/stepIn… 通用请求，不碰适配器**。**规模 M。**
- **D4 变量 / 监视 / 求值**：variables·scopes 树、watch、debug console `evaluate`、悬停求值——同样走 D1 通用请求。**规模 M。**
- **D5 进阶**：条件断点、logpoint、异常断点（DAP `setExceptionBreakpoints`，通用）；热重载为 Java 适配器可选扩展（jdtls `redefineClasses`，经 registry 的适配器能力位声明，非内核必备）。**规模 M。**

**前端**：底部 Debug 面板（调用栈/变量/监视/断点/console）+ 编辑器断点 gutter + 悬浮运行工具条，**均按 DAP 标准模型渲染，与语言无关**；适配器专属能力（如 Java 热重载）按 D1 下发的 capabilities/适配器能力位开关（沿用 §5.2.0 capability 驱动模式）。

### 11.E 测试集成（M8–M9，依赖 Bundle 基建 + 部分 D，规模 L）

- **探测**：java-test 命令 `java.test.findTestTypesAndMethods`（JUnit4/5、TestNG）。
- **运行**：非调试 run 经 launch（不依赖 D）；调试 run 经 D 的 DAP（依赖 D2）。结果 pass/fail/skip/耗时。
- **前端**：测试树面板（按包/类/方法）、gutter run·debug 图标、结果状态、失败堆栈跳转、「重跑失败」。
- **排期**：run-only 可先于 D 交付；debug-test 依赖 D2。

### 11.7 实施顺序与里程碑映射

```
M6 快赢(并行)      : A(jdtls 设置) ‖ B(大文件)                — 2 条独立线，无 M1–M5 之外新前提
M7 工程智能        : C(全项目诊断, 先 spike) ‖ F(构建增强)     — C 依赖 M6-A 的 autobuild
M8 测试/调试基建    : Bundle 基建 → E(测试 run-only) ；D1→D2 起步(可与 M7 并行)
M9 调试主线 + 收口  : D3→D4→D5 ；debug-test(E×D2) ；真机冒烟回填
```

硬依赖：C ← M6-A 的 `autobuild`；D/E ← Bundle 基建；debug-test ← D2。A、B、F 互相独立可并行。每个里程碑独立可发布、可验收。

### 11.8 后端新增 / 扩展命令清单

| 模块 | 命令 / 改动 | 里程碑 |
|------|-------------|--------|
| lsp.rs | `lsp_initialization_options` 扩展 `settings.java` 全集 + bundles 注入 | M6-A / M8 |
| lsp.rs | `lsp_set_java_settings`（热更新经 didChangeConfiguration） | M6-A |
| lsp.rs | `lsp_workspace_diagnostics` + `lsp:diagnostics-updated` event + `java.buildWorkspace` 触发 | M7-C |
| 新 dap.rs | 通用内核：`dap_start_session` / `dap_send_request` / `dap_terminate` + DAP event 转发 + `DebugAdapterRegistry` 抽象（**语言无关**） | M8-D1 |
| dap.rs registry | Java `DebugAdapterDescriptor`：resolveMainClass/Classpath/JavaExecutable + java-debug `startDebugSession`（**唯一语言相关处**） | M8-D2 |
| 新 java_test.rs | `java_test_discover` / `java_test_run`（run-only）；debug 复用 dap | M8/M9-E |
| workspace.rs | `workspace_dependency_tree` / `workspace_task_tree` / `workspace_reload_project` | M7-F |
| 新 java_bundles.rs | bundle 路径解析 / 探测 / 下载 | M8-Bundle |

依赖新增：DAP 用自实现 stdio 客户端（不引第三方 crate）；java-debug / java-test / lombok 为运行期加载的 JVM bundle（jar），非 Rust 依赖。

### 11.9 风险与权衡（M6–M9）

| 风险 | 缓解 |
|------|------|
| 全项目诊断依赖 jdtls 推送语义 | **C 先做 spike**，确认 `buildWorkspace` 是否推送未打开文件；备选 LSP pull 诊断 |
| DAP 工程量失控 | 严格按 D1–D5 分里程碑，每阶段独立可用；**通用内核 + 适配器注册表（§10.7 已定）**——语言相关代码集中于 D2 一处，D3–D5 走标准 DAP，避免 Java 特判蔓延 |
| Bundle 版本 / 下载 | 探测 + 版本校验 + 手动路径回退（同现有 jdtls 模式）；不强制自动下载 |
| Lombok javaagent 路径 | Settings 显式配置 + 探测；缺失时降级提示而非静默报错 |
| 大文件增量与 server 不同步 | ChangeSet 映射 + 全量兜底（已有 catch）+ 版本代际校验（已有 epoch guard） |
| jdtls 内存（默认 1G） | M6-A 把建议 vmargs（如 `-Xmx2G -XX:+UseG1GC`）写入设置提示；大型工程引导上调 |
| 冷启动慢 | 与本计划正交；可另做「导入进度」可视化（承接 jdtls `language/status` 通知） |
| 范围蔓延 | 修订后 §2.3 为新基线：不做 Profiler / IDEA facet 建模 / 远程 jdtls |

