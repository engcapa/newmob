---
name: Parity doc audit lag
description: claudedocs parity audit tables can describe the previous commit, not the code in the same commit
---

Parity audit tables can describe the code state from immediately before the documentation update, while the same change set also contains implementation fixes for items still listed as incomplete.

**Why:** Treating a recorded audit baseline as the current code state can create duplicate work or incorrectly mark partial wiring as complete.

**How to apply:** Before planning from a gap table, verify every claim against current production consumers and update contradictory status rows before creating work.
