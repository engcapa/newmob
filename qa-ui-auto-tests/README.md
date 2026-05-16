# qa-ui-auto-tests/

End-to-end UI test artifacts for NewMob, consumed by the `qa-ui-auto` skill.

## Layout

```
qa-ui-auto-tests/
├── feature-list.md            # Feature catalog. Each section has a frontmatter block:
│                              #     <!-- feature
│                              #     id: F4.10
│                              #     status: done
│                              #     area: terminal/file-transfer
│                              #     components: [TerminalPanel, ZmodemConflictDialog]
│                              #     files:
│                              #       - src/lib/zmodem.ts
│                              #     -->
│                              # Parsed by qa_ui_auto.feature_catalog.
└── cases/
    ├── TC-XXX-<slug>.testcase.yaml  # 71 typed YAML testcases (hand-authored + migrated)
    └── auto/                        # gen-coverage's drafts land here
        └── TC-auto-F4.X-...yaml     # tags: [auto-generated, smoke, needs-review]
```

## How to run

Browser mode (default):

```bash
# preflight (in another terminal)
DEV_PROXY_ALLOW_PRIVATE=1 ALLOW_PRIVATE_TARGETS=1 pnpm dev
export QA_SSH_PASSWORD=...

# lint + dry-run
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.lint
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --dry-run

# real run
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --tag smoke --workers 4
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --workers 4
```

Reports land in `qa-ui-auto-report/run-<timestamp>/`.

## Subcommands provided by the skill

The `qa-ui-auto` skill in Claude Code wraps these tools with playbooks:

| Subcommand | Writes to | Purpose |
|---|---|---|
| `run` | (read-only) | Execute testcases |
| `lint` | (read-only) | Schema-validate YAML + parse feature-list.md |
| `gen-coverage` | `cases/auto/` | Draft new cases for uncovered features |
| `gen-diff` | `cases/` (patches) | Patch existing cases impacted by a code change |
| `gen-from-range` | `feature-list.md` | Refresh feature catalog from a commit range |
| `explore` | `qa-ui-auto-report/` | Free-form exploratory testing report |

Trigger the skill in Claude Code by asking naturally: "run smoke tests", "what features have no test", "did my change break a test", "refresh feature-list from the last 5 commits", etc.

## Authoring rules

See `.agents/skills/qa-ui-auto/references/authoring.md` and `verb-catalog.md`.
The Python step library lives at `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/steps/`.

## Coverage status

100% of features in `feature-list.md` have at least one testcase referencing them via `covers`.
Cases tagged `needs-review` were auto-migrated from the old Markdown DSL; their assertions
may need tightening. Track via `python -m qa_ui_auto.coverage_report`.
