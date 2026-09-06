# Git Log Diff 分割线拖动失效修复设计

## 1. 交付结论与范围

| 项目 | 结论 |
|---|---|
| Issue | ID 未知；slug：`git-log-diff-resize` |
| 文档 | `docs-issue/git-log-diff-resize-design.md` |
| 设计状态 | **部分可实施**。诊断、夹具及回归准备可开始；生产修复按 TASK-01 的区分性证据选择分支 |
| 修复状态 | 未实现。本轮只新增本文，未修改产品、测试、依赖或覆盖目录 |
| 根因确定性 | 已确认共享组件、事件路径、宽度禁用条件及不同分割线的所有权；**尚未在原生 Linux 复现，不能确认平台故障根因或 Mint 报告与主问题同源** |
| 来源 | 本次用户提供的问题描述及截图文字转述；未收到可检查的原始截图文件、issue 链接、日志、失败测试、问题版本或提交 |
| 调研基线 | `c54e07b8317d166b25d86e6ae11846f262d32a31`，`package.json` 版本 `0.4.22`；2026-09-06；调研开始与测试后工作树均干净 |
| 适用约束 | 根目录 `AGENTS.md`；未发现作用于相关目录的更深层 `AGENTS.md`。路径均相对工程根目录 |
| 平台范围 | Windows、macOS、Linux 三端 Tauri 桌面构建及运行；browser 仅辅助验证 |
| 当前执行端 | Ubuntu 22.04.5 LTS、Linux x64、LXQt、X11，`DISPLAY=:40004`；本机安装的 WebKitGTK 4.1 API 包版本 2.50.4、GTK 3.24.33；不能将它当作用户的问题 Linux/Mint 环境 |

推荐沿用共享 `DiffViewer` 的现有 Pointer Events 和布局算法，先取得一次失败拖动的命中、事件、容器尺寸及取消原因证据，再修复对应的命中/生命周期或尺寸实现。外层使用 `react-resizable-panels` 的分割线独立诊断，复用库的拖拽状态管理。禁止依据“Linux”增加平台分支、叠加一套 mouse 拖拽、改为 CSS `resize`，或未经证实就升级/替换布局库。

范围包含 Diff 左右正文调宽、报告涉及的导航边界及直接相关的嵌套布局回归。保持提交选择、文件操作、横纵滚动、编辑保存、键盘调宽、面板折叠/恢复及原有存储契约。不增加布局预设、跨窗口同步、比例持久化或其他新布局功能。

## 2. 原问题、代码路径与证据

### 2.1 用户报告与本轮实测分开

| 证据 ID | 类型 | 内容与证明范围 |
|---|---|---|
| E-01 | 用户报告，未独立复现 | 当前某 Linux 环境中，Git > Log > 选择含变更提交 > Diff，左右拖动稳定不能调宽；Windows 11 同功能正常；Linux Changes Diff 正常。各环境版本、窗口和面板尺寸未知 |
| E-02 | 用户报告，未独立复现 | Linux Mint 中左侧导航与 log list 的边界有时不能拖动；频率、桌面环境、具体控件、是否同机器均未知 |
| E-03 | 本轮自动化实际结果 | 根目录执行 §7 的 C-01：4 个文件、19 项测试通过，退出码 0；Vitest 4.1.8，2026-09-06 10:25:29 +08:00，耗时 2.84s。未新增失败测试，也未证明原问题在当前代码重现 |
| E-04 | 本轮环境检查 | `cat /etc/os-release`、Node 平台/架构及指定桌面环境变量读取、`pkg-config --modversion webkit2gtk-4.1 gtk+-3.0`、`rustc --version`；Node v24.13.0、Rust 1.96.1。WebKitGTK 为已安装包版本，被测应用实际加载版本仍须核对 |
| E-05 | 历史资料，非本轮实测 | `96d94536`（2026-09-05）加入共享 Diff 拖动。`docs-feature/git-diff-resize-and-scroll-origin-design.md` 记录 Windows native smoke，但也明确完整鼠标/几何和三端矩阵未完成。不能继承为本问题修复证据 |
| E-06 | 本轮静态检查 | 下表列出的入口、组件、布局库实际安装源码、测试 mock、IPC 注册和 browser alias。源码能证明分支存在，不能证明用户触发了它 |

原始复现步骤保留：Linux 启动 Taomni，进入 Git > Log，选择有变更的提交及文本文件，在 Split 下拖动左右正文边界；再拖动左侧导航与提交列表边界；对照 Windows 11 Log 和 Linux Changes。执行时必须补上二进制提交/hash、实际分割线身份、窗口和内容区尺寸。没有已证实的 workaround；扩大 Diff 容器或键盘调宽目前仅作为诊断对照。

本轮没有启动 Tauri、浏览器 UI 或原生自动化，也没有录制拖动。原始应用/版本和 Mint 的触发条件缺失，不能把现有组件测试通过写成“无法复现所以已经修好”。当前设备有图形会话和部分原生依赖，不应虚称没有 Linux 测试环境；实现阶段由 TASK-05 执行原生流程。

### 2.2 分割线身份与调用链

为防止“左右 panel”含义混淆，下游在截图中标注 S1/S2/S3/S4，记录被操作元素，而不是只记录鼠标坐标。

| 标记 | UI 边界与准确位置 | 实现、状态及尺寸 |
|---|---|---|
| S1 | 旧文本/新文本；`src/components/git/DiffViewer.tsx:575`，`setupSplitDiffInteractions`；`[data-testid="git-diff-splitter"]` | 自定义 36px connector + CodeMirror `MergeView`；局部 `drag`/`previewRatio`；组件 `preferredRatioRef`，不写 store |
| S2 | 应用左侧导航/主内容；`src/layouts/MainLayout.tsx:3461` 的 `main-layout`；`[data-testid="main-sidebar-resize-handle"]` | `Group/Panel/Separator`；默认 sidebar 22%，范围 15%～40%，可折叠；可见宽度与 `resizeTargetMinimumSize` 均为 3px；库管理拖动，`saveResizableLayout("main-layout")` 管持久化 |
| S3 | Log 提交列表/详情；`src/components/git/CommitLog.tsx:297` 的 `git-log-layout`；聚合版 `src/components/git/WorkspaceCommitLog.tsx:317` 的 `workspace-git-log-layout` | 同一个库，视觉 Separator 为 3px；未覆盖库默认命中尺寸（fine 10px/coarse 20px）；没有独立 React 拖拽状态或比例持久化 |
| S4 | Log 详情内文件列表/Diff 上下边界；`CommitLog.tsx:331`、`WorkspaceCommitLog.tsx:356` | 库的 vertical Group；视觉高度 3px；与 S1 顶端相交，列为直接相邻回归 |

S2 是“左侧导航与 log list”在当前独立 Git 标签结构中的首选映射，但缺少原图，不能确定。若截图中的“左侧”其实是提交列表，应归为 S3。`WorkspaceGitManager` 当前没有独立的可拖动仓库侧栏，不能凭名称给它新增分割逻辑。若实测定位到工作区项目树，则核对 `src/components/editor/CodeWorkspaceTab.tsx:16903` 的 `code-workspace-project-resize-handle`；只在证实该入口相关后纳入 TASK-03。

