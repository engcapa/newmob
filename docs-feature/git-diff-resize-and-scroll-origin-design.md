# Git Panel Diff 分割拖动与行首定位设计

## 1. 交付范围与结论

- 类型：现有能力扩展，包含与布局相关的滚动定位完善。
- 状态：**已实现并通过自动化验证及 Windows native smoke（TASK-01、TASK-02、TASK-03 全部完成）；完整三端真机矩阵和 V-04 人工几何交互仍未完成，见 §8.1。**
- 来源：2026-09-05 用户提供的 Git → Log 截图。中间红框标出左右 diff 的分界区域，底部箭头标出横向滚动位置；用户要求分界可拖动，左右默认从行第一列显示。
- 基线：`d690a95a4907b323969b68b04b18bccd73d0da0c`，`package.json` 版本 `0.4.22`；调研开始时 `git status --short` 无输出。`docs-feature/`、`docs-issue/` 当时为空，无同名设计。
- 平台：Windows、macOS、Linux 三端 Tauri 桌面应用。当前运行端为 Windows；浏览器仅用于辅助验证。

用户打开长行 diff 时，两侧正文均从行首开始；鼠标拖动中间连接带即可调整左右宽度，差异连接图形随之更新。手动横向浏览内容后，普通调宽不把内容拉回行首。

本次的“滚动条放到最左边”指**两侧底部横向滚动条的滑块归零，即各自 `scrollLeft = 0`**。垂直滚动条继续位于各自编辑器右边缘；不通过移动垂直滚动条或开启自动折行实现此需求。

覆盖所有复用 `DiffViewer` 的文本入口：单仓库 Log、Changes、Compare，以及工作区聚合 Git 的 Log、Changes。图片、二进制、超大文件提示保持现有分支。Stash 使用另一种 patch 预览，不属于这次左右 diff 的改动范围。外层“提交列表 / 详情”和“文件列表 / diff”分割不调整。

## 2. 现状、证据与问题判断

下列路径均相对工程根目录，行号以调研基线为准。

| 位置 / 符号 | 已核实事实 | 设计影响 |
|---|---|---|
| `src/components/git/CommitLog.tsx:153,327` | 调用 `gitBlobPair(repoRoot, path, parent, commit, oldPath)`，结果交给 `DiffViewer`；请求有取消标志 | 截图入口，通过共享组件生效 |
| `src/components/git/WorkspaceCommitLog.tsx:189,351`、`CompareView.tsx:81,135` | 聚合 Log、引用比较复用同一个 `DiffViewer` | 一并回归，不复制布局实现 |
| `src/components/git/shared/DiffPane.tsx:56` | Changes 包装层转交 `pair`、`pairLoading`、可编辑右侧和保存回调 | 调宽不能重建编辑器或丢失右侧修改 |
| `src/components/git/DiffViewer.tsx:144,421`，样式及 `applySplitDiffLayout` | CSS 和运行时样式均设置 wrapper 为 `flex: 1 1 0`、`width: 0`，强制均分宽度 | 两处必须共同改为受比例控制，不能只加鼠标事件 |
| `DiffViewer.tsx:40,265,477`，`CONNECTOR_WIDTH`、`setupSplitDiffInteractions` | 中间是 36px 连接带，内部 SVG 绘制 chunk 连接曲线；整个带有 `pointer-events: none` | 保留连接可视化，连接带本身成为分割控件 |
| `DiffViewer.tsx:540`，`handleScroll` | 同步滚动仅写目标 `scrollTop`，不写 `scrollLeft`；有滚动监听、ResizeObserver、rAF、80ms 延迟重绘和清理 | 横向仍各自滚动，复用纵向同步和连接带重绘 |
| `DiffViewer.tsx:573`，`scrollChunkIntoView` | 选择位置是 chunk 起点，滚动目标却是 `end - 1`，参数 `{ y: "center", x: "nearest" }` | 长行导航存在把行尾横向滚入视口的明确路径 |
| `DiffViewer.tsx:675`，`BUILD_EFFECT` | `pair`、模式、空白过滤、词高亮等变更销毁并重建编辑器；未显式归零横向滚动；`loading` 未列入依赖，但加载分支会移除 host | 明确每次构建的初始化规则，并纳入 loading 生命周期 |
| `src/lib/git.ts:38,181`、`src-tauri/src/git.rs:148,268` | `GitBlobPair` 提供文本、大小、存在性及媒体标志，无布局状态 | 本次无需变更 IPC、Rust 或存储格式 |
| `src/components/git/GitPanel.tsx:33`、`CommitLog.tsx:296` | 外层使用 `react-resizable-panels`；内层编辑器 DOM 由 CodeMirror `MergeView` 创建 | 复用当前内层 DOM 所有权，不为此次调宽重做 MergeView 容器 |
| `src/components/git/DiffViewer.eol.test.tsx` | 已有 EOL 提示与真实 CodeMirror 编辑后保存的组件测试 | 保留并加入聚焦回归 |
| `src/stubs/tauri-core.ts`、`vite.config.ts` | browser stub 有 `git_blame_lines`，没有 `git_blob_pair` / 完整 Git Panel 数据链；Vite bridge 只列 SSH、SFTP、RDP | 不能把 `pnpm dev` 的 Git 页面当作现成可跑的真实 Git 验收环境 |
| `qa-ui-auto-tests/feature-list.md`、cases、testid catalog | 未检出 GitPanel / DiffViewer 对应功能登记和 diff 专用 YAML；拟用 `F26.1`、`TC-GIT-DIFF-01` 尚未占用 | 在实现阶段登记本次功能及用例，不提前声明已完成 |

