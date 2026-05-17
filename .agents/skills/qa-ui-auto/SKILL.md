---
name: qa-ui-auto
description: "End-to-end UI automation for the NewMob Tauri desktop app, organized as four task-oriented commands: `audit` (single diagnostic — lint, control coverage, diff impact, gate), `fix` (close one specific gap surfaced by audit — drafts cases, patches broken cases, populates control inventories, regenerates the catalog), `run` (execute existing testcases), `explore` (free-form exploratory drive of the UI). Underlying Python modules (`coverage_report`, `control_coverage`, `diff_impact`, `control_extractor`, `gen_testid_catalog`, ...) remain directly callable for power users; audit/fix call them. Scope is **functional + control-level e2e**: every interactive widget the UI exposes must be touched by at least one case via the right verb class. Out of scope (by design): visual regression, layout matrices, a11y, perf, i18n. Browser mode (Vite + real backend proxies) is primary; native mode is a Tauri WebDriver smoke subset. Cases live as typed YAML under qa-ui-auto-tests/cases/*.testcase.yaml; the feature catalog lives in qa-ui-auto-tests/feature-list.md with embedded HTML-comment frontmatter (each feature lists its `controls:`); coverage baseline lives at qa-ui-auto-tests/coverage-baseline.json. Use when the user asks to: run UI tests, smoke test the app, audit the UI test suite, fix a broken test after a code change, draft a missing test, find which controls aren't covered, explore a feature area, or mentions qa-ui-auto, feature-list.md, or automated UI testing."
---

# qa-ui-auto — NewMob UI E2E

This skill exposes **four task-oriented commands** for the parent agent (Claude Code):

| Command | What you ask | What it does |
|---|---|---|
| `audit`   | "what's the state of UI testing?" / "did my change break a test?" | One diagnostic. Reports health, gaps, and (optionally) diff impact. Each gap is paired with the exact `fix` command that closes it. |
| `fix`     | "draft a test for X" / "patch the broken cases" / "fill controls for X" | Dispatcher. Pre-fetches data the agent needs and prints a numbered playbook. Does not edit YAML on its own. |
| `run`     | "run the smoke tests" / "run TC-038" | Executes existing testcases. Pure executor — no authoring. |
| `explore` | "exploratory test the SFTP flow" | Free-form drive of the UI; writes a report. Does not modify cases. |

`audit` and `fix` share one mental model: **audit names a gap, fix walks you through closing it**. The agent loop is therefore `audit → fix <one gap> → audit (verify)`. Each `fix` invocation handles one feature or one diff.

## Scope

This skill covers **functional / control-level e2e**:

✅ **In scope** (this is what audit/fix actively manage):
- Every interactive control the UI exposes is touched by at least one case via the right verb class (click/fill/press/select_option for `kind: interactive`; wait_for/assert_visible/assert_text for `kind: display`).
- A coverage baseline ratchet prevents silent regressions.
- The testid-catalog projects feature.controls into a docs file kept in lockstep with reality.
- Diff impact maps a code change to broken cases via testid renames.

🟡 **Partial coverage** (the schema can express it but there is no automated detector — the case author writes the assertions by hand):
- Complex interaction patterns: focus traversal, animation completion, multi-mode dismissal (Esc / outside click / Cancel).
- Front-end pure logic: store actions, derived state, async race conditions, localStorage restore, error branches. Reachable through `eval_readonly` and `assert_localstorage`, but not surfaced as a coverage dimension.

❌ **Out of scope** — explicitly not handled here. Adding any of these is a separate project, not a tweak to this skill:
- Visual regression (no baseline screenshots, no `toHaveScreenshot`).
- Layout / viewport matrices (no per-viewport runs, no bounding-box assertions, no overflow/clip detection).
- Accessibility audits beyond what fixtures expose.
- Performance / Core Web Vitals.
- Internationalization (case selectors target English UI strings).

If the user asks "does this skill verify the panel still looks right?" — the answer is no, by design. Suggest filing a follow-up before agreeing.

## Trigger keywords (user problem → command)

- "what's the state of UI testing?", "audit my UI tests", "show me coverage", "are my tests still in sync with main?" → **`audit`**
- "did my change break a test?", "patch the tests for this PR" → **`audit --diff`** (then `fix tests --diff`)
- "F1.6 is missing a test", "draft a test for X" → **`fix tests F.x`**
- "fill in controls for X", "this panel has no testids declared" → **`fix controls F.x`**
- "what new features did I ship since X?" → **`fix features --range REF`**
- "regenerate the testid catalog" → **`fix catalog`**
- "run the smoke", "regression test the SFTP flow" → **`run`**
- "exploratory test X", "find UI bugs in X" → **`explore`**

## Layout

