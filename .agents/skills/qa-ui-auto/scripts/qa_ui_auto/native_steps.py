"""Verb dispatch for native-mode runs (R9 §8.19.10 native gate harness).

Mirrors the browser STEP_REGISTRY semantics on top of the WebDriver subset
implemented in scripts/tauri_webdriver.py. Verbs that cannot be expressed
through WebDriver (or that would lie about what was exercised) raise
StepError instead of silently passing — a native gate must fail loudly.

Native-only verbs:
* assert_file_contains  - host-side disk re-read of a saved workspace file
                          (the G0 disk-effect proof; impossible from browser).
* assert_file_exists    - host-side existence check.
* assert_file_receipt   - independent byte hash/encoding/receipt reconciliation.
* assert_file_sha256    - exact host-byte postcondition without reading source text.
* native_set_writable   - report-root-scoped Linux permission fault injection.
* native_clipboard_owner - external X11 CLIPBOARD selection owner: grant a real
                          OS payload, deny text conversion, or suspend the owner
                          so any client's selection read genuinely fails (the
                          clipboard analogue of the disk permission fault above).
* assert_system_clipboard - independent out-of-process read of the real X11
                          CLIPBOARD selection; the only proof that the app's
                          copy actually crossed the OS boundary.
* native_pointer_drag - modifier-aware pointer drag in the packaged WebKitGTK
                        session, targeted from read-only line/column geometry.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import platform
import re
import signal
import stat
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable

from .steps import StepError


class NativeStepContext:
    """Per-case context handed to native verbs (fixture values resolved)."""

    def __init__(self, session: Any, case_dir: Path, cfg: dict):
        self.session = session
        self.case_dir = case_dir
        self.cfg = cfg
        self._permission_restores: dict[Path, int] = {}
        # External X11 CLIPBOARD owner started by native_clipboard_owner, plus
        # the host selection value captured before the case touched it.
        self._clipboard_owner: subprocess.Popen[str] | None = None
        self._clipboard_owner_suspended = False
        self._clipboard_owner_mode: str | None = None
        self._clipboard_owner_text: str | None = None
        self._host_clipboard_before: str | None = None
        self._host_clipboard_captured = False

    def restore_host_permissions(self) -> None:
        """Best-effort rollback for report-scoped fault injection.

        Also releases the external X11 clipboard owner and records that the
        host CLIPBOARD selection was replaced. X11 cannot retain a restored
        value without leaking a live owner process.
        """
        for path, mode in reversed(list(self._permission_restores.items())):
            try:
                path.chmod(mode)
            except OSError:
                pass
        self._permission_restores.clear()
        self._release_clipboard_owner()
        self._restore_host_clipboard()

    # -- external X11 clipboard owner -------------------------------------

    def _release_clipboard_owner(self) -> None:
        owner = self._clipboard_owner
        if owner is None:
            return
        try:
            if self._clipboard_owner_suspended:
                # A stopped process cannot act on any catchable signal; resume it
                # first so it can be reaped instead of lingering as a stopped
                # selection owner.
                os.kill(owner.pid, signal.SIGCONT)
                self._clipboard_owner_suspended = False
            # SIGKILL, not SIGTERM: an idle Tk mainloop blocks in C-level Tcl,
            # so Python never runs the bytecode that would service a catchable
            # signal and the owner would survive teardown holding the selection.
            owner.kill()
            owner.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            for stream in (owner.stdout, owner.stderr):
                with suppress(Exception):
                    if stream is not None:
                        stream.close()
            self._clipboard_owner = None
            self._clipboard_owner_mode = None

    def _restore_host_clipboard(self) -> None:
        """Record that the host CLIPBOARD selection was replaced.

        The value is deliberately NOT republished. X11 keeps a selection only
        while some process owns it, so "restoring" it would mean leaving a
        detached owner behind after every run — a process leak, and one that can
        republish a payload this harness itself granted (a later case's snapshot
        of "host state" is often the previous case's payload). Testing the real
        system clipboard unavoidably replaces its contents; the honest contract
        is to disclose that in the artifact rather than fake a restore.
        """
        if not self._host_clipboard_captured:
            return
        previous = self._host_clipboard_before
        self._host_clipboard_captured = False
        self._host_clipboard_before = None
        artifact = self.case_dir / "native-clipboard-host-state.json"
        with suppress(OSError):
            artifact.write_text(
                json.dumps({
                    "display": os.environ.get("DISPLAY"),
                    "hostSelectionReplaced": True,
                    "hostSelectionRestored": False,
                    "reason": "X11 selections require a live owner; the runner does not "
                              "leave one behind, so the pre-case value is reported, not restored.",
                    "priorSelectionReadable": previous is not None,
                    "priorSelectionLength": len(previous) if previous else None,
                    "priorSelectionSha256": hashlib.sha256(previous.encode("utf-8")).hexdigest()
                    if previous else None,
                    "priorSelectionWasHarnessPayload": bool(
                        previous and previous in _GRANTED_CLIPBOARD_TEXTS
                    ),
                }, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )


def _screenshot(ctx: NativeStepContext, args: Any) -> str:
    target = args["path"] if isinstance(args, dict) else str(args)
    return ctx.session.screenshot(ctx.case_dir / target)


def _press(ctx: NativeStepContext, args: Any) -> str:
    if isinstance(args, str):
        key, selector = args, None
    elif isinstance(args, dict) and "key" in args:
        key = str(args["key"])
        selector = args.get("selector")
    else:
        raise StepError(f"press: expected string or {{key, selector?}}, got {args!r}")
    if selector:
        ctx.session.click(selector)
    return ctx.session.press_combo(key)


def _wait_for(ctx: NativeStepContext, args: Any) -> str:
    timeout = 10.0
    selectors: list[str]
    if isinstance(args, dict):
        raw = args.get("selector", args.get("text"))
        timeout = float(args.get("timeout_sec", timeout))
    else:
        raw = args
    if raw is None:
        raise StepError(f"wait_for: unsupported args {args!r}")
    selectors = raw if isinstance(raw, list) else [raw]
    last = ""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for sel in selectors:
            try:
                ctx.session.find(sel, timeout=0.5)
                return f"found {sel}"
            except Exception as e:  # noqa: BLE001
                last = str(e)
        time.sleep(0.25)
    raise StepError(f"wait_for: none found within {timeout}s ({last})")


def _assert_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.find(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_visible failed: {selector} ({e})") from e
    return f"visible {selector}"


def _assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    selector, timeout = _selector_args(args)
    try:
        ctx.session.wait_absent(selector, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        raise StepError(f"assert_not_visible failed: {e}") from e
    return f"absent {selector}"


def _selector_args(args: Any) -> tuple[str, float]:
    if isinstance(args, str):
        return args, 10.0
    if isinstance(args, dict) and "selector" in args:
        return str(args["selector"]), float(args.get("timeout_sec", 10))
    raise StepError(f"expected selector string or {{selector, timeout_sec?}}, got {args!r}")


def _assert_text(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "contains" not in args:
        raise StepError(f"assert_text: expected {{selector, contains, timeout_sec?}}")
    selector = str(args["selector"])
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    text = ""
    while time.time() < deadline:
        try:
            text = ctx.session.text(selector)
        except Exception:  # noqa: BLE001
            text = ""
        if expected in text:
            return f"text ok: {selector}"
        time.sleep(0.3)
    raise StepError(
        f"assert_text failed: {selector!r} did not contain {expected!r}; last text={text[:200]!r}"
    )


def _eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "expression" not in args:
        raise StepError("eval_readonly: expected {expression, ...}")
    expr = str(args["expression"])
    result = ctx.session.execute(f"return ({expr});")
    if args.get("expect_truthy", True) and not result:
        raise StepError(f"eval_readonly: expression returned falsy: {result!r}")
    if "contains" in args and args["contains"] not in str(result):
        raise StepError(f"eval_readonly: result {result!r} does not contain {args['contains']!r}")
    return f"eval ok"


def _hover(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    element = ctx.session.find(selector, interactive=True)
    rect = ctx.session.request("GET", ctx.session.element_path(element, "/rect"))
    x = int(rect.get("x", 0) + rect.get("width", 0) / 2)
    y = int(rect.get("y", 0) + rect.get("height", 0) / 2)
    ctx.session.request(
        "POST",
        ctx.session.endpoint("/actions"),
        {
            "actions": [
                {
                    "type": "pointer",
                    "id": "mouse",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [{"type": "pointerMove", "duration": 100, "x": x, "y": y,
                                 "origin": "viewport"}],
                }
            ]
        },
    )
    return f"hovered {selector}"


def _select_option(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args:
        raise StepError("select_option: expected {selector, value?|label?}")
    selector = str(args["selector"])
    value = args.get("value")
    label = args.get("label")
    if value is None and label is None:
        raise StepError("select_option: value or label is required")
    result = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "if (!(el instanceof HTMLSelectElement)) return {ok:false, reason:'not-select'};"
        f"const expectedValue = {json.dumps(None if value is None else str(value))};"
        f"const expectedLabel = {json.dumps(None if label is None else str(label))};"
        "const option = Array.from(el.options).find((candidate) => "
        "(expectedValue !== null && candidate.value === expectedValue) || "
        "(expectedLabel !== null && candidate.text === expectedLabel));"
        "if (!option) return {ok:false, reason:'missing-option'};"
        "el.value = option.value;"
        "el.dispatchEvent(new Event('input', {bubbles:true}));"
        "el.dispatchEvent(new Event('change', {bubbles:true}));"
        "return {ok:true, value:el.value};"
    )
    if not isinstance(result, dict) or not result.get("ok"):
        raise StepError(f"select_option: could not select {value or label!r}: {result!r}")
    return f"selected {result.get('value')!r} in {selector}"


def _assert_attribute(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not {"selector", "name", "equals"} <= set(args):
        raise StepError("assert_attribute: expected {selector, name, equals}")
    selector = str(args["selector"])
    name = str(args["name"])
    expected = str(args["equals"])
    actual = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        f"return el ? el.getAttribute({json.dumps(name)}) : null;"
    )
    if str(actual) != expected:
        raise StepError(f"assert_attribute: {selector}[{name}]={actual!r} != {expected!r}")
    return f"attribute ok: {selector}[{name}]"


def _assert_file_receipt(ctx: NativeStepContext, args: Any) -> str:
    """Independently hash host bytes and reconcile them with the DOM receipt."""
    required = {"path", "selector", "encoding", "bom", "eol", "expected_text"}
    if not isinstance(args, dict) or not required <= set(args):
        raise StepError(
            "assert_file_receipt: expected {path, selector, encoding, bom, eol, expected_text}"
        )
    path = Path(str(args["path"])).expanduser()
    selector = str(args["selector"])
    encoding = str(args["encoding"])
    normalized_encoding = encoding.strip().upper().replace("_", "-")
    expected_bom = bool(args["bom"])
    expected_eol = str(args["eol"]).lower()
    expected_text = str(args["expected_text"])
    require_history = bool(args.get("require_history", True))
    timeout = float(args.get("timeout_sec", 20))
    deadline = time.time() + timeout
    attrs: dict[str, Any] | None = None
    raw = b""
    disk_hash = ""

    attribute_names = [
        "data-state", "data-result-kind", "data-receipt-id", "data-transaction-id",
        "data-final-text-sha256", "data-encoded-bytes-sha256",
        "data-encoded-byte-length", "data-disk-post-sha256", "data-write-count",
        "data-encoding", "data-bom", "data-eol", "data-history-id",
    ]
    while time.time() < deadline:
        observed = ctx.session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            f"const names = {json.dumps(attribute_names)};"
            "return el ? Object.fromEntries(names.map((name) => [name, el.getAttribute(name)])) : null;"
        )
        if isinstance(observed, dict) and path.exists():
            candidate = path.read_bytes()
            candidate_hash = hashlib.sha256(candidate).hexdigest()
            if (
                observed.get("data-state") == "saved"
                and observed.get("data-encoded-bytes-sha256") == candidate_hash
                and observed.get("data-disk-post-sha256") == candidate_hash
            ):
                attrs = observed
                raw = candidate
                disk_hash = candidate_hash
                break
        time.sleep(0.25)
    if attrs is None:
        raise StepError(
            f"assert_file_receipt: receipt did not converge with independently hashed bytes for {path}"
        )

    if attrs.get("data-result-kind") != "saved-current":
        raise StepError(f"assert_file_receipt: unexpected result kind {attrs.get('data-result-kind')!r}")
    if attrs.get("data-write-count") != "1":
        raise StepError(f"assert_file_receipt: write count is {attrs.get('data-write-count')!r}, expected '1'")
    if attrs.get("data-encoded-byte-length") != str(len(raw)):
        raise StepError(
            f"assert_file_receipt: byte length {attrs.get('data-encoded-byte-length')!r} != {len(raw)}"
        )
    observed_encoding = (attrs.get("data-encoding") or "").upper().replace("_", "-")
    if observed_encoding != normalized_encoding:
        raise StepError(
            f"assert_file_receipt: encoding {attrs.get('data-encoding')!r} != {encoding!r}"
        )
    if attrs.get("data-bom") != str(expected_bom).lower():
        raise StepError(f"assert_file_receipt: BOM metadata {attrs.get('data-bom')!r} is wrong")
    if attrs.get("data-eol") != expected_eol:
        raise StepError(f"assert_file_receipt: EOL metadata {attrs.get('data-eol')!r} != {expected_eol!r}")
    if require_history and not attrs.get("data-history-id"):
        raise StepError("assert_file_receipt: production receipt has no local-history identity")

    if normalized_encoding == "UTF-8":
        marker, codec = b"\xef\xbb\xbf", "utf-8"
    elif normalized_encoding == "UTF-16LE":
        marker, codec = b"\xff\xfe", "utf-16-le"
    elif normalized_encoding == "UTF-16BE":
        marker, codec = b"\xfe\xff", "utf-16-be"
    elif normalized_encoding in {"ISO-8859-1", "LATIN1"}:
        marker, codec = b"", "latin-1"
    else:
        raise StepError(f"assert_file_receipt: unsupported evidence encoding {encoding!r}")

    if marker:
        has_marker = raw.startswith(marker)
        if has_marker != expected_bom:
            raise StepError(
                f"assert_file_receipt: BOM bytes present={has_marker}, expected={expected_bom}"
            )
        payload = raw[len(marker):] if has_marker else raw
    else:
        payload = raw
    try:
        decoded = payload.decode(codec)
    except UnicodeDecodeError as exc:
        raise StepError(f"assert_file_receipt: host bytes do not decode as {encoding}: {exc}") from exc

    normalized_expected = expected_text.replace("\r\n", "\n").replace("\r", "\n")
    if expected_eol == "crlf":
        expected_disk_text = normalized_expected.replace("\n", "\r\n")
    elif expected_eol == "cr":
        expected_disk_text = normalized_expected.replace("\n", "\r")
    else:
        expected_disk_text = normalized_expected
    if decoded != expected_disk_text:
        raise StepError(
            "assert_file_receipt: decoded host bytes do not match the expected fixture text/EOL"
        )
    text_hash = hashlib.sha256(decoded.encode("utf-8")).hexdigest()
    if attrs.get("data-final-text-sha256") != text_hash:
        raise StepError(
            f"assert_file_receipt: logical text SHA {attrs.get('data-final-text-sha256')!r} != {text_hash}"
        )

    artifact = ctx.case_dir / "native-save-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.system().lower(),
        "path": str(path),
        "encoding": encoding,
        "bom": expected_bom,
        "eol": expected_eol,
        "byteLength": len(raw),
        "diskBytesSha256": disk_hash,
        "receiptId": attrs.get("data-receipt-id"),
        "transactionId": attrs.get("data-transaction-id"),
        "historyId": attrs.get("data-history-id"),
        "verifiedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(json.dumps(observations, indent=2, sort_keys=True), encoding="utf-8")
    return f"native receipt verified: {encoding} bom={expected_bom} eol={expected_eol} sha256={disk_hash}"


def _assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    """Host-side G0 proof: re-read the saved file from the real filesystem."""
    if not isinstance(args, dict) or "path" not in args or "contains" not in args:
        raise StepError("assert_file_contains: expected {path, contains}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["contains"])
    timeout = float(args.get("timeout_sec", 15))
    deadline = time.time() + timeout
    body = ""
    while time.time() < deadline:
        if path.exists():
            body = path.read_text(encoding="utf-8", errors="replace")
            if expected in body:
                return f"disk verified: {path}"
        time.sleep(0.3)
    state = "missing" if not path.exists() else f"len={len(body)}"
    raise StepError(
        f"assert_file_contains failed after {timeout}s: {path} ({state}) "
        f"does not contain {expected!r}"
    )


def _assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    path_str = args["path"] if isinstance(args, dict) else str(args)
    path = Path(path_str).expanduser()
    timeout = float(args.get("timeout_sec", 10)) if isinstance(args, dict) else 10
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            return f"exists {path}"
        time.sleep(0.25)
    raise StepError(f"assert_file_exists failed: {path} not created within {timeout}s")


def _assert_file_sha256(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or not {"path", "equals"} <= set(args):
        raise StepError("assert_file_sha256: expected {path, equals, timeout_sec?}")
    path = Path(str(args["path"])).expanduser()
    expected = str(args["equals"]).lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise StepError("assert_file_sha256: equals must be a lowercase SHA-256 hex digest")
    timeout = float(args.get("timeout_sec", 10))
    deadline = time.time() + timeout
    actual = "missing"
    while time.time() < deadline:
        if path.exists():
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual == expected:
                return f"host byte SHA-256 verified: {actual}"
        time.sleep(0.25)
    raise StepError(
        f"assert_file_sha256: {path} hash {actual!r} != {expected!r} after {timeout}s"
    )


def _native_set_writable(ctx: NativeStepContext, args: Any) -> str:
    """Toggle owner-write only inside this run's retained report directory."""
    if platform.system() != "Linux":
        raise StepError("native_set_writable: requires Linux permission semantics")
    if not isinstance(args, dict) or not {"path", "writable"} <= set(args):
        raise StepError("native_set_writable: expected {path, writable}")
    requested = Path(str(args["path"])).expanduser()
    try:
        target = requested.resolve(strict=True)
    except OSError as exc:
        raise StepError(f"native_set_writable: cannot resolve {requested}: {exc}") from exc
    report_root = ctx.case_dir.parent.resolve()
    if not target.is_relative_to(report_root):
        raise StepError(
            f"native_set_writable: target must stay inside report root {report_root}"
        )
    writable = bool(args["writable"])
    before = stat.S_IMODE(target.stat().st_mode)
    ctx._permission_restores.setdefault(target, before)
    after = before | stat.S_IWUSR if writable else before & ~stat.S_IWUSR
    target.chmod(after)
    observed = stat.S_IMODE(target.stat().st_mode)
    if bool(observed & stat.S_IWUSR) != writable:
        raise StepError(
            f"native_set_writable: owner-write postcondition failed for {target}"
        )

    artifact = ctx.case_dir / "native-permission-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.system().lower(),
        "path": str(target),
        "ownerWritable": writable,
        "beforeMode": f"{before:04o}",
        "afterMode": f"{observed:04o}",
        "verifiedAtUnixMs": int(time.time() * 1000),
    })
    artifact.write_text(json.dumps(observations, indent=2, sort_keys=True), encoding="utf-8")
    return f"owner writable={writable} for {target} ({before:04o}->{observed:04o})"


