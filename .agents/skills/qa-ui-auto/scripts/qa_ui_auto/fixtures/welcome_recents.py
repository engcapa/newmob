"""Seed Welcome recents/restore browser state (D-01=B, browser-only).

Browser isolation wipes owned localStorage keys on every page load (see
reset_db's init script), so seeds must also be init scripts registered AFTER
reset_db (fixture order in the case file guarantees wipe-then-seed on every
load, including reloads). Only stub-owned keys are written — never native
app-data:

* `taomni.sessions.v1` — one File session (`file-seed` → /vfs) and one
  LocalShell session (`local-seed`) used by RS-02/RS-03.
* `taomni.welcome.directoryUsage.v1` — fixed A/Home/Downloads recency for
  RS-01 ordering (A=3000, Home=2000, Downloads=1000).
* `taomni.welcome.runSnapshot.v1` — one-entry File snapshot for RS-02.

RS-03 overwrites the snapshot via its own seed step before opening the app;
RS-04 uses only `reset_db` (no seeds at all). Teardown is a no-op; the next
case's `reset_db` clears the keys.
"""

from __future__ import annotations

import json
from typing import Any


SESSIONS_SEED = [
    {
        "id": "file-seed",
        "name": "Seed files",
        "session_type": "File",
        "group_path": None,
        "host": "/preview",
        "port": 0,
        "username": None,
        "auth_method": '"None"',
        "options_json": '{"fileEmbedInTab":true}',
        "created_at": 1700000000,
        "updated_at": 1700000000,
        "last_connected_at": None,
        "sort_order": 0,
    },
    {
        "id": "local-seed",
        "name": "Seed shell",
        "session_type": "LocalShell",
        "group_path": None,
        "host": "",
        "port": 0,
        "username": None,
        "auth_method": '"None"',
        "options_json": "{}",
        "created_at": 1700000000,
        "updated_at": 1700000000,
        "last_connected_at": None,
        "sort_order": 1,
    },
]

DIRECTORY_SEED = [
    {"path": "/preview/seed/A", "label": "A", "kind": "personal", "lastUsedAtMs": 3000},
    {"path": "/preview/seed/Home", "label": "Home", "kind": "system", "lastUsedAtMs": 2000},
    {"path": "/preview/seed/Downloads", "label": "Downloads", "kind": "system", "lastUsedAtMs": 1000},
]

RUN_SNAPSHOT_SEED = {
    "snapshot": {
        "schemaVersion": 2,
        "revision": 1,
        "runId": "stub-run-rs02",
        "createdAtMs": 1700000000000,
        "activeEntryKey": "saved:file-seed",
        "entries": [
            {
                "entryKey": "saved:file-seed",
                "orderIndex": 0,
                "kind": "file-browser",
                "savedSessionId": "file-seed",
                "savedSessionType": "File",
                "displayName": "Seed files",
                "localCwd": None,
                "tempShell": None,
                "profileRef": None,
            }
        ],
    },
    "issue": None,
}


def setup(ctx: Any) -> None:
    page = getattr(ctx, "page", None)
    if page is None:
        return
    case_id = str(getattr(ctx, "case_id", "") or "")
    # RS-03 needs a LocalShell resume (browser has no native PTY, so the
    # real error path is exercised); everything else uses the File snapshot.
    if "RS-03" in case_id:
        snapshot = {
            "snapshot": {
                "schemaVersion": 2,
                "revision": 1,
                "runId": "stub-run-rs03",
                "createdAtMs": 1700000000000,
                "activeEntryKey": "saved:local-seed",
                "entries": [
                    {
                        "entryKey": "saved:local-seed",
                        "orderIndex": 0,
                        "kind": "terminal",
                        "savedSessionId": "local-seed",
                        "savedSessionType": "LocalShell",
                        "displayName": "Seed shell",
                        "localCwd": "/preview/seed/A",
                        "tempShell": None,
                        "profileRef": None,
                    }
                ],
            },
            "issue": None,
        }
    else:
        snapshot = RUN_SNAPSHOT_SEED
    script = (
        "try { localStorage.setItem('taomni.sessions.v1', "
        + json.dumps(json.dumps(SESSIONS_SEED))
        + "); } catch (_) {} "
        "try { localStorage.setItem('taomni.welcome.directoryUsage.v1', "
        + json.dumps(json.dumps(DIRECTORY_SEED))
        + "); } catch (_) {} "
        "try { localStorage.setItem('taomni.welcome.runSnapshot.v1', "
        + json.dumps(json.dumps(snapshot))
        + "); } catch (_) {} "
        "try { localStorage.removeItem('taomni.welcome.runSnapshotCleared.v1'); } catch (_) {} "
    )
    try:
        page.context.add_init_script(script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        page.evaluate(script)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def teardown(ctx: Any) -> None:
    return None
