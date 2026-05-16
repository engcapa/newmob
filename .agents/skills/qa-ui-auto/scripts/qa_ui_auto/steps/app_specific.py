"""High-level NewMob-specific verbs that bundle common UI flows.

These exist so testcases stay short and selector knowledge is centralised
here. When the UI changes, edit these helpers — not 60 testcases.
"""

from __future__ import annotations

import re
from typing import Any

from . import StepContext, StepError, verb
from .mouse import step_click
from .keyboard import step_fill


_SSH_URL_RE = re.compile(
    r"^(?P<scheme>ssh|sftp)://(?P<user>[^@]+)@(?P<host>[^:/]+)(?::(?P<port>\d+))?/?$",
    re.IGNORECASE,
)


@verb("quick_connect")
def step_quick_connect(ctx: StepContext, args: Any) -> None:
    """Type into the QuickConnect bar and submit. Mirrors what TC-006 hand-built."""
    if not isinstance(args, dict) or "url" not in args:
        raise StepError("quick_connect: expected {url}")
    url = args["url"]
    if not _SSH_URL_RE.match(url):
        raise StepError(f"quick_connect: url {url!r} is not ssh://user@host[:port]")
    if ctx.dry_run:
        return
    page = ctx.page
    page.locator('[data-testid="qc-input"]').first.fill(url)  # type: ignore[attr-defined]
    page.locator('[data-testid="qc-submit"]').first.click()   # type: ignore[attr-defined]


@verb("auth")
def step_auth(ctx: StepContext, args: Any) -> None:
    """Wait for the auth prompt then submit a password.

    Args may be a plain string (the password) or {password: ...}. Empty/whitespace
    passwords cause the submit button to stay disabled, so we surface that rather
    than silently typing nothing.
    """
    if isinstance(args, str):
        password = args
    elif isinstance(args, dict):
        password = args.get("password", "")
    else:
        raise StepError("auth: expected string or {password}")
    if not password or not password.strip():
        raise StepError("auth: empty password (set QA_SSH_PASSWORD env var)")
    if ctx.dry_run:
        return
    page = ctx.page
    page.wait_for_selector('[data-testid="auth-prompt"]', timeout=15_000)  # type: ignore[attr-defined]
    page.locator('[data-testid="auth-password"]').first.fill(password)      # type: ignore[attr-defined]
    page.locator('[data-testid="auth-submit"]').first.click()              # type: ignore[attr-defined]


@verb("attach_sftp")
def step_attach_sftp(ctx: StepContext, args: Any) -> None:
    """Click the attached-SFTP toggle in the active SSH terminal."""
    if ctx.dry_run:
        return
    page = ctx.page
    page.locator('[data-testid="attached-sftp-toggle"]').first.click()  # type: ignore[attr-defined]
    page.wait_for_selector('[data-testid="sftp-browser"]', timeout=15_000)  # type: ignore[attr-defined]


@verb("set_remote_path")
def step_set_remote_path(ctx: StepContext, args: Any) -> None:
    path = str(args)
    if ctx.dry_run:
        return
    page = ctx.page
    inp = page.locator('[data-testid="sftp-remote-path"]').first  # type: ignore[attr-defined]
    inp.click()
    inp.fill(path)
    inp.press("Enter")


@verb("seed_clipboard")
def step_seed_clipboard(ctx: StepContext, args: Any) -> None:
    """Set the OS clipboard via the page (used for paste-flow tests).

    This is a write to clipboard, but it's intentional: a controlled fixture
    rather than arbitrary JS. Hence implemented in app_specific (allowed) and
    not in eval_readonly (forbidden writes).
    """
    text = str(args)
    if ctx.dry_run:
        return
    ctx.page.evaluate("(t) => navigator.clipboard.writeText(t)", text)  # type: ignore[attr-defined]


