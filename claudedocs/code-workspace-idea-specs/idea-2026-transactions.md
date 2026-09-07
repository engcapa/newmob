# 保存与重构恢复详细设计

必读 [IDEA 对比契约](./idea-2026-comparison.md)、[共享合同](./shared-contracts.md)。
产品数据模型沿用现有 typed effects；IDEA 不暴露的 IPC 状态仅作为 Taomni 安全契约，不宣称 IDEA 采用相同内部实现。所有性能、native、provider 和 IDEA 检查在本设计中均待执行。

<a id="ed-audit-004"></a>
## ED-AUDIT-004 保存中的输入竞争与最终字节对齐

### 用户结果与当前代码

保存后磁盘是该次冻结快照的最终编码字节；保存期间新输入继续保留为 dirty，关闭的编辑器不因回包重新出现。

`src/components/editor/workspace/saveCommit.ts` 已定义 PreparedSave、FinalBytesReceipt、SaveCommitResult。其 diskEffect 为 none/committed/unknown，memoryEffect 分离 saved-current/kept-dirty/writeback-discarded。CodeWorkspaceTab.tsx 的 open/closed save catch 走 saveCommitResultFromError。这是已有机制，本卡核验并修复实际 caller 的差距，不重建另一 save pipeline。

### Owner 与方案

Owner：`src/components/editor/workspace/saveCommit.ts`、`saveNormalizationPipeline.ts`、`saveOrganizeImportsAdapter.ts`；`CodeWorkspaceTab.tsx` 的 prepare/write/writeback；IPC 入口 `src/lib/editor/workspace.ts` 和 `src-tauri/src/workspace_fs.rs` 若变更则必须追加 rust evidence。依赖 ED-AUDIT-001。

1. 保存开始冻结 document revision、style/project/provider generation、encoding/EOL/BOM 与 expectedDiskHash。六阶段 normalization 只形成 immutable plan，organize-imports 保持 plan-only。
2. writer 对精确快照编码且 BOM/EOL 仅写一次，receipt 的 bytes hash 必须来自真实写入确认；错误不得构造成功 receipt。
3. 新输入出现在 await 期间：旧快照 landed 就返回 saved-stale-snapshot，保留新输入 dirty，LSP 同步当前内容。owner 已关闭时 committed-writeback-discarded 不重开 tab。
4. expectedDiskHash 冲突为 conflict，不写盘；取消只有 pre-write 才可声称零 diskEffect。传输不确定为 unknown，提供 recoveryId，先读取实际文件核对再允许重试，避免重复执行有副作用的 provider command。
5. 沿用现有保存错误反馈/编码入口，不增加默认自动保存策略；明确 Undo 是否只改 buffer，磁盘需再次 Save。不得擅自让 editor Undo 自动回写文件以迎合测试。

### 相同 fixture 与 IDEA 动作

在两端关闭会干扰测试的自动保存并记录设置，准备带中文、非 BMP 字符和尾随空格的 UTF-8/UTF-8-BOM/UTF-16LE 文件，分别 LF/CRLF。由两端现有编码/EOL 设置执行 Save，独立读取最终字节。改变文本再 Undo/Save，记录 buffer dirty 与磁盘变化。

正常保存、外部改文件后保存、只读失败可作真实 IDEA 对比。IPC 延迟/new typing/owner close/unknown acknowledgement 在 Taomni 回归中受控复现；IDEA 若无法重现同等时序，记录安全扩展，不伪造其内部状态。当前端 native 用独立 fixture 模拟失败；Windows 用文件锁或 ACL，Linux/macOS 用本测试有权限恢复的只读状态。

### 验收与验证

- **ED-AUDIT-004-A1：** UI Save 的编码/EOL/BOM 最终字节和 Undo/再保存行为有两端实测；BOM 不重叠、CR 不重复、receipt 与独立磁盘 hash 一致。
- **ED-AUDIT-004-A2：** 写入时输入、关闭、external conflict、known failure、unknown acknowledgement 分别返回准确效果轴；新输入不丢失，零效果路径无 history，unknown 未核对前不盲重试。
- **ED-AUDIT-004-A3：** focused/mounted、当前平台 native 文件断言、IDEA comparison、全部 owned path typecheck 通过；若改 Rust 追加真实测试；另两端有设置和未验证项。

验证 V-004：`pnpm exec vitest run src/components/editor/workspace/saveCommit.test.ts src/components/editor/workspace/saveNormalizationPipeline.test.ts src/components/editor/workspace/saveOrganizeImportsAdapter.test.ts`；补 CodeWorkspaceTab.test.tsx 的 owner 竞争回归；扩展 TC-IDE-C0-01/02，不用 observation 注入 receipt 作为通过。保存原始字节/hash、dirty 可见状态和 Undo 后内容；恢复只读 fixture 属性。
必需证据：code-audit、unit、typecheck、browser、native、idea-comparison。

<a id="ed-audit-014"></a>
## ED-AUDIT-014 Refactor postcondition 失败阻断与恢复入口

### 已确认代码差距

`src/components/editor/CodeWorkspaceTab.tsx` 8941 附近在 verifyRefactorPostHashes 失败时仅 console.warn；接着可将 recoveryEntry.status 写为 committed 并登记正常 history。journal 在 mutation 之后才生成，崩溃发生于首次写入与 journal 之间无法据此恢复。

