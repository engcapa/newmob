"""Reset Taomni persistent state per case.

Browser mode: clear localStorage keys (taomni.sessions.v1, taomni.groups.v1,
taomni.tunnels.v1, taomni.appTheme.v1, taomni.terminalProfile.v1, taomni.compactMode,
taomni.sftp.*).

Native mode: delete the SQLite DB at <app_data_dir>/taomni.db. The path is
computed from the bundle identifier 'com.taomni.app' which is stable in
src-tauri/tauri.conf.json. Each worker uses XDG_DATA_HOME=<run>/data-w<N>
so per-worker isolation is automatic.
"""

from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path
from typing import Any

BUNDLE_ID = "com.taomni.app"

LOCAL_STORAGE_KEYS = [
    "taomni.welcome.directoryUsage.v1",
    "taomni.welcome.sessionResume.v1",
    "taomni.welcome.sessionResumeRevision.v1",
    "taomni.welcome.sessionResumeSequence.v1",
    "taomni.welcome.sessionResumeCleared.v1",
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


def _native_app_data_dir() -> Path:
    system = platform.system()
    if system == "Windows":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / BUNDLE_ID
        return Path.home() / "AppData" / "Roaming" / BUNDLE_ID
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / BUNDLE_ID
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / BUNDLE_ID


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
    data_dir = _native_app_data_dir()
    db = data_dir / "taomni.db"
    for path in (db, data_dir / "taomni.db-wal", data_dir / "taomni.db-shm", data_dir / "sdk.json"):
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
    # If the worker uses a private data dir, prefer wiping the whole tree.
    custom = os.environ.get("NEWMOB_DATA_DIR")
    if custom:
        try:
            shutil.rmtree(custom, ignore_errors=True)
        except OSError:
            pass