```text
MainLayout: main-layout (S2)
  Git 标签 (保留挂载，非活动时 display:none)
    GitPanel 或 WorkspaceGitManager -> GitPanel
      Log: .git-log-view (切换到 Changes 时 display:none)
        CommitLog / WorkspaceCommitLog
          horizontal Group: 提交列表 | S3 | 详情
            vertical Group: 文件列表 / S4 / DiffViewer
              MergeView: 旧文本 | S1 connector | 新文本
      Changes: horizontal Group: 文件列表 | Separator | shared/DiffPane
        同一个 DiffViewer -> 同一个 S1
```

### 2.3 当前源码事实

| 位置与符号 | 已核对事实 | 对诊断/修复的影响 |
|---|---|---|
| `CommitLog.tsx:145` 附近文件加载 effect；`WorkspaceCommitLog.tsx` 选中提交 effect | 通过 `gitCommitFiles` 获取文件，`gitBlobPair(repoRoot, path, commit^, commit, oldPath)` 加载 parent/commit；取消标志拒绝过期响应 | S1 拖动不应触发这些 effect、Git 请求或改变选中文件 |
| `GitPanel.tsx:368,1090`，`ChangesView`；`WorkspaceChangesView.tsx:187,277`；`shared/DiffPane.tsx:56` | Changes 为单层水平文件/Diff 布局，再调用同一个 `DiffViewer`；包装层传递 loading 和可选编辑/保存回调 | Log/Changes 没有不同平台或不同 splitter 参数。父容器嵌套、宽高和 mount/visibility 是区别；单仓库 Changes 当前不一定启用编辑，编辑契约在实际开启的入口及组件层回归 |
| `DiffViewer.tsx:437` `splitLayoutMetrics` | `W=elementWidth(editorDom)`；`A=max(0,W-36)`；`A<320` 时等分且 disabled，正常每侧下限 160px | `W<356px` 的不能拖动是既有保护；`W=356px` 可行区间退化为 50:50，也不会移动。必须在 `W>356` 且未夹紧时检查故障 |
| `DiffViewer.tsx:483` `applySplitDiffLayout` | 对两 wrapper 写显式像素 `flex`/`width !important`；各层 `min-width:0`，左右之和为 `A`；尺寸变更请求 CodeMirror measure | 当前没有旧版固定均分 `width:0 !important` 的主路径；如比例变了几何不变，要定位实际覆盖或父容器约束 |
| `DiffViewer.tsx:775` `onPointerDown` | 仅主键/主指针；要求可用布局；preventDefault/stopPropagation、focus、保存起点和 body 样式、注册 window 监听、尝试 capture，异常时保留监听兜底 | “未设置 pointer capture”不成立；需记录 handler 是否进入、capture 是否成功及首次取消原因 |
| `DiffViewer.tsx:712,902` `pointerRatio` / `handleResize` | 拖动中可用宽度距起点变化超过 0.5px 时失败；observer 检测到 `width !== lastWidth` 就取消拖动。测量优先用整数 `clientWidth` | 容器初次显现、真实外层 resize 或宽度抖动可能回退；不能仅把阈值调大或去掉取消契约 |
| `DiffViewer.tsx:682` `endDrag` | up 提交最后位置；Escape/cancel/blur/lost capture 取消并恢复起始偏好；cleanup 取消帧、解绑、还原 body 样式、释放 capture | 已有多数清理路径；window pointermove 没有检查 mouse `buttons===0`，释放事件缺失后的悬挂是待触发候选；正常 up 后的 lost capture 应幂等 |
| `DiffViewer.tsx:590,620` connector / `renderConnectors` | connector `pointer-events:auto; touch-action:none; user-select:none`；SVG 未显式 `pointer-events:none`，rAF 中 `pathLayer.replaceChildren` | 实际 target 可以是 SVG/path，但事件应冒泡到 connector，**本身不能证明被吞事件**；需对比图形填充/空白命中及 capture 丢失 |
| `DiffViewer.tsx:1087` `BUILD_EFFECT` | pair/loading/mode 等决定创建与 teardown；比例 ref 不在构建依赖；切换文件/模式可保留已挂载组件的偏好 | 单次 resize 不能销毁编辑器；隐藏页面应恢复测量，活动拖动不得遗留到另一页面 |
| `GitPanel.tsx:788`、`MainLayout.tsx:3928` 附近 | Log 和 Git 标签都保留挂载，以 `display:none` 隐藏 | 测试首开、切出后重开、后台刷新；不能按“有 DOM”推断可见或尺寸有效 |
| `node_modules/react-resizable-panels/dist/react-resizable-panels.js:1066,1243,1489`；对应 sourcemap 的 `onDocumentPointerDown/Move/Up`、`findMatchingHitRegions` | v4.11.2 使用 document capture 的 down/up、document bubble 的 move、几何命中及 stacking 判定；move 会对命中 separator capture；存在全局拖动状态及 cursor stylesheet | S1 target 阶段 stopPropagation 无法撤销已执行的 document capture；仅在命中区域实际相交时构成竞争。SVG/hover overlay、嵌套边缘需要实测事件先后 |
| 同库 `react-resizable-panels.d.ts`、JS `parseSizeAndUnit`（dist 中 `bt`） | 数字尺寸是 px，百分比要用字符串；Log 的 `defaultSize={42}/{58}`、`minSize={28}/{35}` 和详情 `30/70,15/20` 都是 px；Changes 也有数值 | 这是确定的 API 语义，是否违背原布局意图及导致故障仍待尺寸证据。不能把这些数值直接当百分比，也不能全库批量转换 |
| `MainLayout.tsx:3467` 注释、`src/lib/resizableLayout.ts` | 主侧栏故意缩小命中区，避免侵入终端第一列；持久化 key 为 `taomni.resizable-panels.v4.main-layout`，值是 panel ID 到百分比的映射 | 若扩大 S2 命中区，需分配真实布局空间，回归终端文字选择；保持 key、字段和比例单位 |
| `shared/CommitMessageHover.tsx:162` | 可选中文字的 portal 弹层 `z-[600]`，350ms 出现、180ms 延迟隐藏，外部 mousedown 关闭 | 可解释“有时”覆盖的候选。不能全局设置 pointer-events:none 破坏弹层文字操作 |
| `src/components/window/WindowResizeHandles.tsx` | Windows/Linux 原生窗口边缘 6px、角 14px 的高层控件调用 `startResizeDragging`；根层 pointer-events:none | 只有实际坐标重叠才相关；无证据表明覆盖内部整页；不能删除窗口 resize 功能 |
| `src/lib/git.ts:181,339,343`；`src-tauri/src/git.rs:268,683,699`；`src-tauri/src/lib.rs:458,479,480` | `git_blob_pair/git_log/git_commit_files` 已注册，无布局参数；`GitBlobPair` 传文本/媒体元数据 | 预期无需 IPC、Rust、数据库或序列化变更 |
| `vite.config.ts`、`src/stubs/tauri-core.ts` | browser 把 Tauri core 替换为 stub，未实现完整 Git blob/log/status 数据链；现有桥接为 SSH/SFTP/RDP | `pnpm dev` 不能直接证明该原生 Git 流程；辅助 harness 需显式使用 fixture/mock，不能冒充真实后端 |

未在上述分割线实现中发现 CSS `resize`、专门的 Windows/Linux 事件分支或 Git 内容区 `data-tauri-drag-region`。`src/index.css` 中 modal 的 `resize:both` 不在本问题执行路径。Tauri 平台的 WebView2/WebKitGTK/WKWebView 差异需要实际 runtime、事件和异常记录，不能由平台名称推导。

