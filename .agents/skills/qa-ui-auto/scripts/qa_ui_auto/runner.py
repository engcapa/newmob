"""Single-process Playwright Python runner with parallel workers.

Browser mode gives each worker a Chromium context.
Native mode delegates to .agents/skills/qa-ui-auto/scripts/tauri_webdriver.py
(legacy harness) and only runs cases tagged `modes: [native]`.

Usage:

    python -m qa_ui_auto.runner [--mode browser|native] [--tag smoke]
        [--filter TC-007,TC-008] [--workers 4] [--cases qa-ui-auto-tests/cases]
        [--config qa-ui-auto-tests/qa-ui-auto.config.yaml] [--dry-run]
        [--report-dir qa-ui-auto-report] [--keep-going]
"""

from __future__ import annotations

import argparse
import atexit
import json
import multiprocessing as mp
import os
import platform
import sys
import time
import traceback
from contextlib import suppress
from pathlib import Path
from typing import Any

# Make sibling scripts (probe.py, tauri_webdriver.py) importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from . import config as cfg_mod
from . import reporter
from . import testcase as tc_mod
from .fixtures import FixtureSkip, REGISTRY as FIXTURE_REGISTRY, get as get_fixture
from .steps import REGISTRY as STEP_REGISTRY, StepContext, StepError
from .deadline import BudgetedPage, Deadline, using_deadline
from .provenance import input_digest, execution_identity, conditions_identity

_browser = None
_playwright = None


def _close_browser() -> None:
    global _browser, _playwright
    if _browser is not None:
        with suppress(Exception):
            _browser.close()
    if _playwright is not None:
        with suppress(Exception):
            _playwright.stop()
    _browser = _playwright = None


def _browser_context(headless: bool):
    global _browser, _playwright
    if _browser is None or not _browser.is_connected():
        from playwright.sync_api import sync_playwright
        _close_browser()
        _playwright = sync_playwright().start()
        _browser = _playwright.chromium.launch(headless=headless)
    return _browser.new_context(viewport={"width": 1440, "height": 900})


atexit.register(_close_browser)


def _init_browser_worker() -> None:
    from multiprocessing.util import Finalize
    Finalize(None, _close_browser, exitpriority=10)


def _timed_step(result: dict, index: int, verb: str, action, deadline=None) -> None:
    started = time.monotonic()
    try:
        with using_deadline(deadline):
            action()
    finally:
        result.setdefault("step_timings", []).append({
            "index": index, "verb": verb, "duration_sec": time.monotonic() - started,
        })


def _run_browser_case(payload: dict) -> dict:
    started = time.monotonic()
    try:
        return _run_browser_case_inner(payload)
    except Exception as exc:
        case = payload["case"]
        return {"id": case["id"], "title": case["title"], "tags": case["tags"],
                "covers": case["covers"], "modes": case["modes"], "status": "failed",
                "duration_sec": time.monotonic() - started, "step_count": len(case["steps"]),
                "failure": {"step_index": 0, "verb": "<setup>", "message": str(exc), "artifacts": {}}}


# ─── per-case worker (browser) ──────────────────────────────────────────────


def _slugify_path_part(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)


