"""Reset Taomni persistent state per case.

Browser mode: clear localStorage keys (taomni.sessions.v1, taomni.groups.v1,
taomni.tunnels.v1, taomni.appTheme.v1, taomni.terminalProfile.v1, taomni.compactMode,
taomni.sftp.*).

Native mode: clear only the QA application's state under the current run's
verified data/config/cache roots. Never resolve or clear the production profile.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env

LOCAL_STORAGE_KEYS = [
    "taomni.sessions.v1",
    "taomni.groups.v1",
    "taomni.tunnels.v1",
    "taomni.appTheme.v1",
    "taomni.terminalProfile.v1",
    "taomni.compactMode",
    "taomni.stub.sdkRegistry.v1",
]
LOCAL_STORAGE_PREFIXES = [
    "taomni.sftp.",
    "taomni.tab.",
    "taomni.recent.",
]


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode == "browser":
        _reset_browser(ctx)
    else:
        _reset_native(ctx)


def teardown(ctx: Any) -> None:
    # No-op; setup before next case is enough for clean isolation.
    return None


def _reset_browser(ctx: Any) -> None:
    """Wipe localStorage keys we own. Done via a tiny script after navigation,
    so we postpone until the page is loaded — emit a marker and let the runner
    clear at the start of the case (before opening the URL we just clear in
    a post-goto hook). For now, set a per-context init script that wipes on
    every page load.
    """
    page = getattr(ctx, "page", None)
    if page is None:
        return
    keys_payload = LOCAL_STORAGE_KEYS
    prefixes_payload = LOCAL_STORAGE_PREFIXES
    init_script = (
        "const keys = " + repr(keys_payload) + ";"
        "const prefixes = " + repr(prefixes_payload) + ";"
        "try { for (const k of keys) localStorage.removeItem(k); }"
        " catch (_) {} "
        "try { for (let i = localStorage.length - 1; i >= 0; i--) {"
        "  const k = localStorage.key(i);"
        "  if (k && prefixes.some((p) => k.startsWith(p))) {"
        "    localStorage.removeItem(k);"
        "  } } }"
        " catch (_) {} "
    )
    # The page may already have something open; clear immediately too.
    try:
        page.context.add_init_script(init_script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        page.evaluate(init_script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def _reset_native(ctx: Any) -> None:
    report_root = getattr(ctx, "report_root", None)
    if report_root is None:
        raise RuntimeError("reset_db requires a native run directory; refusing profile cleanup")
    expected = native_isolation_env(Path(report_root))
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("reset_db requires the current run's native isolation environment")
    targets = [Path(value) / QA_APP_ID for value in set(expected.values())]
    # Validate every target before deleting any; rmtree does not follow child symlinks.
    if any(target.resolve() != target for target in targets):
        raise RuntimeError("reset_db refuses symlinked QA profile paths")
    for target in targets:
        if target.exists():
            shutil.rmtree(target)
