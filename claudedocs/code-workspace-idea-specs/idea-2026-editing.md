# 编辑、视图与输入详细设计

必读 [IDEA 对比与平台契约](./idea-2026-comparison.md) 和 [共享合同](./shared-contracts.md)。本文件只规定现有 editor surfaces 的行为，不新增界面布局。以下测试路径未加目录者均相对 `src/components/editor/workspace/`；新增对象显式标注。所有验证待执行。

<a id="ed-audit-002"></a>
## ED-AUDIT-002 Virtual Space 插入与撤销对齐

### 用户目标与代码现状

光标越过行尾只改变视图状态，实际插入才产生 padding，并由一次 undo 恢复。

代码事实：workspaceVirtualSpace.ts 用 virtualSpaceOverflowField 和 EditorVirtualSpacePolicy 保存虚拟坐标，默认 afterLineEnd/atFileBottom 均关闭；CodeMirrorHost.tsx 消费该扩展。这证明有实现，不证明 IDEA 的所有移动/输入行为已对齐。

### 实施范围与状态

Owner：src/components/editor/workspace/workspaceVirtualSpace.ts、workspaceEditorCommands.ts、CodeMirrorHost.tsx 及相邻测试；CodeWorkspaceTab.tsx 仅相应 command context 绑定。

复用 overflow field 与 document transaction owner。冻结发起 view/document revision；根据 grapheme 和 tabSize 保存视觉列，实际 document offset 仍合法。各 leaf 的 overflow 独立；insert/paste/padding 合为一个 transaction，移动不产生文本或 undo 项。IME composing 时交回输入法。不得为了测试引入绕过 production dispatch 的 setter。

仅修改上述职责；出现别的功能差距单独记录。依赖：ED-AUDIT-001。每个操作都遵守共享 failure/cancel/stale/effect 契约，不用其他 owner 的成功测试代替本卡行为。

### IDEA 同场景步骤

UTF-8 文件三行：包含 tab 的长行、短行、空行，另含组合字符和 emoji。两端启用 after-line-end，关闭 at-file-bottom；从长行末向下、向右越过短行，输入 X，Undo/Redo；再分别开启 bottom policy 重复；两 split 交替操作。记录视觉列、UTF-16 offset、padding 数和 undo 后字节；记录 IDEA 实际设置名称与值。

### 验收与验证

- **ED-AUDIT-002-A1：** 两端同设置完成越界移动和插入，所有规定 caret/selection 与文本字段可比较；生产入口复现确认差距并实现修复，已经一致则给出当前证据。
- **ED-AUDIT-002-A2：** 不插入时文本/hash/history 不变；一次 undo 恢复插入前文本及虚拟 caret，redo 重放；readonly、revision stale、失焦和 composition 均不错误填空格。
- **ED-AUDIT-002-A3：** 改动 owner scoped typecheck、focused/mounted 回归、当前端 native 及本场景 IDEA 对比全部通过，其他两端记录未验证和动作清单。

验证 V-002：workspaceVirtualSpace.test.ts、workspaceEditorCommands.test.ts、workspaceDocumentTransactionOwner.test.ts；扩展 TC-IDE-C8-01 与 TC-IDE-C8-02。回归必须断言真实 editor 文本和 selection，不只检查 overflow 数组。 先运行对应 `pnpm exec vitest run <上述测试>`；QA/native/IDEA 执行方式见共享对比契约。逐项将 A1 主流程、A2 负路径与恢复、A3 交付门禁映射到 evidence checks；有实际变更时保留 baseline failing regression。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。当前平台 native 与 IDEA 缺失不能关闭 done；代码已齐但证据缺失为 implemented。

<a id="ed-audit-009"></a>
## ED-AUDIT-009 同文档分屏与关闭重开对齐

### 用户目标与代码现状

同文件分屏共享文本和撤销序列，caret/scroll/fold 独立，关闭重开不丢失 dirty 内容。

代码事实：workspaceDocumentTransactionOwner.ts 与 workspaceTabPolicy.ts 已存在；EditorGroup.tsx/CodeWorkspaceTab.tsx 是视图挂载与 tab 生命周期入口。是否与 IDEA 2026.2 默认 preview/pinned/reopen 行为一致仍需实测。

### 实施范围与状态

Owner：src/components/editor/workspace/workspaceDocumentTransactionOwner.ts、workspaceTabPolicy.ts、EditorGroup.tsx、workspaceLayoutPersistence.ts；CodeWorkspaceTab.tsx 仅 close/reopen/split/document routing handlers。

