"""Protect production state across QA build, launch, and fixture cleanup."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import native_build
import tauri_webdriver as native
from qa_ui_auto import __main__ as cli, native_steps, runner
from qa_ui_auto.fixtures import reset_db


def recorded_binary(root: Path) -> Path:
    binary = root / "taomni"
    binary.write_bytes(b"test executable; never launched")
    native_build.identity_path(binary).write_text(json.dumps({
        "identifier": native_build.QA_APP_ID,
        "binary_sha256": native_build.binary_digest(binary),
    }), encoding="utf-8")
    return binary


class NativeBuildTest(unittest.TestCase):
    def test_build_records_exact_output_in_separate_target_for_each_os(self):
        for system, release in [("Linux", False), ("Windows", False), ("Darwin", True)]:
            with self.subTest(system=system), TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / "src-tauri" / "target" / "qa-ui-auto"
                expected = target / ("release" if release else "debug") / (
                    "taomni.exe" if system == "Windows" else "taomni")

                def compile_binary(command, *, cwd, env, check):
                    self.assertEqual(cwd, root)
                    self.assertTrue(check)
                    self.assertEqual(env["CARGO_TARGET_DIR"], str(target))
                    self.assertNotIn("TAURI_CONFIG", env)
                    self.assertEqual(command[command.index("--config") + 1], str(native_build.QA_CONFIG))
                    self.assertEqual("--debug" in command, not release)
                    expected.parent.mkdir(parents=True)
                    expected.write_bytes(b"new QA build")

                with (
                    patch.object(native_build, "ROOT", root),
                    patch.object(native_build.platform, "system", return_value=system),
                    patch.object(native_build.shutil, "which", return_value="pnpm"),
                    patch.object(native_build.subprocess, "run", side_effect=compile_binary),
                    patch.dict(os.environ, {"TAURI_CONFIG": '{"identifier":"com.taomni.app"}'}),
                ):
                    binary = native_build.build_qa(release=release)
                self.assertEqual(binary, expected)
                record = native_build.verify_identity(binary)
                self.assertEqual(record["identifier"], native_build.QA_APP_ID)
                self.assertEqual(record["platform"], system)

    def test_failed_rebuild_invalidates_old_authorization(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "src-tauri" / "target" / "qa-ui-auto" / "debug"
            output.mkdir(parents=True)
            binary = recorded_binary(output)
            with (
                patch.object(native_build, "ROOT", root),
                patch.object(native_build.platform, "system", return_value="Linux"),
                patch.object(native_build.shutil, "which", return_value="pnpm"),
                patch.object(native_build.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "pnpm")),
            ):
                with self.assertRaises(subprocess.CalledProcessError):
                    native_build.build_qa()
            self.assertTrue(binary.exists())
            with self.assertRaises(ValueError):
                native_build.verify_identity(binary)

    def test_missing_production_malformed_and_replaced_binaries_are_rejected(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for record in [None, "invalid json", "[]", json.dumps({
                "identifier": "com.taomni.app",
                "binary_sha256": native_build.binary_digest(recorded_binary(root)),
            })]:
                with self.subTest(record=record):
                    binary = recorded_binary(root)
                    path = native_build.identity_path(binary)
                    if record is None:
                        path.unlink()
                    else:
                        path.write_text(record, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        native_build.verify_identity(binary)
            binary = recorded_binary(root)
            binary.write_bytes(b"replaced executable")
            with self.assertRaises(ValueError):
                native_build.verify_identity(binary)


class NativeIsolationTest(unittest.TestCase):
    def test_harness_restores_environment_after_success_and_start_failure(self):
        for fails in (False, True):
            with self.subTest(fails=fails), TemporaryDirectory() as directory:
                root = Path(directory)
                binary = recorded_binary(root)
                harness = native.NativeHarness({"app": {"native_binary": str(binary)}}, root / "run")
                harness.driver = Mock()
                if fails:
                    harness.driver.start.side_effect = native.WebDriverError("start failure")
                with patch.object(native.platform, "system", return_value="Linux"), patch.dict(os.environ, {}, clear=False):
                    before = dict(os.environ)
                    try:
                        with harness:
                            self.assertEqual(os.environ["XDG_DATA_HOME"], str(root / "run" / "native-appdata"))
                            self.assertEqual(os.environ["XDG_CACHE_HOME"], str(root / "run" / "native-appcache"))
                    except native.WebDriverError:
                        if not fails:
                            raise
                    self.assertEqual(dict(os.environ), before)
                harness.driver.stop.assert_called_once()
                evidence = json.loads((root / "run" / "native-isolation.json").read_text())
                self.assertEqual(evidence["identifier"], native_build.QA_APP_ID)

    def test_unrecorded_binary_never_starts_driver(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "production"
            binary.write_bytes(b"production")
            harness = native.NativeHarness({"app": {"native_binary": str(binary)}}, root / "run")
            harness.driver = Mock()
            with self.assertRaises(native.WebDriverError):
                harness.__enter__()
            harness.driver.start.assert_not_called()
            self.assertFalse((root / "run").exists())

    def test_reset_clears_only_qa_state_for_linux_and_windows(self):
        for system in ("Linux", "Windows"):
            with self.subTest(system=system), TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.object(native.platform, "system", return_value=system):
                    env = native.native_isolation_env(root / "run")
                    keep = []
                    for value in env.values():
                        for app_id in (native_build.QA_APP_ID, "com.taomni.app"):
                            data = Path(value) / app_id
                            data.mkdir(parents=True, exist_ok=True)
                            (data / "taomni.db").write_bytes(b"keep production")
                            if app_id == "com.taomni.app":
                                keep.append(data / "taomni.db")
                    legacy = root / "legacy-user-directory"
                    legacy.mkdir()
                    with patch.dict(os.environ, {**env, "NEWMOB_DATA_DIR": str(legacy)}):
                        reset_db._reset_native(SimpleNamespace(report_root=root / "run"))
                    for path in keep:
                        self.assertEqual(path.read_bytes(), b"keep production")
                    self.assertTrue(legacy.is_dir())
                    for value in env.values():
                        self.assertFalse((Path(value) / native_build.QA_APP_ID).exists())

    def test_reset_refuses_missing_or_wrong_run_environment(self):
        with TemporaryDirectory() as directory, patch.object(native.platform, "system", return_value="Linux"):
            with self.assertRaises(RuntimeError):
                reset_db._reset_native(SimpleNamespace())
            with patch.dict(os.environ, {"XDG_DATA_HOME": directory}):
                with self.assertRaises(RuntimeError):
                    reset_db._reset_native(SimpleNamespace(report_root=Path(directory) / "run"))

    @unittest.skipIf(os.name == "nt", "symlink creation requires extra Windows privileges")
    def test_reset_rejects_symlink_escape_before_any_cleanup(self):
        with TemporaryDirectory() as directory, patch.object(native.platform, "system", return_value="Linux"):
            root = Path(directory)
            outside = root / "production"
            outside.mkdir()
            (outside / "taomni.db").write_bytes(b"production")
            env = native.native_isolation_env(root / "run")
            for key, value in env.items():
                profile = Path(value) / native_build.QA_APP_ID
                profile.parent.mkdir(parents=True)
                if key == "XDG_CACHE_HOME":
                    profile.symlink_to(outside, target_is_directory=True)
                else:
                    profile.mkdir()
            with patch.dict(os.environ, env), self.assertRaises(native.WebDriverError):
                reset_db._reset_native(SimpleNamespace(report_root=root / "run"))
            self.assertEqual((outside / "taomni.db").read_bytes(), b"production")
            self.assertTrue((Path(env["XDG_DATA_HOME"]) / native_build.QA_APP_ID).is_dir())

    def test_x11_activation_uses_exact_qa_executable_despite_product_name(self):
        qa_binary = Path("/test/qa/taomni")
        real_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            if str(path) == "/proc/101/exe":
                return qa_binary
            if str(path) == "/proc/102/exe":
                return Path("/test/production/taomni")
            return real_resolve(path, *args, **kwargs)

        outputs = [
            "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1, 0x2",
            'WM_CLASS(STRING) = "taomni", "Taomni"\n_NET_WM_PID(CARDINAL) = 102',
            'WM_CLASS(STRING) = "taomni-qa", "Taomni QA"\n_NET_WM_PID(CARDINAL) = 101',
            "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1",
        ]
        with patch.object(native_steps, "_command_output", side_effect=outputs), patch.object(Path, "resolve", resolve):
            window, identity = native_steps._activate_x11_application(qa_binary)
        self.assertEqual(window, "0x1")
        self.assertIn("Taomni QA", identity)

    def test_macos_webdriver_refuses_without_changing_home(self):
        with TemporaryDirectory() as directory, patch.object(native.platform, "system", return_value="Darwin"):
            before = dict(os.environ)
            with self.assertRaises(native.WebDriverError):
                native.native_isolation_env(Path(directory))
            self.assertEqual(dict(os.environ), before)

    def test_driver_rejects_external_listener_without_spawning(self):
        with TemporaryDirectory() as directory:
            driver = native.TauriDriverProcess({}, Path(directory))
            with patch.object(native, "_tcp_ok", return_value=True), patch.object(native.subprocess, "Popen") as spawn:
                with self.assertRaises(native.WebDriverError):
                    driver.start()
                spawn.assert_not_called()

    def test_driver_uses_configured_free_ports(self):
        with TemporaryDirectory() as directory:
            driver = native.TauriDriverProcess({"webdriver": {"port": 4450, "native_port": 4451}}, Path(directory))
            proc = Mock()
            proc.poll.return_value = None
            with patch.object(native, "_tcp_ok", side_effect=[False, False, True]), patch.object(native.subprocess, "Popen", return_value=proc) as spawn:
                driver.start()
                self.assertEqual(spawn.call_args.args[0], ["tauri-driver", "--port", "4450", "--native-port", "4451"])
                driver.stop()


class RoutineEntryTest(unittest.TestCase):
    def test_run_prefers_native_and_forwards_explicit_browser(self):
        for flags, expected in [
            (["--filter", "TC-001"], ["--filter", "TC-001", "--mode", "native"]),
            (["--mode=browser"], ["--mode=browser"]),
            (["--mode", "browser"], ["--mode", "browser"]),
        ]:
            with self.subTest(flags=flags), patch.object(runner, "main", return_value=1) as run:
                self.assertEqual(cli.main(["run", *flags]), 1)
                run.assert_called_once_with(expected)

    def test_audit_passes_through_flags_and_exit_code(self):
        from qa_ui_auto import audit
        with patch.object(audit, "main", return_value=2) as run:
            self.assertEqual(cli.main(["audit", "--gate", "--json"]), 2)
            run.assert_called_once_with(["--gate", "--json"])

    def test_real_runner_rejects_unrecorded_native_before_fixtures(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cases = root / "cases"
            cases.mkdir()
            (cases / "TC-001.testcase.yaml").write_text(
                'id: TC-001\ntitle: Native isolation\nmodes: [native]\nfixtures: [reset_db]\nsteps:\n  - wait_for: "[data-testid=welcome-panel]"\n',
                encoding="utf-8",
            )
            config = root / "config.yaml"
            config.write_text(json.dumps({"app": {"native_binary": str(root / "unrecorded")},
                                          "report": {"dir": str(root / "reports")}}), encoding="utf-8")
            before = dict(os.environ)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), patch.object(reset_db, "_reset_native") as reset:
                self.assertEqual(cli.main(["run", "--cases", str(cases), "--config", str(config)]), 2)
                reset.assert_not_called()
            self.assertEqual(dict(os.environ), before)


if __name__ == "__main__":
    unittest.main()
