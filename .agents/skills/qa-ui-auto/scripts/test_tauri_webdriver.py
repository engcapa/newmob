import json
import os
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, call, patch

from qa_ui_auto import native_steps
from tauri_webdriver import NativeSession


class NativeSessionFillTest(TestCase):
    def session(self, contenteditable: bool, focus_results: list[bool] | None = None) -> NativeSession:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.find = Mock(return_value="element-1")
        session.request = Mock(return_value=None)
        execute_results: list[bool] = [contenteditable]
        if contenteditable:
            execute_results.extend(focus_results or [True])
        session.execute = Mock(side_effect=execute_results)
        session.press_combo = Mock(return_value="")
        session.type_text = Mock(return_value="")
        return session

    def test_contenteditable_fill_uses_real_key_actions(self) -> None:
        session = self.session(True)

        result = session.fill(".cm-content", "cafe\r\nmatrix\n")

        self.assertEqual(result, "filled contenteditable .cm-content")
        session.execute.assert_any_call(
            'const el = document.querySelector(".cm-content");'
            "return !!el?.isContentEditable;"
        )
        session.execute.assert_any_call(
            'const el = document.querySelector(".cm-content");'
            "return !!el && document.activeElement === el;"
        )
        session.press_combo.assert_has_calls([
            call("Control+a"),
            call("Enter"),
            call("Enter"),
        ])
        session.type_text.assert_has_calls([call("cafe"), call("matrix")])
        self.assertFalse(any(args[1].endswith("/value") for args, _ in session.request.call_args_list))

    def test_contenteditable_fill_retries_real_click_until_focused(self) -> None:
        session = self.session(True, [False, True])

        session.fill(".cm-content", "text")

        click_call = call("POST", "/session/session-1/element/element-1/click", {})
        self.assertEqual(session.request.call_args_list.count(click_call), 2)

    def test_input_fill_preserves_clear_and_value_contract(self) -> None:
        session = self.session(False)

        result = session.fill("input[name=title]", "Taomni")

        self.assertEqual(result, "filled input[name=title]")
        self.assertIn(
            call("POST", "/session/session-1/element/element-1/clear", {}),
            session.request.call_args_list,
        )
        self.assertIn(
            call(
                "POST",
                "/session/session-1/element/element-1/value",
                {"text": "Taomni", "value": list("Taomni")},
            ),
            session.request.call_args_list,
        )
        session.press_combo.assert_not_called()
        session.type_text.assert_not_called()

    def test_type_text_paces_contenteditable_key_transactions(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        session.type_text("ab")

        actions = session.request.call_args.args[2]["actions"][0]["actions"]
        self.assertEqual(
            actions,
            [
                {"type": "keyDown", "value": "a"},
                {"type": "keyUp", "value": "a"},
                {"type": "pause", "duration": 20},
                {"type": "keyDown", "value": "b"},
                {"type": "keyUp", "value": "b"},
                {"type": "pause", "duration": 20},
            ],
        )


class NativeSessionPointerClickTest(TestCase):
    def test_pointer_click_uses_viewport_w3c_actions(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.find = Mock(return_value="element-1")
        session.request = Mock(side_effect=[
            {"x": 40, "y": 30, "width": 20, "height": 10},
            None,
        ])

        result = session.pointer_click("#bom")

        self.assertEqual(result, {"x": 50, "y": 35})
        action = session.request.call_args_list[1].args[2]["actions"][0]
        self.assertEqual(action["parameters"], {"pointerType": "mouse"})
        self.assertEqual(action["actions"][0], {
            "type": "pointerMove",
            "duration": 100,
            "x": 50,
            "y": 35,
            "origin": "viewport",
        })
        self.assertEqual(action["actions"][1]["type"], "pointerDown")
        self.assertEqual(action["actions"][-1]["type"], "pointerUp")

    def test_pointer_drag_holds_modifier_across_viewport_drag(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        result = session.pointer_drag(
            {"x": 30, "y": 40},
            {"x": 80, "y": 90},
            ["Alt"],
        )

        self.assertEqual(result, {
            "start": {"x": 30, "y": 40},
            "end": {"x": 80, "y": 90},
        })
        payload = session.request.call_args_list[0].args[2]
        keyboard, pointer = payload["actions"]
        self.assertEqual(keyboard["actions"][0], {"type": "keyDown", "value": "\ue00a"})
        self.assertEqual(keyboard["actions"][-1], {"type": "keyUp", "value": "\ue00a"})
        self.assertEqual(pointer["parameters"], {"pointerType": "mouse"})
        self.assertEqual(pointer["actions"][1]["x"], 30)
        self.assertEqual(pointer["actions"][3]["x"], 80)
        self.assertEqual(pointer["actions"][2]["type"], "pointerDown")
        self.assertEqual(pointer["actions"][5]["type"], "pointerUp")
        self.assertEqual(session.request.call_args_list[1].args[:2], (
            "DELETE", session.endpoint("/actions"),
        ))


class NativeSessionPressComboTest(TestCase):
    def test_press_combo_releases_webdriver_input_sources(self) -> None:
        session = NativeSession("http://driver.invalid", Path("/tmp/taomni"))
        session.session_id = "session-1"
        session.request = Mock(return_value=None)

        self.assertEqual(session.press_combo("Control+v"), "pressed Control+v")

        payload = session.request.call_args_list[0].args[2]
        actions = payload["actions"][0]["actions"]
        self.assertEqual(actions[0], {"type": "keyDown", "value": "\ue009"})
        self.assertEqual(actions[-1], {"type": "keyUp", "value": "\ue009"})
        self.assertEqual(session.request.call_args_list[1].args[:2], (
            "DELETE", session.endpoint("/actions"),
        ))


class NativeKeysVerbTest(TestCase):
    def test_x11_chord_maps_modifiers_before_the_character(self) -> None:
        self.assertEqual(
            native_steps._x11_keysyms_for_chord("Control+Shift+v"),
            [0xFFE3, 0xFFE1, ord("v")],
        )

    def test_native_keys_requires_focus_and_records_x11_transport(self) -> None:
        session = Mock()
        session.execute.return_value = True

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ) as activate,
                patch.object(native_steps, "_inject_x11_keys") as inject,
            ):
                result = native_steps.VERBS["native_keys"](
                    ctx,
                    {"selector": "#encoding", "keys": ["Tab", "Control+v"]},
                )

            self.assertEqual(result, "injected 2 X11 keys into focused native control")
            activate.assert_called_once_with(session.application)
            inject.assert_called_once_with(["Tab", "Control+v"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["transport"], "X11 XTest -> GTK/WebKitGTK")
            self.assertEqual(artifact["keys"], ["Tab", "Control+v"])
            self.assertNotIn("text", artifact)

    def test_native_keys_accepts_explicit_focus_precondition_during_driver_fault(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ),
                patch.object(native_steps, "_inject_x11_keys") as inject,
            ):
                native_steps.VERBS["native_keys"](
                    ctx,
                    {
                        "selector": ".cm-content",
                        "keys": ["Control+v"],
                        "focus_prechecked": True,
                    },
                )

            session.execute.assert_not_called()
            inject.assert_called_once_with(["Control+v"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["focus_verification"], "testcase precondition")


class NativeClickVerbTest(TestCase):
    def test_native_click_targets_exact_window_and_records_pointer_transport(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.execute.side_effect = [
            {
                "x": 100,
                "y": 50,
                "width": 20,
                "height": 10,
                "innerWidth": 600,
                "innerHeight": 400,
                "disabled": False,
            },
            {"activeTestId": "file-encoding-bom", "checked": True},
        ]
        session.pointer_click.return_value = {"x": 110, "y": 55}

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ) as activate,
            ):
                result = native_steps.VERBS["native_click"](
                    ctx,
                    {"selector": '[data-testid="file-encoding-bom"]'},
                )

            self.assertEqual(
                result,
                'injected X11 pointer click into [data-testid="file-encoding-bom"]',
            )
            activate.assert_called_once_with(session.application)
            session.pointer_click.assert_called_once_with('[data-testid="file-encoding-bom"]')
            artifact = json.loads(
                (case_dir / "native-pointer-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                artifact["transport"],
                "W3C pointer actions -> packaged WebKitGTK session",
            )
            self.assertEqual(artifact["postcondition"]["checked"], True)
            self.assertNotIn("text", artifact)


class NativePointerDragVerbTest(TestCase):
    def test_native_pointer_drag_resolves_geometry_and_records_no_source_text(self) -> None:
        session = Mock()
        session.application = Path("/tmp/taomni")
        session.execute.side_effect = [
            {
                "start": {"x": 110, "y": 60, "lineLength": 9},
                "end": {"x": 140, "y": 80, "lineLength": 8},
                "lineCount": 2,
                "innerWidth": 600,
                "innerHeight": 400,
            },
            {"focused": True, "selectionRectCount": 2, "cursorCount": 2},
        ]
        session.pointer_drag.return_value = {
            "start": {"x": 110, "y": 60},
            "end": {"x": 140, "y": 80},
        }

        with TemporaryDirectory() as directory:
            case_dir = Path(directory)
            ctx = native_steps.NativeStepContext(session, case_dir, {})
            with (
                patch.object(native_steps.platform, "system", return_value="Linux"),
                patch.dict(os.environ, {"DISPLAY": ":99"}),
                patch.object(
                    native_steps,
                    "_activate_x11_application",
                    return_value=("0x1", 'WM_CLASS = "taomni"'),
                ),
            ):
                result = native_steps.VERBS["native_pointer_drag"](
                    ctx,
                    {
                        "selector": ".cm-content",
                        "from": {"line": 1, "column": 1},
                        "to": {"line": 2, "column": 4},
                        "modifiers": ["Alt"],
                    },
                )

            self.assertIn("line 1 column 1", result)
            session.pointer_drag.assert_called_once_with(
                {"x": 110, "y": 60, "lineLength": 9},
                {"x": 140, "y": 80, "lineLength": 8},
                ["Alt"],
            )
            artifact = json.loads(
                (case_dir / "native-pointer-drag-observation.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(artifact["postcondition"]["selectionRectCount"], 2)
            self.assertEqual(artifact["requested"]["modifiers"], ["Alt"])
            self.assertNotIn("alpha", json.dumps(artifact))


class NativeFilesystemFaultTest(TestCase):
    def test_native_set_writable_is_report_scoped_and_records_modes(self) -> None:
        with TemporaryDirectory() as directory:
            report_root = Path(directory)
            case_dir = report_root / "TC-NATIVE"
            case_dir.mkdir()
            target = report_root / "native-workspaces" / "fixture"
            target.mkdir(parents=True, mode=0o700)
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})

            blocked = native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": False},
            )
            self.assertIn("writable=False", blocked)
            self.assertFalse(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)

            ctx.restore_host_permissions()
            self.assertTrue(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)

            native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": False},
            )
            restored = native_steps.VERBS["native_set_writable"](
                ctx,
                {"path": str(target), "writable": True},
            )
            self.assertIn("writable=True", restored)
            self.assertTrue(stat.S_IMODE(target.stat().st_mode) & stat.S_IWUSR)
            observations = json.loads(
                (case_dir / "native-permission-observations.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                [row["ownerWritable"] for row in observations],
                [False, False, True],
            )

    def test_assert_file_sha256_reads_real_host_bytes(self) -> None:
        with TemporaryDirectory() as directory:
            report_root = Path(directory)
            case_dir = report_root / "TC-NATIVE"
            case_dir.mkdir()
            target = report_root / "native-workspaces" / "fixture.txt"
            target.parent.mkdir()
            target.write_bytes(b"receipt bytes")
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})

            result = native_steps.VERBS["assert_file_sha256"](
                ctx,
                {
                    "path": str(target),
                    "equals": "9e85aa95f04db5f108534e48b63e75e8045a7ecab59988405e70a9260300a0d6",
                },
            )
            self.assertIn("host byte SHA-256 verified", result)