@verb("open_session")
def step_open_session(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("open_session: expected {name, double_click?}")
    name = args["name"]
    double = bool(args.get("double_click", True))
    if ctx.dry_run:
        return
    page = ctx.page
    selector = f'[data-testid="session-tree-item"][data-session-name="{name}"]'
    page.wait_for_selector(selector, timeout=15_000)  # type: ignore[attr-defined]
    loc = page.locator(selector).first  # type: ignore[attr-defined]
    if double:
        loc.dblclick()
    else:
        loc.click()


@verb("assert_menu_items")
def step_assert_menu_items(ctx: StepContext, args: Any) -> None:
    """Within the open context menu, assert each label is visible.

    Used after `right_click`. Expects [data-testid='context-menu'] to be open.
    """
    if not isinstance(args, list):
        raise StepError("assert_menu_items: expected list of labels")
    if ctx.dry_run:
        return
    page = ctx.page
    page.wait_for_selector('[data-testid="context-menu"]', timeout=10_000)  # type: ignore[attr-defined]
    menu = page.locator('[data-testid="context-menu"]')  # type: ignore[attr-defined]
    for label in args:
        loc = menu.get_by_text(label, exact=False).first
        try:
            loc.wait_for(state="visible", timeout=5_000)
        except Exception as e:  # noqa: BLE001
            raise StepError(f"context menu missing item {label!r}: {e}") from e


@verb("click_menu")
def step_click_menu(ctx: StepContext, args: Any) -> None:
    """Click a context menu item by visible label."""
    if isinstance(args, str):
        label = args
    elif isinstance(args, dict):
        label = args["label"]
    else:
        raise StepError("click_menu: expected string label or {label}")
    if ctx.dry_run:
        return
    page = ctx.page
    page.wait_for_selector('[data-testid="context-menu"]', timeout=10_000)  # type: ignore[attr-defined]
    menu = page.locator('[data-testid="context-menu"]')  # type: ignore[attr-defined]
    menu.get_by_text(label, exact=False).first.click()


@verb("seed_dialog")
def step_seed_dialog(ctx: StepContext, args: Any) -> None:
    """Pre-arm window.prompt and window.confirm for the next interaction.

    Many SFTP flows (new file, new folder, rename) call window.prompt() once.
    Args:
      {prompt: "filename.txt"}            — window.prompt returns "filename.txt" once, then ""
      {prompt: ["a.txt","b.txt"]}         — sequence consumed call-by-call, exhausted -> ""
      {confirm: true|false}               — window.confirm returns this for any call
      {prompt: ..., confirm: ...}         — both at once

    Defaults: confirm true if not specified, prompt empty if not specified.
    """
    if not isinstance(args, dict):
        raise StepError("seed_dialog: expected mapping with prompt and/or confirm")
    prompt_raw = args.get("prompt", "")
    if isinstance(prompt_raw, list):
        prompts = [str(p) for p in prompt_raw]
    else:
        prompts = [str(prompt_raw)]
    confirm = bool(args.get("confirm", True))
    if ctx.dry_run:
        return
    import json as _json
    script = (
        "(seed) => {"
        "  let i = 0;"
        "  window.prompt = () => (i < seed.prompts.length ? seed.prompts[i++] : '');"
        "  window.confirm = () => seed.confirm;"
        "  return true;"
        "}"
    )
    ctx.page.evaluate(script, {"prompts": prompts, "confirm": confirm})  # type: ignore[attr-defined]


@verb("reload")
def step_reload(ctx: StepContext, args: Any) -> None:  # noqa: ARG001
    if ctx.dry_run:
        return
    ctx.page.reload(wait_until="domcontentloaded")  # type: ignore[attr-defined]


@verb("assert_localstorage")
def step_assert_localstorage(ctx: StepContext, args: Any) -> None:
    """Assert localStorage[key] satisfies a constraint.

    Args: {key, exists?: bool, contains?: str, equals?: str}
    """
    if not isinstance(args, dict) or "key" not in args:
        raise StepError("assert_localstorage: expected {key, exists?/contains?/equals?}")
    key = args["key"]
    if ctx.dry_run:
        return
    value = ctx.page.evaluate(  # type: ignore[attr-defined]
        "(k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }",
        key,
    )
    if "exists" in args:
        want = bool(args["exists"])
        got = value is not None
        if want != got:
            raise StepError(
                f"localStorage[{key}] exists={got} but expected exists={want}"
            )
    if "contains" in args:
        if value is None or args["contains"] not in str(value):
            raise StepError(
                f"localStorage[{key}]={value!r} does not contain {args['contains']!r}"
            )
    if "equals" in args:
        if str(value) != str(args["equals"]):
            raise StepError(
                f"localStorage[{key}]={value!r} != {args['equals']!r}"
            )


@verb("assert_attribute")
def step_assert_attribute(ctx: StepContext, args: Any) -> None:
    """Assert an element attribute equals a value.

    Args: {selector, name, equals}.
    """
    if not isinstance(args, dict):
        raise StepError("assert_attribute: expected {selector, name, equals}")
    selector = args["selector"]
    name = args["name"]
    expected = args["equals"]
    if ctx.dry_run:
        return
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    actual = loc.get_attribute(name)
    if str(actual) != str(expected):
        raise StepError(
            f"{selector}[{name}]={actual!r} != {expected!r}"
        )


@verb("assert_disabled")
def step_assert_disabled(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    if ctx.dry_run:
        return
    if not ctx.page.locator(selector).first.is_disabled():  # type: ignore[attr-defined]
        raise StepError(f"{selector} is not disabled")


@verb("assert_enabled")
def step_assert_enabled(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    if ctx.dry_run:
        return
    if not ctx.page.locator(selector).first.is_enabled():  # type: ignore[attr-defined]
        raise StepError(f"{selector} is not enabled")


@verb("set_check")
def step_set_check(ctx: StepContext, args: Any) -> None:
    """Idempotently set a checkbox to a desired state.

    Args: {selector, checked: bool}. Useful for the 'Specify username' switch
    in the session editor where multiple cases need it on.
    """
    if not isinstance(args, dict):
        raise StepError("set_check: expected {selector, checked}")
    selector = args["selector"]
    desired = bool(args["checked"])
    if ctx.dry_run:
        return
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    current = loc.is_checked()
    if current != desired:
        loc.click(force=True)


@verb("send_text_via_label")
def step_send_text_via_label(ctx: StepContext, args: Any) -> None:
    """Set a checkbox by its parent label's text content.

    Args: {label_contains, checked: bool}. Used when there's no testid on a
    label-wrapped checkbox.
    """
    if not isinstance(args, dict):
        raise StepError("send_text_via_label: expected {label_contains, checked}")
    label_text = args["label_contains"]
    desired = bool(args["checked"])
    if ctx.dry_run:
        return
    page = ctx.page
    label = page.locator(f"label:has-text({label_text!r})").first  # type: ignore[attr-defined]
    cb = label.locator('input[type="checkbox"]').first
    current = cb.is_checked()
    if current != desired:
        cb.click(force=True)
