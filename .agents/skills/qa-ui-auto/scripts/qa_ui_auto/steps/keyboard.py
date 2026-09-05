"""Keyboard input: fill, type, composition, press, select_option, upload_file."""

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


@verb("compose_text")
def step_compose_text(ctx: StepContext, args: Any) -> None:
    """Drive one browser composition lifecycle through the focused control.

    This is browser interaction evidence only. It deliberately does not claim
    an OS input method or satisfy native IME evidence.
    """
    if not isinstance(args, dict):
        raise StepError("compose_text: expected {selector, text, during_key?}")
    selector = args["selector"]
    text = args["text"]
    during_key = args.get("during_key")
    if not isinstance(text, str) or not text:
        raise StepError("compose_text: text must be a non-empty string")
    loc = ctx.page.locator(selector).first  # type: ignore[attr-defined]
    if ctx.dry_run:
        return
    loc.focus()
    session = ctx.page.context.new_cdp_session(ctx.page)  # type: ignore[attr-defined]
    try:
        session.send("Input.imeSetComposition", {
            "text": text,
            "selectionStart": len(text),
            "selectionEnd": len(text),
        })
        if during_key:
            ctx.page.keyboard.press(during_key)  # type: ignore[attr-defined]
        session.send("Input.insertText", {"text": text})
    finally:
        session.detach()


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