**观测与推断分开记录：**用户截图证明当时长行内容显示在中段，无法证明此前是否点击过差异导航或拖动过滚动条。源码确认导航使用长行末尾作为滚动目标，是可以解释该现象的路径；本轮未启动应用复现，不能将它记为“首次打开偏移的唯一已证实根因”。实现前用第 7 节夹具分别记录首次打开与点击 Next 的结果。

CodeMirror 的 `scrollIntoView` 支持横纵方向策略；本地 `node_modules/@codemirror/view/dist/index.d.ts:1130` 已核对，`x: "nearest"` 仍会横向调整，不能视为禁用横向滚动。接口说明亦见 [CodeMirror 官方源码](https://github.com/codemirror/view/blob/main/src/editorview.ts)。实施以仓库锁定版本及本地类型为准，无需升级依赖。

## 3. 验收条件

| ID | 前置条件与动作 | 可观察结果 | 验证 |
|---|---|---|---|
| AC-01 | Split 文本 diff，中间带向左右拖动、释放，再双击 | 左右宽度连续反向变化，总宽度不溢出；连接曲线保持对齐；释放后停止，双击恢复 50:50 | V-01、V-03、V-04 |
| AC-02 | 向极限拖动；将 diff 内容区缩窄至 320px 以下后再放大；键盘操作分割控件 | 按 §4.1 限制最小宽度；两侧不消失；无新增整页横向滚动；可通过键盘调宽与恢复 | V-01、V-03、V-04 |
| AC-03 | 拖动中按 Escape、失焦、pointercancel，或切到 Unified / 其他文件 / 关闭标签 | Escape 和取消恢复拖动前比例；不再跟随指针；无残留光标、选择禁用或旧实例回调；下次拖动正常 | V-01、V-04 |
| AC-04 | 首次打开长行、切换文件/提交、相同路径同长度但内容不同、刷新重新加载、Split↔Unified | 当前新建文本视图所有横向滚动容器在稳定布局后 `abs(scrollLeft) <= 1` CSS px，正文行首可见；不继承上一文件横向位置 | V-02、V-03、V-04 |
| AC-05 | 长行、多行变更、纯新增/删除和 EOF 边界，点击 Next / Previous | 保持现有循环导航顺序；定位目标块首个有效行的行首并尽量纵向居中；Split 两侧横向均归零，不再跳到长行尾部 | V-02、V-03、V-04 |
| AC-06 | 手动将左右分别横向滚动，再纵向滚动、开关同步、调宽或改变窗口尺寸 | 未发生明确内容重建/导航时，不主动归零；两侧横向位置独立；调宽仅允许浏览器按新可滚范围夹紧；纵向同步开关仍有效 | V-01、V-02、V-04 |
| AC-07 | Changes 的右侧可编辑，修改后拖动/双击/键盘调宽，再保存 | 文本、选区、dirty 状态与保存值保留；单纯调宽不触发 Git 读写或文档事务；历史左侧仍只读 | V-01、V-04 |
| AC-08 | 多个 DiffViewer 实例；loading、空内容、图片、二进制、超大文件及加载竞态 | 比例不串实例；非文本分支无可操作分割控件；loading 完成能正确创建 host；过期语言加载或测量不修改新视图 | V-02、V-04 |

上表 1px 是布局与浮点滚动测量容差，不是性能指标。拖动性能验收检查是否重建编辑器、重新取 blob、出现持续抖动或观察器循环；没有测量基线，本设计不虚构 FPS 或耗时通过值。

## 4. 交互与实现契约

### 4.1 分割比例与最小宽度

在现有 36px 连接带上启用 Pointer Events 和 `cursor: col-resize`，整条带作为命中区。SVG 保留 `aria-hidden="true"`、`pointer-events: none`，不遮挡交互。使用 `box-sizing: border-box`，36px 包含现有边框；hover / focus-visible 显示主题强调色细线，不新增常驻工具栏按钮。

定义 `W` 为 `.cm-mergeViewEditors` 的可用内宽，`C = 36`，`A = max(0, W - C)` 为两侧正文面板总宽。

- 初始偏好比例 `preferredRatio = 0.5`；左宽为 `A × effectiveRatio`，右宽为剩余宽度。
- 当 `A >= 320` 时，两侧最小宽度各 160 CSS px；有效比例夹在 `[160/A, 1-160/A]`。
- 当 `0 < A < 320` 时临时等分可用宽，分割控件标为 `aria-disabled="true"`，忽略调宽输入。恢复宽度后恢复之前的偏好比例；不强制切换 Unified。
- host 隐藏、宽度为零或仅剩连接带时暂停测量与交互，不用零宽覆盖偏好；再次可见时重测。
- 160px 是本设计选择的可读宽度下限，包含行号区；不是 CodeMirror 限制。两侧长行继续通过各自横向滚动查看。

CSS 与 `applySplitDiffLayout` 共同去掉固定均分约束；用明确的像素 `flex-basis` / 宽度表达测量结果，两个 wrapper 均 `flex-grow: 0; flex-shrink: 0; min-width: 0`。右侧用 `A - leftWidth` 避免独立舍入引入溢出。禁止留下运行时 `width: 0 !important` 覆盖新布局。

**状态范围：**`preferredRatioRef` 属于每个已挂载的 `DiffViewer`，切换文件、过滤项及 Split→Unified→Split 时保留。卸载或重启后默认 50:50。没有新 localStorage、Zustand、后端配置字段，也不增加跨标签或跨窗口同步。窗口暂时过窄导致的 effectiveRatio 夹紧，不反写 preferredRatio。

### 4.2 鼠标、键盘和中断

分割控件使用 `role="separator"`、`aria-orientation="vertical"`、`tabIndex=0`、`aria-label="Resize diff panes"`。通过实例唯一 ID 的 `aria-controls` 指向左右 wrapper，ARIA 数值表示当前左侧占可用正文宽度的百分比。设定动态 `aria-valuemin/max/now`，禁用时 min/max/now 均为 50。

| 操作 | 结果 |
|---|---|
| 主指针主键按下 | focus 分割控件，记录 pointerId、起始 clientX、起始有效左宽、拖动前偏好；调用 `setPointerCapture`，阻止正文选区与外层分割拖动 |
| 指针移动 | 用 CSS px 的 clientX 差值更新比例；不乘设备像素比；只处理当前 pointerId |
| pointerup | 提交最后位置到实例偏好，释放 capture、恢复临时样式并结束拖动 |
| Escape / pointercancel / window blur / 意外 lostpointercapture | 恢复拖动前偏好并清理；正常 pointerup 之后的 lostpointercapture 是幂等空操作 |
| 双击 / Enter | 恢复 50:50 |
| ArrowLeft / ArrowRight | 左侧比例减少 / 增加 2 个百分点；Shift 时为 10 个百分点；按当前最小宽度夹紧 |
| Home / End | 当前可用宽度下的最小 / 最大左侧比例 |
| Tab / Shift+Tab | 正常移出分割控件，不截获 |
| 拖动中窗口或外层面板尺寸改变 | 结束并取消当前拖动，按新宽度重新计算；避免沿用旧坐标跳变 |

拖动期间只在必要范围禁用文本选择；若设置 document 级 `cursor` / `user-select`，必须保存旧值并原样恢复。退出、异常、模式切换和组件卸载共用幂等 cleanup。优先使用 Pointer Capture；无法取得 capture 时使用 window pointermove/up/cancel 兜底，不能依赖指针始终留在连接带中。

### 4.3 默认行首与用户滚动

| 触发 | 横向规则 | 纵向规则 |
|---|---|---|
| 新建文本视图：首次加载、新 pair、刷新完成、模式或过滤引起重建、Render anyway | 新实例每一侧归零一次 | 沿用新建视图的顶部初值；不新增自动跳到第一差异 |
| Next / Previous | Split 两侧归零；Unified 当前侧归零 | 目标块首个有效行尽量居中；接近首尾按实际范围夹紧 |
| 手动横向滚动、文本选择/编辑 | 用户控制，不阻止 CodeMirror 为真实光标编辑滚动 | 沿用现有编辑器行为 |
| 拖动、双击或键盘调宽，窗口/外层面板 resize | 保留原 `scrollLeft`，超出新 max 时允许夹紧 | 尽量保留 `scrollTop`，仅允许合法范围夹紧 |
| 同步滚动开关和普通滚动 | 不复制或重置左右 `scrollLeft` | 保留现有比例映射；只有源 `scrollTop` 实际变化才同步 |

具体落点：

1. 修改 `scrollChunkIntoView`：将 `chunk.fromA/fromB` 夹紧到 `[0, doc.length]` 后，用 `view.state.doc.lineAt(pos).from` 得到合法行首。选择 anchor 及 `scrollIntoView` 目标一致；使用 `{ y: "center", x: "start", xMargin: 0 }`，不再使用 `end - 1`。空文档用 0，空侧纯新增/删除用最近有效行首。
2. 明确归零针对 `view.scrollDOM`，不能设置 host 或 `.cm-content` 的 scrollLeft 代替。CodeMirror 行号 gutter 仍固定，正文缩进原样显示。
3. 每次构建完成后，在布局测量阶段归零一次；导航时在 CodeMirror 完成滚动效果后确认归零。通过 `requestMeasure` 的读/写阶段调度，至多一次后续 rAF 确认；隐藏 host 延后到首次有效布局，不用固定 sleep 或无界重试。
4. 所有异步初始化/导航校正带实例 generation 与有效标志；cleanup 后空操作。用户在待执行校正前开始手动滚动、选择或编辑时取消该校正，防止晚到回调抢走阅读位置。不得在每次 scroll、ResizeObserver、connector 重绘或 updateListener 中无条件归零。
5. `goToChunk` 保持循环 index 及右侧 focus 策略；使用 CodeMirror `focus()`，不额外调用 DOM `scrollIntoView()`。初始加载不抢焦点。
6. 新 pair 的初始化依据是实际构建生命周期，不以现有 `pairKey` 的路径/长度组合判定内容是否相同；该 key 无法区分同路径等长内容。比例也不能加入 `BUILD_EFFECT` 依赖。

### 4.4 资源、加载与 DOM 所有权

推荐保持 `DiffViewer.tsx` 为内层布局与滚动的唯一 owner，直接扩展既有 helper，避免引入新的布局库或拆出第二套状态系统。

拟调整私有契约如下，不对调用者增加 props：

```ts
interface SplitInteractionOptions {
  isSyncEnabled: () => boolean;
  readPreferredRatio: () => number;
  commitPreferredRatio: (ratio: number) => void;
  leftPaneId: string;
  rightPaneId: string;
}

// 拟调整：布局、拖动、滚动同步与连接带共用同一生命周期。
function setupSplitDiffInteractions(
  mv: MergeView,
  options: SplitInteractionOptions,
): () => void;
```

- `applySplitDiffLayout` 接收当前比例或计算后的左右宽度；`setupSplitDiffInteractions` 持有临时拖动状态、观察器、监听与调度句柄。
- pointermove 最多排队一帧布局更新。先读容器尺寸，再写左右宽度，调用两侧 `requestMeasure()`，在测量更新后重绘连接图形。复用连接带重绘队列；无尺寸变化时不重复写样式，避免 ResizeObserver 循环。
- 不在 pointermove 中调用 React `setState`、销毁/新建 MergeView、重新 diff、调用 gitBlobPair 或提交文档事务。最终比例写 ref，ARIA 数值与实际几何同帧更新。
- cleanup 顺序为：标记交互失效 → 取消拖动/恢复临时样式 → 解绑监听、disconnect observer、取消 rAF/timeout → 移除 connector → 原有 teardown 销毁编辑器。保留语言异步加载的 cancelled 防护。
- `BUILD_EFFECT` 增加 `loading` 依赖，`loading || !host || !renderable || !pair` 时不创建视图；loading 完成后获取新 host 再创建。显式覆盖“旧 pair 引用未变，但 host 因 loading 被移除”的刷新恢复路径。
- Split 的横向归零覆盖 a、b，Unified 覆盖自身；图片等分支不创建 separator。布局结构检查失败时不抛出影响整个 Git Panel 的异常，保留可读 diff；此时调宽验收仍算失败，需要修正，不能当作正常完成。
- 本次不解决切换 diff 模式时已有未保存内容的整体策略；要求本次新增的调宽交互本身不触发重建或数据丢失。

## 5. 实施任务与文件职责

本轮 TASK-01、TASK-02、TASK-03 均已完成。任务拆分不授权创建多个 agent 或修改任何 backlog；验证时保留工作树中其他人的修改。

| 任务 | 文件职责与实施内容 | 依赖与完成条件 |
|---|---|---|
| TASK-01 分割交互 | 修改 `src/components/git/DiffViewer.tsx` 的 CSS、`applySplitDiffLayout`、`setupSplitDiffInteractions`；新增实例比例 ref、唯一 ID、testid、ARIA、pointer/keyboard/cleanup；新增 `src/components/git/DiffViewer.viewport.test.tsx` 中布局交互测试 | 可立即开始；读 §2–4；完成 AC-01/02/03/06/07 与 V-01，代码不得因 resize 重建编辑器 |
| TASK-02 行首与生命周期 | 同一 `DiffViewer.tsx` 修改 `scrollChunkIntoView`、`BUILD_EFFECT`、一次性归零调度；在同一新测试文件补内容切换/导航/取消回调测试 | 在 TASK-01 合入后修改共享文件，复用其 cleanup；完成 AC-04/05/06/08 与 V-02 |
| TASK-03 验证与交接 | 新增 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/git_diff_repo.py`，在同目录 `__init__.py` 注册；新增 `qa-ui-auto-tests/cases/TC-GIT-DIFF-01-split-navigation-native.testcase.yaml`；补 `GitPanel.tsx`、`WorkspaceGitManager.tsx`、`CommitLog.tsx`、`WorkspaceCommitLog.tsx` 的必要入口 testid；维护 feature-list、生成 testid catalog；负责 V-03/04/05 与本文证据回填 | 依赖 TASK-01/02 的交互契约；测试夹具可先准备；负责所有入口集成回归、当前 Windows 真机和三端兼容审查 |

`DiffViewer.tsx` 与新组件测试由 TASK-01→TASK-02 顺序修改。TASK-03 只登记已经实现的功能；不把全体 Git 能力补录当作本次前置项目。Rust、IPC、生产 browser stub、package.json 和锁文件无计划变更。

## 6. 自动化与目录对接

### 6.1 组件行为验证

| V ID | 文件与输入 | 必须断言 | 证明边界 / 状态 |
|---|---|---|---|
| V-01 | `src/components/git/DiffViewer.viewport.test.tsx`；真实 CodeMirror + 可控元素尺寸/ResizeObserver；主键拖动、越界、双击、键盘、取消、两实例 | 左右比例与最小宽度规则；事件结束后不跟随；两个实例不串比例；编辑右侧文字后调宽仍可保存同一文本，EditorView 实例与选区保留；同步开关不复制横向值 | 12/12 组件测试通过；jsdom 不证明真实像素布局、原生 pointer capture，真实几何仍由 V-04 覆盖 |
| V-02 | 同一新文件；长行、多个 chunk、空侧、同路径等长不同内容、loading=true→false 且 pair 引用不变、延迟语言加载后卸载 | 每次合法新建横向归零；Next/Previous 到正确行首且循环；EOF 不越界；手动横向滚动后无晚到校正；旧异步不更改新 DOM；非文本无 separator | 组件行为及异步边界测试通过；像素与真实滚动由 Windows native smoke 部分证明，完整 V-04 未完成 |
| V-05 | 现有 EOL、GitPanel、WorkspaceGitManager、WorkspaceCommitLog、diffWhitespace 测试与 frontend build | 相关保存/EOL/入口回归通过；TypeScript 无新增错误；没有平台条件依赖变化 | 6 个 Git 测试文件共 55/55 通过，`pnpm build` 通过 |

实现后在仓库根目录执行，PowerShell / Bash 均可：

```text
pnpm test src/components/git/DiffViewer.viewport.test.tsx src/components/git/DiffViewer.eol.test.tsx src/components/git/GitPanel.test.tsx src/components/git/WorkspaceGitManager.test.tsx src/components/git/WorkspaceCommitLog.test.tsx src/lib/diffWhitespace.test.ts
pnpm build
git diff --check
```

测试路径已经创建。测试使用真实 CodeMirror 验证可观察行为，允许模拟 jsdom 缺失的尺寸与指针设施，但不能用“handler 被调用”替代拖动后状态和保存结果断言。

### 6.2 V-03：原生控件 smoke 映射

功能 `F26.1`：Git 文本 diff 调宽与行首导航，`area: git/diff`。功能目录只记录实际落地路径，已完成登记并与 testid catalog 同步。

| 已登记 testid | owner / 控件用途 | YAML 动作与结果 |
|---|---|---|
| `git-diff-viewer` | DiffViewer 根节点，限定单实例 | wait_for，避免多面板串选 |
| `git-diff-splitter` | 连接带 separator，interactive | click 后 press ArrowRight / Enter，断言 `aria-valuenow` 变化后回到 50 |
| `git-diff-left-scroll`、`git-diff-right-scroll` | 两侧真实 scrollDOM，display | eval_readonly 读取 scrollLeft，断言归零 |
| `git-diff-mode-split`、`git-diff-mode-unified` | 现有模式按钮，interactive | click；断言两侧/单侧视图与 separator 存在性 |
| `git-diff-next`、`git-diff-prev` | 现有导航按钮，interactive | click 后同时断言目标行可见与两侧行首 |
| `git-log-tab` | GitPanel / WorkspaceGitManager 的 Log 入口 | 在已定位的 Git 根节点内 click |
| `git-log-commit`、`git-log-file` | 两个 Log 组件的提交/文件行 | 以 `data-oid`、`data-path` 选择夹具提交和 `long-lines.txt` |

DOM 生成的 separator/scroller testid 需要人工核对并登记 controls；不能因 TSX 静态提取未发现而删除。测试将分割控件登记 interactive，使用真实键盘输入覆盖；控件存在性不计作拖动验收。新文字标签沿用本组件当前英文文案习惯。

**用例全流程：**`modes: [native]`、`covers: [F26.1]`、`fixtures: [reset_db, git_diff_repo]`。在隔离测试用户配置中完成 first-run；按现有 `TC-IDE-D2-02` 的已登记 `seed_storage` / `reload_window` 写入一次性 `taomni.recentWorkspaces.v1`，使用 fixture repo 作为 root、`isGitRepo: true`、lastActiveFile 为 `long-lines.txt`。从现有 Welcome 最近工作区入口打开，等待 `code-workspace-tab`，点击当前工作区可用的 `ribbon-git`，等待 `git-panel` 或 `workspace-git-manager` 中实际出现的一个，随后使用上述 Log testid。复用入口 controls 的既有归属；为尚未登记的入口补准确归属，避免同一 selector 重复属于多个 feature。

用例进入真实 Log 后选 fixture 的第二次提交及长行文件，检查初始行首；键盘调宽/恢复；Next / Previous 后检查 fixture 的目标行首标记及左右 scrollLeft；切换另一文件，再回原文件；Split→Unified→Split。截图作为证据补充，核心必须是内容、滚动与 ARIA 断言。只读表达式例如 `Math.abs(document.querySelector('[data-testid="git-diff-right-scroll"]').scrollLeft) <= 1`。双侧断言分别写，遵守 eval_readonly 长度与只读限制。

仓库的 YAML runner 没有布局矩阵门禁；本次不扩展它。真实鼠标拖动、窄窗口几何与取消边界由 V-04 验证，不能从 F26.1 控件覆盖率推导通过。V-03 native smoke 涉及真实 Git 后端，不能直接改成 browser 模式跑 stub。macOS 使用 V-04 手工原生流程接续。

实现后、仓库根目录 PowerShell：

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python -m qa_ui_auto.gen_testid_catalog
python -m qa_ui_auto.lint
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.runner --config qa-ui-auto-tests/qa-ui-auto.config.yaml --mode native --filter TC-GIT-DIFF-01 --workers 1 --dry-run
python -m qa_ui_auto.runner --config qa-ui-auto-tests/qa-ui-auto.config.yaml --mode native --filter TC-GIT-DIFF-01 --workers 1
```

前置：安装仓库 QA Python 依赖；从 `.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml` 生成本地配置，填写 `app.mode: native`、实际 `app.native_binary` 与 WebDriver 配置。当前检出没有 `qa-ui-auto-tests/qa-ui-auto.config.yaml`；它是执行准备项，不是已存在配置。Windows 驱动需要 tauri-driver 和匹配 WebView2 的 msedgedriver；Linux 按现有 runner 支持配置 WebKitWebDriver。不要启动第二个桌面实例与 driver 抢同一配置；若使用 debug binary，需保留其 1980 Vite 服务。

每次执行记录实际选中 case、执行数、skip 原因。原生 driver 不可用时 V-03 标环境阻塞，由 V-04 手工完成同一原生用户行为并附证据，不能把 dry-run / skip 记为 smoke 通过。图形交互验证仍需真实桌面。

## 7. V-04 三端真机验证手册

### 7.1 环境与隔离

| 平台 | 准备与原生验证方式 | 本设计交付时状态 |
|---|---|---|
| Windows（本轮执行端） | 专用测试 Windows 用户或 VM；记录版本/架构/WebView2 版本、Git 版本、commit；按 AGENTS.md 准备 Rust 1.94+、protoc、完整 Perl、Bash 与构建依赖；根目录 `pnpm install` 后 `pnpm tauri dev` | 已执行 `tauri build --debug --no-bundle` 后的 native runner smoke；完整 V-04 手工 pointer/几何流程仍未完成 |
| macOS | 专用测试用户或 VM；记录系统/架构/WKWebView；按 release workflow 安装原生依赖；根目录 `pnpm tauri dev`，手工执行相同步骤；如直接运行 Cargo，先执行 `bash scripts/bundle-krb5-macos.sh stage` | 未验证；后续 macOS 环境接续 |
| Linux | 专用测试用户或 VM；记录系统/架构/WebKitGTK 与 X11/Wayland；按 release workflow 准备依赖；根目录 `pnpm tauri dev`，手工或受支持的原生 driver 执行 | 未验证；后续 Linux 环境接续 |

使用专用操作系统用户/VM隔离应用数据和 WebView 存储，不清空开发者 profile。`src-tauri/src/lib.rs` 从 `app.path().app_data_dir()` 初始化数据库，不能假设一个自造环境变量能隔离全应用；迁移模块还访问具名 config/cache 目录，所以仅改变 identifier 也不作为完整隔离证明。

`pnpm tauri dev` 已从本地 `--help` 核对；它会按 `build.beforeDevCommand` 启动前端并运行原生应用，参见 [Tauri CLI 官方说明](https://v2.tauri.app/reference/cli/)。本次是界面行为变更，开发态真实 Tauri 窗口足以覆盖本轮原生主流程，若使用打包应用则额外记录二进制路径与 hash；浏览器网页不能替代。

### 7.2 可复现 Git 数据

TASK-03 的 `git_diff_repo.py` 按现有 `workspace_root.py` 的 `setup(ctx)` / `teardown(ctx)` 约定，在当前 report_root 的 `git-diff-repos/` 下用随机后缀创建临时仓库，返回 `ctx.values["git_diff_repo"]`、`git_diff_commit_a`、`git_diff_commit_b`。保留夹具至证据归档后清理。该文件已提供可直接运行的 CLI 入口 `python .agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/git_diff_repo.py --output-root qa-ui-auto-report/git-diff-viewport`，供手工真机复用。

数据生成契约：

1. 使用 `subprocess.run` 参数数组、`cwd=fixture repo`、`check=True` 调用 Git。仓库本地配置测试作者、`core.autocrlf=false`，提交时禁用签名与外部 hooks，不更改用户全局 Git 设置，无 remote。
2. `long-lines.txt` 共 240 行，第 20、120、220 行含 2,000 个可打印 ASCII 字符，前缀分别为 `LINE020:`、`LINE120:`、`LINE220:`；其余为短行且每行有唯一编号。用 UTF-8 字节固定 LF，不依赖平台换行转换。
3. commit A 写入长行、短行文件 `short.txt`、同长度版本文件 `same-size.txt`、待删除文件。commit B 修改三个长行距行首约 1,700 列处字符，前缀保留；同路径等长替换 `same-size.txt`；删除待删除文件，新增空文件和非空文件。两次提交消息包含 `qa diff A` / `qa diff B`。
4. 保留一个未提交长行修改与一个已暂存的短行修改，供 Changes 切换和右侧保存使用；不要在开发仓库制造这些修改。图片、二进制和超大文本可由夹具另建单独文件用于提示分支，避免首选预览碰到大文件保护。
5. fixture 写出 manifest：绝对临时路径、两个 commit OID、文件字节 hash、关键行号、起始 `git status --porcelain`。路径由当前平台生成，文档及测试不硬编码当前开发者目录。

### 7.3 操作与逐步结果

1. **确认真实入口。** 在测试桌面通过 Git Repository 工具打开 fixture 路径，进入 Log，选择 `qa diff B` 和 `long-lines.txt`。画面标题的提交及文件与 `git log` / manifest 一致；两侧可分别看到未改/已改内容。记录“首次打开”截图及左右 scrollLeft，不先点 Next 掩盖初始状态。
2. **验证导航。** 连续 Next 到 20、120、220 行的变更，随后 Previous，检查两侧行首前缀可见、目标行尽量居中、scrollLeft 归零；再次 Next 检查循环。对新增/删除、空文件与末行无换行的专用组件数据/补充 fixture 检查无越界。
3. **验证调宽。** 在 diff 可用正文宽度至少 800 CSS px 时，拖动连接带使左右约 30:70，再拖向相反方向；确认宽度随手势连续变化，两侧垂直滚动条贴各自右边，底部横向滚动条占各自面板宽度，连接曲线仍连接对应变更行。双击恢复各半。
4. **验证手动滚动。** 两侧分别横向滚到不同位置，先关闭纵向同步，再分别纵向滚动；开启同步后验证纵向联动。拖动、双击调宽和外层 panel resize 时，保留各自横向位置（超出新滚动上限时夹紧），没有晚到归零。点击 Next 后才按规则回行首。
5. **验证边界。** 将外层 Log 详情区拖窄，使 `A` 分别位于 320px 上下；两侧可见，窄区等分，恢复外层宽度后恢复偏好。测试系统显示缩放 100% 与当前机器可用的高 DPI 档；记录 CSS px 与 devicePixelRatio，勿将鼠标 CSS 坐标乘 DPR。
6. **验证取消与键盘。** 拖动后 Escape；拖动时 Alt+Tab；在拖动状态切换文件/Unified/关闭 Git 标签，再重新打开。确认无残留 resize 光标、选区禁用或旧比例串入。Tab 到 separator，验证左右键、Shift、Home/End、Enter，继续 Tab 能离开控件。
7. **验证刷新恢复。** 切换同路径等长内容的提交，切到短行文件再回长行，刷新、切换模式/空白过滤/词高亮。新建视图从行首显示；loading 后没有空白 host；切回 Split 保留同一 DiffViewer 生命周期内的调宽比例。关闭标签重开默认各半。
8. **验证可编辑侧。** 在 Changes 中打开 fixture 的未提交文本，输入唯一标记，记下选区与滚动位置；拖动和键盘调宽后标记与 dirty 按钮仍在；点击 Save，独立读取文件确认标记落盘。取消/清理仅作用于 fixture；Log 的左侧无法输入。再走聚合 Workspace Log 与 Compare 入口，确认共享行为生效。
9. **验证非文本。** 空选择、二进制、图片、大文本保护分支无 separator；Render anyway 后文本左右初始化行首。过程中无未处理异常和 ResizeObserver loop 报错。

布局数值可通过测试版 DevTools 的只读表达式读取左右 wrapper 的 `getBoundingClientRect()` 与 scrollDOM 的 scrollLeft、clientWidth、scrollWidth。至少保存拖动前/后/复位、首次打开、长行 Next 后截图；录像用于证明连续拖动和取消。必须结合实际尺寸及内容前缀判断，不把截图文件生成当作断言通过。

证据保存到 `qa-ui-auto-report/git-diff-viewport/<platform>/<run>/`：manifest、操作记录、截图/录像、必要的 console 摘要、V/AC 映射、应用 commit 与工作树变更、系统/WebView/缩放、实际结果和未覆盖项。报告目录不提交；文档回填脱敏摘要与获取产物方式。

结束时关闭本次测试应用与服务，保留失败夹具/证据。证据归档后只清理本次创建的临时 Git 仓库与专用测试 profile；Windows 删除前核对解析后的绝对目标确在本次 report 根下，用 PowerShell 原生命令单一 shell 操作。

## 8. 验收追踪与交付状态

| AC | 方案 | 实施 | 验证与应有证据 | 当前状态 |
|---|---|---|---|---|
| AC-01 | §4.1/4.2/4.4 | TASK-01 | V-01、V-03、V-04；尺寸、拖动、复位 | **自动化通过；V-04 未完**（组件行为通过，native smoke 未覆盖真实 pointer 几何） |
| AC-02 | §4.1/4.2 | TASK-01 | V-01、V-03、V-04；窄宽边界与键盘结果 | **组件与键盘通过；V-04 未完**（Windows native 未覆盖窄窗口真实几何） |
| AC-03 | §4.2/4.4 | TASK-01 | V-01、V-04；取消后继续交互的记录 | **组件测试通过；V-04 未完**（真实 Alt+Tab/pointer cancel 尚未人工验证） |
| AC-04 | §4.3/4.4 | TASK-02 | V-02、V-03、V-04；初始/切换左右 scrollLeft | **已通过**（挂载与切文件 scrollLeft=0 测试，Windows native smoke 也通过） |
| AC-05 | §4.3 | TASK-02 | V-02、V-03、V-04；正确行首前缀、循环与边界 | **已通过**（chunk 导航定位行首与横向归零测试，Windows native smoke 也通过） |
| AC-06 | §4.3/4.4 | TASK-01/02 | V-01、V-02、V-04；独立横向与纵向联动记录 | **组件测试通过；V-04 未完**（真实独立滚动/调宽后的保留尚未人工验证） |
| AC-07 | §4.4 | TASK-01 | V-01、V-04；编辑保留及独立文件读取 | **组件测试通过；V-04 未完**（Changes 真机保存流程尚未执行） |
| AC-08 | §4.1/4.4 | TASK-02 | V-02、V-04；加载/卸载/非文本回归 | **组件测试通过；native 仅覆盖 Log 文本路径**（完整非文本矩阵尚未执行） |

### 8.1 实施与测试验证记录

- **TASK-01（Split diff 拖动与键盘交互）**：
  - `src/components/git/DiffViewer.tsx`：更新样式与 `applySplitDiffLayout`，移除 `flex: 1 1 0` 与 `width: 0 !important`；使用显式像素 basis 与 `clamp` 单侧最小 160px；实现 `setupSplitDiffInteractions` 支持 Pointer Capture 拖拽、键盘导航（ArrowLeft/Right ±20px、Shift ±10%、Home/End、Enter 重置 50:50）、双击重置、Escape/blur/pointercancel 安全回退；添加 `role="separator"`、`aria-orientation="vertical"`、`aria-valuenow/min/max` 与 `data-testid="git-diff-splitter"`。
- **TASK-02（默认行首归零与差异导航定位）**：
  - `src/components/git/DiffViewer.tsx`：优化 `scrollChunkIntoView` 将滚动目标修正为目标差异行首字符（`view.state.doc.lineAt(pos).from`），指定 `{ y: "center", x: "start", xMargin: 0 }`；实现 `scheduleScrollZero` 与 `cancelPendingScrollCorrection`，在挂载、切文件及 chunk 导航时调度横向归零；在用户 wheel、pointerdown、touchstart 及文档编辑输入时立即取消未决矫正；将 `loading` 纳入 `BUILD_EFFECT` 依赖，确保加载竞态下弹性建构。
- **TASK-03（测试集、夹具与交付验证）**：
  - **V-01 & V-02**：编写 `src/components/git/DiffViewer.viewport.test.tsx` 共 12 个单元与集成测试，覆盖拖拽、双击复位、键盘调宽、最小宽度限制、窄宽度禁用、Escape 取消、初始行首归零、chunk 跳转保持行首、切文件归零、用户操作取消未决校正、Unified/Split 往返保持比例。全量 12/12 测试通过。
  - **Git 模块回归**：运行全量 6 个 Git 测试套件（`DiffViewer.viewport.test.tsx`、`DiffViewer.eol.test.tsx`、`GitPanel.test.tsx`、`WorkspaceGitManager.test.tsx`、`WorkspaceCommitLog.test.tsx`、`diffWhitespace.test.ts`），共 55/55 测试通过。
  - **前端全量构建**：`pnpm build`（`tsc -b && vite build`）顺利通过，TypeScript 类型检查零错误。
  - **V-05 夹具与自动化**：
    - 新增 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/git_diff_repo.py` 并注册，支持自动生成长行 Git 测试仓库与 manifest。
    - 在 `qa-ui-auto-tests/feature-list.md` 登记 `F26.1`。
    - 编写 `qa-ui-auto-tests/cases/TC-GIT-DIFF-01-split-navigation-native.testcase.yaml`，严格遵守 native-gate 约束与 eval_readonly 规范。
    - `python -m qa_ui_auto.lint` 验证通过：173 文件全部合法，81 个功能条目（含 F26.1），0 个 lint 错误，0 个孤立选择器（orphans: 0）。
    - `python -m qa_ui_auto.gen_testid_catalog` 成功更新 testid 目录（1419 行）。
  - **Windows native smoke（V-03）**：执行 `python -m qa_ui_auto.runner --mode native --filter TC-GIT-DIFF-01 --workers 1`，结果为 **1 passed、0 failed、0 skipped**，共 42 步，报告目录为 `qa-ui-auto-report/run-20260905-204549`。该运行通过真实 Tauri/WebDriver 与 fixture Git 仓库验证 first-run、Log、Split/Unified 往返、键盘调宽/复位、Next/Previous 及双侧 `scrollLeft <= 1`。
  - **V-04 证据边界**：上述 native smoke 没有覆盖真实鼠标拖动的像素几何、窄窗口 320px 边界、pointercancel/失焦/Alt+Tab、Changes 编辑保存、100%/高 DPI 矩阵；这些不能由组件 jsdom 测试或 F26.1 控件覆盖率推导通过。macOS 与 Linux 尚未验证。
  - **当前平台 Rust 回归**：`cargo test --lib` 编译成功但结果为 `1257 passed, 1 failed, 13 ignored`。唯一失败是与本功能无关的 `src-tauri/src/backup/policy.rs:145` `test_default_policy`（该测试断言默认值为 `false`，而 `src-tauri/src/backup/tests.rs:341` 同时断言为 `true`）；本轮未修改该契约。
  - **QA gate 状态**：`F26.1` 聚焦审计无 actionable gap，catalog 为最新；全局 `python -m qa_ui_auto.audit --gate` 仍失败，原因是现有 baseline 的 shallow controls `44 -> 49`（集中于 F25.5）、release evidence 目录没有可提交的 current entry，另有既有 F1.9/F12.1/F5.2 控件缺口。native runner 报告在被忽略的 `qa-ui-auto-report/` 下，当前未提交产品源码也不满足 release evidence validator 的 current-entry 条件，故不将该 gate 记为通过。

## 9. 风险、回退与可开始工作

- **CodeMirror DOM 结构依赖：**现有代码已依赖 `.cm-mergeViewEditors` 和 wrapper 父子关系，本次继续限定在这一实现中；真实布局与版本锁定依赖升级后需回归。V-04 发现结构变化时修正 helper，不通过重建两套编辑器规避。
- **布局与校正时序：**一次性行首校正若晚于用户输入会破坏阅读位置；通过 generation、取消和有界调度约束，V-02/V-04 必测。禁止以高频定时归零消除表面偏移。
- **验证设施缺口：**Git diff 专用 YAML、fixture 和 feature/catalog 已补齐；当前剩余是完整 V-04 人工几何流程、macOS/Linux 设备验证，以及 release evidence 的提交后归档。driver/其他平台设备未验证，不将其结果推断为通过。
- **数据回退：**无新持久化字段、数据库迁移或 IPC；回退本次组件代码恢复固定等宽布局即可。既有 view/ws/syncScroll 偏好保持兼容，夹具数据留在测试目录。

本轮开发、自动化测试和 Windows native smoke 已完成；后续交付前需在 Windows 完成 §7.3 的人工几何/编辑流程，并在 macOS/Linux 环境接续验证。设计文档中的 native smoke 通过不等同于完整三端发布验收。
