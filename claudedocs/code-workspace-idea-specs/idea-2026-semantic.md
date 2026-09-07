# 语义操作详细设计

必读 [共享对比契约](./idea-2026-comparison.md) 与 [共享合同](./shared-contracts.md)。保持当前 UI 布局和 action registry；已确认断点与待实测差异明确分列。测试文件默认相对 `src/components/editor/workspace/`。本设计不要求实现 IDEA 私有索引/PSI 或全语言补全引擎。

<a id="ed-audit-003"></a>
## ED-AUDIT-003 文件替换范围与冲突对齐

### 目标与代码事实

Replace in Files 只修改预览确认的文件和匹配项，并在外部改动时阻止覆盖。

findInFilesScopeModel.ts 的 planFindInFilesScope 处理 project/module/directory/recent/custom 与 fileMask；replaceInFilesModel.ts、buildReplaceEdits.ts 和 ReplacePreviewDialog.tsx 已存在。需要核验匹配集合是否沿 UI 到 workspace writer 保持一致；不是假定这些模块尚未接入。

### Owner 与实现契约

src/components/editor/workspace/findInFilesScopeModel.ts、replaceInFilesModel.ts、buildReplaceEdits.ts、panels/FindInFilesPanel.tsx、panels/ReplacePreviewDialog.tsx；CodeWorkspaceTab.tsx 中 replace handlers；必要时 src/lib/editor/workspaceSearch.ts / src-tauri/src/workspace_search.rs（变更则追加 rust 证据）。

预览冻结 scope roots、fileMask、query/options、project-facts generation 与每文件 preimage；apply 必须使用这份匹配集并即时检查文件变化，不能扩大为当前全项目搜索。checked 项只作用于原 plan；regex 错误必须在预览前显示。readonly/dirty/excluded/超限文件逐项说明。reuse workspace edit/history；取消不创建 history，部分写入必须显式已改集合和恢复，禁止 UI 显示全部完成。

依赖：ED-AUDIT-001。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

临时工程含 src/A.java、src/B.java、test/ATest.java、excluded/Skip.java，文本含 foo、Foo、foobar 与多行。两端选 directory + *.java、case/whole-word/regex 分别搜索替换；取消预览、排除一个结果、确认剩余项、Undo。预览后外部改 B.java 再 apply，记录结果集合、冲突提示及磁盘 hash。

### 验收与验证

- **ED-AUDIT-003-A1：** 同一 fixture 的范围、匹配位置、选中替换集合在 IDEA 与 Taomni 可对比；修复确认 delta，结果集合不得因 UI 刷新扩大。
- **ED-AUDIT-003-A2：** 预览后外部改变、dirty/readonly、非法 regex、取消/stale 均有回归；无 effect 分支零 history，已发生部分 effect 有真实 ledger 与恢复结果。
- **ED-AUDIT-003-A3：** focused/mounted、当前 native 文件后置断言、typecheck 与 IDEA comparison 通过；搜索实现改动影响性能时补同 fixture 耗时证据。

验证 V-003：findInFilesScopeModel.test.ts、replaceInFilesModel.test.ts、buildReplaceEdits.test.ts、panels/FindInFilesPanel.test.tsx、panels/ReplacePreviewDialog.test.tsx；拟新增 TC-IDE-AUDIT-003（实施前查重登记 covers）。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。

<a id="ed-audit-007"></a>
## ED-AUDIT-007 Completion 接受与单次撤销对齐

### 目标与代码事实

接受 completion 后主 edit、额外 import 和 snippet 成为一个可撤销动作，延迟 resolve 不覆盖新输入。

CodeWorkspaceTab.tsx 13743 附近调用真实 lspCompletion/resolve；lspCompletion.ts 的 createLspCompletionSource、commitLspCompletion 是接受 owner。已有 choice/snippet 测试，仅凭这些测试不能推断 IDEA 排序或 Smart Completion 对齐。

### Owner 与实现契约

src/components/editor/workspace/lspCompletion.ts、completionScopeAdapter.ts、CodeMirrorHost.tsx completion wiring、CodeWorkspaceTab.tsx completion callbacks；src/lib/editor/lsp.ts 如需 transport 变更单独记录。

