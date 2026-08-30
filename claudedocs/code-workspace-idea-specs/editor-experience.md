# Editor Experience Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). These tasks cover quiet, editor-native surfaces rather than semantic engine claims. Every surface preserves editing focus and reports unsupported provider states honestly.

<a id="ed-chrome-002"></a>
## ED-CHROME-002 Actionable Editor Banner Framework

- **User outcome:** persistent file/workspace conditions appear above the editor with relevant actions and lifecycle, not as transient toast text.
- **Audit:** `implemented`. Banner model/component/group integration exists with UI tests; browser focus, overlap, and action-failure behavior remain unproven.
- **Contract:** typed kinds include read-only, encoding mismatch, SDK/import, indexing/degraded; priority is deterministic; dismissal keys by condition generation; action failure remains visible.
- **Acceptance:** `ED-CHROME-002-A1` priority/lifecycle survive file switches correctly; `A2` actions route to one owner and failure is visible; `A3` keyboard/focus/zoom layout has no editor overlap.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-chrome-001"></a>
## ED-CHROME-001 Per-File Highlighting Widget

- **User outcome:** users see current errors/warnings, navigate them, and choose None/Syntax/All Problems for the active file.
- **Audit:** `implemented`. Widget/model are production-wired with component tests; provider-scope truth, persistence, and keyboard/accessibility lack behavior evidence.
- **Contract:** counts bind diagnostic revision/file/provider scope; level does not claim an inspection engine; no-provider is explicit.
- **Acceptance:** `ED-CHROME-001-A1` counts/navigation track revision; `A2` level persists and updates without losing focus; `A3` provider/no-provider labels and accessibility pass browser checks.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-doc-001"></a>
## ED-DOC-001 Rendered Documentation / Reader Mode

- **User outcome:** supported doc comments toggle between source and safe rendered content without replacing Quick Documentation.
- **Audit:** `implemented`. Rendering extension/model are consumed by the production editor and focused tests pass; the repository build gate is red.
- **Contract:** allowlisted markup/links/images; no script/event/raw HTML execution; edit inside a rendered block reveals source; unsupported language is unavailable.
- **Acceptance:** `ED-DOC-001-A1` render/source toggle preserves text/selection; `A2` malicious/broken links/images are safe and visible; `A3` large/unsupported documents degrade predictably.
- **Required evidence:** `code-audit`, `unit`, `build`.

<a id="ed-bookmark-001"></a>
## ED-BOOKMARK-001 Mnemonic Bookmarks And Groups

- **User outcome:** users assign numeric/letter mnemonics, replace conflicts, group bookmarks, and jump by keyboard.
- **Audit:** `implemented`. Bookmark model/panel/actions are production-wired with focused tests; keyboard-only, restore, rename/delete behavior is not proven in a mounted workflow.
- **Contract:** mnemonic conflict replacement is explicit; bookmark identity follows file lifecycle or becomes a visible missing target; TODO and bookmark stores remain separate.
- **Acceptance:** `ED-BOOKMARK-001-A1` set/replace/remove/group persist; `A2` mnemonic jump reveals and records history; `A3` rename/delete/restore and keyboard-only focus behave predictably.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-compare-001"></a>
## ED-COMPARE-001 General Editor Compare Workflow

- **User outcome:** Compare with Clipboard/Files/Local History uses one diff surface with safe copy/apply actions.
- **Audit:** `implemented`. Dialog/model/actions are production-wired with component tests; real file/clipboard/local-history effects and accessibility are not behavior-tested.
- **Contract:** preserve encoding/EOL metadata; binary/oversized inputs are typed unavailable; apply uses a transaction and cannot silently overwrite dirty text.
- **Acceptance:** `ED-COMPARE-001-A1` three sources produce correct sides/labels/diff; `A2` selection/encoding/EOL and unavailable states are correct; `A3` copy/apply/undo plus keyboard accessibility pass browser/native checks.
- **Required evidence:** `code-audit`, `unit`, `browser`, `accessibility`, `build`.

<a id="ed-style-001"></a>
## ED-STYLE-001 Reformat Scope, Markers, And Exclusions

- **User outcome:** reformat can target selection/file/directory/module, respect formatter markers/exclusions, preview multi-file scope, and undo once.
- **Audit:** `ready`. New `buildFormatPlan` and `filterFormattingRanges` functions are test-only; production `CodeWorkspaceTab` still uses the older `planReformat` path and does not consume module facts or the multi-file plan.
- **Contract:** selection/range capability is distinct from document formatting; module requires ready facts; excluded/read-only/marker regions never receive edits; preview preimages are rechecked.
- **Acceptance:** `ED-STYLE-001-A1` production actions build exact scope/eligible/excluded plan; `A2` nested markers and exclusions protect ranges; `A3` provider unavailable/stale/conflict has zero commit; `A4` multi-file commit/undo is atomic.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `build`.

<a id="ed-style-002"></a>
## ED-STYLE-002 Rearrange And Cleanup Workflows

- **User outcome:** Rearrange and Cleanup appear only with a real provider capability and execute their own previewed plans.
- **Audit:** `ready`. Production actions call the new planners with `rearrangeSupported: false` and `cleanupSupported: false`, so they only display unavailable; no provider capability or execution path exists.
- **Contract:** never relabel format/organize-imports as rearrange/cleanup; capability names provider/version; plan/preview/conflict/postcondition/undo follow shared transaction rules.
- **Acceptance:** `ED-STYLE-002-A1` supported provider exposes and executes each distinct workflow; `A2` unsupported remains explanatory unavailable; `A3` preview/cancel/conflict/stale is correct; `A4` postcondition and one undo are verified.
- **Required evidence:** `code-audit`, `unit`, `browser`, `provider`, `build`.
- **References:** historical `N10.1-N10.3`, `N11.3-N11.4`, `C8-D`.
