# QA And Release Evidence Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). QA mappings and validators are infrastructure; only runner-produced observations can support a release or L2/L3 parity claim.

## Evidence Architecture

The `daily-editor-linux` scope maps capabilities to behavior cases and required layers. A read-only observation adapter may expose revision, request/cancel/write/lease/history counters and hashes from real production owners; it cannot inject state or execute actions. Runners produce signed receipts over the exact source, test plan, bundle, command, output, and artifacts. Rollup validates receipts; it never manufactures them.

Linux is the first target. Windows and macOS are independent rows and cannot inherit Linux PASS. Browser, native, provider, performance, accessibility, and IDEA comparison are independent evidence layers.

<a id="ed-qa-001"></a>
## ED-QA-001 Daily-Editor Linux Scope And Observation Adapter

- **User outcome:** every release-scope capability has a case/evidence contract tied to read-only facts from its production owner.
- **Audit:** `ready`. `daily-editor-linux.scope.json` exists, but `workspaceObservationBridge.ts` is test-only and records manually supplied values rather than observing production save/query/lease/history owners.
- **Contract:** observation is dev/test-only, read-only, redacted, and source-labelled; production mode exposes no sensitive data; every counter/hash comes from an actual effect boundary.
- **Acceptance:** `ED-QA-001-A1` scope schema maps each capability to required cases/layers; `A2` production owners feed the adapter; `A3` observations cannot invoke or mutate actions and contain no source text; `A4` stale/missing observation fails closed.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `browser`, `build`.

<a id="ed-qa-002"></a>
## ED-QA-002 Behavior Case Mapping Quality

- **User outcome:** scoped cases assert the promised behavior/effect and do not pass merely because a control exists or screenshot was taken.
- **Audit:** `implemented`. Scope mapping/schema tests pass, but audited cases include shallow C3/C4/C6 steps; current QA gate also reports shallow-control regression and zero release evidence.
- **Contract:** every case declares mode/fixture/claim ceiling and asserts entry, effect/result, failure or unavailable, and undo/recovery where relevant; controls have one owning feature/case.
- **Acceptance:** `ED-QA-002-A1` every scoped capability maps to non-shallow assertions; `A2` catalog/lint/orphan/diff audit passes; `A3` browser/native/provider boundaries are explicit; `A4` screenshots are supplemental only.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `browser`.

<a id="ed-qa-003"></a>
## ED-QA-003 Linux Packaged/Provider/Performance/A11y/IDEA Matrix

- **User outcome:** maintainers can make a bounded Linux parity statement backed by actual packaged observations and see independent blocked/failing platform rows.
- **Audit:** `ready`. `capabilityMatrixAudit.test.ts` hard-codes a synthetic Linux PASS, five fake timing samples, all accessibility booleans, and `exact-match`; it consumes no runner evidence. Current repository release evidence count is zero.
- **Contract:** validator tests use fixtures labelled synthetic; real matrix input comes only from verified runner receipts/artifacts. Missing required layer is INCOMPLETE/BLOCKED, never PASS.
- **Acceptance:** `ED-QA-003-A1` packaged Linux receipts cover every required capability/layer; `A2` provider/perf/a11y/IDEA artifacts are independently verified; `A3` Windows/macOS remain independent; `A4` rollup emits the exact bounded claim and all gaps.
- **Required evidence:** `native`, `provider`, `performance`, `accessibility`, `idea-comparison`, `document`.

<a id="ed-rel-001"></a>
## ED-REL-001 Runner-Owned Receipt And Signature Boundary

- **User outcome:** evidence can be traced to the runner that executed the command and cannot be rewritten into a pass by application code.
- **Audit:** `implemented`. Receipt/signature types and validator tests exist, but no actual browser/native runner owns and emits the receipt.
- **Contract:** signed payload covers runner/key/purpose, command digest, source/test/bundle identity, time/exit/output digests, and artifact hashes; key purpose/validity/revocation is checked.
- **Acceptance:** `ED-REL-001-A1` real runner emits after execution; `A2` mutation/wrong purpose/expired/revoked key fails; `A3` application/test code cannot self-attest a release run.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `browser`.

<a id="ed-rel-002"></a>
## ED-REL-002 Source, Test-Plan, And Bundle Identity

- **User outcome:** a receipt proves exactly which tracked source, test plan, and built bundle it exercised.
- **Audit:** `ready`. Identity builders/validators feed the rollup library but no runner consumes them end-to-end, and the current identity tests fail the TypeScript unused-symbol build gate.
- **Contract:** canonical path ordering/content digest; dirty/untracked product inputs explicit; bundle identity derives from actual packaged artifacts; mismatches fail closed.
- **Acceptance:** `ED-REL-002-A1` identical inputs are byte-identical; `A2` source/test/artifact mutation changes identity; `A3` real runner and package pipeline bind all three identities.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `native`.

<a id="ed-rel-003"></a>
## ED-REL-003 Release Plan, Channel, And Artifact Roots

- **User outcome:** a release channel can consume only allowlisted capabilities, evidence layers, and artifact roots.
- **Audit:** `ready`. Plan validation and rollup integration exist without a production/CLI consumer, and `releasePlanValidator.ts` currently fails the TypeScript unused-type build gate.
- **Contract:** schema/version/channel/platform/capability/layer/root are allowlisted; path traversal/symlink/out-of-root artifacts fail; missing layer is incomplete.
- **Acceptance:** `ED-REL-003-A1` valid plan resolves deterministic requirements; `A2` unknown/path-escape/cross-channel input fails; `A3` runner/rollup CLI uses the validated plan without alternate roots.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `native`.

<a id="ed-rel-004"></a>
## ED-REL-004 Rollup And Real Smoke Transaction

- **User outcome:** one real runner transaction produces a receipt and deterministic rollup that can be independently checked.
- **Audit:** `ready`. `releaseRollup.test.ts` constructs and signs a fake receipt in-process; there is no real runner transaction or CLI consumer.
- **Contract:** rollup only verifies collected receipts; it cannot call `createRunnerExecutionReceipt` for the execution it is judging. Zero receipt is INCOMPLETE; nonzero exit is FAIL.
- **Acceptance:** `ED-REL-004-A1` runner executes a smoke case and writes signed receipt/artifact; `A2` rollup consumes it and is byte-identical; `A3` independent check verifies identity/signature/artifacts; `A4` tamper/zero/failure paths remain red.
- **Required evidence:** `code-audit`, `unit`, `qa-lint`, `browser`, `document`.
- **References:** historical `BB2`, `BB10`, `BB11`.