snapshot 固定 document revision、provider generation、caret 范围与 invocation；resolve 后复核。Insert/Replace、additionalTextEdits、snippet anchors 使用当前模块的 planCompletionChanges，不额外逐条 dispatch。已输入新字符或 provider restart 时丢弃旧接受计划并维持新文本。候选选择顺序、Enter/Tab 与 commit character 单独记录；不要求复刻 IDEA 私有 rank 或把 basic 改名 smart。

依赖：ED-AUDIT-001。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

复用 __fixtures__/jdtls 下 maven-single，使用同 JDK/dependencies，在未导入类型和带参数方法位置请求 basic completion；用 Enter/Tab 接受，snippet Tab/Shift-Tab/Escape，Undo/Redo；另做 resolve 延迟时继续输入。记录主 edit、imports、caret、snippet stops、一次 undo 文本。IDEA 对不可直接控制的 LSP 延迟不作伪对比。

### 验收与验证

- **ED-AUDIT-007-A1：** 真实 provider 主 edit+import+snippet 由同一接受动作完成，并与 IDEA 同输入的用户结果对比；不支持的 completion 模式显式 unavailable。
- **ED-AUDIT-007-A2：** 延迟 resolve/取消/过期 document/provider 返回不能修改新文本；一次 undo 撤销该次所有 edits，history 与 selection 没有重复提交。
- **ED-AUDIT-007-A3：** 现有 completion focused/mounted 回归、真实 provider、当前端 native 与 IDEA comparison/typecheck 通过；ranking 差异不能被 label normalize 吞掉。

验证 V-007：lspCompletion.test.ts、lspCompletionChoice.test.ts、lspCompletionChoiceSession.test.ts、lspCompletionResolveGate.test.ts、CodeMirrorHost.completion.test.tsx；TC-IDE-C2-01/03/05。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。

<a id="ed-audit-008"></a>
## ED-AUDIT-008 Intention 预览提交与失败对齐

### 目标与代码事实

Alt+Enter 与同一 action 的其他入口使用同一 preview/commit owner，并显示真实失败与恢复结果。

CodeWorkspaceTab.tsx runCodeAction 已消费 canonicalCodeActionService.applyPlan；codeActionProviderAdapter.ts、intentionSession.ts 与 workspaceEditApply/history 组成可复用事务链。

### Owner 与实现契约

src/components/editor/workspace/codeActionProviderAdapter.ts、intentionSession.ts、codeActionExecution.ts；CodeWorkspaceTab.tsx 的 requestCodeActions/runCodeAction 及其具体调用入口。

request->resolve->immutable plan->preview->validate->apply->verify->history，保留 plan-only 的零副作用边界。provider command 是可能产生额外 effect 的独立轴，不能在 command 失败后把已写文本说成零效果。preview cancel/失焦/文件换代后关闭旧 session，不让结果夺焦点。菜单及 Alt+Enter 均进入同 owner，禁止重新添加 legacy executor。

依赖：ED-AUDIT-001。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

maven-single 未导入 StringUtils，通过 IDEA intention 与 Taomni Alt+Enter 选择 import quick fix；捕获可选项、预览/直接 apply 实际行为、文本和 Undo。另用两文件真实 provider edit 验证 preview 取消；command exception、request cancel/stale 在回归层模拟并记录哪些不能在 IDEA 精确复现。

### 验收与验证

- **ED-AUDIT-008-A1：** Alt+Enter 及另一实际 UI 入口的同 action 产生同一个实际 commit 与一次 history；import quick fix 在真实两端有可比后置文本。
- **ED-AUDIT-008-A2：** resolve null/malformed/failure、preview cancel、stale 与 command failure 分别显示准确结果；已改文件的 recovery 不被零效果文案掩盖。
- **ED-AUDIT-008-A3：** focused/mounted、provider、当前 native、IDEA comparison 与 typecheck 完成；apply 前后和 undo 的文本/hash 有可获取的真实产物。

验证 V-008：codeActionProviderAdapter.test.ts、intentionSession.test.ts、codeActionExecution.test.ts、workspaceEditApply.test.ts、CodeWorkspaceTab.test.tsx 的 code-action 用例；复用 __fixtures__/jdtls/runner/run-jdtls-fixture.mjs 的实际支持参数，新增本卡 UI case 前核对已有覆盖。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。

