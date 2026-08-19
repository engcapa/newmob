# Debug 底部面板 IDEA 对齐重设计

> 状态：**v1 布局已交付，v2 为 model/wired partial，正确性收口待开发**。最新代码审计基线为 `dab8a778`；该提交新增 typed DebugActionService factory、source-link renderer、workspace-prefixed 部分 ID 与 hidden-pane guard，但 action/token/watch/console/layout 仍未完成真实 production ownership，source link 还有行号与多 root 解析错误。
> 日期：2026-08-19
> 文档结构：§1–§12 保留原始布局方案；§13 是 v1 历史对账；§14–§20 保留历史设计合同；§15.13 是 `dab8a778` 最新 code review；§21 是当前下一轮权威待办。
> 当前范围：v1 只重组 `DebugPanel.tsx` 及子组件；v2 允许按 §15 扩展 `dapDebugModel.ts`、`useCodeDebugSession.ts`、Action Service 和 QA catalog，但不修改 Rust DAP kernel，除非单独任务明确列出协议缺口。

---

## 1. 背景与目标

### 1.1 现状

当前 Debug 面板是 BottomDock 中的一个 tab，内部为**单列纵向滚动**布局，所有内容自上而下堆叠：

```
┌─ BottomDock tab: "Debug" ─────────────────────────────────────────┐
│ [配置下拉 ▾] [▶ Start] [🔌 Attach]        [⏵⏸⏭⏬⏫🔥↺⏹] ← 顶栏  │
│ [会话选择条（多会话时）]                                            │
│ ▸ Breakpoints（行/函数/指令/数据断点 + 内联编辑器）                  │
│ ▾ Exception 信息条（命中异常时）                                     │
│ ▸ Threads（默认折叠）                                               │
│ ▾ Call Stack                                                        │
│ ▾ Variables                                                         │
│ ▾ Watch                                                             │
│ ▸ Memory / Disassembly（默认折叠）                                   │
│ ▾ Console（输出 + REPL 输入）                                        │
│ ▸ Exception Breakpoints                                             │
└────────────────────────────────────────────────────────────────────┘
```

**问题**：

1. **空间效率低** — 底部面板高度受限（默认 192px，最大 640px），所有内容挤在一列，查看变量时看不到调用栈，看调用栈时看不到控制台输出
2. **信息架构混乱** — 断点管理（配置型内容）与运行时状态（线程/帧/变量）混在一起；Console 与调试视图互相挤压
3. **单文件 2692 行** — `DebugPanel.tsx` 承载所有职责，扩展困难
4. **与 IDEA 差距大** — IDEA 的 Debug 工具窗口是多栏布局，信息密度和可用性远高于当前实现

### 1.2 目标

将 Debug 面板重构为 **IntelliJ IDEA 风格的多栏布局**：

- Debug tab 内部分为 **4 个子 tab**：Debugger / Console / Breakpoints / Memory
- Debugger 子 tab 内为**左右双栏**：左栏 Threads & Frames + 调试控制，右栏 Variables & Watches
- 控制按钮按 IDEA 布局：左栏左侧竖排（Resume/Pause/Stop），帧区上方横排（Step 系列）
- 拆分 `DebugPanel.tsx` 为多个独立组件文件

### 1.3 非目标

- 不改动 DAP 数据模型（`DebugSessionState`、`DebugThread`、`DebugStackFrame` 等）
- 不改动 `useCodeDebugSession` hook 的状态管理逻辑
- 不改动 Rust 后端（`src-tauri/src/dap.rs`）
- 不改动 BottomDock 通用组件本身（Debug tab 只是其中一个 tab）

---

## 2. 信息架构

### 2.1 IDEA Debug 工具窗口参考

```
┌─ Debug ───────────────────────────────────────────────────────────┐
│ [Debugger] [Console]                                              │
│ ┌────────┬──────────────────────┬─────────────────────────────┐   │
│ │ ⏵ ⏸ ⏹ │ Frames              │ Variables                    │   │
│ │ ↺ 🔥   │  main:14            │  args = ["foo"]              │   │
│ │        │  run:42             │  count = 3                   │   │
│ │        │  Thread-0           │  ...                         │   │
│ │        ├──────────────────────┤                              │   │
│ │ ⏭ ⏬ ⏫│ (step controls)      │ Watches                      │   │
│ │        │                     │  expr1 = true                │   │
│ └────────┴──────────────────────┴─────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

- 左栏最左：竖排工具条（Resume / Pause / Stop / Restart / Hot Reload）
- 左栏主体：Frames（线程树 + 调用栈合并）
- 左栏底部：横排 Step 按钮（Step Over / Step Into / Step Out）
- 右栏：Variables + Watches（上下分割或 tab 切换）

### 2.2 Taomni 目标架构

```
BottomDock tab: "Debug"
└─ DebugPanel（新）
   ├─ 子 tab 栏: [Debugger] [Console] [Breakpoints] [Memory]
   │
   ├─ Debugger 子 tab（默认）
   │  ├─ 顶部: [配置下拉 ▾] [▶ Start / 🔌 Attach]（仅无会话时显示）
   │  ├─ 左栏（可拖拽调宽，默认 ~40%）
   │  │  ├─ 最左竖排: ⏵ ⏸ ⏹ ↺ 🔥（会话控制）
   │  │  ├─ 会话选择条（多会话时）
   │  │  ├─ Exception 信息条（命中异常时）
   │  │  ├─ Threads & Frames 树（合并）
   │  │  └─ 底部横排: ⏭ ⏬ ⏫（Step Over / Into / Out）
   │  └─ 右栏（默认 ~60%）
   │     ├─ Variables 段
   │     └─ Watches 段（可折叠，带输入框）
   │
   ├─ Console 子 tab
   │  ├─ 输出区（DAP output 事件 + REPL 结果）
   │  └─ REPL 输入框
   │
   ├─ Breakpoints 子 tab
   │  ├─ 工具条: 静音全部 / 删除全部
   │  ├─ Line Breakpoints 列表
   │  ├─ Function Breakpoints 列表
   │  ├─ Instruction Breakpoints 列表
   │  ├─ Data Breakpoints 列表
   │  ├─ Exception Breakpoints 列表
   │  └─ 断点编辑器（选中时内联展开）
   │
   └─ Memory 子 tab
      └─ Memory / Disassembly 视图
```

### 2.3 子 tab 状态持久化

子 tab 选择存入 `codeWorkspaceStore` 的 `CodeWorkspaceInstanceUi`，与 `bottomDockTab` 并列：

```ts
// codeWorkspaceStore.ts 新增
export type DebugSubTabId = "debugger" | "console" | "breakpoints" | "memory";

interface CodeWorkspaceInstanceUi {
  // ...existing...
  bottomDockTab: BottomDockTabId;
  debugSubTab: DebugSubTabId;  // 新增
  // ...
}
```

默认值 `"debugger"`。切换到其他底部 tab 再切回来时保持子 tab 状态。

---

## 3. 组件拆分设计

### 3.1 文件结构

将 `DebugPanel.tsx`（2692 行）拆分为：

```
src/components/editor/workspace/panels/
├── DebugPanel.tsx                    ← 入口，子 tab 路由 + 顶栏（~200 行）
└── debug/
    ├── DebugToolbar.tsx              ← 竖排会话控制 + 横排 Step 控制（~120 行）
    ├── DebugFramesPane.tsx           ← 左栏：会话选择 + 异常信息 + Threads/Frames 树（~250 行）
    ├── DebugVariablesPane.tsx        ← 右栏：Variables + Watches（~300 行）
    ├── DebugConsolePane.tsx          ← Console 子 tab（~150 行）
    ├── DebugBreakpointsPane.tsx      ← Breakpoints 子 tab（~200 行）
    ├── DebugMemoryPane.tsx           ← Memory 子 tab（纯包装，~30 行）
    ├── DebugSubTabBar.tsx            ← 子 tab 栏组件（~80 行）
    ├── VariableRow.tsx               ← 变量/监视行（从 DebugPanel 提取，~180 行）
    ├── BreakpointEditor.tsx          ← 断点编辑器（从 DebugPanel 提取，~120 行）
    ├── BreakpointsView.tsx           ← 各类断点列表（从 DebugPanel 提取，~600 行）
    ├── ExceptionBreakpointsView.tsx  ← 异常断点（从 DebugPanel 提取，~370 行）
    ├── MemoryDisassemblyView.tsx     ← 内存/反汇编（从 DebugPanel 提取，~580 行）
    └── debugPanelShared.ts           ← 共享类型（VarNode、VarEditState）+ 工具函数（~80 行）
```

> 行数为原设计估算。实际提交在提取旧逻辑之外增加了子 tab、布局和测试，因此总代码量发生变化；当前行数见 §13。

### 3.2 组件职责与接口

#### 3.2.1 `DebugPanel.tsx`（入口）

```tsx
export function DebugPanel(props: DebugPanelProps) {
  // 从 store 读取 debugSubTab
  // 渲染 DebugSubTabBar + 对应子面板
  // 业务回调保持兼容；新增 workspaceInstanceId / controlled sub-tab props
}
```

As-built：原业务 props 保持兼容，但新增可选 `workspaceInstanceId`、`activeSubTab`、`onSubTabChange`，`CodeWorkspaceTab.tsx` 需要传 workspace instance id 才能持久化 sub-tab。

#### 3.2.2 `DebugSubTabBar.tsx`

```tsx
interface DebugSubTabBarProps {
  activeTab: DebugSubTabId;
  onTabChange: (tab: DebugSubTabId) => void;
  /** 各 tab 的 badge，如 Console 有新输出时的未读计数 */
  badges?: Partial<Record<DebugSubTabId, number | string>>;
  statusText?: string | null;
  trailing?: ReactNode;
}
```

视觉样式复用 BottomDock 的 tab 按钮样式，但更小一号（`h-6`, `text-[10px]`），与底部 tab 栏形成层级区分。

#### 3.2.3 `DebugToolbar.tsx`

两组按钮，按 IDEA 布局：

```tsx
interface DebugToolbarProps {
  debug: CodeDebugSession;
  /** 是否有活跃会话（非 terminated） */
  running: boolean;
  /** 当前是否停在断点上 */
  stopped: boolean;
}

/** 竖排：Resume/Pause/Stop/Restart/HotReload — 放在左栏最左侧 */
export function DebugSessionControls({ debug, running, stopped }: DebugToolbarProps) { }

/** 横排：StepOver/StepInto/StepOut — 放在帧区上方 */
export function DebugStepControls({ debug, stopped }: Pick<DebugToolbarProps, "debug" | "stopped">) { }
```

按钮图标和颜色沿用现有方案（lucide-react + 语义色），保持视觉一致性。

#### 3.2.4 `DebugFramesPane.tsx`（左栏）

```tsx
interface DebugFramesPaneProps {
  debug: CodeDebugSession;
  onOpenFrame: (frame: DebugStackFrame) => void;
}
```

内容自上而下：
1. **会话选择条**（多会话时）— 从当前 DebugPanel 的 `<select>` 迁移
2. **Exception 信息条** — 从当前 DebugPanel 迁移
3. **Threads & Frames 合并树**：
   - 每个 Thread 是一个可展开节点
   - 展开的 Thread 下显示其 Frames
   - 当前选中帧高亮
   - 右键菜单：Jump to Source / Restart Frame / Drop Frame / Copy Stack
4. **底部 Step 控制条**

Threads & Frames 合并树的交互模型：

```
▼ Thread "main" (stopped: breakpoint)     ← 点击选中线程
    ▶ main(String[])  Main.java:14        ← 点击选中帧
      run()           App.java:42
▶ Thread "worker-1" (running)             ← 折叠的线程
```

#### 3.2.5 `DebugVariablesPane.tsx`（右栏）

```tsx
interface DebugVariablesPaneProps {
  debug: CodeDebugSession;
  /** 当前选中帧 ID（来自 DebugFramesPane 的共享状态） */
  selectedFrameId: number | null;
  stopped: boolean;
}
```

内容自上而下：
1. **Variables 段** — 作用域变量树（现有逻辑提取）
2. **Watches 段** — 监视表达式（现有逻辑提取，带输入框）

Variables 和 Watches 之间用可拖拽分隔条分割，默认 Variables 占 60%。

#### 3.2.6 `DebugConsolePane.tsx`

```tsx
interface DebugConsolePaneProps {
  debug: CodeDebugSession;
  stopped: boolean;
}
```

内容：
1. **输出区** — `state.output` 渲染（现有逻辑提取）
2. **REPL 输入框** — 求值表达式（现有逻辑提取）
3. **工具条** — Clear Console 按钮

#### 3.2.7 `DebugBreakpointsPane.tsx`

```tsx
interface DebugBreakpointsPaneProps {
  debug: CodeDebugSession;
  onOpenBreakpoint?: (path: string, line: number) => void;
  editingBreakpoint?: { path: string; line: number } | null;
  onEditingBreakpointChange?: (target: { path: string; line: number } | null) => void;
}
```

内容：
1. **工具条** — Mute All / Remove All
2. **Line Breakpoints** — 现有 `BreakpointsView` 的行断点部分
3. **Function Breakpoints** — 现有 `FunctionBreakpointsView`
4. **Instruction Breakpoints** — 现有 `InstructionBreakpointsView`
5. **Data Breakpoints** — 现有 `DataBreakpointsView`
6. **Exception Breakpoints** — 现有 `ExceptionBreakpointsView`
7. **断点编辑器** — 选中时内联展开（现有 `BreakpointEditor`）

各断点类型用可折叠 Section 分隔，但默认全部展开（与当前不同，因为现在有独立子 tab，空间充足）。

#### 3.2.8 `DebugMemoryPane.tsx`

```tsx
interface DebugMemoryPaneProps {
  debug: CodeDebugSession;
}
```

纯包装组件，渲染现有 `MemoryDisassemblyView`。

### 3.3 共享状态

Variables/Watch 的数据获取逻辑（`fetchScopes` → `fetchVariables` → 构建 `VarNode` 树）目前耦合在 `DebugPanel` 内部。拆分后，这些逻辑提升到 `DebugPanel` 入口组件，通过 props 传递给 `DebugVariablesPane`：

```tsx
// DebugPanel.tsx 内部
const { variables, watchNodes, expandVariable, expandWatch, ... } = useDebugVariables(debug, selectedFrameId, stopped);

// 传递给 DebugVariablesPane
<DebugVariablesPane
  variables={variables}
  watchNodes={watchNodes}
  onExpandVariable={expandVariable}
  // ...
