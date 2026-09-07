#!/usr/bin/env python3
"""Minimal WebDriver client for Tauri native E2E via tauri-driver.

This intentionally avoids adding a Node test runner dependency to the skill.
It speaks the small W3C WebDriver subset needed by the qa-ui-auto DSL.
"""
from __future__ import annotations

import base64
import json
import os
import platform
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from native_build import QA_APP_ID, verify_identity


ROOT = Path.cwd()


def native_binary(cfg: dict) -> Path:
    explicit = cfg.get("app", {}).get("native_binary")
    if explicit:
        return Path(explicit).expanduser()
    name = "taomni.exe" if platform.system() == "Windows" else "taomni"
    return ROOT / "src-tauri" / "target" / "qa-ui-auto" / "debug" / name


def native_isolation_env(report_root: Path) -> dict[str, str]:
    """Resolve only run-owned roots; never fall back to a user's profile."""
    root = report_root.resolve()
    paths = {key: root / f"native-app{key}" for key in ("data", "config", "cache")}
    checked = [path for root_path in paths.values() for path in (root_path, root_path / QA_APP_ID)]
    if any(path.resolve() != path for path in checked):
        raise WebDriverError("Native isolation directories must not be symlinks")
    system = platform.system()
    if system == "Linux":
        return {f"XDG_{key.upper()}_HOME": str(path) for key, path in paths.items()}
    if system == "Windows":
        return {"APPDATA": str(paths["data"]), "LOCALAPPDATA": str(paths["cache"])}
    raise WebDriverError("Tauri WebDriver is unsupported on this OS; use an isolated QA app with OS automation/manual testing")


def _tcp_ok(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _quote_xpath_text(value: str) -> str:
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value:
        return f'"{value}"'
    parts = value.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


def selector_strategy(selector: str, *, interactive: bool = False) -> tuple[str, str]:
    """Map common Playwright-ish selectors to WebDriver selector strategies."""
    selector = selector.strip()
    if selector.startswith("text="):
        text = selector[5:].strip()
        if (text.startswith('"') and text.endswith('"')) or (
            text.startswith("'") and text.endswith("'")
        ):
            text = text[1:-1]
        q = _quote_xpath_text(text)
        if interactive:
            return "xpath", (
                f"//button[contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
                f"|//*[@role='button' and (contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q}))]"
                f"|//a[contains(normalize-space(.), {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
                f"|//input[contains(@value, {q}) or contains(@aria-label, {q}) or contains(@title, {q})]"
            )
        return "xpath", (
            f"//*[contains(normalize-space(.), {q}) "
            f"or contains(@aria-label, {q}) or contains(@title, {q})]"
        )
    if selector.startswith("role=button"):
        name = ""
        marker = "name="
        if marker in selector:
            raw = selector.split(marker, 1)[1].strip()
            if raw.startswith("[") and raw.endswith("]"):
                raw = raw[1:-1]
            if (raw.startswith('"') and raw.endswith('"')) or (
                raw.startswith("'") and raw.endswith("'")
            ):
                raw = raw[1:-1]
            name = raw
        if name:
            q = _quote_xpath_text(name)
            return "xpath", (
                f"//button[normalize-space(.)={q} or @aria-label={q}]"
                f"|//*[@role='button' and (normalize-space(.)={q} or @aria-label={q})]"
            )
        return "css selector", "button,[role='button']"
    return "css selector", selector


class WebDriverError(RuntimeError):
    pass


class TauriDriverProcess:
    def __init__(self, cfg: dict, report_root: Path):
        webdriver = cfg.get("webdriver") or {}
        self.host = str(webdriver.get("host", "127.0.0.1"))
        self.port = int(webdriver.get("port", 4444))
        self.url = f"http://{self.host}:{self.port}"
        self.proc: subprocess.Popen[str] | None = None
        self.report_root = report_root
        self.command = str(webdriver.get("tauri_driver", "tauri-driver"))
        self.native_driver = webdriver.get("native_driver")
        self.native_port = int(webdriver.get("native_port", 4445))
        self.startup_timeout = float(webdriver.get("startup_timeout", 20))

    def start(self) -> None:
        if self.host not in ("127.0.0.1", "localhost"):
            raise WebDriverError("Native isolation requires a local driver started by this run")
        if _tcp_ok(self.host, self.port):
            raise WebDriverError(f"Driver port {self.port} is occupied; choose a free port so the driver inherits QA isolation")
        if self.native_port == self.port or _tcp_ok(self.host, self.native_port):
            raise WebDriverError(f"Native driver port {self.native_port} must be free and distinct from the driver port")
        cmd = [self.command, "--port", str(self.port), "--native-port", str(self.native_port)]
        if self.native_driver:
            cmd += ["--native-driver", str(self.native_driver)]
        out = self.report_root / "tauri-driver.out.log"
        err = self.report_root / "tauri-driver.err.log"
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8") as stdout, err.open("w", encoding="utf-8") as stderr:
            self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=stdout, stderr=stderr, text=True)
        deadline = time.time() + self.startup_timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise WebDriverError(
                    f"tauri-driver exited early with code {self.proc.returncode}; "
                    f"see {err}"
                )
            if _tcp_ok(self.host, self.port):
                return
            time.sleep(0.25)
        raise WebDriverError(f"tauri-driver did not listen on {self.url}")

    def stop(self) -> None:
        if not self.proc:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


