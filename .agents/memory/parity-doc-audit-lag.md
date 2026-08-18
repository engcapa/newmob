---
name: Parity doc audit lag
description: claudedocs parity audit tables can describe the previous commit, not the code in the same commit
---

The `claudedocs/code-workspace-ide-design.md` §2.11 / `debug-panel-idea-redesign.md` §15.8 audit tables are written against the *previous* commit hash, while the commit that adds them may also contain code fixes for items the tables list as "未交付".

**Why:** Commit `ddc131d3` fixed the step lock, watch-index deletion, console generation guard, and recentChangedFiles alias — yet the doc tables in the same commit still list them as gaps (they audit `67215c85`).

**How to apply:** Before planning work from these gap tables, re-verify each claimed gap against the current code (`git show`/rg), and flag stale rows for re-audit instead of re-fixing already-fixed items.
