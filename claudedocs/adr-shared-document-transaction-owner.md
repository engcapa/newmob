# ADR 2026-08-29: Shared Document Transaction Owner & Multi-Split Architecture (§8.26 / ED-MULTIVIEW-001)

## Status
Accepted (Design Phase for ED-MULTIVIEW-001; Implementation in ED-MULTIVIEW-002 & ED-MULTIVIEW-003)

---

## 1. Context & Problem Statement

In IntelliJ IDEA and modern professional IDEs, opening the same file across multiple editor splits (Split Vertically / Split Horizontally), detached floating windows, or secondary preview panes must operate on a single shared `Document` instance:
- **Typing in Split A** instantly mutates Split B without rebuilding Split B's DOM or resetting Split B's cursor/scroll offset.
- **Undo / Redo** affects the shared document history consistently rather than each split maintaining divergent, conflicting document versions.
- **Dirty status & LSP sync** are owned by the document authority, firing exactly one `textDocument/didChange` event and incrementing `documentRevision` once per edit transaction.
- **Per-view states** (selection, active caret position, scroll viewport, fold ranges, and inline search highlights) remain strictly isolated per `EditorView` / `EditorGroupId`.

### Current Taomni Baseline Reproduction
Currently in Taomni:
1. Each editor group mounts a separate `CodeMirrorHost` component.
2. Document state is stored globally in `openFiles[fileKey]` (`OpenFileState`).
3. When Split A edits text, `onChange` calls `updateOpenDoc(file.key, newText)`.
4. Split B receives `value={file.text}` via React props. When `value` differs from Split B's internal `view.state.doc.toString()`, `CodeMirrorHost` performs a full-text update (`view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })`).
5. Consequences:
   - Full-text replacement in Split B clears or corrupts Split B's local undo history.
   - Typing causes O(N) full document string conversions instead of incremental diffs.
   - Sibling views cannot coordinate complex multi-edit transactions atomically.

---

## 2. Decision & Architecture Invariants

### 2.1 Single Document Authority
The workspace file state (`OpenFileState`) remains the sole authority for document lifecycle:
- **Attributes**: `key`, `ref`, `path`, `text`, `savedText`, `eol`, `documentRevision`, `dirty`, `encoding`, `hash`.
- **Resource Lease**: An open file is kept alive as long as at least one Editor Group holds a reference. Closing a tab in Split A does not release or discard the document if Split B still has it open.

### 2.2 Shared Document Transaction Owner (`WorkspaceDocumentTransactionOwner`)
Introduce a centralized Transaction Owner to mediate edits across multiple `EditorView`s:
```ts
export interface DocumentChangeTransaction {
  fileKey: string;
  sourceViewId: string; // EditorGroupId or DetachedWindowId
  revision: number;
  changes: readonly { from: number; to: number; insert: string }[];
  origin?: "user-input" | "format" | "completion" | "refactor" | "undo" | "redo" | "external-disk";
  timestamp: number;
}
```
- **Transaction Origin**: When Split A dispatches a change, it tags the transaction with `sourceViewId: "primary"`.
- **Delta Broadcast**: The Transaction Owner notifies all other mounted `EditorView`s for `fileKey` (e.g. `secondary`) with the incremental change delta.
- **Echo Prevention**: Split B applies the incremental change via `view.dispatch({ changes, annotations: [Transaction.remote.of(true)] })`. Because Split B's change is annotated as remote, Split B does not re-emit an `onChange` back to the store, preventing infinite update cycles.

### 2.3 Undo / Redo Authority
1. **Shared Document History**:
   - The authoritative undo stack is maintained at the document level.
   - Triggering Undo (Ctrl+Z) in any active split dispatches the inverted changes to the shared document.
   - Remote views apply the inverted changes smoothly, adjusting their carets if their cursor was inside the affected range.
2. **Selection Preservation**:
   - Remote changes use CodeMirror's `ChangeSet.mapPos` to shift selection ranges and cursors without resetting them to `(0, 0)`.

### 2.4 Language Server (LSP) Authority
- **Single didChange per Transaction**: The Transaction Owner notifies the LSP client once per transaction. Sibling views do NOT fire additional LSP sync requests.
- **Generation & Revision Coupling**: `documentRevision` increments by 1 per transaction. Semantic queries, quick fixes, and completions validate against this single authoritative revision.
- **Shared Diagnostics**: Diagnostic markers and squigglies are received once from the language server and displayed across all views for that file.

### 2.5 Per-View State Isolation
The following properties are strictly isolated and tracked per `EditorGroupId`:
- Primary and secondary selection ranges (`selection.ranges`).
- Cursor line and column coordinates (`cursorPositions[groupId]`).
- Viewport scroll position (`scrollDOM.scrollTop`, `scrollDOM.scrollLeft`, `viewportRanges[groupId]`).
- Code folding state (`foldState` per view).
- In-view Find/Replace active search match (`findPanelState[groupId]`).

---

## 3. Migration Roadmap

### Phase 1: Design & ADR (ED-MULTIVIEW-001) — *Current Task*
- Establish invariants, transaction schemas, and multi-split contracts in this ADR.
- Zero breaking changes to production editor code in this phase.

### Phase 2: Transaction Owner & Incremental Dispatch (ED-MULTIVIEW-002)
1. Implement `WorkspaceDocumentTransactionOwner` in `src/components/editor/workspace/workspaceDocumentTransactionOwner.ts`.
2. Update `CodeMirrorHost.tsx` to subscribe to sibling transactions and apply incremental `ChangeSet`s with `Transaction.remote.of(true)` annotations.
3. Replace `openFiles[key].text` full-prop resets with transaction delta synchronization.
4. Verify dual/triple split typing, undo/redo across splits, multi-edit snippet completion, and tab close/reopen.

### Phase 3: Shared Decorations & View Leases (ED-MULTIVIEW-003)
1. Synchronize diagnostics, breakpoints, and bookmarks across all split views.
2. Maintain per-view cursor, scroll offset, and fold state.
3. Implement document lease counter: closing a tab in Split A decrements lease count; document is only evicted when lease reaches 0.

---

## 4. Test & Rollback Plan

### Test Scenarios
1. **Dual Split Typing**:
   - Open `Main.java` in Split 1 and Split 2.
   - Type in Split 1 -> Split 2 updates incrementally at exact line/character; Split 2 caret remains unchanged.
2. **Cross-Split Undo/Redo**:
   - Type in Split 1; switch focus to Split 2; press Undo -> Text reverts; both splits reflect the undone state.
3. **Multi-Edit Completion**:
   - Accept completion with `additionalTextEdits` (e.g. auto-import) in Split 1 -> Split 2 reflects both import and call site atomically.
4. **View Close & Reopen**:
   - Close Split 2 -> Split 1 continues editing without document reset. Re-splitting preserves current dirty text and revision.
5. **External Disk Modification**:
   - File changed on disk -> Single prompt/reload transaction updates all open splits simultaneously.

### Rollback Strategy
- The Transaction Owner integrates via a feature-guarded dispatch hook. If regressions occur during incremental sync, `CodeMirrorHost` can fall back to direct prop synchronization without schema migration.