def _command_output(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise StepError(f"native_ime_keys: {' '.join(command)} failed: {detail}")
    return result.stdout.strip()


def _active_x11_window() -> tuple[str, str]:
    root = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    window_id = root.rsplit(" ", 1)[-1]
    if window_id == "0x0":
        raise StepError("native_ime_keys: X11 has no active window")
    identity = _command_output(["xprop", "-id", window_id, "WM_CLASS", "_NET_WM_NAME"])
    if "taomni" not in identity.lower():
        raise StepError(f"native_ime_keys: active window is not Taomni: {identity}")
    return window_id, identity


def _activate_x11_application(application: Path) -> tuple[str, str]:
    """Activate only the X11 window owned by the exact test executable."""
    clients = _command_output(["xprop", "-root", "_NET_CLIENT_LIST_STACKING"])
    window_ids = [token.rstrip(",") for token in clients.split() if token.startswith("0x")]
    expected_executable = application.resolve()
    target: tuple[str, str] | None = None
    for window_id in reversed(window_ids):
        try:
            identity = _command_output([
                "xprop", "-id", window_id, "WM_CLASS", "_NET_WM_NAME", "_NET_WM_PID",
            ])
        except StepError:
            continue
        first_line = identity.splitlines()[0].lower() if identity else ""
        if '"taomni"' not in first_line:
            continue
        pid_match = re.search(r"_NET_WM_PID\(CARDINAL\) = (\d+)", identity)
        if not pid_match:
            continue
        executable = Path(f"/proc/{pid_match.group(1)}/exe")
        try:
            if executable.resolve(strict=True) != expected_executable:
                continue
        except OSError:
            continue
        target = (window_id, identity)
        break
    if target is None:
        raise StepError(f"native X11: no window belongs to {expected_executable}")

    window_id, identity = target
    active = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if active.rsplit(" ", 1)[-1] != window_id:
        activation = subprocess.run(
            ["wmctrl", "-ia", window_id],
            capture_output=True,
            text=True,
            check=False,
        )
        if activation.returncode != 0:
            detail = activation.stderr.strip() or activation.stdout.strip() or f"exit {activation.returncode}"
            raise StepError(f"native X11: could not activate {window_id}: {detail}")
        deadline = time.time() + 3
        while time.time() < deadline:
            active = _command_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
            if active.rsplit(" ", 1)[-1] == window_id:
                break
            time.sleep(0.1)
        else:
            raise StepError(f"native X11: {window_id} did not become active")
    return window_id, identity


def _x11_keysyms_for_chord(chord: str) -> list[int]:
    special_keysyms = {
        "Tab": 0xFF09,
        "Return": 0xFF0D,
        "Enter": 0xFF0D,
        "Home": 0xFF50,
        "End": 0xFF57,
        "ArrowUp": 0xFF52,
        "ArrowDown": 0xFF54,
        "ArrowLeft": 0xFF51,
        "ArrowRight": 0xFF53,
        "Escape": 0xFF1B,
        "Space": 0x0020,
        "Control": 0xFFE3,
        "Ctrl": 0xFFE3,
        "Shift": 0xFFE1,
        "Alt": 0xFFE9,
        "Meta": 0xFFE7,
    }
    parts = [part.strip() for part in chord.split("+") if part.strip()]
    if not parts:
        raise StepError(f"native_keys: empty X11 chord {chord!r}")
    keysyms: list[int] = []
    for key in parts:
        if len(key) == 1 and key.isascii():
            keysyms.append(ord(key))
        elif key in special_keysyms:
            keysyms.append(special_keysyms[key])
        else:
            raise StepError(f"native_keys: unsupported X11 key {key!r}")
    return keysyms


def _inject_x11_keys(keys: list[str]) -> None:
    x11 = ctypes.CDLL("libX11.so.6")
    xtst = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_uint
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeKeyEvent.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_ulong,
    ]
    xtst.XTestFakeKeyEvent.restype = ctypes.c_int

    display = x11.XOpenDisplay(os.environ.get("DISPLAY", "").encode() or None)
    if not display:
        raise StepError(f"native_keys: cannot open X11 display {os.environ.get('DISPLAY')!r}")
    try:
        for chord in keys:
            keycodes: list[int] = []
            for keysym in _x11_keysyms_for_chord(chord):
                keycode = x11.XKeysymToKeycode(display, keysym)
                if keycode == 0:
                    raise StepError(f"native_keys: no X11 keycode for {chord!r}")
                keycodes.append(keycode)
            for keycode in keycodes:
                if xtst.XTestFakeKeyEvent(display, keycode, 1, 0) == 0:
                    raise StepError(f"native_keys: keyDown injection failed for {chord!r}")
                x11.XFlush(display)
                time.sleep(0.04)
            time.sleep(0.08)
            for keycode in reversed(keycodes):
                if xtst.XTestFakeKeyEvent(display, keycode, 0, 0) == 0:
                    raise StepError(f"native_keys: keyUp injection failed for {chord!r}")
                x11.XFlush(display)
                time.sleep(0.04)
            x11.XFlush(display)
            time.sleep(0.12)
    finally:
        x11.XCloseDisplay(display)


