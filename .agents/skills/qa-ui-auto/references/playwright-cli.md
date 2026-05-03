# playwright-cli cheatsheet (for qa-ui-auto)

`playwright-cli` is a thin CLI wrapper around Playwright. The runner relies on
the subset listed below. Install with:

```
npm install -g @playwright/cli@latest
playwright-cli install chromium
```

State is shared across invocations via `--user-data-dir <path>`. The runner
gives each test case its own profile dir under `qa-ui-auto-report/<TC>/profile`,
so multiple cases never collide.

## Navigation
- `playwright-cli open <url> --user-data-dir DIR [--headed]`
  Open a URL in a persistent browser context. Subsequent commands act on the
  same context.

## Interaction
- `playwright-cli click <selector>` — left click.
- `playwright-cli dblclick <selector>` — double click.
- `playwright-cli type <text>` — type into the focused element.
- `playwright-cli fill <selector> <value>` — focus + clear + type.
- `playwright-cli press <key>` — e.g. `Enter`, `Tab`, `Control+L`.
- `playwright-cli select <selector> <value>` — pick an `<option>`.

## Waiting & assertions
- `playwright-cli wait-for <selector>` — wait until selector exists & visible.
- `playwright-cli expect visible <selector>`
- `playwright-cli expect text <selector> <substring>`
- `playwright-cli expect url <substring>`

## Capture
- `playwright-cli screenshot --path <file>`
- `playwright-cli eval "<js>"` — run JS in page context, prints the result.

## Selector syntax (Playwright)
- CSS: `button.primary`
- Role:  `role=button[name="Save"]`
- Text:  `text="Connected"`
- Test id: `[data-testid="settings-panel"]` or `data-testid=settings-panel`
- nth:   `role=button[name="Save"] >> nth=0`

## Headed vs headless
The runner runs headless by default. Pass `--headed` via the `eval` escape
hatch only when manually debugging — CI and Replit have no display unless
the VNC workflow is running.

## Versioning
`playwright-cli` is pre-1.0; flags occasionally change. If a verb stops
working, check `playwright-cli --help` and `playwright-cli <verb> --help` and
update `scripts/run_tests.py::dispatch` accordingly.
