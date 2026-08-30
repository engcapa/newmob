# Correctness Gates Specification

Shared contracts: [`shared-contracts.md`](./shared-contracts.md). These tasks protect the repository baseline; they do not prove an editor capability or release.

<a id="ed-gate-001"></a>
## ED-GATE-001 Stable Frontend Regression Baseline

- **User outcome:** ordinary editor changes are evaluated against deterministic tests rather than timing flakes.
- **Audit:** `ready`. The production Git gutter debounce fix remains, but the current audit at `5ac80fc4` ran 3,425 tests and failed 5 in `SettingsPanel.test.tsx` (2), `CodeWorkspaceTab.test.tsx` (2: Git gutter and format-on-save), and `companionCapabilities.test.ts` (directory format scope). The historical green run is preserved only as prior completion evidence.
- **Scope:** fix the identified Settings appearance and Git gutter scheduling causes. Do not loosen assertions, extend arbitrary timeouts, or quarantine unrelated failures.
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
