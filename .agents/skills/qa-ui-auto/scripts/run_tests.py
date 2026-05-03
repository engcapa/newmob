#!/usr/bin/env python3
"""qa-ui-auto entry point.

Usage:
    python .agents/skills/qa-ui-auto/scripts/run_tests.py \
        [--mode browser|native] \
        [--testcases testcase-for-auto.md] \
        [--config qa-ui-auto.config.yaml] \
        [--filter TC-001,TC-002] \
        [--tag smoke]

Exit codes: 0 all passed, 1 some failed, 2 setup error.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import traceback
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from parse_testcases import TestCase, parse, resolve_step  # noqa: E402

ROOT = Path.cwd()
DEFAULT_TESTCASES = ROOT / "testcase-for-auto.md"
DEFAULT_CONFIG = ROOT / "qa-ui-auto.config.yaml"
TEMPLATE = HERE.parent / "assets" / "testcase-for-auto.template.md"
CONFIG_EXAMPLE = HERE.parent / "assets" / "qa-ui-auto.config.example.yaml"
AUTO_HEADER = "<!-- qa-ui-auto:auto-generated -->"


def log(msg: str) -> None:
    print(f"[qa-ui-auto] {msg}", flush=True)


def load_yaml(path: Path) -> dict:
    import yaml
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def ensure_config(path: Path) -> dict:
    if not path.exists():
        shutil.copy(CONFIG_EXAMPLE, path)
        log(f"created {path.name} from example — fill in credentials and re-run")
        sys.exit(2)
    return load_yaml(path)


def ensure_testcases(path: Path) -> None:
    """Apply the regeneration policy from SKILL.md."""
    if not path.exists():
        shutil.copy(TEMPLATE, path)
        log(f"created {path.name} from template")
        return
    content = path.read_text(encoding="utf-8")
    if AUTO_HEADER in content:
        # Auto-generated and presumably untouched → refresh it.
        shutil.copy(TEMPLATE, path)
        log(f"refreshed auto-generated {path.name}")
        return
    # User-customised: keep their file, just write a side-by-side fresh template.
    backup = path.with_name(
        f"{path.stem}.fresh-{datetime.now():%Y%m%d-%H%M%S}.md")
    shutil.copy(TEMPLATE, backup)
    log(f"{path.name} appears user-modified; wrote fresh template to {backup.name}")


def wait_for_url(url: str, timeout: float = 30.0) -> bool:
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


# ─── playwright-cli adapter ──────────────────────────────────────────────────

def _pw(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["playwright-cli", *args], cwd=cwd,
                          capture_output=True, text=True)


def dispatch(step, profile_dir: Path, report_dir: Path) -> tuple[bool, str]:
    """Execute one step via playwright-cli. Returns (ok, message)."""
    v = step.verb
    a = step.args
    common = ["--user-data-dir", str(profile_dir)]
    try:
        if v == "open" or v == "goto":
            r = _pw(["open", a[0], *common], profile_dir)
        elif v == "click":
            r = _pw(["click", a[0], *common], profile_dir)
        elif v == "dblclick":
            r = _pw(["dblclick", a[0], *common], profile_dir)
        elif v == "type":
            r = _pw(["type", a[0], *common], profile_dir)
        elif v == "fill":
            r = _pw(["fill", a[0], a[1], *common], profile_dir)
        elif v == "press":
            r = _pw(["press", a[0], *common], profile_dir)
        elif v == "select":
            r = _pw(["select", a[0], a[1], *common], profile_dir)
        elif v == "wait_for":
            r = _pw(["wait-for", a[0], *common], profile_dir)
        elif v in ("wait", "sleep"):
            time.sleep(float(a[0]))
            return True, f"slept {a[0]}s"
        elif v == "expect_visible":
            r = _pw(["expect", "visible", a[0], *common], profile_dir)
        elif v == "expect_text":
            r = _pw(["expect", "text", a[0], a[1], *common], profile_dir)
        elif v == "expect_url":
            r = _pw(["expect", "url", a[0], *common], profile_dir)
        elif v == "screenshot":
            target = report_dir / (a[0] if a else "screenshot.png")
            target.parent.mkdir(parents=True, exist_ok=True)
            r = _pw(["screenshot", "--path", str(target), *common], profile_dir)
        elif v == "eval":
            r = _pw(["eval", a[0], *common], profile_dir)
        else:
            return False, f"unknown verb {v}"
        ok = r.returncode == 0
        msg = (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr) else ""
        return ok, msg or ("ok" if ok else "failed")
    except Exception as e:
        return False, f"exception: {e}"


# ─── runner ──────────────────────────────────────────────────────────────────

def run_case(case: TestCase, cfg: dict, env: dict, report_root: Path) -> dict:
    case_dir = report_root / case.id
    case_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = case_dir / "profile"
    log(f"▶ {case.id}: {case.title}")
    steps_log = []
    failed = False
    for i, raw_step in enumerate(case.steps, 1):
        try:
            step = resolve_step(raw_step, cfg, env)
        except KeyError as e:
            steps_log.append({"i": i, "raw": raw_step.raw, "ok": False,
                              "msg": f"placeholder error: {e}"})
            failed = True
            break
        ok, msg = dispatch(step, profile_dir, case_dir)
        steps_log.append({"i": i, "raw": raw_step.raw, "ok": ok, "msg": msg})
        status = "✓" if ok else "✗"
        log(f"  {status} {i:02d} {raw_step.raw} — {msg}")
        if not ok:
            failed = True
            # Always capture failure screenshot
            dispatch(type(raw_step)("screenshot",
                                    [f"_failure-step{i}.png"],
                                    f"screenshot _failure-step{i}.png"),
                     profile_dir, case_dir)
            break
    return {"id": case.id, "title": case.title, "tags": case.tags,
            "passed": not failed, "steps": steps_log}


def write_report(report_root: Path, results: list[dict]) -> None:
    report_root.mkdir(parents=True, exist_ok=True)
    (report_root / "summary.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    md = ["# qa-ui-auto report",
          f"_generated: {datetime.now().isoformat(timespec='seconds')}_", ""]
    passed = sum(1 for r in results if r["passed"])
    md.append(f"**{passed}/{len(results)} passed**\n")
    for r in results:
        icon = "✅" if r["passed"] else "❌"
        md.append(f"## {icon} {r['id']}: {r['title']}")
        for s in r["steps"]:
            si = "✓" if s["ok"] else "✗"
            md.append(f"- `{si}` {s['raw']} — {s['msg']}")
        md.append("")
    (report_root / "summary.md").write_text("\n".join(md), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["browser", "native"], default="browser")
    ap.add_argument("--testcases", default=str(DEFAULT_TESTCASES))
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--filter", default="", help="comma-sep TC ids")
    ap.add_argument("--tag", default="", help="only run cases with this tag")
    args = ap.parse_args()

    cfg = ensure_config(Path(args.config))
    cfg.setdefault("app", {}).setdefault("base_url", "http://localhost:5000")
    cfg["app"]["mode"] = args.mode

    ensure_testcases(Path(args.testcases))
    cases = parse(Path(args.testcases))

    if args.filter:
        wanted = {x.strip() for x in args.filter.split(",") if x.strip()}
        cases = [c for c in cases if c.id in wanted]
    if args.tag:
        cases = [c for c in cases if args.tag in c.tags]
    if not cases:
        log("no test cases selected")
        return 2

    base_url = cfg["app"]["base_url"]
    if args.mode == "browser":
        if not wait_for_url(base_url, timeout=30):
            log(f"app not reachable at {base_url} — start the dev server first "
                "(restart the `Start application` workflow)")
            return 2

    report_root = Path(cfg.get("report", {}).get("dir", "qa-ui-auto-report"))
    if report_root.exists():
        # rotate
        keep = int(cfg.get("report", {}).get("keep_runs", 5))
        archive = report_root.with_name(
            f"{report_root.name}-{datetime.now():%Y%m%d-%H%M%S}")
        report_root.rename(archive)
        siblings = sorted(report_root.parent.glob(f"{report_root.name}-*"))
        for old in siblings[:-keep]:
            shutil.rmtree(old, ignore_errors=True)
    report_root.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    results = []
    for c in cases:
        try:
            results.append(run_case(c, cfg, env, report_root))
        except Exception:
            (report_root / "error.log").write_text(traceback.format_exc(),
                                                    encoding="utf-8")
            log(f"unhandled error in {c.id}; see error.log")
            results.append({"id": c.id, "title": c.title, "tags": c.tags,
                            "passed": False, "steps": [],
                            "error": "see error.log"})

    write_report(report_root, results)
    summary = (report_root / "summary.md").read_text(encoding="utf-8")
    print("\n" + summary)
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