`src/components/editor/workspace/refactorPlan.ts` 的 recordRefactorRecoveryJournal 吞掉 storage 错误；replayRefactorRecoveryJournal 逐项 applyText 后直接返回 preHashesRestored: true，没有读取核验；该 replay 没有 production caller。这些代码事实要求实际实现修复，不能只补一份对比报告。

### Owner、范围与持久化

Owner：`refactorPlan.ts` 的 journal/verify/replay，`CodeWorkspaceTab.tsx` 的 workspace-edit/refactor prepare/commit/recovery handlers，复用 `workspaceEditApply.ts`、`workspaceEditHistory.ts`；必要 UI 使用现有确认/preview 弹窗。新增 `refactorRecoveryController.ts`（拟新增）负责当前 workspace 恢复生命周期，避免把所有逻辑堆入 Tab。依赖 ED-AUDIT-001；只覆盖 text-only 多文件 rename/refactor，create/rename/delete 资源操作需保留明确不支持恢复边界，不伪称覆盖。

保持 v1 journal 可读，但视为 unverified；新条目采用独立 v2 schema，含 workspace identity、transactionId、每资源 pre/post hash、encoding/EOL/BOM、状态及 applied operation index。使用独立 key 前缀，读取时验证 JSON/schema/路径属于当前 fixture/workspace，不自动重放未知旧数据。实现前先核对现有 storage/recovery adapter 并复用；不能把吞错 localStorage 写入声明为耐断电的磁盘事务。

### 事务与失败设计

1. 在 mutation 前构建完整 preimage/expected postimage，保存 prepared journal 并获得明确成功；持久化失败在变更前终止，显示可重试原因。journal write 接口返回 typed success/failure，不吞 quota/error。
2. 记录 applied index；实际 postimage 对不上或读取失败时进入 recovery-required，禁止 committed 成功提示和正常成功 history；已经发生的 effect 必须列明，不能改叫 cancelled。
3. 恢复控制器在 workspace 就绪时发现本 workspace 的 pending 条目，通过现有确认/preview 工作流显示涉及资源、恢复/暂不处理操作；不自动覆盖磁盘。关闭 workspace 释放 pending async owner。
4. 用户选择恢复前，逐文件读取当前 hash；只在当前内容等于已知 pre/postimage 时允许恢复，第三方修改标 conflict，零覆盖。dirty open buffer 同样校验 document revision。
5. 恢复使用现有编码 writer 和事务路径，逐文件回读；只有全部 preHashes 确认恢复才能标 rolled-back。失败保留 pending 条目和已恢复集合；重复恢复幂等，不伪造 preHashesRestored。
6. 正常成功只有 postcondition 全通过后标 committed，并注册一次真实 Undo/Redo；撤销也需检查当前 preconditions，不能覆盖用户后续编辑。

不承诺跨多文件 OS 写入天然原子性；以 journal + effect ledger + verified recovery 保证可追溯。回滚代码保留 v1/v2 未处理条目，不删除用户恢复数据。敏感源文本 journal 只写当前应用隔离存储，不进入 release 日志或 Git。

### IDEA 行为对比

同 maven-single 两文件 rename，通过 IDEA Rename Preview 与 Taomni rename 入口比较 preview 文件集合、取消、apply、单次 undo、外部修改冲突。记录 IDEA 2026.2 的实际 Undo 行为，不推断它的恢复存储实现。
Taomni 特有 post-hash mismatch、storage quota、first-write 后中断、restart replay 由真实 QA fixture/单测验证，明确属于恢复安全扩展。此卡不能把 IDEA 正常 rename 的通过当作 Taomni crash recovery 通过。

### 验收与验证

- **ED-AUDIT-014-A1：** 从 production rename 入口注入实际 postcondition mismatch 时不登记成功 committed/history；返回 recovery-required 和准确 affected files；正常真实 provider rename 的 preview/apply/undo 与 IDEA 比较通过。
- **ED-AUDIT-014-A2：** journal prepared 在首次 mutation 前完成；持久化失败零写入；中断重开能通过真实 UI 发现 pending 条目，第三方内容 conflict 不覆盖；同一恢复重复执行幂等。
- **ED-AUDIT-014-A3：** 恢复后独立回读所有 preimages 才报告成功，读/写失败保存 pending 状态；focused/mounted、native restart/disk、provider、IDEA 与完整 owner scope typecheck 通过，v1 数据不被自动重放。

验证 V-014：扩展 `refactorPlan.test.ts`、`workspaceEditApply.test.ts`、`workspaceEditHistory.test.ts`、`CodeWorkspaceTab.test.tsx`，新增 `refactorRecoveryController.test.ts`（均对应上述真实 owner）。TC-IDE-C6-04 复用正常路径；拟新增当前端 restart-recovery case，按 qa-ui-auto 原生生命周期能力实现，不用 page reload 冒充进程崩溃恢复。收集真实 JDT LS rename、修改前后磁盘 hash、journal 状态和恢复 UI 结果。故障 fixture 保留首次失败证据再恢复。
必需证据：code-audit、unit、typecheck、browser、native、provider、idea-comparison。