### 2.4 可验证因果链与候选优先级

必须恢复的不变量：在可调区间内，一次主键拖动只由命中的分割线持有；移动改变相邻两侧实际宽度；结束后不再跟随；单纯改变宽度不重建内容、不改变 Git 数据。

| 假设 | 触发 → 执行路径 → 可能破坏/结果 | 支持与限制 | 最小区分检查 / 修复分支 |
|---|---|---|---|
| H-01 版本或目标不一致 | 原问题运行旧版或操作 S3，却与新版 S1 对照 | 最近提交才启用 S1；旧设计描述 connector 不接收事件。但无法解释同版同 S1 的 Windows/Changes 差异 | 核对各二进制 SHA、版本和 S1/S2/S3；最新基线真实复测。只在旧版失败时记录版本范围，不再重复实现拖拽 |
| H-02 可用宽度/布局约束 | Log 多层分配使 `W<=356`，或首次显示时宽度未就绪 → disabled/夹紧 → pointerdown 返回或位移为零 | 已确认分支；Changes 实際正文可能更宽，报告未给尺寸 | 同一文件分别在 Log/Changes 测 `W=600/1000`；记录 `aria-disabled`、W、A、左右实宽。扩大后仅解除正常保护不等于发现平台故障；父级错误分配成立才执行 §4.2 |
| H-03 命中/事件所有权 | 指针落在 SVG、浮层或相交命中区 → down 未到 S1、库已激活其他 separator，或 capture 被抢 → 无变化/立即回退 | document capture 与独立 S1 确实共存；SVG 子节点被重绘、S2 3px/浮层存在；尚无失败 trace | 固定 x、分别在高度 25%/50%/75%、S1 顶端和图形填充区拖动；`elementsFromPoint`、capture owner、target/currentTarget 对照；执行 §4.3/4.4 的已证实子项 |
| H-04 拖动因测量/重建被取消 | down 后 observer 测得宽度变化，或父级 loading 隐藏/重建 → `endDrag(false)` → 回到起点 | 取消逻辑确定，Log 隐藏/嵌套条件更多；尚无容器持续抖动证据 | 按事件记录 W、startAvailableWidth、isConnected、BUILD_EFFECT teardown 及取消原因；区分真实外层 resize 与无外部变化的抖动；§4.2/4.3 |
| H-05 丢失释放/引擎异常 | 原生事件中断、capture 不可用且 up 丢失 → 后续 mouse move 仍改宽；或库 cursor/捕获 API 异常中断外层交互 | S1 兜底缺少 `buttons` 校验；库使用 CSSStyleSheet/adoptedStyleSheets，当前 OS 包版本不能证明故障机支持；正常 Changes 是对照而非排除证据 | 抓 pointercancel/lost capture/blur、buttons 和首个异常堆栈；一次释放后移回页面。只按确认的异常/API 或生命周期修复，§4.3/4.4 |

H-02 不会使另一条库 separator 必然失效；H-03/H-05 可能共同影响 S1 与外层，但只有**同一环境中相同的第一失败事件/异常和共同修复前后结果**才能判为同源。两个边界分别保留结果。未出现证据的候选不得全部变成生产补丁。

## 3. 修复验收

容差以 CSS px 计，几何比较默认 1px；真实显示器缩放不乘入 `clientX` 差值。下面数值用于可重复验收，不是新增产品尺寸需求。

| AC ID | 输入/动作 | 修复后的可观察结果 |
|---|---|---|
| AC-01 | Linux 原生 Log，普通文本 Split，S1 的 W=1000±1，初始 50:50；主键从中点向右 120px、向左 120px，分别释放 | 左右约从 482/482 变为 602/362 及反向对应宽度；移动期间有中间宽度变化，左右总宽+36等于W，无持续抖动或回弹；原问题的失败位置必须在 V-01 基线记录 |
| AC-02 | 确认报告对应的导航边界 S2 或 S3，在各自可调范围左右拖动；同时回归另一个外层边界与 S4 | 目标相邻面板连续反向变化，其他组不被同时拖动；在可调范围内不能无响应。S2 的现有折叠/展开和 15%～40% 限制保留；未见浮层遮挡时整条合法命中区可用 |
| AC-03 | S1 及报告外层边界连续往返各20次；从图形/空白、边界中段和靠近嵌套交点起拖 | 每次合法起拖、移动、释放都有效；无第一次后失效、错组拖动、内容误选或比例串实例。次数是本次间歇性观察样本，不宣称统计上消除所有 Mint 条件 |
| AC-04 | S1 分别 W=1000/600/356/355/300，极限左右拖动；窗口 1440x900→1024x768→1440x900；隐藏后显示 | 保留 A>=320 时每侧160px、A<320临时等分/禁用；W=356仅无调节余量；放宽后恢复可调及已提交偏好。窗口改变时不溢出/遮挡；拖动中真实外层 resize 按既有规则取消，下一次可拖 |
| AC-05 | S1 普通 up、指针移出 connector 后 up、出窗口释放再移回、Escape、blur、pointercancel、lost capture；拖动中换页/卸载 | up 提交最终位置，其后移动不改宽；取消恢复拖动前偏好；无残留 capture、rAF 写入、is-dragging 或 body cursor/userSelect；下次拖动正常。外层 up/失焦后同样不能持续跟随，取消是否回退沿用库契约 |
| AC-06 | Log/Changes 往返10次，切换提交/文件、刷新同提交、Split/Unified、查看二进制/空/大文本提示；双击及键盘调宽 | 文件及提交选中正确；同一已挂载 DiffViewer 保持已提交比例、实例互不串值；非 Split 文本无可操作 S1；Arrow ±2%、Shift ±10%、Home/End/Enter、双击行为保留。刷新不丢选中文件 |
| AC-07 | 调宽前手动横向滚动两侧至不同位置；纵向滚动、切同步、Next/Previous；在已启用 Changes 编辑的入口改文本后调宽并保存 | 普通调宽仅允许合法滚动范围夹紧，不主动归零或复制横向位置；同步和行首导航保留；编辑文本、选区、dirty和保存值不丢失；调宽不重建 EditorView、不触发 Git 请求/写盘 |
| AC-08 | Changes 文件选中、勾选、Stage/Unstage；聚合 Log/Changes、Compare 冒烟；S2 旁终端第一列文字选择 | 相邻行为保持；只有显式文件命令改变 index/worktree；S2 命中区不侵入终端正文/Log 行操作。Windows 11 作为正常对照，macOS 纳入真机计划，无平台特判或已知三端不兼容 |

## 4. 修复方案与契约

### 4.1 SOL-01：先定位第一个失败边界

TASK-01 在当前基线和可取得的故障版本上执行 V-01。用同一隔离 repo、同一 commit/file、同一入口模式、W 和缩放比较 Log/Changes。主问题先取一次稳定失败；Mint 对 S2/S3 分别做20次，若未出现，只记录“本次0/20”，不判已修。

可在 DevTools 非暂停日志点观察 `onPointerDown`、`applyDragAt`、`endDrag`、`handleResize`、`BUILD_EFFECT` teardown；另在 window/document/connector 的捕获与冒泡阶段临时监听，输出 `timeStamp/type/target/currentTarget/pointerId/pointerType/isPrimary/button/buttons/clientX/clientY/defaultPrevented`、`hasPointerCapture`、`activeElement`、`isConnected`、W/A、左右 rect 和 `aria-*`。日志不得调用 preventDefault、修改布局或包含源码/凭据。避免用断点暂停制造 blur/capture 丢失；诊断结束移除全部临时监听/日志点。

