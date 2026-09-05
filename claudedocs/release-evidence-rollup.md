# Release Evidence Rollup & Runner Smoke Transaction (ED-REL-004)

## 1. Overview & Architecture

The Taomni Code Workspace release verification architecture eliminates fake in-process receipt synthesis and enforces an end-to-end cryptographic trust chain from execution to rollup manifest verification:

```
[Real Runner Execution]
      │
      ▼
[Artifacts & Reports] (summary.json, junit.xml, screenshots)
      │
      ▼
[Repository Identity] (source SHA-256 tree, test plan digests, bundle identity)
      │
      ▼
[Signed Runner Receipt] (runner_receipt.json signed by DEFAULT_RUNNER_KEY_REGISTRY)
      │
      ▼
[Rollup Aggregation] (qa_ui_auto.rollup / releaseRollup.ts)
      │
      ▼
[Deterministic Manifest] (release_rollup_manifest.json with canonical manifestDigest)
      │
      ▼
[Independent Audit] (--check mode verification by external CI or auditor)
```

---

## 2. Release Rollup Contracts & Boundaries

| Component | Responsibility | Failure Mode |
|---|---|---|
| **Runner Receipt** (`runner_receipt.py` / `runnerReceipt.ts`) | Emitted exclusively by the runner executing the test. Binds command digest, timing, exitCode, artifact digests, and repository identities (`sourceIdentityDigest`, `testPlanIdentityDigest`, `bundleIdentity`). Signed with official runner key. | Verification fails closed on unknown key, expired key, revoked key, purpose mismatch, timing tampering, or content alteration. |
| **Evidence Roots** (`release_plan.py` / `releasePlanValidator.ts`) | Restricts all allowable artifact paths to approved committed roots (`qa-ui-auto-report`, `evidence`). | Absolute paths, directory traversal (`..` or `.`), or out-of-root paths are rejected. |
| **Rollup Manifest** (`rollup.py` / `releaseRollup.ts`) | Aggregates collected receipts across channels. **Never generates or synthesizes fake receipts for the executions it is judging.** | Zero receipts evaluates to `INCOMPLETE` (stable RED); non-zero exitCode or invalid signature evaluates to `FAIL`. |
| **Independent Check** (`--check`) | Rebuilds expected manifest from collected receipts, canonical identity, and release plan, matching `manifestDigest` byte-for-byte. | Discrepancies fail closed. |

---

## 3. Real Smoke Execution & Verification Commands

### Step 1: Run Smoke Case in Browser Mode
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --mode browser --filter TC-IDE-C6-02
```
Output:
- Executes `TC-IDE-C6-02` (Definition/References/Hierarchy) against live dev server.
- Automatically produces `qa-ui-auto-report/run-<timestamp>/runner_receipt.json` signed by `key-browser-runner-01`.

### Step 2: Run Smoke Case in Native Mode (Linux Desktop)
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --mode native --filter TC-117
```
Output:
- Launches native WebKitGTK Linux desktop bundle.
- Automatically produces `qa-ui-auto-report/run-<timestamp>/runner_receipt.json` signed by `key-native-linux-01`.

### Step 3: Verify Emitted Runner Receipt
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner_receipt verify qa-ui-auto-report/run-<timestamp>/runner_receipt.json
```

### Step 4: Validate Release Plan & Channel Compliance
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.release_plan \
  --plan qa-ui-auto-tests/release-evidence-plan.json \
  --channel linux-daily-editor \
  --receipt qa-ui-auto-report/run-<timestamp>/runner_receipt.json
```

### Step 5: Build Deterministic Rollup Manifest
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.rollup \
  --plan qa-ui-auto-tests/release-evidence-plan.json \
  --reports-dir qa-ui-auto-report \
  --out qa-ui-auto-report/release_rollup_manifest.json
```

### Step 6: Independent Verification (--check)
```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.rollup \
  --plan qa-ui-auto-tests/release-evidence-plan.json \
  --reports-dir qa-ui-auto-report \
  --check qa-ui-auto-report/release_rollup_manifest.json
```

---

## 4. Acceptance Verification Matrix

| Acceptance ID | Requirement | Verification Evidence |
|---|---|---|
| `ED-REL-004-A1` | Real runner executes smoke case and writes signed receipt/artifact | `qa_ui_auto.runner` runs `TC-IDE-C6-02` (browser) and `TC-117` (native) and emits cryptographically signed `runner_receipt.json` with artifact digests. |
| `ED-REL-004-A2` | Rollup consumes receipt and is byte-identical | `buildReleaseRollupManifest` and `build_release_rollup_manifest` produce identical `manifestDigest` across runs and permutations. |
| `ED-REL-004-A3` | Independent check verifies identity, signature, and artifacts | `--check` mode compares expected vs actual manifest digest and verifies collected receipts. |
| `ED-REL-004-A4` | Tamper, zero, and failure paths remain red | Zero receipts yields `INCOMPLETE`; non-zero exitCode or signature mismatch yields `FAIL`. |
