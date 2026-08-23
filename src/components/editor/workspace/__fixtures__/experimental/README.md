# Orphan Model Governance Registry (§8.17.9 N12 / N8.3)

基线：`b74705b5` 审计（设计文档 §2.25）标记的 8 个零生产引用模型，逐模块决策记录如下。
本目录（`__fixtures__/experimental/`）内的模型**不是生产代码**：无任何 production
import、不得接入 popup/action，也不计入生产能力等级；仅作为后续工作包的参考实现，
由同目录测试覆盖。删除的模型连同死测一并移除。

| 模型 | 决策 | Owner / Consumer | 状态 | 理由与后续入口 |
|---|---|---|---|---|
| `keymapModel.ts` (+test) | **迁入 experimental** | 无（原 §8.13 E2 草案） | fixture | 可编辑 keymap 归 G1.1 后续包；届时以 ActionHost snapshot 为唯一真值重建 wiring，本模型仅作 scheme/conflict-graph 参考 |
| `dependencyCompletion.ts` (+test) | **迁入 experimental** | 无 | fixture | N8.3 二选一：未接真实 Maven/Gradle provider 前，硬编码 popular list 不得进 popup；接线时须带 AbortSignal/timeout/typed unavailable/request generation/host replacement range |
| `fullLineCompletionModel.ts` | **迁入 experimental** | 无（A4） | fixture | Full Line local model 归 G3（独立按 edition/hardware/privacy 验收）；本地模型 runtime 另行设计 |
| `surroundGenerateModel.ts` (+test) | **迁入 experimental** | 无（E1.3/E3.3 草案） | fixture | Surround/Generate 属 P0/G1.0 功能面，但必须走真实 action + CodeAction/template engine；当前模板原型不满足 workflow contract |
| `javaSemanticIndex.ts` | **删除（含死测）** | 曾被下方两模型引用（岛内闭环） | removed | G2 Java semantic 将按 §8.17.9 在 `src-tauri/src/java_semantic/` 以后端边界重建（project/classpath fingerprint、declaration/reference identity）；regex index 不能代替 completeness |
| `javaInspectionEngine.ts` | **删除** | 岛内闭环 | removed | 同上；inspection 结果必须带 source/scope/completeness/revision/evidence |
| `semanticRefactorPlan.ts` | **删除** | 岛内闭环 | removed | refactor preview/conflict/post-condition/undo 由 G2 后端边界提供 |
| `structuralSearchModel.ts` | **删除（含死测用例）** | 无 | removed | §5.2.1 明确 SSR "不能退化为 regex"，模板原型即被禁止形态；SSR 归 P2/G3 独立 search tool window |

补充约束：

- `inspectionEvidence.ts` 保持 provider evidence helper 定位（source/scope/completeness/
  revision 展示），不升级为本地 inspection engine。
- 本目录文件禁止被 `src/` 下任何非 `__fixtures__` 文件 import；新增 import 会被
  review 拒绝（治理回归 = 重新打开 N12）。
- `advancedWorkflows.test.ts` 仅保留 A4 用例；A1 随删除模型移除，A2 由生产侧
  `recursiveLayoutTree.test.ts` 覆盖。