顺序判断：命中元素不符 → H-03；handler未进入 → 对照原生事件和上游处理；disabled或无余量 → H-02；进入后立即取消 → H-04/H-05；ratio/style变而实际rect不变 → 布局约束；只有释放后仍动 → H-05。记录第一异常堆栈，不以最后一次看见的 cursor 当作根因。

### 4.2 SOL-02：仅修正确认有误的尺寸链路

保留 `splitLayoutMetrics` 的既有最小宽度、36px 带宽及不持久化比例契约。W不足本身不是通用拖动 bug；不得通过删除160px下限使界面继续挤压。若相同W下两入口都正常，但Log父布局把一个本应可用的详情区域压窄，则改准确父级约束，不修改CodeMirror内容或引入Linux分支。

`react-resizable-panels` 的数字为px已经确认。只有 TASK-01 的真实几何、原布局意图/历史及正常对照确认这些值应表达比例时，才把受影响的 Log Group 显式写成百分比：list `42%/min28%`、details `58%/min35%`；files `30%/min15%`、diff `70%/min20%`。聚合版对应相同规则。Changes 若同样确认误用，限于同链路改为单仓库 `36%/64%, min24%/35%`、聚合 `38%/62%, min26%/35%`。这些是条件性改动，不是已证实修复；转换后必须实测窄窗口，不能只断言 JSX 字符串。

如果父容器测量抖动导致取消，则在 `elementWidth`/`handleResize`/`pointerRatio` 统一同一盒模型和有效尺寸判定，消除已观测到的自激尺寸写入或初始化时序。诊断记录需先证明“外部尺寸稳定但应用自身写入引起反复测量变化”。零宽/隐藏恢复只更新有效布局、不覆盖偏好；真实窗口/父组改变仍取消当前拖动。不要仅提高0.5px阈值掩盖持续反馈循环。

### 4.3 SOL-03：共享 S1 命中与拖动生命周期

修复 owner 为 `DiffViewer.tsx` 的 `setupSplitDiffInteractions`，保持当前私有接口和调用者 props。根据 V-01 选定的因果链执行以下对应项：

1. 若 SVG/重绘命中参与故障：将 `.taomni-diff-connector svg` 及图形后代设为 `pointer-events:none`，整个既有36px connector承接输入；图形视觉和 chunk 更新保留。不新增透明全页覆盖层，不改变内容滚动命中。
2. 若捕获/事件丢失：继续以 pointerId 绑定一次主指针会话，capture不可用时保留同源window兜底。统一move/up消费路径，禁止同一事件被connector和window重复处理；非当前pointerId和非主键不写宽度。不能因实现了兜底就同时添加mousedown/mousemove第二套状态机。
3. 若释放丢失成立：mouse `pointermove` 的 `buttons & 1` 为0时终止会话并清理，不继续套用clientX。没有可靠最终up位置时采用既有取消规则恢复起始偏好。touch/pen不能套用mouse按钮规则。合成测试必须给真实拖动的move带 `buttons:1`，不能靠默认0伪造“按住”。
4. `endDrag` 保持幂等：先清空会话，再取消pending帧，提交或回退，解绑本次window监听（包括blur）、还原捕获前body样式和临时class，最后释放capture。正常up后的lost capture是空操作；非活动pointer的意外事件不能取消另一会话。异常、取消和teardown共用该出口。
5. 若parent visibility/loading重建是起因：仅在证实的依赖/父级生命周期处修正误重建或迟到回调，保留内容变化需要重建的路径。drag预览仍使用DOM/ref，不加入React effect依赖，不在每次move中请求blob或重建MergeView。

| 状态 | 事件 | 结果 |
|---|---|---|
| idle | 合法down且W有调节余量 | active；记录pointerId、clientX、起始左宽/可用宽度、起始偏好和临时样式 |
| active | 同一pointer且仍按住move | 按起点增量计算夹紧比例，rAF写左右宽度/ARIA；不提交偏好 |
| active | 同一pointer up | 同步处理最终clientX，提交偏好，cleanup→idle |
| active | Escape/cancel/blur/非预期lost capture/真实容器resize/卸载 | 恢复起始偏好，cleanup→idle；新容器按有效宽度布局 |
| active | mouse move发现已释放（条件修复） | 取消并清理，不追逐无按键移动 |
| idle | 迟到up/cancel/lost capture或旧帧 | 空操作，无副作用 |

### 4.4 SOL-04：外层分割线的独立修复边界

S2、S3、S4继续使用库的Group/Separator；不复用S1的像素ratio ref，不在MainLayout手写document拖拽。先定位边界：

- **S2纯命中不足成立**：建议把真实占位和命中区一起从3px改为6px，内部保留细分割视觉，`resizeTargetMinimumSize={{fine:6,coarse:6}}` 与占位一致。6px是本修复的有界命中改善值；不能只恢复默认10/20px造成透明区域侵入正文。保留sidebar折叠时隐藏分割线、存储key/面板ID、折叠前宽度ref。终端第一列选择是强制回归。
- **S3/S4交点竞争成立**：调整该Group的实际separator占位/命中设置，使内外几何边界不覆盖S1可操作带；保留库的原生键盘与拖动，不给子控件盲目提高z-index，也不能只在S1多加stopPropagation，因为库down已在document捕获阶段执行。
- **hover portal遮挡成立**：修正 `CommitMessageHover` 的具体放置/退出时序，让已退出的弹层及时释放边界；弹层实际可见区域仍应允许文字选择和滚动。对真实覆盖的菜单/弹窗应先关闭后操作，不能让分割线穿透正常模态UI。
- **库在特定WebView抛异常或capture清理缺陷成立**：从锁定v4.11.2的具体调用栈制作最小重现，再选择已验证的上游修复版本或可维护的局部适配。没有异常/API支持证据时，不预先增加polyfill、关闭全局cursor或修改`node_modules`。如需依赖更新，TASK-04补锁文件差异和所有受影响Group集成回归，规模须限于确认的缺陷。

S2的修复不能靠更改S1样式宣称完成，反之亦然；两个失效区域分别提供修复前失败/修复后通过结果。

### 4.5 SOL-05：接口、存储、兼容和相邻行为

沿用 `DiffViewerProps`、`SplitInteractionOptions`、`GitBlobPair` 及 `gitBlobPair/gitLog/gitCommitFiles` 接口。`preferredRatioRef`属于已挂载实例，preview属于单次drag；普通刷新/模式重建保留已提交偏好，组件卸载/重启默认50:50。已有view/whitespace/syncScroll localStorage键不变，S2百分比存储不迁移，不新增Zustand布局状态。

宽度更新只触发布局/CodeMirror measure和现有连接图重绘，横向scrollLeft仅由用户滚动、合法范围夹紧或已有明确导航/内容重建规则改变。文件数据、只读Log与可编辑Changes边界沿用；图像/二进制/oversize/Render anyway分支不强行创建S1。错误/loading沿用现有反馈，不增加提示文案或toast。

