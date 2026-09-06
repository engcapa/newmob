"""Risk-based selection and observed execution coverage, separate from selector coverage."""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
from collections import Counter
from pathlib import Path

from .feature_catalog import load_features
from .provenance import digest_file, input_digest, execution_identity, source_input, conditions_identity
from .testcase import TestCase, discover

PLATFORMS = ("Linux", "Windows", "macOS")
LINUX_VERBS = {"native_set_writable", "assert_native_process_delta", "native_process_snapshot",
               "native_click", "native_pointer_drag", "native_ime_keys", "native_clipboard_owner",
               "assert_system_clipboard"}
REVIEW_TAGS = {"needs-review", "legacy-imported"}


def host_platform() -> str:
    return "macOS" if platform.system() == "Darwin" else platform.system()


def native_support(case: TestCase, target: str) -> str | None:
    from .native_steps import VERBS
    if target == "macOS":
        return "Tauri WebDriver unavailable; collect native OS/manual evidence using the macOS runbook"
    if case.native_platforms and target not in case.native_platforms:
        return f"case declares native platforms {case.native_platforms}"
    for step in case.steps:
        verb, args = next(iter(step.items()))
        if verb not in VERBS:
            return f"native runner does not support verb {verb}"
        linux_only = verb in LINUX_VERBS or (verb == "native_keys" and isinstance(args, dict)
                                             and args.get("transport", "x11") == "x11")
        if linux_only and target != "Linux":
            return f"{verb} requires Linux/X11"
    return None


