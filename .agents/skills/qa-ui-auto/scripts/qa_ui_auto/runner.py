"""Single-process Playwright Python runner with parallel workers.

Browser mode is the primary path: each worker owns a Chromium context.
Native mode delegates to .agents/skills/qa-ui-auto/scripts/tauri_webdriver.py
(legacy harness) and only runs cases tagged `modes: [native]`.

Usage:

    python -m qa_ui_auto.runner [--mode browser|native] [--tag smoke]
        [--filter TC-007,TC-008] [--workers 4] [--cases qa-ui-auto-tests/cases]
        [--config qa-ui-auto.config.yaml] [--dry-run]
        [--report-dir qa-ui-auto-report] [--keep-going]
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
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


# ─── per-case worker (browser) ──────────────────────────────────────────────


def _slugify_path_part(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)


def _run_browser_case(payload: dict) -> dict:
    """Worker entry. Spins up a fresh Chromium context for one test case."""
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
    user_data_dir = report_root / "_workdirs" / f"w{worker_id}-{case_dict['id']}"
    user_data_dir.mkdir(parents=True, exist_ok=True)

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

    from playwright.sync_api import sync_playwright  # local import to keep startup fast

    headless = bool(payload.get("headless", True))
    failure: dict[str, Any] | None = None
    last_step_index = 0
    last_verb = "<setup>"
    last_args: Any = None
    captured_console: list[dict[str, Any]] = []

    with sync_playwright() as pw:
        browser_ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(user_data_dir),
            headless=headless,
            viewport={"width": 1440, "height": 900},
        )
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
            page=page, case_id=case_dict["id"], case_dir=case_dir,
            cfg=cfg, env=env, dry_run=False,
        )

        try:
            # Run fixtures (setup); a FixtureSkip turns into "skipped" status.
            for fname in case_dict.get("fixtures", []):
                fix = get_fixture(fname)
                try:
                    fix.setup(ctx)
                except FixtureSkip as fs:
                    result["status"] = "skipped"
                    result["fixtures_skipped"] = f"{fname}: {fs}"
                    raise

            # Auto-open base_url at step 0 if the first step isn't `open`.
            first_verb, _ = tc_mod.step_verb_and_args(case_dict["steps"][0])
            if first_verb not in ("open", "goto"):
                page.goto(base_url, wait_until="domcontentloaded")

            for i, step in enumerate(case_dict["steps"], start=1):
                ctx.step_index = i
                verb, raw_args = tc_mod.step_verb_and_args(step)
                last_step_index = i
                last_verb = verb
                args = cfg_mod.resolve(raw_args, cfg=cfg, env=env)
                last_args = args
                if verb not in STEP_REGISTRY:
                    raise StepError(f"unknown verb: {verb}")
                STEP_REGISTRY[verb](ctx, args)

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
            try:
                trace_path = case_dir / "trace.zip"
                browser_ctx.tracing.stop(path=str(trace_path))
                if failure is not None:
                    failure.setdefault("artifacts", {})["trace"] = str(
                        trace_path.relative_to(report_root)
                    )
            except Exception:  # noqa: BLE001
                pass
            with suppress(Exception):
                browser_ctx.close()

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
        page.screenshot(path=str(png), full_page=False)
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
    """Native mode (P1 scope): delegate to tauri_webdriver.py for the smoke subset.

    For P1 we keep the behavior simple: import the legacy harness and run cases
    sequentially. P3 (covers expansion) will rewrite this with an upgraded driver.
    """
    from tauri_webdriver import NativeHarness, WebDriverError  # type: ignore[no-redef]

    results: list[dict] = []
    if dry_run:
        for c in cases:
            results.append({
                "id": c.id, "title": c.title, "status": "passed",
                "tags": c.tags, "covers": c.covers, "modes": c.modes,
                "duration_sec": 0.0, "step_count": len(c.steps),
                "worker_id": 0, "failure": None, "fixtures_skipped": None,
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
            try:
                session = harness.create_session()
                try:
                    # Native is intentionally minimal in P1 — only screenshots + open.
                    # Cases with non-native verbs are recorded as failed so they're
                    # visible (rather than silently skipped).
                    for i, step in enumerate(c.steps, start=1):
                        verb, args = tc_mod.step_verb_and_args(step)
                        if verb in ("open", "goto"):
                            continue  # tauri-driver auto-launches the binary
                        if verb == "screenshot":
                            target = case_dir / (
                                args["path"] if isinstance(args, dict) else str(args)
                            )
                            session.screenshot(target)
                            continue
                        raise StepError(
                            f"native runner P1 supports only `open` and `screenshot`; "
                            f"got {verb!r}"
                        )
                finally:
                    session.close()
            except WebDriverError as e:
                r["status"] = "failed"
                r["failure"] = {
                    "step_index": None, "verb": None, "args": None,
                    "message": f"WebDriverError: {e}", "artifacts": {},
                }
            except StepError as e:
                r["status"] = "failed"
                r["failure"] = {
                    "step_index": None, "verb": None, "args": None,
                    "message": str(e), "artifacts": {},
                }
            r["duration_sec"] = time.time() - started
            results.append(r)
    return results


def _rotate_runs(report_dir: Path, keep: int) -> None:
    runs = sorted(
        [p for p in report_dir.glob("run-*") if p.is_dir()],
        key=lambda p: p.name,
        reverse=True,
    )
    for old in runs[keep:]:
        with suppress(Exception):
            import shutil
            shutil.rmtree(old)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="qa_ui_auto.runner")
    ap.add_argument("--mode", choices=["browser", "native"], default=None)
    ap.add_argument("--config", default="qa-ui-auto.config.yaml")
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

    cases = tc_mod.discover(Path(args.cases))
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

    report_dir = Path(cfg.get("report", {}).get("dir", "qa-ui-auto-report"))
    run_id = time.strftime("run-%Y%m%d-%H%M%S")
    report_root = report_dir / run_id
    report_root.mkdir(parents=True, exist_ok=True)

    started_iso = reporter.now_iso()
    started = time.time()
    env = dict(os.environ)

    print(
        f"qa-ui-auto: mode={mode} workers={workers} cases={len(selected)} "
        f"report={report_root}{' [dry-run]' if args.dry_run else ''}"
    )

    results: list[dict] = []
    if mode == "native":
        results = _native_run(selected, cfg, env, report_root, args.dry_run)
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
        else:
            ctx = mp.get_context("spawn")
            with ctx.Pool(workers) as pool:
                for r in pool.imap_unordered(_run_browser_case, payloads):
                    results.append(r)
                    _print_case_line(r)

    duration = time.time() - started
    results.sort(key=lambda r: r["id"])

    summary = {
        "started_at": started_iso,
        "finished_at": reporter.now_iso(),
        "duration_sec": duration,
        "mode": mode,
        "workers": workers,
        "totals": {
            "total": len(results),
            "passed": sum(1 for r in results if r["status"] == "passed"),
            "failed": sum(1 for r in results if r["status"] == "failed"),
            "skipped": sum(1 for r in results if r["status"] == "skipped"),
        },
        "cases": results,
    }
    reporter.write_summary(report_root, summary)
    md = reporter.write_markdown(report_root, summary)
    reporter.write_junit(report_root, summary)
    print("\n" + md.read_text(encoding="utf-8"))

    keep = int(cfg.get("report", {}).get("keep_runs", 5))
    _rotate_runs(report_dir, keep)

    return 0 if summary["totals"]["failed"] == 0 else 1


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
