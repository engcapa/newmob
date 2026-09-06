# Browser Exploration Fallback

The YAML runner uses the Playwright Python API; it does not require
`playwright-cli`. Prefer native testing as described in SKILL.md. For interactive
browser exploration, use available Playwright tools or the installed CLI.

CLI commands and flags vary by version. Start with `playwright-cli --help` and
`playwright-cli --help open`; use a dedicated named session and a disposable
profile. Never attach to a personal browser profile or use `close-all`/`kill-all`
to manage one test session.

Typical current CLI sequence:

```bash
playwright-cli -s=taomni-qa open http://localhost:5000
playwright-cli -s=taomni-qa snapshot
# Act on a fresh snapshot's element ref, for example:
playwright-cli -s=taomni-qa click e12
playwright-cli -s=taomni-qa snapshot
playwright-cli -s=taomni-qa console error
playwright-cli -s=taomni-qa requests
playwright-cli -s=taomni-qa screenshot
playwright-cli -s=taomni-qa close
```

Check postconditions after each meaningful action and collect relevant error/
request details. Use `eval` only for read-only observations; UI automation must
perform the actual action. Keep screenshot/report paths from tool output. Do not
invent `expect` or `wait-for` subcommands if the installed CLI does not list them.
For repeatable cases use the YAML verbs and runner; `--headed` is a runner flag,
not JavaScript to pass through an eval escape hatch.