一个 canonical document key 对应一个 transaction owner；订阅以 view lease 释放，关闭其中一 leaf 不销毁另一 leaf 的 document/history。复用现有 persisted layout，旧 snapshot 缺字段采用现有默认值，不另建同类 store。重开恢复 URI/encoding/EOL/dirty 与视图 snapshot；关闭最后 dirty view 使用现有保存/放弃/取消流程。

仅修改上述职责；出现别的功能差距单独记录。依赖：ED-AUDIT-001。每个操作都遵守共享 failure/cancel/stale/effect 契约，不用其他 owner 的成功测试代替本卡行为。

### IDEA 同场景步骤

两端同一文件 split，左侧输入 abc，右侧输入 def，再分别 Undo；调整两边 caret/scroll/fold，pin/preview 后关闭一侧、重开，关闭最后 dirty view 并取消，再保存后重开。所有步骤记录文档版本、内容、焦点和 leaf 状态，IDEA keymap actionName 与实际键位分列。

### 验收与验证

- **ED-AUDIT-009-A1：** 两个真实 leaf 的编辑和 undo/redo 只进入同一逻辑历史，内容实时一致；独立 caret/scroll/fold 不被另一 leaf 输入覆盖，与 IDEA 同动作对比有结果。
- **ED-AUDIT-009-A2：** 关闭非最后 leaf 不丢文本/history；最后 dirty view 的取消零效果，保存失败不关闭；reopen 不复活错误 workspace 或改变编码。
- **ED-AUDIT-009-A3：** focused/mounted 生命周期测试、当前端 native（含重启读取 snapshot）、scoped typecheck 与 IDEA 对比通过；兼容旧 snapshot 的测试和两端未运行项保留。

验证 V-009：workspaceDocumentTransactionOwner.test.ts、workspaceTabPolicy.test.ts、workspaceTabPolicyV3.test.ts、EditorGroup.test.tsx；TC-IDE-C4-01/TC-IDE-C4-02。选取 CodeWorkspaceTab.test.tsx 中对应挂载流程并补缺失断言。 先运行对应 `pnpm exec vitest run <上述测试>`；QA/native/IDEA 执行方式见共享对比契约。逐项将 A1 主流程、A2 负路径与恢复、A3 交付门禁映射到 evidence checks；有实际变更时保留 baseline failing regression。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。当前平台 native 与 IDEA 缺失不能关闭 done；代码已齐但证据缺失为 implemented。

<a id="ed-audit-010"></a>
## ED-AUDIT-010 系统剪贴板多光标粘贴对齐

### 用户目标与代码现状

多光标复制/粘贴使用真实系统剪贴板，内部多片段元数据不会覆盖外部应用新内容。

代码事实：workspaceClipboardSession.ts 的 acquireClipboardStore/planPaste 与 GuardedSystemReadResult/WriteResult 已区分 permission、generation、performed/unknown；CodeMirrorHost 的剪贴板入口有 composing/revision guards。

### 实施范围与状态

Owner：src/components/editor/workspace/workspaceClipboardSession.ts、ClipboardHistoryPopup.tsx、CodeMirrorHost.tsx 剪贴板 handlers、src/lib/clipboard.ts；必要 IPC 变更追加真实 Rust owner 和 rust 证据。

system text 是 OS 事实；只有 session text identity 与读回内容一致才可使用 per-selection metadata。数量相同逐片段分配、数量不同的分配规则以 IDEA 同配置实测为准并固化回归。write/read await 后重验 lease+document+view；OS effect 已发生不能记 zero effect。permission unknown 不当 denied，真正 denied 的内部 fallback 需可见且说明来源。history privacy/清理沿用现有 policy。

仅修改上述职责；出现别的功能差距单独记录。依赖：ED-AUDIT-001。每个操作都遵守共享 failure/cancel/stale/effect 契约，不用其他 owner 的成功测试代替本卡行为。

### IDEA 同场景步骤

同 fixture 两处选择进行复制，切换 split 粘贴并 Undo；外部应用改写 OS clipboard 后再次粘贴；目标 caret 数为 1、2、3 分别记录。两端做空选择 copy/cut；Taomni 单测模拟系统读取拒绝及 await 后关闭 workspace。native finally 恢复原 host clipboard。

### 验收与验证

