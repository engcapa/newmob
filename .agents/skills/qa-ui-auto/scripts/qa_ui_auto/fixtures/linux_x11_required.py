"""Require the real Linux X11 stack used by native clipboard and IME gates."""

from __future__ import annotations

import os
import platform
import shutil
from typing import Any


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise FixtureSkip("requires a Linux X11 display")
    missing = [
        command
        for command in ("xprop", "wmctrl", "fcitx5-remote")
        if shutil.which(command) is None
    ]
    if missing:
        raise FixtureSkip(
            "Linux X11 native tools missing: "
            + ", ".join(missing)
            + "; clipboard/IME evidence is unavailable on this host"
        )
