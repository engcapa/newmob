"""Welcome recents + run-snapshot restore browser fixture (design
docs-feature/welcome-recents-session-restore-design.md §7.2).

Seeds browser-context localStorage ONLY (never native app-data) so the four
TC-WELCOME-RS-* cases exercise the Welcome restore entry against the stub
backend. Data is selected per case id; nothing is seeded for
TC-WELCOME-RS-04 (it builds its own state through the UI and ends by
clearing the record).

Seeded keys (also owned by reset_db cleanup):
- taomni.welcome.directoryUsage.v1
- taomni.welcome.sessionResume.v1
- taomni.sessions.v1 (only when a case needs a saved session seed)
"""

from __future__ import annotations

import json
from typing import Any

DIRECTORY_USAGE_KEY = "taomni.welcome.directoryUsage.v1"
SESSION_RESUME_KEY = "taomni.welcome.sessionResume.v1"
SESSIONS_KEY = "taomni.sessions.v1"

VFS_HOME = "/preview"


def _dir_usage_payload(case_id: str) -> dict[str, Any] | None:
    """Per-case directoryUsage seed; None means "do not seed"."""
    if case_id.startswith("TC-WELCOME-RS-01"):
        return {
            "revision": 4,
            "entries": {
                VFS_HOME: {
                    "directoryId": "stub:home",
                    "lastUsedAtMs": 2000,
                    "timeSource": "local-start",
                    "legacyRank": None,
                    "availability": "available",
                },
                f"{VFS_HOME}/A": {
                    "directoryId": "stub:a",
                    "lastUsedAtMs": 3000,
                    "timeSource": "local-start",
                    "legacyRank": None,
                    "availability": "available",
                },
                f"{VFS_HOME}/Downloads": {
                    "directoryId": "stub:dl",
                    "lastUsedAtMs": 1000,
                    "timeSource": "local-cwd",
                    "legacyRank": None,
                    "availability": "available",
                },
                f"{VFS_HOME}/Legacy": {
                    "directoryId": "stub:legacy",
                    "lastUsedAtMs": None,
                    "timeSource": None,
                    "legacyRank": 1,
                    "availability": "available",
                },
            },
            "fixtureDirectories": [
                {"label": "Downloads", "path": f"{VFS_HOME}/Downloads", "kind": "personal"},
                {"label": "A", "path": f"{VFS_HOME}/A", "kind": "personal"},
                {"label": "Legacy", "path": f"{VFS_HOME}/Legacy", "kind": "personal", "legacyRank": 1},
            ],
        }
    return None


def _session_seed(case_id: str) -> list[dict[str, Any]] | None:
    if case_id.startswith("TC-WELCOME-RS-02"):
        return [
            {
                "id": "sess-file-vfs",
                "name": "VFS folder",
                "session_type": "File",
                "group_path": None,
                "host": VFS_HOME,
                "port": 0,
                "username": None,
                "auth_method": "None",
                "options_json": "{}",
                "created_at": 1000,
                "updated_at": 1000,
                "last_connected_at": 2000,
                "sort_order": 0,
            }
        ]
    if case_id.startswith("TC-WELCOME-RS-03"):
        return [
            {
                "id": "sess-local-shell",
                "name": "qa-local-shell",
                "session_type": "LocalShell",
                "group_path": None,
                "host": "",
                "port": 0,
                "username": None,
                "auth_method": "None",
                "options_json": "{}",
                "created_at": 1000,
                "updated_at": 1000,
                "last_connected_at": 3000,
                "sort_order": 0,
            }
        ]
    return None


def _snapshot_seed(case_id: str) -> dict[str, Any] | None:
    if case_id.startswith("TC-WELCOME-RS-02"):
        return {
            "schemaVersion": 1,
            "revision": 2,
            "runSequence": 1,
            "batchId": "fixture-batch-2",
            "committedAtMs": 4000,
            "entries": [
                {
                    "kind": "saved-session",
                    "identity": "saved:sess-file-vfs",
                    "savedSessionId": "sess-file-vfs",
                    "savedSessionType": "File",
                    "displayName": "VFS folder",
                }
            ],
            "activeIdentity": "saved:sess-file-vfs",
        }
    if case_id.startswith("TC-WELCOME-RS-03"):
        return {
            "schemaVersion": 1,
            "revision": 3,
            "runSequence": 2,
            "batchId": "fixture-batch-3",
            "committedAtMs": 5000,
            "entries": [
                {
                    "kind": "saved-session",
                    "identity": "saved:sess-local-shell",
                    "savedSessionId": "sess-local-shell",
                    "savedSessionType": "LocalShell",
                    "displayName": "qa-local-shell",
                }
            ],
            "activeIdentity": "saved:sess-local-shell",
        }
    return None


def setup(ctx: Any) -> None:
    page = getattr(ctx, "page", None)
    if page is None:
        raise RuntimeError("welcome_recents fixture requires browser mode (ctx.page)")

    case_id = getattr(ctx, "case_id", "") or ""
    directory_usage = _dir_usage_payload(case_id)
    sessions = _session_seed(case_id)
    snapshot = _snapshot_seed(case_id)
    if directory_usage is None and sessions is None and snapshot is None:
        return  # e.g. RS-04 builds its own state through the UI

    payload = {
        "directoryUsage": directory_usage,
        "sessions": sessions,
        "sessionResume": snapshot,
    }
    script = (
        "const seed = " + json.dumps(payload) + ";"
        "try { if (seed.directoryUsage) localStorage.setItem("
        "'" + DIRECTORY_USAGE_KEY + "', JSON.stringify(seed.directoryUsage)); } catch (_) {}"
        "try { if (seed.sessions) localStorage.setItem("
        "'" + SESSIONS_KEY + "', JSON.stringify(seed.sessions)); } catch (_) {}"
        "try { if (seed.sessionResume) localStorage.setItem("
        "'" + SESSION_RESUME_KEY + "', JSON.stringify(seed.sessionResume)); } catch (_) {}"
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
    # reset_db owns cleanup; nothing extra to do.
    return None