/>
```

或者提取为自定义 hook `useDebugVariables`，放在 `debug/` 目录下：

```ts
// debug/useDebugVariables.ts
export function useDebugVariables(
  debug: CodeDebugSession,
  selectedFrameId: number | null,
  stopped: boolean,
) {
  const [variables, setVariables] = useState<VarNode[]>([]);
  const [watchNodes, setWatchNodes] = useState<VarNode[]>([]);
  const [edit, setEdit] = useState<VarEditState>({ node: null, value: "" });
  // ... fetchScopes / fetchVariables / expand / edit / watch logic ...
  return { variables, watchNodes, edit, expandVariable, expandWatch, startEdit, submitEdit, cancelEdit, addWatch, removeWatch };
}
```

这样 `DebugPanel` 保持薄，`DebugVariablesPane` 只负责渲染。

---

## 4. 布局与视觉规范

### 4.1 整体尺寸

```
BottomDock（不变）
└─ DebugPanel
   ├─ 子 tab 栏: h-6 (24px)
   └─ 子 tab 内容: 剩余高度，min-h-0
      └─ Debugger 子 tab
         ├─ 顶栏（无会话时）: h-8 (32px)
         └─ 双栏区: flex-1, min-h-0
            ├─ 左栏: 默认 40%, min 200px, max 60%
            └─ 右栏: flex-1
```

左栏宽度用 `react-resizable-panels`（项目已有依赖）实现拖拽调整，持久化到 localStorage（key: `taomni.codeWorkspace.debugLeftPaneWidth.v1`）。

### 4.2 双栏分隔

使用项目已有的 `react-resizable-panels`：

```tsx
<PanelGroup direction="horizontal">
  <Panel defaultSize={40} minSize={20} maxSize={60}>
    <DebugFramesPane ... />
  </Panel>
  <PanelResizeHandle className="w-1 bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)]" />
  <Panel>
    <DebugVariablesPane ... />
  </Panel>
</PanelGroup>
```

### 4.3 左栏内部布局

```
┌─────────────────────────────┐
│ [⏵]  Session: [main ▾]     │  ← 竖排控制 + 会话选择
│ [⏸]                         │
│ [⏹]  ────────────────────── │
│ [↺]  ⚠ NullPointerException │  ← 异常信息（条件显示）
│ [🔥]                         │
│      ────────────────────── │
│      ▼ Thread "main"        │  ← Threads & Frames 树
│        main:14  Main.java   │
│        run:42   App.java    │
│      ▶ Thread "worker-1"    │
│      ────────────────────── │
│      [⏭] [⏬] [⏫]          │  ← Step 控制
└─────────────────────────────┘
```

竖排控制条宽度 `w-8`（32px），与帧区之间用 `border-r` 分隔。

### 4.4 右栏内部布局

```
┌─────────────────────────────────┐
│ Variables                  [▼]  │  ← 段标题 + 折叠
│  args: String[1] = ["foo"]      │
│  count: int = 3                 │
│  this: Main = Main@739          │
│    ▶ field1: int = 42           │
│─────────────────────────────────│  ← 可拖拽分隔
│ Watches                    [▼]  │
│  [+ Add expression___________]  │
│  expr1: boolean = true          │
│  list.size(): int = 5           │
└─────────────────────────────────┘
```

Variables 和 Watches 之间用可拖拽分隔条（`react-resizable-panels` 垂直方向），默认 Variables 60% / Watches 40%。

### 4.5 颜色与主题

沿用现有 CSS 变量，不引入新颜色：

| 用途 | 变量 |
|------|------|
| 边框 | `--taomni-code-border` |
| 背景 | `--taomni-code-bg`, `--taomni-code-gutter-bg` |
| 文本 | `--taomni-code-text`, `--taomni-code-muted` |
| 悬停 | `--taomni-hover-bg` |
| 选中 | `--taomni-code-selection-match-bg` |
| 强调 | `--taomni-accent` |
| 异常 | `rose-500` 系列（现有） |
| 断点条件 | `amber-500`（现有） |

### 4.6 空状态

| 场景 | 文案 |
|------|------|
| 无会话（Debugger tab） | "No debug session. Select a configuration and press ▶ to start." |
| 无会话（Console tab） | "Console output will appear here when a debug session is running." |
| 无断点（Breakpoints tab） | "No breakpoints. Click a line's gutter to add one." |
| 运行中（Frames 区） | "Running…" （现有行为保留） |
| 浏览器预览 | "Debugging is available in the desktop app only." （现有行为保留） |

---

## 5. 交互细节

### 5.1 子 tab 切换

- 点击子 tab 切换内容，**所有子 tab 内容保持挂载**（与 BottomDock 行为一致，用 `hidden` 隐藏非活跃 tab），避免 Console 输出丢失
- 子 tab 栏样式与 BottomDock tab 栏一致但更小，形成视觉层级

### 5.2 Threads & Frames 树

**合并模型**（与 IDEA 一致）：

- 每个 Thread 是树的根节点，显示线程名和状态图标（⏸ stopped / ▶ running）
- 展开的 Thread 下显示该线程的 Frames
- 当前选中帧高亮（`bg-[var(--taomni-code-selection-match-bg)]`）
- 点击帧：选中 + 触发 `onOpenFrame`（跳转源码）
- 右键帧：Jump to Source / Restart Frame / Drop Frame / Copy Stack（现有 context menu 逻辑迁移）
- 单线程时自动展开，多线程时只展开 stopped 线程

**数据流**：

```
useCodeDebugSession
  → state.threads: DebugThread[]
  → state.frames: DebugStackFrame[]  （当前选中线程的帧）
  → state.selectedThreadId / selectedFrameId
  → debug.selectThread(id) / selectFrame(id)
```

当前实现中 `state.frames` 只包含选中线程的帧。合并树需要支持**每个线程独立展开/折叠**，但帧数据只在选中线程时加载。因此：

- 默认只展开 `selectedThreadId` 的线程（显示其帧）
- 点击其他线程时调用 `debug.selectThread(threadId)`，帧数据自动刷新
- 非选中线程显示为折叠状态（不加载帧）

这与当前行为一致，只是 UI 上从"两个独立列表"变为"一个树"。

### 5.3 变量编辑

- 双击变量值进入编辑（现有逻辑保留）
- `Enter` 提交，`Escape` 取消
- 编辑框样式沿用现有 `VarEditState` 逻辑

### 5.4 Watch 表达式

- 输入框在 Watches 段顶部（现有位置保留）
- `Enter` 添加
- 每个 Watch 项悬停显示删除按钮（现有逻辑保留）
- Watch 表达式持久化到 localStorage（现有 `readWatches` 逻辑不变）

### 5.5 Console REPL

- 输入框在输出区底部（现有位置保留）
- `Enter` 求值，结果显示在输出区
- 仅在 `stopped` 状态可用（现有行为保留）
- Clear 按钮在输出区右上角

### 5.6 断点编辑

- 点击断点行的 "Edit" 按钮展开内联编辑器（现有逻辑保留）
- 编辑器内容：Enabled / Condition / Hit Condition / Log Message / Breakpoint Mode
- 编辑器的展开/折叠状态由 `editingBreakpoint` prop 控制（现有逻辑不变）

---

## 6. 键盘快捷键

沿用现有快捷键，不新增：

| 快捷键 | 功能 | 实现位置 |
|--------|------|----------|
| Ctrl+F8 | 切换断点 | 编辑器 gutter |
| Ctrl+Shift+F8 | 编辑断点 | 编辑器 gutter → `editingBreakpoint` |

**建议新增**（可选，Phase 2）：

| 快捷键 | 功能 |
|--------|------|
| F8 | Step Over |
| F7 | Step Into |
| Shift+F8 | Step Out |
| F9 | Continue |
| Ctrl+F5 | Restart |
| Ctrl+F2 | Stop |

这些快捷键需要在 `CodeWorkspaceTab` 的键盘处理中注册，当 Debug tab 激活时生效。

---

## 7. 测试策略

### 7.1 现有测试兼容

- `useCodeDebugSession.test.tsx` — 不涉及 UI，无需修改
- `qa-ui-auto-tests/cases/` 中的 UI 测试用例需要更新：
  - `data-testid` 保持不变（`debug-start`, `debug-continue`, `debug-step-over` 等）
  - 新增 `data-testid`：`debug-subtab-debugger`, `debug-subtab-console`, `debug-subtab-breakpoints`, `debug-subtab-memory`
  - 帧/线程的 `data-testid` 保持不变（`debug-frame-{id}`, `debug-thread-{id}`）

### 7.2 新增测试

- `DebugPanel.test.tsx` — 子 tab 切换、空状态渲染
- `DebugFramesPane.test.tsx` — Threads & Frames 树渲染、选中逻辑
- `DebugVariablesPane.test.tsx` — Variables/Watches 渲染、编辑交互

---

## 8. 迁移计划

### Phase 1：组件拆分（不改变 UI）— 已交付

1. 将 `DebugPanel.tsx` 中的内部组件提取到 `debug/` 目录
2. 提取共享类型到 `debugPanelShared.ts`
3. 提取变量逻辑到 `useDebugVariables.ts`
4. 确认所有现有测试通过

**产出**：代码结构改善，UI 不变。

### Phase 2：子 tab 框架 — 已交付

1. 新增 `DebugSubTabBar` 组件
2. 新增 `debugSubTab` 到 `codeWorkspaceStore`
3. `DebugPanel` 入口改为子 tab 路由
4. 将现有内容映射到对应子 tab：
   - Debugger → 现有全部内容（暂时保持单列）
   - Console → 提取 Console 段
   - Breakpoints → 提取 Breakpoints 段
   - Memory → 提取 Memory/Disassembly 段

**产出**：子 tab 框架就位，Debugger 暂时保持旧布局。

### Phase 3：双栏布局 — 已交付

1. `DebugFramesPane` — Threads & Frames 合并树
2. `DebugVariablesPane` — Variables + Watches
3. `DebugToolbar` — 竖排 + 横排控制
4. `DebugPanel` 的 Debugger 子 tab 改为双栏布局

**产出**：完整 IDEA 风格布局。

### Phase 4（原可选项）：快捷键 + 打磨 — 部分交付

1. 注册调试快捷键
2. 左栏宽度持久化
3. Console 未读 badge
4. 动画过渡

当前状态：左右与上下分隔比例已经持久化；Console badge 目前显示的是当前 session 的**总输出行数**，不是未读数；F7/F8/F9/Stop/Restart 等统一 action/keymap 尚未接入；动画未实现。后续不再按本 Phase 继续零散补丁，统一执行 §14–§15。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 子 tab 切换导致状态丢失 | 高 | 所有子 tab 内容保持挂载（`hidden` 隐藏），与 BottomDock 行为一致 |
| Threads & Frames 合并树改变现有交互 | 中 | 保持 `selectThread` / `selectFrame` 调用不变，只是 UI 合并 |
| `data-testid` 变更破坏现有测试 | 中 | 所有现有 `data-testid` 保持不变 |
| 双栏在小高度下拥挤 | 低 | 左栏设 `min-w-[200px]`，不足时自动折叠为单栏（media query 或 ResizeObserver） |
| 变量获取逻辑提取引入 bug | 中 | Phase 1 先纯提取不改逻辑，确保测试通过后再改 UI |

---

## 10. 原型示意

### 10.1 Debugger 子 tab（有会话，停在断点）

```
┌─ Debug ─────────────────────────────────────────────────────────────┐
│ [Debugger] [Console] [Breakpoints] [Memory]                         │
│ ┌────┬───────────────────────────┬──────────────────────────────┐   │
│ │ ⏵  │ Session: [Main ▾]         │ Variables               [▼] │   │
│ │ ⏸  │ ─────────────────────────  │  ▼ Locals                   │   │
│ │ ⏹  │ ⚠ Stopped at breakpoint    │    args: String[1]          │   │
│ │ ↺  │                            │      [0]: "foo"             │   │
│ │ 🔥 │ ▼ Thread "main" ⏸          │    count: int = 3           │   │
│ │    │   ▶ main(String[]) Main:14 │    this: Main@739           │   │
│ │    │     run() App:42           │ ────────────────────────────│   │
│ │    │   ▶ start() Thread:834     │ Watches                 [▼] │   │
│ │    │                            │  [+ Add expression______]   │   │
│ │    │ ▶ Thread "worker-1" ▶     │  args.length > 0 = true     │   │
│ │    │                            │  count * 2 = 6              │   │
│ │    │ ─────────────────────────  │                              │   │
│ │    │ [⏭ Step] [⏬ Into] [⏫ Out]│                              │   │
│ └────┴───────────────────────────┴──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.2 Console 子 tab

```
┌─ Debug ─────────────────────────────────────────────────────────────┐
│ [Debugger] [Console] [Breakpoints] [Memory]                         │
│ ┌────────────────────────────────────────────────────────────────┐  │
│ │ Connected to the target VM, address: 'localhost:5005'          │  │
│ │ args.length = 1                                                │  │
│ │ count = 3                                                      │  │
│ │ > args.length + count                                          │  │
│ │ = 4                                                            │  │
│ │                                                                │  │
│ │                                              [🧹 Clear]        │  │
│ ├────────────────────────────────────────────────────────────────┤  │
│ │ [Evaluate expression___________________________________] [⏎]   │  │
│ └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.3 Breakpoints 子 tab

```
┌─ Debug ─────────────────────────────────────────────────────────────┐
│ [Debugger] [Console] [Breakpoints] [Memory]                         │
│ ┌────────────────────────────────────────────────────────────────┐  │
│ │ [🔇 Mute All]  [🗑 Remove All]                                 │  │
│ │ ────────────────────────────────────────────────────────────── │  │
│ │ ▾ Line Breakpoints (3)                                         │  │
│ │   ☑ Main.java:14        if count > 2              [Edit] [🗑] │  │
│ │   ☑ App.java:42                                   [Edit] [🗑] │  │
│ │   ☐ Utils.java:7        (disabled)                [Edit] [🗑] │  │
│ │ ▾ Function Breakpoints (1)                                     │  │
│ │   ☑ com.example.Main#main                         [Edit] [🗑] │  │
│ │ ▸ Instruction Breakpoints (0)                                  │  │
│ │ ▸ Data Breakpoints (0)                                         │  │
│ │ ▸ Exception Breakpoints (2)                                    │  │
│ └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 10.4 Memory 子 tab