Windows使用WebView2，Linux使用WebKitGTK，macOS使用WKWebView。统一CSS px与Pointer Events，保留capture的能力检测/异常恢复；没有新增Rust `cfg`、系统API、权限或平台路径分支。`vite.config.ts` 的现有ES2020/Safari16构建目标不降低。若证据要求库适配，按API能力处理并在三端验证，不以OS名称绕过。

## 5. 改动清单与文件所有权

所有“拟新增/条件修改”均未执行。负责实现的agent保留他人工作树变更；下表不代表已经领取任务，也不授权并行agent或共享看板操作。

| 路径/符号 | 具体职责及修改条件 | TASK / AC |
|---|---|---|
| 本文 | 回填基线、根因、分支选择和脱敏证据 | TASK-01/04/05；全部 |
| `src/components/git/DiffViewer.tsx` 的样式、`elementWidth/splitLayoutMetrics/applySplitDiffLayout/setupSplitDiffInteractions/BUILD_EFFECT` | 按SOL-02/03处理已证实的S1问题；保留所有相邻接口 | TASK-02；AC-01/03～07 |
| `src/components/git/DiffViewer.viewport.test.tsx` | 补同pointer释放、capture失败/丢失、窗口兜底、隐藏/重建、按键状态和拖动中resize；真实CodeMirror+可控尺寸 | TASK-02；AC-01/03～07 |
| `src/layouts/MainLayout.tsx`、`src/layouts/MainLayout.test.tsx` | 仅S2命中/恢复确认相关才修改；保留折叠、百分比存储、终端选择 | TASK-03；AC-02/03/05/08 |
| `CommitLog.tsx`、`WorkspaceCommitLog.tsx`；必要时 `GitPanel.tsx`、`WorkspaceChangesView.tsx` | 仅SOL-02/04成立时修尺寸/命中；给S3/S4增加准确testid是可选测试辅助 | TASK-03；AC-02/04/06/08 |
| `src/components/git/shared/CommitMessageHover.tsx`、同名`.test.tsx`（现有） | 仅证明portal直接参与时修放置/退出；保留可选文本 | TASK-03；AC-02/03/08 |
| `src/components/git/GitLogResize.integration.test.tsx`（拟新增） | 使用真实布局库而非全局mock，mount实际Log/Changes外壳与DiffViewer；fixture Git数据；覆盖document级事件所有权 | TASK-04；AC-01～06/08 |
| `qa-ui-auto-tests/feature-list.md`、`.agents/skills/qa-ui-auto/references/testid-catalog.md`、相关既有case | 若新增控件/selector，分别归属F26.1/F1.1；生成目录，不手改生成物；无需无关目录补全 | TASK-04；AC-02/06/08 |
| `package.json`、`pnpm-lock.yaml` | 默认无变更；仅SOL-04已证实库缺陷且选定依赖修复时由TASK-04统一负责 | TASK-04；AC-08 |

生产Rust/IPC/stub、`src/lib/resizableLayout.ts` 默认不修改。测试夹具复用现成实现；不为跑browser补全生产Git stub。

## 6. 工作包

### TASK-01：诊断与根因分流

- 职责/输入：本文§2、SOL-01，现有Git/布局源码和E-01/E-02；维护本文证据，不修改产品。依赖：无，立即可开始。
- 实施：确认S1/S2/S3身份和版本；准备§8夹具；执行V-01的同W、同文件、事件和几何比较；分别记录主Linux稳定问题和Mint间歇问题。核实px/百分比意图及首个异常。
- AC/V：AC-01～05；V-01、V-06/V-07的修复前基线。
- 完成条件：每个边界标记“已复现并定位第一失败边界”或“未复现/缺少明确条件”；选定SOL分支并附证据。若主问题仍未定，受影响生产分支继续待确认，但TASK-02/04测试准备和其他已证实边界可推进。

### TASK-02：共享Diff修复与聚焦回归

- 职责：独占修改 `DiffViewer.tsx` 和 viewport测试；输入SOL-02/03/05、TASK-01 trace与现有13项viewport测试。依赖：失败条件已定位才能选择生产改动；测试设计可先做。
- 实施：写能体现已确认第一失败边界的回归；在原实现观察失败，再实施最小修复。补必要结束/隐藏/尺寸场景，不重复现有键盘用例。当前指针移动测试补正确buttons，必要时局部模拟capture失败/抛错。
- AC/V：AC-01/03～07；V-02/V-04及TASK-04集成。
- 完成条件：失败变通过，编辑器实例/保存/滚动契约保持，拖动后残留状态为零；证据记录通过数和mock边界。不因既有pointer单测绿色略过原生失败证据。

### TASK-03：报告外层边界与相邻布局

- 职责：MainLayout、两个Log及确实受影响的父布局/hover文件和对应单测；不并行修改TASK-02文件。输入SOL-02/04与TASK-01的S2/S3确认结果。
- 依赖/实施：按证据选择命中占位、布局单位、portal或库缺陷路径；给两个Log的S3/S4拟增 `git-log-list-resize-handle` / `git-log-files-resize-handle` 时使用实例根定位，不能把全局第一个元素作为目标。不要同时改全部候选。
- AC/V：AC-02～06/08；V-03/V-04，原生V-06/V-07。
- 完成条件：报告的目标边界恢复、另一个边界和S1未回归；MainLayout折叠/终端首列选择及原存储恢复通过。Mint无法取得触发条件时保留未验证，不硬编一个“Mint修复”。

### TASK-04：集成、目录与三端代码检查

- 职责：拟新增真实库集成测试、必要QA映射/生成物、条件依赖变更；整合TASK-02/03并回填追踪表。输入§7，先读取当前qa-ui-auto规则。
- 依赖：集成fixture可与诊断独立准备；最终检查依赖所有选定修复。
- 实施：测试文件局部 `vi.unmock("react-resizable-panels")` 或显式加载actual，保留真实Group/Separator和DiffViewer；控制jsdom rect/ResizeObserver用于事件状态检查。不能仅把三个假div嵌套就声称真实集成；jsdom依然不能替代浏览器/WebView几何。映射现有F26.1、F1.1，必要时补既有case的键盘行为，保持明确证明边界。
- AC/V：全部AC；V-03～05；三端静态兼容检查。
- 完成条件：相关单测/集成、`pnpm build`、diff check及目录改动对应audit通过；无已知三端代码不兼容。输出当前Linux原生待测构建、提交及确切文件变更列表交TASK-05。

### TASK-05：当前Linux真机、三端计划与证据交接

- 职责：§8的原生操作、测量、截图/录屏、清理、结果回填；负责主问题与所有相邻入口的最终回归闭环。
- 依赖：TASK-01提供失败基线，TASK-04提供集成构建；原环境缺失不阻塞其他独立检查。
- AC/V：全部AC；V-06/V-07/V-08。当前端需在实际Linux Tauri验证，Windows 11和macOS各保留结果，不继承Linux通过。
- 完成条件：本轮实现交付所需自动化和当前Linux真机通过，原始失败场景有前后证据或明确标注原环境尚未验证；其他两端未执行记未验证。若Linux仍失败则交回对应TASK，不能以YAML退出码0结案。仅本轮设计交付不要求执行这些实现后项目。

## 7. 验证设计

### 7.1 输入、动作、断言与状态

