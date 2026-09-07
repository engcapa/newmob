# Code Workspace IntelliJ IDEA 2026.2 对齐任务板

## 1. 任务规则

本文件管理任务、依赖和规格索引；实施要求以卡片指向的 spec 为准。一次领取一张卡，完成该卡的生产效果及必要证据。所有卡均为待实现或待核验，不能把本文件理解为功能已经完成。

使用 `code-workspace-idea-task`，每次调用任务板脚本都显式指定本文件：

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md list --claimable
```

领取、更新命令见技能的 task-lifecycle。依赖未完成的 ready 卡不能领取；已存在实现时先核验，仅修复当前代码与本卡验收之间的差距。不得修改旧卡状态来代替完成本卡。

## 2. 详细规格索引

| 规格 | 内容 |
|---|---|
| [共享合同](./code-workspace-idea-specs/shared-contracts.md) | 状态、owner、事务与证据语义 |
| [IDEA 对比契约](./code-workspace-idea-specs/idea-2026-comparison.md) | 版本、fixture、动作记录、数据接口、平台手册、校验设施 |
| [编辑与输入](./code-workspace-idea-specs/idea-2026-editing.md) | Virtual Space、分屏、剪贴板、IME |
| [语义操作](./code-workspace-idea-specs/idea-2026-semantic.md) | 替换、completion、intention、导航、rearrange、cleanup |
| [保存与恢复](./code-workspace-idea-specs/idea-2026-transactions.md) | 保存竞争、重构 postcondition 与恢复 |
| [性能与门禁](./code-workspace-idea-specs/idea-2026-performance.md) | 输入热路径、多标签恢复、发布能力矩阵 |

## 3. 交付标准

每卡拥有独立的 `ED-AUDIT-xxx-A1/A2/A3`。本轮原生验证要求当前执行平台；Windows、Linux、macOS 分别记实测或未验证，不能推广单端结论。没有 IDEA 2026.2 实测时，所需 `idea-comparison` 层保持未运行，不能编造行为或通过证据。

`ED-AUDIT-001` 交付对比校验设施，其余行为卡负责各自真实样本与实现。共享 `CodeWorkspaceTab.tsx` 只按具体 handler/owner 修改；同时领取者必须协调重叠范围。`ED-AUDIT-006` 独家持有本板全仓 build 汇总，功能卡运行自己的 scoped typecheck，不得为绿灯排除自己造成的错误。

## 4. 任务卡

### ED-AUDIT-001 IDEA 对比记录契约与校验器
<!-- ide-task {"id":"ED-AUDIT-001","status":"ready","priority":"P0","size":"M","depends_on":[],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-comparison.md#ed-audit-001","acceptance":["ED-AUDIT-001-A1","ED-AUDIT-001-A2","ED-AUDIT-001-A3"],"required_evidence":["document","unit"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"新增对比数据校验设施；现有 QA receipt 只证明 Taomni 执行，不能生成 IDEA 观测。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-comparison.md#ed-audit-001)。

### ED-AUDIT-002 Virtual Space 插入与撤销对齐
<!-- ide-task {"id":"ED-AUDIT-002","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-editing.md#ed-audit-002","acceptance":["ED-AUDIT-002-A1","ED-AUDIT-002-A2","ED-AUDIT-002-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"workspaceVirtualSpace 已有独立 overflow state；逐动作 IDEA 语义需要实测确认。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-editing.md#ed-audit-002)。

### ED-AUDIT-003 文件替换范围与冲突对齐
<!-- ide-task {"id":"ED-AUDIT-003","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-003","acceptance":["ED-AUDIT-003-A1","ED-AUDIT-003-A2","ED-AUDIT-003-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"已有 find scope / replace model；需核对 preview 到文件写入的一致范围。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-003)。

### ED-AUDIT-004 保存中的输入竞争与最终字节对齐
<!-- ide-task {"id":"ED-AUDIT-004","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-transactions.md#ed-audit-004","acceptance":["ED-AUDIT-004-A1","ED-AUDIT-004-A2","ED-AUDIT-004-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"SaveCommitResult 已区分 committed/unknown 和 dirty writeback；本卡核对真实保存动作。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-transactions.md#ed-audit-004)。

### ED-AUDIT-005 输入延迟实测与热路径优化
<!-- ide-task {"id":"ED-AUDIT-005","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-performance.md#ed-audit-005","acceptance":["ED-AUDIT-005-A1","ED-AUDIT-005-A2","ED-AUDIT-005-A3"],"required_evidence":["code-audit","unit","typecheck","performance","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"必须测生产 CodeMirrorHost 输入链；字符串/rope 微基准不能证明编辑器延迟。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-performance.md#ed-audit-005)。

### ED-AUDIT-006 当前源码门禁与能力发布矩阵
<!-- ide-task {"id":"ED-AUDIT-006","status":"ready","priority":"P2","size":"S","depends_on":["ED-AUDIT-002","ED-AUDIT-003","ED-AUDIT-004","ED-AUDIT-005","ED-AUDIT-007","ED-AUDIT-008","ED-AUDIT-009","ED-AUDIT-010","ED-AUDIT-011","ED-AUDIT-012","ED-AUDIT-013","ED-AUDIT-014","ED-AUDIT-015","ED-AUDIT-016"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-performance.md#ed-audit-006","acceptance":["ED-AUDIT-006-A1","ED-AUDIT-006-A2","ED-AUDIT-006-A3"],"required_evidence":["code-audit","build","qa-lint","document"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"汇总本任务板能力及当前 source/case/runner identity，不复用过期 PASS。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-performance.md#ed-audit-006)。

### ED-AUDIT-007 Completion 接受与单次撤销对齐
<!-- ide-task {"id":"ED-AUDIT-007","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-007","acceptance":["ED-AUDIT-007-A1","ED-AUDIT-007-A2","ED-AUDIT-007-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"生产 commitLspCompletion 已处理 edit/snippet；需真实 provider 与 IDEA 对比接受边界。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-007)。

### ED-AUDIT-008 Intention 预览提交与失败对齐
<!-- ide-task {"id":"ED-AUDIT-008","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-008","acceptance":["ED-AUDIT-008-A1","ED-AUDIT-008-A2","ED-AUDIT-008-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"runCodeAction 已调用 canonical applyPlan；对比 apply/command failure 与 history。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-008)。

### ED-AUDIT-009 同文档分屏与关闭重开对齐
<!-- ide-task {"id":"ED-AUDIT-009","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-editing.md#ed-audit-009","acceptance":["ED-AUDIT-009-A1","ED-AUDIT-009-A2","ED-AUDIT-009-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"已有 document transaction owner、tab policy；核对 shared history 与独立视图状态。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-editing.md#ed-audit-009)。

### ED-AUDIT-010 系统剪贴板多光标粘贴对齐
<!-- ide-task {"id":"ED-AUDIT-010","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-editing.md#ed-audit-010","acceptance":["ED-AUDIT-010-A1","ED-AUDIT-010-A2","ED-AUDIT-010-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"clipboard session 已区分 permission 与 systemEffect；需验证 OS 与内存 fallback 边界。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-editing.md#ed-audit-010)。

### ED-AUDIT-011 IME 输入期间的命令与焦点隔离
<!-- ide-task {"id":"ED-AUDIT-011","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-editing.md#ed-audit-011","acceptance":["ED-AUDIT-011-A1","ED-AUDIT-011-A2","ED-AUDIT-011-A3"],"required_evidence":["code-audit","unit","typecheck","native","accessibility","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"CodeMirrorHost 有 composing guards；全局 action 层及真实输入法仍需逐端验证。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-editing.md#ed-audit-011)。

### ED-AUDIT-012 语义结果跳转与返回历史对齐
<!-- ide-task {"id":"ED-AUDIT-012","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-012","acceptance":["ED-AUDIT-012-A1","ED-AUDIT-012-A2","ED-AUDIT-012-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"已有 navigation history 与 usage scope；本卡只核对语义结果到 reveal/back 的用户链路。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-012)。

### ED-AUDIT-013 多标签恢复的可交互时机优化
<!-- ide-task {"id":"ED-AUDIT-013","status":"ready","priority":"P1","size":"M","depends_on":["ED-AUDIT-001","ED-AUDIT-009"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-performance.md#ed-audit-013","acceptance":["ED-AUDIT-013-A1","ED-AUDIT-013-A2","ED-AUDIT-013-A3"],"required_evidence":["code-audit","unit","typecheck","performance","native","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"planWorkspaceRestore 已有 active/background 两阶段和有界队列；需测 active-ready 真实边界。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-performance.md#ed-audit-013)。

### ED-AUDIT-014 Refactor postcondition 失败阻断与恢复入口
<!-- ide-task {"id":"ED-AUDIT-014","status":"ready","priority":"P0","size":"M","depends_on":["ED-AUDIT-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-transactions.md#ed-audit-014","acceptance":["ED-AUDIT-014-A1","ED-AUDIT-014-A2","ED-AUDIT-014-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"当前 post-hash mismatch 仅 console.warn 后继续记录 committed/history；journal 写在 mutation 后且 replay 无生产调用。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-transactions.md#ed-audit-014)。

### ED-AUDIT-015 Rearrange 支持分支接入实际事务
<!-- ide-task {"id":"ED-AUDIT-015","status":"ready","priority":"P0","size":"M","depends_on":["ED-AUDIT-001","ED-AUDIT-008"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-015","acceptance":["ED-AUDIT-015-A1","ED-AUDIT-015-A2","ED-AUDIT-015-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"workspace.rearrangeCode 的 execute 分支只更新状态；buildRearrangePlan 无生产调用。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-015)。

### ED-AUDIT-016 Cleanup 支持分支接入实际事务
<!-- ide-task {"id":"ED-AUDIT-016","status":"ready","priority":"P0","size":"M","depends_on":["ED-AUDIT-001","ED-AUDIT-008","ED-AUDIT-015"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-016","acceptance":["ED-AUDIT-016-A1","ED-AUDIT-016-A2","ED-AUDIT-016-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-07","head":"6cda8077b17218ad72cff09ae693a3e55f6ffce5","finding":"workspace.codeCleanup 的 execute 分支只更新状态；buildCleanupPlan 无生产调用。"},"prior_completion":{"kind":"new-task","completed":false}} -->

[设计、代码职责、验收与验证](./code-workspace-idea-specs/idea-2026-semantic.md#ed-audit-016)。
