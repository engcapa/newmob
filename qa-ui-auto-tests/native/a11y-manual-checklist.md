# a11y manual smoke checklist — §8.19.10 (per platform, human-executed)

> 自动扫描（`a11y_scan.py`）只覆盖静态 role/name/state 合同；本清单是每端
> 一次的**人工** keyboard / screen-reader smoke，不可用自动化替代。每完成
> 一项，用 `evidence_collect.py --gate a11y --result passed|failed` 记一条。

## 1. Keyboard-only（每端 × 每种 layout）

- [ ] 不碰鼠标完成全部 G1 case 路径（打开工作区 → 编辑 → 保存 → Switcher → 分屏 → 关闭）
- [ ] Tab/Shift+Tab 焦点顺序符合视觉顺序，无焦点丢失（focus trap 逃生用 Esc）
- [ ] dialog 关闭后焦点回到触发者；取消与 Esc / 外点行为一致
- [ ] menu 打开时焦点入 menu，Esc/方向键行为正确，关闭后焦点归还
- [ ] listbox/tab/tree 全键盘可达（方向键、Home/End、Enter/Space）

## 2. Screen reader announcements（每端一次；Linux: Orca / Windows: NVDA / macOS: VoiceOver）

- [ ] completion 弹层出现/消失有 announcement，候选可读（含 source/truncation 标注）
- [ ] save conflict（hash conflict / foreign effect）阻断信息可读
- [ ] save recovery（stale snapshot 恢复入口）可读
- [ ] unavailable contract（provider/fixture 不可用置灰 + hint）可读

## 3. 视觉/偏好（每端）

- [ ] high contrast 主题无重叠/截断
- [ ] 200% zoom 无重叠/截断，焦点可见
- [ ] 窄 viewport（~800px）编辑器壳层可用
- [ ] reduced motion 下动画降级（Switcher/弹层）

## 4. 记录

| 平台 | 日期 | 执行人 | §1 | §2 | §3 | evidence entry |
|---|---|---|---|---|---|---|
| Linux | — | — | ☐ | ☐ | ☐ | — |
| Windows | — | — | ☐ | ☐ | ☐ | — |
| macOS | — | — | ☐ | ☐ | ☐ | — |
