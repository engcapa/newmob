# ADR 2026-08-29: Buffer Authority Migration & Incremental Synchronization Architecture (ED-PERF-004 / PERF-5)

## Status
Accepted (Design Specification & Architecture Decision Record; baseline captured 2026-09-03; production implementation partitioned into phased milestones).

---

## 1. Context & Motivation

In professional development environments such as IntelliJ IDEA and VS Code, text buffers ranging from small source files (<50KB) to large generated files, bundle artifacts, or data tables (1MB - 5MB+) must maintain sub-16ms keystroke responsiveness without UI stuttering, heap thrashing, or unnecessary thread stalls.

### 1.1 Current Taomni Baseline & Limitations

In the current Taomni architecture:
1. **React/Zustand Store as Live Text Container**:
   - `openFiles[fileKey].text` holds the complete document as a JavaScript string in Zustand state.
   - Every keystroke dispatches `updateOpenDoc(fileKey, newText)`, generating a new string object and mutating the store state.
2. **Prop Drilling & Re-render Cascades**:
   - Store updates trigger React selector subscriptions across breadcrumbs, status bars, minimaps, split views, and file trees.
   - For 1MB files (~25,000 lines) and 5MB files (~120,000 lines), allocating full string copies on every character input causes severe GC pressure (up to 200MB/minute during rapid typing) and long frames (>50ms).
3. **Full-Document Synchronization**:
   - LSP synchronizations (`textDocument/didChange`) send full text payloads (`TextDocumentSyncKind.Full`), transferring megabytes over IPC.
   - Git line diff computations recalculate against complete strings.

---

## 2. Decision & Invariants at Every Phase

To achieve professional editor performance with large files and multi-split layouts, we establish the following core architectural invariants:

### 2.1 Principle of Live Buffer Authority
1. **CodeMirror `Text` Rope as the Single Authority**:
   - The active CodeMirror `EditorState.doc` (backed by a tree/rope structure) is the single source of truth for text content during interactive editing.
   - Keystrokes mutate the internal rope in $O(\log N)$ time with zero full-string allocations.
2. **React/Zustand as a Decoupled Snapshot Observer**:
   - The React store no longer retains the synchronous live editing string.
   - Instead, the store receives throttled/debounced **Document Snapshots** (e.g., at 100ms-250ms intervals or on blur/save) containing:
     - `dirty: boolean`
     - `version: number` (monotonically incrementing edit transaction counter)
     - `contentHash: string` (fast 64-bit non-cryptographic hash for synchronization validation)
     - `length: number` and `lineCount: number`

### 2.2 System Invariants Matrix

| Invariant Category | Invariant Rule | Validation / Enforcement Mechanism |
|---|---|---|
| **Shared-Document** | Split editors and multi-window views share a single underlying `SharedDocumentInstance`. | Edit transactions from View A propagate to View B via transaction deltas (`ChangeSet`) without full document reload or cursor position resets. |
| **Save** | Save serializes the live buffer text, performs atomic disk flush, and verifies SHA-256 / byte length. | The `dirty` bit is cleared **only** after disk confirmation receipt (`assert_file_receipt`); failure retains buffer state without data loss. |
| **LSP** | Incremental `textDocument/didChange` range edits strictly correspond to CodeMirror `Transaction` changesets. | Monotonically increasing version numbers; content hash verification on diagnostic response; hash mismatch triggers automatic full-sync fallback. |
| **Git Diff** | Line diff calculations are debounced and executed asynchronously. | Diff workers receive incremental line slice changes or worker messages; in-flight diff tasks are cancelled when superseded by newer versions. |
| **Undo / Redo** | Undo and redo stacks reside directly within the live buffer authority (`EditorState`). | Snapshot updates to Zustand do not fragment, clear, or reset the CodeMirror undo history. |
| **Crash Recovery** | Emergency snapshot persisting text and version to SQLite/localStorage. | Unsaved buffer content is captured periodically (e.g. 30s) or on `beforeunload` to prevent work loss. |
| **Snapshot** | Zustand store receives only metadata snapshots during typing. | Components requiring full text (e.g. file save or export) query the buffer authority directly on-demand. |

---

## 3. Measured Performance Baselines vs Target Values

### 3.1 Reproducible Runner Command & Raw Artifacts

- **Runner Command:**
  ```bash
  node --experimental-strip-types scripts/buffer_authority_benchmark.ts
  ```
- **Raw Sample Artifacts:**
  `qa-ui-auto-report/evidence/perf-buffer-authority-baseline-20260903.json`
- **Methodology:** N=200 sequential keystroke transactions inserting into random and sequential buffer positions, capturing individual frame/execution times, memory allocations, and IPC payloads.

### 3.2 Comparison Matrix