```
┌─ Debug ─────────────────────────────────────────────────────────────┐
│ [Debugger] [Console] [Breakpoints] [Memory]                         │
│ ┌────────────────────────────────────────────────────────────────┐  │
│ │ Memory Address: [0x7fff5fbff8a0____________] [Read]            │  │
│ │ ────────────────────────────────────────────────────────────── │  │
│ │ 0x7fff5fbff8a0: 48 89 e5 48 83 ec 20  48 8d 3d a1 0e 00 00   │  │
│ │ 0x7fff5fbff8b0: e8 4b ff ff ff 48 89  45 f8 48 8b 45 f8      │  │
│ │ ────────────────────────────────────────────────────────────── │  │
│ │ Disassembly                                                    │  │
│ │   0x7fff5fbff8a0: push rbp                                     │  │
│ │   0x7fff5fbff8a1: mov  rbp, rsp                                │  │
│ │   0x7fff5fbff8a4: sub  rsp, 0x20                               │  │
│ └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 布局方案 | 完整 IDEA 对齐（子 tab + 双栏） | 用户确认 |
| 左栏内容 | Threads + Frames + Sessions；Breakpoints 不重复渲染 | v1 as-built，避免同一断点状态出现双入口 |
| 子 tab 划分 | Debugger / Console / Breakpoints / Memory | 用户确认全选 |
| 控制按钮位置 | IDEA 风格（竖排会话控制 + 横排 Step） | 用户确认 |
| 断点位置 | 独立 Breakpoints 子 tab | 集中管理；gutter/Ctrl+Shift+F8 可直接路由到该 tab |
| 面板拖拽 | `react-resizable-panels` | 项目已有依赖，BottomDock 已用类似模式 |
| 子 tab 状态持久化 | `codeWorkspaceStore` | 与 `bottomDockTab` 一致 |

---

## 12. 附录：现有代码提取对照表

| 现有位置（DebugPanel.tsx 行号） | 提取目标 |
|------|------|
| `VariableRow` (149-268) | `debug/VariableRow.tsx` |
| `BreakpointsView` (269-393) | `debug/BreakpointsView.tsx`（Line BP 部分） |
| `FunctionBreakpointsView` (396-556) | `debug/BreakpointsView.tsx` |
| `InstructionBreakpointsView` (557-1102) | `debug/BreakpointsView.tsx` |
| `DataBreakpointsView` (1103-1415) | `debug/BreakpointsView.tsx` |
| `ExceptionBreakpointsView` (1416-1782) | `debug/ExceptionBreakpointsView.tsx` |
| `MemoryDisassemblyView` (841-1415) | `debug/MemoryDisassemblyView.tsx` |
| `BreakpointEditor` (1783-1904) | `debug/BreakpointEditor.tsx` |
| `DebugPanel` 主体 (1905-2619) | 拆分为入口 + 各子面板 |
| `Section` / `SectionAction` / `Empty` (2620-2692) | `debug/debugPanelShared.ts` 或保留在入口 |

---

## 13. v1 As-Built 对账（历史基线，2026-08-17）

> 本节记录 v1 布局首次落地时的事实；历史增量保留在 §15.8–§18，当前状态以 §15.11/§19 为准。

### 13.1 已进入生产路径

| 原设计项 | 代码证据 | 结论 |
|----------|----------|------|
| 4 个子 tab | `DebugSubTabBar.tsx` + `DebugSubTabId`/`debugSubTab` store | 已交付；Breakpoint editor 请求会自动切到 Breakpoints |
| Debugger 双栏 | `DebugPanel.tsx` 横向 `PanelGroup`，默认 45/55 | 已交付；左右 min 15%，左 max 85% |
| Variables/Watches 上下分隔 | `DebugVariablesPane.tsx` 纵向 `PanelGroup`，默认 60/40 | 已交付 |
| 布局持久化 | `readDebugSplitLayout`/`writeDebugSplitLayout` | 已交付，但 key 为应用全局，不区分 workspace，且无 Reset Layout/schema migration |
| Threads/Frames 合并树 | `DebugFramesPane.tsx` | 已交付选中线程工作流；非选中线程没有 frame cache，只能点击切换后查看 |
| 会话/Step 控制分区 | `DebugToolbar.tsx` | 已交付 UI；Restart Frame/Data/Memory 等多数 optional action 已 capability-gated |
| Console 独立页 | `DebugConsolePane.tsx` | 已交付 output、clear、REPL 与显示后滚底；无 history/follow-tail/stale evaluate 保护 |
| Breakpoints/Memory 独立页 | `DebugBreakpointsPane.tsx`/`DebugMemoryPane.tsx` | 已交付；Memory 内部按 adapter capability 显示 unsupported |
| 组件拆分 | `DebugPanel.tsx` 328 行，`debug/` 下 14 个非测试实现文件 | 入口已明显变薄；`BreakpointsView.tsx` 仍为 887 行，后续按行为而非行数决定是否继续拆 |
| 自动化 | `DebugPanel.test.tsx`、Frames/SubTab/Variables tests | 组件测试已增加；`qa-ui-auto-tests` 尚未检索到新 subtab/pane testid 的功能 catalog/YAML 覆盖 |

### 13.2 与原设计或 IDEA 体验仍不一致

1. Console badge 使用 `state.output.length`，是总行数而非离开 Console 后新增的未读数；清空、切 session、重新进入的语义也未定义。
2. Console 每次输出都强制 `scrollTop = scrollHeight`，用户向上阅读时仍会被拉回底部；REPL 没有 Up/Down history、busy/cancel、session generation 或错误分类。
3. 空状态和 Start tooltip 仍写死 Java/java-debug；仓库已经有多语言 DAP 配置，不应把通用面板描述成 Java-only。Attach 也只暴露 Remote JVM 的专用入口。
4. Hot Reload 按钮对所有 active session 可见，实际直接发送 java-debug 私有 `redefineClasses`；非 Java adapter 只能点击后报错，不符合 capability-driven affordance。
5. 原风险表承诺“空间不足自动折叠为单栏”，代码没有 ResizeObserver/窄宽布局；15% panel 在窄 dock 中会压缩标签和数据。
6. tab bar 没有 `tablist/tab/tabpanel` 与 `aria-selected/aria-controls` 关系；分隔器没有产品级可见 label、Reset Layout 和明确键盘验收。
7. 布局比例 key 是应用全局 localStorage；不同 workspace、不同窗口和不同 dock 宽度会共享同一比例。
8. Frames 只保存当前线程的 `state.frames`，展开其他线程显示“Click to inspect frames”；无法并排观察多线程栈，也没有分页/总帧数、冻结/恢复时的 cache epoch。
9. Variables/Watches 缺 filter、sort、变化高亮、watch reorder/enable、按 scope 分组的稳定展开恢复；evaluate/expand 的旧响应必须继续审计 session/frame generation。
10. IDEA 风格 F7/F8/F9、Force Step Into、Smart Step Into、Show Execution Point、Run to Cursor、Step Back 等 action 没有统一 keymap/capability 状态；现有 workspace action 只覆盖断点相关入口。
11. 所有 UI 文案为硬编码英文，没有进入现有 i18n；屏幕阅读、200% zoom、非美式键盘和 Linux/macOS/Windows 打包应用证据缺失。
12. `DebugPanel` 4 个隐藏 pane 常驻挂载能保留局部状态，但 Memory/Breakpoints 等隐藏 pane 未来新增 effect 时必须显式接收 `visible`，不能在后台轮询或请求。

## 14. v2 当前权威待办（历史 D0-D5 分解）

> D0-D5 的原始设计仍保留供追溯；最新可执行顺序和代码状态见 §15.11、§19（D6-D10）。

| 顺序 | 工作包 | 目标 | 依赖 |
|------|--------|------|------|
| 1 | D0 文档/QA/能力真值 | 修正多语言文案，登记新控件；所有 action 有 supported/available/reason | Code Workspace §8.5.2 Action Service |
| 2 | D1 Console correctness | 真未读、follow-tail、REPL history/generation/error、per-session 状态 | debug output sequence/model |
| 3 | D2 Threads/Frames/Variables data views | per-thread lazy stack cache、分页、变量变化与 filter、watch 管理 | `useCodeDebugSession` 状态扩展 |
| 4 | D3 Debug action 与 IDEA stepping | 统一 F7/F8/F9/Stop/Restart/Run to Cursor/Show Point；高级动作 capability-gated | D0 + DAP capabilities |
| 5 | D4 Responsive/Layout/A11y/i18n | 窄宽布局、per-workspace layout、Reset、ARIA/keyboard、翻译 | D0，可与 D1/D2 并行 |
| 6 | D5 Adapter/三端/性能门禁 | Java/JS/Python/Go/Rust/C++ 真实 trace、三端、长输出/多线程压力 | D1–D4 |

完成标准：

- [ ] 面板不再包含 Java-only 通用文案；Java Hot Reload/Remote JVM 等动作明确显示 adapter 来源。
- [ ] Console badge 只统计上次看见序号之后的新输出；用户离开底部时不被强制滚动。
- [ ] 多线程停止时可展开至少两个线程的 frame snapshot，切 session/continue 后旧响应不会回填。
- [ ] F7/F8/F9 与工具条来自同一 action state，unsupported 动作不出现或带明确 reason。
- [ ] 宽度不足时切成可操作的 Frames/Variables 单栏模式，文本、按钮和 resize handle 不重叠。
- [ ] tab/tabpanel/resizer/toolbar 可仅键盘操作，200% zoom 与读屏名称通过组件/浏览器检查。
- [ ] `feature-list.md`、testid catalog、YAML case 与组件测试同步；真实 adapter 和三端证据不由 mock 替代。

## 15. v2 实现级详细设计

### 15.1 D0：能力真值与多语言入口

把按钮可用性从 `activeRunning/stopped` boolean 提升为 action descriptor，和 Code Workspace §8.5.2 共用 action service：

```ts
type DebugActionId =
  | "debug.resume" | "debug.pause" | "debug.stop" | "debug.restart"
  | "debug.stepOver" | "debug.stepInto" | "debug.forceStepInto"
  | "debug.smartStepInto" | "debug.stepOut" | "debug.stepBack"
  | "debug.runToCursor" | "debug.showExecutionPoint" | "debug.hotReload";

interface DebugActionState {
  id: DebugActionId;
  supported: boolean;
  available: boolean;
  source: "dap" | "adapter-extension" | "local-navigation";
  disabledReason?: "no-session" | "running" | "not-stopped" | "capability" | "busy";
}
```

标准 action 从 DAP initialize capability 和 session status 计算；Hot Reload 必须由 adapter descriptor 明确声明 `java.redefineClasses` extension，不能只因有 session 就 enabled。Remote JVM Attach 作为 configuration type，而不是通用 toolbar 的固定 Java 按钮；Start/Attach tooltip 使用 active configuration 的 label/type/diagnostic。

`DebugPanel` 空状态改为配置驱动：“No debug session. Select a configuration and start debugging.”；desktop unavailable 显示 runtime 事实，不提具体语言。所有字符串进入 `src/lib/i18n/locales/en.ts`/`zh-CN.ts`。`DebugSubTabBar` badge、title 和 toolbar action 均消费 descriptor，不再各自推断。

**文件边界。** D0 负责 `DebugPanel.tsx`、`DebugToolbar.tsx`、`DebugSubTabBar.tsx`、Action Service adapter、i18n 和 QA catalog；不在本包改 frames/variables 请求结构。

**验收。** Java/Node/Python/LLDB synthetic descriptor 分别覆盖 hot reload/step back/terminate/restart 能力；no session/running/stopped/terminated 状态；多 workspace action ownership；工具条、快捷键、Search Everywhere 的 enabled/reason 完全一致。

### 15.2 D1：Console 状态、未读与 REPL

给 output 增加 session 内单调序号和时间，不使用 array index 作为 identity：

```ts
interface DebugConsoleEntry {
  seq: number;
  sessionId: string;
  category: "stdout" | "stderr" | "console" | "important" | "telemetry" | "repl" | "result" | "unknown";
  rawCategory?: string;
  text: string;
  timestamp: number;
}

interface DebugConsoleUiState {
  lastSeenSeqBySession: Record<string, number>;
  followTailBySession: Record<string, boolean>;
  replHistoryBySession: Record<string, string[]>;
  historyIndexBySession: Record<string, number | null>;
}
```

未读数为当前/所有 session 中 `seq > lastSeenSeq` 的数量，Console 可见且滚动在距底部 24px 内时推进 seen；仅切 tab 不盲目清零。Clear 只清显示 buffer，并把 seen 更新到当前 seq；session terminate 后保留本次输出直到新 launch/用户 clear。badge 上限 `99+`，title 说明来自哪个 session。

Auto-scroll 只有 `followTail=true` 才执行；用户向上滚超过阈值自动关，显示“Scroll to end / Resume follow”图标按钮。输出用虚拟化或有界 ring buffer（建议每 session 10,000 entries / 2 MiB，截断时插入明确 marker），避免长日志创建无限 DOM。

REPL history 只在内存中保存每 session 最近 100 条，连续重复去重，Up/Down 浏览，Esc 恢复草稿；默认不写 localStorage，避免表达式含凭据。evaluate 请求绑定 `(sessionId, frameId, stopEpoch, requestId)`；切 session、continue、frame change 或 terminate 后旧结果标 cancelled/stale，不写入新 Console。错误单独输出 `stderr`，输入 busy 时允许 cancel 或排队策略必须二选一并测试。

**验收。** hidden/visible、读历史日志、切 session、clear、terminate/restart、10k output、ANSI/多行、evaluate error/stale/cancel、history draft、跟随尾部；组件测试使用真实滚动尺寸 mock，QA case 验证 badge 和 follow-tail。

### 15.3 D2：多线程栈与变量数据视图

将单一 `frames` 演进为 stop epoch 内的 per-thread cache：

```ts
interface ThreadStackState {
  status: "idle" | "loading" | "ready" | "partial" | "failed";
  frames: DebugStackFrame[];
  totalFrames?: number;
  nextStartFrame: number;
  requestId?: string;
  error?: string;
}

