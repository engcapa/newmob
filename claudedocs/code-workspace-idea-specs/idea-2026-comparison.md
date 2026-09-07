# IDEA 2026.2 行为对比与交付契约

## 1. 设计边界

配合 [共享合同](./shared-contracts.md) 与 [任务板](../code-workspace-idea-parity-backlog-2026-09-audit.md) 使用。后续能力规格继承本文件。规格状态为可开展实现和采样，所有实际运行证据初始为未执行。当前代码定位基于 `6cda8077b17218ad72cff09ae693a3e55f6ffce5`，接手时必须重查 production caller。

目标是实现可观察编辑行为的一致性，不复制 IDEA 的 PSI、专有索引或排序引擎。每个工作包先在 IDEA 2026.2.x 实测本卡动作，再映射到 Taomni owner 和验收；不能用其他版本或当前官网文本代替该版本实测。本设计没有声称已经运行 IDEA。

### DEC-01 复用 QA 设施

采用现有 qa-ui-auto runner、summary、receipt、status 和 feature catalog，只新增独立对比记录及校验命令，不另建动作 DSL、签名系统或通用自动化框架。理由：现有工具已管理 Taomni 的隔离、命令、真实执行与来源身份；IDEA 端用可重复手工步骤或已有 OS 自动化即可采集。此为沿用工程设施的局部设计决定。

### DEC-02 对齐策略

先比较结果集合、字节/文本、caret/selection、焦点、history、失败和恢复。排序、推荐策略和 provider 能力须单独记录。被测方法应调用真实 UI 入口；直接写 store 或伪造 provider response 只可用于回归测试，不能作为真实行为对比证据。IDEA 没有对应的 Taomni 内部失败状态时记为 Taomni 安全扩展，仅对比用户可见结果，不虚构 IDEA IPC 语义。

### DEC-03 门禁与状态

历史失败后同类当前检查通过是合法历史，不是缺陷。非必需层的 unrun 不自动否定 done；反之，必需层缺失或最终失败不能记 done。本板 build 汇总归 ED-AUDIT-006；不继承共享合同中旧板的 gate ID 列表。维持三端代码兼容，当前平台 native 达标可以关闭单卡，但不能声明三端已实测。已知兼容性错误必须解决。

## 2. 对比记录接口（拟新增）

ED-AUDIT-001 负责在 `claudedocs/code-workspace-idea-specs/idea-comparison.schema.json` 定义 JSON Schema，在 `.agents/skills/code-workspace-idea-task/scripts/compare_idea.py` 实现标准库 CLI 校验。schema 文档与 CLI 规则保持一致；已有解析工具可复用，不引入新的平台 driver。

每个文件含以下字段。实际采样文件写入被忽略的 `qa-ui-auto-report/idea-comparison/<task>/<run>/`，入库文档只记录脱敏结论、hash、执行步骤及可获取原始产物的位置。

| 字段 | 类型 / 要求 |
|---|---|
| schemaVersion, taskId, acceptance | `1`、本卡 ID、该卡完整验收 ID 数组 |
| scenarioId, fixture | 场景 ID；fixture 包含相对文件路径与 SHA-256、初始内容来源、根目录别名、初始 dirty/磁盘状态 |
| settings | keymap 名称与 action 绑定、editor/formatter 参数、语言、JDK、项目导入/indexing 就绪条件、locale、相关插件 |
| steps | 有序对象：stepId、actionName、实际 key/chord 或菜单路径、输入值、前置状态、需观察字段；不是可直接执行的新 DSL |
| idea | version=2026.2.x、完整 build number、edition、OS、采样时间、operator 或自动化工具、设置快照、原始产物列表、逐步骤 observations |
| taomni | HEAD 加源码内容身份、QA build identity、OS/WebView、provider ID/version、mode、summary/receipt 路径与 hash、逐步骤 observations |
| observations | stepId、status、documents（相对路径、文本/字节 hash、dirty）、caret/selection、focus target、结果项或范围、history/undo、错误/恢复事实 |
| deltas | field、idea value、taomni value、分类、linkedAcceptance、解释及处置；不得只写“相同” |
| verdict, ceiling | `matched / different / incomparable / unverified`；能力、fixture、provider、平台、通过层级 |
| artifacts | 相对路径、SHA-256、类型、获取方式；原始文件缺失不能充当可重验 passing 证据 |