| Metric | [MEASURED BASELINE]<br>Zustand String Copy (2026-09-03) | [MEASURED PROTOTYPE]<br>CodeMirror Rope (2026-09-03) | [TARGET INVARIANT / ESTIMATE]<br>Production Goal | Status |
|---|---|---|---|---|
| **1MB Keystroke P50 Latency** | **0.639 ms** | **0.020 ms** | < 1.0 ms | Met |
| **1MB Keystroke P95 Latency** | **1.764 ms** | **0.060 ms** | < 8.0 ms | Met (29.4x speedup) |
| **1MB Keystroke P99 Latency** | **3.126 ms** | **0.087 ms** | < 12.0 ms | Met |
| **1MB Max Keystroke Latency** | **4.449 ms** | **0.092 ms** | < 16.0 ms | Met |
| **1MB Heap Alloc per Keystroke** | **1,048,915 bytes (~1.05 MB)** | **~850 bytes** | < 1,024 bytes | Met (1234x reduction) |
| **1MB LSP IPC Payload / Keystroke** | **1,055,836 bytes (~1.06 MB)** | **243 bytes** | < 500 bytes | Met (4345x reduction) |
| **5MB Keystroke P50 Latency** | **3.245 ms** | **0.007 ms** | < 2.0 ms | Met |
| **5MB Keystroke P95 Latency** | **6.658 ms** | **0.015 ms** | < 14.0 ms | Met (443.8x speedup) |
| **5MB Keystroke P99 Latency** | **8.214 ms** | **0.026 ms** | < 20.0 ms | Met |
| **5MB Max Keystroke Latency** | **12.229 ms** | **0.046 ms** | < 25.0 ms | Met |
| **5MB Heap Alloc per Keystroke** | **5,243,180 bytes (~5.24 MB)** | **~850 bytes** | < 1,024 bytes | Met (6168x reduction) |
| **5MB LSP IPC Payload / Keystroke** | **5,277,008 bytes (~5.28 MB)** | **243 bytes** | < 500 bytes | Met (21716x reduction) |

*Note: In the browser renderer thread with full DOM tree layout and React re-render cascades, baseline keystroke-to-paint reaches P95 134.5ms (as measured in `perf-baseline-browser-20260825-153258.json`). The buffer authority migration directly eliminates the string copy and component re-render root causes.*

---

## 4. Phased Migration Plan & Gates

### Phase 1: Throttled Snapshot Emission & Store Decoupling
- **Scope:** Retain `openFiles[fileKey].text` for read-only / saving paths, but debounce store updates from `CodeMirrorHost` during continuous typing bursts (150ms trailing debounce).
- **Correctness Gate:** File saving produces identical byte hashes; cursor position, selection, and `dirty` indicators remain instantaneous.
- **Performance Gate:** Keystroke-to-paint P95 on 1MB files drops from >100ms to <40ms; zero Maximum update depth exceeded errors.
- **Rollback Trigger:** Any regression in file save content hash or lost uncommitted text during tab switching rolls back immediately.

### Phase 2: Transaction-Driven Incremental LSP Synchronization
- **Scope:** Upgrade language server bridge to support `TextDocumentSyncKind.Incremental` (2). Transform CodeMirror `Transaction` changesets directly into LSP range edits.
- **Correctness Gate:** Language server diagnostics on modified files produce identical error/warning sets as full-document sync; automated document hash verification returns 0 mismatches.
- **Performance Gate:** LSP IPC transmission payload per keystroke drops to <1KB (measured: 243 bytes).
- **Rollback Trigger:** Diagnostic drift, out-of-order range edit application, or server parse failures automatically trigger an immediate full-document resynchronization and revert sync mode to Full.

### Phase 3: Headless Shared Buffer & Worker Offloading
- **Scope:** Decouple buffer lifetime from React component tree via `WorkspaceDocumentManager`. Offload syntax highlighting, folding range computation, and semantic indexing for files >1MB to Web Workers.
- **Correctness Gate:** Multi-split views and detached tabs stay synchronized on every keystroke with zero cursor desync.
- **Performance Gate:** Frame rate maintains steady 60 FPS during continuous typing in 5MB files with 3 active split views.
- **Rollback Trigger:** Multi-split change collision or worker thread serialization failures trigger fallback to single-view direct rendering.

---

## 5. Rollback Mechanisms & Feature Flag

### 5.1 Global Feature Gate
The migration is protected by the configuration feature gate:
```ts
workspace.incrementalBufferAuthority: boolean
```
- **Default:** `false` (legacy string-store behavior preserved during dark-launch).
- **Runtime Toggle:** Can be toggled per workspace or globally without app restart.

### 5.2 Dynamic Fallback
If an unhandled exception or desynchronization is detected in the live buffer pipeline:
1. An emergency snapshot is taken from `EditorState.doc.toString()`.
2. The document store writes the snapshot to `openFiles[fileKey].text`.
3. The editor gracefully falls back to legacy Zustand string-store mode for that file key.
4. An error event is logged without terminating user editing.