def changed_files(root: Path, base: str) -> list[str]:
    names = set()
    # Include committed, staged, unstaged and untracked changes. Invalid refs fail closed.
    for command in (["git", "diff", "--name-only", "-z", f"{base}...HEAD"],
                    ["git", "diff", "--name-only", "-z", "HEAD"],
                    ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        names.update(subprocess.check_output(command, cwd=root).decode("utf-8").split("\0"))
    return sorted(names - {""})


def plan(cases: list[TestCase], features, changes: list[str] | None, target: str) -> dict:
    from .diff_impact import _file_matches
    affected = set()
    unmapped = []
    for name in changes or []:
        owners = {f.id for f in features if any(_file_matches(path, name) for path in f.files)}
        affected.update(owners)
        if source_input(name) and not owners:
            unmapped.append(name)
    shared = any(name.startswith(("src-tauri/", "src/lib/", "src/stores/", "src/hooks/",
                                 ".agents/skills/qa-ui-auto/")) or name in {
                                     "package.json", "pnpm-lock.yaml", "vite.config.ts"}
                 for name in changes or [])
    broad = changes is None or shared or bool(unmapped)
    selected = [c for c in cases if broad or affected.intersection(c.covers)
                or (c.source_path and c.source_path.as_posix() in (changes or []))]
    commands = []
    gaps = []
    for mode in ("browser", "native"):
        eligible = [c for c in selected if mode in c.modes]
        # A mapped renderer edit uses browser for shared cases, but retains native-only boundaries.
        if mode == "native" and not broad:
            eligible = [c for c in eligible if "browser" not in c.modes or (
                c.source_path and c.source_path.as_posix() in (changes or []))]
        runnable = []
        for case in eligible:
            reason = native_support(case, target) if mode == "native" else None
            if reason:
                gaps.append({"case": case.id, "mode": mode, "platform": target, "reason": reason})
            else:
                runnable.append(case.id)
        if runnable:
            commands.append({"mode": mode, "cases": runnable,
                             "argv": ["python", "-m", "qa_ui_auto", "run", "--mode", mode,
                                      "--filter", ",".join(runnable)]})
    return {"schema": "qa-ui-auto.plan.v1", "platform": target, "changed_files": changes,
            "affected_features": sorted(affected), "unmapped_source_files": unmapped,
            "selection_reason": "shared/unmapped changes: broaden selected scope" if broad else "mapped feature changes",
            "commands": commands, "native_gaps": gaps,
            "performance": "assess changed hot paths; functional timings are not product performance measurements",
            "backend_tests": "run affected Rust unit/integration tests" if any(
                n.startswith("src-tauri/") for n in changes or []) else None}


def load_observations(report_dirs: list[Path], identity: dict, config: dict | None = None) -> tuple[dict, list[dict]]:
    observations = {}
    rejected = []
    for root in report_dirs:
        paths = [root] if root.is_file() else sorted(root.glob("run-*/summary.json"))
        for path in paths:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data.get("dry_run") is not False:
                    raise ValueError("dry-run or legacy report without execution marker")
                receipt = json.loads((path.parent / "runner_receipt.json").read_text(encoding="utf-8"))
                from .runner_receipt import verify_runner_receipt
                if not verify_runner_receipt(receipt).get("valid"):
                    raise ValueError("invalid execution receipt")
                purpose = "native-runner" if data.get("mode") == "native" else "browser-runner"
                if receipt.get("purpose") != purpose or receipt.get("exitCode") != data.get("exit_code"):
                    raise ValueError("receipt mode or exit status differs from summary")
                expected = "sha256:" + digest_file(path)
                if not any(a.get("path") == "summary.json" and a.get("sha256") == expected
                           for a in receipt.get("artifacts", [])):
                    raise ValueError("summary hash does not match execution receipt")
                if data.get("mode") not in ("browser", "native") or data.get("platform") not in (*PLATFORMS, "Darwin"):
                    raise ValueError("missing or unsupported execution mode/platform")
                current = data.get("identity") == identity and data.get("identity_stable") is True
                expected_config = config
                if expected_config is None:
                    from .config import load_config
                    config_path = Path(data.get("config_path", "")).resolve()
                    if config_path.is_relative_to(Path.cwd().resolve()) and config_path.is_file():
                        expected_config = load_config(config_path)
                current = current and expected_config is not None and data.get("conditions_sha256") == (
                    conditions_identity(expected_config, data["mode"]) if expected_config is not None else None)
                if data["mode"] == "native":
                    native = data.get("native_identity", {})
                    current = current and native.get("identifier") == "com.taomni.app.qa" and (
                        native.get("source_sha256") == identity["source_sha256"])
                target = "macOS" if data["platform"] == "Darwin" else data["platform"]
                for result in data.get("cases", []):
                    if result.get("status") not in ("passed", "failed", "skipped"):
                        raise ValueError("invalid case outcome")
                    key = (result["id"], data["mode"], target)
                    item = {"status": result["status"], "current": current,
                            "case_sha256": result.get("case_sha256"), "report": str(path),
                            "finished_at": data.get("finished_at", ""),
                            "duration_sec": result.get("duration_sec"),
                            "conditions_sha256": data.get("conditions_sha256"),
                            "reason": result.get("fixtures_skipped") or (result.get("failure") or {}).get("message")}
                    previous = observations.get(key)
                    # Prefer current-source runs; within those keep the latest failure/skip too.
                    if previous is None or (current, item["finished_at"]) > (previous["current"], previous["finished_at"]):
                        observations[key] = item
            except (OSError, ValueError, KeyError, TypeError) as exc:
                rejected.append({"report": str(path), "reason": str(exc)})
    return observations, rejected


def coverage_status(cases, features, observations, targets) -> dict:
    rows = []
    gaps = []
    for case in cases:
        reviewed = not REVIEW_TAGS.intersection(case.tags)
        cells = {}
        case_hash = input_digest(case.source_path) if case.source_path else None
        for mode in case.modes:
            platforms = targets
            for target in platforms:
                candidates = [value for (cid, m, p), value in observations.items()
                              if cid == case.id and m == mode and (target == "any" or p == target)]
                valid = [v for v in candidates if v["current"] and v["case_sha256"] == case_hash]
                latest = max(valid, key=lambda v: v["finished_at"], default=None)
                state = latest["status"] if latest else "stale" if candidates else "unverified"
                key = f"{mode}:{target}"
                cells[key] = {"status": state, "report": latest["report"] if latest else None,
                              "reason": latest.get("reason") if latest else None}
                if mode == "native":
                    cells[key]["automation_gap"] = native_support(case, target)
                if state != "passed" or not reviewed:
                    gaps.append({"case": case.id, "target": key,
                                 "reason": "needs review" if not reviewed else state})
        rows.append({"id": case.id, "covers": case.covers, "reviewed": reviewed, "execution": cells})
    feature_rows = []
    for feature in features:
        owned = [row for row in rows if feature.id in row["covers"]]
        feature_rows.append({"id": feature.id, "title": feature.title,
                             "written": len(owned), "reviewed": sum(r["reviewed"] for r in owned),
                             "execution": dict(Counter(f"{key}:{cell['status']}" for r in owned
                                                       for key, cell in r["execution"].items()))})
    return {"schema": "qa-ui-auto.status.v1", "platforms": targets, "features": feature_rows,
            "cases": rows, "gaps": gaps, "ok": bool(rows) and not gaps,
            "scope": "YAML UI automation only; native manual, Rust, visual and performance evidence remain separate"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "status"])
    parser.add_argument("--diff", help="git base ref; include local changes")
    parser.add_argument("--feature")
    parser.add_argument("--tag", help="comma-separated OR tags; use smoke for a quick plan")
    parser.add_argument("--cases", default="qa-ui-auto-tests/cases")
    parser.add_argument("--features", default="qa-ui-auto-tests/feature-list.md")
    parser.add_argument("--reports", action="append", help="report root or summary.json; repeat to combine CI artifacts")
    parser.add_argument("--config", help="expected execution configuration, useful for imported reports")
    parser.add_argument("--platform", help="plan: one OS; status: comma-separated OS names (default all three)")
    parser.add_argument("--gate", action="store_true", help="require reviewed, current passing execution for selected scope")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        cases = discover(Path(args.cases))
        features = load_features(Path(args.features))
        if args.feature:
            features = [f for f in features if f.id == args.feature]
            cases = [c for c in cases if args.feature in c.covers]
            if not features:
                raise ValueError(f"unknown feature: {args.feature}")
        if args.tag:
            tags = set(args.tag.split(","))
            cases = [c for c in cases if tags.intersection(c.tags)]
        targets = args.platform.split(",") if args.platform else list(PLATFORMS)
        if any(target not in PLATFORMS for target in targets):
            raise ValueError(f"platforms must be drawn from {PLATFORMS}")
        if args.command == "plan":
            target = args.platform or host_platform()
            if target not in PLATFORMS:
                raise ValueError("plan requires one target platform")
            data = plan(cases, features, changed_files(Path.cwd(), args.diff) if args.diff else None, target)
        else:
            identity = execution_identity(Path.cwd())
            from .config import load_config
            expected_config = load_config(args.config) if args.config else None
            observations, rejected = load_observations([Path(p) for p in args.reports or ["qa-ui-auto-report"]], identity, expected_config)
            data = coverage_status(cases, features, observations, targets)
            data.update(identity=identity, rejected_reports=rejected)
        rendered = json.dumps(data, indent=2, ensure_ascii=False)
        if not args.json:
            if args.command == "plan":
                rendered = data["selection_reason"] + "\n" + "\n".join(
                    " ".join(command["argv"]) for command in data["commands"])
                rendered += "\nNative gaps: " + json.dumps(data["native_gaps"], ensure_ascii=False)
                rendered += "\nUnmapped source files: " + ", ".join(data["unmapped_source_files"])
            else:
                rendered = "| Feature | Written | Reviewed | Observed execution |\n|---|---:|---:|---|\n"
                rendered += "\n".join(f"| {f['id']} | {f['written']} | {f['reviewed']} | "
                                      + ", ".join(f"{k}={v}" for k, v in f["execution"].items()) + " |"
                                      for f in data["features"])
                rendered += f"\n\nUnmet case/target checks: {len(data['gaps'])}; rejected reports: {len(rejected)}\n{data['scope']}"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 1 if args.gate and (not data.get("ok", bool(data.get("commands"))) or data.get("native_gaps")) else 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"qa-ui-auto: {exc}")
        return 2
