---
name: qa-ui-auto
description: "End-to-end UI automation for the NewMob Tauri desktop app, plus tools to maintain the testcase catalog and the feature inventory. Provides six subcommands: `run` (execute testcases), `lint` (schema-validate YAML), `gen-coverage` (find features with no test and draft new cases), `gen-diff` (find tests impacted by a code change and patch them), `gen-from-range` (refresh feature-list.md based on a commit range), `explore` (free-form exploratory testing). Browser mode (Vite + real backend proxies) is primary; native mode is a Tauri WebDriver smoke subset. Test cases live as typed YAML under qa-ui-auto-tests/cases/*.testcase.yaml; the feature catalog lives in qa-ui-auto-tests/feature-list.md with embedded HTML-comment frontmatter. Use when the user asks to: run UI tests, do E2E testing, smoke test the app, regression test SSH/SFTP/terminal/SFTP/tunnel flows, validate testcases, check the coverage matrix, ask 'which features have no test', ask 'did my change break a test', update tests for a PR, refresh the feature list from recent commits, exploratory test a feature area, or mentions qa-ui-auto, testcase-for-auto.md, feature-list.md, or automated UI testing."
---

# qa-ui-auto — NewMob UI E2E + catalog maintenance

This skill exposes **six subcommands**. Three (`run`, `lint`, plus the data fetchers behind `gen-coverage` / `gen-diff` / `gen-from-range`) are deterministic Python tools. Three are **playbooks** the parent agent (Claude Code) follows in the current session — they read project state, draft / patch files, verify, and do **not** call any external LLM API. Claude Code itself **is** the LLM; that's how the drafting work gets done.

## Trigger keywords

- "run UI tests", "E2E test", "smoke test the app", "regression test", "verify the X flow" → **`run`**
- "validate testcases", "check the testcase YAML", "lint" → **`lint`**
- "coverage matrix", "which features have no test", "what's untested", "draft a test for F4.X" → **`gen-coverage`**
- "did my change break a test", "update tests for this PR", "what tests should I run for this diff" → **`gen-diff`**
- "refresh feature-list.md from recent commits", "what new features did I add since X", "missing features for this range" → **`gen-from-range`**
- "exploratory test the SFTP flow", "free-form test the terminal", "find UI bugs" → **`explore`**

## Boundaries between gen-* subcommands

```
                                    code change            commit history          missing tests
                                          ↓                       ↓                       ↓
                                   ┌──────────────┐       ┌──────────────┐       ┌───────────────┐
                                   │  gen-diff    │       │ gen-from-    │       │ gen-coverage  │
                                   │              │       │   range      │       │               │
                                   │ patches      │       │ updates      │       │ drafts new    │
                                   │ existing     │       │ feature-     │       │ test cases    │
                                   │ test cases   │       │ list.md      │       │ in cases/auto │
                                   └──────┬───────┘       └──────┬───────┘       └──────┬────────┘
                                          ▼                      ▼                      ▼
                       qa-ui-auto-tests/cases/  qa-ui-auto-tests/feature-list.md   qa-ui-auto-tests/cases/auto/
```

Each command **only writes** to one place. Don't blur boundaries: `gen-from-range` never touches cases; `gen-coverage` never touches feature-list.md; `gen-diff` never creates new cases.

## Layout

```
.agents/skills/qa-ui-auto/
├── SKILL.md                                this file
├── schema/testcase.schema.json             feature-list.md is parser-validated, no schema
├── scripts/
│   ├── qa_ui_auto/                         python package, no LLM calls
│   │   ├── runner.py                       `run`
│   │   ├── lint.py                         `lint`
│   │   ├── feature_catalog.py              feature-list.md parser (used by all gen-*)
│   │   ├── coverage_report.py              data for `gen-coverage`
│   │   ├── diff_impact.py                  data for `gen-diff`
│   │   ├── range_changes.py                data for `gen-from-range`
│   │   ├── reporter.py / config.py / testcase.py
│   │   ├── steps/                          39 controlled verbs
│   │   └── fixtures/                       reset_db, ssh_required, sftp_required
│   ├── probe.py                            service preflight
│   ├── tauri_webdriver.py                  native-mode harness
│   ├── migrate.py / backfill_covers.py     one-off legacy tools, kept for reference
└── references/
    ├── verb-catalog.md                     verbs available in YAML
    ├── testid-catalog.md                   stable selectors per surface
    ├── authoring.md                        rules for writing/fixing a case
    └── migration-mapping.md                legacy DSL → YAML cheatsheet
```

