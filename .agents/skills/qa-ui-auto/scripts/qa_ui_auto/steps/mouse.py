"""Mouse interactions: click variants, hover, drag."""

from __future__ import annotations

from typing import Any

from . import StepContext, StepError, verb


def _resolve_click(args: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(args, str):
        return args, {}
    if isinstance(args, dict):
        sel = args["selector"]
        kwargs: dict[str, Any] = {}
        if "modifiers" in args:
            kwargs["modifiers"] = list(args["modifiers"])
        if "force" in args:
            kwargs["force"] = bool(args["force"])
        if "position" in args:
            kwargs["position"] = {"x": args["position"]["x"], "y": args["position"]["y"]}
        return sel, kwargs
    raise StepError(f"click arg must be string or object, got {type(args).__name__}")


@verb("click")
def step_click(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.click(**kwargs)


@verb("dblclick")
def step_dblclick(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.dblclick(**kwargs)


@verb("right_click")
def step_right_click(ctx: StepContext, args: Any) -> None:
    selector, kwargs = _resolve_click(args)
    kwargs["button"] = "right"
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.click(**kwargs)


@verb("hover")
def step_hover(ctx: StepContext, args: Any) -> None:
    selector = args if isinstance(args, str) else args["selector"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.hover()


@verb("drag_to")
def step_drag_to(ctx: StepContext, args: Any) -> None:
    src = ctx.page.locator(args["from"]).first  # type: ignore[attr-defined]
    dst = ctx.page.locator(args["to"]).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    src.drag_to(dst, force=True)