<a id="ed-audit-012"></a>
## ED-AUDIT-012 语义结果跳转与返回历史对齐

### 目标与代码事实

从语义定义/用法结果跳转后能回到发起位置，旧查询不污染当前页或导航历史。

useWorkspaceNavigation.ts、navigationHistoryModel.ts 和 UsagesScopeDialog.tsx 已存在；现有 TC-IDE-C6-01/02/05 可作真实 provider 入口。此卡不实现新的搜索引擎或全套层次面板。

### Owner 与实现契约

src/components/editor/workspace/useWorkspaceNavigation.ts、navigationHistoryModel.ts、UsagesScopeDialog.tsx；CodeWorkspaceTab.tsx query definition/references callbacks 与 reveal/history owner。

在 request 时记录发起 document/view/position、provider 与 project identity；成功 reveal 后才写一次导航历史。结果未就绪、目标不存在、cancel/stale 不移焦点或加 history。library URI 与 workspace 路径显式区分，无法读取目标时有可见解释。pin 的结果保留原 query identity，rerun 明确产生新快照。

依赖：ED-AUDIT-001。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

maven-single 的 App/AppTest 与一个 library symbol；IDEA/Taomni Go to Declaration、Find Usages、打开第二条结果、Back/Forward；pin 后修改源文本 rerun。记录路径/范围、去重、结果顺序、reveal caret 和返回位置；库依赖差异单列。

### 验收与验证

- **ED-AUDIT-012-A1：** 同 fixture 的定义/用法目标和 reveal/back 位置可比较，修复确认的漏跳/错跳/重复 history；不把 lexical scan 伪称语义全集。
- **ED-AUDIT-012-A2：** missing/library target、取消、切换 workspace、旧查询迟到都不夺焦点或污染 history；pin/rerun 的 scope 和 generation 可追溯。
- **ED-AUDIT-012-A3：** navigation focused/mounted、实际 provider、当前端 native、IDEA comparison 和 typecheck 通过，未支持的库能力明确作为未达到而非匹配。

验证 V-012：useWorkspaceNavigation.test.tsx、navigationHistoryModel.test.ts、navigationHistoryV2.test.ts、UsagesScopeDialog.test.tsx、__fixtures__/jdtls/jdtlsUsagesContract.test.ts；TC-IDE-C6-01/02/05。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。

<a id="ed-audit-015"></a>
## ED-AUDIT-015 Rearrange 支持分支接入实际事务

### 目标与代码事实

Rearrange Code 在有实际能力时执行成员重排，而不是仅出现执行文案。

CodeWorkspaceTab.tsx 11789 起 workspace.rearrangeCode 的 execute 分支只 setStatusMessage 后 return true；buildRearrangePlan 仅在 rearrangeCleanupWorkflow.ts 定义，无生产调用。属于已确认的生产链断点。

### Owner 与实现契约

src/components/editor/workspace/rearrangeCleanupWorkflow.ts 仅 rearrange 部分；CodeWorkspaceTab.tsx workspace.rearrangeCode handler；codeActionProviderAdapter.ts 的确有必要的复用入口；相邻测试。与 ED-AUDIT-016 顺序修改共享文件。

明确能力必须解析到可调用的 provider action，不仅是 summary boolean 或字符串猜测。执行 handler 冻结 file/view/provider/revision，向具备 source.rearrange 类能力的真实 provider 请求专用 edit，buildRearrangePlan 生成 workspace preview，再交 canonical transaction apply/verify/history。无该 provider 保持具体 unavailable，不得用 formatting 或 optimizeImports 替代。providerAdvertised 但返回空 action/unsupported 必须结束 loading 并解释，无假 success。未发现可运行 provider 时本卡不能凭单测关闭。

依赖：ED-AUDIT-001、ED-AUDIT-008。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

Java 类含 field、constructor、methods，记录 IDEA arrangement rules/profile（不得假定默认规则）。两端按相同规则执行 file Rearrange，预览、取消、apply、Undo；再在 preview 后改成员。IDEA 的排列结果是该 rules fixture 的 oracle，差异必须有源文本 diff。