# --------------------------------------------------------------------------
# External X11 CLIPBOARD selection client.
#
# Both halves run OUT OF PROCESS from the app under test, so nothing here can
# observe or influence the app's internal state: the only channel is the real
# X11 CLIPBOARD selection. Tk is used because it is the one X11 selection client
# guaranteed present with CPython; this host has no xclip/xsel/wl-copy.
# --------------------------------------------------------------------------

# Every payload this runner process has ever published to the X11 CLIPBOARD.
# The restore guard is process-wide, not per-case: with several cases in one
# run, case N's snapshot of "host state" can be exactly what case N-1 granted,
# and republishing that would fake a restore and leak an owner.
_GRANTED_CLIPBOARD_TEXTS: set[str] = set()


_CLIPBOARD_OWNER_SOURCE = r"""
import sys, tkinter as tk
root = tk.Tk(); root.withdraw()
root.clipboard_clear(); root.clipboard_append(sys.argv[1])
root.update()
sys.stdout.write("OWNER-READY\n"); sys.stdout.flush()
root.mainloop()
"""

_CLIPBOARD_DENY_OWNER_SOURCE = r"""
import ctypes, ctypes.util, sys

X11 = ctypes.CDLL(ctypes.util.find_library("X11"))
Window = ctypes.c_ulong
Atom = ctypes.c_ulong

class XSelectionRequestEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("owner", Window),
        ("requestor", Window),
        ("selection", Atom),
        ("target", Atom),
        ("property", Atom),
        ("time", ctypes.c_ulong),
    ]

class XSelectionEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("requestor", Window),
        ("selection", Atom),
        ("target", Atom),
        ("property", Atom),
        ("time", ctypes.c_ulong),
    ]

class XEvent(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("xselectionrequest", XSelectionRequestEvent),
        ("xselection", XSelectionEvent),
        ("pad", ctypes.c_long * 24),
    ]

X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XOpenDisplay.restype = ctypes.c_void_p
X11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X11.XDefaultRootWindow.restype = Window
X11.XCreateSimpleWindow.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int,
    ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
    ctypes.c_ulong, ctypes.c_ulong,
]
X11.XCreateSimpleWindow.restype = Window
X11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
X11.XInternAtom.restype = Atom
X11.XSetSelectionOwner.argtypes = [ctypes.c_void_p, Atom, Window, ctypes.c_ulong]
X11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, Atom]
X11.XGetSelectionOwner.restype = Window
X11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
X11.XChangeProperty.argtypes = [
    ctypes.c_void_p, Window, Atom, Atom, ctypes.c_int,
    ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int,
]
X11.XSendEvent.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent),
]
X11.XFlush.argtypes = [ctypes.c_void_p]

display = X11.XOpenDisplay(None)
if not display:
    raise RuntimeError("cannot open X11 display")
root = X11.XDefaultRootWindow(display)
owner = X11.XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0)
clipboard = X11.XInternAtom(display, b"CLIPBOARD", 0)
targets = X11.XInternAtom(display, b"TARGETS", 0)
utf8 = X11.XInternAtom(display, b"UTF8_STRING", 0)
text = X11.XInternAtom(display, b"TEXT", 0)
string = X11.XInternAtom(display, b"STRING", 0)
atom = 4
X11.XSetSelectionOwner(display, clipboard, owner, 0)
X11.XFlush(display)
if X11.XGetSelectionOwner(display, clipboard) != owner:
    raise RuntimeError("failed to own CLIPBOARD")
sys.stdout.write("OWNER-READY\n"); sys.stdout.flush()

while True:
    event = XEvent()
    X11.XNextEvent(display, ctypes.byref(event))
    if event.type != 30:
        continue
    request = event.xselectionrequest
    reply_property = 0
    if request.target == targets:
        reply_property = request.property or request.target
        advertised = (Atom * 4)(targets, utf8, text, string)
        X11.XChangeProperty(
            display,
            request.requestor,
            reply_property,
            atom,
            32,
            0,
            ctypes.cast(advertised, ctypes.POINTER(ctypes.c_ubyte)),
            len(advertised),
        )
    reply = XEvent()
    reply.xselection = XSelectionEvent(
        31,
        0,
        1,
        display,
        request.requestor,
        request.selection,
        request.target,
        reply_property,
        request.time,
    )
    X11.XSendEvent(display, request.requestor, 0, 0, ctypes.byref(reply))
    X11.XFlush(display)
"""