class NativeClipboardOwnerTest(TestCase):
    """Real X11 CLIPBOARD selection verbs (ED-CLIP-004).

    These exercise the actual selection transfer between two separate
    processes; they skip rather than fake it when no X11 display exists,
    because a stubbed clipboard would prove nothing about the OS boundary.
    """

    def setUp(self) -> None:
        if os.name != "posix" or not os.environ.get("DISPLAY"):
            self.skipTest("requires a Linux X11 display")

    def test_grant_suspend_resume_crosses_the_real_x11_boundary(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            try:
                granted = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "grant", "text": "qa-clipboard-owner-payload"}
                )
                self.assertIn("holds CLIPBOARD", granted)

                # An independent process reads the exact granted value.
                equal = native_steps.VERBS["assert_system_clipboard"](
                    ctx, {"equals": "qa-clipboard-owner-payload"}
                )
                self.assertIn("assertion passed", equal)

                # Suspending the owner denies every client's read.
                suspended = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "suspend"}
                )
                self.assertIn("external X11 read denied", suspended)
                self.assertIn(
                    "readable=False",
                    native_steps.VERBS["assert_system_clipboard"](ctx, {"readable": False}),
                )
                with self.assertRaises(native_steps.StepError):
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"equals": "qa-clipboard-owner-payload"}
                    )

                resumed = native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "resume"})
                self.assertIn("external X11 read restored", resumed)
                self.assertIn(
                    "assertion passed",
                    native_steps.VERBS["assert_system_clipboard"](ctx, {"readable": True}),
                )
            finally:
                ctx.restore_host_permissions()

            observations = json.loads(
                (case_dir / "native-clipboard-observations.json").read_text(encoding="utf-8")
            )
            # The `equals` assertion that correctly raised under denial records
            # nothing: an observation is appended only for a passing assertion.
            self.assertEqual(
                [row["action"] for row in observations],
                ["grant", "assert", "suspend", "assert", "resume", "assert"],
            )
            denied = [row for row in observations if row["action"] == "suspend"][0]
            self.assertFalse(denied["externalReadOk"])
            self.assertIn(denied["ownerProcState"], {"T", "t"})

    def test_grant_deny_resume_crosses_the_real_x11_boundary(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            try:
                native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "grant", "text": "qa-clipboard-deny-payload"}
                )
                granted_owner = ctx._clipboard_owner

                denied = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "deny"}
                )
                self.assertIn("denies X11 text conversion", denied)
                self.assertIsNotNone(granted_owner.poll())
                self.assertEqual(ctx._clipboard_owner_mode, "deny")
                self.assertIn(
                    "readable=False",
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"readable": False, "timeout_sec": 5}
                    ),
                )

                denying_owner = ctx._clipboard_owner
                resumed = native_steps.VERBS["native_clipboard_owner"](
                    ctx, {"action": "resume"}
                )
                self.assertIn("external X11 read restored", resumed)
                self.assertIsNotNone(denying_owner.poll())
                self.assertEqual(ctx._clipboard_owner_mode, "grant")
                self.assertIn(
                    "assertion passed",
                    native_steps.VERBS["assert_system_clipboard"](
                        ctx, {"equals": "qa-clipboard-deny-payload"}
                    ),
                )
            finally:
                ctx.restore_host_permissions()

            observations = json.loads(
                (case_dir / "native-clipboard-observations.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                [row["action"] for row in observations],
                ["grant", "deny", "assert", "resume", "assert"],
            )
            denied = [row for row in observations if row["action"] == "deny"][0]
            self.assertFalse(denied["externalReadOk"])
            self.assertEqual(denied["ownerMode"], "text-targets-reject-conversion")
            resumed = [row for row in observations if row["action"] == "resume"][0]
            self.assertEqual(resumed["resumeMode"], "replaced-denying-owner")

    def test_teardown_releases_the_owner_process(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            native_steps.VERBS["native_clipboard_owner"](
                ctx, {"action": "grant", "text": "qa-clipboard-teardown"}
            )
            owner = ctx._clipboard_owner
            self.assertIsNotNone(owner)
            native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "suspend"})
            ctx.restore_host_permissions()
            self.assertIsNone(ctx._clipboard_owner)
            self.assertIsNotNone(owner.poll())

    def test_teardown_does_not_republish_its_own_payload_as_host_state(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            native_steps.VERBS["native_clipboard_owner"](
                ctx, {"action": "grant", "text": "qa-clipboard-not-host-state"}
            )
            ctx.restore_host_permissions()

            # A LATER case snapshotting what an earlier case granted must not
            # treat it as host state: the guard is process-wide, so one case
            # cannot republish another case's payload as a restore.
            later = native_steps.NativeStepContext(Mock(), case_dir, {})
            later._host_clipboard_before = "qa-clipboard-not-host-state"
            later._host_clipboard_captured = True
            with patch.object(native_steps, "_spawn_clipboard_owner") as spawn:
                later.restore_host_permissions()
            spawn.assert_not_called()

            # Teardown discloses the replacement instead of faking a restore.
            host_state = json.loads(
                (case_dir / "native-clipboard-host-state.json").read_text(encoding="utf-8")
            )
            self.assertTrue(host_state["hostSelectionReplaced"])
            self.assertFalse(host_state["hostSelectionRestored"])
            self.assertTrue(host_state["priorSelectionWasHarnessPayload"])

    def test_suspend_without_grant_fails_loudly(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["native_clipboard_owner"](ctx, {"action": "suspend"})

    def test_assert_system_clipboard_rejects_ambiguous_assertions(self) -> None:
        with TemporaryDirectory() as directory:
            case_dir = Path(directory) / "TC-NATIVE"
            case_dir.mkdir()
            ctx = native_steps.NativeStepContext(Mock(), case_dir, {})
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["assert_system_clipboard"](
                    ctx, {"equals": "a", "readable": True}
                )
            with self.assertRaises(native_steps.StepError):
                native_steps.VERBS["assert_system_clipboard"](ctx, {})
