---
name: qa-ui-auto
description: "End-to-end UI automation for the NewMob Tauri desktop app, plus tools to maintain the testcase catalog, the feature inventory, and a per-feature controls inventory. Provides seven subcommands: `run` (execute testcases), `lint` (schema-validate YAML + selector-orphan check), `gen-coverage` (find features with no test and draft new cases), `gen-diff` (find tests impacted by a code change and patch them), `gen-from-range` (refresh feature-list.md based on a commit range), `gen-controls` (extract per-feature interactive controls from .tsx and report control-level coverage), `explore` (free-form exploratory testing). Two CI guards back the controls inventory: `control_coverage --gate qa-ui-auto-tests/coverage-baseline.json` ratchets that required-control coverage / shallow / orphan counts cannot regress, and `gen_testid_catalog --check` keeps `references/testid-catalog.md` in sync with the feature list. Browser mode (Vite + real backend proxies) is primary; native mode is a Tauri WebDriver smoke subset. Test cases live as typed YAML under qa-ui-auto-tests/cases/*.testcase.yaml; the feature catalog lives in qa-ui-auto-tests/feature-list.md with embedded HTML-comment frontmatter (each feature optionally lists its `controls:`); the active config lives at qa-ui-auto-tests/qa-ui-auto.config.yaml (template and smoke preset are in .agents/skills/qa-ui-auto/assets/). Use when the user asks to: run UI tests, do E2E testing, smoke test the app, regression test SSH/SFTP/terminal/SFTP/tunnel flows, validate testcases, check the coverage matrix, ask 'which features have no test', ask 'which controls in this panel are untested', ask 'did my change break a test', update tests for a PR, refresh the feature list from recent commits, exploratory test a feature area, or mentions qa-ui-auto, feature-list.md, or automated UI testing."
---

# qa-ui-auto — NewMob UI E2E + catalog maintenance

This skill exposes **seven subcommands**. Three (`run`, `lint`, plus the data fetchers behind `gen-coverage` / `gen-diff` / `gen-from-range` / `gen-controls`) are deterministic Python tools. The rest are **playbooks** the parent agent (Claude Code) follows in the current session — they read project state, draft / patch files, verify, and do **not** call any external LLM API. Claude Code itself **is** the LLM; that's how the drafting work gets done.

## Trigger keywords

- "run UI tests", "E2E test", "smoke test the app", "regression test", "verify the X flow" → **`run`**
- "validate testcases", "check the testcase YAML", "lint" → **`lint`**
- "coverage matrix", "which features have no test", "what's untested", "draft a test for F4.X" → **`gen-coverage`**
- "did my change break a test", "update tests for this PR", "what tests should I run for this diff" → **`gen-diff`**
- "refresh feature-list.md from recent commits", "what new features did I add since X", "missing features for this range" → **`gen-from-range`**
- "which controls in panel X are untested", "fill in controls for this feature", "what's in WelcomePanel that no case touches" → **`gen-controls`**
- "exploratory test the SFTP flow", "free-form test the terminal", "find UI bugs" → **`explore`**

## Boundaries between gen-* subcommands

```
                       code change       commit history     missing tests       per-component controls
                            ↓                  ↓                  ↓                   ↓
                     ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌────────────────┐
                     │  gen-diff    │  │ gen-from-    │  │ gen-coverage  │  │ gen-controls   │
                     │              │  │   range      │  │               │  │                │
                     │ patches      │  │ updates      │  │ drafts new    │  │ fills the      │
                     │ existing     │  │ feature-     │  │ test cases    │  │ controls: list │
                     │ test cases   │  │ list.md body │  │ in cases/auto │  │ in feature     │
                     └──────┬───────┘  └──────┬───────┘  └──────┬────────┘  │ frontmatter    │
                            ▼                 ▼                 ▼            └────────┬───────┘
              qa-ui-auto-tests/cases/  feature-list.md       cases/auto/              ▼
                                       (sections + body)                       feature-list.md
                                                                               (controls: only)
```