_CLIPBOARD_READER_SOURCE = r"""
import json, sys, tkinter as tk
root = tk.Tk(); root.withdraw()
try:
    value = root.clipboard_get()
    sys.stdout.write(json.dumps({"ok": True, "text": value}))
except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
"""


def _spawn_clipboard_owner(
    text: str | None = None,
    *,
    deny_text_conversion: bool = False,
) -> subprocess.Popen[str]:
    """Own the X11 CLIPBOARD selection from a separate process."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native clipboard: requires a Linux X11 display")
    if deny_text_conversion:
        command = [sys.executable, "-c", _CLIPBOARD_DENY_OWNER_SOURCE]
    else:
        if text is None:
            raise StepError("native clipboard: text owner requires a payload")
        command = [sys.executable, "-c", _CLIPBOARD_OWNER_SOURCE, text]
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if proc.poll() is not None:
            err = (proc.stderr.read() if proc.stderr else "") or f"exit {proc.returncode}"
            raise StepError(f"native clipboard: owner process died: {err.strip()}")
        line = proc.stdout.readline() if proc.stdout else ""
        if line.strip() == "OWNER-READY":
            return proc
    with suppress(OSError):
        proc.kill()
    raise StepError("native clipboard: owner process did not take the CLIPBOARD selection")


def _read_x11_clipboard(timeout: float = 30.0) -> dict[str, Any]:
    """Read the real CLIPBOARD selection from a separate process.

    A missing or unresponsive owner is reported as `{"ok": False}` with the X11
    error text rather than as an empty string, so a stalled selection transfer
    can never be mistaken for an empty clipboard.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native clipboard: requires a Linux X11 display")
    try:
        result = subprocess.run(
            [sys.executable, "-c", _CLIPBOARD_READER_SOURCE],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"external X11 read exceeded {timeout}s"}
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit {result.returncode}"
        return {"ok": False, "error": detail}
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"unparsable reader output: {exc}"}
    return payload if isinstance(payload, dict) else {"ok": False, "error": "reader returned non-object"}


