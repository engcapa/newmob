# Correctness Gates Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). These tasks protect the repository baseline; they do not prove an editor capability or release.

<a id="ed-gate-003"></a>
## ED-GATE-003 Repository TypeScript Build Gate

- **User outcome:** a developer's `pnpm build` compiles the whole repository, so a type error names a real defect instead of another task's parked module.
- **Audit:** `ready`. `pnpm build` exits 1 with 30 `error TS` diagnostics across 13 files. Every diagnostic is already named as some feature card's own gap, and all eleven owning cards are `claimable: false` behind ancestors that themselves required the repo-wide build, so no legal claim path to the errors existed. This card is the maintainer-authorised owner of the shared gate and of those 13 files' type correctness.
- **Scope:** make the repo-wide TypeScript gate green. Own only type correctness: bring a fixture to the shape the production contract already declares, complete a production call site that references an absent property, narrow a discriminated union at the access site, drop a genuinely unread import, and pin a widened literal to its declared union. Behavioural deliverables stay with their cards — notably `capabilities.rearrangeSupported` / `cleanupSupported` hard-coded `false` (ED-STYLE-002), the unused `completionScopeAdapter` consumer (ED-COMP-004), and the release receipt runner (ED-REL-001).
- **Contract:** no assertion is deleted, no closed union widened, no `any` / `@ts-expect-error` / `skipLibCheck` escape added, and no test weakened to fit code. A fixture and its production type may only converge on the shape production actually produces. Test counts before and after are identical, and no card's behavioural gap is silently closed or silently deepened.
- **Acceptance:** `ED-GATE-003-A1` `pnpm build` exits 0 on the current tree with zero `error TS` diagnostics; `A2` each of the 30 diagnostics is resolved by a recorded truthful cause, with no suppression directive, union widening, or deleted assertion introduced; `A3` `pnpm test` file and test counts are unchanged from the pre-fix baseline, and every adjacent behavioural gap found while fixing is reported to its owning card rather than absorbed.
- **Required evidence:** `code-audit`, `unit`, `build`.
- **References:** ED-GATE-001's recorded deadlock analysis; owning cards ED-STYLE-002, ED-REF-001, ED-QUERY-004, ED-FIND-003, ED-FIND-004, ED-COMP-004, ED-PROJECT-005, ED-USAGE-002, ED-REL-002, ED-REL-003, ED-REL-004.

<a id="ed-gate-001"></a>
## ED-GATE-001 Stable Frontend Regression Baseline

- **User outcome:** ordinary editor changes are evaluated against deterministic tests rather than timing flakes.
- **Audit:** `implemented`. The `5ac80fc4` audit's 5 failures are down to 1 stable failure after `71a30b2f`: `companionCapabilities.test.ts` "builds plans that omit unsupported stages", the directory format-scope contract mismatch owned by ED-STYLE-001. Two consecutive full runs at `6ec57e2a` then exposed a *new* order-dependent failure that no card had recorded: `CodeWorkspaceTab.test.tsx` "sets mnemonic bookmarks through the mounted prompt and replaces conflicts" (`expected length 2, got 1`) fails in run 1 and passes in run 2 of the 390-file suite, while passing 92/92 alone and passing in a 203-file `src/components/editor` subset. A2 therefore fails on nondeterminism, independently of the build gate. A3's TypeScript half is now owned by ED-GATE-003.
- **Scope:** fix the identified Settings appearance and Git gutter scheduling causes, plus the newly identified cross-file ordering/pollution cause behind the mnemonic-bookmark failure. That failure is a test-isolation defect, not a bookmark behaviour defect, so ED-BOOKMARK-001's contract is out of scope. Do not loosen assertions, extend arbitrary timeouts, retry, reorder, or quarantine to hide it, and do not absorb ED-STYLE-001's format-scope contract.
- **Contract:** a failing first run is preserved with its root cause; two clean full runs must agree before the baseline is accepted.
- **Acceptance:** `ED-GATE-001-A1` focused failures reproduce then pass for the intended cause; `A2` two clean `pnpm test` runs have identical counts; `A3` build and QA diff checks pass.
- **Required evidence:** `code-audit`, `unit`, `build`, `qa-lint`.
- **References:** historical `BB0-A`.

<a id="ed-gate-002"></a>
## ED-GATE-002 Reproducible Non-Release Baseline Receipt

- **User outcome:** maintainers can regenerate a deterministic, read-only summary of the tested source and commands without creating a release claim.
- **Audit:** `implemented`. `editor_baseline_summary.py` and its focused tests remain present and reject release-evidence roots, but its predecessor baseline is currently red and the helper was not rerun to publish a new green baseline.
- **Scope:** source/tree identity, dirty/untracked product inputs, command exits, test counts, and failures. No signing, release PASS, or current evidence mutation.
- **Contract:** identical input produces byte-identical deterministic output; dirty or untracked product input is explicit; failed commands remain failed.
- **Acceptance:** `ED-GATE-002-A1` deterministic output matches byte-for-byte; `A2` dirty/untracked input is recorded; `A3` release evidence roots and release claims are rejected.
- **Required evidence:** `code-audit`, `unit`, `document`.
- **References:** historical `BB0-C`.