interface DebugStopSnapshot {
  sessionId: string;
  stopEpoch: number;
  stoppedThreadId: number | null;
  stacksByThreadId: Record<number, ThreadStackState>;
}
```

展开线程时发 `stackTrace(threadId,startFrame,levels)`，首批 50 帧，Load More 继续；请求只在 session/stopEpoch/thread/requestId 全匹配时发布。continue/step 清空 snapshot，重新 stop 建新 epoch；切选中线程不删除其它已加载 stack。adapter 没有 totalFrames 时以返回不足 page size 判断结束。Copy Call Stack 复制目标线程的完整已加载栈，并注明 partial。

Variables 按 `sessionId/stopEpoch/frameId/scope/variablesReference` 缓存，scope 保持分组，不把不同 scope 同名变量扁平混合。相邻 stop epoch 对同一 stable path 的值做浅层 diff，高亮 changed/new/removed；对象 identity 不可靠时只比较已展开节点并标 local comparison。增加当前树 filter、name/value/type sort（默认 adapter order）、Refresh、Copy path；filter 不触发额外 DAP 请求。

Watches 使用稳定 ID 而非 array index，支持 enable/disable、drag reorder、edit expression、逐条 error、frame/session 重新求值；持久化仍按 workspace，但不得保存本次 value。所有 evaluate/variables/setVariable/dataBreakpoint 请求带 epoch guard；set 成功后只刷新受影响 container 和 watches。

**验收。** 20 threads、两个同时展开、分页、快速 continue/re-stop、session switch、旧响应、stack failure partial、递归变量、重复变量名、值变化、watch reorder/error/disable、frame change、compound debug。保持现有 `debug-thread-*`/`debug-frame-*` testid，新增 Load More/filter/watch handle 控件并更新 catalog。

### 15.4 D3：IDEA stepping 与执行点工作流

基础 keymap 通过 D0 action service 注册：F8 Step Over、F7 Step Into、Shift+F8 Step Out、F9 Resume、Ctrl+F2 Stop、Ctrl+F5 Restart；macOS/系统冲突由可编辑 keymap 解析，不在 DebugPanel 写 `window.keydown`。

新增动作按能力分阶段：

1. **Show Execution Point**：本地 navigation action，跳到当前 stopped session 的 selected/current top frame；source unavailable 时给 disabled reason。
2. **Run to Cursor**：复用现有 editor gutter/debug session 方法，作为 editor context action；发送 temporary breakpoint/goto 的具体实现仍遵守 adapter contract。
3. **Force Step Into**：若 adapter descriptor 能映射标准/扩展 request 才显示；不能把普通 stepIn 换标题。
4. **Smart Step Into**：先请求 `stepInTargets(frameId)`，多目标时显示 quick pick，再用 `stepIn { targetId }`；没有 `supportsStepInTargetsRequest` 则 unavailable。
5. **Step Back/Reverse Continue**：DAP 用同一个 `supportsStepBack` capability 声明两者；若某 adapter 实际只实现其一，由 adapter descriptor 进一步收窄，不能假设存在非标准 `supportsReverseContinue` 字段。
6. **Restart Frame/Force Return**：Restart Frame 已有；Force Return 需要 adapter extension descriptor 和单独确认，不从 evaluate 拼接实现。

每个 action 执行时锁定 requestId，避免双击发送两次 step；收到 continued/stopped/terminated 或 request failure 后释放。失败写 Console 并恢复可点击状态，不让 toolbar 永久 busy。compound session 的 action 默认只作用 active child；group stop/restart 保留现有 group 语义，并在 tooltip 明确作用域。

**验收。** action state matrix、双击防重、request failure、compound active child、sourceReference、stepInTargets 0/1/N、capability missing、keymap remap、toolbar/Search/keyboard 三入口一致。真实 Java/JS/Python/Delve/LLDB 至少记录适用动作 trace。

### 15.5 D4：响应式布局、持久化、可访问性与 i18n

布局 preference 改为 workspace instance scoped schema：

```ts
interface DebugLayoutPreferenceV2 {
  schemaVersion: 2;
  horizontal: { frames: number; variables: number };
  vertical: { variables: number; watches: number };
  compactPane: "frames" | "variables";
}
```

从现有两个 global localStorage key 一次性迁移为 default，然后写入 workspace UI preference；非法/极端比例回到默认。提供 Reset Debug Layout action。ResizeObserver 观察内容区宽度：宽度 >= 640px 使用双栏；更窄时竖排 toolbar 保留，主体用 `Frames | Variables` segmented tabs 单栏切换，不能把两个 panel 各压到 15%。切 compact/full 保持 scroll、selection 和 split preference。

`DebugSubTabBar` 使用 `role=tablist`，button 使用 `role=tab`、`aria-selected`、`aria-controls`、roving tabindex，pane 使用 `role=tabpanel`；ArrowLeft/Right/Home/End 切 tab。toolbar 使用 `role=toolbar` 和可见 focus ring；separator 设置方向、label、value/min/max，并验证 Arrow 调整。icon-only action 有 tooltip/aria-label，状态变化用克制的 live region，不逐行朗读 Console。

所有文案、title、empty/error、status 进入 i18n；长翻译在 320/480/640/1024px 与 100%/200% zoom 不溢出。动画只在 `prefers-reduced-motion` 允许时使用，不作为本轮完成前提。

### 15.6 D5：测试、性能与真实 adapter 门禁

自动化分层：

- pure tests：unread/seen、ring buffer、epoch reducer、per-thread paging、action matrix、layout migration。
- component tests：tab ARIA/keyboard、follow-tail、REPL history、two-thread expand、watch reorder、compact/full 切换、Reset Layout。
- `qa-ui-auto`：更新 F25.1 feature/control/testid catalog，增加 Debugger/Console/Breakpoints/Memory 子 tab、resize、compact、unread、step action 的 browser case；desktop-only action在 browser 必须断言明确 unavailable。
- fake DAP integration：initialize -> launch -> threads -> 两线程 stackTrace -> scopes/variables -> evaluate -> continue/stale response -> stop；覆盖 stepInTargets/stepBack capability profile。
- real adapter smoke：Java、Node、Python、Delve、LLDB 按各自支持能力记录 initialize、action request/event、source mapping、停止/清理，不要求每个 adapter 支持所有动作。
- 三端：Windows/Linux/macOS 的 F-key/system conflict、IME 输入 REPL、200% zoom、resize persistence、长输出 CPU/内存、compound session。

建议性能门槛以同机基线为主：10,000 Console entries 追加时 UI 不随总行数线性重渲染；20 threads/每线程 200 frames 按需加载；隐藏 subtab 不发新 DAP 请求；持续 output 时用户滚动/输入不阻塞。trace 不记录表达式、变量值、源码或完整路径。

### 15.7 Agent ownership

| Agent | 负责文件/职责 | 不得越界 |
|-------|---------------|----------|
| D0/D3 | `DebugToolbar`/SubTab/Action adapter、keymap、配置文案 | 不改 Console/variables reducer |
| D1 | Console model/pane、output sequence、REPL request guard | 不改 stack/variable cache |
| D2 | `useCodeDebugSession` stop snapshot、Frames/Variables/Watches | 不改 Action Service core 或 layout persistence |
| D4 | layout preference/migration、responsive host、ARIA/i18n | 不改 DAP request semantics |
| D5 | fake adapter harness、component/QA catalog/cases、真实 smoke checklist | 不以 mock 结果改能力支持矩阵 |

合并顺序为 D0 -> D1/D2/D4（可并行）-> D3 -> D5。D1/D2 若都需修改 `useCodeDebugSession.ts`，先各自提交共享类型/epoch contract，再按 Console output 与 stop snapshot 分区，避免同时重排 2.9k 行 hook。所有 agent 都应保留用户/其他分支已有修改，不回退无关代码。

---

### 15.8 最新提交再复核（2026-08-18）

以下是代码已经接入的事实，状态沿用 `model -> wired -> workflow -> verified`。

- [~] **D1 控制台与 REPL generation guard**：clear 与公开 `terminate()` 会 bump generation，`evaluate`/`hoverEvaluate` 已在 hook 内检查 generation + sessionId；但 `publishActiveSession`/`selectSession`、间接 terminate、continue/new stop/frame change 不会 bump，旧 A session 请求在 A→B→A 后仍可能被接受。stale evaluate 返回空结果而非 typed stale/cancelled，pane 的 Promise 链仍可能追加空 result。
- [~] **D2 变量与 Watch 稳定 ID**：当前 mount 内 `WatchExpressionItem.id` 已贯通到 pane，filter/sort 后删除按 watchId 精准执行；但持久化仍只保存 expression、重载会重建随机 ID，且缺 reorder/enable/per-watch error。scopes/variables/watch response 仍无完整 `(session,stopEpoch,frame,requestId)` guard。
- [~] **D3 执行点与单步中央锁**：`stepInFlightRef/isStepping` 已移入 hook，`step()` 返回 typed result，toolbar/keymap 最终共享中央锁，Show Execution Point 已连通；但还没有 capability-driven Debug Action Service，Hot Reload 仍对任意 adapter 可见并发送 Java `redefineClasses` 私有请求，其它 action 入口也未统一 descriptor。
- [~] **D0/D4 子 Tab 导航与 ARIA**：`DebugSubTabBar` 已有 `role="tablist"`、`role="tab"`、`aria-selected`、roving `tabIndex` 与 ArrowLeft/Right/Home/End。
- [~] **D5 测试与回归**：本轮 11 个相关测试文件、195 tests 通过；这是 unit/component 回归证据，不等于 fake DAP、真实 adapter、QA YAML、性能或三端门禁完成。

**明确未交付。** Console seq/unread/follow-tail/ring buffer/REPL history 尚无；evaluate 未绑定 stopEpoch/frame/requestId，跨 session publish 与间接 terminate 不递增 generation；`refreshStoppedContext/selectThread` 仍只维护单线程 40 帧；`fetchScopes/fetchVariables` 失败仍折叠成空数组；value diff key 未完整包含 session/stop/frame；Watch 缺 reorder/enable/error；Hot Reload 未 capability gate；Debug layout 仍用 global preference，ARIA/i18n/隐藏 pane request guard、200% zoom、IME、非美式键盘、QA catalog、真实 adapter 与三端 evidence 均缺。

### 15.9 `f88c5785` as-built 再审计（2026-08-18）

本节只记录 §15.8 之后的增量事实。交付等级仍按 `model -> wired -> workflow -> verified`，新增文件或局部组件测试不自动提升等级。

| 包 | 本提交实际新增 | 仍未闭环 | 结论 |
|----|----------------|----------|------|
| D6 Action Service | 新增 `debugActionService.ts` descriptor/action matrix；Hot Reload 有初步 gating；Show Execution Point 保持接线 | Toolbar 仍直接调用 `debug.step/terminate/restart`，Search/keymap/workspace registry 未统一消费 descriptor；`execute` 仍是 void Promise，无 `ActionResult/requestId/central lock`；runToCursor/callback/extension manifest gating 不完整 | **model + partial consumer** |
| D7 Console | output entry 增加 seq 与 ring cap；pane 有 follow-tail、scroll-to-bottom、REPL history；clear/terminate/evaluate 有部分 generation 检查 | follow/history/seen 是 pane-local，切 session 会串；badge 仍可能是总长度；generation 不等于 per-stop epoch，且以 stoppedThreadId 代替 epoch；结果仍 append 到 resolve 时的当前 session，stale 空结果可能生成空行；2 MiB/ANSI/paint 门禁未证明 | **wired / correctness gap** |
| D8 Variables/Watches | scopes/variables 请求增加 session guard；parent 向隐藏 pane 传 visible；Watch 删除继续按运行期 ID | 同一线程连续 stop 仍可接受旧响应；children expand 无 requestId/epoch/dedupe/error，collapse 后迟到结果可能复活；错误仍可能折叠为空；diff key、持久 stable watch ID、reorder/enable/per-item error 未完成 | **wired / correctness gap** |
| D9 ARIA/Layout | tab id/`aria-controls`、tabpanel/`aria-labelledby` 和 visible props 有部分接线 | Arrow 导航仍用 document-global query，多个 Debug 实例会错焦点；global split preference 未迁移；separator/toolbar keyboard/i18n/200% zoom/hidden no-request 未验证 | **wired / partial** |
| D10 Evidence | 新增单元/组件覆盖伴随提交 | 没有 fake DAP 全链、真实 Java/Node/Python/Delve/LLDB trace、QA catalog/YAML、性能或 Linux/macOS/Windows native evidence | **unit evidence only** |

**关键纠偏。** `stoppedThreadId` 是线程标识，不是 stop epoch；同一 thread 可连续停止多次。Console、scopes、variables、watch、stack 和 action response 必须共享由 `stopped` event 单调递增的 `stopEpoch`，并使用 `(sessionId, stopEpoch, frameId, requestId[, clearGeneration])` 做发布条件。所有异步结果必须写回请求发出时捕获的 session reducer，禁止 Promise resolve 后重新读取 active session。

**本轮验证结果。** 编辑器/布局相关回归为 5 files/42 tests 全绿，Debug 定向回归为 3 files/42 tests 全绿，`CodeWorkspaceTab.test.tsx` 56 tests 全绿；`pnpm build`（`tsc -b && vite build`）已修复并全绿通过。`git diff --check` 通过。后续包将继续补齐 fake DAP 全链、真实 adapter trace、QA YAML 及三端 native 证据。

### 15.10 `3f107de9` 增量复核（2026-08-19）

`3f107de9` 对 Debug 的代码变化只有 `debugActionService.ts` 将非法的 `stepInto` 参数改为 `stepIn`；其余 Debug v2.2 工作没有实现。Build 恢复是必要门禁，但不提升 D6-D10 的 workflow 等级。

| 领域 | 当前生产事实 | 继续阻断的点 | 下一包 |
|------|--------------|--------------|--------|
| Action | descriptor 中 Step Into 已调用合法 `DebugStepAction`；hook 中 `step()` 仍有中央防重入 | `DebugSessionControls`、`DebugStepControls`、`DebugPanel` restart 和 editor chrome 仍直接调用 hook；descriptor `execute` 返回 void，无 requestId/ActionResult；Hot Reload 仍接受通用 capability，不是 adapter extension manifest | D6.1 |
| Epoch | `DebugSessionRecord.stopEpoch` 已在每次 `stopped` event 单调递增，并被 hook 内部分 stack/frame 请求使用 | `DebugSessionState`/`CodeDebugSession` 不公开 stopEpoch；Console 和 `useDebugVariables` 仍把 `stoppedThreadId` 当 epoch，同一线程连续 stop 会接收旧结果；child expand 无 token | D8.1 后供 D7.1 消费 |
| Console | seq、10k line cap、follow-tail/history 基础仍在 | UI state 仍 pane-local；没有 session unread/2 MiB cap；evaluate result 仍经当前 debug session append；clear/frame/new stop token 不完整 | D7.1 |
| Layout/ARIA | tab/tabpanel id 基础仍在 | tab id 固定且 focus 用 document-global query；split preference 仍是全局 v1 key；hidden Debugger/Breakpoints/Memory pane 常驻，尚无 zero-request 证明 | D9.1 |
| Evidence | 本轮 Debug 定向测试 4 files、44 tests 通过，`pnpm build` 通过 | 无 fake DAP、真实 adapter trace、QA YAML、性能与三端 native | D10.1 |

**架构纠偏。** 下一步无需再新造另一套 epoch：以现有 `DebugSessionRecord.stopEpoch` 为唯一源，把 snapshot/token 公开到前端 model，并让 action/console/variables/stack 共用。`consoleGeneration` 只负责 clear/session UI generation，不能替代 stop epoch；threadId/frameId 都不是 generation。

### 15.11 `3aacbecc` 最新提交复核（2026-08-19）

本节只评价最新提交的生产可达性。类型、hook 字段和组件 mock 分别只能证明 `model`/`component`，不等于真实 DAP workflow。

| 领域 | 已确认实现 | 仍未闭环 | 当前等级 / 下一包 |
|------|------------|----------|------------------|
| Stop snapshot/token | `DebugSessionState.stopEpoch`、`CodeDebugSession.stopEpoch` 已公开；`stopped` reducer 递增；`DebugRequestToken`/`AsyncLoadState` 类型存在；Variables 首轮 guard 已改读 epoch | `fetchScopes/fetchVariables/evaluate/stackTrace` 没有接受/发布 token；children 无 requestId/interest/dedupe；失败仍变成空数组/空值；Console REPL 仍以 `stoppedThreadId` 检查迟到结果；watch reload 仍从 string[] 重新造 ID | **model + partial consumer；D8.2** |
| Action | descriptor 仍覆盖 step/restart/hot reload 等 capability matrix；hook `step` 有防重入 | `DebugToolbar`、`DebugSessionControls`、`DebugStepControls`、Frames/context、Panel restart 和 workspace keymap 仍直接调用 hook；descriptor execute 没有 requestId/typed result/central session lock；Hot Reload 仍依赖宽泛 capability 字段 | **model/partial；D6.2** |
| Console | seq、10k line cap、follow-tail、history、clear generation 基础存在；当前组件回归通过 | follow/history/lastSeen 仍 pane-local；没有 per-session unread、2 MiB budget、captured frame/stop/request token；evaluate 错误以空/错误值混入结果；hidden/clear/frame/new-stop late result 不能由 session reducer 定向拒绝 | **component only；D7.2** |
| Layout/ARIA | DebugPanel tab/tabpanel IDs、visible prop、compact/full layout 基础存在；5 files/46 tests 全绿 | SubTabBar 仍 `document.querySelector`；tab IDs 没有 workspace/window instance prefix；split 使用 global localStorage key；Debug Variables hook 在 pane hidden 时仍创建 scopes/watch effect；separator/toolbar keyboard/i18n/200% zoom 无证据 | **partial；D9.2** |
| Evidence | `pnpm build` 通过；DebugPanel/Console/Frames/SubTab/Variables 定向为 46/46 | 无 fake DAP stale/failure/cleanup、真实 Java/Node/Python/Delve/LLDB trace、QA catalog/YAML、10k/2 MiB/20x200 性能和 Linux/macOS/Windows native 证据 | **unit/component only；D10.2** |

**本轮验证事实。** Debug 定向 5 files、46 tests 全绿；`dapDebugModel.test.ts` 与 `useCodeDebugSession.test.tsx` 合计 89 tests 全绿；`pnpm build` 通过。编辑器定向 style 隔离测试仍失败，因此 Debug 文档不得把全仓库 release gate 写成绿色。以上不提供 fake adapter、真实 adapter、Tauri、QA 或三端证据。

**复核结论。** `3aacbecc` 完成了 D8 的公开字段和结构化类型，但没有完成 D8 workflow；D6/D7/D9 仍必须按生产 consumer 重做接线。下一步先让 D8 token 成为 scopes/variables/evaluate/stack 的唯一发布条件，再由 D6 action service、D7 session console、D9 workspace layout 消费，D10 随包记录协议和平台证据。

### 15.12 `1b6f91cf` 最新提交复核（2026-08-19，含 IDEA 2026.2 对照）

本节只评价 `1b6f91cf` 的生产可达性；descriptor 文件、类型声明与组件 mock 只能证明 `model/component`。

| 领域 | 已确认实现 | 仍未闭环（含证据） | 当前等级 / 下一包 |
|------|------------|--------------------|-------------------|
| D6.2 Action Service | `debugActionService.ts:1-238` descriptor 文件存在 | `execute` 返回 `void`（`:36`），非 instance service、无 typed result/requestId/取消；`DebugToolbar.tsx:53,63,73,87,98,129` 与 `DebugFramesPane.tsx:43,111` 仍直调 hook；Hot Reload 接受泛化 capability 字段而非 adapter extension manifest（`debugActionService.ts:41-44`）；无 Search/keymap bridge consumer | **model；D6.3** |
| D7.2 Console | session record 持有 output；模型 10k 行截断（`dapDebugModel.ts:340-359`） | history/draft/follow-tail/seen 是 pane-local（`DebugConsolePane.tsx:20-28`），A→B→A 不恢复；REPL 用 `stoppedThreadId` 当 epoch（`:77-88`）；`logConsole` 写 active session 且仅 2k cap（`useCodeDebugSession.ts:1036-1042`）；generation 只在 clear bump（`:1044-1047`），active publish/间接 terminate 不 bump（`:890-912,1755-1787,1802-1856`）；无 2 MiB budget 与 reducer-owned unread | **component only；D7.3** |
| D8.2 Token/Watch | token/load/watch 类型存在（`dapDebugModel.ts:263-284`）；stopped 递增 epoch；variables 有有限 epoch 检查 | fetch API 只收 frame/reference（`useCodeDebugSession.ts:280-282`）；stackTrace 不分页且仅 epoch 检查（`:1614-1650,2736-2751`）；watch 持久化 `string[]`、reload 重造 ID（`:717,818-826,1017-1023,2613-2654`），无 order/enable/error；hidden Debugger 仍无条件创建 variables hook（`DebugPanel.tsx:145-146`） | **model + partial consumer；D8.3** |
| D9.2 Layout/ARIA | ref-scoped tab 导航已修（`DebugSubTabBar.tsx:37-58`） | `CodeWorkspaceTab.tsx:10714-10722` 未传 `workspaceInstanceId`；panel ID 无实例前缀（`DebugPanel.tsx:253-257,387-392`）；split key 仍全局（`DebugPanel.tsx:34,150-153`、`DebugVariablesPane.tsx:18-20,77-91`）；separator 无 ARIA/键盘值；文案为字面量未入 i18n（如 `DebugPanel.tsx:233-245,263`） | **partial；D9.3** |
| D10.2 Evidence | — | 无 fake DAP 生命周期、QA YAML/catalog、真实 Java/Node/Python/Delve/LLDB trace、性能或 native 证据 | **missing；D10.3** |

**本轮验证事实。** `pnpm exec tsc -b` 干净；编辑器+Debug 定向回归 10 files、183/183 通过。仅为无回归证据，不构成 fake/真实 adapter、QA、性能或三端门禁。

**IDEA 2026.2 对照增量。** 官方 2026.2 Debugger 相关新增：Logpoints（本仓库模型/gutter 已有，缺插值求值与输出证据）与 runtime output → source code 导航增强（本仓库 Console 已有不正确的初版 linkify/openLocation）；async stack traces 是 Java agent 特性，通用 DAP 无标准 capability，声明为非目标。当前对应待办见 §21 D11.1/D11.2。

### 15.13 `dab8a778` production-path code review（2026-08-19）

本节审查 §20 的实际交付。结论为 **FAIL**：新增模型与组件行为有价值，但没有形成规定的唯一 action/request/console/layout owner；D11 source link 还会打开错误行。

| 领域 | 本提交已确认 | Code review 发现的阻断事实 | 当前等级 / 下一包 |
|------|--------------|----------------------------|-------------------|
| D6.3 Action | `createDebugActionService` 返回 typed `Promise<ActionResult>` 并有 busy/cancel skeleton | 无 production consumer；Toolbar/Frames 仍直调 debug hook。service 在 descriptor resolve 后一律返回 applied（`debugActionService.ts:284-288`），但 `debug.step` 可能 resolve `{kind:"failed"}`，terminate/restart 仍 fire-and-forget；失败/取消被误报成功且不写目标 session Console | **model only / unsound result；D6.4** |
| D8.3 Token/Watch | watch migration helper 与部分 hidden pane gating 已加入 | public scopes/variables API 仍只收 frame/reference并读 mutable active session；variables expansion 无取消且闭包可把 A 的迟到结果渲染进 B；stack 固定 40 条无 paging/cache；migration helper 无 consumer，持久化仍为 `string[]`、reload 重造 ID | **model + partial guard；D8.4** |
| D7.3 Console | source line renderer 与现有 output ring 基础存在 | draft/history/follow/seen 仍是 pane-local；badge 是总 output 数而非 unread；`logConsole` 仍有独立 2k cap，不符合 10k + 2 MiB session reducer；clear/continue/terminate 的 request generation 未统一 | **wired partial；D7.4** |
| D9.3 Layout/ARIA | subtab IDs 使用 workspace instance，Variables pane 按当前 tab 控制 visible | split storage key 与 PanelGroup ID 仍 global（`DebugPanel.tsx:34-35,360`），Variables split 同样 global；separator 无完整 ARIA/keyboard，testids 未实例化、可见文案未 i18n | **wired partial；D9.4** |
| D11 Source navigation | Console 将 `path:line(:col)` 渲染为按钮并调用 `onOpenLocation` | renderer 先把 line/column 减一（`DebugConsolePane.tsx:36-44`），CodeWorkspace `openDebugFrame` 再减一，形成 double decrement；相对路径没有按 roots 解析，`App.java:42` 可 no-op；只有 pane callback test，没有 host navigation test | **wired but incorrect；D11.1** |
| D10.3 Evidence | `tsc -b` 与新增相关 5 files/45 tests 通过 | 无 fake DAP、真实 adapter、性能/native；QA catalog/YAML 仍使用 `[data-testid="code-workspace-debug-panel"]`，生产已改为 `debug-panel`，现有自动化 selector 失效 | **missing / broken gate；D10.4** |

**Code review 结论。** 先修 D11 错误导航和 D8 跨 session stale publish，再接 D6 唯一 action service；D7/D9 不能继续在 pane/global localStorage 上增量堆字段。所有 service/model 的完成声明必须附生产 consumer 搜索与真实 host/fake DAP 证据。

## 16. v2.1 下一轮权威待办（面向其它 agent，`f88c5785` 前历史快照）

本节记录 `f88c5785` 之前的生产代码复核。当前增量事实见 §15.11，当前执行顺序见 §19。每个包必须同时提交：生产 host 接线、typed state/result、取消/失败/恢复语义、纯/组件测试、QA catalog/YAML 变更和适用的真实 adapter 证据。单测直接 mock `CodeDebugSession` 不能把能力升级为 `workflow`。

| 优先级 | 工作包 | 已具备 | 本轮剩余 |
|--------|--------|--------|----------|
| P0 | D6 Action Service | hook-level step lock；Show Point wiring | capability descriptor；所有入口统一；Hot Reload extension gate |
| P0 | D7 Console | clear/public terminate generation guard | per-session/stop/frame/request epoch；seq/unread/follow-tail/ring/history |
| P0 | D8 Stack/Variables/Watches | mount 内 watchId 删除 | thread paging/cache；scope/variable epoch；structured watch reorder/enable/error |
| P1 | D9 Layout/ARIA/i18n | basic responsive/tab keyboard | workspace preference/migration/Reset；tabpanel/resizer；hidden-pane guard |
| Gate | D10 Adapter/QA/native | unit/component tests | fake DAP、真实 adapter、catalog/YAML、性能与三端 evidence |

### D6：Debug Action Service、能力真值与执行点

**本次复核后的清单：**

- [x] step Promise、中央防重入状态和 Show Execution Point 已接生产。
- [ ] 建立唯一 `DebugActionDescriptor` service，并让 toolbar/Search/keymap/keyboard 全部消费相同 state/result。
- [ ] Hot Reload 仅在 adapter manifest 明确声明 Java extension 时注册；Node/Python/LLDB 不渲染也不发请求。
- [ ] stepBack/runToCursor/stepInTargets/restart/stop 的 supported/available/busy/failure 均由 capability + session epoch 派生。
- [ ] 失败不得静默吞掉；Console 记录结构化错误，Abort/terminated/continued 释放 action lock。

**目标。** 工具条、子 tab badge、Search/Keymap 和快捷键只消费一个 capability-driven action descriptor；Java 私有扩展不得以通用按钮出现。

```ts
type DebugActionId =
  | "debug.resume" | "debug.pause" | "debug.stop" | "debug.restart"
  | "debug.stepOver" | "debug.stepInto" | "debug.stepOut"
  | "debug.stepBack" | "debug.showExecutionPoint" | "debug.runToCursor"
  | "debug.hotReload";