`gen-from-range` and `gen-controls` both modify `feature-list.md`, but write **different fields**: `gen-from-range` owns H3 sections + `id/area/files/components/status` frontmatter; `gen-controls` only owns the `controls:` list inside an existing frontmatter block. They compose: add a new feature with `gen-from-range`, then fill its controls with `gen-controls`.

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
│   │   ├── runner.py                       `run`
│   │   ├── lint.py                         `lint` (testcases + features + selector-orphan warn)
│   │   ├── feature_catalog.py              feature-list.md parser (used by all gen-*)
│   │   ├── coverage_report.py              data for `gen-coverage` (feature + control level)
│   │   ├── control_extractor.py            data for `gen-controls`: scan .tsx → controls draft
│   │   ├── control_coverage.py             data for `gen-controls` + CI gate; --gate / --update-baseline
│   │   ├── batch_extract.py                bulk-extract drafts for every feature (used during initial fill)
│   │   ├── gen_testid_catalog.py           render references/testid-catalog.md from feature.controls; supports --check
│   │   ├── diff_impact.py                  data for `gen-diff`
│   │   ├── range_changes.py                data for `gen-from-range`
│   │   ├── reporter.py / config.py / testcase.py
│   │   ├── steps/                          39 controlled verbs
│   │   └── fixtures/                       reset_db, ssh_required, sftp_required
│   ├── probe.py                            service preflight
│   └── tauri_webdriver.py                  native-mode harness
└── references/
    ├── verb-catalog.md                     verbs available in YAML
    ├── testid-catalog.md                   AUTO-GENERATED — run gen_testid_catalog after editing feature.controls
    └── authoring.md                        rules for writing/fixing a case

qa-ui-auto-tests/
├── qa-ui-auto.config.yaml                  host/port/user, references env vars for secrets
├── coverage-baseline.json                  CI ratchet for control_coverage --gate (regenerate with --update-baseline)
├── feature-list.md                         feature catalog (Markdown + frontmatter, optional controls:)
└── cases/
    ├── *.testcase.yaml                     typed YAML testcases
    └── auto/*.testcase.yaml                auto-drafted by `gen-coverage`
```

Other paths:
- `qa-ui-auto-report/run-<timestamp>/` — gitignored runner output

## Subcommand: `run`

Execute existing testcases. Pure executor — no authoring.

1. **Read config** `qa-ui-auto-tests/qa-ui-auto.config.yaml`. Confirm `app.base_url`, `ssh.host`, `sftp.host` are set.
2. **Confirm secrets**: cases tagged with `fixtures: [ssh_required]` or `[sftp_required]` need `QA_SSH_PASSWORD` in the environment. Without it those cases skip via the fixture.
3. **Preflight**: `python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser`. Browser mode requires Vite up (`DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev`). Don't auto-start services or auto-install — surface the recipe and ask first.
4. **Lint**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint`.
5. **Run**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner [flags]`. Flags: `--mode browser|native`, `--tag smoke,p0`, `--filter TC-001,TC-007`, `--workers N`, `--dry-run`, `--headed`.
6. **Report**: runner echoes `summary.md`. For each failure, read `summary.json` and inline failing step / first failure screenshot / in-page console errors.
7. Don't auto-rerun, auto-heal, or guess at YAML fixes inline. Failed test? That's `gen-diff` territory.

## Subcommand: `lint`

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
# variants:
#   --skip-cases / --skip-features / --skip-orphans
#   --strict-orphans                 promote orphan selector warning to error
#   --max-orphans-shown N            cap stderr noise (default 20)
```

Three checks, all in one run:

1. **`[cases]`** — every `qa-ui-auto-tests/cases/**/*.testcase.yaml` validates against the schema; case ids are unique.
2. **`[features]`** — `feature-list.md` parses; every `<!-- feature -->` block is well-formed YAML; feature ids are unique; **selectors inside `controls:` blocks must be globally unique** across all features (an error, not a warning — coverage attribution requires it).
3. **`[orphans]`** — every selector that any case touches via an interactive or display verb (click, fill, wait_for, assert_visible, ...) must match a `selector:` entry in some feature's `controls:` list. During the migration period this is a **warning** (`exit 0`) so most of the catalog can stay un-migrated. Use `--strict-orphans` in CI once the catalog is fully populated to make orphans block.

Exit `0` when all are clean (orphans warning is allowed in default mode); `1` on case/feature errors or strict-mode orphans; `2` on setup error (missing schema, missing jsonschema package). Always run before `run`.

## Coverage ratchet & testid catalog

Two non-subcommand utilities that CI uses to keep the control inventory honest. Neither is a "playbook" — they're plain commands that run on every PR after `lint`.

### Coverage ratchet

```bash
# CI runs this; fails the build if any required-control count regressed,
# shallow grew, or orphan count grew vs the saved baseline.
PYTHONPATH=.agents/skills/qa-ui-auto/scripts \
  python -m qa_ui_auto.control_coverage \
    --gate qa-ui-auto-tests/coverage-baseline.json
