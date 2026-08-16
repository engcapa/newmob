# Debug 底部面板 IDEA 对齐重设计

> 状态：设计评审中
> 日期：2026-08-16
> 范围：`src/components/editor/workspace/panels/DebugPanel.tsx` 及其子组件的 UI 重组；不涉及 DAP 协议层（`dapDebugModel.ts` / `useCodeDebugSession.ts` 的数据模型保持不变）

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

> 行数为估算，实际以提取后为准。总代码量不变，只是组织方式改变。

### 3.2 组件职责与接口

#### 3.2.1 `DebugPanel.tsx`（入口）

```tsx
export function DebugPanel(props: DebugPanelProps) {
  // 从 store 读取 debugSubTab
  // 渲染 DebugSubTabBar + 对应子面板
  // 保留 DebugPanelProps 接口不变（对 CodeWorkspaceTab 透明）
}
```

props 接口**保持完全不变**，`CodeWorkspaceTab.tsx` 无需修改。

#### 3.2.2 `DebugSubTabBar.tsx`

```tsx
interface DebugSubTabBarProps {
  activeTab: DebugSubTabId;
  onTabChange: (tab: DebugSubTabId) => void;
  /** 各 tab 的 badge，如 Console 有新输出时的未读计数 */
  badges?: Partial<Record<DebugSubTabId, number>>;
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

### Phase 1：组件拆分（不改变 UI）

1. 将 `DebugPanel.tsx` 中的内部组件提取到 `debug/` 目录
2. 提取共享类型到 `debugPanelShared.ts`
3. 提取变量逻辑到 `useDebugVariables.ts`
4. 确认所有现有测试通过

**产出**：代码结构改善，UI 不变。

### Phase 2：子 tab 框架

1. 新增 `DebugSubTabBar` 组件
2. 新增 `debugSubTab` 到 `codeWorkspaceStore`
3. `DebugPanel` 入口改为子 tab 路由
4. 将现有内容映射到对应子 tab：
   - Debugger → 现有全部内容（暂时保持单列）
   - Console → 提取 Console 段
   - Breakpoints → 提取 Breakpoints 段
   - Memory → 提取 Memory/Disassembly 段

**产出**：子 tab 框架就位，Debugger 暂时保持旧布局。

### Phase 3：双栏布局

1. `DebugFramesPane` — Threads & Frames 合并树
2. `DebugVariablesPane` — Variables + Watches
3. `DebugToolbar` — 竖排 + 横排控制
4. `DebugPanel` 的 Debugger 子 tab 改为双栏布局

**产出**：完整 IDEA 风格布局。

### Phase 4（可选）：快捷键 + 打磨

1. 注册调试快捷键
2. 左栏宽度持久化
3. Console 未读 badge
4. 动画过渡

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
| 左栏内容 | Threads + Frames + Breakpoints + Sessions | 用户确认全选 |
| 子 tab 划分 | Debugger / Console / Breakpoints / Memory | 用户确认全选 |
| 控制按钮位置 | IDEA 风格（竖排会话控制 + 横排 Step） | 用户确认 |
| 断点位置 | 独立子 tab + 左栏断点列表 | 独立 tab 集中管理，左栏快速查看 |
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