def _run_browser_case_inner(payload: dict) -> dict:
    """Fresh storage context per case, one browser process per worker."""
    case_dict = payload["case"]
    cfg = payload["cfg"]
    env = payload["env"]
    report_root = Path(payload["report_root"])
    worker_id = payload["worker_id"]
    dry_run = bool(payload.get("dry_run", False))

    case_dir = report_root / case_dict["id"]
    case_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "id": case_dict["id"],
        "title": case_dict["title"],
        "tags": case_dict.get("tags", []),
        "covers": case_dict.get("covers", []),
        "modes": case_dict.get("modes", ["browser"]),
        "status": "passed",
        "duration_sec": 0.0,
        "step_count": len(case_dict.get("steps", [])),
        "worker_id": worker_id,
        "failure": None,
        "fixtures_skipped": None,
        "skipped_reason": case_dict.get("skip"),
    }
    if case_dict.get("skip"):
        result["status"] = "skipped"
        result["fixtures_skipped"] = case_dict["skip"]
        return result

    started = time.time()
    base_url = cfg["app"]["base_url"]
    deadline = Deadline(case_dict.get("timeout_sec", 90))
    result["timings"] = {}

    if dry_run:
        # Validate verbs, args, and selector strings without launching the browser.
        try:
            for i, step in enumerate(case_dict.get("steps", []), start=1):
                verb, args = tc_mod.step_verb_and_args(step)
                if verb not in STEP_REGISTRY:
                    raise StepError(f"unknown verb: {verb}")
                # Resolve placeholders to ensure ${cfg.x.y} / ${env.X} all bind.
                cfg_mod.resolve(args, cfg=cfg, env=env)
            result["status"] = "passed"
            result["duration_sec"] = time.time() - started
            return result
        except Exception as e:  # noqa: BLE001
            result["status"] = "failed"
            result["failure"] = {
                "step_index": None,
                "verb": None,
                "args": None,
                "message": f"dry-run validation failed: {e}",
                "artifacts": {},
            }
            result["duration_sec"] = time.time() - started
            return result

    headless = bool(payload.get("headless", True))
    failure: dict[str, Any] | None = None
    last_step_index = 0
    last_verb = "<setup>"
    last_args: Any = None
    captured_console: list[dict[str, Any]] = []

    context_started = time.monotonic()
    browser_ctx = _browser_context(headless)
    result["timings"]["context_setup_sec"] = time.monotonic() - context_started
    if browser_ctx:
        page = browser_ctx.pages[0] if browser_ctx.pages else browser_ctx.new_page()
        page.on("console", lambda msg: captured_console.append(  # noqa: SLF001
            {"level": msg.type, "text": msg.text}
        ))
        page.on("pageerror", lambda exc: captured_console.append(
            {"level": "error", "text": f"pageerror: {exc}"}
        ))

        # Tracing: record everything; only persist on failure.
        try:
            browser_ctx.tracing.start(screenshots=True, snapshots=True, sources=False)
        except Exception:  # noqa: BLE001
            pass

        ctx = StepContext(
            page=BudgetedPage(page, deadline), case_id=case_dict["id"], case_dir=case_dir,
            cfg=cfg, env=env, dry_run=False,
        )

        try:
            fixture_started = time.monotonic()
            # Run fixtures (setup); a FixtureSkip turns into "skipped" status.
            for fname in case_dict.get("fixtures", []):
                fix = get_fixture(fname)
                try:
                    deadline.remaining()
                    fix.setup(ctx)
                    deadline.remaining()
                except FixtureSkip as fs:
                    result["status"] = "skipped"
                    result["fixtures_skipped"] = f"{fname}: {fs}"
                    raise
            result["timings"]["fixtures_sec"] = time.monotonic() - fixture_started

            # Auto-open base_url at step 0 if the first step isn't `open`.
            first_verb, _ = tc_mod.step_verb_and_args(case_dict["steps"][0])
            if first_verb not in ("open", "goto"):
                ctx.page.goto(base_url, wait_until="domcontentloaded", timeout=deadline.remaining() * 1000)

            for i, step in enumerate(case_dict["steps"], start=1):
                ctx.step_index = i
                verb, raw_args = tc_mod.step_verb_and_args(step)
                last_step_index = i
                last_verb = verb
                args = cfg_mod.resolve(raw_args, cfg=cfg, env=env)
                last_args = args
                if verb not in STEP_REGISTRY:
                    raise StepError(f"unknown verb: {verb}")
                page.set_default_timeout(min(30000, deadline.remaining() * 1000))
                page.set_default_navigation_timeout(min(30000, deadline.remaining() * 1000))
                _timed_step(result, i, verb, lambda: STEP_REGISTRY[verb](ctx, args), deadline)
                deadline.remaining()

        except FixtureSkip:
            pass  # handled above
        except StepError as e:
            failure = _capture_failure(
                page, case_dir, last_step_index, last_verb, last_args, str(e),
                captured_console,
            )
            result["status"] = "failed"
            result["failure"] = failure
        except Exception as e:  # noqa: BLE001
            failure = _capture_failure(
                page, case_dir, last_step_index, last_verb, last_args,
                f"{type(e).__name__}: {e}", captured_console,
                traceback_text=traceback.format_exc(),
            )
            result["status"] = "failed"
            result["failure"] = failure
        finally:
            cleanup_started = time.monotonic()
            try:
                trace_path = case_dir / "trace.zip"
                browser_ctx.tracing.stop(**({"path": str(trace_path)} if failure is not None else {}))
                if failure is not None:
                    failure.setdefault("artifacts", {})["trace"] = str(
                        trace_path.relative_to(report_root)
                    )
            except Exception:  # noqa: BLE001
                pass
            with suppress(Exception):
                browser_ctx.close()
            result["timings"]["cleanup_sec"] = time.monotonic() - cleanup_started

    result["duration_sec"] = time.time() - started
    return result


