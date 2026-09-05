# Code Workspace Linux Matrix (ED-QA-003)

> Generated 2026-09-04 from verified runner artifacts only. Machine source:
> `qa-ui-auto-tests/evidence/linux-matrix.2026-09-04.json` (built by
> `.agents/skills/qa-ui-auto/scripts/matrix_from_artifacts.py`).
> Audit gate: `src/lib/release/linuxMatrixArtifact.test.ts` (4/4) plus
> `capabilityMatrixAudit.test.ts` (4/4, synthetic-labelled fixtures).

## Bounded claim

On Linux (Tauri debug binary + WebKitGTK, X11 `:0`, JDT LS 1.61.0 + JDK 21):

- **10 functional rows PASS** from real packaged/browser/provider artifacts,
  every Linux PASS row carrying `origin: runner-artifact` with committed
  receipts on disk.
- **1 row FAIL**: editor key-to-paint p95 171.5ms over the 50ms budget
  (browser-renderer proxy; excludes OS/compositor/WebKitGTK). Not a
  functional failure; the budget miss is the gap.
- **14 rows BLOCKED**: Windows/macOS have no runners on this Linux-only box;
  each row names its reason independently. No extrapolation.
- **Provider traces satisfied** across all 6 JDT LS fixtures.
- **IDEA comparison exact-match** (byte-identical) on the formatting probe:
  IntelliJ IDEA 2026.1.2 (IU-261.24374.151) vs JDT LS post-image
  `eeb42451…`. Ceiling: single-fixture formatting only.

What this matrix does **not** claim: Windows/macOS behavior, WebKitGTK
paint latency, screen-reader/zoom/IME verification (a11y booleans record
exactly what ran), completion/query navigation comparison against IDEA
(manual only; no GUI automation runs on the shared workstation), or
large-corpus performance (environment-blocked in the perf harness).

## Rows

| Capability | Linux | Windows | macOS |
|---|---|---|---|
| query.definition (F12 reveal + history) | PASS (native C6-05 + browser C6-02 + JDT LS traces) | BLOCKED | BLOCKED |
| project.maven-ingest | PASS (native C7-04) | BLOCKED | BLOCKED |
| project.gradle-ingest | PASS (native C7-05) | BLOCKED | BLOCKED |
| completion.choice-undo | PASS (native C2-03 + JDT LS traces) | BLOCKED | BLOCKED |
| reformat.markers | PASS (browser C8-03 + format trace + IDEA exact-match) | BLOCKED | BLOCKED |
| facts.lifecycle | PASS (browser C7-06 + C7-07) | BLOCKED | BLOCKED |
| completion.scope-fallback | PASS (browser C2-02) | BLOCKED | BLOCKED |
| editor-input.key-to-paint | FAIL (p95 171.5ms > 50ms budget, proxy) | — | — |
| editor-input.local-action | PASS (p95 15.4ms <= 100ms, proxy) | — | — |
| a11y.shell-scan | PASS (0 violations, 4 surfaces) | — | — |
| idea.format-markers | PASS (exact-match, byte-identical) | — | — |

## Artifact index

- Native receipts: `qa-ui-auto-tests/evidence/run-20260904-10*.summary.json`
  + `.runner_receipt.json` (command digest, exit code, artifact hashes).
- Browser receipts: `qa-ui-auto-tests/evidence/browser-*.summary.json`.
- Provider: `src/components/editor/workspace/__fixtures__/jdtls/traces/`.
- Perf: `qa-ui-auto-tests/evidence/perf-baseline-browser-20260904-092100.json`
  (local action WITHIN, key-to-paint OVER target).
- A11y: `qa-ui-auto-tests/evidence/a11y-scan-browser-20260904-092119.json`
  (0 violations; complements but never replaces manual keyboard/
  screen-reader/IME smoke).
- IDEA: `qa-ui-auto-tests/evidence/idea-format-FormatProbe.json`.

## Open gaps (A4)

1. key-to-paint p95 over budget on this box — needs WebKitGTK-side
   measurement before any latency claim ships.
2. Screen-reader, 200% zoom, and IME composition unverified beyond
   keyboard/role observations — manual smoke still required.
3. Windows/macOS rows need per-platform runbooks and runners.
4. IDEA comparison beyond single-fixture formatting needs GUI automation
   on a dedicated (non-shared) workstation.
