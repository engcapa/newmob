# Code Workspace IntelliJ IDEA Editor 对齐待办

> 审计日期：2026-08-29
> 代码基线：`2ae34fecfb70189e96d98047ec9c044e7c0d51c3`
> 参考产品：IntelliJ IDEA 2026.2 公开 Code Editor 工作流
> 状态：当前唯一可领取的 Editor parity backlog
> 历史设计与审计：[`code-workspace-ide-design.md`](./code-workspace-ide-design.md)

## 1. 文档职责

本文只回答四个问题：当前代码真实具备什么、与 IDEA 2026.2 还差什么、下一项可独立交付的小任务是什么、完成声明由什么证据支持。

- 本文是当前任务状态的权威来源；原 9,000 余行设计文档保留架构、交互、历史审计和旧合同，不再从其中直接领取任务。
- 本文不复制历史轮次。旧 `N* / W* / V* / U* / X* / Y* / Z* / AA* / BB*` 编号只写在任务的 `legacy` 字段中用于追溯。
- 任务完成不等于整个能力已与 IDEA 等价。任务 `done` 只表示该任务卡的单一结果和验证完成；能力等级仍按 L0-L3 单独判断。
- 官方帮助页只证明 IDEA 提供相应工作流；Taomni 状态只由当前 production chain、可观察 effect、失败语义、undo/recovery 和实跑证据决定。
- Build/Run/Debug/Test/Coverage、Terminal、完整 Git 客户端、AI 和远程工作区不计入 Code Editor parity，除非任务只验收它们在编辑器内的入口或装饰。

## 2. 对齐目标与等级

### 2.1 交付层级

| 层级 | 目标 | 对外允许声明 |
|---|---|---|
| G0 | 编辑完整性：保存、剪贴板、WorkspaceEdit、资源生命周期、异步身份和 undo/recovery 不丢数据、不跨 workspace | 只允许说明具体正确性门禁已通过 |
| G1 | Core Daily Editing：文本、选择、多光标、tabs/splits、搜索、Basic Completion、Reference Info、diagnostics/quick fix、基础导航、format/import、keymap | 某平台全部 L2 后可称 `IDEA-like daily editor workflow validated on <platform>` |
| G2 | Java provider-backed semantic workflow：真实 jdtls + JDK 21 + Maven/Gradle project facts，覆盖 completion/import/navigation/usages/hierarchy/refactor | 只按 capability 和 fixture 逐格声明 |
| G3 | Advanced：Smart/Type-Matching、Full Line、SSR、Code Vision、scratch/injection、完整 inspection/refactor、detach 等 | 前置未满足时保持 deferred，不得用占位模型冒充 |

### 2.2 能力等级

| 等级 | 判定 |
|---|---|
| L0 | 无生产入口，或入口不产生承诺结果 |
| L1 | UI/命令/协议已接，但 effect、失败、undo、scope 或 provider 真实性未闭环 |
| L2 | 真实主路径、取消/失败、状态同步、undo/recovery 和聚焦自动化闭环，限制可见 |
| L3 | 同 fixture 的 IDEA observed 对照、目标平台 native、性能和 a11y 证据均通过 |

## 3. IDEA 2026.2 事实源

本轮重新读取的 JetBrains Help 页面均返回 `200`，页面 build time 为 `2026-08-18`，主要页面标注最后修改于 `2026-08-17`。任务验收对齐公开用户结果，不复制 JetBrains 私有 PSI 或 ranking 实现。

