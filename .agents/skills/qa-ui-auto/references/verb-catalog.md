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
| `native_click` | `{selector}` | Native Linux/X11 only. Activates the exact test executable window and sends W3C pointer actions through its packaged WebKitGTK session; testcase assertions own the postcondition. |
| `native_pointer_drag` | `{selector, from:{line,column}, to:{line,column}, modifiers?}` | Native Linux/X11 only. Resolves CodeMirror line/column positions through read-only DOM geometry, then sends a real modifier-aware W3C pointer drag to the packaged WebKitGTK session. The verb records geometry/transport only; testcase assertions own selection and edit postconditions. |
| `native_set_writable` | `{path, writable}` | Native Linux only. Toggles owner-write permission for a path inside the current retained report root and records mode metadata; used for deterministic real-write failure/recovery evidence. |
| `native_clipboard_owner` | `{action, text?}` | Native Linux/X11 only. Drives an out-of-process X11 CLIPBOARD selection owner. `grant` takes the selection with `text` (postcondition verified by an external read); `deny` replaces it with an owner that advertises standard text targets but rejects their conversion, causing an immediate real OS read failure; `suspend` retains the timeout-based unresponsive-owner fault; `resume` restores the last granted text; `release` terminates it. Teardown always kills the owner and records that the host selection was replaced - it is deliberately not republished, because an X11 selection needs a live owner and faking a restore would leak a process. |

## Keyboard

| Verb | Args | Notes |
|------|------|-------|
| `fill` | `{selector, value}` | Replaces field content. |
| `type` | string | Types into the focused element. Prefer `fill` for inputs. |
| `send_keys` | string | Same as `type`; semantic for terminal-pane interaction. |
| `compose_text` | `{selector, text, during_key?}` | Browser-only composition lifecycle; optionally dispatches one composing key before committing text. Never substitutes for native IME evidence. |
| `native_keys` | `{selector, keys, transport?, focus_prechecked?}` | Requires the selector to own focus. Default `transport: x11` injects XTest keys through Linux/X11 and identifies the Taomni window. `transport: webdriver` uses W3C actions in the platform WebView (Windows/Linux), not OS-level input. Records transport and observed events. `focus_prechecked: true` is limited to a testcase that asserted focus immediately before a driver fault; it omits WebDriver probes/event collection and records that limitation. Testcase assertions own the postcondition. |
| `native_ime_keys` | `{selector, expected_engine, keys}` | Native Linux/X11 only. Injects physical XTest keys through the named configured fcitx5 engine and records an observation artifact; testcase assertions must verify the committed result. |
| `native_editor_performance` | `{selector, keys, max_p95_ms}` | Native packaged app only. Injects at least five ASCII keys through W3C WebDriver actions and records keydown-to-CodeMirror-DOM-mutation latency. The artifact also records the next animation frame as a diagnostic, but does not gate on it because a frame requested from CodeMirror's mutation observer is one frame later than the paint containing that mutation. Writes `native-editor-performance.json` and fails when p95 exceeds the supplied budget. |
| `press` | key string **or** `{key, selector?}` | E.g. `Enter`, `Control+Shift+F`. |
| `select_option` | `{selector, label?, value?}` | At least one of label/value. |
| `upload_file` | `{selector, path}` | Hooks into a file input. |

## Assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_visible` | selector | Up to 15s wait. |
| `assert_not_visible` | selector | Up to 15s wait for hidden. |
| `assert_text` | `{selector, contains, timeout_sec?}` | Polls `text_content` and `data-terminal-text` (xterm canvas fallback). |
| `assert_pattern` | `{selector, regex, timeout_sec?}` | Browser and native; polls Python regex against element text (terminal buffer fallback for `terminal-pane`). Use anchored output assertions to distinguish shell output from command echo, and await shell readiness before typing. |
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

## Native filesystem assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_file_contains` | `{path, contains, timeout_sec?}` | Native-only host re-read asserting decoded UTF-8 text contains a marker. |
| `assert_file_exists` | path string **or** `{path, timeout_sec?}` | Native-only host filesystem existence check. |
| `assert_file_receipt` | `{path, selector, encoding, bom, eol, expected_text, require_history?, timeout_sec?}` | Native-only: independently reads and hashes host bytes, validates encoding/BOM/EOL, then reconciles the result with the production receipt observation. |
| `assert_file_sha256` | `{path, equals, timeout_sec?}` | Native-only: independently reads host bytes and requires an exact lowercase SHA-256 digest. |
| `assert_native_process_delta` | `{pattern, baseline, max_delta, timeout_sec?}` | Native Linux only. Counts `/proc/*/cmdline` entries containing `pattern`, writes `native-process-observation.json`, and requires the count increase from `baseline` to remain within `0..max_delta`. |
| `assert_system_clipboard` | `{equals \| contains \| readable, timeout_sec?}` | Native Linux/X11 only: reads the real CLIPBOARD selection from a separate process, never from the app's DOM or in-process state. The only step that can prove a copy actually crossed the OS boundary. An unresponsive owner is reported as unreadable, never as an empty string. Exactly one assertion key. |

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
