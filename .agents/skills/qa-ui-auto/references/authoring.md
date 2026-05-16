# Authoring testcases

Rules for the parent agent (Claude Code) when writing or fixing a `qa-ui-auto-tests/cases/*.testcase.yaml` file. The runner skill itself does not author cases unprompted; this is the rulebook the `gen-coverage` and `gen-diff` subcommands follow when they do.

## Discovery helpers (read these first)

Before drafting or fixing a case, run the deterministic helpers to know what's missing or impacted:

```bash
# What features have no testcase, or are only covered by needs-review cases?
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.coverage_report
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.coverage_report --feature F4.10

# Which features and cases does the current change touch?
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.diff_impact
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.diff_impact --files src/components/foo.tsx

# Which features did a commit range add / change / break? (for gen-from-range)
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.range_changes --since HEAD~5

# Inspect the feature catalog directly (parses qa-ui-auto-tests/feature-list.md):
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.feature_catalog
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.feature_catalog --feature F4.10 --json
```

All four tools support `--json` for parsing. None of them write any files.

## File and ID conventions

- One file per case: `qa-ui-auto-tests/cases/<id>-<slug>.testcase.yaml`. Slug is the title lowercased, non-alphanumerics → `-`, truncated to ~40 chars.
- `id` matches the filename prefix and is unique repo-wide.
- Always set `covers: [F.x, F.y, ...]` with at least one feature ID from `qa-ui-auto-tests/feature-list.md`. `lint` does not enforce this yet, but coverage analysis will.
- Always declare `fixtures` explicitly. Use `reset_db` for any case that mutates persistent state. Add `ssh_required` / `sftp_required` if the case talks to the network.

## Verb rules

- Use only verbs listed in `verb-catalog.md`. The schema rejects anything else.
- Each step is a single-key map. `{click: "...", screenshot: "y.png"}` is invalid.
- Selectors prefer `[data-testid="..."]`. Fall back to `text=`, `role=`, CSS, or XPath only when no testid exists — and add a testid in the next change.
- The only escape hatch for raw JS is `eval_readonly`. The schema rejects assignments, `await`, `function`, `new`, `.click(`, `.dispatchEvent(`, `.innerHTML=`, etc. Use it sparingly (e.g., reading `localStorage`).

## Modes

- `modes: [browser]` is the default. Add `native` only when the case truly needs the Tauri Rust backend: local PTY behavior, native dialogs, system clipboard read paths, window controls.
- Browser+native is rarely correct. The duplicate-run policy is gone.

## When you fix a failing case

Order of operations:

1. Read the failure: `qa-ui-auto-report/<run>/<TC-id>/_failure-stepN.{png,html,console.json}`.
2. Read the case YAML.
3. Read the relevant component source (find via `qa-ui-auto-tests/feature-list.md` → `files`).
4. Decide whether the case is wrong (selector renamed, assertion stale) or the code is wrong (real regression).
5. If the case is wrong, propose a YAML patch — show a unified diff in chat — and only apply after user approval.
6. After applying, re-run with `--filter <id> --workers 1`.

Never silently rewrite a case without showing the diff. Never disable a case to make CI green; if you must, mark `skip: "<reason>"` and surface the skip prominently.

## Tagging

- `smoke` — fast (≤30 s), no network preconditions, runs on every PR.
- `p0` — must pass before a release tag.
- `p1` — full sweep on `main`.
- `needs-review` — auto-migrated or auto-drafted; flag for human read.
- `legacy-imported` — added by the migration step; cleared once the case is hand-reviewed.
- `terminal`, `sftp`, `ssh`, `tunnel`, `vnc`, `welcome`, `main`, `settings` — area tags.

## Adding a new verb to the step library

Three places must move together:

1. `scripts/qa_ui_auto/steps/<module>.py` — implement the function and `@verb("name")` it.
2. `schema/testcase.schema.json` — add the property under `step.properties` and a `$defs` entry for its arg shape.
3. `references/verb-catalog.md` — document it.

Run `python -m qa_ui_auto.lint` after.

## Adding a new feature to the catalog

When NewMob ships a new feature in `feature-list.md`, add a matching entry to `qa-ui-auto-tests/feature-list.md`:

```yaml
- id: F<chapter>.<seq>
  title: <human title>
  status: done
  area: <slash/separated/area>
  components: [ComponentA, ComponentB]
  files: [src/components/.../File.tsx]
```

Then add at least one testcase referencing it via `covers: [F<id>]`.