| V ID | 层级/文件 | 具体输入与操作 | 核心断言/修复前失败点 | 命令与状态 |
|---|---|---|---|---|
| V-01 | 原生诊断；本文§4.1 | 当前基线、原问题版本可得时各一次；fixture B和`long-lines.txt`；S1 W=600/1000及阈值两侧；S2/S3同坐标20次；捕获事件与rect序列 | 定位第一个偏离不变量的位置：无命中、disabled、wrong owner、即时cancel、style/rect不一致或结束不清理；同W的Changes和键盘是区分对照 | §8手工；**待执行**；E-01/E-02仅报告 |
| V-02 | Vitest：viewport测试（现有+拟扩展） | `before\n`/`after\n`及现有长行pair；1000px，down x500→move x620→up；move用buttons1；window兜底、capture抛错、lost capture、非当前pointer、缺失up后buttons0、卸载前未执行rAF；宽度0→1000、1000→600 | 中间及最终左右实样式602/362、无EditorView重建；结束后再move不动、body旧样式恢复；取消回起点；有效宽度变化取消、零宽不污染偏好。只新增已证实故障及必要结束路径 | C-01；**基线E-03通过，新增回归待实现/执行**。jsdom尺寸和capture模拟不证明WebKit原生捕获 |
| V-03 | 拟新增 `GitLogResize.integration.test.tsx`，实际组件/实际库 | 显式解除全局库mock，fixture两个提交/两个文件；Log↔Changes反复10次，S1居中和靠近S4、S3/S2交替拖20次；模拟真实Group rect和可控observer | 只选中组改变，内外结束各自释放；loading/可见性变化后可再次拖；文件不串选择；父组resize使Diff正确重测；若改百分比，用不同Group宽度验证最终比例而非单独props断言 | C-02（新增后）；**待实现/执行**；真实引擎hit-test与CSS布局另归V-06 |
| V-04 | 现有相邻组件测试；具体文件见C-03 | Git Log同commit刷新保留文件；聚合按repo取blob；EOL/可编辑右侧保存；MainLayout折叠/展开；需要时增加TASK-03直接回归 | 读取/选择/保存行为保持，存储key不变，非文本/加载保持；真实终端首列选择由V-06确认 | C-03；本轮仅C-01的4个文件已过，其余**待执行** |
| V-05 | 前端编译+兼容审查+QA功能目录 | 集成提交，全部受影响TS/CSS/库版本；若控件有变按现有工具更新目录并审计 | 类型/构建通过；无新增平台路径/语法/API缺口；case数/skip原因明确、目录一致。不把build视为native证明 | C-04/C-05；**待执行** |
| V-06 | 当前Linux Tauri真实鼠标与相邻功能 | §8完整步骤，实际鼠标/原生事件，普通及长行fixture；S1/S2/S3/S4；比例/窗口/释放矩阵 | AC-01～08，故障前后同一动作和宽度数据；viewport截图/录屏辅证，真实repo hash/index确认无意外写入 | C-06或C-07启动后手工；**待执行** |
| V-07 | 原报告Linux/Mint复测 | 取得报告机相同版本/桌面/缩放/session；先重现旧行为，再验证修复；按S2/S3身份各20次 | 主问题修复前失败/后通过；Mint分开记录失败次数及首个事件，同源结论有trace支持；未取得原环境保留未验证 | §8步骤；**待执行，原环境信息待补充** |
| V-08 | Windows 11、macOS原生对照 | 与V-06同fixture、同内容W；正常按住、释放、取消和页面切换；Windows可补native case，macOS手工 | 各自AC-01～08结果与环境，不从其他平台或历史文档推导通过 | C-06/C-07及手工；**两端均待执行/未验证** |

### 7.2 已有自动化的实际证明范围

`src/test/setup.ts:25` **全局mock了react-resizable-panels**；当前 `CommitLog.test.tsx` 与 `WorkspaceCommitLog.test.tsx` 还mock了DiffViewer。因此E-03只证明共享Diff组件在合成事件/尺寸中的行为，以及调用方文件选择等逻辑，不证明真实库与S1同时存在时的事件顺序。

现有 `qa-ui-auto-tests/cases/TC-GIT-DIFF-01-split-navigation-native.testcase.yaml` 的 `covers:[F26.1]`、`fixtures:[reset_db,git_diff_repo]`、`modes:[native]` 已登记，验证Log入口、ArrowRight调宽到52/Enter回50、导航行首及模式切换。它**没有真实鼠标拖动/宽度矩阵/Changes保存验证**，不能单独作为AC-01/02/03通过证据。F1.1的 `TC-001-main-interface-shell.testcase.yaml` 仅检查主侧栏separator存在，也不证明拖动。

当前catalog已有 `git-diff-splitter`、`git-diff-left-scroll/right-scroll`、`git-log-tab/commit/file` 等F26.1控件，S2归属F1.1。S3/S4上述两个testid是拟新增，当前未登记；实现时再次查重后由TASK-04登记F26.1，维护case的covers/controls并生成catalog。需要新case时先分配未占用ID，本文不冒充已创建用例。

qa-ui-auto提供 `drag_to`，但只是selector到selector且没有连续坐标/窗口矩阵断言；`native_pointer_drag` 是CodeMirror行列选择专用，不接受任意splitter像素路径。不要伪造YAML参数或把键盘case改标题冒充拖拽。实际连续几何与外窗释放由V-06/V-08手工完成；如使用独立浏览器harness，加载真实库+CodeMirror、fixture数据，按同一输入/断言测rect，并单独标记browser证据，无需扩展QA DSL或生产stub。

### 7.3 命令与前置条件

以下均从工程根目录执行。C-01已实际执行，其余是下游待执行命令；没有创建的测试须先按TASK完成。Node/pnpm依赖来自当前lockfile；`pnpm install`用于缺少依赖的环境。

```bash
# C-01：本轮已执行的精确命令，4文件/19测试通过。
pnpm test src/components/git/DiffViewer.viewport.test.tsx src/components/git/DiffViewer.eol.test.tsx src/components/git/CommitLog.test.tsx src/components/git/WorkspaceCommitLog.test.tsx

# C-02：拟新增测试完成后执行。
pnpm test src/components/git/GitLogResize.integration.test.tsx

# C-03：实现后相邻回归；修改hover时再加入该组件的现有测试文件。
pnpm test src/components/git/DiffViewer.eol.test.tsx src/components/git/GitPanel.test.tsx src/components/git/WorkspaceGitManager.test.tsx src/components/git/CommitLog.test.tsx src/components/git/WorkspaceCommitLog.test.tsx src/lib/diffWhitespace.test.ts src/layouts/MainLayout.test.tsx

# C-04：实现后的类型、构建、补丁检查。
pnpm build
git diff --check

# C-05：涉及controls/case变更时生成目录，再审计；不降低baseline来放行。
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.gen_testid_catalog
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --gate

# C-06：实际Tauri开发运行；须先设置§8的独立app-data。
pnpm tauri dev

# C-07：原生发布构建链的debug可执行程序，保留隔离覆盖能力。
pnpm tauri build --debug --no-bundle

# C-08：可选既有native控件smoke；先满足driver及隔离前置。
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --mode native --filter TC-GIT-DIFF-01 --workers 1
```

PowerShell的C-05/C-08先执行 `$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"`，再调用相同 `python -m ...`；其余pnpm命令相同。runner所需Python/Playwright/YAML依赖按技能环境安装；native需要匹配的`tauri-driver`与系统WebDriver，配置`app.native_binary`若不使用默认 `src-tauri/target/debug/taomni[.exe]`。检查每次实际case执行数与summary中的skip原因。

