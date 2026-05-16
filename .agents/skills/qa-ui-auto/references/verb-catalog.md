# qa-ui-auto verb catalog

Authoritative list of step verbs available in `*.testcase.yaml`. Each verb is implemented in `scripts/qa_ui_auto/steps/`. Schema enforces argument shape.

> Read this when authoring or modifying testcases. Verbs not listed here are not allowed; the schema validator will reject them.

Format reminder: every step is a **single-key map**. Two valid forms:

```yaml
- click: '[data-testid="qc-submit"]'                  # short form when only the selector matters
- click:                                              # rich form
    selector: '[data-testid="qc-submit"]'
    modifiers: [Control]
```

Placeholders: `${cfg.x.y}` resolves from `qa-ui-auto.config.yaml`; `${env.X}` from environment.

## Navigation & timing

| Verb | Args | Notes |
|------|------|-------|
| `open` | string URL **or** `{url}` | Navigates and waits for `domcontentloaded`. Auto-runs at step 0 if first step isn't `open`/`goto`. |
| `goto` | same as `open` | Alias. |
| `wait` | seconds (number or `"3s"`) | Hard sleep; use sparingly. |
| `wait_for` | selector string **or** `{selector, timeout_sec?, state?}` | `state` ∈ `attached/detached/visible/hidden`, default `visible`. |
| `screenshot` | filename string **or** `{path, selector?, full_page?}` | Saved under `qa-ui-auto-report/<run>/<TC-id>/`. |

## Mouse

| Verb | Args | Notes |
|------|------|-------|
| `click` | selector string **or** `{selector, modifiers?, position?, force?}` | `modifiers` ⊆ `Alt/Control/Meta/Shift`. |
| `dblclick` | same as click | |
| `right_click` | same as click | Use before `assert_menu_items` / `click_menu`. |
| `hover` | selector | |
| `drag_to` | `{from, to}` | Both selectors. |

## Keyboard

| Verb | Args | Notes |
|------|------|-------|
| `fill` | `{selector, value}` | Replaces field content. |
| `type` | string | Types into the focused element. Prefer `fill` for inputs. |
| `send_keys` | string | Same as `type`; semantic for terminal-pane interaction. |
| `press` | key string **or** `{key, selector?}` | E.g. `Enter`, `Control+Shift+F`. |
| `select_option` | `{selector, label?, value?}` | At least one of label/value. |
| `upload_file` | `{selector, path}` | Hooks into a file input. |

## Assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_visible` | selector | Up to 15s wait. |
| `assert_not_visible` | selector | Up to 15s wait for hidden. |
| `assert_text` | `{selector, contains, timeout_sec?}` | Polls `text_content` and `data-terminal-text` (xterm canvas fallback). |
| `assert_pattern` | `{selector, regex, timeout_sec?}` | Python regex. |
| `assert_count` | `{selector, min?/max?/equal?}` | Pick at least one bound. |
| `assert_url` | URL substring | |
| `assert_menu_items` | `[label, label, ...]` | After `right_click`; checks each label visible inside `[data-testid="context-menu"]`. |

## App-specific helpers (use these instead of inlining selector chains)

| Verb | Args | Notes |
|------|------|-------|
| `quick_connect` | `{url}` (must match `(ssh\|sftp)://user@host[:port]`) | Fills + submits the QuickConnect bar. |
| `auth` | password string **or** `{password}` | Waits for `[data-testid="auth-prompt"]` then submits. Empty password → step error. |
| `attach_sftp` | (none / `{}`) | Toggles attached SFTP from current SSH terminal. |
| `set_remote_path` | path string | Sets the SFTP remote path input + presses Enter. |
| `seed_clipboard` | text string | Writes text to OS clipboard via the page (controlled write — not eval_readonly). |
| `seed_dialog` | `{prompt: str|[str], confirm: bool}` | Pre-arms `window.prompt` and `window.confirm` responses. Used before SFTP "new file/folder/rename" flows. `prompt` may be a list to feed sequential calls. |
| `open_session` | `{name, double_click?}` | Clicks/dblclicks `[data-testid="session-tree-item"][data-session-name="<name>"]`. |
| `click_menu` | label string **or** `{label}` | Click context-menu item by visible text. |
| `set_check` | `{selector, checked}` | Idempotently set a checkbox (only clicks if state mismatches). |
| `send_text_via_label` | `{label_contains, checked}` | Set a label-wrapped checkbox by the label's text content. |
| `reload` | (none) | Reloads the page (`domcontentloaded` wait). |

## State assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_localstorage` | `{key, exists?/contains?/equals?}` | Read & assert localStorage[key]. Pass at least one of exists/contains/equals. |
| `assert_attribute` | `{selector, name, equals}` | Read element attribute and assert exact match. E.g. `type=password`. |
| `assert_disabled` | selector | Pass when element is disabled. |
| `assert_enabled` | selector | Pass when element is enabled. |

## Last-resort escape hatch

| Verb | Args | Notes |
|------|------|-------|
| `eval_readonly` | `{expression, expect_truthy?, contains?}` | Evaluates a single read-only JS expression. Schema **rejects** assignments, function declarations, `await`, `new`, `.click(`, `.setAttribute(`, `.dispatchEvent(`, `.innerHTML=`, `document.write`. Use for things like reading `localStorage` to verify persistence. Max 400 chars. |

## What you should NOT do

- ❌ Inline JS (`page.locator(...).click()`-style strings) — there is no `eval` verb.
- ❌ Multi-key step entries (`{click: ..., screenshot: ...}` is invalid).
- ❌ Selectors based on Tailwind classes like `.text-\\[11px\\]` — they break on a font tweak. Add a `data-testid` to the source instead.
- ❌ Hard-coded passwords. Use `${env.QA_SSH_PASSWORD}` (set externally).
- ❌ Skipping `fixtures: [reset_db]` for any case that mutates persistent state.
