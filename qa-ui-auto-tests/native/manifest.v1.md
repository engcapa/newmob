# Native Gate Manifest — §8.20.8 W7 Release Rollup

> Canonical release manifest and rollup for Taomni Code Workspace IDEA parity (§8.20).
> Schema: `qa-ui-auto-tests/evidence-manifest.schema.json`.
> Raw test runs and artifacts reside under `qa-ui-auto-report/evidence/`.

## 1. Release Identification

| Attribute | Value |
|---|---|
| Target Milestone | §8.20 IDE Parity Release (W0 through W7) |
| Architecture / OS | x86_64 Linux (Ubuntu / WebKitGTK 2.48+), Windows 11 (WebView2), macOS (WKWebView) |
| Schema Version | `EditorEvidenceManifestV1` |
| Evidence Layers Evaluated | `unit`, `mounted`, `browser`, `native`, `provider`, `idea-compare` |

---

## 2. G0 Save & Disk Matrix

| Item | Linux (Native / Unit) | Windows | macOS | Status & Evidence |
|---|---|---|---|---|
| locked / permission / hash conflict | **Passed** (Rust unit + IPC error) | platform-unverified | platform-unverified | `workspace.rs`, `workspaceStyleController.ts`, `saveCommit.ts` |
| atomic replace fault points | **Passed** (Rust fault harness) | platform-unverified | platform-unverified | Safe temp-file rename, hash verification |
| external watcher | **Passed** | platform-unverified | platform-unverified | File change detection & dirty buffer sync |
| encoding / EOL / BOM | **Passed** (100% byte-exact) | platform-unverified | platform-unverified | `writeDiskByteCorrectness.test.ts`, Latin-1 guard, CRLF/LF/CR |
| save close/unmount | **Passed** (Transaction abort) | platform-unverified | platform-unverified | Buffer close discards pending writes cleanly |
| WorkspaceEdit partial/resume/undo | **Passed** (Single undo) | platform-unverified | platform-unverified | `workspaceEditApply.test.ts`, boundary stops on first failure |
| symlink / case / path normalization | **Passed** | platform-unverified | platform-unverified | Normalized canonical paths |

---

## 3. G1 Capability Packages Rollup (W0 – W6)

| Package | Owner Areas | Verification Layers | Claim Level |
|---|---|---|---|
| **W0: Shell Stability & Shortcuts** | `useWorkspaceTreeData.ts`, `MainLayout.tsx`, `workspaceActionHost.ts` | `unit`, `mounted`, `browser`, `native` | **L2 (Linux)** |
| **W1: Reference Information V3** | `referenceInfoSession.ts`, `QuickDocPopup.tsx`, `CodeMirrorHost.tsx` | `unit`, `mounted` | **L2** |
| **W2: Project Analysis & Lifecycle** | `workspaceJavaProjectAnalysis.ts`, `WorkspaceProjectAnalysisPanel.tsx` | `unit`, `mounted` | **L2** |
| **W3: Inspection & Intention Contract** | `workspaceInspectionProfile.ts`, `WorkspaceInspectionSettingsDialog.tsx` | `unit`, `mounted` | **L2** |
| **W4: Navigation, Usages & Hierarchy** | `workspaceUsagesSession.ts`, `workspaceHierarchySession.ts`, `UsagesToolWindow.tsx` | `unit`, `mounted` | **L2** |
| **W5: Refactor Evidence & Conflict Gate** | `workspaceRefactorSession.ts`, `WorkspaceRefactorPreviewModal.tsx` | `unit`, `mounted` | **L2** |
| **W6-A: Clipboard History Settings** | `WorkspaceClipboardSettingsDialog.tsx`, `CodeWorkspaceTab.tsx` | `unit`, `mounted` | **L2** |
| **W6-B: Tab Policy V3 & Consumers** | `WorkspaceTabPolicySettingsDialog.tsx`, `EditorGroup.tsx`, `codeWorkspaceStore.ts` | `unit`, `mounted` | **L2** |
| **W6-C: Virtual Space & Region Folding**| `workspaceVirtualSpace.ts`, `workspaceEditorCommands.ts` | `unit`, `mounted` | **L2** |
| **W6-D: Code Style Save Actions** | `workspaceCodeStyleScheme.ts`, `saveNormalizationPipeline.ts`, `CodeStyleSettingsDialog.tsx` | `unit`, `mounted` | **L2** |
| **W6-E: Completion Preferences** | `intelligencePreferences.ts`, `workspaceLspSessionManager.ts`, `lspCompletion.ts` | `unit`, `mounted` | **L2** |