def _append_clipboard_observation(ctx: NativeStepContext, entry: dict[str, Any]) -> None:
    artifact = ctx.case_dir / "native-clipboard-observations.json"
    observations: list[dict[str, Any]] = []
    if artifact.exists():
        try:
            loaded = json.loads(artifact.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                observations = loaded
        except (OSError, json.JSONDecodeError):
            observations = []
    observations.append({
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "transport": "external X11 CLIPBOARD selection (out-of-process Tk client)",
        "verifiedAtUnixMs": int(time.time() * 1000),
        **entry,
    })
    artifact.write_text(
        json.dumps(observations, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


VERBS: dict[str, Callable[[NativeStepContext], str]] = {}


def _verb(name: str) -> Callable[[Callable[[NativeStepContext, Any], str]], Callable[[NativeStepContext, Any], str]]:
    def deco(fn: Callable[[NativeStepContext, Any], str]) -> Callable[[NativeStepContext, Any], str]:
        VERBS[name] = fn
        return fn

    return deco


@_verb("open")
@_verb("goto")
def _noop_open(ctx: NativeStepContext, args: Any) -> str:
    # tauri-driver launches the binary as part of session creation; there is
    # nothing to navigate in a packaged app window.
    return "no-op (app already launched by driver)"


@_verb("screenshot")
def _do_screenshot(ctx: NativeStepContext, args: Any) -> str:
    return _screenshot(ctx, args)


@_verb("click")
def _do_click(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.click(selector)


@_verb("dblclick")
def _do_dblclick(ctx: NativeStepContext, args: Any) -> str:
    selector, _ = _selector_args(args)
    return ctx.session.dblclick(selector)


@_verb("fill")
def _do_fill(ctx: NativeStepContext, args: Any) -> str:
    if not isinstance(args, dict) or "selector" not in args or "value" not in args:
        raise StepError("fill: expected {selector, value}")
    return ctx.session.fill(str(args["selector"]), str(args["value"]))


@_verb("type")
@_verb("send_keys")
def _do_type(ctx: NativeStepContext, args: Any) -> str:
    return ctx.session.type_text(str(args))


@_verb("press")
def _do_press(ctx: NativeStepContext, args: Any) -> str:
    return _press(ctx, args)


@_verb("wait_for")
def _do_wait_for(ctx: NativeStepContext, args: Any) -> str:
    return _wait_for(ctx, args)


@_verb("wait")
def _do_wait(ctx: NativeStepContext, args: Any) -> str:
    seconds = float(args if isinstance(args, (int, float)) else (args or {}).get("seconds", 1))
    time.sleep(seconds)
    return f"waited {seconds}s"


@_verb("assert_visible")
def _do_assert_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_visible(ctx, args)


@_verb("assert_not_visible")
def _do_assert_not_visible(ctx: NativeStepContext, args: Any) -> str:
    return _assert_not_visible(ctx, args)


@_verb("assert_text")
def _do_assert_text(ctx: NativeStepContext, args: Any) -> str:
    return _assert_text(ctx, args)


@_verb("eval_readonly")
def _do_eval_readonly(ctx: NativeStepContext, args: Any) -> str:
    return _eval_readonly(ctx, args)


@_verb("hover")
def _do_hover(ctx: NativeStepContext, args: Any) -> str:
    return _hover(ctx, args)


@_verb("select_option")
def _do_select_option(ctx: NativeStepContext, args: Any) -> str:
    return _select_option(ctx, args)


@_verb("assert_attribute")
def _do_assert_attribute(ctx: NativeStepContext, args: Any) -> str:
    return _assert_attribute(ctx, args)


@_verb("assert_file_contains")
def _do_assert_file_contains(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_contains(ctx, args)


@_verb("assert_file_exists")
def _do_assert_file_exists(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_exists(ctx, args)


@_verb("assert_file_receipt")
def _do_assert_file_receipt(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_receipt(ctx, args)


@_verb("assert_file_sha256")
def _do_assert_file_sha256(ctx: NativeStepContext, args: Any) -> str:
    return _assert_file_sha256(ctx, args)


@_verb("native_set_writable")
def _do_native_set_writable(ctx: NativeStepContext, args: Any) -> str:
    return _native_set_writable(ctx, args)


@_verb("native_keys")
def _do_native_keys(ctx: NativeStepContext, args: Any) -> str:
    """Inject physical X11 keys into an already-focused native control."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_keys: requires a Linux X11 display")
    if not isinstance(args, dict):
        raise StepError("native_keys: expected {selector, keys}")
    selector = args.get("selector")
    keys = args.get("keys")
    if not isinstance(selector, str) or not selector:
        raise StepError("native_keys: selector must be a non-empty string")
    if not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
        raise StepError("native_keys: keys must be a non-empty string array")

    focus_prechecked = args.get("focus_prechecked") is True
    if not focus_prechecked:
        focused = ctx.session.execute(
            f"const el = document.querySelector({json.dumps(selector)});"
            "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
        )
        if not focused:
            raise StepError(
                f"native_keys: target must already have DOM focus before native injection: {selector}"
            )
    time.sleep(0.25)
    window_id, window_identity = _activate_x11_application(ctx.session.application)
    _inject_x11_keys(keys)
    time.sleep(0.5)
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "focused_selector": selector,
        "focus_verification": "testcase precondition" if focus_prechecked else "immediate DOM probe",
        "keys": keys,
        "transport": "X11 XTest -> GTK/WebKitGTK",
        "result": "keys-injected; testcase DOM postcondition is authoritative",
    }
    (ctx.case_dir / "native-key-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return f"injected {len(keys)} X11 keys into focused native control"


@_verb("native_click")
def _do_native_click(ctx: NativeStepContext, args: Any) -> str:
    """Click a visible control through X11 in the exact test application."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_click: requires a Linux X11 display")
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str):
        raise StepError("native_click: expected {selector}")
    selector = args["selector"]
    geometry = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "if (!(el instanceof HTMLElement)) return null;"
        "const rect = el.getBoundingClientRect();"
        "return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,"
        "innerWidth:window.innerWidth,innerHeight:window.innerHeight,"
        "disabled:'disabled' in el ? !!el.disabled : false};"
    )
    if not isinstance(geometry, dict):
        raise StepError(f"native_click: selector not found: {selector}")
    if geometry.get("disabled"):
        raise StepError(f"native_click: target is disabled: {selector}")
    required = ("x", "y", "width", "height", "innerWidth", "innerHeight")
    if any(not isinstance(geometry.get(name), (int, float)) for name in required):
        raise StepError(f"native_click: invalid element geometry for {selector}")
    if geometry["width"] <= 0 or geometry["height"] <= 0:
        raise StepError(f"native_click: target has no visible area: {selector}")

    window_id, window_identity = _activate_x11_application(ctx.session.application)
    coordinates = ctx.session.pointer_click(selector)
    time.sleep(0.5)

    postcondition = ctx.session.execute(
        "const el = document.activeElement;"
        "return {activeTestId:el?.getAttribute('data-testid') ?? null,"
        "checked:el instanceof HTMLInputElement ? el.checked : null};"
    )
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "selector": selector,
        "css_geometry": geometry,
        "viewport_coordinates": coordinates,
        "transport": "W3C pointer actions -> packaged WebKitGTK session",
        "result": "pointer-click-injected; testcase DOM postcondition is authoritative",
        "postcondition": postcondition,
    }
    (ctx.case_dir / "native-pointer-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return f"injected X11 pointer click into {selector}"


@_verb("native_pointer_drag")
def _do_native_pointer_drag(ctx: NativeStepContext, args: Any) -> str:
    """Drag between CodeMirror line/column coordinates in the packaged app."""
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_pointer_drag: requires a Linux X11 display")
    if not isinstance(args, dict) or not isinstance(args.get("selector"), str):
        raise StepError(
            "native_pointer_drag: expected {selector, from:{line,column}, "
            "to:{line,column}, modifiers?}"
        )
    selector = args["selector"]
    start = args.get("from")
    end = args.get("to")
    modifiers = args.get("modifiers", [])
    if not all(isinstance(point, dict) for point in (start, end)):
        raise StepError("native_pointer_drag: from/to must be line/column objects")
    for label, point in (("from", start), ("to", end)):
        if not isinstance(point.get("line"), int) or point["line"] < 1:
            raise StepError(f"native_pointer_drag: {label}.line must be >= 1")
        if not isinstance(point.get("column"), int) or point["column"] < 0:
            raise StepError(f"native_pointer_drag: {label}.column must be >= 0")
    if not isinstance(modifiers, list) or any(
        modifier not in {"Alt", "Control", "Meta", "Shift"} for modifier in modifiers
    ):
        raise StepError(
            "native_pointer_drag: modifiers must contain only Alt/Control/Meta/Shift"
        )

    geometry = ctx.session.execute(
        f"const root = document.querySelector({json.dumps(selector)});"
        "if (!(root instanceof HTMLElement)) return null;"
        "const lines = Array.from(root.querySelectorAll('.cm-line'));"
        f"const points = {json.dumps([start, end])};"
        "const locate = ({line,column}) => {"
        " const el = lines[line - 1];"
        " if (!(el instanceof HTMLElement) || column > (el.textContent?.length ?? 0)) return null;"
        " const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);"
        " let node = walker.nextNode(), remaining = column;"
        " while (node && remaining > (node.textContent?.length ?? 0)) {"
        "  remaining -= node.textContent?.length ?? 0; node = walker.nextNode();"
        " }"
        " if (!(node instanceof Text)) return null;"
        " const range = document.createRange();"
        " range.setStart(node, remaining); range.collapse(true);"
        " const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();"
        " const lineRect = el.getBoundingClientRect();"
        " return {x:Math.round(caret.x), y:Math.round(lineRect.y + lineRect.height / 2),"
        "  lineLength:el.textContent?.length ?? 0};"
        "};"
        "const resolved = points.map(locate);"
        "if (resolved.some(point => point === null)) return null;"
        "return {start:resolved[0],end:resolved[1],lineCount:lines.length,"
        " innerWidth:window.innerWidth,innerHeight:window.innerHeight};"
    )
    if not isinstance(geometry, dict):
        raise StepError(
            "native_pointer_drag: selector or requested line/column geometry is unavailable"
        )
    resolved_start = geometry.get("start")
    resolved_end = geometry.get("end")
    if not all(isinstance(point, dict) for point in (resolved_start, resolved_end)):
        raise StepError("native_pointer_drag: invalid resolved geometry")
    for point in (resolved_start, resolved_end):
        if not all(isinstance(point.get(axis), (int, float)) for axis in ("x", "y")):
            raise StepError("native_pointer_drag: invalid viewport coordinates")

    window_id, window_identity = _activate_x11_application(ctx.session.application)
    coordinates = ctx.session.pointer_drag(resolved_start, resolved_end, modifiers)
    time.sleep(0.5)
    postcondition = ctx.session.execute(
        f"const root = document.querySelector({json.dumps(selector)});"
        "return {focused:document.activeElement === root,"
        " selectionRectCount:root?.parentElement?.querySelectorAll('.cm-selectionBackground').length ?? 0,"
        " cursorCount:root?.parentElement?.querySelectorAll('.cm-cursor').length ?? 0};"
    )
    artifact = {
        "platform": platform.platform(),
        "display": os.environ.get("DISPLAY"),
        "active_window": window_id,
        "window_identity": window_identity,
        "selector": selector,
        "requested": {"from": start, "to": end, "modifiers": modifiers},
        "resolved": {
            "coordinates": coordinates,
            "fromLineLength": resolved_start.get("lineLength"),
            "toLineLength": resolved_end.get("lineLength"),
        },
        "transport": "W3C modifier + pointer actions -> packaged WebKitGTK session",
        "result": "pointer-drag-injected; testcase DOM postcondition is authoritative",
        "postcondition": postcondition,
    }
    (ctx.case_dir / "native-pointer-drag-observation.json").write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return (
        f"dragged {selector} from line {start['line']} column {start['column']} "
        f"to line {end['line']} column {end['column']}"
    )


@_verb("native_ime_keys")
def _do_native_ime_keys(ctx: NativeStepContext, args: Any) -> str:
    """Inject physical X11 keys through the configured fcitx5 engine.

    This is native Linux IME evidence. W3C WebDriver keys and browser
    composition events deliberately do not enter this path.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_ime_keys: requires a Linux X11 display")
    if not isinstance(args, dict):
        raise StepError("native_ime_keys: expected {selector, expected_engine, keys}")
    selector = args.get("selector")
    expected_engine = args.get("expected_engine")
    keys = args.get("keys")
    if not isinstance(selector, str) or not selector:
        raise StepError("native_ime_keys: selector must be a non-empty string")
    if not isinstance(expected_engine, str) or not expected_engine:
        raise StepError("native_ime_keys: expected_engine must be a non-empty string")
    if not isinstance(keys, list) or not keys or not all(isinstance(key, str) for key in keys):
        raise StepError("native_ime_keys: keys must be a non-empty string array")

    focused = ctx.session.execute(
        f"const el = document.querySelector({json.dumps(selector)});"
        "return !!el && (document.activeElement === el || el.contains(document.activeElement));"
    )
    if not focused:
        raise StepError(
            f"native_ime_keys: target must already have DOM focus before native injection: {selector}"
        )
    time.sleep(0.25)
    window_id, window_identity = _activate_x11_application(ctx.session.application)
    prior_state = _command_output(["fcitx5-remote"])
    prior_engine = _command_output(["fcitx5-remote", "-n"])

    try:
        if prior_engine != expected_engine:
            _command_output(["fcitx5-remote", "-s", expected_engine])
            time.sleep(0.25)
        engine = _command_output(["fcitx5-remote", "-n"])
        if engine != expected_engine:
            raise StepError(
                f"native_ime_keys: could not select engine {expected_engine!r}; current {engine!r}"
            )
        if prior_state != "2":
            _command_output(["fcitx5-remote", "-o"])
            time.sleep(0.25)
        if _command_output(["fcitx5-remote"]) != "2":
            raise StepError("native_ime_keys: fcitx5 did not enter active state")
        _inject_x11_keys(keys)
        time.sleep(0.5)
        artifact = {
            "platform": platform.platform(),
            "display": os.environ.get("DISPLAY"),
            "engine": engine,
            "active_window": window_id,
            "window_identity": window_identity,
            "keys": keys,
            "transport": "X11 XTest -> fcitx5 -> GTK/WebKitGTK",
            "result": "keys-injected; testcase DOM postcondition is authoritative",
        }
        (ctx.case_dir / "native-ime-observation.json").write_text(
            json.dumps(artifact, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    finally:
        if prior_engine != expected_engine:
            subprocess.run(["fcitx5-remote", "-s", prior_engine], check=False)
        if prior_state != "2":
            subprocess.run(["fcitx5-remote", "-c"], check=False)
    return f"injected {len(keys)} X11 keys through fcitx5 engine {engine}"


@_verb("native_clipboard_owner")
def _do_native_clipboard_owner(ctx: NativeStepContext, args: Any) -> str:
    """Drive an external X11 CLIPBOARD selection owner.

    actions:
      grant   - own the CLIPBOARD selection with `text`, so the app's next read
                genuinely crosses the OS boundary and returns that value.
      deny    - replace the text owner with one that advertises standard text
                targets but rejects their conversion, so clients fail immediately.
      suspend - SIGSTOP the owner. It keeps the selection but stops answering
                SelectionRequest, so every client's read fails after the X11
                timeout. This is a real OS-level clipboard denial, not a stub.
      resume  - resume a suspended owner or replace a denying owner with a text
                owner carrying the last granted payload; reads succeed again.
      release - terminate the owner and record the host-selection replacement.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("native_clipboard_owner: requires a Linux X11 display")
    if not isinstance(args, dict) or "action" not in args:
        raise StepError("native_clipboard_owner: expected {action, text?}")
    action = str(args["action"])
    if action not in {"grant", "deny", "suspend", "resume", "release"}:
        raise StepError(f"native_clipboard_owner: unsupported action {action!r}")

    if action == "grant":
        text = args.get("text")
        if not isinstance(text, str) or not text:
            raise StepError("native_clipboard_owner: grant requires a non-empty text")
        if not ctx._host_clipboard_captured:
            # Snapshot metadata for the developer's real selection exactly once
            # so teardown can disclose its replacement without retaining text.
            before = _read_x11_clipboard(timeout=15.0)
            ctx._host_clipboard_before = before.get("text") if before.get("ok") else None
            ctx._host_clipboard_captured = True
        ctx._release_clipboard_owner()
        owner = _spawn_clipboard_owner(text)
        _GRANTED_CLIPBOARD_TEXTS.add(text)
        ctx._clipboard_owner = owner
        ctx._clipboard_owner_suspended = False
        ctx._clipboard_owner_mode = "grant"
        ctx._clipboard_owner_text = text
        observed = _read_x11_clipboard(timeout=20.0)
        if not observed.get("ok") or observed.get("text") != text:
            ctx._release_clipboard_owner()
            raise StepError(
                "native_clipboard_owner: grant postcondition failed; external read returned "
                f"{observed!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": owner.pid,
            "grantedLength": len(text),
            "externalReadOk": True,
        })
        return f"external X11 owner {owner.pid} holds CLIPBOARD ({len(text)} chars)"

    owner = ctx._clipboard_owner
    if action == "release":
        ctx._release_clipboard_owner()
        ctx._clipboard_owner_text = None
        ctx._restore_host_clipboard()
        _append_clipboard_observation(ctx, {"action": action, "ownerPid": owner.pid if owner else None})
        return "external X11 clipboard owner released; host selection replacement recorded"

    if owner is None:
        raise StepError(f"native_clipboard_owner: {action} requires a granted owner")
    if owner.poll() is not None:
        raise StepError(f"native_clipboard_owner: owner exited with {owner.returncode}")

    if action == "deny":
        if ctx._clipboard_owner_mode != "grant" or ctx._clipboard_owner_suspended:
            raise StepError("native_clipboard_owner: deny requires an active granted owner")
        granted_text = ctx._clipboard_owner_text
        if granted_text is None:
            raise StepError("native_clipboard_owner: deny has no granted payload to preserve")
        ctx._release_clipboard_owner()
        denying_owner = _spawn_clipboard_owner(deny_text_conversion=True)
        ctx._clipboard_owner = denying_owner
        ctx._clipboard_owner_mode = "deny"
        probe = _read_x11_clipboard(timeout=5.0)
        if probe.get("ok"):
            ctx._release_clipboard_owner()
            raise StepError(
                "native_clipboard_owner: deny exposed a readable text target; external read "
                f"succeeded with {probe.get('text')!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": denying_owner.pid,
            "ownerMode": "text-targets-reject-conversion",
            "preservedGrantLength": len(granted_text),
            "externalReadOk": False,
            "externalReadError": probe.get("error"),
        })
        return (
            f"owner {denying_owner.pid} denies X11 text conversion; "
            f"external X11 read denied ({probe.get('error')})"
        )

    if action == "suspend":
        if ctx._clipboard_owner_mode != "grant":
            raise StepError("native_clipboard_owner: suspend requires an active granted owner")
        os.kill(owner.pid, signal.SIGSTOP)
        ctx._clipboard_owner_suspended = True
        time.sleep(0.3)
        state = _process_state(owner.pid)
        if state not in {"T", "t"}:
            raise StepError(
                f"native_clipboard_owner: owner {owner.pid} did not stop (state={state!r})"
            )
        # Prove the denial is real before the app is asked to read: an external
        # client must also fail against this owner.
        probe = _read_x11_clipboard(timeout=20.0)
        if probe.get("ok"):
            raise StepError(
                "native_clipboard_owner: suspend did not deny X11 reads; external read still "
                f"succeeded with {probe.get('text')!r}"
            )
        _append_clipboard_observation(ctx, {
            "action": action,
            "ownerPid": owner.pid,
            "ownerProcState": state,
            "externalReadOk": False,
            "externalReadError": probe.get("error"),
        })
        return f"owner {owner.pid} suspended; external X11 read denied ({probe.get('error')})"

    if ctx._clipboard_owner_mode == "deny":
        granted_text = ctx._clipboard_owner_text
        if granted_text is None:
            raise StepError("native_clipboard_owner: resume has no granted payload to restore")
        ctx._release_clipboard_owner()
        owner = _spawn_clipboard_owner(granted_text)
        ctx._clipboard_owner = owner
        ctx._clipboard_owner_mode = "grant"
        resume_mode = "replaced-denying-owner"
    else:
        if not ctx._clipboard_owner_suspended:
            raise StepError("native_clipboard_owner: resume requires a denied or suspended owner")
        os.kill(owner.pid, signal.SIGCONT)
        ctx._clipboard_owner_suspended = False
        resume_mode = "continued-suspended-owner"
        time.sleep(0.3)
    probe = _read_x11_clipboard(timeout=20.0)
    if not probe.get("ok"):
        raise StepError(
            f"native_clipboard_owner: resume did not restore X11 reads: {probe.get('error')}"
        )
    _append_clipboard_observation(ctx, {
        "action": action,
        "ownerPid": owner.pid,
        "resumeMode": resume_mode,
        "ownerProcState": _process_state(owner.pid),
        "externalReadOk": True,
    })
    return f"owner {owner.pid} resumed; external X11 read restored"


def _process_state(pid: int) -> str | None:
    try:
        stat_line = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    # comm may contain spaces/parens; the state field follows the last ')'.
    tail = stat_line.rsplit(")", 1)[-1].split()
    return tail[0] if tail else None


@_verb("assert_system_clipboard")
def _do_assert_system_clipboard(ctx: NativeStepContext, args: Any) -> str:
    """Independently read the real X11 CLIPBOARD selection and assert it.

    This is the only step that can prove the app's copy actually reached the OS:
    the value is fetched by a separate process through a real X11 selection
    transfer, never from the app's DOM or its in-process clipboard state.
    """
    if platform.system() != "Linux" or not os.environ.get("DISPLAY"):
        raise StepError("assert_system_clipboard: requires a Linux X11 display")
    if not isinstance(args, dict):
        raise StepError("assert_system_clipboard: expected {equals|contains|readable}")
    keys = {"equals", "contains", "readable"} & set(args)
    if len(keys) != 1:
        raise StepError("assert_system_clipboard: pass exactly one of equals/contains/readable")

    observed = _read_x11_clipboard(timeout=float(args.get("timeout_sec", 30.0)))
    ok = bool(observed.get("ok"))
    text = observed.get("text") if ok else None

    if "readable" in args:
        expected_readable = bool(args["readable"])
        if ok != expected_readable:
            raise StepError(
                f"assert_system_clipboard: expected readable={expected_readable}, observed "
                f"ok={ok} error={observed.get('error')!r}"
            )
        summary = f"readable={ok}"
    else:
        if not ok:
            raise StepError(
                f"assert_system_clipboard: external X11 read failed: {observed.get('error')}"
            )
        if "equals" in args:
            expected = str(args["equals"])
            if text != expected:
                raise StepError(
                    "assert_system_clipboard: OS clipboard mismatch; expected "
                    f"{expected!r} of {len(expected)} chars, observed {len(text or '')} chars"
                )
            summary = f"equals {len(expected)} chars"
        else:
            needle = str(args["contains"])
            if needle not in (text or ""):
                raise StepError(
                    f"assert_system_clipboard: OS clipboard does not contain {needle!r}"
                )
            summary = f"contains {len(needle)} chars"

    _append_clipboard_observation(ctx, {
        "action": "assert",
        "assertion": sorted(keys)[0],
        "externalReadOk": ok,
        "externalReadError": observed.get("error"),
        "observedLength": len(text) if isinstance(text, str) else None,
        "observedSha256": hashlib.sha256(text.encode("utf-8")).hexdigest()
        if isinstance(text, str) else None,
    })
    return f"external X11 CLIPBOARD assertion passed ({summary})"


@_verb("seed_storage")
def _do_seed_storage(ctx: NativeStepContext, args: Any) -> str:
    """Seed one localStorage entry (see steps/persistence.py rationale)."""
    if not isinstance(args, dict) or "key" not in args or "value" not in args:
        raise StepError("seed_storage: expected {key, value}")
    key = str(args["key"])
    value = str(args["value"])
    import json as _json
    try:
        _json.loads(value)
    except ValueError as e:
        raise StepError(f"seed_storage: value must be valid JSON ({e})") from e
    ctx.session.execute(
        f"window.localStorage.setItem({_json.dumps(key)}, {_json.dumps(value)});"
        "return window.localStorage.getItem(" + _json.dumps(key) + ") !== null;"
    )
    return f"seeded {key}"


@_verb("reload_window")
def _do_reload_window(ctx: NativeStepContext, args: Any) -> str:
    """Reload the webview document; wait for the app shell to return."""
    _ = args
    ctx.session.execute(
        "window.setTimeout(() => window.location.reload(), 0); return true;"
    )
    time.sleep(2.0)  # document teardown; execute/sync is unavailable during it
    ctx.session.find("[data-testid='welcome-panel']", timeout=60)
    # The reload dropped the console hook along with the old document.
    ctx.session.install_console_hook()
    return "reloaded; welcome-panel visible"


@_verb("vault_first_run")
def _do_vault_first_run(ctx: NativeStepContext, args: Any) -> str:
    """Complete the empty-vault first-run master-password gate.

    Fresh isolated app-data => vault.db is empty => the app shows the setup
    dialog. Fills both fields with the given QA password and confirms. If a
    LOCKED vault shows the unlock dialog instead, fail loudly: the password
    is unknown and guessing would be dishonest. If the main UI is already
    reachable, this is a no-op.
    """
    password = str(args)
    deadline = time.time() + 20
    while time.time() < deadline:
        if _find_quiet(ctx, "[data-testid='vault-setup-dialog']"):
            break
        if _find_quiet(ctx, "[data-testid='vault-unlock-dialog']"):
            raise StepError(
                "vault_first_run: vault is LOCKED with an unknown master "
                "password; run against a fresh isolated profile"
            )
        if _find_quiet(ctx, "[data-testid='welcome-panel']"):
            return "vault already unlocked; no-op"
        time.sleep(0.5)
    else:
        raise StepError("vault_first_run: neither vault dialog nor welcome-panel appeared")
    ctx.session.fill("[data-testid='vault-setup-pw1']", password)
    ctx.session.fill("[data-testid='vault-setup-pw2']", password)
    ctx.session.click("[data-testid='vault-setup-confirm']")
    ctx.session.wait_absent("[data-testid='vault-setup-dialog']", timeout=30)
    return "vault master password set"


def _find_quiet(ctx: NativeStepContext, selector: str) -> bool:
    try:
        ctx.session.find(selector, timeout=0.5)
        return True
    except Exception:  # noqa: BLE001
        return False


def run_native_step(ctx: NativeStepContext, verb: str, args: Any) -> str:
    fn = VERBS.get(verb)
    if fn is None:
        raise StepError(
            f"native runner does not support verb {verb!r}; supported: {sorted(VERBS)}"
        )
    return fn(ctx, args)