```

The baseline is `qa-ui-auto-tests/coverage-baseline.json`, a compact snapshot (totals + per-feature `required` / `covered_required` / `shallow`). It moves only when someone explicitly ratchets it:

```bash
# After legitimately improving coverage (e.g. adding cases that cover more
# controls), regenerate. The command refuses to write a baseline that's
# strictly worse than the existing one — pass --force only when the regression
# is intentional (feature removed, control list narrowed).
PYTHONPATH=.agents/skills/qa-ui-auto/scripts \
  python -m qa_ui_auto.control_coverage \
    --update-baseline qa-ui-auto-tests/coverage-baseline.json
```

When gen-coverage drafts and lands a new case, the ratchet should be updated in the same PR. When gen-controls expands a feature's `controls:` list (more required controls without new cases), `covered_required` won't drop in absolute terms but the gap-to-required ratio gets worse — that's still allowed by the ratchet, by design. The ratchet stops *measured* regressions; it doesn't stop *honesty* about new gaps.

### testid-catalog auto-generation

`references/testid-catalog.md` used to be hand-edited and drifted constantly. It's now derived from `feature.controls`:

```bash
# Regenerate after editing any feature's controls block.
PYTHONPATH=.agents/skills/qa-ui-auto/scripts \
  python -m qa_ui_auto.gen_testid_catalog

# CI guard: fails if the file on disk is out of date.
PYTHONPATH=.agents/skills/qa-ui-auto/scripts \
  python -m qa_ui_auto.gen_testid_catalog --check
```

Output groups by `area` (the frontmatter field), one line per control with `selector — kind — F{feature}.{control_id}`. Aliases get an indented `↳` line. Backend-only and undeclared features are skipped.

If `gen-controls` writes new selectors and you forget to regenerate, the next CI run fails the catalog `--check`. Same flow for `gen-diff` patches that introduce a new selector — landing the case YAML, the controls block, and the regenerated catalog should be one PR.

## Subcommand: `gen-coverage`

Find features with no testcase (or only weak coverage), and draft new cases. Reports both feature-level and **control-level** coverage — a feature counts as `fully reviewed` only when (a) it has a non-`needs-review` case AND (b) every required (non-optional) entry in its `controls:` block is touched by a case.

### Step 1 — Run the coverage analyzer (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.coverage_report
# variants:
#   --uncovered-only        feature-level gap list only
#   --controls              control-level actionable list (which testid is untouched in which feature)
#   --feature F4.10         detail for one feature, including its uncovered controls
#   --json                  machine-readable, includes control_coverage_pct + uncovered_required_controls
```

The top-line report has two coverage numbers:
- **feature coverage**: how many features have ≥1 case (legacy gate).
- **control coverage**: how many required controls have ≥1 case touching them via the right verb class (interactive verb on `kind: interactive`, display verb on `kind: display`). This is the real coverage number.

The middle of the report is segmented:
- **Uncovered features** — zero `covers` reference; pure gap.
- **Needs-review only** — every covering case is tagged `needs-review`; assertions known to be shallow.
- **Partial control coverage** — has a reviewed case, but at least one required control is untouched. Each row lists the missing control IDs so the agent knows exactly what to write. **This is the most common gap now.**
- **Fully reviewed** — feature has a real case AND every required control is touched.

### Step 2 — For each gap (or `--feature F.x` from user), draft a case

You — the parent agent — are doing this. Procedure:

