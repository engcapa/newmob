# ADR 2026-08-27: JDT.LS 1.61 `textDocument/codeAction` Unsupported Policy (§8.21.4 V3)

## Status
Accepted

## Context
Under headless integration testing and real fixture execution, Eclipse JDT Language Server version 1.61.0-SNAPSHOT never answers incoming `textDocument/codeAction` requests (timing out indefinitely across healthy files and unresolved-import broken files alike).
Previous implementations attempted to hide this provider hang by:
1. Setting arbitrary UI timeouts without protocol cancellation (`$/cancelRequest`).
2. Synthesizing local mock import edits from keyword matching, which violated §8.14.2 J0 containment and §8.16.2 request identity truth.

## Decision
1. **Audit & Trace Truth**: In `jdtlsFixtureExpectations.ts` and `jdtlsTraceContract.test.ts`, the scenario `import-quick-fix` records `assert: { type: "quickfix-provider-hang-recorded" }`. Under jdt.ls 1.61, `quickFix.satisfied` is marked `false`, with explicit `reason: "provider-hang"`.
2. **Version-Level Unsupported Classification**:
   - For language server sessions running jdt.ls 1.61 where `textDocument/codeAction` fails or hangs, `CodeActionProviderResultV4` returns:
     `{ state: "unsupported", reason: "Language server version (jdtls 1.61) does not support codeAction under current configuration", evidence }`
     or `{ state: "timeout", requestId, cancelled: true, providerStillHealthy, retryAfter: "manual" | "restart" }`.
   - The UI surfaces this status cleanly as disabled/unsupported with an actionable diagnostic message, prohibiting fake claims of quick-fix availability.
3. **Cancellation Enforcement**:
   - Whenever an intention request times out in Taomni, `$/cancelRequest` is dispatched to the provider with the tracked `requestId`.
   - The frozen intention session marks the candidate as stale/failed but keeps it visible so user context is not erased.
   - Retry initiates a fresh request with a newly minted `requestId`.
4. **Precondition Re-verification**:
   - Prior to applying any resolved CodeAction WorkspaceEdit, Taomni re-verifies:
     - Document revision (`documentRevision`)
     - Provider session generation (`providerGeneration`)
     - Project structure fingerprint (`projectFingerprint`)
   - Any mismatch blocks application with `status: "stale-precondition"`.
5. **Atomic Edit & Undo (R0)**:
   - When a supported provider answers CodeActions, WorkspaceEdits are applied atomically via `workspaceEditApply` in a single document revision / single undo transaction.

## Consequences
- No synthetic or keyword-guessed Java quick fixes can be generated in production paths.
- Quick Fix capability remains honest (L0-L1 for jdt.ls 1.61, upgradeable to L2 only when a compatible provider responds with verifiable effects).
- All 4 intention entry points (Alt+Enter, Gutter Bulb, Problems Panel, Search Actions) share identical session lifecycles and precondition gates.