def _capture_failure(
    page: Any,
    case_dir: Path,
    step_index: int,
    verb: str,
    args: Any,
    message: str,
    console: list[dict],
    traceback_text: str | None = None,
) -> dict:
    case_dir.mkdir(parents=True, exist_ok=True)
    base = f"_failure-step{step_index}"
    artifacts: dict[str, str] = {}

    try:
        png = case_dir / f"{base}.png"
        page.screenshot(path=str(png), full_page=False, timeout=3000)
        artifacts["screenshot"] = png.name
    except Exception:  # noqa: BLE001
        pass

    try:
        html = case_dir / f"{base}.html"
        html.write_text(page.content(), encoding="utf-8")
        artifacts["html"] = html.name
    except Exception:  # noqa: BLE001
        pass

    try:
        injected: list[Any] = []
        with suppress(Exception):
            injected = page.evaluate("() => (window.__QA_UI_AUTO_CONSOLE__ || [])")
        cjson = case_dir / f"{base}.console.json"
        cjson.write_text(json.dumps({
            "url": getattr(page, "url", ""),
            "page_console": console,
            "in_page_console": injected,
            "traceback": traceback_text,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        artifacts["console"] = cjson.name
    except Exception:  # noqa: BLE001
        pass

    return {
        "step_index": step_index,
        "verb": verb,
        "args": args,
        "message": message,
        "artifacts": artifacts,
    }


# ─── orchestration ──────────────────────────────────────────────────────────


def _serialize_case(c: tc_mod.TestCase) -> dict:
    return {
        "id": c.id,
        "title": c.title,
        "description": c.description,
        "tags": c.tags,
        "covers": c.covers,
        "modes": c.modes,
        "fixtures": c.fixtures,
        "timeout_sec": c.timeout_sec,
        "skip": c.skip,
        "steps": c.steps,
    }


def _native_run(cases: list[tc_mod.TestCase], cfg: dict, env: dict, report_root: Path,
                dry_run: bool) -> list[dict]:
    """Native mode (P2): full verb subset over tauri-driver + fixtures.

    R9 §8.19.10 native gate harness. Sequential single session per case;
    fixtures run before steps; `${fixture.*}` template values resolve
    strictly after their fixture produced them. NativeHarness verifies the QA
    build and establishes storage isolation before fixtures or sessions start.
    """
    from types import SimpleNamespace

    from tauri_webdriver import NativeHarness, WebDriverError  # type: ignore[no-redef]

    from .native_steps import NativeStepContext, run_native_step

    results: list[dict] = []
    if dry_run:
        # Validate verbs against the native registry and resolve placeholders
        # that are statically known (cfg/env). ${fixture.*} only binds at
        # runtime, so dry-run tolerates them being unresolved.
        from .native_steps import VERBS as NATIVE_VERBS
        for c in cases:
            status, failure = "passed", None
            try:
                for step in c.steps:
                    verb, raw_args = tc_mod.step_verb_and_args(step)
                    if verb not in NATIVE_VERBS:
                        raise StepError(f"unknown native verb: {verb}")
                    try:
                        cfg_mod.resolve(raw_args, cfg=cfg, env=env)
                    except KeyError as e:
                        if "fixture value not set" not in str(e):
                            raise
            except Exception as e:  # noqa: BLE001
                status, failure = "failed", {"message": f"dry-run validation failed: {e}"}
            results.append({
                "id": c.id, "title": c.title, "status": status,
                "tags": c.tags, "covers": c.covers, "modes": c.modes,
                "duration_sec": 0.0, "step_count": len(c.steps),
                "worker_id": 0, "failure": failure, "fixtures_skipped": None,
            })
        return results

    with NativeHarness(cfg, report_root) as harness:
        for c in cases:
            case_dir = report_root / c.id
            case_dir.mkdir(parents=True, exist_ok=True)
            started = time.time()
            r: dict[str, Any] = {
                "id": c.id, "title": c.title, "status": "passed",
                "tags": c.tags, "covers": c.covers, "modes": c.modes,
                "duration_sec": 0.0, "step_count": len(c.steps),
                "worker_id": 0, "failure": None, "fixtures_skipped": None,
            }
            r["timings"] = {}
            deadline = Deadline(c.timeout_sec)
            if c.skip:
                r.update(status="skipped", fixtures_skipped=c.skip)
                results.append(r)
                continue
            failure_artifacts: dict = {}
            fixture_values: dict[str, str] = {}
            last_step, last_verb, last_args = 0, "<setup>", None
            ctx_ns = SimpleNamespace(
                page=None, case_id=c.id, case_dir=case_dir, cfg=cfg, env=env,
                dry_run=False, worker_id=0, report_root=report_root,
                values=fixture_values, step_index=0,
            )
            try:
                fixture_started = time.monotonic()
                # Fixtures first — a FixtureSkip turns into "skipped".
                for fname in c.fixtures:
                    fix = get_fixture(fname)
                    try:
                        deadline.remaining()
                        fix.setup(ctx_ns)
                        deadline.remaining()
                    except FixtureSkip as fs:
                        r["status"] = "skipped"
                        r["fixtures_skipped"] = f"{fname}: {fs}"
                        break
                else:
                    r["timings"]["fixtures_sec"] = time.monotonic() - fixture_started
                    session_started = time.monotonic()
                    harness.deadline = deadline
                    session = harness.create_session()
                    r["timings"]["session_setup_sec"] = time.monotonic() - session_started
                    nctx: NativeStepContext | None = None
                    try:
                        nctx = NativeStepContext(session, case_dir, cfg)
                        last_step, last_verb, last_args = 0, "<setup>", None
                        for i, step in enumerate(c.steps, start=1):
                            ctx_ns.step_index = i
                            verb, raw_args = tc_mod.step_verb_and_args(step)
                            last_step, last_verb, last_args = i, verb, raw_args
                            args = cfg_mod.resolve(
                                raw_args, cfg=cfg, env=env, fixture=fixture_values
                            )
                            nctx.case_dir.mkdir(parents=True, exist_ok=True)
                            deadline.remaining()
                            _timed_step(r, i, verb, lambda: run_native_step(nctx, verb, args), deadline)
                            deadline.remaining()
                    except Exception:
                        session.deadline = Deadline(5)
                        capture_started = time.monotonic()
                        failure_artifacts = _capture_native_failure(session, case_dir)
                        r["timings"]["failure_capture_sec"] = time.monotonic() - capture_started
                        raise
                    finally:
                        cleanup_started = time.monotonic()
                        session.deadline = Deadline(5)
                        if nctx is not None:
                            nctx.restore_host_permissions()
                        console = []
                        with suppress(Exception):
                            console = session.console_entries()
                        (case_dir / "console.json").write_text(
                            json.dumps(console[-500:], ensure_ascii=False, indent=1),
                            encoding="utf-8",
                        )
                        with suppress(Exception):
                            session.close()
                        r["timings"]["cleanup_sec"] = time.monotonic() - cleanup_started
            except WebDriverError as e:
                r["status"] = "failed"
                r["failure"] = {
                    "step_index": last_step,
                    "verb": last_verb,
                    "args": None,
                    "message": f"WebDriverError: {e}", "artifacts": {},
                }
            except StepError as e:
                r["status"] = "failed"
                r["failure"] = {
                    "step_index": last_step,
                    "verb": last_verb,
                    "args": last_args,
                    "message": str(e), "artifacts": {},
                }
            except Exception as e:  # noqa: BLE001
                r["status"] = "failed"
                r["failure"] = {
                    "step_index": last_step,
                    "verb": last_verb,
                    "args": None,
                    "message": f"{type(e).__name__}: {e}",
                    "artifacts": {},
                }
            if r["status"] == "failed":
                r["failure"]["artifacts"] = failure_artifacts
            r["duration_sec"] = time.time() - started
            results.append(r)
    return results


def _capture_native_failure(session: Any, case_dir: Path) -> dict:
    """Capture the failing session before cleanup changes its state."""
    artifacts: dict[str, str] = {}
    try:
        shot = case_dir / "failure-native.png"
        session.screenshot(shot)
        artifacts["screenshot"] = str(shot)
    except Exception:  # noqa: BLE001
        pass
    with suppress(Exception):
        html = case_dir / "failure-native.html"
        html.write_text(str(session.execute("return document.documentElement.outerHTML")), encoding="utf-8")
        artifacts["html"] = str(html)
    with suppress(Exception):
        log = case_dir / "console-failure.json"
        log.write_text(json.dumps(session.console_entries()[-300:], ensure_ascii=False), encoding="utf-8")
        artifacts["console"] = str(log)
    return artifacts


def _rotate_runs(report_dir: Path, keep: int) -> None:
    if keep <= 0:
        return
    runs = sorted(
        [p for p in report_dir.glob("run-*") if p.is_dir()],
        key=lambda p: p.name,
        reverse=True,
    )
    for old in runs[keep:]:
        with suppress(Exception):
            import shutil
            shutil.rmtree(old)


def _configure_console_encoding() -> None:
    """Keep report output printable on Windows consoles using legacy code pages."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    _configure_console_encoding()
    ap = argparse.ArgumentParser(prog="qa_ui_auto.runner")
    ap.add_argument("--mode", choices=["browser", "native"], default=None)
    ap.add_argument("--config", default="qa-ui-auto-tests/qa-ui-auto.config.yaml")
    ap.add_argument("--cases", default="qa-ui-auto-tests/cases")
    ap.add_argument("--tag", default=None,
                    help="comma-separated tags; case must match at least one")
    ap.add_argument("--filter", default=None,
                    help="comma-separated TC ids to run")
    ap.add_argument("--workers", type=int, default=None,
                    help="parallel workers for browser mode (default from config)")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate verbs/selectors without launching browser")
    ap.add_argument("--headed", action="store_true",
                    help="show the browser (default headless)")
    ap.add_argument("--report-dir", help="isolated output directory")
    ap.add_argument("--keep-runs", type=int, help="retained runs in output directory; 0 disables rotation")
    ap.add_argument("--require-pass", action="store_true", help="fail if any selected case skips")
    args = ap.parse_args(argv)

    try:
        cfg = cfg_mod.load_config(args.config)
    except Exception as e:  # noqa: BLE001
        print(f"qa-ui-auto: config error: {e}", file=sys.stderr)
        return 2

    mode = args.mode or cfg["app"].get("mode", "browser")
    cfg["app"]["mode"] = mode  # propagate into fixtures
    workers = max(1, int(args.workers or (cfg.get("worker") or {}).get("parallel", 4)))
    if mode == "native":
        workers = 1

    try:
        cases = tc_mod.discover(Path(args.cases))
    except (OSError, ValueError) as exc:
        print(f"qa-ui-auto: testcase error: {exc}", file=sys.stderr)
        return 2
    if not cases:
        print(f"qa-ui-auto: no testcases found under {args.cases}", file=sys.stderr)
        return 2

    selected = tc_mod.filter_cases(
        cases,
        mode=mode,
        tags=[t.strip() for t in args.tag.split(",")] if args.tag else None,
        ids=[t.strip() for t in args.filter.split(",")] if args.filter else None,
    )
    if not selected:
        print(
            f"qa-ui-auto: 0 cases matched filters "
            f"(mode={mode}, tag={args.tag}, filter={args.filter})",
            file=sys.stderr,
        )
        return 2
    if mode == "native":
        from .verification import host_platform, native_support
        unsupported = {c.id: reason for c in selected if (reason := native_support(c, host_platform()))}
        if unsupported:
            print(f"qa-ui-auto: unsupported native scope: {unsupported}", file=sys.stderr)
            return 2

    requested_ids = set(args.filter.split(",")) if args.filter else set()
    missing_ids = requested_ids - {c.id for c in selected}
    if missing_ids:
        print(f"qa-ui-auto: requested cases unavailable in {mode}: {sorted(missing_ids)}", file=sys.stderr)
        return 2

    report_dir = Path(args.report_dir or cfg.get("report", {}).get("dir", "qa-ui-auto-report"))
    run_id = time.strftime("run-%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1000000000:09d}"
    report_root = report_dir / run_id
    report_root.mkdir(parents=True, exist_ok=True)

    started_iso = reporter.now_iso()
    started = time.time()
    env = dict(os.environ)
    identity = execution_identity(Path.cwd())
    case_digests = {c.id: input_digest(c.source_path) for c in selected if c.source_path}

    print(
        f"qa-ui-auto: mode={mode} workers={workers} cases={len(selected)} "
        f"report={report_root}{' [dry-run]' if args.dry_run else ''}"
    )

    results: list[dict] = []
    if mode == "native":
        from tauri_webdriver import WebDriverError
        try:
            results = _native_run(selected, cfg, env, report_root, args.dry_run)
        except (OSError, ValueError, WebDriverError) as exc:
            print(f"qa-ui-auto: native setup error: {exc}", file=sys.stderr)
            return 2
    else:
        payloads = []
        for i, c in enumerate(selected):
            payloads.append({
                "case": _serialize_case(c),
                "cfg": cfg,
                "env": env,
                "report_root": str(report_root),
                "worker_id": i % workers,
                "dry_run": args.dry_run,
                "headless": not args.headed,
            })
        if workers == 1 or args.dry_run:
            for p in payloads:
                results.append(_run_browser_case(p))
                _print_case_line(results[-1])
            _close_browser()
        else:
            ctx = mp.get_context("spawn")
            with ctx.Pool(workers, initializer=_init_browser_worker) as pool:
                for r in pool.imap_unordered(_run_browser_case, payloads):
                    results.append(r)
                    _print_case_line(r)
                pool.close()
                pool.join()

    duration = time.time() - started
    results.sort(key=lambda r: r["id"])
    for result in results:
        result["case_sha256"] = case_digests.get(result["id"])
    identity_stable = identity == execution_identity(Path.cwd())
    identity_stable = identity_stable and all(
        c.source_path and c.source_path.exists() and input_digest(c.source_path) == case_digests[c.id]
        for c in selected)

    summary = {
        "started_at": started_iso,
        "finished_at": reporter.now_iso(),
        "duration_sec": duration,
        "mode": mode,
        "platform": platform.system(),
        "workers": workers,
        "dry_run": args.dry_run,
        "identity": identity,
        "identity_stable": identity_stable,
        "conditions_sha256": conditions_identity(cfg, mode, env),
        "config_path": Path(args.config).as_posix(),
        "selection": {"requested": sorted(requested_ids), "selected": [c.id for c in selected],
                      "not_selected": [c.id for c in cases if c not in selected]},
        "totals": {
            "total": len(results),
            "passed": sum(1 for r in results if r["status"] == "passed"),
            "failed": sum(1 for r in results if r["status"] == "failed"),
            "skipped": sum(1 for r in results if r["status"] == "skipped"),
        },
        "cases": results,
    }
    if mode == "native":
        isolation_path = report_root / "native-isolation.json"
        if isolation_path.exists():
            summary["native_identity"] = json.loads(isolation_path.read_text(encoding="utf-8"))
    exit_code = 1 if (summary["totals"]["failed"] or not identity_stable
                      or (args.require_pass and summary["totals"]["skipped"])) else 0
    summary["exit_code"] = exit_code
    reporter.write_summary(report_root, summary)
    md = reporter.write_markdown(report_root, summary)
    reporter.write_junit(report_root, summary)
    print("\n" + md.read_text(encoding="utf-8"))

    # ED-REL-001: emit runner-owned execution receipt
    from .runner_receipt import emit_runner_receipt
    try:
        if args.dry_run:
            print("qa-ui-auto: dry-run has no execution receipt")
            return exit_code
        receipt_path = emit_runner_receipt(
            report_root=report_root,
            mode=mode,
            executed_cmd=sys.argv,
            started_at=started_iso,
            finished_at=reporter.now_iso(),
            duration_sec=duration,
            exit_code=exit_code,
        )
        print(f"qa-ui-auto: runner receipt emitted: {receipt_path.name}")
    except Exception as e:
        print(f"qa-ui-auto: warning: failed to emit runner receipt: {e}", file=sys.stderr)

    keep = args.keep_runs if args.keep_runs is not None else int(cfg.get("report", {}).get("keep_runs", 5))
    _rotate_runs(report_dir, keep)

    return exit_code


def _print_case_line(r: dict) -> None:
    glyph = {"passed": "✓", "failed": "✗", "skipped": "~"}.get(r["status"], "?")
    note = ""
    if r["status"] == "skipped" and r.get("fixtures_skipped"):
        note = f" — {r['fixtures_skipped']}"
    elif r["status"] == "failed" and r.get("failure"):
        note = f" — step {r['failure'].get('step_index', '?')} {r['failure'].get('verb', '?')}: {r['failure'].get('message', '')[:120]}"
    print(f"  {glyph} {r['id']:<14} {r['title'][:60]:<60} {r['duration_sec']:6.2f}s{note}")


if __name__ == "__main__":
    sys.exit(main())