interface DebugActionDescriptor {
  id: DebugActionId;
  source: "dap" | "adapter-extension" | "local-navigation";
  supported: boolean;
  available: boolean;
  disabledReason?: "no-session" | "running" | "not-stopped" | "capability" | "busy" | "runtime";
  run(signal?: AbortSignal): Promise<{ kind: "applied" | "no-op" | "failed" | "cancelled"; message?: string }>;
}
```

从 initialize capability、session status、active child 和 request lock 派生 descriptor；`hotReload` 只有 adapter manifest 明确声明 `java.redefineClasses` 时注册。`Show Execution Point` 是 `local-navigation`：将 `debug.currentLocation` 转成 `onOpenFrame`/sourceReference 定位；必须修复当前 `DebugFramesPane -> DebugStepControls` 未传 callback 的死入口。Run to Cursor/stepInTargets/force step/step back 逐项按 capability 或 extension gating，不以普通 `stepIn` 改标题。

执行契约必须由 service 持有：`run()` 返回可等待的 `Promise<ActionResult>`，并在发 request 前生成 requestId、在 continued/stopped/terminated、AbortSignal 或 failure 时释放锁。现有 hook-level `stepInFlightRef` 可作为迁移基础，但 toolbar 不能继续单独推导能力或绕过 service；旧 request 的结果不能覆盖新 active child 或新 stop epoch。

**文件边界。** 新建 `panels/debug/debugActionService.ts`（或等价 adapter）；修改 `DebugPanel.tsx`、`DebugToolbar.tsx`、`DebugSubTabBar.tsx`、`DebugFramesPane.tsx`、`useCodeDebugSession.ts` capability adapter、`workspaceActionRegistry` bridge、`src/lib/i18n/locales/{en,zh-CN}.ts` 和 D6 tests。不得改 Console ring buffer 或 per-thread cache。

**状态/失败。** 每次 action 生成 requestId；双击只允许一个 in-flight；continued/stopped/terminated、AbortSignal 或 request failure 都释放 lock。失败写结构化 Console entry，并恢复按钮到可重试状态；不得在 hook 中静默 catch 后返回成功。无 session、browser runtime、能力缺失必须显示 reason，不发送 DAP request。

**验收。** Java/Node/Python/LLDB synthetic descriptors；toolbar/Search/keymap/keyboard 状态完全一致；Show Point 真实打开源文件；hot reload 在非 Java adapter 不出现；stepInTargets 0/1/N、stepBack unsupported、request failure、compound active child、keymap remap 和 i18n 文案都有组件测试与 testid。

### D7：Console sequence、unread、follow-tail 与 REPL generation

**本次复核后的清单：**

- [x] clear 与公开 terminate 已 bump generation；evaluate/hover 已有基础 session/generation 检查。
- [ ] generation 改为 per-session request epoch，并在 active-session publish、所有 terminate 路径、continue/new stop、frame change、restart 和 clear 时正确失效。
- [ ] evaluate 返回 typed `applied/stale/cancelled/failed`，pane 只为 applied append；不得以空字符串代表 stale。
- [ ] entry 使用单调 seq + sessionId；实现 10k/2MiB ring、truncation marker、unread badge 与 24px seen 规则。
- [ ] follow-tail、Scroll to end、每 session 100 条 REPL history、Up/Down/Esc draft 与 busy-cancel policy 完整接线。

**目标。** 把 `state.output` 的无身份数组升级为 session-scoped 有界日志模型，修正当前总行数 badge、强制滚底和旧 evaluate 回填。

```ts
interface DebugConsoleEntry {
  seq: number; sessionId: string; category: "stdout" | "stderr" | "console" | "repl" | "result" | "telemetry" | "unknown";
  text: string; timestamp: number; rawCategory?: string;
}
interface DebugConsoleUiState {
  lastSeenSeqBySession: Record<string, number>;
  clearGenerationBySession: Record<string, number>;
  followTailBySession: Record<string, boolean>;
  historyBySession: Record<string, string[]>;
  historyIndexBySession: Record<string, number | null>;
}
```

`logConsole` 在 `useCodeDebugSession` 内分配单调 seq（不能用 array index），每 session 默认 10,000 entries/2 MiB ring buffer，截断插入 marker。badge 只统计 `seq > lastSeenSeq`；Console 可见且距底部 <=24px 才推进 seen，Clear 递增 `clearGenerationBySession` 并推进 seen，但不改变 session identity。用户向上滚自动关闭 follow-tail，提供 icon-only Resume/Scroll-to-end；隐藏 pane 不改变 seen。REPL history 每 session 最近 100 条、连续重复去重、Up/Down/Esc 草稿、默认不写 localStorage。

evaluate 请求和结果绑定 `(sessionId, frameId, stopEpoch, requestId, clearGeneration)`；请求发出后必须捕获目标 session/epoch，结果 append 只能调用该 session 的 reducer，不能在 Promise resolve 时再次读取“当前 active session”。切 session/frame、continue、terminate、新 stop 或 clear 后旧结果标记 stale/cancelled，不追加到当前 Console；错误进入 stderr，busy 时明确选择 cancel 或 queue（先实现 cancel）。

**文件边界。** D7 负责 `dapDebugModel.ts` output entry/reducer、`useCodeDebugSession.ts`、`DebugConsolePane.tsx`、Debug console shared store/model 和 tests；不得改 frames/variables request semantics。

**验收。** hidden/visible 切换、读历史日志、离开底部、clear 后迟到结果、terminate/restart、session switch、frame/stop 变化、10k output、ANSI/多行、evaluate success/error/stale/cancel、history draft、memory/paint profile；加入 `debug-console-unread`、`debug-console-follow-tail`、`debug-console-history` QA controls，并断言旧结果不会污染另一 session 或清空后的日志。

### D8：Per-thread stack cache、分页与稳定 Variables/Watches

**本次复核后的清单：**

- [x] Watch UI 删除已从 rendered index 改为当前 mount 内的 watchId。
- [ ] Watch state 持久化稳定 ID/order/enabled，提供 reorder/enable/edit/error；删除 API 移除 number/expression fallback，只接受 ID。
- [ ] stack 建立 per-thread cache、50/200 分页、partial/error/load-more，并以 session/stop/thread/requestId 发布。
- [ ] scopes/variables/evaluate/setVariable/data breakpoint 全部绑定 session/stop/frame/requestId，失败不能伪装成空数组。
- [ ] diff cache key 包含 session/stop/frame/stable path；collapse/frame/session 变化后的迟到响应不得复活节点。

**目标。** 停止时至少同时查看两个线程的 stack snapshot，切线程不丢缓存；所有 scopes/variables/watch 请求具备 epoch guard 和可恢复 partial 状态。

```ts
interface ThreadStackState {
  status: "idle" | "loading" | "ready" | "partial" | "failed";
  frames: DebugStackFrame[]; totalFrames?: number; nextStartFrame: number;
  requestId?: string; error?: string;
}
interface DebugStopSnapshot {
  sessionId: string; stopEpoch: number; stoppedThreadId: number | null;
  stacksByThreadId: Record<number, ThreadStackState>;
}
interface WatchExpressionState {
  id: string; expression: string; enabled: boolean; order: number;
  value?: string; type?: string | null; lastError?: string;
}
```

`refreshStoppedContext` 首批请求所有可见 thread 的 50 帧或按需首个线程；`selectThread`/展开线程发送 `stackTrace(threadId,startFrame,levels)`，只在 `(sessionId,stopEpoch,threadId,requestId)` 全匹配时发布；continue/step 清空 snapshot，新 stopped 建新 epoch。无 totalFrames 时以 page size 判断结束，Load More 显示 partial。Copy Call Stack 标注 partial。

Variables cache key 为 `session/stopEpoch/frameId/scope/variablesReference`，保持 scope 分组；展开、setVariable、data breakpoint 和 evaluate 都带 guard。每个异步请求必须有 requestId、loading/error/partial 状态和去重；响应发布前检查 session/stop/frame/variablesReference，collapse 或切 frame 后的迟到响应不得重新展开节点，失败不能折叠成 `[]`。相邻 epoch 以 stable path 做 changed/new/removed 浅层 diff，`previousValuesRef` 必须按 session/stop/frame 隔离，无法证明 identity 时标 local comparison。Watches 在 model 边界立即改为 `{id, expression, enabled, order, lastError}`，所有 remove/edit/reorder/enable 操作按 stable `id`，不能把 filter/sort 后的 rendered index 传回 source array；支持逐条错误，持久化只保存表达式，不保存 value。

**文件边界。** D8 负责 `useCodeDebugSession.ts` stop snapshot/types、`DebugFramesPane.tsx`、`useDebugVariables.tsx`、`DebugVariablesPane.tsx`、`VariableRow.tsx` 与 tests；不得改 D6 action registry 或 D9 layout preference。若 D7 也需改 hook，先合并共享 epoch type，再按 output/stop snapshot 分区。

**验收。** 20 threads、两线程并行展开、50/200 帧分页、快速 continue/re-stop、session switch、旧 response、stack failure/partial、递归变量、重复名字、value diff、frame/session-isolated diff、watch filter/sort 后按 ID 删除、watch reorder/error/disable、collapse-before-response、frame change 和 compound session；保持现有 `debug-thread-*`/`debug-frame-*` testid，新增 load-more/watch handles。

### D9：Workspace-scoped layout、ARIA、i18n 与窄宽稳定性

**本次复核后的清单：**

- [x] 已有基础 ResizeObserver、compact pane 和 tab 键盘导航。
- [ ] global localStorage key 迁移为 workspace/window-scoped v2 preference，并提供坏数据回退与 Reset action。
- [ ] tab/tabpanel 使用本实例 ref 关联 `aria-controls/aria-labelledby`；禁止 document-global focus 查询。
- [ ] separator 补 label/orientation/value/min/max 与键盘调整；toolbar 补 roving focus/visible focus ring。
- [ ] hidden pane 传 `visible=false` 并停止 scopes/variables/evaluate effect。
- [ ] UI 文案全部 i18n；完成 320–1024px、200% zoom、长中英文和 reduced-motion 验证。

**目标。** 将两个 global localStorage key 迁移为 workspace instance preference，并完成可访问 tab/panel/resizer/toolbar。

```ts
interface DebugLayoutPreferenceV2 {
  schemaVersion: 2;
  horizontal: { frames: number; variables: number };
  vertical: { variables: number; watches: number };
  compactPane: "frames" | "variables";
}
```

一次性从 `taomni.codeWorkspace.debugSplitHorizontal.v1`/`...Vertical.v1` 迁移合法比例；workspace/window 互不共享，非法值回默认。提供 `debug.resetLayout` action。ResizeObserver 只负责切换模式，compact 使用 Frames/Variables segmented tabs；隐藏 pane 必须收到 `visible=false`，禁止后台 DAP/effect，`useDebugVariables` 也不能在不可见 tab 创建会触发 fetch 的 effect。`DebugSubTabBar` 补 `aria-controls`，每个 pane 使用 `role=tabpanel`/`aria-labelledby`；separator 有方向、label、min/max/value 和键盘调整，toolbar 有 roving focus/visible focus ring。箭头导航只能在当前 bar 的 ref-scoped tab collection 中查找按钮，禁止 `document.querySelector` 这种 document-global focus。

所有空态、status、tooltip、error、button 文案进入现有 i18n，删除通用面板中的 Java-only 字符串；320/480/640/1024px、100%/200% zoom、长中文/英文翻译不能溢出。`prefers-reduced-motion` 下不依赖动画表达状态。

**文件边界。** D9 负责 `DebugPanel.tsx`、`DebugSubTabBar.tsx`、`DebugVariablesPane.tsx` layout helpers/store、i18n、ARIA/visual tests 和 feature catalog；不得改 D8 DAP request。

**验收。** 双 workspace/多窗口 layout 隔离、迁移坏数据、Reset、compact/full 切换、键盘 tab/tabpanel/resizer、两个 Debug panel 同时 Arrow 导航仍聚焦本实例、读屏名称、200% zoom、中文长文案、隐藏 pane 无 scopes/variables/evaluate 请求；浏览器和 Tauri smoke 各一条。

### D10：Fake DAP、真实 adapter、性能与三端门禁

**本次复核后的清单：**

- [x] 相关 unit/component 回归当前为 11 files、195 tests 全绿。
- [ ] 建立 fake DAP 全事件链与 supported/unsupported profiles，覆盖 stale/partial/failure/cleanup。
- [ ] Java、Node、Python、Delve、LLDB 记录脱敏 capability/action/source/cleanup smoke evidence。
- [ ] 同步 feature-list、testid catalog、YAML：unread/follow-tail、step busy、multi-thread/load-more、layout Reset 与 unsupported reason。
- [ ] 完成 10k Console、20x200 frames、hidden pane no-request 性能门槛及 Linux/macOS/Windows native checklist。

**目标。** 把组件 mock 之外的 Debug 语义和平台证据固化，能力矩阵以真实 adapter 为准。

Fake DAP 必须覆盖 `initialize -> launch -> initialized -> threads -> 两线程 stackTrace 分页 -> scopes/variables -> evaluate -> continue/stale response -> stopped -> terminate`，并提供 stepInTargets/stepBack/hotReload supported/unsupported profiles。真实 smoke 至少 Java、Node、Python、Delve、LLDB（C++ 可随后）记录 initialize capabilities、每个 action request/event、source mapping、失败和 cleanup；不要求 adapter 支持所有动作，但 UI 必须准确显示 unavailable。

`qa-ui-auto-tests/feature-list.md`、`references/testid-catalog.md` 和 YAML 增加四个 sub-tab、unread/follow-tail、compact/full、Reset、step state、multi-thread/load-more、unsupported reason。性能门槛：10k entries 追加不产生线性 DOM 重渲染；20x200 frames 按需加载；持续 output 时输入/滚动不阻塞；隐藏 pane 不发 DAP。Linux/macOS/Windows 原生包记录 F-key/system conflict、IME REPL、200% zoom、resize persistence、长输出 CPU/内存和 compound session；trace 脱敏，不记录表达式/变量/源码/完整路径。

**文件边界。** D10 负责 fake adapter harness、Rust/TS integration fixture、QA catalog/cases、性能脚本和三端 smoke checklist；不得以 mock capability 改写产品支持矩阵。

### 16.1 Agent ownership 与合并顺序

| Agent | 负责文件/职责 | 不得越界 | 合并前必须交付 |
|-------|---------------|----------|----------------|
| D6 | action service、toolbar/subtab/frames wiring、i18n action keys | D7/D8 state model | descriptor matrix、show-point trace、capability tests |
| D7 | console model/pane、sequence/unread/follow-tail/REPL | frames/variables cache | stale/cancel/ring-buffer tests、console QA case |
| D8 | stop snapshot、thread paging、variables/watches | action core、layout schema | epoch reducer、two-thread fixture、watch IDs |
| D9 | layout migration/store、responsive host、ARIA/i18n | DAP request semantics | workspace isolation、a11y/zoom/compact tests |
| D10 | fake/real adapter harness、QA catalog/cases、performance/native evidence | 修改 capability truth | sanitized traces、platform matrix、gate report |

合并顺序：`D6 -> D7/D8/D9（共享类型先行，可并行） -> D10`。若 D7/D8 同时需要 `useCodeDebugSession.ts`，先提交只含 `DebugConsoleEntry`/`DebugStopSnapshot` 的类型与 reducer，再按代码区域合并；所有 agent 必须保留其它分支修改，不回退无关文件。

## 17. v2.2 `f88c5785` 后续待办（`3f107de9` 前历史合同）

§16 保留完整目标，本节记录 `f88c5785` 后形成的任务合同；`3f107de9` 只修复 Step Into/build gate，当前最小开发批次以 §19 为准。所有工作包必须以生产 consumer 为准；descriptor、hook 字段、pane-local state 或 mocked `CodeDebugSession` 只能分别证明 model/component，不能代替真实 action path 和 DAP 生命周期。

| 顺序 | 包 | 当前可复用基础 | 本轮必须交付 |
|------|----|----------------|--------------|
| P0 | D6 Action execution | descriptor factory、部分 Hot Reload/Show Point state | instance service、typed result/request lock、Toolbar/Search/keymap/workspace bridge |
| P0 | D7 Session console | seq/ring、follow-tail、history、部分 generation guard | session-owned UI state、真实 stop epoch、captured append、unread/2 MiB/late-result correctness |
| P0 | D8 Stop snapshot | session guard、visible prop、运行期 watch ID | monotonic stopEpoch、request state/dedupe、error-vs-empty、stable Watch model |
| P1 | D9 Layout/ARIA | tab/tabpanel ids、responsive host 基础 | ref-scoped focus、workspace preference v2、hidden no-request、resizer/i18n/zoom |
| Gate | D10 Evidence | unit/component tests | fake DAP、QA catalog/YAML、真实 adapter、性能与三端 native evidence |

### 17.1 D6：让 Action Service 成为唯一执行入口

**实现。** 将 `debugActionService.ts` 从纯 descriptor helper 改为每个 Debug/workspace 实例拥有的 service。descriptor 只暴露 `state` 和 `run(signal)`；`run` 创建 requestId、捕获 `(sessionId, activeChildId, stopEpoch)`，通过一个 central in-flight map 执行并返回统一结果：

```ts
type DebugActionResult =
  | { kind: "applied"; requestId: string }
  | { kind: "no-op" | "cancelled"; requestId?: string; reason: string }
  | { kind: "failed"; requestId: string; message: string; retryable: boolean };