- **ED-AUDIT-010-A1：** 真实 OS 内容及 selection 数分配规则与 IDEA 对比明确，生产 paste 一次 transaction、一次 undo 恢复；外部修改后不使用旧 metadata。
- **ED-AUDIT-010-A2：** 拒绝/unknown/取消/stale 各有准确系统副作用事实；迟到读取不修改失去 owner 的 editor，history 不跨 workspace 泄漏，fallback 明确可见。
- **ED-AUDIT-010-A3：** focused unit、挂载入口、当前端 native 文件/clipboard 后置断言、typecheck 与 IDEA comparison 通过，未测 OS 不借 browser stub 通过。

验证 V-010：workspaceClipboardSession.test.ts、workspaceClipboardHistory.test.ts、ClipboardHistoryPopup.test.tsx；TC-IDE-C3-01/02/03。测试前先读现有 case covers 和 native clipboard fixture。 先运行对应 `pnpm exec vitest run <上述测试>`；QA/native/IDEA 执行方式见共享对比契约。逐项将 A1 主流程、A2 负路径与恢复、A3 交付门禁映射到 evidence checks；有实际变更时保留 baseline failing regression。

必需证据：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。当前平台 native 与 IDEA 缺失不能关闭 done；代码已齐但证据缺失为 implemented。

<a id="ed-audit-011"></a>
## ED-AUDIT-011 IME 输入期间的命令与焦点隔离

### 用户目标与代码现状

输入法候选确认/取消不误触全局编辑命令，composition 结束后正常恢复快捷键和焦点。

代码事实：CodeMirrorHost.tsx 2599 附近 compositionNavigationGuard 在 capture keydown 阶段检查 composing/isComposing，其他剪贴板/导航路径亦有 guard；需要验证 action host 和真实输入法组合。

### 实施范围与状态

Owner：src/components/editor/workspace/CodeMirrorHost.tsx composition guard、workspaceActionHost.ts、workspaceKeymapScheme.ts、对应测试；不改全局 OS keymap。

使用真实 DOM composition lifecycle 与 CodeMirror composing 状态，workspace global action 不抢 IME Enter/Escape/方向键及候选快捷键。compositionend 后释放临时拦截；失焦、卸载、重挂载清除残留状态。复用 existing action registry，不把所有快捷键永久禁用。菜单显式命令是否可用按 readonly/owner policy 判定。

仅修改上述职责；出现别的功能差距单独记录。依赖：ED-AUDIT-001。每个操作都遵守共享 failure/cancel/stale/effect 契约，不用其他 owner 的成功测试代替本卡行为。

### IDEA 同场景步骤

IDEA 与 QA app 打开同一含中文注释的文件。Linux IBus/Fcitx、Windows 微软拼音、macOS 拼音分别记录实际版本；输入候选、Enter 确认、Escape 取消、方向选词，期间切 focus；完成后导航/Undo。对同一次操作记录 text、selection、focus、候选窗口与误触命令。

### 验收与验证

- **ED-AUDIT-011-A1：** 实际输入法候选阶段没有 workspace 误导航、重复插入或错误 clipboard 操作；确认/取消与 IDEA 同系统输入法行为有实测记录。
- **ED-AUDIT-011-A2：** compositionend、blur、unmount 后正常快捷键恢复；一次 undo 的边界与 IDEA 对比确定；合成 KeyboardEvent 单测只作 guard 回归，不能当 IME 证据。
- **ED-AUDIT-011-A3：** 当前平台真实输入法、键盘焦点、name/role/state 与 200% zoom 的受影响 UI 检查通过；unit/typecheck 通过；Windows/Linux/macOS 分列输入法版本和未验证项。

验证 V-011：CodeMirrorHost 的现有键盘测试与 workspaceActionHost 对应单测；拟新增 CodeMirrorHost.ime.test.tsx。复用 TC-IDE-C3-03 可覆盖部分焦点，IME 需新增专题手工记录或真正支持的 native verb；不伪造 YAML pass。 先运行对应 `pnpm exec vitest run <上述测试>`；QA/native/IDEA 执行方式见共享对比契约。逐项将 A1 主流程、A2 负路径与恢复、A3 交付门禁映射到 evidence checks；有实际变更时保留 baseline failing regression。

必需证据：`code-audit`、`unit`、`typecheck`、`native`、`accessibility`、`idea-comparison`。当前平台 native 与 IDEA 缺失不能关闭 done；代码已齐但证据缺失为 implemented。