### 验收与验证

- **ED-AUDIT-015-A1：** 真实支持 provider 从 production Rearrange 入口产生专用重排结果，post text 与 IDEA 指定 rules 可对比；无 provider 时明确未达到该能力，不再出现执行成功假象。
- **ED-AUDIT-015-A2：** preview/cancel/stale/conflict 各有零提交回归；只读拒绝；apply 读取真实 post hash，单次 undo 恢复 preimage。
- **ED-AUDIT-015-A3：** unit/typecheck/mounted、当前 native、真实 capable provider 与 IDEA comparison 通过；仅 JDT LS unadvertised 探针不满足本卡 provider 成功验收。

验证 V-015：rearrangeCleanupWorkflow.test.ts 中新增支持分支 mounted 回归，CodeWorkspaceTab.test.tsx 从 action 入口断言文本变化；TC-IDE-C8-04 仅证明 unavailable，需新增 capable provider 的 UI case。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。

<a id="ed-audit-016"></a>
## ED-AUDIT-016 Cleanup 支持分支接入实际事务

### 目标与代码事实

Code Cleanup 使用真实 cleanup profile 和 provider 事务产生修改，不将普通格式化假装为 cleanup。

CodeWorkspaceTab.tsx workspace.codeCleanup 的 execute 分支同样只写 Executing 文案；buildCleanupPlan 无生产调用。resolveCleanupCapabilities 还把 source.fixAll 等标记作为支持信号，需证明具体 profile 语义。

### Owner 与实现契约

src/components/editor/workspace/rearrangeCleanupWorkflow.ts 仅 cleanup 部分；CodeWorkspaceTab.tsx workspace.codeCleanup handler；复用 ED-AUDIT-008/015 的 canonical transaction 接口，不改 provider engine。

本卡范围固定当前文件和 default profile；其他 project/module/directory profile 明确 unavailable，不扩大到全项目 cleanup。将 capabilities 中 provider id/version/profile 解析到真正可执行 action 与规则集合。source.fixAll 不能自动证明等价 IDEA inspection profile。request/plan/preview/apply/postverify/undo 与 canonical owner 同链；空 edit 是 no-change 事实，不显示执行了修复；无法执行返回准确原因。

依赖：ED-AUDIT-001、ED-AUDIT-008、ED-AUDIT-015。变化严格限制本卡职责；变更 transport/Rust 时补原生 ABI 和 focused Rust 验证，不用 stub 替代 provider。

### IDEA 实测与 fixture

同 Java fixture 含 provider 支持且与 IDEA 选定 cleanup profile 等效的至少一个问题；记录规则启用列表。IDEA Code Cleanup 与 Taomni file cleanup 执行前后 diff，取消后 hash、只读拒绝、Undo；不以 unsupported trace 当 capable-run。

### 验收与验证

- **ED-AUDIT-016-A1：** 生产 Cleanup 入口运行真实 cleanup action，profile/规则可追溯，至少一个真实修复与 IDEA 对比；当前文件外文本不变。
- **ED-AUDIT-016-A2：** profile 不支持、provider failure、no-change、取消/stale/conflict 均有准确可见状态；preview 后不静默改范围，单次 undo/恢复经过 postcondition 断言。
- **ED-AUDIT-016-A3：** unit/typecheck/mounted、当前 native、capable provider 和 IDEA comparison 全通过；无法获得等效 provider profile 时保留明确缺口，不能改成格式化后关闭。

验证 V-016：rearrangeCleanupWorkflow.test.ts 的 cleanup 子集、CodeWorkspaceTab.test.tsx 支持分支；TC-IDE-C8-04 保留 unavailable 回归，新增 file-cleanup capable case 并关联真实 provider fixture。 执行 `pnpm exec vitest run <本卡文件>` 与完整 owner scope 的 typecheck；每个 A ID 对应同场景主流程、负路径与交付检查。新 case/runner 命令需实现并校验后才可记录实际执行。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`、`idea-comparison`。所有计划当前待执行。mock-only 证明模型边界；无真实 IDEA/provider/native 时保持未运行或 implemented，不标 done。