路径采用 fixture 根的相对路径；只规范化 OS 路径分隔符和预先声明的运行目录别名。文本、BOM、EOL、字节 hash、结果顺序、耗时不得规范化掉。比较文本 offset 统一为 UTF-16，视觉列单独保存 grapheme/tabSize 与像素观测。两端 provider 不同是事实，不能伪称同一 provider；源码、JDK、动作和就绪前提才是可比条件。

`matched` 要求规定字段全部可比且无未解释差异。`different` 记录真实差距；`incomparable` 用于版本/fixture/动作/平台前提不匹配；缺一端运行是 `unverified`。validator 不凭合法 JSON 签发运行证明。

## 3. 每卡执行流程

1. 读本文件和所选能力章节，核对列出的 owner/caller；把每个 A ID 映射到一个完整生产路径。
2. 在独立 fixture 工程运行 IDEA 2026.2.x；从 Help/About 记录完整 build，记录 keymap/action 和 settings；等待项目索引完成。每个正常/撤销动作至少重复一次。没有此版本就明确留下缺口。
3. 用相同初始内容在独立 Taomni QA workspace 重置并执行同动作。通过文件读取、可见 selection/focus、结果列表及撤销后文本采集事实。仅在单测注入 timeout/stale 等受控故障；native 异常只使用隔离 fixture。
4. 给 confirmed delta 添加失败回归，修改具体 owner，复跑该回归与相邻行为。已经满足的代码不重复实现；存在功能差距时不能只交付对比报告。
5. 运行本卡 evidence kinds；原始失败保留在重跑通过之前。每个 A ID 在 evidence checks 中有真实通过覆盖，任何未解决的实质行为差距都阻止 done。

产品 UI 沿用现有命令、弹窗和反馈，不在本设计增加布局或技术栈。恢复等行为复用现有确认/预览流程。涉及 materially 不同的 provider 能力或不可逆恢复选择时记录 review_required，写具体选择，不能自行弱化卡片目标。

## 4. QA 命令与平台手册