class NativeSession:
    def __init__(self, driver_url: str, application: Path):
        self.driver_url = driver_url.rstrip("/")
        self.application = application
        self.session_id: str | None = None
        self.deadline = None
        # A local driver must remain reachable when the desktop uses a proxy.
        host = urllib.parse.urlsplit(self.driver_url).hostname
        self._open = (urllib.request.build_opener(urllib.request.ProxyHandler({})).open
                      if host in {"localhost", "127.0.0.1", "::1"} else urllib.request.urlopen)

    def request(self, method: str, path: str, payload: dict | None = None) -> Any:
        body = None
        headers = {"Content-Type": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.driver_url}{path}", data=body, headers=headers, method=method
        )
        try:
            timeout = min(30, self.deadline.remaining()) if self.deadline else 30
            with self._open(req, timeout=timeout) as r:
                data = r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise WebDriverError(f"HTTP {e.code}: {detail}") from e
        if not data:
            return None
        parsed = json.loads(data)
        value = parsed.get("value", parsed)
        if isinstance(value, dict) and "error" in value:
            raise WebDriverError(value.get("message") or value["error"])
        return value

    def start(self) -> None:
        payload = {
            "capabilities": {
                "alwaysMatch": {
                    "tauri:options": {
                        "application": str(self.application.resolve())
                    }
                }
            }
        }
        value = self.request("POST", "/session", payload)
        sid = value.get("sessionId") if isinstance(value, dict) else None
        if not sid:
            raise WebDriverError(f"could not create WebDriver session: {value}")
        self.session_id = sid
        self.install_console_hook()

    def close(self) -> None:
        if self.session_id:
            try:
                self.request("DELETE", f"/session/{self.session_id}")
            finally:
                self.session_id = None

    def endpoint(self, suffix: str) -> str:
        if not self.session_id:
            raise WebDriverError("WebDriver session is not started")
        return f"/session/{self.session_id}{suffix}"

    def find(self, selector: str, timeout: float = 10.0,
             *, interactive: bool = False) -> str:
        using, value = selector_strategy(selector, interactive=interactive)
        deadline = time.time() + timeout
        last_error = ""
        while time.time() < deadline:
            if self.deadline:
                self.deadline.remaining()
            try:
                found = self.request(
                    "POST",
                    self.endpoint("/element"),
                    {"using": using, "value": value},
                )
                if isinstance(found, dict):
                    element_id = (
                        found.get("element-6066-11e4-a52e-4f735466cecf")
                        or found.get("ELEMENT")
                    )
                    if element_id:
                        return element_id
            except Exception as e:  # keep polling until timeout
                last_error = str(e)
            time.sleep(0.25)
        raise WebDriverError(f"element not found: {selector} {last_error}".strip())

    def element_path(self, element_id: str, suffix: str = "") -> str:
        return self.endpoint(f"/element/{element_id}{suffix}")

    def click(self, selector: str) -> str:
        element = self.find(selector, interactive=True)
        self.request("POST", self.element_path(element, "/click"), {})
        return f"clicked {selector}"

    def dblclick(self, selector: str) -> str:
        element = self.find(selector, interactive=True)
        # Use W3C Actions API so WebKitGTK registers a real double-click.
        rect = self.request("GET", self.element_path(element, "/rect"))
        x = int((rect.get("x", 0) + rect.get("width", 0) / 2)) if isinstance(rect, dict) else 0
        y = int((rect.get("y", 0) + rect.get("height", 0) / 2)) if isinstance(rect, dict) else 0
        self.request(
            "POST",
            self.endpoint("/actions"),
            {
                "actions": [
                    {
                        "type": "pointer",
                        "id": "mouse",
                        "parameters": {"pointerType": "mouse"},
                        "actions": [
                            {"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pointerUp", "button": 0},
                            {"type": "pause", "duration": 50},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pointerUp", "button": 0},
                        ],
                    }
                ]
            },
        )
        return f"double-clicked {selector}"

    def pointer_click(self, selector: str) -> dict[str, int]:
        """Click through W3C pointer actions instead of element /click."""
        element = self.find(selector, interactive=True)
        rect = self.request("GET", self.element_path(element, "/rect"))
        x = int((rect.get("x", 0) + rect.get("width", 0) / 2)) if isinstance(rect, dict) else 0
        y = int((rect.get("y", 0) + rect.get("height", 0) / 2)) if isinstance(rect, dict) else 0
        self.request(
            "POST",
            self.endpoint("/actions"),
            {
                "actions": [
                    {
                        "type": "pointer",
                        "id": "native-pointer",
                        "parameters": {"pointerType": "mouse"},
                        "actions": [
                            {"type": "pointerMove", "duration": 100, "x": x, "y": y, "origin": "viewport"},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pause", "duration": 80},
                            {"type": "pointerUp", "button": 0},
                        ],
                    }
                ]
            },
        )
        return {"x": x, "y": y}

    def pointer_drag(
        self,
        start: dict[str, int],
        end: dict[str, int],
        modifiers: list[str] | None = None,
    ) -> dict[str, dict[str, int]]:
        """Drag between viewport coordinates while holding W3C modifiers."""
        modifier_names = modifiers or []
        modifier_values: list[str] = []
        for name in modifier_names:
            value = self.MODIFIER_MAP.get(name)
            if value is None:
                raise WebDriverError(f"pointer_drag: unknown modifier {name!r}")
            modifier_values.append(value)

        pointer_core = [
            {
                "type": "pointerMove",
                "duration": 100,
                "x": int(start["x"]),
                "y": int(start["y"]),
                "origin": "viewport",
            },
            {"type": "pointerDown", "button": 0},
            {
                "type": "pointerMove",
                "duration": 400,
                "x": int(end["x"]),
                "y": int(end["y"]),
                "origin": "viewport",
            },
            {"type": "pause", "duration": 100},
            {"type": "pointerUp", "button": 0},
        ]
        pointer_actions = (
            [{"type": "pause", "duration": 0} for _ in modifier_values]
            + pointer_core
            + [{"type": "pause", "duration": 0} for _ in modifier_values]
        )
        key_actions: list[dict[str, Any]] = []
        if modifier_values:
            key_actions.extend(
                {"type": "keyDown", "value": value} for value in modifier_values
            )
            key_actions.extend(
                {"type": "pause", "duration": 0}
                for _ in pointer_core
            )
            key_actions.extend(
                {"type": "keyUp", "value": value}
                for value in reversed(modifier_values)
            )

        actions: list[dict[str, Any]] = []
        if key_actions:
            actions.append({"type": "key", "id": "drag-keyboard", "actions": key_actions})
        actions.append({
            "type": "pointer",
            "id": "native-drag-pointer",
            "parameters": {"pointerType": "mouse"},
            "actions": pointer_actions,
        })
        try:
            self.request("POST", self.endpoint("/actions"), {"actions": actions})
        finally:
            # Release any input source left depressed by a failed driver action.
            try:
                self.request("DELETE", self.endpoint("/actions"))
            except WebDriverError:
                pass
        return {
            "start": {"x": int(start["x"]), "y": int(start["y"])},
            "end": {"x": int(end["x"]), "y": int(end["y"])},
        }

    def fill(self, selector: str, text: str) -> str:
        element = self.find(selector)
        contenteditable = self.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return !!el?.isContentEditable;"
        )
        if contenteditable is True:
            # WebKit accepts element /value for contenteditable nodes without
            # dispatching the beforeinput/input events CodeMirror owns. Drive
            # real key actions so the editor creates a normal transaction.
            for _ in range(3):
                self.request("POST", self.element_path(element, "/click"), {})
                focused = self.execute(
                    f"const el = document.querySelector({json.dumps(selector)});"
                    "return !!el && document.activeElement === el;"
                )
                if focused is True:
                    break
                time.sleep(0.1)
            else:
                raise WebDriverError(f"contenteditable did not receive focus: {selector}")
            self.press_combo("Control+a")
            lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            for index, line in enumerate(lines):
                if index:
                    self.press_combo("Enter")
                if line:
                    self.type_text(line)
            return f"filled contenteditable {selector}"
        try:
            self.request("POST", self.element_path(element, "/clear"), {})
        except WebDriverError:
            pass
        self.request(
            "POST",
            self.element_path(element, "/value"),
            {"text": text, "value": list(text)},
        )
        return f"filled {selector}"

    def send_keys(self, text: str) -> str:
        keys = {
            "Enter": "\ue007",
            "Tab": "\ue004",
            "Escape": "\ue00c",
            "Backspace": "\ue003",
            "Delete": "\ue017",
        }.get(text, text)
        self.request(
            "POST",
            self.endpoint("/actions"),
            {
                "actions": [
                    {
                        "type": "key",
                        "id": "keyboard",
                        "actions": [
                            {"type": "keyDown", "value": ch} for ch in keys
                        ]
                        + [{"type": "keyUp", "value": ch} for ch in keys],
                    }
                ]
            },
        )
        return f"sent keys {text}"

    # W3C key code points for named keys that have no printable character.
    KEY_MAP = {
        "Enter": "\ue007",
        "Tab": "\ue004",
        "Escape": "\ue00c",
        "Space": "\ue00d",
        "Backspace": "\ue003",
        "Delete": "\ue017",
        "ArrowUp": "\ue013",
        "ArrowDown": "\ue015",
        "ArrowLeft": "\ue012",
        "ArrowRight": "\ue014",
        "Home": "\ue011",
        "End": "\ue010",
        "PageUp": "\ue00e",
        "PageDown": "\ue00f",
        "Insert": "\ue016",
        **{f"F{i}": chr(0xE031 + i - 1) for i in range(1, 13)},
    }
    MODIFIER_MAP = {
        "Control": "\ue009",
        "Ctrl": "\ue009",
        "Shift": "\ue008",
        "Alt": "\ue00a",
        "Meta": "\ue03d",
        "Cmd": "\ue03d",
        "Command": "\ue03d",
    }

    def _combo_actions(self, combo: str) -> list[dict[str, Any]]:
        parts = [p.strip() for p in combo.split("+") if p.strip()]
        if not parts:
            raise WebDriverError(f"press_combo: empty combo {combo!r}")
        mods: list[str] = []
        for p in parts[:-1]:
            if p not in self.MODIFIER_MAP:
                raise WebDriverError(f"press_combo: unknown modifier {p!r}")
            mods.append(self.MODIFIER_MAP[p])
        final = parts[-1]
        value = self.MODIFIER_MAP.get(final) or self.KEY_MAP.get(final) or final
        seq: list[dict[str, Any]] = [{"type": "keyDown", "value": m} for m in mods]
        seq.append({"type": "keyDown", "value": value})
        seq.append({"type": "pause", "duration": 30})
        seq.append({"type": "keyUp", "value": value})
        seq += [{"type": "keyUp", "value": m} for m in reversed(mods)]
        seq.append({"type": "pause", "duration": 30})
        return seq

    def press_combo(self, combo: str) -> str:
        """Press a chord like `Control+s`, `Control+Shift+p`, or a bare
        named key (`Enter`). Sends real key events through the W3C Actions
        API so CodeMirror/keydown handlers in the native WebView see them."""
        return self.press_combos([combo])

    def press_combos(self, combos: list[str]) -> str:
        """Send multiple chords in one W3C action request.

        WebKitWebDriver can reset its connection after many back-to-back
        /actions requests. A single input source preserves the same native
        keydown/keyup semantics without exercising that driver failure.
        """
        seq = [action for combo in combos for action in self._combo_actions(combo)]
        try:
            self.request(
                "POST",
                self.endpoint("/actions"),
                {"actions": [{"type": "key", "id": "keyboard", "actions": seq}]},
            )
        finally:
            # WebKitWebDriver may retain pressedCharKey even after explicit
            # keyUp events. Releasing all input sources keeps the next command
            # independent, especially after Enter and clipboard shortcuts.
            try:
                self.request("DELETE", self.endpoint("/actions"))
            except WebDriverError:
                pass
        return f"pressed {len(combos)} combo(s)"

    def type_text(self, text: str) -> str:
        """Type text into the focused element, one paced key pair per char."""
        seq: list[dict[str, Any]] = []
        for ch in text:
            seq.append({"type": "keyDown", "value": ch})
            seq.append({"type": "keyUp", "value": ch})
            # Let WebKit deliver the input transaction and CodeMirror finish
            # its scheduled measure before the next native character arrives.
            seq.append({"type": "pause", "duration": 20})
        self.request(
            "POST",
            self.endpoint("/actions"),
            {"actions": [{"type": "key", "id": "keyboard", "actions": seq}]},
        )
        return f"typed {len(text)} chars"

    def wait_absent(self, selector: str, timeout: float = 5.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.find(selector, timeout=0.5)
            except WebDriverError:
                return
        raise WebDriverError(f"element still present after {timeout}s: {selector}")

    def console_entries(self) -> list[dict[str, Any]]:
        try:
            data = self.execute("return window.__QA_UI_AUTO_CONSOLE__ || [];")
            return data if isinstance(data, list) else []
        except WebDriverError:
            return []

    def text(self, selector: str) -> str:
        # For terminal-pane, read the data-terminal-text attribute which is
        # kept in sync by TerminalPanel via a 500ms interval. This bypasses
        # the xterm.js canvas rendering that makes innerText always empty.
        try:
            attr = self.execute(
                f"const el = document.querySelector({json.dumps(selector)});"
                "return el ? (el.getAttribute('data-terminal-text') ?? el.innerText ?? '') : '';"
            )
            if attr is not None:
                return str(attr)
        except WebDriverError:
            pass
        element = self.find(selector)
        return str(self.request("GET", self.element_path(element, "/text")) or "")

    def screenshot(self, target: Path) -> str:
        data = self.request("GET", self.endpoint("/screenshot"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(str(data)))
        return str(target)

    def execute(self, script: str) -> Any:
        return self.request(
            "POST", self.endpoint("/execute/sync"), {"script": script, "args": []}
        )

    def install_console_hook(self) -> None:
        script = r"""
        if (!window.__QA_UI_AUTO_CONSOLE__) {
          window.__QA_UI_AUTO_CONSOLE__ = [];
          for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            const original = console[level] ? console[level].bind(console) : console.log.bind(console);
            console[level] = (...args) => {
              try {
                window.__QA_UI_AUTO_CONSOLE__.push({
                  level,
                  time: new Date().toISOString(),
                  args: args.map((arg) => {
                    try {
                      if (arg instanceof Error) return arg.stack || arg.message;
                      if (typeof arg === 'string') return arg;
                      return JSON.stringify(arg);
                    } catch (_) {
                      return String(arg);
                    }
                  })
                });
              } catch (_) {}
              return original(...args);
            };
          }
          window.addEventListener('error', (event) => {
            window.__QA_UI_AUTO_CONSOLE__.push({
              level: 'error',
              time: new Date().toISOString(),
              args: [event.message, event.filename, event.lineno, event.colno]
            });
          });
          window.addEventListener('unhandledrejection', (event) => {
            window.__QA_UI_AUTO_CONSOLE__.push({
              level: 'error',
              time: new Date().toISOString(),
              args: ['unhandledrejection', String(event.reason)]
            });
          });
        }
        return true;
        """
        try:
            self.execute(script)
        except WebDriverError:
            pass


class NativeHarness:
    def __init__(self, cfg: dict, report_root: Path):
        self.cfg = cfg
        self.report_root = report_root
        self.application = native_binary(cfg)
        self.driver = TauriDriverProcess(cfg, report_root)
        self._previous_env: dict[str, str | None] = {}

    def __enter__(self) -> "NativeHarness":
        try:
            identity = verify_identity(self.application)
        except ValueError as exc:
            raise WebDriverError(str(exc)) from exc
        overrides = native_isolation_env(self.report_root)
        if identity.get("source_sha256"):
            from qa_ui_auto.provenance import source_identity
            if identity["source_sha256"] != source_identity(ROOT):
                raise WebDriverError("QA binary source is stale; run native_build.py")
        self._previous_env = {key: os.environ.get(key) for key in overrides}
        try:
            for value in overrides.values():
                Path(value).mkdir(parents=True, exist_ok=True)
            os.environ.update(overrides)
            self.report_root.mkdir(parents=True, exist_ok=True)
            (self.report_root / "native-isolation.json").write_text(
                json.dumps({"identifier": QA_APP_ID, "binary": str(self.application.resolve()),
                            "binary_sha256": identity["binary_sha256"], "environment": overrides,
                            "source_sha256": identity.get("source_sha256"),
                            "profile": identity.get("profile")}, indent=2) + "\n",
                encoding="utf-8",
            )
            self.driver.start()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self.driver.stop()
        finally:
            for key, previous in self._previous_env.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous
            self._previous_env.clear()

    def create_session(self) -> NativeSession:
        session = NativeSession(self.driver.url, self.application)
        session.deadline = getattr(self, "deadline", None)
        session.start()
        return session


def native_tool_issues(cfg: dict) -> list[str]:
    issues: list[str] = []
    if not shutil.which(str((cfg.get("webdriver") or {}).get("tauri_driver", "tauri-driver"))):
        issues += [
            "✗ tauri-driver not found on PATH.",
            "  Install: cargo install tauri-driver --locked",
            "  Install when needed within the authorized local test setup.",
        ]
    if platform.system() == "Windows" and not (
        (cfg.get("webdriver") or {}).get("native_driver") or shutil.which("msedgedriver")
    ):
        issues += [
            "✗ msedgedriver not found on PATH.",
            "  Download the Microsoft Edge Driver matching your Edge/WebView2 runtime,",
            "  then put msedgedriver.exe on PATH or set webdriver.native_driver.",
            "  This is not installed automatically because the version must match the local runtime.",
        ]
    return issues
