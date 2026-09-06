# Authoring And Maintaining Coverage

Reuse audit results and source context. Inspect the owning feature in
`qa-ui-auto-tests/feature-list.md` and its source files; run a helper only when
information is missing. Apply requested changes directly and summarize the diff.

## Cases

- One unique ID per `cases/<id>-<slug>.testcase.yaml`; drafts may use `cases/auto/`.
  Set `covers: [F.x]` and `fixtures` explicitly. Use `reset_db` for persistent
  mutations, plus required network/workspace/provider fixtures.
- Assert the user's result after acting, including relevant failure/recovery
  paths. Control touches alone do not prove workflows work. Use browser for
  renderer behavior and selected native cases for real OS/IPC boundaries.
- Set `modes` explicitly. Use `[native]` for real-app boundary workflows;
  use `[browser, native]` when both implementations/fixtures support the assertions.
  Browser-specific stubs/verbs stay `[browser]`. Missing modes still default to
  browser for compatibility. Never mass-add native without checking verbs/fixtures.
- Native is a mode, not an OS guarantee. Some verbs are Linux/X11-only; check
  [verb-catalog.md](verb-catalog.md) and `scripts/qa_ui_auto/native_steps.py`.
  Use platform runbooks for OS differences and disclose unsupported paths.
  `native_platforms: [Linux, Windows]` optionally restricts native execution;
  it does not certify those platforms. Do not substitute mocks for OS evidence.
- Each step is a single-key map using a schema-supported verb. `eval_readonly`
  is the only raw-JS escape hatch; never mutate state or bypass the real action.
- Prefer exact `[data-testid="..."]` selectors from feature controls or
  [testid-catalog.md](testid-catalog.md). Add stable testids where needed; avoid
  styling classes and fragile text. Do not add expensive production polling,
  DOM mirroring or instrumentation solely to make automation easier.
- Use condition-based waits and existing performance budgets. Measure affected
  native interactions as described in [native-testing.md](native-testing.md).
  Never weaken assertions, increase latency budgets or skip regressions to pass.

Tags: `smoke` for fast (normally <=30s), self-contained cases; `p0` for release
critical cases; `p1` for broader coverage; area tags for selection. Mark drafts
`auto-generated, needs-review`, adding `smoke` only when appropriate. Retain
`needs-review` and `legacy-imported` until assertions have been reviewed.

## Repair And Verify

Read failure artifacts, YAML and current source to distinguish stale tests from
product regressions. Fix within the user's requested scope; diagnosis alone does
not authorize unrelated product changes. Run affected IDs after a concrete
correction, retaining first-failure evidence and disclosing skips.

The runner validates YAML, so normal edits need a targeted run rather than
separate lint/dry-run/run stages. For feature/control edits, regenerate the
catalog once after the batch and run `python -m qa_ui_auto audit --gate` to check
lint, freshness and the existing coverage ratchet. Ratchet verified improvements
only; do not overwrite unrelated baseline losses.

## Catalogs And Optional Helpers

Add feature `id/title/status/area/components/files` and controls to
`qa-ui-auto-tests/feature-list.md`, then reference its ID from cases. New/unowned
changed files may extend a feature or justify a new one; private helpers do not
automatically need features. Refresh touched features for observable changes.
Remove deleted files from `files`; assess empty features before removing them.

Controls declare `id`, `selector`, `kind: interactive|display`, optional aliases
and `optional`. Conditional controls are not automatically optional: required
workflows must reach them. Review extractor drafts against source. Regenerate
`references/testid-catalog.md` after controls change.

Coverage matches exact selectors/aliases (normalizing quotes) or derivations at
CSS boundaries (`[`, space, `:`, `>`, `,`). The longest control match wins.
Interactive controls require interaction verbs; display-only touches are shallow.
Fix orphan attribution without weakening the asserted behavior.

Use `python -m qa_ui_auto.<module> --help` for flags. Existing modules remain
available for scripts and CI; this table is not a required command sequence.

| Need | Module / Arguments |
|---|---|
| Combined health, gaps, diff and gate | `audit [--feature F.x] [--diff REF] [--gate] [--json]` |
| Case/control context or extraction playbook | `fix tests F.x`, `fix tests --diff REF`, `fix controls F.x` |
| Commit-range inventory | `range_changes --since REF` or `fix features --range REF` |
| Render/check catalog | `gen_testid_catalog [--check]` or `fix catalog` |
| Ratchet verified coverage | `control_coverage --update-baseline qa-ui-auto-tests/coverage-baseline.json` |
| Detailed coverage / orphans | `coverage_report --controls`, `control_coverage --orphans` |
| Strict schema / orphan diagnostics | `lint --strict-orphans` |
| One feature's metadata | `feature_catalog --feature F.x --json` |
| Extract controls / initial bulk fill | `control_extractor FILE.tsx`, `batch_extract` |
| Explicit changed-file impact | `diff_impact --files A.tsx B.tsx` |

When adding a verb, update implementation, testcase schema and verb catalog
together; check/implement native support where appropriate. Validate the argument
contract and execute a representative case. Evidence rollup, release-plan and
artifact scripts remain available when their existing contracts are needed;
routine case maintenance does not require them.