---

## 4. Performance Budget & Telemetry Baselines

| Metric | Target p95 | Baseline (Browser) | Native Linux Baseline | Native Windows / macOS |
|---|---|---|---|---|
| Normal key-to-paint | <= 50 ms | 20.5 ms p50 / 134 ms p95 (Finding logged) | platform-unverified | platform-unverified |
| Local action / Switcher chord | <= 100 ms | 14 ms p95 (Meets target) | platform-unverified | platform-unverified |
| Completion debounce & IPC | Record & gate | 120 ms debounce / 25 ms IPC | platform-unverified | platform-unverified |
| 1 MiB file CPU / Heap | Record | Heap delta <= 12 MB | platform-unverified | platform-unverified |
| 10k candidates cap | <= 200 items | 200 items capped (`MAX_COMPLETION_OPTIONS`) | platform-unverified | platform-unverified |
| 3+ split recursive layout | No layout leaks | 0 leaks observed | platform-unverified | platform-unverified |

---

## 5. Provider Evidence & IDEA 2026.2 Comparison

| Workflow Area | IDEA Expected Behavior | Taomni Observed Behavior | Alignment Level |
|---|---|---|---|
| **Basic Completion** | Member list sorted by relevance, capped, lazy resolve for imports, single undo | Relevance sorting, 200 item cap, atomic single undo (primary + import), real-time controller sync | **L3 (IDEA parity)** |
| **Parameter Info** | Auto popup on trigger chars, highlight active param, overload list | Parameter popup anchored to caret, active param highlighted, overload switching | **L2** |
| **Quick Documentation** | Hover popup or tool-window with doc render | Hover popup and dedicated Documentation Pane supported | **L2** |
| **Usages / Hierarchy** | Scope filtering, grouped tree by file/class, preview pin | Dedicated tool window, scope filtering, group by file, preview on selection | **L2** |
| **Refactoring (Rename/Safe Delete)** | Conflict detection (shadowing/usages), preview modal, single undo | Pre-flight conflict inspection, interactive preview modal with exclude/include, atomic undo | **L2** |

---

## 6. Accessibility (a11y) & Visual Stability

| Checkpoint | Automated Scan | Manual Verification |
|---|---|---|
| Dialogs / Modals ARIA roles | **0 violations** (`role="dialog"`, `aria-labelledby`, `aria-modal`) | Focus trap and Esc cancellation verified |
| Menus & Listboxes | **0 violations** (`role="menu"`, `role="listbox"`, `role="option"`) | Keyboard navigation (Up/Down/Enter/Esc) verified |
| Tab Strips | **0 violations** (`role="tablist"`, `role="tab"`, `aria-selected`) | Tab selection state exposed correctly |
| High contrast & 200% scale | Tested via CSS variables and responsive layout | Text and icons scale without clipping |

---

## 7. Release Gate Sign-off & Maximum Claim Rules

1. **Platform Restriction**: All verified capability claims are strictly scoped to **Validated on Linux x86_64**. Windows and macOS remain `platform-unverified` (or `manual-native`) until packaged runs on physical targets are performed.
2. **Claim Level Statement**:
   - G0 (Save & Byte-correct disk write): **L2 verified on Linux**.
   - G1 (IDE core workflows W0 through W6): **L2 verified on Linux**.
   - Advanced capabilities (W8): **L0 (Closed queue)**, requiring independent ADR before re-opening.
3. **Prohibition Statement**: It is strictly forbidden to claim "full cross-platform parity" or "IDEA 100% replacement" until native runs on Windows and macOS are executed and logged into `qa-ui-auto-report/evidence/`.
