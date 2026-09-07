# 编辑器性能与发布门禁详细设计

必读 [共享对比契约](./idea-2026-comparison.md)。本设计安排生产测量和必要优化，不从微基准推导用户输入延迟，也不声称本轮已经完成 IDEA 性能实测。三端实测分别记账，本轮原生交付平台为实际运行端。

## 统一测量与决策

每组记录设备/OS/WebView/JDK/IDEA build、Taomni source 与 build profile、fixture hash、warmup、N、全部 raw samples 和 nearest-rank p50/p95/p99。输入基线先采集再修改 hot path；restore 基线先采集再调整队列。对照组执行顺序交替，记录热/冷缓存和背景进程。进程、资源和 fixture 在 finally 清理，失败样本保留。

同产品 baseline/candidate 使用同 build profile、同计时边界与环境。IDEA 跨产品比较只能用双方都能观察的端点，例如用户 action 到可见内容/交互，不拿 Taomni keydown-to-DOM 与 IDEA 的屏幕显示直接计算倍数。采样无法提供共同端点时只报告各自事实，比较为 incomparable。

禁止把 runner step duration 当产品延迟。已有明确预算沿用且注明来源；没有专用预算时先记录 baseline/noise 与目标，不把通用 local-action 100ms 当冷启动预算。相同输入的 baseline/candidate 无回归采用重复基线测得的噪声范围，噪声估计在 candidate 前冻结并保留原始数据。绝对预算待正式确定时仍可测量和优化，但不得写“预算达标”或通过需要预算的验收。

<a id="ed-audit-005"></a>
## ED-AUDIT-005 输入延迟实测与热路径优化

### 目标、代码与 owner

连续输入 1 MiB 文本时 UI 及时响应，语义/历史不受优化破坏。5 MiB 如触发现有大文件降级，单独报告该模式，不与完整编辑模式混比。

Owner：`src/components/editor/workspace/CodeMirrorHost.tsx` 的 update/reconfigure，`CodeWorkspaceTab.tsx` 的 onChange 到 document owner 热路径，`editorPerformance.test.tsx`、`src/lib/performanceInstrumentation.ts` 及现有性能 collector。先沿当前 caller 确定 store owner，禁止仅运行 `scripts/buffer_authority_benchmark.ts` 的字符串/rope 模拟宣布产品提升。依赖 ED-AUDIT-001。

### 方案与异常

使用实际 mounted/native editor 输入，先测定位全量 toString、重复 setState/reconfigure 和无关 Git/LSP 后台活动；只修本卡 trace 证明的耗时。复用 stable props/compartment guards，不在本卡直接完成 buffer authority 大迁移。必要 extraction 明确 owner，不改变 shared-document、save、LSP、undo、crash recovery 的 authority。

应用一次编辑，观察文本与 UI readiness；采样保留 busy/failed 结果和文档 post hash，不能过滤最慢帧。probe observer 只观察，不注入状态或驱动动作，测量结束解除 instrumentation。若确认性能问题来自 scope 外引擎且无法在本卡改动，不用合成数字关闭。

### 对比与验收

生成固定文件：1 MiB Java-like 多行文本，5 MiB 同结构 stress fixture，另一个小文档验证普通编辑不回归。真实输入 N>=200、warmup>=20，重复至少两组并记录环境噪声。两端使用可比 editor intelligence 状态；IDEA indexing 等待完成。保存用户动作、caret、最后文档 hash 和 Undo。

- **ED-AUDIT-005-A1：** 真实输入链的 baseline 与 candidate raw samples、共同端点 IDEA 测量记录可重算 percentile；缺失/不可比数据不能产生 matched 或 no-regression 结论。
- **ED-AUDIT-005-A2：** 对 baseline trace 定位的本卡热路径完成代码优化并证明改善超出预先记录噪声；若当前实现已满足原目标，允许无重复实现，但须保留当前 source 的生产路径与无回归证据。小文档/1 MiB 文本、selection、undo、save 同步断言不变。
- **ED-AUDIT-005-A3：** 性能 collector 与 owner focused/typecheck、当前平台 native、performance/IDEA evidence 通过；预算尚未定义的项只能报告测量/no-regression，不报告绝对预算达标。

V-005：`pnpm exec vitest run src/components/editor/workspace/editorPerformance.test.tsx src/stores/appStore.test.ts` 为已有回归入口，必要时增加实际变化 owner 测试；按 native-testing.md 的 native_editor_performance 收集真实 keydown-to-DOM samples，明确它不是全 OS-to-screen。现有 `scripts/perf_baseline.py` 只作 Chromium 诊断。IDEA 屏幕计时采用相同采集器/分辨率并记录工具；当前不可实现共同计时端点则保留未验证，不编造新命令已可用。
必需证据：code-audit、unit、typecheck、performance、native、idea-comparison。

<a id="ed-audit-013"></a>
## ED-AUDIT-013 多标签恢复的可交互时机优化

### 代码事实与职责

`workspaceRestoreModel.ts` 的 planWorkspaceRestore 将 leaf active target 与 background target 分离；executeBoundedAsyncQueue 将 worker concurrency 限制在 2..4。CodeWorkspaceTab.tsx 3421 附近消费 plan。是否在 active-ready 前仍等待背景文件/active-file diff，需要真实 trace 验证。

Owner：`src/components/editor/workspace/workspaceRestoreModel.ts`、`useDeferredGitLineChanges.ts`、CodeWorkspaceTab.tsx restore effect，及相关性能 observation；依赖 ED-AUDIT-001、009。本卡不改变 tab close/reopen policy。