Project root holds:
- `qa-ui-auto.config.yaml` — host/port/user, references env vars for secrets
- `qa-ui-auto-tests/feature-list.md` — feature catalog (Markdown + frontmatter)
- `qa-ui-auto-tests/cases/*.testcase.yaml` — typed YAML testcases
- `qa-ui-auto-tests/cases/auto/*.testcase.yaml` — auto-drafted by `gen-coverage`
- `qa-ui-auto-report/run-<timestamp>/` — gitignored output

## Subcommand: `run`

Execute existing testcases. Pure executor — no authoring.

1. **Read config** `qa-ui-auto.config.yaml`. Confirm `app.base_url`, `ssh.host`, `sftp.host` are set.
2. **Confirm secrets**: cases tagged with `fixtures: [ssh_required]` or `[sftp_required]` need `QA_SSH_PASSWORD` in the environment. Without it those cases skip via the fixture.
3. **Preflight**: `python .agents/skills/qa-ui-auto/scripts/probe.py --mode browser`. Browser mode requires Vite up (`DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev`). Don't auto-start services or auto-install — surface the recipe and ask first.
4. **Lint**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint`.
5. **Run**: `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner [flags]`. Flags: `--mode browser|native`, `--tag smoke,p0`, `--filter TC-001,TC-007`, `--workers N`, `--dry-run`, `--headed`.
6. **Report**: runner echoes `summary.md`. For each failure, read `summary.json` and inline failing step / first failure screenshot / in-page console errors.
7. Don't auto-rerun, auto-heal, or guess at YAML fixes inline. Failed test? That's `gen-diff` territory.

## Subcommand: `lint`

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
```

Validates `qa-ui-auto-tests/cases/**/*.testcase.yaml` against the schema and parses `qa-ui-auto-tests/feature-list.md` to check frontmatter blocks. Reports duplicate IDs. Exit 0 ok / 1 errors. Always run before `run`.

## Subcommand: `gen-coverage`

Find features with no testcase (or only weak coverage), and draft new cases.

