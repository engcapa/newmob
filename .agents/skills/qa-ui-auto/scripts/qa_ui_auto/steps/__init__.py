"""Step library — each verb is a function that mutates page state or asserts.

Verbs are registered via @verb(name). The runner imports this package, which
populates REGISTRY by importing every submodule with side effects.

Each verb has the signature:

    def verb(ctx: StepContext, args) -> None

`ctx` carries the Playwright `page`, the report directory for screenshots,
the resolved config dict, and a logger. Verbs raise StepError on failure;
the runner converts that to a structured failure entry in summary.json.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol


class PageLike(Protocol):
    """Subset of playwright.sync_api.Page we touch (kept narrow for type-hint
    independence — the runtime always supplies the real Page).
    """
    def goto(self, url: str, **kwargs: Any) -> Any: ...
    def screenshot(self, **kwargs: Any) -> bytes: ...
    def locator(self, selector: str) -> Any: ...
    def wait_for_selector(self, selector: str, **kwargs: Any) -> Any: ...
    def evaluate(self, expression: str, *args: Any) -> Any: ...
    def keyboard(self) -> Any: ...
    def mouse(self) -> Any: ...


@dataclass
class StepContext:
    page: PageLike
    case_id: str
    case_dir: Path
    cfg: dict[str, Any]
    env: dict[str, str]
    case_state: dict[str, Any] = field(default_factory=dict)
    step_index: int = 0
    dry_run: bool = False


class StepError(RuntimeError):
    """Raised by verbs to signal a failed assertion or interaction."""


VerbFn = Callable[[StepContext, Any], None]
REGISTRY: dict[str, VerbFn] = {}


def verb(name: str) -> Callable[[VerbFn], VerbFn]:
    def deco(fn: VerbFn) -> VerbFn:
        if name in REGISTRY:
            raise RuntimeError(f"verb {name!r} already registered")
        REGISTRY[name] = fn
        return fn
    return deco


def get(name: str) -> VerbFn:
    if name not in REGISTRY:
        raise StepError(f"unknown verb: {name}")
    return REGISTRY[name]


# Eagerly import submodules so registry is populated.
from . import navigation  # noqa: E402,F401
from . import mouse        # noqa: E402,F401
from . import keyboard     # noqa: E402,F401
from . import assertions   # noqa: E402,F401
from . import app_specific # noqa: E402,F401
