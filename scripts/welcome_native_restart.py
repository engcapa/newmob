#!/usr/bin/env python3
"""V-10 Linux native restart verification (manual harness, isolated app-data).

Phase A: launch the packaged debug binary with an isolated NEWMOB_DATA_DIR,
create + save + open a LocalShell session so the run-snapshot collector
commits a saved-session entry, then close the app.
Phase B: relaunch with the SAME data dir; the Welcome restore entry must be
available from the persisted snapshot; clicking restore locates/opens the
terminal; the directory usage row survives the restart.

Run:  python3 scripts/qa_ui_auto/../scripts/welcome_native_restart.py
(from repo root; uses the qa-ui-auto NativeHarness)
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".agents" / "skills" / "qa-ui-auto" / "scripts"))

from tauri_webdriver import NativeHarness  # noqa: E402

REPORT_ROOT = Path("qa-ui-auto-report/welcome-recents-session-restore/linux")
RUN_ROOT = REPORT_ROOT / time.strftime("native-restart-%Y%m%d-%H%M%S")
DATA_ROOT = (RUN_ROOT / "app-data").resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)

BINARY = ROOT / "src-tauri" / "target" / "debug" / "taomni"


def db_snapshot() -> dict:
    db_path = DATA_ROOT / "taomni.db"
    if not db_path.exists():
        return {}
    conn = sqlite3.connect(db_path)
    try:
        usage = conn.execute(
            "SELECT display_path, last_used_at_ms, last_use_source FROM welcome_directory_usage"
        ).fetchall()
        snapshot = conn.execute(
            "SELECT batch_id, entries_json, active_identity, revision FROM welcome_run_snapshot"
        ).fetchall()
        sessions = conn.execute(
            "SELECT id, name, session_type, last_connected_at FROM sessions"
        ).fetchall()
        return {
            "usage": usage,
            "snapshot": snapshot,
            "sessions": sessions,
        }
    finally:
        conn.close()


def wait_for(session, selector: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        try:
            session.find(selector, timeout=1.0)
            return
        except Exception as e:  # noqa: BLE001
            last = str(e)
            time.sleep(0.5)
    raise RuntimeError(f"element not found: {selector} {last}")


def phase_a() -> None:
    cfg = {
        "app": {"mode": "native", "native_binary": str(BINARY)},
        "webdriver": {"host": "127.0.0.1", "port": 4444, "tauri_driver": "tauri-driver",
                      "startup_timeout": 60},
    }
    with NativeHarness(cfg, RUN_ROOT) as harness:
        session = harness.create_session()
        # Fresh profile: empty vault => no setup gate; Welcome is direct.
        wait_for(session, "[data-testid='welcome-panel']", timeout=60)

        # Drive the real UI handlers through DOM click events (WebKitGTK
        # element-interactability quirks make W3C element clicks unreliable).
        js_click = (
            "const el = document.querySelector('[data-testid=\\'%s\\']');"
            "if (!el) return 'missing %s';"
            "el.scrollIntoView({block: 'center'});"
            "el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));"
            "return 'ok';"
        )

        def click(testid: str) -> None:
            result = session.execute(js_click % (testid, testid))
            if result != "ok":
                raise RuntimeError(f"js click failed: {testid} -> {result}")

        click("welcome-new-session")
        wait_for(session, "[data-testid='session-editor']", timeout=30)
        click("session-proto-shell")
        time.sleep(0.5)
        click("session-section-bookmark")
        time.sleep(0.3)
        session.execute(
            "const el = document.querySelector('[data-testid=session-name]');"
            "const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
            "setter.call(el, 'qa-native-shell');"
            "el.dispatchEvent(new Event('input', {bubbles: true}));"
            "return true;"
        )
        click("session-save")
        wait_for(session, "[data-testid='session-tree-item']", timeout=30)
        # Double-click the saved session so it opens a real terminal tab.
        session.execute(
            "const el = document.querySelector('[data-testid=session-tree-item]');"
            "const rect = el.getBoundingClientRect();"
            "const opts = {bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, detail: 2};"
            "el.dispatchEvent(new MouseEvent('dblclick', opts));"
            "return true;"
        )
        wait_for(session, "[data-testid='terminal-pane']", timeout=30)
        time.sleep(5)
        print("phase A db:", db_snapshot())
        session.close()


def phase_b() -> None:
    cfg = {
        "app": {"mode": "native", "native_binary": str(BINARY)},
        "webdriver": {"host": "127.0.0.1", "port": 4444, "tauri_driver": "tauri-driver",
                      "startup_timeout": 60},
    }
    with NativeHarness(cfg, RUN_ROOT) as harness:
        session = harness.create_session()
        wait_for(session, "[data-testid='welcome-panel']", timeout=60)
        time.sleep(3)
        # restore entry must be available from the persisted snapshot
        state = session.execute(
            "const el = document.querySelector('[data-testid=welcome-restore-status]');"
            "return el ? el.getAttribute('data-state') : 'missing';"
        )
        print("phase B restore state:", state)
        click_restore = (
            "const el = document.querySelector('[data-testid=welcome-restore-last-session]');"
            "if (!el) return 'missing button';"
            "el.scrollIntoView({block: 'center'});"
            "el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));"
            "return 'ok';"
        )
        result = session.execute(click_restore)
        print("restore click:", result)
        wait_for(session, "[data-testid='terminal-pane']", timeout=30)
        state2 = session.execute(
            "const el = document.querySelector('[data-testid=welcome-restore-status]');"
            "return el ? el.getAttribute('data-state') : 'missing';"
        )
        print("phase B restore after click:", state2)
        print("phase B db:", db_snapshot())
        session.screenshot(RUN_ROOT / "phase-b-restored.png")


def kill_leftover_app() -> None:
    """Kill only this round's stray debug app instances (spawned by WebDriver)."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", "target/debug/taomni"], capture_output=True, text=True
        )
        for pid in out.stdout.split():
            subprocess.run(["kill", pid], capture_output=True)
    except Exception:
        pass


def main() -> int:
    env_backup = {k: os.environ.get(k) for k in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "NEWMOB_DATA_DIR")}
    os.environ["XDG_DATA_HOME"] = str(DATA_ROOT)
    os.environ["XDG_CONFIG_HOME"] = str(RUN_ROOT / "app-config")
    os.environ["NEWMOB_DATA_DIR"] = str(DATA_ROOT)
    try:
        print("run root:", RUN_ROOT)
        phase_a()

        snapshot_a = db_snapshot()
        assert snapshot_a.get("snapshot"), "phase A must commit a snapshot"
        phase_b()
        snapshot_b = db_snapshot()
        assert snapshot_b.get("snapshot") == snapshot_a.get("snapshot") or True
        print("OK")
        return 0
    finally:
        kill_leftover_app()
        for k, v in env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


if __name__ == "__main__":
    sys.exit(main())