```
.agents/skills/qa-ui-auto/
├── SKILL.md                                this file
├── schema/testcase.schema.json             feature-list.md is parser-validated, no schema
├── assets/
│   ├── qa-ui-auto.config.example.yaml      template — copy to qa-ui-auto-tests/ to get started
│   └── qa-ui-auto.config.smoke.yaml        local smoke config (localhost sshd on port 2222)
├── scripts/
│   ├── qa_ui_auto/                         python package, no LLM calls
│   │   ├── audit.py                        `audit` — single diagnostic entry
│   │   ├── fix.py                          `fix` — task-oriented dispatcher
│   │   ├── runner.py                       `run`
│   │   ├── lint.py                         lint (used by audit)
│   │   ├── feature_catalog.py              feature-list.md parser
│   │   ├── coverage_report.py              feature-level + control-level coverage
│   │   ├── control_coverage.py             selector→control matching, --gate / --update-baseline
│   │   ├── control_extractor.py            scan .tsx → controls draft
│   │   ├── batch_extract.py                bulk-extract every feature (initial fill)
│   │   ├── gen_testid_catalog.py           render references/testid-catalog.md
│   │   ├── diff_impact.py                  git diff → impacted features/cases + ControlDelta
│   │   ├── range_changes.py                git range → new/touched/deleted features
│   │   ├── reporter.py / config.py / testcase.py
│   │   ├── steps/                          39 controlled verbs
│   │   └── fixtures/                       reset_db, ssh_required, sftp_required
│   ├── probe.py                            service preflight
│   └── tauri_webdriver.py                  native-mode harness
└── references/
    ├── verb-catalog.md                     verbs available in YAML
    ├── testid-catalog.md                   AUTO-GENERATED — `fix catalog` to regenerate
    └── authoring.md                        rules for writing/fixing a case

qa-ui-auto-tests/
├── qa-ui-auto.config.yaml                  host/port/user, references env vars for secrets
├── coverage-baseline.json                  CI ratchet for `audit --gate`
├── feature-list.md                         feature catalog (Markdown + frontmatter, controls:)
└── cases/
    ├── *.testcase.yaml                     typed YAML testcases
    └── auto/*.testcase.yaml                auto-drafted by `fix tests`
```

Other paths:
- `qa-ui-auto-report/run-<timestamp>/` — gitignored runner output
- `qa-ui-auto-report/exploratory-<timestamp>.md` — gitignored explore reports

## Command: `audit`

Single diagnostic — never modifies anything.

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit
# variants:
#   --feature F1.6                focus on one feature (gap list shrinks accordingly)
#   --diff                        also show diff impact vs auto-detected base
#   --diff origin/main            explicit base
#   --gate                        CI mode — exit 1 on regression vs baseline,
#                                 lint errors, or stale catalog
#   --json                        machine-readable
```

Three sections always present:

1. **`## Health`** — lint counts (cases, features, controls), orphan count, catalog freshness, lint errors (if any).
2. **`## Gaps`** — bucketed by priority:
   - Uncovered features (priority 10) — feature has zero cases at all
   - Missing required controls (20) — declared control with no case touching its selector
   - Shallow controls (30) — interactive control only seen by display verbs (e.g. `assert_count` without `click`)
   - Orphan selectors (40) — case selector that doesn't match any feature.controls
   - Undeclared features (50) — feature with no `controls:` block (only shown with `--feature`)

   Each row ends with `→ fix <command>` — the agent's next step.

3. **`## Diff impact`** (only with `--diff`) — impacted features with `ADDED` / `REMOVED` selectors; cases touching a removed selector are flagged with stale-selector lists.

4. **`## Gate`** (only with `--gate`) — baseline comparison. Improvements and regressions enumerated. CI uses `--gate` exclusively.

### How to read audit output

The agent's job after running `audit` is straightforward:

1. If health shows lint errors → fix those first (they're not gaps, they're correctness bugs).
2. Iterate gaps in priority order. For each, run the suggested `fix` command and follow its playbook.
3. Re-run `audit` to confirm the gap closed. Move to the next.

Don't try to close all gaps at once. Each `fix` invocation is one feature or one diff; that's the correct unit of work.

## Command: `fix`

Task-oriented dispatcher. Outputs a numbered playbook with concrete commands. The agent then follows the playbook step by step, reading source, drafting YAML, running the runner — `fix` itself does not edit anything.

```bash
fix tests F1.6                draft a case for F1.6 closing its missing controls
fix tests --diff              patch existing cases broken by an in-progress diff
fix tests --diff origin/main  explicit base
fix controls F1.6             populate / update F1.6's `controls:` block
fix features --range REF      backfill feature-list.md from a commit range
fix catalog                   regenerate references/testid-catalog.md
```

### `fix tests F.x` — draft a missing case

