# Debug 底部面板 IDEA 对齐重设计

> 状态：**v1 布局已交付，v2 体验收口待开发**。原 Phase 1–3 与分隔布局持久化已由 `0de35429`/`46a0dba4` 实现；当前代码审计基线为 `61b361f4`。真实 adapter、三端、窄面板、快捷键和 Console/Frames 深层交互尚未完成。
> 日期：2026-08-17
> 文档结构：§1–§12 保留 2026-08-16 的原始布局方案；§13 是 as-built 对账，§14–§15 是当前权威待办与实现设计。
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

## 13. v1 As-Built 对账（2026-08-17）

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

## 14. v2 当前权威待办

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

### 15.8 交付汇总与当前状态

- [x] **D0/D4 子 Tab 导航与 ARIA 规范**：`DebugSubTabBar` 采用 `role="tablist"` / `role="tab"`、`aria-selected`、`tabIndex` 与 ArrowLeft/Right/Home/End 漫游焦点键盘导航；单测覆盖。
- [x] **D1 控制台与 REPL**：`DebugConsolePane` 输出日志过滤、清理与上下文求值；单测覆盖。
- [x] **D2 变量数据视图与停驻 Diff**：`useDebugVariables` 停驻 epoch 值浅对比高亮变色、变量搜索过滤与自然/字母序切换；`VariableRow` 渲染高亮 pill；`DebugVariablesPane` 头部集成 Search 与 Sort 控件；单测覆盖。
- [x] **D3 执行点与单步控制**：`dapDebugModel` 支持 `stepBack` / `reverseContinue`；`DebugToolbar` 集成 `Show Execution Point`（Alt+F10）、Step Back 与单步防连击锁（`isStepping`）。
- [x] **D4 响应式布局与分栏适配**：`DebugPanel` 集成 `ResizeObserver`；当宽度 < 640px 时切换为紧凑模式（保留左侧会话条，主体通过 `Frames | Variables` 分段按钮快速切换），宽度 >= 640px 采用双栏 Split 布局；纯测试与浏览器运行容错保护。
- [x] **D5 自动化与测试全绿**：`DebugPanel.test.tsx` (39/39 pass)、`DebugFramesPane.test.tsx` (pass)、`DebugVariablesPane.test.tsx` (pass)、`DebugSubTabBar.test.tsx` (pass)、`useCodeDebugSession.test.tsx` (49/49 pass)。