C-06/C-07需要Rust1.94+、protoc、完整Perl、Bash和平台Tauri依赖，参考`.github/workflows/release.yml`。macOS直接Cargo命令前按AGENTS先从根目录执行 `bash scripts/bundle-krb5-macos.sh stage`。本修复不改后端算法，Rust unit/integration不作为新增必需测试层；已读`src-tauri/tests/README.md`。若后续发现必须改Rust，则重新补该模块测试与本机编译，不能以本前端计划覆盖未知后端改动。

## 8. 真机复测手册

### 8.1 构建、隔离数据与fixture

| 平台 | 准备与执行环境 | 当前状态 |
|---|---|---|
| Linux（当前端） | 先记录Ubuntu/LXQt/X11及实际窗口系统、显示缩放、WebKitGTK运行版本；有图形会话。手工鼠标无需WebDriver；C-08需要`tauri-driver`、`WebKitWebDriver`。按release依赖构建当前commit | 环境部分已识别；未构建/启动被测app，V-06待执行 |
| 原Linux / Mint | 保存`/etc/os-release`、桌面环境及X11/Wayland、发行包来源、版本/二进制hash；不能把Ubuntu结果标为Mint通过；按报告设置先复现 | 版本及触发条件缺失，V-07待执行 |
| Windows 11 | 记录系统build、架构、WebView2 runtime、显示缩放；MSVC/Rust及release依赖；手工鼠标，C-08需匹配`msedgedriver.exe`/`tauri-driver` | 用户正常对照；本轮未验证 |
| macOS | 记录OS/架构、WKWebView/Safari对应版本、显示缩放；Xcode CLI/Rust及release依赖；使用手工原生流程，Tauri WebDriver在macOS不支持 | 待验证；不能只跑browser替代 |

使用纯本地Git夹具，无远端、SSH、账号或网络服务依赖。沿用已有脚本，创建两个提交、多块长行变更、已暂存short文件及未暂存long文件：

```bash
# 根目录；本命令将在指定report目录下创建独立repo和manifest，设计阶段未执行。
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.fixtures.git_diff_repo --output-root qa-ui-auto-report/git-log-diff-resize/fixture
```

保存输出的绝对`repo/manifest`路径，按manifest的 `commitA/commitB` 操作。`long-lines.txt` 共240行、每行2000字符，第20/120/220行第1700列A→B；worktree另在第30行有W标记；`short.txt` 已暂存。该长文件超过Diff自动渲染阈值，需点击**Render anyway**后再测S1。先以B的`same-size.txt`验证小文本，排除大文本保护/渲染影响；还可用新增/删除/空文件验证非对称正文。脚本manifest本身是未跟踪文件，基线`git status --porcelain=v1`须在脚本完全结束后重取，不能误报它为拖动写盘。

打开前在fixture repo目录读取 `git log -2 --oneline`、`git status --porcelain=v1`、`git diff --cached -- short.txt`，并记录文件hash。Tauri UI应显示两个提交及对应的staged/unstaged文件；后端blob的A/B/W内容与fixture一致，才证明不是browser stub或错误仓库。

隔离规则：`src-tauri/src/lib.rs:65` 的 `resolved_app_data_dir` 只在debug构建接受绝对 `NEWMOB_DATA_DIR`。Linux/Bash使用新的临时目录，不修改HOME：

```bash
resize_qa_profile=$(mktemp -d /tmp/taomni-git-log-resize-profile.XXXXXX)
NEWMOB_DATA_DIR="$resize_qa_profile/app-data" XDG_DATA_HOME="$resize_qa_profile/xdg-data" XDG_CONFIG_HOME="$resize_qa_profile/xdg-config" pnpm tauri dev
```

macOS的debug手工流程同样使用新临时目录和 `NEWMOB_DATA_DIR`；启动后核对实际app-data和WebView配置目录均属于隔离测试环境。若WebView偏好仍落入原用户profile，改用专用测试OS用户，不重定向HOME。Windows PowerShell在临时目录创建唯一子目录后启动：

```powershell
$resizeQaProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("taomni-git-log-resize-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $resizeQaProfile | Out-Null
$env:NEWMOB_DATA_DIR = Join-Path $resizeQaProfile "app-data"
$env:APPDATA = Join-Path $resizeQaProfile "roaming"
$env:LOCALAPPDATA = Join-Path $resizeQaProfile "local"
pnpm tauri dev
```

在专用终端/进程内设置上述变量；退出测试终端即可恢复父环境。手工与runner使用各自独立profile，不共用`reset_db`到开发者配置。C-08的runner会设置绝对native-appdata路径，仍须记录实际启动binary来源。release二进制不识别debug覆盖：用专用测试OS用户/VM验证原发行包，不宣称变量已隔离release数据。初次Vault流程只在隔离profile完成。

### 8.2 V-06/V-07/V-08逐步操作

1. 记录被测commit、工作树相关diff、版本、二进制路径/hash、runtime、DPR/显示缩放、窗口尺寸、输入设备、测试时间。Log与Changes使用同一运行实例；Windows/Linux对照明确是否同commit。日志、录屏写到 `qa-ui-auto-report/git-log-diff-resize/<platform>/<before-or-after>/`（待生成）。
2. 从侧栏Git仓库入口打开fixture，或从真实工作区打开Git标签；进入Log，选B及`same-size.txt`，Split。确认S1/S2/S3/S4与§2一致，记录每个元素的rect和当前 `aria-disabled`。不依赖隐藏页面的第一个重复testid。
3. 将S1正文外容器W调到1000±1或600±1，在未夹紧区间左右移动120px，使用真实鼠标按住、经过至少三个中间位置再释放。记录旧/中间/新左右宽度。原问题基线若仍不动，先完成V-01 trace；修复后相同动作必须改变几何。不能只拍最终截图或只断言aria-valuenow。
4. 对S2导航边界和S3提交列表边界分别做上述拖动，再上下拖动S4。记录每次只有对应组改变；Diff能按新容器重测。在主sidebar允许范围内测试，不把达到15%/40%限制或折叠行为当作故障。用边界25%/50%/75%高度及中段、靠近交点重复，记录是否有hover/menu覆盖。
5. S1、报告外层边界各往返20次；在S1的SVG填充与空白起拖对照。展开/关闭提交hover，再拖S3；切换Log/Changes10次、切另一Git标签再回、刷新同commit并换文件，仍须可调且选中正确。若Mint0/20，保留“未复现，条件未定”。
6. S1 W=1000/600/356/355/300各记录尺寸与可操作状态，恢复1000后验证偏好恢复；初始30:70、50:50、70:30（可行时）分别拖动，极限夹紧后反向能立即离开极限。窗口1440x900→1024x768→1440x900，实际内容W单独记录，不能把窗口宽度当Diff宽度。
7. 按住S1拖动后移出connector到正文再释放；移出应用窗口释放并移回；拖动中Escape、切到另一应用造成blur、切模式/文件或关闭Git标签。每次重新进入后不再跟随、光标/文本选择正常、下一次拖动有效。自然无法触发的pointercancel/lostcapture另由V-02合成验证并标证明边界；不要把合成DevTools事件记为原生输入。测试拖动期间真实改变外层/窗口宽度，预期取消并可再次拖。
8. 选择`long-lines.txt`、Render anyway；左右分别横向滚至不同位置，纵向滚动及切同步，拖动S1后仍在合法阅读位置，Next/Previous回到对应差异行首；连接图随新宽度/滚动对齐，文件列表和Log搜索/分支/提交菜单可用。查看新增、删除、空文本及媒体提示，再回普通文本继续拖。
9. 进入Changes，选择未暂存long文件和已暂存short文件，测试S1与文件/Diff外层separator；勾选文件、Stage/Unstage各一次，逐次用`git status`/`git diff --cached`检查只有显式动作改变index。在实际启用右侧编辑的入口输入唯一测试文本，调宽/双击后保存并从宿主读取该文件；未启用编辑的入口只做只读回归，编辑保存另在有效入口完成，不能记为全通过。
10. 单纯拖动阶段前后对fixture文件hash、`git status`及index diff进行比较，应一致；Changes显式保存/暂存阶段另记允许的差异。若S2有改动，打开一个本地终端验证从第一列拖选文字不会变成侧栏resize，再回Log拖S2。关闭重开应用：S2按原持久化布局恢复，S1按原卸载契约回50:50，不新增持久化。

