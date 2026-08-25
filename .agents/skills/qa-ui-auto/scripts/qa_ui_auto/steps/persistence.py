"""Persistence-seeding verbs (R9 §8.19.10 native gate support).

Native folder pickers cannot be driven by WebDriver, so native gate cases
enter a workspace by seeding the app's own persisted recents
(`taomni.recentWorkspaces.v1`) and reloading the window — the same state an
end user produces by opening a workspace once. These verbs are controlled
fixtures (like seed_clipboard), not arbitrary JS: eval_readonly stays
read-only.
"""

from __future__ import annotations

import json
from typing import Any

from . import StepContext, StepError, verb


@verb("seed_storage")
def step_seed_storage(ctx: StepContext, args: Any) -> None:
    """Write one localStorage entry: {key, value} where value is JSON text."""
    if not isinstance(args, dict) or "key" not in args or "value" not in args:
        raise StepError("seed_storage: expected {key, value}")
    key = str(args["key"])
    value = str(args["value"])
    try:
        json.loads(value)
    except json.JSONDecodeError as e:
        raise StepError(f"seed_storage: value must be valid JSON ({e})") from e
    if ctx.dry_run:
        return
    ctx.page.evaluate(  # type: ignore[attr-defined]
        "([k, v]) => { window.localStorage.setItem(k, v); }",
        [key, value],
    )


@verb("reload_window")
def step_reload_window(ctx: StepContext, args: Any) -> None:
    """Reload the webview document so store bootstraps re-read storage."""
    _ = args
    if ctx.dry_run:
        return
    # Defer through setTimeout: a synchronous reload inside evaluate would
    # never return (the document tears down mid-call).
    ctx.page.evaluate(  # type: ignore[attr-defined]
        "() => { window.setTimeout(() => window.location.reload(), 0); }"
    )
    try:
        ctx.page.wait_for_selector("[data-testid='welcome-panel']", timeout=30_000)  # type: ignore[attr-defined]
    except Exception as e:  # noqa: BLE001
        raise StepError(f"reload_window: page did not come back up ({e})") from e