1. Run `python -m qa_ui_auto.coverage_report --feature F.x` to see the missing control list.
2. Run `python -m qa_ui_auto.feature_catalog --feature F.x --json` to confirm component / file paths.
3. **Read** every file in `files` (focus on the missing controls' selectors).
4. Skim `references/testid-catalog.md` (canonical selectors) and `references/verb-catalog.md` (verbs).
5. **Draft** to `qa-ui-auto-tests/cases/auto/TC-auto-F4.X-<slug>.testcase.yaml`:
   - `id: TC-auto-F4.X` (or `TC-auto-F4.Xb` if there's already an auto- case for this feature)
   - `covers: [F4.X]`
   - `tags: [auto-generated, smoke, needs-review]`
   - `fixtures: [reset_db]` plus `ssh_required` / `sftp_required` if the case talks to the network
   - Steps must touch every missing required `interactive` control via a click/fill/select verb, and every missing `display` control via wait_for/assert_visible/assert_text. Use the exact selector strings from the controls block — don't invent variants (orphan reports flag rogue selectors).
6. **Validate**: `python -m qa_ui_auto.lint`. Confirm `[orphans]` count didn't grow.
7. **Dry-run**: `python -m qa_ui_auto.runner --filter TC-auto-F4.X --dry-run`.
8. **Real run** if Vite is up: `python -m qa_ui_auto.runner --filter TC-auto-F4.X --workers 1`. Re-run `coverage_report --feature F.x` to confirm the count went down.
9. **Update the ratchet** in the same change: `python -m qa_ui_auto.control_coverage --update-baseline qa-ui-auto-tests/coverage-baseline.json`. Skipping this means the next PR can silently regress past your new coverage.
10. **Don't commit.** Tell the user: file path, what was verified, what assertions are weak and why, and remind them to run the catalog generator if they touched `feature.controls` along the way.

### Step 3 — For "needs-review only" features

If `gen-coverage` ever surfaces a needs-review-only feature again, open that case, harden the assertions, and drop the `needs-review` tag once a full pass is done.

### CI implication

Cases under `qa-ui-auto-tests/cases/auto/` with `tags: [auto-generated, smoke]` **DO** run in CI by default. If they're flaky and break PRs, the response is to fix the case (proper review), not to exclude `auto-generated` from `--tag smoke`.

## Subcommand: `gen-diff`

Find tests impacted by an in-progress change and patch the broken ones. Now goes one level deeper than file-name matching: for each impacted feature, the analyzer **re-extracts testid/aria-label from the new source** and diffs against the feature's declared `controls:` to compute three sets per feature — added selectors, removed selectors, unchanged selectors. Each impacted case is then tagged with the specific selectors it touches that match a removed entry, so the agent goes straight to the broken lines.

### Step 1 — Run the diff impact analyzer (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.diff_impact
# variants:
#   --base origin/main      explicit base (default tries origin/main, main, HEAD~1)
#   --files a.tsx b.tsx     bypass git, treat these as the change set
#   --no-uncommitted        ignore staged/unstaged/untracked
#   --json                  machine-readable, includes per-feature control_delta and per-case broken_selectors
```

Returns:
- **Impacted features** — features whose `files:` paths intersect the changed paths. Each row also lists:
  - `controls ADDED` — selectors the new source now declares (and the feature.controls list doesn't yet). Suggest the user add them via `gen-controls --feature F.x`.
  - `controls REMOVED` — declared selectors that no longer appear in source (extractor pass + literal substring fallback to catch testids dispatched through helper components like `<IconBtn testId="x">`). These are very likely to break tests.
- **Impacted testcases** — cases that `cover` any impacted feature, OR whose YAML file itself was edited. Each row that touches a removed selector is flagged `BROKEN xN` with the offending selector strings inline.
- **Features with NO testcase touching the change** — gaps the user might want to fill.

### Step 2 — Patch broken tests

For each impacted case:

1. **If `BROKEN xN` is flagged**: the analyzer already named the stale selectors. Open the case and the changed component; for each broken selector, find what replaced it (extractor's `controls ADDED` list narrows the search). Output a unified diff (markdown code block) for the YAML change. Don't apply until the user confirms.
2. **If only `yaml-changed` is flagged**: someone edited the case directly. Re-run `python -m qa_ui_auto.lint` and `python -m qa_ui_auto.runner --filter <id>` to verify it still passes. No selector chase needed.
3. **If only `covers F.x`**: the feature was touched but no testid moved (e.g. the diff was a logic-only change). Run the case to confirm it still passes; only patch if it actually fails.
4. After applying, run `python -m qa_ui_auto.runner --filter <id>` to verify, then re-run `python -m qa_ui_auto.diff_impact` to confirm `BROKEN` clears.
5. If patching the case meant you also updated the feature's `controls:` (a renamed selector typically requires both YAML edits), regenerate the catalog: `python -m qa_ui_auto.gen_testid_catalog`. Coverage numbers shouldn't change from a pure rename, so the baseline rarely needs to move; if it does, ratchet it.

### Step 3 — Suggest new coverage / control declarations if needed

Two places where gen-diff hands work back to other subcommands:

- `controls ADDED` rows on a feature → suggest `/qa-ui-auto gen-controls --feature F.x` to declare the new selectors. Don't auto-declare them yourself; reviewer decides which are real interactive controls vs decorative.
- "Features with NO testcase touching the change" → suggest `/qa-ui-auto gen-coverage --feature F.x` to draft a case before merging.

Keep the boundaries clean: `gen-diff` patches existing cases. New cases come from `gen-coverage`. New control declarations come from `gen-controls`.

## Subcommand: `gen-from-range`

Refresh `feature-list.md` based on a range of commits (or an explicit commit set). **Only modifies `feature-list.md`** — never touches testcases.

### Step 1 — Run the range analyzer (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.range_changes
# variants:
#   --since v0.1.10                   from a tag / branch / SHA / "yesterday"
#   --since HEAD~5                    last N commits
#   --until <ref>                     end of range (default HEAD)
#   --commits abc,def,ghi             explicit commit set
#   --json                            machine-readable
```

Returns three classifications:

- **Touched features**: existing features in feature-list.md whose `files:` were modified or added
- **Orphan NEW**: files added in the range that no existing feature lists. **Most likely to be a new feature.**
- **Orphan MODIFIED**: files modified but no feature claims them. Possibly an existing feature that should grow its `files:` list, or a new feature.
- **Deleted in features**: files listed by an existing feature that were deleted in the range. The feature may need status downgrade or section removal.

### Step 2 — Update feature-list.md (you, the agent)

For each **Orphan NEW** file:
1. Read the file (Read), the relevant commit message (`git show <sha> --stat -- <path>`).
2. Decide: is this a new feature, or an extension of an existing one?
   - If the file lives in a new component directory and the commit subject reads like a new capability ("feat: add X session type") → new feature.
   - If the file is a sibling of existing feature files in the same directory → likely extending an existing feature.
3. **For a new feature**:
   - Pick the next free section number in the appropriate H2 chapter (e.g. F2.6 if chapter 2 has F2.1..F2.5).
   - Read enough of the new file(s) to write a 3-6 bullet description in Chinese (matches existing feature-list.md style).
   - Build a `<!-- feature ... -->` frontmatter block with `id`, `status: done` (if the commit shipped it), `area`, `components`, `files`.
   - Use the Edit tool to insert: `### N.M <title> <emoji>` heading + frontmatter block + bullets. Place it at the right chapter ordering.
   - Show the user the proposed insertion as a unified diff before applying.
4. **For an extension**: add the new path to the existing feature's `files:` block.

For each **Touched feature**:
1. Read the commits' diff/messages.
2. Decide if the description needs a refresh (new sub-capability, status change, additional bullets).
3. Show diff, apply only after confirmation.

For each **Deleted file in features**:
1. Don't auto-delete the section. Add a `<!-- DELETED in <commit> -->` HTML comment at the top of the section's body so it's visible in raw view.
2. Suggest the user manually decide whether to drop the section, downgrade status, or update the file list.

### Step 3 — Run lint and (if controls changed) regenerate the catalog

After modifying feature-list.md:

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
```

Confirms feature_catalog still parses cleanly (no duplicate IDs, no malformed YAML in frontmatter). If you added a new feature with a `controls:` block (rare in this subcommand — usually you'd defer that to `gen-controls`), also run `python -m qa_ui_auto.gen_testid_catalog` so CI's catalog `--check` doesn't fail on the next PR.

### Important boundaries

- **Don't run `gen-coverage` automatically** after gen-from-range. Tell the user "feature-list.md updated. Run `/qa-ui-auto gen-coverage` next to draft tests for the new features." That's a separate, explicit step.
- **Don't write any testcase YAML.** That's strictly `gen-coverage`'s job.
- **Don't write `controls:` lists.** That's `gen-controls`. After adding a new feature, suggest the user run `/qa-ui-auto gen-controls --feature F.x` to populate its controls.
- **Don't commit.** The user reviews and commits.

## Subcommand: `gen-controls`

Maintain the per-feature `controls:` inventory inside `feature-list.md` frontmatter, and report which controls are touched by which testcases. **Only modifies the `controls:` field** of an existing feature block — never creates features, never writes testcases.

### What "controls" means here

A *feature* (F1.6) is a coarse unit. The `controls:` list inside a feature's frontmatter pins down every interactive or observable element that feature renders, with a stable selector and a kind:

```yaml
<!-- feature
id: F1.6
...
files:
  - src/components/WelcomePanel.tsx
controls:
  - id: open-local-terminal
    selector: '[data-testid="welcome-open-local-terminal"]'
    kind: interactive          # must be exercised by click/fill/select/press/...
  - id: shell-select
    selector: 'select[aria-label="Terminal shell"]'
    kind: interactive
    optional: true             # only renders when >1 local shell detected
  - id: import-openssh-card
    selector: 'text="Import OpenSSH config"'
    kind: interactive
    aliases:                   # extra selectors that should also count as touching this control
      - '[data-testid="welcome-import-openssh"]'   # if you later add a testid
  - id: active-connections-list
    selector: 'text="Active connections"'
    kind: display              # must be observed by wait_for/assert_visible/...
-->
```

`kind: interactive` controls require at least one case to click / fill / press / select-option on the selector. `kind: display` only requires wait_for / assert_visible / assert_text / screenshot. `optional: true` controls don't fail the coverage gate (they conditionally render). `aliases:` is a list of additional selectors that resolve to the same DOM element — both a `text="…"` literal and a `[data-testid="…"]` form may co-exist for the same control. All aliases participate in coverage matching.

**Selector matching.** A case selector counts as touching a control when:
1. It equals the control's selector (or any alias) literally — quote style is folded so `[k='v']` and `[k="v"]` are equal; bare `text=Word` matches `text="Word"`.
2. It is a *derivation* of one — case selector starts with the control selector and the next character is a CSS boundary (`[`, ` `, `:`, `>`, `,`). This handles common refinements without requiring per-instance entries:
   - attribute filter: `[tid="row"][data-key="X"]` → matches `[tid="row"]`
   - descendant chain: `[tid="pane"] button[title="…"]` → matches `[tid="pane"]`
   - Playwright pipe:  `[tid="menu"] >> text=…` → matches `[tid="menu"]`

The longest matching control wins, so a case targeting a more specific container is attributed to that container, not its parent.

### Step 1 — Extract a draft from .tsx (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.control_extractor src/components/WelcomePanel.tsx
# variants:
#   src/components/                  whole directory; concatenates *.tsx
#   --merge F1.6                     diff extractor output against the
#                                    feature's existing controls list
```

Heuristics, in order: `data-testid="x"` → `[data-testid="x"]`; `<button>/<select>/<input> aria-label="X"` → `tag[aria-label="X"]`; PascalCase component tags without testid are skipped (final DOM unknown). Conditional renders (`{flag && <X/>}`, ternaries) are flagged `optional: true`.

The extractor is **always a draft**. Static analysis can't see text-only buttons (`<button><Plus/>Title</button>`), card components that wrap arbitrary children, or list items rendered inside `.map(...)`. Diff mode (`--merge F.x`) is the highest-leverage view: it lists what the extractor found vs. what the feature already declares, with `+` / `-` symbols. A `-` entry with `text="..."` selector is the strongest signal that a control needs a `data-testid` added at the source.

### Step 2 — Fill / patch the feature's controls (you, the agent)

For a feature with an empty or stale `controls:` list:

1. Run `python -m qa_ui_auto.control_extractor <files>` to get a draft.
2. Read the source files to confirm: which extracted entries are real interactive controls, which are decorative (e.g. an `aria-label` on a status icon), which entries are missing because they have no testid.
3. For each missing control, decide: (a) add a `data-testid` to the source file (preferred), or (b) accept a `text="..."` / role-based selector as the canonical one (fragile but acceptable for unique strings).
4. Edit the feature's frontmatter block: replace or extend the `controls:` list. Don't add controls to a feature that doesn't `cover` the file (that's a sign you're crossing feature boundaries — split or rescope first).
5. Run `python -m qa_ui_auto.lint`. The features pass should report `controls (N)` and zero selector duplicates. Strict orphan errors here usually mean another feature owns the same selector — pick which feature it belongs to.
6. Run `python -m qa_ui_auto.gen_testid_catalog` to regenerate `references/testid-catalog.md`. CI's `--check` step will fail otherwise.
7. If you also added cases that landed new control coverage, re-ratchet the baseline: `python -m qa_ui_auto.control_coverage --update-baseline qa-ui-auto-tests/coverage-baseline.json`. Skip this if you only declared controls (no new cases) — the gate will tolerate that.
8. Show the user the unified-diff preview before applying.

### Step 3 — Read the coverage report

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.control_coverage
# variants:
#   --feature F1.6                   one feature, deep detail
#   --orphans                        selectors used by cases but not in any
#                                    feature.controls (the lint --warn list)
#   --json                           machine-readable
```

Per control:
- `✓` covered (kind matches verb class)
- `~` shallow — interactive control only seen by display verbs (e.g. `assert_count` on a button without ever clicking it). Flag for hardening.
- `✗` uncovered required — no case touches the selector at all.
- optional controls report status but never fail the gate.

Orphan list is the inverse: selectors a case uses that no feature declares. Two interpretations:
1. Easy: that feature hasn't filled in its controls yet (migration backlog).
2. Hard: a case is reaching into UI no feature documents — a hidden cross-feature dependency. Decide whether to add the selector to an existing feature or split a new one.

### Important boundaries

- **Don't write feature `id` / `area` / `files`.** That's `gen-from-range`'s territory.
- **Don't generate testcases.** That's `gen-coverage`. After filling controls, point the user at `gen-coverage` to draft cases for any uncovered ones.
- **Don't auto-promote selectors.** Reviewer always decides whether `text="..."` stays or a testid gets added.
- **Don't commit.** The user reviews and commits.

## Subcommand: `explore`

Free-form exploratory testing — drive the UI like a curious user, surface anomalies, write a report. **Does NOT** modify `qa-ui-auto-tests/cases/`.

### Procedure

1. **Bound the run**:
   - `--area sftp|terminal|tunnel|settings` what to focus on
   - `--duration 10m` (default 10 min, hard cap)
   - Action cap default 200 actions; stop on whichever hits first
2. **Preflight**: browser mode only. Confirm Vite is up. Prefer `mcp__playwright__*` tools; otherwise `playwright-cli`.
3. **Drive**: cycles of snapshot → action → check console.error / pageerror / unhandledrejection / network 4xx/5xx on `/__newmob/ssh-bridge` and `/__newmob/sftp-bridge`.
4. **Stay scoped**: don't drift outside `--area` unless a bug trail leads there. Don't touch `~/.ssh/config` or other user files. Don't actually upload from `~/Documents` etc.
5. **Write report** to `qa-ui-auto-report/exploratory-<YYYYMMDD-HHMM>.md`: actions taken, anomalies, repro steps, screenshot paths, suggested next steps (which feature each anomaly touches).
6. **Don't add to cases/**. Tell the user "if anomaly N is real, run `/qa-ui-auto gen-coverage --feature F.x` to lock in regression coverage."

### Bounds

- Token budget: explore can go runaway. After 200 actions or `--duration` minutes, stop and write the report.
- No persistence mutations beyond what `reset_db` cleans up.
- No real SSH connects unless user explicitly says so — default to local-only flows (welcome panel, settings, session editor without saving, tab management).

## Authoring rules (cross-cutting)

When `gen-coverage` writes new YAML or `gen-diff` patches existing YAML, follow `references/authoring.md`:

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

## Adding a new feature manually (without commit history)

If the user already added a feature to the codebase but hasn't committed yet (or commits don't reflect what they want documented), they can manually add a frontmatter block to feature-list.md and then:

1. `gen-controls --feature F.x` to populate the `controls:` list.
2. `gen-coverage --feature F.x` to draft a testcase that exercises those controls.

`gen-from-range` is the convenience for the more common case of "I committed a few times, now backfill the catalog." Either path lands at the same place: a feature with id, files, controls, and at least one case.