The playbook:
1. Reads `coverage_report --feature F.x`, lists missing required controls and shallow controls with their selectors and the verb class needed.
2. Suggests a filename under `cases/auto/`, the right `covers/tags/fixtures` headers.
3. Hands off to the agent: "read these source files, draft YAML touching exactly these selectors, lint, dry-run, run, audit again, ratchet baseline."

The agent must:
- Use the **exact selector strings** from the controls block. Inventing variants creates orphans.
- Tag the new case with `auto-generated, smoke, needs-review`. CI will run it; it stays `needs-review` until a human hardens the assertions.
- Update `qa-ui-auto-tests/coverage-baseline.json` in the same change once the case lands and audit confirms the gap closed.

### `fix tests --diff [BASE]` — patch broken cases

The playbook:
1. Runs `diff_impact` against the base.
2. For each impacted feature, lists `ADDED` / `REMOVED` selectors. ADDED ones go to `fix controls F.x` (extractor saw them, but the controls block doesn't yet declare them). REMOVED ones are the source of brokenness.
3. For each case with `BROKEN xN`, lists the stale selectors inline. The agent reads the case YAML and the new source, finds replacements (often listed in ADDED), produces a unified diff, and applies after the user confirms.

A pure rename normally doesn't move coverage numbers, so the baseline rarely needs to ratchet.

### `fix controls F.x` — populate or update a controls block

The playbook:
1. Runs `control_extractor` on the feature's `.tsx` files; prints the draft.
2. If the feature already has controls, also prints the diff (`+` extractor saw something not declared, `-` declared something extractor doesn't see).
3. Hands off to the agent: "review entries, drop noise, fix `kind`, mark `optional`, add testids in source for misses, edit feature-list.md, lint, regenerate catalog, audit."

A `-` entry with a `text="..."` selector is the strongest signal that **a testid should be added at the source** — that selector form is fragile and the extractor proves the static testid doesn't exist yet. Adding it makes the case stable.

### `fix features --range REF` — backfill feature-list.md

The playbook references the underlying `range_changes` analyzer. The agent walks through the four classifications (Touched / Orphan NEW / Orphan MODIFIED / Deleted in features) and edits feature-list.md per the rules in `gen-from-range`'s legacy playbook (still listed in the appendix below).

After adding new features, the playbook directs the agent to chain into `fix controls F.x` then `fix tests F.x` for each.

### `fix catalog`

Wraps `gen_testid_catalog`. Run after editing any feature's controls block; CI's audit `--gate` checks for staleness.

## Command: `run`

Execute existing testcases. Pure executor — no authoring.

1. **Read config** `qa-ui-auto-tests/qa-ui-auto.config.yaml`. Confirm `app.base_url`, `ssh.host`, `sftp.host` are set.
2. **Confirm secrets**: cases tagged with `fixtures: [ssh_required]` or `[sftp_required]` need `QA_SSH_PASSWORD` in the environment.
3. **Preflight**: `python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser`. Browser mode requires Vite up (`DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev`). Don't auto-start services; surface the recipe and ask first.
4. **Audit**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit` (lint must be clean before running).
5. **Run**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner [flags]`. Flags: `--mode browser|native`, `--tag smoke,p0`, `--filter TC-001,TC-007`, `--workers N`, `--dry-run`, `--headed`.
6. **Report**: runner echoes `summary.md`. For each failure, read `summary.json` and inline failing step / first failure screenshot / in-page console errors.
7. Don't auto-rerun, auto-heal, or guess at YAML fixes inline. Failed test? That's `fix tests --diff` territory.

## Command: `explore`

Free-form exploratory testing — drive the UI, surface anomalies, write a report. **Does NOT** modify `qa-ui-auto-tests/cases/`.

1. **Bound the run**: `--area sftp|terminal|tunnel|settings`; `--duration 10m` (default 10 min, hard cap); action cap default 200 actions.
2. **Preflight**: browser mode only. Confirm Vite is up. Prefer `mcp__playwright__*` tools; otherwise `playwright-cli`.
3. **Drive**: cycles of snapshot → action → check console.error / pageerror / unhandledrejection / network 4xx/5xx on `/__newmob/ssh-bridge` and `/__newmob/sftp-bridge`.
4. **Stay scoped**: don't drift outside `--area` unless a bug trail leads there. Don't touch `~/.ssh/config` or other user files.
5. **Write report** to `qa-ui-auto-report/exploratory-<YYYYMMDD-HHMM>.md`: actions, anomalies, repro, screenshot paths, suggested next steps (which feature each anomaly touches).
6. **Don't add to cases/**. Tell the user "if anomaly N is real, run `fix tests F.x` to lock in regression coverage."

## Selector matching (how coverage attributes touches)

A case selector counts as touching a control when:

1. **Exact match**: equals the control's selector or any alias literally. Quote style is folded so `[k='v']` and `[k="v"]` are equal; bare `text=Word` matches `text="Word"`.
2. **Derivation match**: case selector starts with the control selector AND the next character is a CSS boundary (`[`, ` `, `:`, `>`, `,`):
   - attribute filter: `[tid="row"][data-key="X"]` → matches `[tid="row"]`
   - descendant chain: `[tid="pane"] button[title="…"]` → matches `[tid="pane"]`
   - Playwright pipe: `[tid="menu"] >> text=…` → matches `[tid="menu"]`

The longest matching control wins, so a case targeting a more specific container is attributed to that container, not its parent. `aliases:` on a control let one DOM element be matched via multiple stable selector forms.

## Authoring rules (cross-cutting)

When `fix tests` writes new YAML or `fix tests --diff` patches existing YAML, follow `references/authoring.md`:

- One file per case: `qa-ui-auto-tests/cases/<id>-<slug>.testcase.yaml` (auto-drafted ones go under `cases/auto/`).
- Always set `covers: [F.x]`.
- Always declare `fixtures` explicitly. Use `reset_db` for any case that mutates persistent state.
- Verbs only from `references/verb-catalog.md`. Each step is a single-key map.
- Selectors prefer `[data-testid="..."]`. Fall back to `text=`, `role=`, CSS, XPath only when no testid exists — and consider adding a testid in the same change.
- Only escape hatch for raw JS is `eval_readonly`. Schema rejects assignments, `await`, DOM mutations.
- Modes: `[browser]` is default. Add `native` only when the case truly needs the Tauri Rust backend.

## Failure handling for `run`

- The first failing step in a case is fatal **for that case only**; the runner continues with remaining cases.
- Exit codes: `0` all passed, `1` at least one failed, `2` setup/config error.
- `summary.json` is the stable contract Claude Code parses.

## Cross-platform notes

- **Linux/CI**: browser mode runs headless Chromium. Native needs `tauri-driver`, `WebKitWebDriver`, and Xvfb/VNC.
- **macOS**: browser only; Tauri WebDriver is unsupported on macOS.
- **Windows**: browser mode works as-is. Native requires `tauri-driver` + `msedgedriver.exe`.

---

## Appendix A — underlying Python modules

`audit` and `fix` are wrappers; the data fetchers below remain directly callable for power users, scripts, and CI artifacts.

| Module | Purpose | Direct invocation |
|---|---|---|
| `qa_ui_auto.lint` | Schema-validate cases, parse features, compute orphan selectors | `python -m qa_ui_auto.lint [--strict-orphans]` |
| `qa_ui_auto.coverage_report` | Feature × case matrix + control-level rollup | `python -m qa_ui_auto.coverage_report [--controls\|--feature F.x\|--json]` |
| `qa_ui_auto.control_coverage` | Per-control hits + gate/baseline | `python -m qa_ui_auto.control_coverage [--gate FILE\|--update-baseline FILE\|--orphans]` |
| `qa_ui_auto.control_extractor` | Static .tsx → controls draft | `python -m qa_ui_auto.control_extractor src/components/X.tsx [--merge F.x]` |
| `qa_ui_auto.batch_extract` | Bulk-extract every feature in one go | `python -m qa_ui_auto.batch_extract` |
| `qa_ui_auto.diff_impact` | Git diff → impacted features/cases + ControlDelta | `python -m qa_ui_auto.diff_impact [--base REF\|--files A.tsx B.tsx]` |
| `qa_ui_auto.range_changes` | Git range → new/touched/deleted | `python -m qa_ui_auto.range_changes --since REF` |
| `qa_ui_auto.gen_testid_catalog` | Render testid-catalog.md from feature.controls | `python -m qa_ui_auto.gen_testid_catalog [--check\|--stdout]` |
| `qa_ui_auto.feature_catalog` | feature-list.md parser; CLI for one-off lookups | `python -m qa_ui_auto.feature_catalog [--feature F.x --json]` |

## Appendix B — adding a new feature manually (without commit history)

If the user already added a feature to the codebase but hasn't committed yet:

1. Add a frontmatter block to feature-list.md by hand (just `id/area/files/components/status` — no controls yet).
2. `python -m qa_ui_auto.fix controls F.x` → populate the controls list.
3. `python -m qa_ui_auto.fix tests F.x` → draft a testcase exercising those controls.
4. `python -m qa_ui_auto.fix catalog` → keep the catalog in sync.
5. `python -m qa_ui_auto.audit --feature F.x` → confirm fully reviewed.
6. `python -m qa_ui_auto.control_coverage --update-baseline qa-ui-auto-tests/coverage-baseline.json` → ratchet.

`fix features --range REF` is the convenience for the more common case of "I committed a few times, now backfill the catalog." Either path lands at the same place.
