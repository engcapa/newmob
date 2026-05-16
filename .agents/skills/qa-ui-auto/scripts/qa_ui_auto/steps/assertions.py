"""Assertions and the controlled `eval_readonly` escape hatch."""

from __future__ import annotations

import re
from typing import Any

from . import StepContext, StepError, verb

# Patterns also enforced by JSON Schema; redundant defense-in-depth here so a
# bad case still fails fast even if schema is bypassed.
_FORBIDDEN_EVAL_PATTERNS = [
    re.compile(r"[^=!<>]=[^=]"),
    re.compile(r"\+=|-=|\*=|/="),
    re.compile(r"\bawait\b"),
    re.compile(r"\bfunction\b"),
    re.compile(r"\bnew\b"),
    re.compile(r"\.click\("),
    re.compile(r"\.setAttribute\("),
    re.compile(r"\.removeAttribute\("),
    re.compile(r"\.dispatchEvent\("),
    re.compile(r"\.innerHTML\s*="),
    re.compile(r"\bdocument\.write"),
]


def _wait_for_match(ctx: StepContext, predicate, timeout: float, fail: str) -> None:
    deadline_ms = int(timeout * 1000)
    page = ctx.page
    page.wait_for_function(  # type: ignore[attr-defined]
        "() => true", timeout=100,
    ) if False else None  # noqa: F841 (keep import surface aligned)
    # Use polling expect via a manual loop; keeps logic explicit.
    import time
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            if predicate():
                return
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(0.25)
    if last_err:
        raise StepError(f"{fail}: {last_err}")
    raise StepError(fail)


@verb("assert_visible")
def step_assert_visible(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    try:
        loc.wait_for(state="visible", timeout=15_000)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"not visible: {selector} ({e})") from e


@verb("assert_not_visible")
def step_assert_not_visible(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    try:
        loc.wait_for(state="hidden", timeout=15_000)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"still visible: {selector} ({e})") from e


@verb("assert_text")
def step_assert_text(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("assert_text: expected {selector, contains, timeout_sec?}")
    selector = args["selector"]
    expected = args["contains"]
    timeout = float(args.get("timeout_sec", 10))
    if ctx.dry_run:
        return

    def _check() -> bool:
        loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
        text = ""
        try:
            text = loc.text_content() or ""
        except Exception:
            text = ""
        if expected in text:
            return True
        # Special case: terminal-pane keeps a synced data-terminal-text attribute
        # because xterm.js uses canvas and innerText is empty.
        try:
            attr = loc.get_attribute("data-terminal-text") or ""
            if expected in attr:
                return True
        except Exception:
            pass
        return False

    _wait_for_match(ctx, _check, timeout, fail=f"{selector} text does not contain {expected!r}")


@verb("assert_pattern")
def step_assert_pattern(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("assert_pattern: expected {selector, regex, timeout_sec?}")
    selector = args["selector"]
    pattern = re.compile(args["regex"])
    timeout = float(args.get("timeout_sec", 10))
    if ctx.dry_run:
        return

    def _check() -> bool:
        loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
        text = ""
        try:
            text = loc.text_content() or ""
        except Exception:
            return False
        return bool(pattern.search(text))

    _wait_for_match(ctx, _check, timeout, fail=f"{selector} text does not match {args['regex']!r}")


@verb("assert_count")
def step_assert_count(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("assert_count: expected {selector, min/max/equal}")
    selector = args["selector"]
    if ctx.dry_run:
        return
    count = ctx.page.locator(selector).count()  # type: ignore[attr-defined]
    if "equal" in args and count != int(args["equal"]):
        raise StepError(f"{selector}: expected exactly {args['equal']}, got {count}")
    if "min" in args and count < int(args["min"]):
        raise StepError(f"{selector}: expected ≥{args['min']}, got {count}")
    if "max" in args and count > int(args["max"]):
        raise StepError(f"{selector}: expected ≤{args['max']}, got {count}")


@verb("assert_url")
def step_assert_url(ctx: StepContext, args: Any) -> None:
    expected = str(args)
    if ctx.dry_run:
        return
    actual = ctx.page.url  # type: ignore[attr-defined]
    if expected not in actual:
        raise StepError(f"URL {actual!r} does not contain {expected!r}")


@verb("eval_readonly")
def step_eval_readonly(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("eval_readonly: expected {expression, ...}")
    expr = args["expression"]
    for pat in _FORBIDDEN_EVAL_PATTERNS:
        if pat.search(expr):
            raise StepError(f"eval_readonly: forbidden pattern {pat.pattern!r} in expression")
    if ctx.dry_run:
        return
    result = ctx.page.evaluate(f"() => ({expr})")  # type: ignore[attr-defined]
    if args.get("expect_truthy", True) and not result:
        raise StepError(f"eval_readonly: expression {expr!r} returned falsy: {result!r}")
    if "contains" in args and args["contains"] not in str(result):
        raise StepError(f"eval_readonly: result {result!r} does not contain {args['contains']!r}")
