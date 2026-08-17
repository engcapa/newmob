---
name: react-resizable-panels v4 API
description: Taomni pins react-resizable-panels v4, whose API differs from the widely-documented v2/v3 — import names, layout persistence, and sizing props all changed.
---

# react-resizable-panels v4 API (as used in this repo)

The project uses `react-resizable-panels@^4` (see `package.json`). Most online examples show the v2 API and will mislead.

- Imports: `Group` (not `PanelGroup`), `Panel`, `Separator` (not `PanelResizeHandle`).
- Direction prop: `orientation="horizontal" | "vertical"` (not `direction`).
- `defaultSize` accepts a percent string (e.g. `"45%"`) or number.
- Layout persistence: no `autoSaveId`. Use `defaultLayout={layout}` + `onLayoutChanged={(layout) => ...}` on `Group`. `Layout` is `Record<panelId, number>` (flexGrow values); each `Panel` needs a stable `id`.

**Why:** v4 renamed the exports and dropped `autoSaveId`; copying v2 snippets produces type errors or silently unpersisted layouts.

**How to apply:** Reference implementation for persisted layouts: `readDebugSplitLayout`/`writeDebugSplitLayout` in `src/components/editor/workspace/panels/debug/debugPanelShared.tsx`, wired in `DebugPanel.tsx` and `debug/DebugVariablesPane.tsx`.