### 设计

定义三个时间点：打开 workspace 请求发出、focused active leaf 接受一次真实编辑且显示正确文本、全部 background restore 完成。先活跃 leaf，其他 leaf active 同样优先，但不得为了所有 active 完成而阻止已准备好 focused editor 输入。复用有界队列，后台 read 失败只影响对应 tab；取消 owner 后不发布结果，晚到 read 不覆盖用户已输入文本。

将 Git diff/诊断昂贵工作延迟到当前 file ready，cache identity 保持 path+HEAD+revision；用户切换 tab 后新 active 任务优先且不重复读取同一 document。优化不能把需要的工作永久跳过伪装低 TTI。

### 场景与验收

固定 24 tabs、2 leaf（明确 active 文件），同一干净 fixture 与一个读取失败文件变体；分别冷启动与已运行重开 workspace，记录哪个文件何时 read/ready，active-ready 后输入 X。IDEA 用相同 tabs/layout 的工程打开动作；插件/JDK/indexing 与缓存前提完整记录。每种不少于 20 次 measured run、3 次 warmup（冷启动 warmup 单列，不改变测量 cache 定义），同时保留 all-ready 和失败数量。

- **ED-AUDIT-013-A1：** active-ready 和 all-ready 两组 raw timing 可重算，未把全恢复时长误用为编辑器输入就绪；IDEA 同动作可比端点与 delta 明确。
- **ED-AUDIT-013-A2：** 生产 trace 证明有界并发、active 优先、每文件失败隔离和取消不发布；若存在 active 被阻塞则完成 owner 优化；ready 后输入不被迟到 restore/Git diff 覆盖。
- **ED-AUDIT-013-A3：** 同条件 candidate 相对 baseline 无超出已测噪声的回归，24 tabs 状态/编辑/关闭重开均正确；unit/typecheck、当前 native、performance 与 IDEA evidence 通过，不套用无来源的 100ms restore 预算。

V-013：`pnpm exec vitest run src/components/editor/workspace/workspaceRestoreModel.test.ts src/components/editor/workspace/useDeferredGitLineChanges.test.tsx src/lib/performanceInstrumentation.test.ts`；TC-IDE-C4-02 只作功能回归，另建本卡 restore measurement fixture（拟新增）。记录 read postconditions、并发数、丢失 tab 数和原始计时。
必需证据：code-audit、unit、typecheck、performance、native、idea-comparison。

<a id="ed-audit-006"></a>
## ED-AUDIT-006 当前源码门禁与能力发布矩阵

### 交付物与范围

Owner：本任务板、各卡 evidence 引用、本板拟新增 `claudedocs/code-workspace-idea-2026-capability-matrix.md`；复用 `qa-ui-auto-tests/release-evidence-plan.json` 和现有 status/rollup，必要范围调整按现有 release-plan schema。依赖本板所有行为卡 done，不自己实现其他卡的产品功能或再次扩张整个 editor backlog。

本板独家持有全仓 build evidence。旧板数据仍保留原状态；不因历史 failed/check 或不必需 unrun 直接批量降级。

### 验证和失败处理

运行当前源 `pnpm build` 并收集完整 exit code/output。命令超过工具一次 yield 不是 build 失败，应继续等待 session；真实 timeout/cancel 记录未完成，不能自动推断 TS 错误。失败需定位实际文件和所属卡，把新发现 bug 放对应 owner 待修任务，不能排除编译文件或 skip 测试。

矩阵每行是 capability + fixture + IDEA build + provider + 平台 + mode + source identity，分别记录 baseline/result/negative/undo、unit、native、performance、accessibility、idea-comparison 和未运行原因。只计算同分母可比样本，不用若干单卡 done 推导整个编辑器百分比对齐。

静态 catalog 与实际执行分开，保留最新 current failure/skip；手工 macOS/IDEA 证据单列，不能造 summary/receipt。行为卡 evidence 随 source drift 失效时安排重新执行相关 scope，不能仅更新时间戳。此卡不要求每个能力强行补未规定的 a11y/performance，缺失项在矩阵标 unverified。

### 验收与验证

- **ED-AUDIT-006-A1：** 当前 source 的 pnpm build exit 0；QA audit --gate 通过并保留 counts；真实失败不被历史 pass 或局部 scope 隐藏。
- **ED-AUDIT-006-A2：** 本板每个 A ID 回链到具体实现/当前可获取 evidence；矩阵有 Windows/Linux/macOS 独立格，状态符合 summary/receipt/source/case/runner identity；手工与自动化执行无混淆。
- **ED-AUDIT-006-A3：** 在选定且非空的本板 case/feature 范围运行 status --gate，审阅通过/失败/跳过及未覆盖范围；需要 release manifest 的条目通过 audit --release-evidence，不合格项不能宣称 release-ready。

V-006：`pnpm build`；设置 PYTHONPATH 后 `python -m qa_ui_auto audit --gate` 与 `python -m qa_ui_auto status --json`，根据实际 feature/case 选择明确 gate 范围（参照 comparison.md）。`task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md validate` 必须通过。既有单元/集成结果如因源变化失效，由卡 owner 范围复跑；无关功能不在此扩大验证。
必需证据：code-audit、build、qa-lint、document。只要某行为所需的当前证据失败，矩阵保持未通过而不是生成绿 summary。

