"""Verb dispatch for native-mode runs (R9 §8.19.10 native gate harness).

Mirrors the browser STEP_REGISTRY semantics on top of the WebDriver subset
implemented in scripts/tauri_webdriver.py. Verbs that cannot be expressed
through WebDriver (or that would lie about what was exercised) raise
StepError instead of silently passing — a native gate must fail loudly.

Native-only verbs:
* assert_file_contains  - host-side disk re-read of a saved workspace file
                          (the G0 disk-effect proof; impossible from browser).
* assert_file_exists    - host-side existence check.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from .steps import StepError


class NativeStepContext:
    """Per-case context handed to native verbs (fixture values resolved)."""

    def __init__(self, session: Any, case_dir: Path, cfg: dict):
        self.session = session
        self.case_dir = case_dir
        self.cfg = cfg


def _screenshot(ctx: NativeStepContext, args: Any) -> str:
    target = args["path"] if isinstance(args, dict) else str(args)
    return ctx.session.screenshot(ctx.case_dir / target)


def _press(ctx: NativeStepContext, args: Any) -> str:
    if isinstance(args, str):
        key, selector = args, None
    elif isinstance(args, dict) and "key" in args:
        key = str(args["key"])
        selector = args.get("selector")
    else:
        raise StepError(f"press: expected string or {{key, selector?}}, got {args!r}")
    if selector:
        ctx.session.click(selector)
    return ctx.session.press_combo(key)


def _wait_for(ctx: NativeStepContext, args: Any) -> str:
    timeout = 10.0
    selectors: list[str]
    if isinstance(args, dict):
        raw = args.get("selector", args.get("text"))
        timeout = float(args.get("timeout_sec", timeout))
    else:
        raw = args
    if raw is None:
        raise StepError(f"wait_for: unsupported args {args!r}")
    selectors = raw if isinstance(raw, list) else [raw]
    last = ""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sel in selectors:
            try:
                ctx.session.find(sel, timeout=0.5)
                return f"found {sel}"
            except Exception as e:  # noqa: BLE001
                last = str(e)
        time.sleep(0.25)
    raise StepError(f"wait_for: none found within {timeout}s ({last})")


def _assert_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.find(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_visible failed: {selector} ({e})") from e
    return f"visible {selector}"


def _assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.wait_absent(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_not_visible failed: {e}") from e
    return f"absent {selector}"


def _selector_args(args: Any) -> tuple[str, float]:
    if isinstance(args, str):
        return args, 10.0
    if isinstance(args, dict) and "selector" in args:
        return str(args["selector"]), float(args.get("timeout_sec", 10))
    raise StepError(f"expected selector string or {{selector, timeout_sec?}}, got {args!r}")


def _assert_text(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "contains" not in args:
        raise StepError(f"assert_text: expected {{selector, contains, timeout_sec?}}")
    selector = str(args["selector"])
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        try:
            text = ctx.session.text(selector)
        except Exception:  # noqa: BLE001
            text = ""
        if expected in text:
            return f"text ok: {selector}"
        time.sleep(0.3)
    raise StepError(
        f"assert_text failed: {selector!r} did not contain {expected!r}; last text={text[:200]!r}"
    )


def _eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "expression" not in args:
        raise StepError("eval_readonly: expected {expression, ...}")
    expr = str(args["expression"])
    result = ctx.session.execute(f"return ({expr});")
    if args.get("expect_truthy", True) and not result:
        raise StepError(f"eval_readonly: expression returned falsy: {result!r}")
    if "contains" in args and args["contains"] not in str(result):
        raise StepError(f"eval_readonly: result {result!r} does not contain {args['contains']!r}")
    return f"eval ok"


def _hover(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    element = ctx.session.find(selector, interactive=True)
    rect = ctx.session.request("GET", ctx.session.element_path(element, "/rect"))
    x = int(rect.get("x", 0) + rect.get("width", 0) / 2)
    y = int(rect.get("y", 0) + rect.get("height", 0) / 2)
    ctx.session.request(
        "POST",
        ctx.session.endpoint("/actions"),
        {
            "actions": [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [{"type": "pointerMove", "duration": 100, "x": x, "y": y,
                                 "origin": "viewport"}],
                }
            ]
        },
    )
    return f"hovered {selector}"


def _select_option(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "value" not in args:
        raise StepError("select_option: expected {selector, value}")
    selector, value = str(args["selector"]), args["value"]
    # Custom (non-<select>) dropdowns are driven by clicking the rendered
    # option element inside the container.
    option_sel = f'{selector} >> role=option[name="{value}"]'
    try:
        ctx.session.click(option_sel)
        return f"selected {value!r} in {selector}"
    except Exception as e:  # noqa: BLE001
        raise StepError(f"select_option: could not click option {value!r} ({e})") from e


def _assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    """Host-side G0 proof: re-read the saved file from the real filesystem."""
    if not isinstance(args, dict) or "path" not in args or "contains" not in args:
        raise StepError("assert_file_contains: expected {path, contains}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 15))
    deadline = time.time() + timeout
    body = ""
    while time.time() < deadline:
        if path.exists():
            body = path.read_text(encoding="utf-8", errors="replace")
            if expected in body:
                return f"disk verified: {path}"
        time.sleep(0.3)
    state = "missing" if not path.exists() else f"len={len(body)}"
    raise StepError(
        f"assert_file_contains failed after {timeout}s: {path} ({state}) "
        f"does not contain {expected!r}"
    )


def _assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    path_str = args["path"] if isinstance(args, dict) else str(args)
    path = Path(path_str).expanduser()
    timeout = float(args.get("timeout_sec", 10)) if isinstance(args, dict) else 10
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            return f"exists {path}"
        time.sleep(0.25)
    raise StepError(f"assert_file_exists failed: {path} not created within {timeout}s")


VERBS: dict[str, Callable[[NativeStepContext], str]] = {}


def _verb(name: str) -> Callable[[Callable[[NativeStepContext, Any], str]], Callable[[NativeStepContext, Any], str]]:
    def deco(fn: Callable[[NativeStepContext, Any], str]) -> Callable[[NativeStepContext, Any], str]:
        VERBS[name] = fn
        return fn

    return deco


@_verb("open")
@_verb("goto")
def _noop_open(ctx: NativeStepContext, args: Any) -> str:
    # tauri-driver launches the binary as part of session creation; there is
    # nothing to navigate in a packaged app window.
    return "no-op (app already launched by driver)"


@_verb("screenshot")
def _do_screenshot(ctx: NativeStepContext, args: Any) -> str:
    return _screenshot(ctx, args)


@_verb("click")
def _do_click(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.click(selector)


@_verb("dblclick")
def _do_dblclick(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.dblclick(selector)


@_verb("fill")
def _do_fill(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "text" not in args:
        raise StepError("fill: expected {selector, text}")
    return ctx.session.fill(str(args["selector"]), str(args["text"]))


@_verb("type")
@_verb("send_keys")
def _do_type(ctx: NativeStepContext, args: Any) -> str:
    return ctx.session.type_text(str(args))


@_verb("press")
def _do_press(ctx: NativeStepContext, args: Any) -> str:
    return _press(ctx, args)


@_verb("wait_for")
def _do_wait_for(ctx: NativeStepContext, args: Any) -> str:
    return _wait_for(ctx, args)


@_verb("wait")
def _do_wait(ctx: NativeStepContext, args: Any) -> str:
    seconds = float(args if isinstance(args, (int, float)) else (args or {}).get("seconds", 1))
    time.sleep(seconds)
    return f"waited {seconds}s"


@_verb("assert_visible")
def _do_assert_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_visible(ctx, args)


@_verb("assert_not_visible")
def _do_assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_not_visible(ctx, args)


@_verb("assert_text")
def _do_assert_text(ctx: NativeStepContext, args: Any) -> str:
    return _assert_text(ctx, args)


@_verb("eval_readonly")
def _do_eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    return _eval_readonly(ctx, args)


@_verb("hover")
def _do_hover(ctx: NativeStepContext, args: Any) -> str:
    return _hover(ctx, args)


@_verb("select_option")
def _do_select_option(ctx: NativeStepContext, args: Any) -> str:
    return _select_option(ctx, args)


@_verb("assert_file_contains")
def _do_assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_contains(ctx, args)


@_verb("assert_file_exists")
def _do_assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_exists(ctx, args)


@_verb("seed_storage")
def _do_seed_storage(ctx: NativeStepContext, args: Any) -> str:
    """Seed one localStorage entry (see steps/persistence.py rationale)."""
    if not isinstance(args, dict) or "key" not in args or "value" not in args:
        raise StepError("seed_storage: expected {key, value}")
    key = str(args["key"])
    value = str(args["value"])
    import json as _json
    try:
        _json.loads(value)
    except ValueError as e:
        raise StepError(f"seed_storage: value must be valid JSON ({e})") from e
    ctx.session.execute(
        f"window.localStorage.setItem({_json.dumps(key)}, {_json.dumps(value)});"
        "return window.localStorage.getItem(" + _json.dumps(key) + ") !== null;"
    )
    return f"seeded {key}"


@_verb("reload_window")
def _do_reload_window(ctx: NativeStepContext, args: Any) -> str:
    """Reload the webview document; wait for the app shell to return."""
    _ = args
    ctx.session.execute(
        "window.setTimeout(() => window.location.reload(), 0); return true;"
    )
    time.sleep(2.0)  # document teardown; execute/sync is unavailable during it
    ctx.session.find("[data-testid='welcome-panel']", timeout=60)
    # The reload dropped the console hook along with the old document.
    ctx.session.install_console_hook()
    return "reloaded; welcome-panel visible"


@_verb("vault_first_run")
def _do_vault_first_run(ctx: NativeStepContext, args: Any) -> str:
    """Complete the empty-vault first-run master-password gate.

    Fresh isolated app-data => vault.db is empty => the app shows the setup
    dialog. Fills both fields with the given QA password and confirms. If a
    LOCKED vault shows the unlock dialog instead, fail loudly: the password
    is unknown and guessing would be dishonest. If the main UI is already
    reachable, this is a no-op.
    """
    password = str(args)
    deadline = time.time() + 20
    while time.time() < deadline:
        if _find_quiet(ctx, "[data-testid='vault-setup-dialog']"):
            break
        if _find_quiet(ctx, "[data-testid='vault-unlock-dialog']"):
            raise StepError(
                "vault_first_run: vault is LOCKED with an unknown master "
                "password; run against a fresh isolated profile"
            )
        if _find_quiet(ctx, "[data-testid='welcome-panel']"):
            return "vault already unlocked; no-op"
        time.sleep(0.5)
    else:
        raise StepError("vault_first_run: neither vault dialog nor welcome-panel appeared")
    ctx.session.fill("[data-testid='vault-setup-pw1']", password)
    ctx.session.fill("[data-testid='vault-setup-pw2']", password)
    ctx.session.click("[data-testid='vault-setup-confirm']")
    ctx.session.wait_absent("[data-testid='vault-setup-dialog']", timeout=30)
    return "vault master password set"


def _find_quiet(ctx: NativeStepContext, selector: str) -> bool:
    try:
        ctx.session.find(selector, timeout=0.5)
        return True
    except Exception:  # noqa: BLE001
        return False


def run_native_step(ctx: NativeStepContext, verb: str, args: Any) -> str:
    fn = VERBS.get(verb)
    if fn is None:
        raise StepError(
            f"native runner does not support verb {verb!r}; supported: {sorted(VERBS)}"
        )
    return fn(ctx, args)
