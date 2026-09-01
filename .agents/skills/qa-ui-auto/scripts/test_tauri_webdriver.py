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


class NativeKeysVerbTest(TestCase):
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
                    {"selector": "#encoding", "keys": ["Tab", "Space"]},
                )

            self.assertEqual(result, "injected 2 X11 keys into focused native control")
            activate.assert_called_once_with(session.application)
            inject.assert_called_once_with(["Tab", "Space"])
            artifact = json.loads(
                (case_dir / "native-key-observation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["transport"], "X11 XTest -> GTK/WebKitGTK")
            self.assertEqual(artifact["keys"], ["Tab", "Space"])
            self.assertNotIn("text", artifact)


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
