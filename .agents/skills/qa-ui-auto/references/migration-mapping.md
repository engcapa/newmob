# Migration mapping: old DSL → new YAML

Use this when running the `migrate` subcommand to convert `testcase-for-auto.md` (legacy Markdown DSL) into typed YAML files in `qa-ui-auto-tests/cases/`.

## Verb mapping

| Legacy verb | New YAML form |
|---|---|
| `open <url>` | `- open: <url>` |
| `goto <url>` | `- goto: <url>` |
| `wait` (with seconds) | `- wait: <n>` |
| `sleep <n>` | `- wait: <n>` |
| `wait_for <selector>` | `- wait_for: '<selector>'` |
| `expect_visible <selector>` | `- assert_visible: '<selector>'` |
| `expect_text <selector> <text>` | `- assert_text: { selector: '<sel>', contains: '<text>' }` |
| `expect_url <substr>` | `- assert_url: '<substr>'` |
| `screenshot <name.png>` | `- screenshot: <name.png>` |
| `click <selector>` | `- click: '<selector>'` |
| `dblclick <selector>` | `- dblclick: '<selector>'` |
| `type '<text>'` | `- type: '<text>'`  (or `send_keys` for terminal) |
| `press <key>` | `- press: <key>` |
| `fill <selector> '<value>'` | `- fill: { selector: '<sel>', value: '<value>' }` |
| `select <selector> '<label>'` | `- select_option: { selector: '<sel>', label: '<label>' }` |

## Idiom mapping (replace inline `eval` with verbs)

Most legacy `eval` blocks are doing one of these — translate to the verb form, do **not** keep the eval:

| Legacy idiom | New form |
|---|---|
| `eval 'async page => { await page.locator(...).click({ button: "right", position: {x, y} }); }'` | `- right_click: { selector: '<sel>', position: {x: 24, y: 24} }` |
| `eval 'async page => { await page.locator(...).click({ button: "middle" }); }'` | `- click: { selector: '<sel>', modifiers: [] }` (currently no native middle; if the case relies on middle, leave `_TODO_MIGRATE` and tag `needs-review`) |
| `eval 'async page => { await page.locator(text="X").hover(); }'` | `- hover: 'text=X'` |
| `eval 'async page => { const v = await page.locator(...).getAttribute("type"); if (v !== "password") throw ... }'` | `- eval_readonly: { expression: 'document.querySelector(\"...\").type === \"password\"' }` |
| `eval 'const stored = localStorage.getItem("X"); if (!stored) throw ...'` | `- eval_readonly: { expression: 'localStorage.getItem(\"X\")', expect_truthy: true }` |
| `eval 'async page => { const status = await page.locator(...).innerText(); if (!status.includes("X")) throw ...}'` | `- assert_text: { selector: '...', contains: 'X' }` |
| `eval 'async page => { const s = await page.locator(\"span\").filter({ hasText: /^Match \\d+\\/\\d+$/ }).first().isVisible(); ... }'` | `- assert_pattern: { selector: 'span', regex: '^Match \\d+/\\d+$' }` |
| Right-click context menu then click "Find" | `- right_click: terminal-pane` then `- assert_menu_items: [Find, ...]` then `- click_menu: Find` |
| `eval 'async page => { await page.evaluate(() => { window.prompt = () => "X"; window.confirm = () => true; }); }'` | Add `- eval_readonly` is **not** allowed (this writes); instead, the runner should set this via a controlled fixture. For P2 migration, leave as `_TODO_MIGRATE` and tag `needs-review` — this idiom is a candidate for a future `seed_dialog_response` verb. |
| `eval 'async page => { await page.locator(...).first().fill("X"); }'` | `- fill: { selector: '...', value: 'X' }` |

## Placeholder syntax

| Legacy | New |
|---|---|
| `${cfg:ssh.host}` | `${cfg.ssh.host}` |
| `${env:QA_SSH_PASSWORD}` | `${env.QA_SSH_PASSWORD}` |

The runner accepts both for one release; the lint step will eventually warn on colon form.

## File output convention

For each `## TC-NNN: <title>` block, emit `qa-ui-auto-tests/cases/TC-NNN-<slug>.testcase.yaml`. The slug is the lowercased title with non-alphanumerics → `-`, truncated to 40 chars.

## Tagging

- Always carry over the original `tags:` line.
- Add `needs-review` when any step couldn't map cleanly.
- Add `legacy-imported` for the entire batch so the user can `git diff --grep=legacy-imported` quickly.