```

`DebugToolbar`、Frames/Breakpoint context actions、Search Everywhere、keymap/keydown 和 workspace ActionHost bridge 只能消费 service，删除直接 `debug.step()`/`terminate()`/`restart()` 分支。`showExecutionPoint` 在 callback 缺失时必须 `disabled`；runToCursor/stepBack/stepInTargets 必须有标准 capability 或明确 adapter extension，不用其它 step 动作冒充。Hot Reload 只在 adapter manifest 明确声明 `{ extension: "java.redefineClasses" }` 时注册，通用 `supportsHotReload` 字段不能让非 Java adapter 显示 Java 私有动作。

**失败/测试。** continued/stopped/terminated、active child 切换、AbortSignal、request reject 都释放 lock；失败写到请求所属 session 的结构化 Console entry，按钮恢复可重试。测试 Java/Node/Python/LLDB action matrix、callback missing、0/1/N step targets、双击 busy、request failure、compound child switch，以及 toolbar/Search/keymap/keyboard state/result 完全一致。负责人限 `debugActionService.ts`、`DebugToolbar.tsx`、`DebugPanel.tsx` action adapter、workspace action bridge和 D6 tests，不改 Console ring 或 Variables cache。

### 17.2 D7：Session-owned Console 与定向异步发布

**实现。** 将 `followTail/history/historyIndex/lastSeenSeq/clearGeneration` 从 `DebugConsolePane` local state 移入 session-keyed reducer/store。每个 output/evaluate request 捕获 `ConsoleRequestToken { sessionId, stopEpoch, frameId, requestId, clearGeneration }`；result 只允许 dispatch 到 token.sessionId，且 reducer 在所有字段匹配时 append。active session 切换、continue/new stop、frame change、restart、所有 terminate 路径和 clear 按语义递增对应 epoch/generation；stale/cancelled 不返回空字符串，pane 只渲染 `applied` result。

ring 同时限制 10,000 entries 和 2 MiB UTF-8 预算，截断时插入单一 marker；多行/ANSI normalization 在进入 ring 前完成。badge 按 active session 的 `seq > lastSeenSeq` 计算，只有 Console 可见且距底 <=24px 才推进 seen。follow-tail、Scroll to end、每 session 100 条 history、Up/Down/Esc draft 在 session 切换后恢复自己的状态，不默认写 localStorage。

**测试/门禁。** 覆盖 A->B->A、同线程连续 stop、frame switch、clear 后 late result、indirect terminate、restart、hidden/visible、离底滚动、10k/2MiB、ANSI/多行、history draft 和持续输出 paint profile。负责人限 `dapDebugModel.ts` console reducer、`useCodeDebugSession.ts` output/evaluate 区、`DebugConsolePane.tsx` 和 D7 tests/QA case，不改 stack/variables semantics。

### 17.3 D8：真实 stop epoch、Variables request state 与稳定 Watch

**实现。** 在 DAP `stopped` event reducer 中为 session 单调递增 `stopEpoch`，不要从 threadId/frameId 推导。统一 token 为 `(sessionId, stopEpoch, threadId?, frameId?, variablesReference?, requestId)`；scopes、variables children、watch evaluate、setVariable、dataBreakpointInfo 和 stack page 在 publish 前逐项匹配。每个节点维护 `idle|loading|ready|partial|failed`、requestId/error；同 token dedupe，collapse 会撤销 interest，迟到 response 只能进 cache，不能重新展开 UI。失败保留 retry，不再转换成 `[]`。

Watch 在 model 边界改为 `{id, expression, enabled, order, lastError}`，ID 持久化且所有 remove/edit/reorder/enable API 只接受 ID。value diff key 至少包含 session/stop/frame/stable variable path；无法证明跨 stop identity 时显示 local comparison，不跨 session/frame 高亮。hidden pane 的 `visible=false` 必须在 hook 前阻断 scopes/variables/watch effect，而不是只隐藏 DOM。

**测试/门禁。** 覆盖同一 thread 连续 stop、collapse-before-response、frame/session switch、重复 variablesReference、error-vs-empty/retry、20 threads x 200 frames、Watch filter/sort 后删除、reload 后 stable ID、reorder/disable/per-item error 和 hidden pane zero-request。负责人限 stop snapshot/types、`useDebugVariables.tsx`、Frames/Variables/Watch components 和 D8 tests；与 D7 共享 epoch 类型但不改 Console UI state。

### 17.4 D9：实例级焦点、Workspace layout 与隐藏 pane

**实现。** `DebugSubTabBar` 持有本实例 button refs，Arrow/Home/End 只遍历该 ref collection，删除 `document.querySelector`。把 global split keys 迁移到 `{schemaVersion:2, workspaceId, windowId, horizontal, vertical, compactPane}` preference，合法 v1 比例只迁移一次，坏数据回默认并记录 diagnostic；提供 `debug.resetLayout` action。separator 暴露 label/orientation/value/min/max 和键盘调整，toolbar 使用 roving focus/visible focus ring；tab/tabpanel ids 在同页面多个 Debug 实例间唯一。

所有 hidden subtab/pane 向 data hook 传 `visible=false` 并由 request spy 证明零 scopes/variables/evaluate。空态、tooltip、disabled reason、错误和按钮进入 i18n；验证 320/480/640/1024px、100%/200% zoom、长中英文、reduced motion、IME 和非美式键盘。负责人限 Debug layout/tab/ARIA/preference/i18n 与 D9 tests，不改 DAP request token。

### 17.5 D10：Fake DAP、QA、真实 adapter 与 native 门禁

fake DAP 覆盖 `initialize -> launch -> initialized -> two-thread stack pages -> scopes/variables -> evaluate -> continue + stale response -> stopped same thread -> terminate`，并提供 action supported/unsupported/failure profiles。同步 `qa-ui-auto-tests/feature-list.md`、`references/testid-catalog.md` 和 YAML，至少包含 action busy/unsupported、Console unread/follow/history、multi-thread/load-more、Watch reorder/error、layout Reset、two-instance tab focus 和 hidden no-request。

真实 smoke 至少记录 Java、Node、Python、Delve、LLDB 的脱敏 capabilities、action request/event、source mapping、失败和 cleanup；adapter 不支持某动作时验收 UI 的准确 unavailable，而不是修改 capability fixture。性能门槛覆盖 10k/2 MiB Console、20x200 stack、持续 output 输入/滚动、hidden zero-request；Linux/macOS/Windows 原生包记录 F-key/system conflict、IME REPL、200% zoom、layout restore 和 compound session。mock、browser stub、jsdom 和协议单测不得替代真实 adapter/native 证据。

### 17.6 Ownership 与合并顺序

先由 D6/D7/D8 共同提交只含 `DebugRequestToken/stopEpoch/ActionResult` 的共享类型与 reducer fixture，再按 D6 action、D7 console、D8 stop data、D9 layout 分区开发；D10 随各包增量更新，不能最后补账。`useCodeDebugSession.ts` 的 owner 必须按 action/output/stop-snapshot 区域分提交，任何 agent 不重排其它区域。推荐合并顺序：`shared epoch contract -> D6 -> D7/D8/D9 -> D10 gate`。

## 18. v2.3 当前执行批次（面向其它 agent）

当前代码已存在内部 `record.stopEpoch`，因此本轮先完成 D8.1 的共享 snapshot/token，再让 D6.1 与 D7.1 消费；D9.1 可并行，D10.1 随包执行。不要在 `useCodeDebugSession.ts` 内再添加互不兼容的 generation ref。

### 18.1 D8.1：公开 StopSnapshot 与统一请求 Token

**共享类型。** 将 `stopEpoch` 放入公开 `DebugSessionState`，每次 `stopped` 由 record reducer更新 state；continue/terminate/restart 保留最后 epoch 但状态非 stopped，使旧 token自然失效。定义：

```ts
interface DebugRequestToken {
  sessionId: string;
  stopEpoch: number;
  threadId?: number;
  frameId?: number;
  variablesReference?: number;
  requestId: string;
}
type AsyncLoadState<T> =
  | { status: "idle" }
  | { status: "loading"; token: DebugRequestToken }
  | { status: "ready" | "partial"; token: DebugRequestToken; value: T }
  | { status: "failed"; token: DebugRequestToken; message: string; retryable: boolean };