| 能力族 | 官方来源 | 本 backlog 的校准点 |
|---|---|---|
| 编辑基础、文本与 split | [Editor basics](https://www.jetbrains.com/help/idea/using-code-editor.html)、[Write and edit source code](https://www.jetbrains.com/help/idea/working-with-source-code.html) | tabs、任意 split、breadcrumbs、font、virtual space、copy/paste、selection、statement editing、folding 是不同可验收工作流 |
| Completion | [Code completion](https://www.jetbrains.com/help/idea/auto-completing-code.html) | Basic、重复调用、Smart/Type-Matching、排序、exclude/prioritize、auto-import 分开记账 |
| Reference information | [Code reference information](https://www.jetbrains.com/help/idea/viewing-reference-information.html) | Parameter Info、Quick Documentation、External Documentation、Type Info、Expression Static Data 不能互相替代 |
| Intention 与 inspection | [Intention actions](https://www.jetbrains.com/help/idea/intention-actions.html)、[Code inspections](https://www.jetbrains.com/help/idea/code-inspection.html) | provider diagnostic presentation 不等于 IDEA inspection/data-flow engine |
| 导航、搜索与 usages | [Source code navigation](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)、[Search Everywhere](https://www.jetbrains.com/help/idea/searching-everywhere.html)、[Search for usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html) | definition/type/implementation/usages/hierarchy、history、Show/Find Usages、scope/role/completeness 分格验收 |
| Tabs 与多光标 | [Editor Tabs](https://www.jetbrains.com/help/idea/editor-tabs.html)、[Multiple cursors](https://www.jetbrains.com/help/idea/multiple-carets.html) | preview/pin/order/limit/open-close policy、split，及 caret clone/occurrence/rectangle/paste distribution 分开验收 |
| Format、EditorConfig 与 import | [Reformat code](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html)、[EditorConfig](https://www.jetbrains.com/help/idea/editorconfig.html)、[Auto import](https://www.jetbrains.com/help/idea/optimizing-imports.html) | selection/file/directory/module、markers/exclude、save actions、rearrange/cleanup、import policy 分层 |
| Keymap | [Keymap](https://www.jetbrains.com/help/idea/settings-keymap.html) | scheme、按 action/shortcut 搜索、增删绑定、冲突和平台键盘差异均属于工作流 |
| Refactor | [Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html) | usages、preview、conflict、scope、apply、postcondition 和统一 undo 缺一不可 |
| Advanced | [Structural search](https://www.jetbrains.com/help/idea/structural-search-and-replace.html)、[Full Line completion](https://www.jetbrains.com/help/idea/full-line-code-completion.html)、[Live templates](https://www.jetbrains.com/help/idea/live-templates.html)、[Postfix completion](https://www.jetbrains.com/help/idea/postfix-code-completion.html)、[Generate code](https://www.jetbrains.com/help/idea/generating-code.html)、[Surround code](https://www.jetbrains.com/help/idea/surrounding-blocks-of-code-with-language-constructs.html) | 只在 provider/runtime、license/privacy、failure/offline 和资源预算明确后重开 |

## 4. 当前代码重判

### 4.1 基线事实

- `c7f76513..2ae34fec` 的 Editor production 增量只有提交 `f0516fa4`：修正 QA diff false positive，并恢复 Clipboard Provider/lease/revision 的一部分；`2ae34fec` 只删除无关旧文档。
- `qa_ui_auto.audit --diff c7f76513`：142 cases、80 features、0 lint error、0 orphan、catalog current、0 broken case；全产品仍有 18 missing required controls，但都不属于 Code Workspace。该结果只关闭旧 `33 broken cases` 误报，不证明 Editor effect。
- 本轮第一次完整 `pnpm test` 为 349/349 files、3165/3165 tests，exit 0，约 332 秒；这是一条绿色样本，不满足连续两次确定性门禁，也不证明 native/provider/IDEA effect。
- `pnpm build` exit 0，TypeScript 与 Vite production build 共转换 4629 modules；这证明当前共享 contract 和 production wiring 可编译，不替代行为或 native 验证。
- `qa_ui_auto.audit --gate` exit 1 的原因是仓库当前 release evidence 为 0；control coverage 没有基线回退且由 348 提升到 353。该 gate 失败属于发布证据缺口，不应误报为 Editor control 回归。
- Clipboard root Provider 已挂载，CodeMirror 能取得 handle；但当前 mounted test 只读 store，没有创建两个 split、执行 copy/paste、断言目标文本或 undo。
- 其余 `BB2-BB12` 没有 production 增量，因此原文档 `§2.38/§8.27` 对 Save、Tabs、Virtual Space、Code Action、Completion、Semantic Query、Project Facts 和 native matrix 的关键断点仍成立。
- `qa-ui-auto` 只覆盖 functional/control-level E2E；不提供视觉回归、viewport matrix、a11y、性能或三端 native 等价证明。

### 4.2 能力快照

| 能力域 | 当前最高事实 | 等级 | 主要剩余问题 |
|---|---|---:|---|
| 文本、选择、常用命令 | CodeMirror 查找、折叠、注释、多光标/矩形、Move Statement、Clone Caret、Join Lines、templates/surround/generate 等已有入口 | L1-L2 分项 | 高级 Find/Replace、同文档多 split 共享 undo、native 输入/IME 和行为型矩阵未闭环 |
| Clipboard | history、copy reference、multi-caret paste plan、root Provider 已存在 | L1 | duplicate lease token 所有权错误；permission adapter/async epoch 缺失；无真实跨 split effect + undo case |
| Tabs / layout | recursive split、preview/pin/reopen/switcher、tab policy UI/model 已存在 | L1 | revision 仍为 component local；policy commit 与资源清理非原子；C4 不测 policy lifecycle |
| Virtual Space | position/model/keymap 与设置存在 | L1 | CodeMirror keymap 仍是第二行为 owner；Page movement 使用固定 geometry；composition/multi-caret effect 未闭环 |
| Basic Completion | 真实 LSP/jdtls 基线、snippet/resolve gate、排序/auto-popup 设置已存在 | L1-L2 分项 | typed resolve outcome、稳定 identity、primary+additional edits 一次 undo、module/project scope facts 缺失 |
| Reference Info | Parameter Info、QuickDoc、External Documentation、Type Info/Static Data typed unavailable 入口存在 | L1-L2 分项 | provider generation/cancel/native evidence 不完整；不可把 unavailable 入口计为语义实现 |
| Diagnostics / Code Action | Problems/Analysis、provider diagnostics、Alt+Enter、suppression presentation、WorkspaceEdit preview/undo 已存在 | L1 | 多入口仍直接组合旧 request/resolve/run；resolve failure/plan-only/postcondition/history 不统一 |
| Navigation / usages / hierarchy | definition/type/implementation/references、Show/Find Usages UI、call/type hierarchy 与 history 模型存在 | L1 | query host 丢参数/取消链不完整；history 写入时机错误；真实 provider/result session/hierarchy expand 证据缺失 |
| Save / style | PreparedSave、typed write errors、EditorConfig/code-style/save normalization 局部存在 | L1-L2 分项 | organize imports 绕 canonical action service；stage/identity/final bytes/one-writer receipt 不完整；native bytes 未闭环 |
| Project facts | descriptor-only containment 局部存在 | L1 | 无可信 Maven/Gradle tooling ingestion、trust/cache generation 和 completion/query/refactor 三 consumer |
| Appearance / keymap | 可编辑 scheme、冲突 UI、font/ligature/soft-wrap/virtual-space/breadcrumb settings 存在 | L1-L2 UI | physical keymap、200% scale、screen reader、三端、state-preserving runtime update 未完成 |
| Evidence / release | synthetic evidence 隔离、旧 validator/rollup 存在 | L1 | current evidence 为 0；release scope、真实 effect observation、native/provider/IDEA matrix 未闭环 |
| Advanced | 若干 experimental fixture/model 存在 | L0 | 无 production owner/runtime；保持 deferred |

## 5. 任务板协议

任务元数据位于每张任务卡标题下的 `ide-task` JSON 注释中。使用 `.agents/skills/code-workspace-idea-task/scripts/task_board.py` 领取和更新，避免手工改错状态。

状态只允许：

- `ready`：任务已定义且未领取；只有依赖全部 `done` 时才是 claimable。
- `claimed`：已登记 owner/baseline，尚未开始 production 修改。
- `in_progress`：实现或验证进行中。
- `blocked`：存在已记录、可复现的外部或前置阻断。
- `done`：本任务单一结果与卡内验证全部完成；不自动提升整个能力等级。
- `deferred`：当前范围明确不领取。

领取规则：依赖必须全部 `done`；一个 agent 一次只领取一张卡；任务不得顺手扩成同能力域的下一张卡。若代码已超前，先用现有 production evidence 证明，再把卡标为 `done` 或重写剩余 DoD，禁止重复实现。

通用完成条件：

1. 追踪 `用户入口 -> production owner -> provider/IPC -> typed result/effect -> failure/cancel/stale -> undo/recovery`，并在回写中列出真实链路。
2. 行为改变先有能在任务 baseline 失败的聚焦测试；若是纯审计/证据任务，先有能暴露缺口的检查或 fixture。
3. 运行聚焦 Vitest；共享 TS contract 运行 `pnpm build`；Rust 改动运行受影响测试并只对改动 `.rs` 执行 `rustfmt --edition 2024`。
4. UI surface/control/case 变化遵循 `qa-ui-auto` 的 `audit -> fix one gap -> audit`；不得用 screenshot 代替文本/effect 断言。
5. 未运行的 native/provider/perf/a11y/IDEA 步骤必须显式写 `not run`，不得外推。
6. 回写任务元数据和一条简短 evidence；不重写其它任务，不覆盖并发改动。

## 6. P0 正确性与 Daily Editor 闭环

### ED-GATE-001 稳定当前前端回归基线
<!-- ide-task {"id":"ED-GATE-001","status":"done","priority":"P0","size":"S","owner":"editor-agent-01","claimed_at":"2026-08-29T06:00:36Z","baseline":"af361ebf3bb9f855847d23cb45ed84ac4b40fe3f","depends_on":[],"legacy":["BB0-A"],"updated_at":"2026-08-29T06:19:02Z","evidence":"focused useDeferredGitLineChanges 3/3; SettingsPanel 16/16; 2x full pnpm test 349 files / 3166 tests exit 0; pnpm build exit 0; cargo test --lib 1302 passed exit 0; qa audit --diff exit 0"} -->

- 结果：隔离 Settings appearance 与 Code Workspace Git gutter 的首轮时序失败；连续两次干净 `pnpm test` 结果一致，失败时保留 root cause，不延长 timeout 或删除断言。
- 主文件：对应失败测试和实际 owner；不要把 Settings 与 Editor 根因混在一个提交。
- 验证：两个聚焦用例各重复运行，随后连续两次完整 `pnpm test`。

### ED-GATE-002 固化可复现的 Editor 基线记录
<!-- ide-task {"id":"ED-GATE-002","status":"done","priority":"P0","size":"S","owner":"editor-agent-01","claimed_at":"2026-08-29T07:30:49Z","baseline":"7c5b6bf55cec53200e62d70807f1d943b1dc85b2","depends_on":["ED-GATE-001"],"legacy":["BB0-C"],"updated_at":"2026-08-29T07:39:16Z","evidence":"focused 17/17; verify-deterministic exit 0; pnpm build exit 0; cargo test --lib 1302 passed exit 0; pnpm test 349 files / 3166 tests exit 0; qa audit --diff exit 0"} -->

- 结果：生成只读、非 release claim 的 baseline summary，记录 source commit/tree、命令、test file/test count、exit 和失败列表；相同输入可重复生成。
- 主文件：`.agents/skills/qa-ui-auto/scripts/` 下独立 helper 与测试；不得写 current release evidence。
- 验证：相同 HEAD 两次输出 byte-identical；dirty/untracked product input 显式标记。

### ED-CLIP-001 修复 consumer lease 的 token 所有权
<!-- ide-task {"id":"ED-CLIP-001","status":"done","priority":"P0","size":"S","owner":"editor-agent-01","claimed_at":"2026-08-29T07:50:04Z","baseline":"6305e60b19da8554373204b6d0822b7aa2caf88e","depends_on":[],"legacy":["BB1"],"updated_at":"2026-08-29T07:59:35Z","evidence":"focused 35/35; CodeWorkspaceTab+Popup 83/83; pnpm build exit 0; cargo test --lib 1302 passed exit 0; pnpm test 349 files / 3171 tests exit 0; qa audit --diff exit 0"} -->

- 结果：duplicate `consumerId` 返回 typed conflict 或独立 token；任一 `detach()` 只删除自己的 token，旧 lease 绝不删除后来 lease；root acquisition 与 consumer lease 计数分账。
- 主文件：`workspaceClipboardSession.ts` 及其测试。
- 验证：重复 id、任意 detach 顺序、双 workspace 同路径、幂等 detach、last-root release。

### ED-CLIP-002 接入真实 clipboard permission epoch
<!-- ide-task {"id":"ED-CLIP-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T08:38:19Z","baseline":"f6cbe75a9f659c5107d213f96eb7e0c1691bcac1","depends_on":["ED-CLIP-001"],"legacy":["BB1"],"updated_at":"2026-08-29T08:43:33Z","evidence":"focused 45/45; CodeMirrorHost 27/27; CodeWorkspaceTab 78/78; pnpm build exit 0; qa audit --diff exit 0; unrun: native clipboard OS backend matrix (ED-CLIP-004/BB11)"} -->

- 结果：root owner 使用 native/web permission adapter；system read/write 在 await 前后重验 session/policy/permission generation；denied 与 mid-await change 返回 typed 结果，系统 effect 为 0。
- 主文件：`workspaceClipboardSession.ts`、`workspaceEditorCommands.ts`、clipboard adapter 与测试。
- 验证：granted/denied/unknown、permission mid-await、same-value 不增 generation、workspace fallback 可见且不伪称系统成功。

### ED-CLIP-003 建立真实跨 split copy/paste/undo mounted test
<!-- ide-task {"id":"ED-CLIP-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T08:43:48Z","baseline":"e456d20284d23069db78ee6143c4ad41fb7f9d70","depends_on":["ED-CLIP-001"],"legacy":["BB1","BB10-C3"],"updated_at":"2026-08-29T08:58:07Z","evidence":"focused CodeWorkspaceTab 80/80; clipboard 45/45; CodeMirrorHost 27/27; pnpm build exit 0; qa audit --diff exit 0; unrun: native clipboard OS backend matrix (ED-CLIP-004/BB11)"} -->

- 结果：mounted `CodeWorkspaceTab` 创建两个真实 CodeMirror leaf，从 A copy、B paste，断言文本/selection/consumer lease，单次 undo 恢复 B；同文件双 split 与不同文件双 split 都覆盖。
- 主文件：`CodeWorkspaceTab.test.tsx`、必要的 test seam；production 只修测试暴露的最小问题。
- 验证：StrictMode、multi-caret segments、workspace close lease cleanup、一次 undo。

### ED-CLIP-004 升级 C3 为行为型 clipboard case
<!-- ide-task {"id":"ED-CLIP-004","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T08:58:27Z","baseline":"83b805b9717bde5bb18351d0d0e28142dfbf6101","depends_on":["ED-CLIP-002","ED-CLIP-003"],"legacy":["BB10-C3","BB11"],"updated_at":"2026-08-29T09:05:12Z","evidence":"qa lint 142/142; TC-IDE-C3-01 dry-run passed; audit --diff exit 0; focused clipboard 72/72; pnpm build exit 0; unrun: native permission matrix & OS level denial (R9 manifest / BB11)"} -->

- 结果：`TC-IDE-C3-01` 不再只按键+截图；断言目标文本、history selection、payload/history revision、lease cleanup 和 undo。OS permission 格保留 native，并明确层级。
- 主文件：C3 YAML、F25 controls/catalog、只读 observation seam。
- 验证：qa audit、dry-run、browser case；native permission 步骤未跑时保持对应格 blocked。

### ED-TABS-001 把 layout revision 收归 workspace store
<!-- ide-task {"id":"ED-TABS-001","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:05:31Z","baseline":"d2e2665042bdbb8fbe9fca4d9a269fd7978665ac","depends_on":[],"legacy":["BB3"],"updated_at":"2026-08-29T09:18:58Z","evidence":"vitest layout & workspace tests (138/138 passed); pnpm build exit 0; qa lint (142 files, 0 errors, 0 orphans); audit --diff exit 0"} -->

- 结果：`layoutRevision` 成为 workspace-instance store 单一真值；open/close/move/pin/preview/split/unsplit/resize/policy eviction 全部经 reducer 递增；删除 component-local 真值。
- 主文件：`codeWorkspaceStore.ts`、`CodeWorkspaceTab.tsx`、layout/store tests。
- 验证：每类 mutation 的 revision、no-op 不递增、两个 workspace 隔离、fresh restore。

### ED-TABS-002 原子化 Tab Policy plan/commit
<!-- ide-task {"id":"ED-TABS-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:19:17Z","baseline":"1c183f3aa6c88b98455d523150cef8fb0bcc603b","depends_on":["ED-TABS-001"],"legacy":["BB3"],"updated_at":"2026-08-29T09:25:18Z","evidence":"vitest tab policy suite (22/22 passed); all tab policy tests (73/73 passed); full CodeWorkspaceTab suite (80/80 passed); pnpm build exit 0; qa lint (142 files, 0 errors, 0 orphans); audit --diff exit 0"} -->

- 结果：`TabPolicyPlan` 冻结 pre/post image、dirty keys、view/resource ids 和 base revisions；confirm 后同步重验；store 一次提交 layout+policy+snapshot 并返回 typed receipt。
- 主文件：`workspaceTabPolicy.ts`、store、Settings dialog/controller 与测试。
- 验证：dirty/non-dirty、confirm 期间变化、cancel zero effect、stale zero commit、持久化失败 recovery。

### ED-TABS-003 建立 view/resource recovery coordinator
<!-- ide-task {"id":"ED-TABS-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:25:31Z","baseline":"07a351be2be924a3452b68aca70f517a110a4b28","depends_on":["ED-TABS-002"],"legacy":["BB3"],"updated_at":"2026-08-29T09:30:19Z","evidence":"workspaceResourceRecoveryCoordinator.test.ts (5/5 passed); all tab policy tests (78/78 passed); full CodeWorkspaceTab suite (80/80 passed); pnpm build exit 0; qa lint (142 files, 0 errors, 0 orphans); audit --diff exit 0"} -->

- 结果：最后一个 view lease 释放后按 `didClose -> watcher -> buffer -> history` 执行；cleanup failure 返回 `committed-with-recovery` 并可幂等重放，不能吞错后返回 applied。
- 主文件：resource state/recovery coordinator、CodeWorkspaceTab owner、测试。
- 验证：同文件双 split、diff/preview/save lease、每资源一次、任一步失败与 replay。

### ED-TABS-004 升级 C4 为 Tab Policy lifecycle case
<!-- ide-task {"id":"ED-TABS-004","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:30:57Z","baseline":"48da37bb4edc7295e231506898820e2c2522c12e","depends_on":["ED-TABS-003"],"legacy":["BB10-C4"],"updated_at":"2026-08-29T09:35:24Z","evidence":"Upgraded TC-IDE-C4-01 to tab policy lifecycle case; separated TC-IDE-C4-02 for split/reopen; added tab-policy controls to F25.5; qa lint (143 cases, 0 errors, 0 orphans); dry-run TC-IDE-C4-01 & C4-02 (2 passed); pnpm build exit 0"} -->

- 结果：C4 从 Settings 打开 Tab Policy、修改 limit、确认 dirty，断言 post-layout、active tab、resource close/recovery counters；原 split/reopen 流程拆成独立 case。
- 主文件：C4 YAML、feature controls、observation contract。
- 验证：qa audit/dry-run/browser；native key-release Switcher 单列未验证格。

### ED-VSPACE-001 统一 Virtual Space action owner
<!-- ide-task {"id":"ED-VSPACE-001","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:35:39Z","baseline":"bdebe152b3000c1ffcb8bb41ca08162884192c87","depends_on":[],"legacy":["BB4"],"updated_at":"2026-08-29T09:51:49Z","evidence":"vitest: workspaceVirtualSpace.test.ts, workspaceKeymapRuntime.test.ts, CodeMirrorHost.test.tsx, CodeWorkspaceTab.test.tsx; pnpm build; qa-ui-auto lint"} -->

- 结果：horizontal/vertical/Page/Shift-Page/Tab 全部注册到 workspace ActionHost；CodeMirror keymap 只路由 action id；移除 `virtualSpaceKeymap` 与 controller keymap 的第二行为真值。
- 主文件：`workspaceVirtualSpace.ts`、`workspaceActionRegistry.ts`、`CodeMirrorHost.tsx`、tests。
- 验证：menu/palette/keymap 同 definition，同一按键一次 dispatch，非 owner focus zero dispatch。

### ED-VSPACE-002 使用真实 display geometry 实现 Page movement
<!-- ide-task {"id":"ED-VSPACE-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:52:12Z","baseline":"f0a036138144874f57f2ccaacad0abb87b5b4ebb","depends_on":["ED-VSPACE-001"],"legacy":["BB4"],"updated_at":"2026-08-29T09:58:19Z","evidence":"vitest: workspaceVirtualSpace.test.ts, workspaceKeymapRuntime.test.ts, CodeMirrorHost.test.tsx; pnpm build; qa-ui-auto lint"} -->

- 结果：读取 CodeMirror line blocks、viewport rectangle 和实际 line height；soft wrap 按 visual block；geometry 未 ready 返回 unavailable 并交回默认 handler；删除固定 15 行 fallback。
- 主文件：virtual-space geometry adapter、CodeMirror host、tests。
- 验证：resize、soft wrap、top/bottom、tabSize 2/8、wide grapheme、virtual bottom。

### ED-VSPACE-003 闭合 multi-caret/selection/composition transaction
<!-- ide-task {"id":"ED-VSPACE-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T09:58:33Z","baseline":"3a0dd32fe6b0e354b421248648735686833948d8","depends_on":["ED-VSPACE-002"],"legacy":["BB4","BB10"],"updated_at":"2026-08-29T10:01:45Z","evidence":"vitest: workspaceVirtualSpace.test.ts, workspaceKeymapRuntime.test.ts, CodeMirrorHost.test.tsx, workspaceActionHost.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：每 caret 独立 desired visual column/anchor；Shift 只扩缩；padding 一次 transaction；composition、AltGr、dead key 不误 dispatch。
- 主文件：virtual-space controller/host tests 和新行为 case。
- 验证：多 caret、短行、一次 undo、browser case；Linux IME 留 native matrix。

### ED-ACTION-001 定义 canonical Code Action service 核心
<!-- ide-task {"id":"ED-ACTION-001","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T10:02:00Z","baseline":"178c75df23de9b17f6abf4a351e2dda7e975b099","depends_on":[],"legacy":["BB5"],"updated_at":"2026-08-29T10:08:26Z","evidence":"vitest: codeActionProviderAdapter.test.ts, codeActionExecution.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：唯一 service 实现 `capability -> request -> stable id -> resolve -> immutable plan`，带 typed failure 和 document/diagnostic/provider/project/trust identity；unknown/plaintext 不默认 Java。
- 主文件：`codeActionProviderAdapter.ts` 及测试；暂不迁移所有 UI 入口。
- 验证：timeout/throw/null/malformed、stale generations、stable action identity、command-only allowlist。

### ED-ACTION-002 迁移 lightbulb 与 Alt+Enter
<!-- ide-task {"id":"ED-ACTION-002","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T10:08:44Z","baseline":"b9b2d1c8a0024d7951efab03e8cb38db375850c2","depends_on":["ED-ACTION-001"],"legacy":["BB5"],"updated_at":"2026-08-29T10:20:33Z","evidence":"vitest: intentionSession.test.ts, codeActionProviderAdapter.test.ts, codeActionExecution.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：lightbulb 和 Alt+Enter 只构造 context 并调用 canonical service；两入口共享同 request/action/result，旧 direct imports 被静态测试禁止。
- 主文件：`CodeWorkspaceTab.tsx` 对应 owner 区域、intention session/tests。
- 验证：mounted 两入口、resolve retry/failure visible、stale zero apply。

### ED-ACTION-003 迁移 Problems、context menu 与 Save plan-only
<!-- ide-task {"id":"ED-ACTION-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T10:20:51Z","baseline":"6aa7019e9706fe29a9905c218cefaa9a5d55406f","depends_on":["ED-ACTION-002"],"legacy":["BB5","BB6"],"updated_at":"2026-08-29T10:23:58Z","evidence":"vitest: codeActionProviderAdapter.test.ts, intentionSession.test.ts, saveNormalizationPipeline.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：Problems、editor context menu 和 save organize-imports 不再直接组合 request/resolve/run；`mode: plan-only` 的 live edit/write/history 均为 0。
- 主文件：入口 owner、canonical adapter、save integration tests。
- 验证：五入口静态 import guard、mounted shared request、plan-only effect counters。

### ED-ACTION-004 加入 preview/commit/postcondition/history
<!-- ide-task {"id":"ED-ACTION-004","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T10:24:15Z","baseline":"9a4f5e67532636d85ada40176f559ff6a9581d50","depends_on":["ED-ACTION-003"],"legacy":["BB5"],"updated_at":"2026-08-29T10:27:15Z","evidence":"vitest: codeActionProviderAdapter.test.ts, intentionSession.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：apply mode 经 preview、commit、postcondition，返回真实 history/recovery id 与 affected URI pre/post/undo hash；preview 后与 commit 前重验 live owner。
- 主文件：canonical service、WorkspaceEdit history/recovery、tests。
- 验证：multi-file edit、conflict/cancel/stale、undo hash、provider failed visible。

### ED-SAVE-001 建立六阶段 immutable save plan
<!-- ide-task {"id":"ED-SAVE-001","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:36:34Z","baseline":"44158c922cde66daaea2a6390b8b856ed6d0b36e","depends_on":[],"legacy":["BB6"],"updated_at":"2026-08-29T11:40:26Z","evidence":"vitest: saveNormalizationPipeline.test.ts, workspaceStyleController.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：冻结 text/document/disk/policy/style/provider/project/encoding identity；阶段固定为 format、organize-imports、trim、final-newline、eol、charset-bom，每段记录 typed status/reason 和 SHA-256。
- 主文件：`saveNormalizationPipeline.ts`、`workspaceStyleController.ts` 及 tests。
- 验证：每 stage applied/unavailable/failed/stale，encoding failure 只产生一个 failed stage，live buffer effect 0。

### ED-SAVE-002 通过 Code Action plan-only 执行 organize imports
<!-- ide-task {"id":"ED-SAVE-002","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:40:41Z","baseline":"c670ad58c38c573cd46fd733bcbc4dbb879b97db","depends_on":["ED-SAVE-001","ED-ACTION-003"],"legacy":["BB6"],"updated_at":"2026-08-29T11:42:51Z","evidence":"vitest: saveOrganizeImportsAdapter.test.ts, saveNormalizationPipeline.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：organize imports 只调用 canonical service `plan-only`；校验 URI/version/range/overlap；command-only 或不可统一提交的 multi-file edit 返回 typed unavailable。
- 主文件：save pipeline adapter、tests。
- 验证：single/multi-file、overlap、wrong URI/version、provider unavailable/failed policy。

### ED-SAVE-003 一次 byte writer 与 final bytes receipt
<!-- ide-task {"id":"ED-SAVE-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:43:07Z","baseline":"391e6f8f1d20699ad44f8bc64966c01af768d869","depends_on":["ED-SAVE-002"],"legacy":["BB6"],"updated_at":"2026-08-29T11:51:59Z","evidence":"vitest: saveCommit.test.ts, writeDiskByteCorrectness.test.ts; pnpm build; qa-ui-auto lint"} -->

- 结果：同步 pre-write 重验后一次 writer；记录 final text/encoded bytes SHA-256、disk pre/post、write count、history/recovery id；writeback merge-only。
- 主文件：PreparedSave/open+closed committer、Rust byte writer boundary、tests。
- 验证：BOM/EOL/encoding、disk race、closed buffer、writer failure、typing race、write count=1。

### ED-SAVE-004 升级 Save behavior/native evidence
<!-- ide-task {"id":"ED-SAVE-004","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:52:14Z","baseline":"33249249c767caedad7ed4fa868733bd6122405c","depends_on":["ED-SAVE-003"],"legacy":["BB10-C0","BB11"],"updated_at":"2026-08-29T11:54:19Z","evidence":"vitest: saveObservationContract.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：C0 断言真实 final bytes、dirty/saved UI、recovery/undo；native temp workspace 覆盖 UTF-8/BOM/UTF-16/Latin-1 与 LF/CRLF，不把 browser VFS 当磁盘证明。
- 主文件：C0 YAML、native fixtures/runbook、observation contract。
- 验证：qa audit、native case、hash/receipt 对账；未跑平台保持 blocked。

### ED-COMP-001 定义 typed completion resolve outcome
<!-- ide-task {"id":"ED-COMP-001","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:54:36Z","baseline":"a9b003af321b10ceb6b94ebb8bca04cba8f026a2","depends_on":[],"legacy":["BB7"],"updated_at":"2026-08-29T11:57:48Z","evidence":"vitest: lspCompletionResolveGate.test.ts, lspCompletion.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：resolve 区分 `resolved/not-required/unavailable/timeout/failed/cancelled/stale`；resolver 缺失不推导 not-required；非安全结果保留 popup、edit=0，提供显式降级入口。
- 主文件：`lspCompletion.ts`、resolve gate UI/tests。
- 验证：throw/null/timeout/missing resolver/cancel/stale，popup 和 selection 保留。

### ED-COMP-002 冻结 candidate/session/provider identity 与排序
<!-- ide-task {"id":"ED-COMP-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T11:58:06Z","baseline":"63b3472e151b9c57eed6bfa76a604585aa818824","depends_on":["ED-COMP-001"],"legacy":["BB7"],"updated_at":"2026-08-29T12:01:56Z","evidence":"vitest: lspCompletion.test.ts, lspCompletionResolveGate.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：stable candidate id 映射 raw response index；冻结 document/session/provider/policy/project generation；match tier 为第一排序键，同 tier 默认保持 provider order。
- 主文件：completion controller/mapping/preferences tests。
- 验证：sorting 不拆 raw/mapped pair，0/1/many、incomplete/truncated、双 workspace、live policy change。

### ED-COMP-003 原子 acceptance 与一次 undo
<!-- ide-task {"id":"ED-COMP-003","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:02:12Z","baseline":"ba0ea1bcb9d2dba058c898c536c22fbe1eefb57b","depends_on":["ED-COMP-002"],"legacy":["BB7","BB10-C5"],"updated_at":"2026-08-29T12:03:51Z","evidence":"vitest: lspCompletionResolveGate.test.ts, lspCompletion.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：resolve 后重验 unique/range/snippet/overlap；primary + additional edits 一次 transaction；snippet+import 也一次 undo；failure 不隐式丢 import。
- 主文件：completion acceptance/CodeMirror integration/tests。
- 验证：snippet+import、additional edit before primary、overlap、stale、explicit primary-only degradation、once undo。

### ED-COMP-004 只消费 ready project scope facts
<!-- ide-task {"id":"ED-COMP-004","status":"ready","priority":"P1","size":"S","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-COMP-003","ED-PROJECT-005"],"legacy":["BB7","BB9"]} -->

- 结果：module/project scope 只读同 workspace 的 ready generation；descriptor/loading/degraded 返回 `scope-facts-missing`，UI 显示实际 scope。
- 主文件：completion scope adapter、project facts consumer tests。
- 验证：document/module/project/provider-reported、stale project generation、双 root。

### ED-QUERY-001 完整传递 semantic query envelope 与 cancel
<!-- ide-task {"id":"ED-QUERY-001","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:04:08Z","baseline":"bf3dadd42bc5916f16c7ca4d7e28add3b55ec5a6","depends_on":[],"legacy":["BB8"],"updated_at":"2026-08-29T12:07:29Z","evidence":"vitest: workspaceSemanticQueryHost.test.ts, semanticQueryEnvelope.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：host/adapter 消费 uri/position/document/provider/project generation/request id；fetcher 与 transport 共享 AbortSignal 和 protocol request id；unmount/file-close/restart `cancelAll`。
- 主文件：`workspaceSemanticQueryHost.ts`、LSP adapter/hooks/tests。
- 验证：真实参数、transport cancel、四阶段 live guard、captured revision closure 被测试禁止。

### ED-QUERY-002 迁移 definition/declaration/type/implementation/references
<!-- ide-task {"id":"ED-QUERY-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:07:48Z","baseline":"6f4f9bea4ca87e8364342dfc889a08f9c5ee17ce","depends_on":["ED-QUERY-001"],"legacy":["BB8"],"updated_at":"2026-08-29T12:11:54Z","evidence":"vitest: useWorkspaceNavigation.test.tsx, workspaceSemanticQueryHost.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：五类 query 全部经同 host；0/1/many 结果 typed；preview 不写 history，成功 open/reveal 后才写。
- 主文件：`CodeWorkspaceTab.tsx` query owner、navigation/history tests。
- 验证：0/1/many、cancel/stale/failed history=0、Back 恢复来源位置。

### ED-QUERY-003 迁移 Call/Type Hierarchy prepare 与 expand
<!-- ide-task {"id":"ED-QUERY-003","status":"done","priority":"P1","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:27:40Z","baseline":"670b30c37c743f7de6c4480dcfc27302228df284","depends_on":["ED-QUERY-001"],"legacy":["BB8"],"updated_at":"2026-08-29T12:29:32Z","evidence":"vitest: hierarchyQueryModel.test.ts, HierarchyPanel.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：hierarchy prepare/expand 经 host，保留 opaque node identity、siblings、direction、completeness 和 partial error；旧 generation expand 不更新 UI。
- 主文件：Hierarchy panel/model、query host adapter/tests。
- 验证：prepare 0/1/many、lazy expand、cancel/restart、partial branch failure。

### ED-QUERY-004 建立 provider-backed Query behavior case
<!-- ide-task {"id":"ED-QUERY-004","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-QUERY-002","ED-QUERY-003"],"legacy":["BB10-C6-02","BB11"]} -->

- 结果：C6-02 不再用 Rename 冒充 Query；真实 jdtls fixture 断言 caret 参数、result session、open/reveal、history、cancel 和 hierarchy expand。
- 主文件：新 Query YAML、jdtls fixture expectations、observation contract。
- 验证：provider case + qa audit；Rename 保留独立 case。

### ED-PROJECT-001 隔离 descriptor discovery 与 ready snapshot
<!-- ide-task {"id":"ED-PROJECT-001","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:12:17Z","baseline":"8ce970477b56f48f3c9b1a2cfd11ddf908610e64","depends_on":[],"legacy":["BB9-A"],"updated_at":"2026-08-29T12:14:21Z","evidence":"vitest: projectStructureModel.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：所有 Cargo/Node/Maven/Gradle descriptor 只产生 `ProjectDescriptorDiscoveryV1`/`descriptor-only`；不得产出 ready classpath/source roots；consumer 必须检查 status+generation。
- 主文件：`projectStructureModel.ts`、consumer reachability/static tests。
- 验证：各种 descriptor、partial/malformed、旧 snapshot consumer 被阻断。

### ED-PROJECT-002 可信 Maven tooling ingestion
<!-- ide-task {"id":"ED-PROJECT-002","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-001"],"legacy":["BB9-B"]} -->

- 结果：trust 批准后 wrapper 优先，读取 effective model；backend 记录 tool/JDK/version/argv/cwd/hash/modules/source sets/classpath/dependency/provenance；untrusted process=0。
- 主文件：Rust workspace tooling 独立模块、IPC types/tests；不顺手实现 Gradle。
- 验证：真实 multi-module Maven fixture、offline/auth/timeout/malformed 不返回空 ready。

### ED-PROJECT-003 可信 Gradle tooling ingestion
<!-- ide-task {"id":"ED-PROJECT-003","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-001"],"legacy":["BB9-C"]} -->

- 结果：trust 批准后 wrapper 优先，通过 Tooling API 或受控 init script 获取 modules/source sets/classpath；记录完整 provenance；untrusted process=0。
- 主文件：Rust workspace tooling 独立模块、IPC types/tests；不修改 Maven owner。
- 验证：真实 multi-module Gradle fixture、missing wrapper/offline/daemon crash/partial typed failure。

### ED-PROJECT-004 建立 project facts cache/generation lifecycle
<!-- ide-task {"id":"ED-PROJECT-004","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-002","ED-PROJECT-003"],"legacy":["BB9-D"]} -->

- 结果：workspace root 唯一 store；descriptor/wrapper/settings/lock/tool/JDK/env fingerprint 驱动 cache；变化取消旧 generation 并标 stale；UI 显示 loading/degraded/untrusted 原因。
- 主文件：project facts store/hook/status UI/tests。
- 验证：文件变化、tool/JDK/env change、restart、双 workspace、cache hit/miss。

### ED-PROJECT-005 接入 completion/query/refactor 三个 consumer
<!-- ide-task {"id":"ED-PROJECT-005","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-004"],"legacy":["BB9-D"]} -->

- 结果：Completion scope、Semantic Query classification、Rename/refactor coverage 使用同一个 ready generation；loading/degraded/untrusted 都 fail closed 并显示原因。
- 主文件：三个 consumer adapter 和 mounted tests；不要在本任务扩 tooling ingestion。
- 验证：三 consumer identity、stale generation、Maven/Gradle UI state、双 root。

## 7. QA 与发布证据并行轨道

本轨道用于可信发布声明，但不阻塞普通 Editor 小任务开始开发；某 capability 要提升为 release `verified` 时，必须满足对应任务。

### ED-QA-001 定义 daily-editor-linux release scope 与 observation
<!-- ide-task {"id":"ED-QA-001","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:21:26Z","baseline":"630a89d94904b6e67cced3e9e0dc7e47c6286f1f","depends_on":["ED-GATE-002"],"legacy":["BB10"],"updated_at":"2026-08-29T12:23:06Z","evidence":"scope: daily-editor-linux.scope.json; vitest: editorReleaseScope.test.ts, workspaceObservationBridge.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：机器可读 scope 列 capability/control/case/effect/layer/provider requirement；dev/test-only observation 只读 revisions/requests/writes/leases/history/hashes，不可执行 action，production build 关闭。
- 主文件：release scope schema/data、observation bridge/tests。
- 验证：scope audit 只统计 Editor required 集；文本/路径只输出 hash/count；production import guard。

### ED-QA-002 对齐 Editor behavior case 映射
<!-- ide-task {"id":"ED-QA-002","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-QA-001"],"legacy":["BB10"]} -->

- 结果：C0 Save、C3 Clipboard、C4 Tab Policy、C5 Completion、C6-01 Quick Fix、C6-02 Query、C6-03 Safe Delete，再新增 Virtual Space 与 Project Structure；每 case 同时断言 UI 与 effect counters。
- 主文件：逐 case 小提交；一次只修一个 case，持续更新 scope。
- 验证：每次 qa audit/dry-run/run；scope 0 broken/orphan/missing/shallow。

### ED-QA-003 Linux packaged/provider/perf/a11y/IDEA matrix
<!-- ide-task {"id":"ED-QA-003","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-QA-002","ED-CLIP-004","ED-TABS-004","ED-VSPACE-003","ED-SAVE-004","ED-COMP-004","ED-QUERY-004","ED-PROJECT-005"],"legacy":["BB11"]} -->

- 结果：按 capability 逐格运行 packaged Linux、真实 jdtls/Maven/Gradle、5 轮 perf raw samples、keyboard/focus/name-role-state/200%/screen-reader、IME/AltGr/dead key，并与 IDEA 相同 fixture 对录。
- 主文件：native manifest/runbooks/evidence；不修改 production 功能来迁就 runner。
- 验证：每格记录 expected/observed/effect/scope/undo/unavailable；Windows/macOS 独立 blocked，不从 Linux 外推。

### ED-REL-001 定义 runner-owned receipt 与签名边界
<!-- ide-task {"id":"ED-REL-001","status":"ready","priority":"P2","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["BB2"]} -->

- 结果：runner 生成 receipt，调用者不能注入 exit/duration/result；签名用途、key registry、有效期/撤销和 secret 边界明确。先完成 schema/attack tests，不在同任务改 rollup。
- 验证：unknown/expired/revoked issuer、手写/tampered receipt 全 fail closed。

### ED-REL-002 收紧 source/test-plan/bundle identity
<!-- ide-task {"id":"ED-REL-002","status":"ready","priority":"P2","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-REL-001"],"legacy":["BB2"]} -->

- 结果：tracked mode/bytes/symlink/deleted/submodule、真实 bundle manifest、schema/scope/runner/cases/runbooks/catalog/baseline 全进入 identity；git/read/missing/untracked product input fail closed。
- 验证：mode/deleted/symlink/git error/missing bundle/changed test plan attack matrix。

### ED-REL-003 约束 release plan/channel/artifact roots
<!-- ide-task {"id":"ED-REL-003","status":"ready","priority":"P2","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-REL-002"],"legacy":["BB2"]} -->

- 结果：validator/rollup/audit 消费同一 release plan；channel 真正选择 requirements；artifact 只允许 committed repo-relative evidence roots，拒绝 absolute、`/tmp`、ignored、symlink escape 和 mixed source。
- 验证：channel/bundle/artifact/mixed-current attack tests。

### ED-REL-004 稳定 rollup 并跑一条真实 smoke transaction
<!-- ide-task {"id":"ED-REL-004","status":"ready","priority":"P2","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-REL-003"],"legacy":["BB2"]} -->

- 结果：相同 receipt 集合生成 byte-identical rollup，manifest commit 后 `--check` 仍通过；一条真实 browser smoke 形成 receipt->entry->validator->rollup->audit。
- 验证：zero-entry 稳定 RED、source 后代 allowlist、manifest stability、真实 smoke。

## 8. P1 IDEA Core 补齐队列

这些任务来自 IDEA 公开工作流与旧文档长期 gap，已按当前代码重新去重。它们可以与 P0 不冲突的 owner 并行，但不能用来补偿 G0 红项。同一 priority 的主产品顺序为 shared multi-view、Find/Replace、Navigation/Usages、Editor Banner、File Templates；其余独立能力随后按文档顺序推荐。

### ED-MULTIVIEW-001 设计 shared document transaction owner
<!-- ide-task {"id":"ED-MULTIVIEW-001","status":"done","priority":"P0","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:14:41Z","baseline":"3cb5c459bdc5dd43c4872702380e18c7a44b6585","depends_on":[],"legacy":["N14.3"],"updated_at":"2026-08-29T12:15:17Z","evidence":"adr: adr-shared-document-transaction-owner.md; qa-ui-auto lint"} -->

- 结果：独立 ADR 明确同文件多 split 的 document/undo/redo/dirty/LSP authority、per-view selection/scroll/fold，以及从当前全文同步的迁移步骤；不在本任务改 production。
- 验证：现状 reproduction 与 invariants、迁移/rollback/test plan 可执行。

### ED-MULTIVIEW-002 实现 shared document + undo transaction
<!-- ide-task {"id":"ED-MULTIVIEW-002","status":"done","priority":"P0","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:15:31Z","baseline":"ed4dcb997fc4ea5ca1fb48a97bc3fcd688a63812","depends_on":["ED-MULTIVIEW-001"],"legacy":["N14.3"],"updated_at":"2026-08-29T12:21:03Z","evidence":"vitest: workspaceDocumentTransactionOwner.test.ts, EditorGroup.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：同文件所有 view 共享 document changes/history，另一个 view 不把全文同步当一步；LSP/dirty revision 只增一次。
- 验证：双/三 split typing、undo/redo、completion/paste multi-edit、close/reopen view、external change。

### ED-MULTIVIEW-003 同步 shared decoration 并保留 per-view state
<!-- ide-task {"id":"ED-MULTIVIEW-003","status":"done","priority":"P1","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:23:21Z","baseline":"7296ca6a382a9471c1dc0a884df42b07035645a9","depends_on":["ED-MULTIVIEW-002"],"legacy":["N14.3"],"updated_at":"2026-08-29T12:27:22Z","evidence":"vitest: workspaceMultiViewState.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：diagnostics/breakpoints/bookmarks/folds 的 document state 同步；caret/selection/scroll 保持 per-view；view close 不释放最后 document resource。
- 验证：多 view decoration/fold/scroll、resource lease、restore。

### ED-FIND-001 扩展文件内 Replace 的 Preserve Case
<!-- ide-task {"id":"ED-FIND-001","status":"done","priority":"P1","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:29:51Z","baseline":"cf700b5b00687820b467eca6bd3159f6cc154aa0","depends_on":[],"legacy":["N9.1"],"updated_at":"2026-08-29T12:34:40Z","evidence":"vitest: editorSearchPanel.test.ts, CodeMirrorHost.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：自有 search panel 增加 Preserve Case，literal/word/regex 的可用性和 replacement 规则明确。
- 验证：lower/title/upper/mixed、多行、zero-length regex 与 undo。

### ED-FIND-002 增加 selection/comments/strings 搜索过滤
<!-- ide-task {"id":"ED-FIND-002","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-FIND-001"],"legacy":["N9.1"]} -->

- 结果：Find in Selection 与 comments/strings/exclude-comments 过滤使用可证明 syntax facts；unsupported language 显式 unavailable，不用文本猜测冒充。
- 验证：Java/TS supported fixture、plaintext unavailable、selection change、Select All Occurrences。

### ED-FIND-003 建立 Find in Files scope/file-mask 模型
<!-- ide-task {"id":"ED-FIND-003","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-005"],"legacy":["N9.2"]} -->

- 结果：Project/Module/Directory/Recently viewed/custom scope 与 file mask 独立于 include/exclude glob；module scope 只用 ready facts。
- 验证：多 root/module、missing facts、recent scope、cancel/stale search。

### ED-FIND-004 增加 Replace in Files preview/exclude/commit
<!-- ide-task {"id":"ED-FIND-004","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-FIND-003"],"legacy":["N9.2"]} -->

- 结果：逐项 preview/exclude，使用 WorkspaceEdit transaction、conflict/revision guard 和一次 undo；禁止直接 Replace All 后只报数量。
- 验证：multi-file、exclude、disk/open dirty conflict、cancel、undo/recovery。

### ED-NAV-001 增加 Navigation Bar 键盘工作流
<!-- ide-task {"id":"ED-NAV-001","status":"done","priority":"P1","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:39:21Z","baseline":"d22a7031309c0980654407340204838b0f5f76a5","depends_on":[],"legacy":["N13.2"],"updated_at":"2026-08-29T12:43:33Z","evidence":"vitest: navigationBarModel.test.ts, Breadcrumbs.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：Alt+Home 打开工程/符号 breadcrumbs 式导航，逐级键盘浏览并打开；与当前 editor Breadcrumbs 分账。
- 验证：多 root、file/symbol、focus restore、unavailable provider、keymap conflict。

### ED-NAV-002 补显式 Highlight Usages 与 occurrence 导航
<!-- ide-task {"id":"ED-NAV-002","status":"done","priority":"P1","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:43:48Z","baseline":"dcb5b3de55367897fd89f313c60ecad902feb0bc","depends_on":["ED-QUERY-002"],"legacy":["N13.4"],"updated_at":"2026-08-29T12:46:40Z","evidence":"vitest: occurrenceHighlightModel.test.ts, CodeMirrorHost.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：显式 Highlight Usages、Esc clear、next/previous occurrence；read/write 只有 provider 分类时区分，否则显示 unknown。
- 验证：document edits invalidate、0/1/many、role unknown、keyboard loop。

### ED-USAGE-001 完成 Show/Find Usages result session
<!-- ide-task {"id":"ED-USAGE-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-QUERY-002"],"legacy":["N13.3"]} -->

- 结果：共享 session 支持 module/file/usage-type grouping、preview、pin/rerun/recent、scope；无 provider role 时 role filter disabled 并解释原因。
- 验证：popup->tool window、pin/rerun、recent restore、stale generation、library ownership。

### ED-USAGE-002 增加 provider usage role/completeness evidence
<!-- ide-task {"id":"ED-USAGE-002","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-USAGE-001","ED-PROJECT-005"],"legacy":["W4","BB8"]} -->

- 结果：Java fixture 记录 read/write/declaration/unknown、workspace/library/decompiled/external 与 completeness；UI 不从文本推断角色。
- 验证：真实 jdtls/tooling fixture、partial results、provider restart。

### ED-CHROME-002 可操作 Editor Banner framework
<!-- ide-task {"id":"ED-CHROME-002","status":"done","priority":"P1","size":"M","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:47:00Z","baseline":"09b07c14b2449722862e5c86b711b0c87dc25bcf","depends_on":[],"legacy":["N10.3"],"updated_at":"2026-08-29T12:50:47Z","evidence":"vitest: editorBannerModel.test.ts, EditorBanner.test.tsx, EditorGroup.test.tsx; qa-ui-auto lint; pnpm build"} -->

- 结果：顶部 banner 支持 read-only、encoding mismatch、SDK/project import、indexing/degraded，带 typed actions、priority/dismiss/lifecycle；不复用瞬时 statusMessage。
- 验证：多 banner priority、file switch、action failure、focus/a11y、layout no-overlap。

### ED-TEMPLATE-001 File and Code Templates 最小 Java 切片
<!-- ide-task {"id":"ED-TEMPLATE-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-PROJECT-005"],"legacy":["N11.1"]} -->

- 结果：New Class/Interface/Record 使用可编辑模板、package/source-root facts 和安全变量；创建为一次 resource transaction。
- 验证：valid/invalid name、package path、existing file conflict、undo/recovery、untrusted template variable。

### ED-DOC-001 Rendered documentation / Reader Mode
<!-- ide-task {"id":"ED-DOC-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["N10.1"]} -->

- 结果：先交付一门语言的 doc-comment rendered toggle、links/images 安全策略与 hover setting；与 QuickDoc popup/pane 分账。
- 验证：edit/render toggle、sanitization、broken link/image、large doc、unsupported language。

### ED-CHROME-001 Per-file highlighting widget
<!-- ide-task {"id":"ED-CHROME-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["N10.2"]} -->

- 结果：editor widget 显示 error/warning count、上下跳转、None/Syntax/All Problems 和 profile entry；准确标示 provider scope。
- 验证：setting persistence、diagnostic revision、keyboard/a11y、no-provider state。

### ED-BOOKMARK-001 助记书签与分组
<!-- ide-task {"id":"ED-BOOKMARK-001","status":"done","priority":"P1","size":"S","owner":"idea-parity-loop-agy","claimed_at":"2026-08-29T12:35:01Z","baseline":"99ed0b142e51c61614b396022c8fb71b58851dc0","depends_on":[],"legacy":["N11.3"],"updated_at":"2026-08-29T12:39:03Z","evidence":"vitest: todoBookmarks.test.ts; qa-ui-auto lint; pnpm build"} -->

- 结果：现有 line bookmark 增加数字/字母 mnemonic、冲突替换、按 mnemonic 跳转和 Bookmarks panel group；TODO 与 bookmark 分账。
- 验证：set/replace/remove、file rename/delete、restore、keyboard-only。

### ED-COMPARE-001 通用 editor Compare workflow
<!-- ide-task {"id":"ED-COMPARE-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["N11.4"]} -->

- 结果：Compare with Clipboard / Files / Local History selection 共用 diff surface；Git branch compare 只复用现有 Git 数据，不扩完整 Git client。
- 验证：encoding/EOL、selection, binary/large unavailable、apply/copy action、a11y。

### ED-STYLE-001 Reformat scope/marker/exclusion
<!-- ide-task {"id":"ED-STYLE-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-SAVE-003"],"legacy":["C8-D"]} -->

- 结果：selection/file/directory/module scope 与 formatter markers/exclusions 分层；module 依赖 ready facts；preview 后统一 commit/undo。
- 验证：selection/file、multi-file scope、marker nesting、excluded file、provider unavailable。

### ED-STYLE-002 Rearrange / Cleanup 独立工作流
<!-- ide-task {"id":"ED-STYLE-002","status":"ready","priority":"P2","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-STYLE-001","ED-ACTION-004"],"legacy":["C8-D"]} -->

- 结果：只在 provider 明确支持时提供 rearrange/cleanup，显示计划/范围/失败；不得把 format 或 organize imports 重命名冒充。
- 验证：provider capability、preview/conflict/cancel、postcondition/undo。

### ED-IMPORT-001 Provider-backed on-the-fly/paste auto-import
<!-- ide-task {"id":"ED-IMPORT-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-COMP-004","ED-ACTION-004"],"legacy":["N13.5"]} -->

- 结果：唯一候选可按设置自动 import，歧义候选由用户选择，paste import/optimize-on-the-fly 可配置；候选来自 provider+ready classpath，不能用固定字典。
- 验证：unique/ambiguous/excluded/prioritized、paste、stale project/provider、once undo。

### ED-REF-001 Rename/refactor completeness 与 conflict 闭环
<!-- ide-task {"id":"ED-REF-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-ACTION-004","ED-PROJECT-005","ED-USAGE-002"],"legacy":["W5","BB5"]} -->

- 结果：Rename 与 provider refactor 记录 coverage/completeness/library ownership、preview exclude/conflict、postcondition/history/undo；Safe Delete 无 dedicated provider coverage 时继续 fail closed。
- 验证：真实 jdtls multi-file rename、dirty conflict、library/read-only、restart/stale、undo hash。

## 9. 性能小任务

详细场景与历史根因见 [`code-workspace-performance-todo.md`](./code-workspace-performance-todo.md)。以下只保留可独立领取的切片。

### ED-PERF-001 稳定 status/empty props 与 CodeMirror reconfigure
<!-- ide-task {"id":"ED-PERF-001","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["PERF-3.1","PERF-3.2"]} -->

- 结果：相同状态不重复写 Zustand；空 diagnostics/git/highlights 等使用稳定值；compartment 语义未变不 reconfigure。
- 验证：render/reconfigure counters、typing/parent rerender regression、before/after samples。

### ED-PERF-002 收敛隐藏 workspace 的 Git/LSP 后台活动
<!-- ide-task {"id":"ED-PERF-002","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["PERF-3.3","PERF-3.4"]} -->

- 结果：Git polling 仅可见 workspace、同 repo cache/in-flight dedupe；LSP detect 应用级 cache、按需触发和手动 refresh。
- 验证：fake timers、3 workspace/同 repo、hide/show、slow request/cancel、call counts。

### ED-PERF-003 首屏优先 restore 与 active-file diff
<!-- ide-task {"id":"ED-PERF-003","status":"ready","priority":"P1","size":"M","owner":null,"claimed_at":null,"baseline":null,"depends_on":[],"legacy":["PERF-4.1","PERF-4.2"]} -->

- 结果：restore 先读每 leaf active file，其他 tab lazy；并发 2-4；line diff 只算可见文件并按 path/HEAD/text version cache。
- 验证：20-40 tabs、multi-leaf、failure/fast switch、large file degradation、before/after TTI。

### ED-PERF-004 buffer authority 迁移设计
<!-- ide-task {"id":"ED-PERF-004","status":"ready","priority":"P2","size":"S","owner":null,"claimed_at":null,"baseline":null,"depends_on":["ED-MULTIVIEW-001"],"legacy":["PERF-5"]} -->

- 结果：独立 ADR 定义 CodeMirror live buffer、React/store snapshot、incremental LSP、Git/semantic scheduling 和迁移/rollback；不在本任务改 production。
- 验证：1MB/5MB current baseline、invariants、phased test plan。

## 10. Deferred Advanced Queue

以下能力确认属于 IDEA 2026.2 公开工作流，但当前不可领取。重开必须先写独立 ADR，给出 engine/provider/version、edition/license、privacy、hardware/resource budget、offline/failure、migration/rollback、fixture 和 claim ceiling。

| 能力 | 当前状态 | 最低重开条件 |
|---|---|---|
| Smart / Type-Matching Completion | deferred | ED-COMP-004、真实 expected-type provider evidence、Linux completion perf 通过 |
| Full Line local completion | deferred | 独立 local model runtime、硬件 gate、privacy/offline/auto-import 设计，普通 completion 闭环 |
| Structural Search/Replace | deferred | Java syntax engine/provider、template scope、preview/undo，不能用 regex 冒充 |
| Maven/Gradle dependency completion | deferred | ED-PROJECT-005 与 Completion scope 完成，proxy/offline/cache 设计 |
| Code Vision / semantic gutter | deferred | usages/inheritor completeness 与 provider generation 可证明 |
| Scratch files/buffers | deferred | shared document/resource model与独立 persistence/search scope 设计 |
| Language injection / fragment editor | deferred | host language range mapping、嵌套 language service、format/undo 设计 |
| 完整 inspection/data-flow engine | deferred | 独立 engine ADR；当前 presentation profile 不升级为 inspection engine |
| 高级 refactors | deferred | ED-REF-001 与对应 provider capability/fixture；逐 refactor 开卡 |
| Editor tab detach/new window | deferred | multi-view/resource lifecycle、跨 window store/clipboard/keymap/native matrix 完成 |
| 自定义 postfix/live-template functions | deferred | language-aware evaluator、安全变量和 persistence/import/export 设计 |

## 11. 旧队列迁移摘要

| 旧包 | 新任务 |
|---|---|
| BB0 | ED-GATE-001/002；33 broken-case 误报已在 `f0516fa4` 消除 |
| BB1 | ED-CLIP-001..004；Provider 恢复只作为已存在基线，不算整包完成 |
| BB2 | ED-REL-001..004；降为发布证据并行轨道，不阻塞普通功能开发 |
| BB3 | ED-TABS-001..004 |
| BB4 | ED-VSPACE-001..003 |
| BB5 | ED-ACTION-001..004 |
| BB6 | ED-SAVE-001..004 |
| BB7 | ED-COMP-001..004 |
| BB8 | ED-QUERY-001..004 |
| BB9 | ED-PROJECT-001..005 |
| BB10 | ED-QA-001/002 与各能力行为 case |
| BB11 | ED-QA-003 |
| BB12 | §10 deferred queue |

## 12. Review 决议与待确认项

2026-08-29 维护者已确认：

1. `BB2` 作为 release verification 并行轨道，不是所有 Editor 功能的串行前置；release `verified` 声明仍必须通过对应 ED-REL 任务。
2. G1 以 Linux 作为首个平台；Windows/macOS 独立验收，不由 Linux 结果外推。
3. P1 Core 主产品顺序为 shared multi-view、Find/Replace、Navigation/Usages、Editor Banner、File Templates；同 priority 的 task board 推荐顺序已按此调整。

仍待后续 review：Deferred queue 是否有需要提前重开的单项。若重开，先补 ADR 和任务卡，不直接改 production。