开发时浏览器矩阵可以先发现CSS布局问题，但V-06必须在实际Tauri WebView和真实repo执行。其他两端缺设备不单独阻塞当前端实现交付；已知三端代码缺陷必须解决。当前端失败/未执行、空产物或skip不算真机通过。

### 8.3 证据与清理

每项记录 `AC/V、代码commit、相关未提交变更、app版本/路径/hash、OS/arch/WebView、桌面与session、缩放、窗口尺寸、S编号/W/左右rect、输入动作、结果、异常/取消原因、artifact路径、未覆盖项`。原始失败和修复后使用同一夹具与动作；报告数据脱敏，不录真实仓库内容或凭据。将单位测试控制台结果摘要保存在本文，真机trace/截图/录屏按上面的报告目录留存；跨机器交接附可取得的产物包，不能只给本机绝对路径。

原生runbook已阅读，但其R9 collector带Code Workspace专用gate，不能直接套用为Git证据；使用C-07/C-08和本节手册，按本问题AC/V记录。不要修改自动manifest把待测写为通过。`qa-ui-auto-report/`受gitignore保护，保留产物用于复核。

清理：关闭本次启动的Tauri/Vite/WebDriver与测试终端进程；移除临时DevTools监听/日志点；确认无活动capture、is-dragging或body样式残留；测试终端退出恢复环境变量。fixture和临时profile先保留到证据归档，需要清除时核对本次manifest/profile绝对路径，移到回收位置或仅删除这两个明确测试目录，不清空HOME、工程、真实Git仓库或开发者配置。本轮仅执行只读检查和既有单测，未创建原生profile/fixture或启动服务，无此类资源需要清理。

## 9. AC追踪与交付状态

| AC | 方案 | 任务责任 | 验证 | 所需证据与当前缺口 |
|---|---|---|---|---|
| AC-01 | SOL-01/02/03 | TASK-01/02/04/05 | V-01/02/03/06/07/08 | E-01报告、E-03合成基线已有；失败/修复后鼠标+宽度trace待生成 |
| AC-02 | SOL-01/02/04 | TASK-01/03/04/05 | V-01/03/04/06/07/08 | S2/S3身份与原生前后几何待生成；Mint未复现 |
| AC-03 | SOL-03/04 | TASK-02/03/04/05 | V-02/03/06/07/08 | 往返次数、逐次结果、交点/hover命中与capture证据待生成 |
| AC-04 | SOL-02/03/05 | TASK-01/02/03/04/05 | V-01/02/03/06/08 | E-03覆盖合成窄宽；真实窗口/父组尺寸矩阵及必要布局修复待执行 |
| AC-05 | SOL-03/04 | TASK-02/03/04/05 | V-02/03/06/07/08 | 现有cancel/blur合成基线通过；释放丢失、capture、卸载与真实外窗动作待测 |
| AC-06 | SOL-03/05 | TASK-02/03/04/05 | V-02/03/04/06/08 | E-03有选择/模式/加载基线；隐藏嵌套与真机重复操作待执行 |
| AC-07 | SOL-03/05 | TASK-02/04/05 | V-02/04/06/08 | E-03有编辑/滚动基线；真实滚动、编辑保存hash和无额外Git写入证据待生成 |
| AC-08 | SOL-04/05 | TASK-03/04/05 | V-04/05/06/07/08 | 三端静态路径已检查；实现后build/native、Changes文件操作/Compare/终端选择待执行 |

设计交付完成条件：本文具备基线、根因确定性、条件修复、任务及AC/V映射，文件/命令已按当前仓库核对。本轮E-03的19项测试通过只作诊断基线。实现交付另需确认所选因果链、相关修复前失败/修复后通过、必要自动化/三端代码检查和当前Linux真机结果；Windows与macOS尚未实测则明确保留后续计划。原报告机未取得时可以交付已确认的代码修复和当前端结果，但不能声称原Linux/Mint问题已经复测关闭。

## 10. 未决项、风险和回退

| 项目 | 影响/最小检查 | 受影响任务与解除条件 |
|---|---|---|
| 问题版本和原始截图缺失 | 可能是96d94536前实现或S1/S3目标差异；取得binary hash/版本及标明边界的截图，先在当前基线同W复测 | 不阻塞TASK-01/回归准备；未有失败边界前，相关TASK-02/03生产分支待确认 |
| 主Linux与Mint是否同源 | 当前Ubuntu/LXQt/X11不等于Mint；独立记录首次失败事件和20次结果 | TASK-05原报告复测待环境信息；不阻塞已证实分支和当前端验证 |
| 百分比意图未证实 | API数字=px是事实，不代表批量转百分比就是修复；用历史/正常尺寸与真实clamp结果核对 | 只阻塞SOL-02对应尺寸转换；保留现有配置直到因果证据成立 |
| SVG/捕获与库document事件竞争 | target stopPropagation不控制上游capture；扩大命中可引入错组拖动 | TASK-02/03需V-01首失败事件，TASK-04/05覆盖实际库与原生几何 |
| S2命中扩大侵入正文 | MainLayout已有终端第一列回归说明 | TASK-03改动须实际占位且V-06首列选择通过；不能只改fine/coarse数字 |
| 缺少真实几何自动化 | jsdom和既有native键盘case不足；qa-ui-auto无完整布局矩阵 | TASK-05执行手工真实鼠标，保留前中后测量/录屏；无需增加新的测试平台来解除 |
| WebView/API依赖缺陷尚未证实 | 不预先引入polyfill或升级；先取runtime和首个异常堆栈 | 只阻塞SOL-04依赖适配分支；确认后评估相邻Group受影响范围并补回归 |

优先顺序为TASK-01与回归准备，之后按证据选择TASK-02/03，TASK-04集成，TASK-05原生闭环。无须为普通实现选择再设设计审批门槛；若无法获取原环境，继续完成独立工作并保留准确未验证范围。

回退按最小补丁边界进行：S1命中/会话、外层尺寸/命中、条件依赖升级分别可回退；只回退本修复改动，保留已有96d94536能力和他人变更。没有数据迁移，回退不需要删除localStorage或Git数据；布局显示可能按旧约束重新夹紧，应记录但不清用户偏好。必要时先回退引发相邻回归的子补丁并保留失败测试；不得用关闭separator、禁用Linux交互或清空布局设置作为发布修复。