### Step 1 — Run the coverage analyzer (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.coverage_report
# variants:
#   --uncovered-only        only the gap list
#   --feature F4.10         detail for one feature
#   --json                  machine-readable
```

Returns three buckets:
- **uncovered** — features with zero testcase referencing them via `covers`.
- **needs-review only** — features only covered by auto-migrated cases that still have `_TODO_MIGRATE` placeholders or `tags: [needs-review]`. Structurally covered, but assertions are weak.
- **fully reviewed** — at least one non-needs-review case covers them.

### Step 2 — For each gap (or `--feature F.x` from user), draft a case

You — the parent agent — are doing this. Procedure:

1. Look up the feature via `python -m qa_ui_auto.feature_catalog --feature F.x --json` (or read the JSON from coverage_report). Get `components` and `files`.
2. **Read** every file in `files`. Use Grep to extract `data-testid`, `aria-label`, `role=`, key event handlers, notable text labels.
3. Skim `references/testid-catalog.md` (canonical selectors) and `references/verb-catalog.md` (39 verbs).
4. **Draft** to `qa-ui-auto-tests/cases/auto/TC-auto-F4.X-<slug>.testcase.yaml`:
   - `id: TC-auto-F4.X` (or `TC-auto-F4.Xb` if there's already an auto- case for this feature)
   - `covers: [F4.X]`
   - `tags: [auto-generated, smoke, needs-review]` — the `auto-generated` tag flags it for human review; `smoke` keeps it in CI; `needs-review` warns the assertions may be shallow
   - `fixtures: [reset_db]` plus `ssh_required` / `sftp_required` if the case talks to the network
   - Steps using only verbs from `verb-catalog.md`. Aim for: open → wait_for main container → 1-2 interactions exercising the key path → assert_visible / assert_text on the key outcomes → screenshot.
5. **Validate**: `python -m qa_ui_auto.lint`. Fix schema errors before continuing.
6. **Dry-run**: `python -m qa_ui_auto.runner --filter TC-auto-F4.X --dry-run`. Fix unbound `${cfg.x}` placeholders or unknown verbs.
7. **Real run** if Vite is up: `python -m qa_ui_auto.runner --filter TC-auto-F4.X --workers 1`. If the case fails on first run, fix it before declaring done. If you can't fix it, **delete the draft** rather than leaving a flaky case.
8. **Don't commit.** Tell the user: file path, what was verified, what assertions are weak and why.

### Step 3 — For "needs-review only" features

Same procedure, but instead of a new file, read the existing needs-review case, find `_TODO_MIGRATE` comments, and replace them with proper verb steps (the original eval body is preserved as a comment so you can see what it was trying to do). After patching, drop the `needs-review` tag if you've done a full pass.

### CI implication

Cases under `qa-ui-auto-tests/cases/auto/` with `tags: [auto-generated, smoke]` **DO** run in CI by default. If they're flaky and break PRs, the response is to fix the case (proper review), not to exclude `auto-generated` from `--tag smoke`.

## Subcommand: `gen-diff`

Find tests impacted by an in-progress change and patch the broken ones.

### Step 1 — Run the diff impact analyzer (deterministic)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.diff_impact
# variants:
#   --base origin/main      explicit base (default tries origin/main, main, HEAD~1)
#   --files a.tsx b.tsx     bypass git, treat these as the change set
#   --no-uncommitted        ignore staged/unstaged/untracked
#   --json                  machine-readable
```

Returns:
- **Impacted features**: features whose `files:` paths intersect the changed paths.
- **Impacted testcases**: cases that `cover` any impacted feature, OR whose YAML file itself was edited.
- **Features with NO testcase touching the change**: gaps the user might want to fill.

### Step 2 — Patch broken tests

For each impacted case:

1. Read the case YAML and the changed component source.
2. For every `[data-testid="..."]`, `text="..."`, `aria-label="..."` literal in YAML, grep the new source — still there?
3. If a selector is gone:
   - Find what replaced it in the new source (semantic match: same nearby button, same role, similar label).
   - Output a unified diff (markdown code block) for the YAML change.
   - **Don't apply** until the user confirms.
4. After applying, run `python -m qa_ui_auto.runner --filter <id>` to verify.

### Step 3 — Suggest new coverage if needed

If diff_impact reports "Features with NO testcase touching the change", suggest the user run `gen-coverage --feature F.x` to draft a case before merging. Don't do it unilaterally — keep the boundary clean.

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

### Step 3 — Run lint

After modifying feature-list.md:

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
```

Confirms feature_catalog still parses cleanly (no duplicate IDs, no malformed YAML in frontmatter).

### Important boundaries

- **Don't run `gen-coverage` automatically** after gen-from-range. Tell the user "feature-list.md updated. Run `/qa-ui-auto gen-coverage` next to draft tests for the new features." That's a separate, explicit step.
- **Don't write any testcase YAML.** That's strictly `gen-coverage`'s job.
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

If the user already added a feature to the codebase but hasn't committed yet (or commits don't reflect what they want documented), they can manually add a frontmatter block to feature-list.md and then run `gen-coverage --feature F.x`. `gen-from-range` is the convenience for the more common case of "I committed a few times, now backfill the catalog."
