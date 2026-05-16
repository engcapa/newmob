"""Keyboard input: fill, type, send_keys, press, select_option, upload_file."""

from __future__ import annotations

from typing import Any

from . import StepContext, StepError, verb


@verb("fill")
def step_fill(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("fill: expected {selector, value}")
    selector = args["selector"]
    value = args["value"]
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.fill(value)


@verb("type")
def step_type(ctx: StepContext, args: Any) -> None:
    text = str(args)
    if ctx.dry_run:
        return
    ctx.page.keyboard.type(text)  # type: ignore[attr-defined]


@verb("send_keys")
def step_send_keys(ctx: StepContext, args: Any) -> None:
    text = str(args)
    if ctx.dry_run:
        return
    ctx.page.keyboard.type(text)  # type: ignore[attr-defined]


@verb("press")
def step_press(ctx: StepContext, args: Any) -> None:
    if isinstance(args, str):
        key, selector = args, None
    elif isinstance(args, dict):
        key = args["key"]
        selector = args.get("selector")
    else:
        raise StepError("press: expected string or {key, selector?}")
    if ctx.dry_run:
        return
    if selector:
        ctx.page.locator(selector).first.press(key)  # type: ignore[attr-defined]
    else:
        ctx.page.keyboard.press(key)  # type: ignore[attr-defined]


@verb("select_option")
def step_select_option(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("select_option: expected {selector, label?, value?}")
    sel = args["selector"]
    target: dict[str, Any] = {}
    if "label" in args:
        target["label"] = args["label"]
    if "value" in args:
        target["value"] = args["value"]
    if not target:
        raise StepError("select_option: provide label or value")
    if ctx.dry_run:
        return
    ctx.page.locator(sel).first.select_option(**target)  # type: ignore[attr-defined]


@verb("upload_file")
def step_upload_file(ctx: StepContext, args: Any) -> None:
    if not isinstance(args, dict):
        raise StepError("upload_file: expected {selector, path}")
    selector = args["selector"]
    path = args["path"]
    if ctx.dry_run:
        return
    ctx.page.locator(selector).first.set_input_files(path)  # type: ignore[attr-defined]