```

`fetchScopes/fetchVariables/evaluate/stackTrace` 接受或内部捕获 token，response 必须定向发布到 token.sessionId，并验证 record live、stopEpoch、frame/reference/requestId。`useDebugVariables` 删除所有以 `stoppedThreadId` 命名为 epoch 的代码；scope/child/watch 使用 `AsyncLoadState`，失败不能变 `[]`。collapse 取消 UI interest，迟到 child 可缓存但不能重新展开。Watch model 升级为稳定持久化 `{id, expression, enabled, order, lastError}`，所有 mutation 只接受 ID；旧 string[] 一次迁移。

**测试/ownership。** D8.1 owner 负责 `dapDebugModel.ts` state/token、`useCodeDebugSession.ts` stop/variables/stack 区、`useDebugVariables.tsx`、Variables/Frames/Watch components 和 tests。覆盖同一 thread 连续两次 stop、A/B session、frame switch、collapse-before-response、error/retry、stable watch migration/reorder/disable。先提交共享类型/reducer，再提交 hook/UI；不得改 Console pane 或 Action service。

### 18.2 D6.1：Instance DebugActionService 接管所有入口

service 构造时注入 active-session snapshot provider 和 session-targeted error sink；每次 `run` 捕获 `DebugRequestToken` 的 session/stop 部分，生成 requestId并返回 `DebugActionResult`。Toolbar、DebugPanel restart、Frames/context menu、editor chrome、workspace ActionHost/Search/keymap 全部使用 descriptor state/run，删除直接 hook action。中央 busy map 以 `(sessionId, action family)` 为 key；continued/stopped/terminated、active child switch、Abort 和 reject 都释放锁，旧 result 不能更新新 child。

Hot Reload 只读取 adapter registry manifest 的明确 extension id；`supportsHotReload/supportsRedefineClasses` 等松散字段不能注册 Java 私有动作。Show Execution Point 无 callback 时给出 `callback-missing` disabled reason；Run to Cursor、Step Back、Restart Frame 分别按 capability/target/context gating。测试所有入口 state/result parity、双击、failure/retry、compound switch 和 Java/Node/Python/LLDB matrix。D6.1 owner 限 action service、Toolbar/Panel/editor action adapters、workspace bridge和 tests，不改 output/variables reducer。

### 18.3 D7.1：Session Console Store 与定向 Evaluate

建立 `consoleBySessionId`，每个 session 保存 entries/bytes/nextSeq/lastSeenSeq/clearGeneration/followTail/history/draft。output event 和 REPL evaluate 都捕获 `{sessionId, stopEpoch, frameId, requestId, clearGeneration}`；result dispatch 到捕获 session，reducer 全字段匹配才 append。stale/cancelled 用 typed outcome，绝不以空 value 表达；错误进入目标 session stderr。

ring 同时限制 10,000 entries 和 2 MiB UTF-8，截断 marker 只出现一次；badge 计算真正 unread，而不是 output length。只有 Console 可见且距底 <=24px 才推进 seen；A->B->A 恢复各自 follow/history/draft。clear 只 bump 目标 session clearGeneration，late response 不复活。测试持续 output、ANSI/多行、clear/frame/continue/new stop/terminate、A/B/A、history draft、hidden seen 和 paint/memory budget。D7.1 owner 限 console reducer、hook output/evaluate 区、Console pane和 QA case，不改 stack/variables。

### 18.4 D9.1：Workspace Debug Layout 与实例级可访问性

将 tab/panel ids 加 workspace/window instance prefix，`DebugSubTabBar` 用 button refs聚焦，删除 document-global query。split preference v2 key含 workspaceId/windowId，迁移合法 global v1一次，坏数据回默认并提供 Reset Debug Layout action。separator补 orientation/label/value/min/max 和 Arrow 调整；toolbar有 role/roving focus/visible focus ring。

所有不可见 subtab/pane 必须传 visible 到 data hook，并用 request spy证明 zero scopes/variables/evaluate；仅 CSS `hidden` 不算完成。文案进入 i18n，验证两个 Debug panel 同页面、320–1024px、200% zoom、长中英文、reduced motion、IME/非美式键盘。D9.1 owner 限 panel/subtab/layout preference/i18n/a11y tests，不改 DAP token。

### 18.5 D10.1：协议、QA 与真实运行门禁

fake DAP 首先验证同 thread re-stop 的 epoch：`stopped(thread=1,e1) -> variables pending -> continue -> stopped(thread=1,e2) -> e1 late response rejected`；再覆盖 compound A/B、action failure、Console clear late result、two-thread stack pages和 terminate cleanup。同步 feature list/testid catalog/YAML 的 action busy/unsupported、unread/follow/history、variables retry/watch reorder、layout Reset、two-instance focus、hidden zero-request。

真实 adapter smoke 至少 Java、Node、Python、Delve、LLDB，记录脱敏 capability、request/event/source/cleanup；三端 native 覆盖 F-key/system shortcut、IME REPL、200% zoom、workspace layout restore和长输出性能。Debug 定向 4 files/44 tests 与 build 绿只作为本轮起始基线，不能替代这些证据。

### 18.6 合并顺序与冲突控制

固定顺序为 `D8.1 shared token/state -> D6.1 action -> D7.1 console -> D9.1 layout -> D10.1 gate`；D9.1 可在 shared types 合并后并行。`useCodeDebugSession.ts` 分成 stop/data、action adapter、output/evaluate 三个 owner 区域；共享提交后各 agent不得重排其它区域。每个包必须保持 `pnpm build`、相应定向测试和 `git diff --check` 全绿，并在 PR 中标明尚缺的真实 adapter/native evidence。

## 19. v2.4 当前下一轮待办（面向其它 agent，`1b6f91cf` 前历史合同）

> 本节已被 §20 取代，保留用于追溯 `3aacbecc` 之后的执行合同；`1b6f91cf` 后的历史合同见 §20，当前合同见 §21。

本节取代 §18 作为 `3aacbecc` 之后的当前 Debug 执行合同。每个包必须标明 `model`/`wired`/`workflow`/`verified`，保留其它 owner 的变更；mock DAP、jsdom 和组件字段不能升级为真实 workflow。

### 19.1 D8.2：把 StopSnapshot/RequestToken 贯穿所有异步请求

以公开 `stopEpoch` 为唯一 stop generation；`consoleGeneration` 只负责 clear/session UI generation。为每次 scopes、variables children、evaluate、stack page、setVariable、watch evaluate 创建 `{sessionId, stopEpoch, threadId?, frameId?, variablesReference?, requestId, clearGeneration?}`，API 内部捕获或显式接收 token，response 只能发布到 token 所属 session reducer，并逐项验证 live、epoch、frame/reference、requestId 和 clear generation。

每个节点使用 `idle|loading|ready|partial|failed`，失败保留 error/retry，不转换为 `[]`/空 value；collapse 取消 UI interest，迟到 child 只能进入 cache，不能重新展开；同 token dedupe。Watch 一次迁移旧 string[] 到持久化 `{id, expression, enabled, order, lastError}`，所有 remove/edit/reorder/enable 只接受 ID，ID 不能由每次 mount 的 Date.now 重新生成。hidden pane 必须在 hook 前阻断请求，而不是只 CSS hidden。

**负责人/测试。** 限 `dapDebugModel.ts`、`useCodeDebugSession.ts` 的 stop/data/stack 区、`useDebugVariables.tsx`、Variables/Frames/Watch tests。覆盖同线程连续 stop、A/B session、frame switch、collapse-before-response、error/retry、watch migration/reorder/disable、hidden zero-request；不得改 Console reducer 或 Action service。

### 19.2 D6.2：Instance DebugActionService 接管全部入口

将 descriptor 改为 instance service：`run(signal)` 捕获 session/stop token、生成 requestId，通过 central in-flight map 返回 `applied|no-op|cancelled|failed`。Toolbar、Frames/context、DebugPanel restart、editor chrome、workspace ActionHost/Search/keymap 全部消费 descriptor state/run，删除直接 `debug.step/terminate/restart/hotReload`。busy key 至少包含 sessionId/action family；continued/stopped/terminated、active child switch、Abort 和 reject 必须释放 lock，旧结果不得更新新 child。

Hot Reload 只由 adapter manifest 明确 extension id 注册；通用 `supportsHotReload/supportsRedefineClasses` 不足以显示 Java 动作。Show Execution Point 缺 callback 时必须给 `callback-missing`；Run to Cursor、Step Back、Restart Frame 按 capability/target/context gating。测试 Java/Node/Python/LLDB matrix、双击 busy、failure/retry、compound switch 和 toolbar/Search/keymap parity。

**负责人/测试。** 限 `debugActionService.ts`、DebugToolbar/Panel/Frames action adapter、workspace bridge 和 D6 tests；不得改 Console/Variables request semantics。

### 19.3 D7.2：Session-owned Console 与定向 Evaluate

建立 `consoleBySessionId`，每个 session 保存 entries/UTF-8 bytes/nextSeq/lastSeenSeq/clearGeneration/followTail/history/draft。output 和 REPL evaluate 捕获 `{sessionId, stopEpoch, frameId, requestId, clearGeneration}`；全字段匹配才 append，stale/cancelled 返回 typed outcome，错误写入目标 session stderr。

同时限制 10,000 entries 和 2 MiB UTF-8；截断 marker 只出现一次，badge 计算 `seq > lastSeenSeq` 的真实 unread。只有 Console 可见且距底 <=24px 才推进 seen；A→B→A 恢复各 session follow/history/draft；clear 只 bump 目标 session generation，late result 不复活。测试 ANSI/多行、clear/frame/continue/new stop/terminate、A/B/A、history、hidden seen、持续 output paint/memory。

**负责人/测试。** 限 `dapDebugModel.ts` console reducer、`useCodeDebugSession.ts` output/evaluate 区、DebugConsolePane 和 D7 QA case；不得改 stack/variables semantics。

### 19.4 D9.2：Workspace Debug Layout 与实例级可访问性

tab/panel/test IDs 加 workspace/window instance prefix；`DebugSubTabBar` 持有本实例 button refs，Arrow/Home/End 只在 ref collection 中聚焦，删除 `document.querySelector`。split preference 迁移到 `{schemaVersion:2, workspaceId, windowId, horizontal, vertical, compactPane}`，提供 Reset action，坏数据回默认并记录 diagnostic。

separator 暴露 orientation/label/value/min/max 与键盘调整，toolbar 使用 roving focus/visible focus ring，tab/tabpanel ids 同页多 Debug 实例不冲突。不可见 subtab/pane 必须传 visible 到 data hook 并以 request spy 证明 scopes/variables/evaluate 为零；文案进入 i18n。验证 320/480/640/1024px、100%/200% zoom、长中英文、reduced motion、IME/非美式键盘和双实例 focus。

**负责人/测试。** 限 DebugPanel/DebugSubTabBar/layout preference/i18n/ARIA tests；不得修改 D8 token。

### 19.5 D10.2：Fake DAP、真实 adapter、QA 与 native gate

fake DAP 至少覆盖 `initialize -> launch -> initialized -> two-thread stack pages -> scopes/variables -> evaluate -> continue -> same-thread stopped(e2) -> e1 late response -> terminate`，并提供 supported/unsupported/failure profiles。同步 `feature-list.md`、testid catalog 和 YAML：action busy/unsupported、Console unread/follow/history、variables retry/watch reorder、layout Reset、two-instance focus、hidden no-request。

真实 smoke 至少 Java、Node、Python、Delve、LLDB，记录脱敏 capability、每个 action request/event、source mapping、失败和 cleanup；性能门槛覆盖 10k/2 MiB Console、20x200 stack、持续 output 输入/滚动、hidden zero-request；Linux/macOS/Windows 原生包覆盖 F-key/system shortcut、IME REPL、200% zoom、layout restore、长输出 CPU/内存和 compound session。Debug 46/46 定向测试与 build 绿只能作为起始基线，不能替代这些证据。

### 19.6 Ownership 与合并顺序

共享顺序固定为 `D8.2 token consumer -> D6.2 action -> D7.2 console -> D9.2 layout -> D10.2 evidence`；D9.2 可在 D8.2 的公开类型稳定后并行。`useCodeDebugSession.ts` 按 stop/data、action、output/evaluate 区域分 owner；任何 agent 不重排其它区域。每个 PR 保持 build、changed-file tests、`git diff --check` 全绿，并明确剩余真实 adapter/native/performance evidence。

---

## 20. v2.5 下一轮待办（`dab8a778` 前历史合同，当前见 §21）

本节是 `1b6f91cf` 后、`dab8a778` 前的执行合同，现保留用于追溯；当前执行合同见 §21。

| 顺序 | 子包 | 完成定义（验收要点） | 主要文件 owner |
|------|------|----------------------|----------------|
| P0 | D8.3 Token 贯穿与 Watch 结构化 | 所有 scopes/variables/evaluate/stack/setVariable 请求携带 `{sessionId,stopEpoch,frameId,variablesReference?,requestId}` 并定向发布；失败保留 error/retry 不折叠为空；Watch 持久化 `{id,expression,enabled,order,lastError}`、reload 不重造 ID、remove/edit/reorder 只按 ID；stack 分页 + per-thread cache；hidden pane 零请求 | `dapDebugModel.ts`、`useCodeDebugSession.ts` stop/data 区、`useDebugVariables.tsx` |
| P0 | D6.3 Instance ActionService | descriptor service 返回 typed `Promise<ActionResult>`（含 requestId/busy/cancelled）；Toolbar/Frames/Panel/keymap/Search 全部经 service 执行；Hot Reload 仅在 adapter extension manifest 声明 `java.redefineClasses` 时注册；失败写结构化 Console entry | `debugActionService.ts`、DebugToolbar/Frames/Panel、workspace bridge |
| P1 | D7.3 Session-owned Console | `consoleBySessionId` 持有 entries/bytes/nextSeq/lastSeen/clearGeneration/followTail/history/draft；10k entries + 2 MiB 双上限；unread badge = `seq > lastSeenSeq`；evaluate 全字段匹配才 append，stale/cancelled 返回 typed outcome；A→B→A 恢复 follow/history/draft | `dapDebugModel.ts` console 区、`useCodeDebugSession.ts` output 区、`DebugConsolePane.tsx` |
| P1 | D9.3 Workspace Layout 与 ARIA | `CodeWorkspaceTab` 传 `workspaceInstanceId`；panel/tab/test IDs 加实例前缀；split preference 迁移 `{schemaVersion:2,workspaceId,...}` + Reset；separator 补 orientation/label/value/min/max + 键盘调整；全部文案入 i18n；hidden pane 经 request spy 证明零 DAP | `DebugPanel.tsx`、`DebugSubTabBar.tsx`、layout preference、i18n locales |
| P2 | D11 IDEA 2026.2 delta（新增） | 见下方清单 | `DebugConsolePane.tsx`、gutter/breakpoint UI、QA |
| Gate | D10.3 Evidence | fake DAP 全事件链 + supported/unsupported profiles；真实 Java/Node/Python/Delve/LLDB 脱敏 trace；catalog/YAML；10k/2MiB Console、20x200 stack 性能；Linux/macOS/Windows native checklist | fake harness、QA、evidence only |

**D11 IDEA 2026.2 delta 清单（对照官方 What's New 的新增缺口）：**

- [ ] **Logpoint 运行期证据链**：DAP logpoint 由 adapter 经 `setBreakpoints.logMessage` 求值，客户端**不在 stop epoch 上自行 evaluate**（logpoint 通常不暂停程序，无 stop epoch/frame 可用）。验收：`logMessage` 原样传递；支持的 adapter 将插值结果以 `output` 事件写入来源 session 的 Console；不支持或未求值的 adapter 按其返回的字面输出显示，或显式展示能力限制提示。以 fake adapter + 至少一种真实 adapter trace 验收（模型与 gutter diamond 已存在，本项只补运行期证据）。
- [ ] **Console runtime output → source 导航**（2026.2 新增）：stdout/stderr/exception 文本中的 `path:line(:col)` 模式渲染为可点击链接，点击经统一导航入口打开位置；多 root/相对路径按 workspace 解析；长输出下链接化不得造成线性重渲染（与 D7.3 ring buffer 协同验收）。
- [ ] **Async stack traces**：声明为通用 DAP 非目标（无标准 capability）；仅当某 adapter 提供扩展时再立项，文档保留此决议防止重复评估。

**合并顺序。** `D8.3 -> D6.3` 先行（正确性），`D7.3` 与 `D9.3` 在 D8.3 公开类型稳定后并行；`D11` 各条目独立成 PR 且不修改 capability truth；`D10.3` 随包执行。`useCodeDebugSession.ts` 仍按 stop/data、action、output/evaluate 区域分 owner；任何 PR 红门禁（`tsc -b`/changed-file tests/`git diff --check`）不得进入下一包。

---

## 21. v2.6 当前下一轮待办（面向其它 agent，`dab8a778` code review 后）

本节取代 §20。按用户可见错误与跨 session 数据正确性排序；每包必须证明真实 consumer，不能只扩充 service/model tests。

| 顺序 | 子包 | 完成定义（验收要点） | 主要 owner |
|------|------|----------------------|------------|
| P0 hotfix | D11.1 Source link 坐标与多 root | 统一坐标 contract：renderer/callback 全程传 1-based line **与 column**，仅 CodeMirror reveal 边界转换为 zero-based line/character 一次；绝对、file URI、Windows drive/UNC 先 canonical match，relative path 在所有 roots 中查找：唯一命中直接打开、多命中弹 disambiguation picker、零命中返回 typed no-op。CodeWorkspace host test 断言 `App.java:42` 与 `src/App.java:42:7` 的最终 line/character，并覆盖双 root ambiguity 与 Windows path | Console renderer、CodeWorkspace open-location adapter、path resolver |
| P1 | D11.2 Logpoint 运行期证据 | `setBreakpoints.logMessage` 原样发给 adapter，客户端不得在 stop epoch 自行 evaluate；支持 adapter 的插值结果必须通过 `output` event 进入来源 session Console；不支持/未求值 adapter 显示其字面 output 或明确 capability limitation。fake adapter 覆盖 pass-through、origin session 与 unsupported profile，并提供至少一种真实 adapter 脱敏 trace | breakpoint/DAP adapter bridge、Console reducer、fake/real adapter evidence |
| P0 | D8.4 Token API 与 Watch 真迁移 | scopes/variables/evaluate/stack/setVariable API 强制接收完整 request token；response 仅在 session/stop/frame/reference/requestId 全匹配时 reducer publish；switch/continue/terminate/collapse 取消 interest；stack paging + per-thread cache；旧 string[] 一次迁移成稳定 ID records 并按 ID edit/remove/reorder/enable | DAP model、debug hook stop/data 区、Variables/Watch |
| P0 | D6.4 Instance ActionService 生产接线 | Toolbar/Frames/Panel/workspace keymap/Search 全部经同一 instance service；descriptor/adapter 返回 typed result 而非 resolved=success；AbortSignal 绑定 DAP request；failed/cancelled 写来源 session structured Console entry；Hot Reload 仅 adapter extension manifest 注册；双 session busy/cancel/failure workflow tests | action service、debug controls、workspace bridge |
| P1 | D7.4 Session Console 单一 owner | entries/bytes/nextSeq/lastSeen/clearGeneration/follow/history/draft 全进 `consoleBySessionId`；删除 hook 2k 与 pane-local 双真值；10k + 2 MiB 双预算、一次 truncation marker、真实 unread badge；clear/frame/continue/new-stop/terminate 丢弃迟到 evaluate；A→B→A 恢复状态 | DAP console reducer、debug hook output/evaluate 区、Console/Panel |
| P1 | D9.4 Workspace layout/ARIA/i18n | split keys、PanelGroup IDs、tab/panel/test IDs 均 namespace by workspace/window；schema v2 migration + Reset；separator 支持 orientation/value/min/max 与键盘；用户文案进 i18n；双 Debug instance focus/storage 与 200% zoom tests | DebugPanel/Variables layout、SubTabBar、locales |
| Gate | D10.4 恢复并扩展证据链 | 先把 feature catalog/YAML selector 与生产 `debug-panel` 对齐；fake DAP 覆盖 stale/failure/cancel/cleanup 与 supported/unsupported profiles；真实 Java/Node/Python/Delve/LLDB trace；10k/2MiB、20x200 性能和三端 native checklist | QA catalog/YAML、fake harness、evidence |

**合并顺序。** `D11.1 hotfix -> D8.4 -> D6.4`；D7.4/D9.4 在 D8 token contract 稳定后并行；D10.4 先修 selector，再随每包补 evidence。任何 PR 必须通过 `tsc -b`、changed-file tests、`git diff --check`，并列明仍缺的 real-adapter/native 证据。
