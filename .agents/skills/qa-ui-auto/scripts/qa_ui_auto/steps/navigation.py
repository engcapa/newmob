"""Navigation, waiting, and screenshots."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import StepContext, StepError, verb


def _coerce_seconds(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("ms"):
            return float(s[:-2]) / 1000.0
        if s.endswith("s"):
            s = s[:-1]
        return float(s)
    raise StepError(f"wait/sleep arg must be a number of seconds, got {value!r}")


@verb("open")
def step_open(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        url = args["url"]
    else:
        url = str(args)
    if ctx.dry_run:
        return
    ctx.page.goto(url, wait_until="domcontentloaded")


@verb("goto")
def step_goto(ctx: StepContext, args: Any) -> None:
    step_open(ctx, args)


@verb("wait")
def step_wait(ctx: StepContext, args: Any) -> None:
    seconds = _coerce_seconds(args)
    if ctx.dry_run:
        return
    ctx.page.wait_for_timeout(int(seconds * 1000))  # type: ignore[attr-defined]


@verb("wait_for")
def step_wait_for(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        selector = args["selector"]
        timeout = float(args.get("timeout_sec", 15)) * 1000.0
        state = args.get("state", "visible")
    else:
        selector = str(args)
        timeout = 15_000.0
        state = "visible"
    if ctx.dry_run:
        ctx.page.locator(selector)  # noqa: B018  syntax check only
        return
    ctx.page.wait_for_selector(selector, timeout=timeout, state=state)


@verb("screenshot")
def step_screenshot(ctx: StepContext, args: Any) -> None:
    if isinstance(args, dict):
        path = args["path"]
        selector = args.get("selector")
        full_page = bool(args.get("full_page", False))
    else:
        path = str(args)
        selector = None
        full_page = False
    target = ctx.case_dir / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if ctx.dry_run:
        target.write_bytes(b"")
        return
    if selector:
        loc = ctx.page.locator(selector)
        loc.first.screenshot(path=str(target))  # type: ignore[attr-defined]
    else:
        ctx.page.screenshot(path=str(target), full_page=full_page)