仓库根目录，先设置 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts`（PowerShell 用 `$env:PYTHONPATH`）。以下为现存入口，filter 和 feature 使用各卡列出的实际 ID；新增 case 在创建并注册之前不能执行。

```bash
python -m qa_ui_auto plan --diff HEAD
python -m qa_ui_auto run --mode browser --filter TC-IDE-C4-02 --require-pass
python -m qa_ui_auto status --feature F25.5 --json
python -m qa_ui_auto audit --gate
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/workspace/workspaceDocumentTransactionOwner.ts
```

typecheck 的所有实际改动 owner/source/test 路径均用重复 `--path` 加入；上面是单路径示例，不是该卡的完整 scope。`pnpm exec vitest run <本卡已有测试文件>` 运行 focused tests；变更 Rust 时从 src-tauri 运行聚焦 `cargo test --lib <实际模块名>`，macOS 先遵守 AGENTS 的 krb5 stage。

| 平台 | 准备与实际执行 | 必须记录的限制 |
|---|---|---|
| Linux | 阅读 qa-ui-auto native-testing；native_build.py 独立编译 QA；tauri-driver + WebKitWebDriver，真实桌面或 Xvfb，菜单/编辑及真实文件断言 | Xvfb 不等价实际 IME/compositor/物理键盘或硬件延迟；这些动作在实际桌面补测 |
| Windows | 同一 QA source build，tauri-driver 与匹配的 WebView2/msedgedriver；执行 Ctrl/Alt、剪贴板、锁定文件、盘符路径动作 | 保存原有 host clipboard 并在 finally 恢复；不能套用 Linux 权限 fixture |
| macOS | 独立 QA bundle，核实 CFBundleIdentifier=com.taomni.app.qa，独立用户/QA profile，使用 OS 自动化或逐步手工执行 | 无 Tauri WebDriver；禁止用 Chromium/WebKit browser 报告补成 native 自动化 pass |

native build/run 命令与隔离详见 `.agents/skills/qa-ui-auto/references/native-testing.md`，执行前必读。禁止改名生产 binary 充当 QA。新测试工作区只包含本卡 fixture；关闭本轮应用和 provider，恢复 clipboard、只读属性和环境，保留失败原始产物。

每个行为卡复用本卡具体 case，补漏项时按 authoring.md/verb-catalog.md 选择真实 verb 并维护 covers/controls/feature。case 编写不是 passed evidence。F25.5 为 editor shell、F25.3 为 appearance/actions；语义归属按现有 case 的 covers 核对，不能把全部新 case 硬塞进一个 feature。

发布验证区分：
- `audit --gate`：schema/catalog/static coverage；
- `status --gate --feature <已登记feature> --platform <当前平台>`：该选择范围的 reviewed/current executions；检查实际 selected/pass/fail/skip，不夸大到全产品；
- `audit --release-evidence`：现有 release manifest 校验。手工 IDEA/native 数据不能伪装为 runner summary。
共同遵守 qa-ui-auto verification.md：当前身份含未提交源码和 runner/case fingerprints；只记录 HEAD 不充分。

## 5. IDEA 资料定位与实测场景

官方主题只提供操作定位，不代表 2026.2 已实测：
[编辑](https://www.jetbrains.com/help/idea/using-code-editor.html)、
[多光标](https://www.jetbrains.com/help/idea/multicursor.html)、
[标签](https://www.jetbrains.com/help/idea/editor-tabs.html)、
[补全](https://www.jetbrains.com/help/idea/auto-completing-code.html)、
[Intention](https://www.jetbrains.com/help/idea/intention-actions.html)、
[导航](https://www.jetbrains.com/help/idea/navigating-through-the-source-code.html)、
[用法](https://www.jetbrains.com/help/idea/find-highlight-usages.html)、
[格式与重排](https://www.jetbrains.com/help/idea/reformat-and-rearrange-code.html)。
执行时保存使用的文档版本/访问时间与 IDEA build；用实测校准本卡期望，不能推断私有引擎内部行为。

<a id="ed-audit-001"></a>
## ED-AUDIT-001 IDEA 对比记录契约与校验器

**目标/owner：** 实现本文件第 2 节接口及 CLI，让行为卡可以复用相同记录格式。范围只限 schema、`compare_idea.py`、同目录拟新增 `test_compare_idea.py` 和本文件运行手册；不改 Taomni QA runner 签名/identity 或任何产品功能。

**实施：** CLI 接受 `--record <json>`，按 schema 与类型校验；默认报告四态 verdict，格式错误 exit 2；`--require-match` 对 different/incomparable/unverified exit 1，只有 matched exit 0。对 duplicate step、缺失观测、无 artifacts、fixture/build mismatch fail closed。允许 Taomni 专有负路径记录，但不能纳入 IDEA matched 分母。对未运行层保留显式理由。不加载/执行记录中的代码或动作。

**验收与验证：**
- **ED-AUDIT-001-A1：** 所有字段、四态结果、CLI exit code 与只允许的 normalization 被独立单测验证；原始文本/EOL/顺序差異不能被吞掉。证据 unit。
- **ED-AUDIT-001-A2：** 有效、版本不匹配、缺一端记录、篡改 artifact、重复 step、unverified 假 pass 六种 fixture 都产生确定结果；fixture 明确标为 synthetic validator tests，不能出现在 runtime passing matrix。证据 unit。
- **ED-AUDIT-001-A3：** 手册含命令、IDEA 人工采样表、三端 native 步骤及与 runner summary/receipt 的链接规则；另一张行为卡仅填写记录即可运行校验，不需要新增 DSL 或修改 verifier。证据 document。

实现后执行 `python -m unittest discover -s .agents/skills/code-workspace-idea-task/scripts -p 'test_compare_idea.py'`；真实 sample 由后续卡采集，本卡不以 schema 测试声称 IDEA parity。必需证据：document、unit。

