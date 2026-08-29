# ADR 2026-08-29: Buffer Authority Migration & Incremental Synchronization Architecture (ED-PERF-004 / PERF-5)

## Status
Accepted (Design Specification & Architecture Decision Record; production implementation partitioned into phased milestones)

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

## 2. Decision & Authority Invariants

To achieve professional editor performance with large files and multi-split layouts, we establish the following core architectural invariants:

### 2.1 Principle of Live Buffer Authority
1. **CodeMirror `Text` Data Structure as the Authority**:
   - The active CodeMirror `EditorState.doc` (backed by a high-performance rope structure) is the single source of truth for text content during interactive editing.
   - Keystrokes mutate the internal rope in O(log N) time with zero full-string allocations.
2. **React/Zustand as a Decoupled Snapshot Observer**:
   - The React store no longer retains the synchronous live editing string.
   - Instead, the store receives throttled/debounced **Document Snapshots** (e.g., at 100ms-250ms intervals or on blur/save) containing:
     - `dirty: boolean`
     - `version: number` (monotonically incrementing edit transaction counter)
     - `contentHash: string` (fast 64-bit non-cryptographic hash for synchronization validation)
     - `length: number` and `lineCount: number`

### 2.2 Shared Document Multi-View Synchronization (ED-MULTIVIEW-001 Integration)
- Split editors and detached windows operate as attached views to a single underlying `SharedDocumentInstance`.
- Edit transactions from View A propagate to View B via transaction deltas (`ChangeSet`), avoiding full DOM resets or undo history corruption.

### 2.3 Incremental LSP Synchronization
- The LSP bridge listens directly to CodeMirror transactions.
- Changes are transformed into LSP `TextDocumentContentChangeEvent` range edits:
  ```json
  {
    "range": {
      "start": { "line": 42, "character": 10 },
      "end": { "line": 42, "character": 15 }
    },
    "rangeLength": 5,
    "text": "newContent"
  }
  ```
- Full document text is never stringified for standard typing transactions.

### 2.4 Asynchronous Git Diff & Semantic Scheduling
- Git line diff and semantic indexers run as background workers or scheduled requestIdleCallback tasks.
- Diffing is executed against chunked line slices rather than whole files.

---

## 3. Performance Baseline & Target Metrics

| Metric | Current Baseline (Zustand String Copy) | Target Invariant (Live Buffer Authority) |
|---|---|---|
| **1MB Keystroke Latency (P95)** | 28ms - 45ms | < 8ms |
| **5MB Keystroke Latency (P95)** | 95ms - 180ms | < 14ms |
| **Heap Allocation per Keystroke** | O(File Size) (1MB - 5MB per key) | O(Delta Size) (< 1KB per key) |
| **Multi-Split Sync Cost (1MB)** | Full string swap + full DOM reparse | O(log N) rope update (< 1ms) |
| **LSP IPC Payload per Keystroke** | 1MB - 5MB JSON string | < 200 bytes JSON range delta |

---

## 4. Phased Migration Plan

### Phase 1: Throttled Snapshot Emission & Store Decoupling
- Retain `openFiles[fileKey].text` for read-only / saving paths, but debounce store updates from `CodeMirrorHost` during continuous typing bursts.
- Immediate updates are preserved for cursor position, selection, and dirty flag.

### Phase 2: Transaction-Driven Incremental LSP Synchronization
- Upgrade language server sync adapter to support `TextDocumentSyncKind.Incremental` (2).
- Generate LSP range edits directly from CodeMirror `Transaction` changesets.
- Periodically verify document hash consistency with language server diagnostics.

### Phase 3: Headless Shared Buffer & Worker Offloading
- Decouple buffer lifetime from React component mounts: keep active buffers in a lightweight headless document manager (`WorkspaceDocumentManager`).
- Offload syntax parsing, folding range computation, and semantic indexing for files >1MB to Web Workers.

---

## 5. Rollback & Safeguards

1. **Hash Desynchronization Recovery**:
   - If an incremental LSP transaction returns an out-of-sync diagnostic or parse error, the manager triggers a full-document resync (`textDocument/didChange` with full text and refreshed version).
2. **Feature Gate**:
   - Implement under feature flag `workspace.incrementalBufferAuthority` during initial rollout to allow instantaneous zero-downtime rollback to legacy string-store behavior if edge-case regressions occur.
