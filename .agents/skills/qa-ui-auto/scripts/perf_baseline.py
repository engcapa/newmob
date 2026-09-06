#!/usr/bin/env python3
"""Repeatable editor-input performance baseline harness (R9 §8.19.10).

Measures, against a running dev server (browser mode):

* key-to-paint   — keydown -> next rendered frame, capture phase, one sample
                   per keystroke while typing into the code editor.
                   Target p95 <= 50 ms.
* local action   — same proxy around a local-only action chord
                   (Ctrl+/ toggle comment). Target p95 <= 100 ms.
* long tasks     — PerformanceObserver longtask count/total during the run.
* heap           — usedJSHeapSize before/after.

Honesty notes (must stay attached to every published number):
* This is a RENDERER-SIDE PROXY measured in Chromium via WebDriver-style
  synthetic input. It excludes OS/compositor latency and does not exercise
  WebKitGTK. Native per-platform baselines are separate evidence rows and
  stay `platform-unverified` until run by the platform runbooks.
* Completion debounce/IPC/provider/paint splits and cancel rate need a real
  language-server provider (jdtls); they are recorded here as
  `provider-unverified`, never estimated.
* Large-corpus scenarios (1 MiB buffer, 10k candidates, 10k-file workspace,
  3+ splits) exceed what the browser-VFS preview can seed faithfully; they
  are recorded as `environment-blocked` rather than approximated.

Output: qa-ui-auto-report/evidence/perf-baseline-browser-<ts>.json (+ .entry.yaml)
"""
from __future__ import annotations

import argparse
import json
import hashlib
import math
import platform
import sys
import time
from pathlib import Path

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / ".agents" / "skills" / "qa-ui-auto" / "scripts"))

EVIDENCE = ROOT / "qa-ui-auto-report" / "evidence"

KTP_HOOK = """
window.__perfKTP = [];
window.addEventListener('keydown', (e) => {
  const t = performance.now();
  requestAnimationFrame(() => { window.__perfKTP.push(performance.now() - t); });
}, true);
window.__perfLongTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const item of list.getEntries()) window.__perfLongTasks.push(item.duration);
  }).observe({ entryTypes: ['longtask'] });
} catch (_) {}
'installed';
"""

LONGTEXT = (
    "The quick brown fox jumps over the lazy dog. "
    "Pack my box with five dozen liquor jugs. "
) * 3


def percentile(samples: list[float], pct: float) -> float:
    if not samples:
        return float("nan")
    ordered = sorted(samples)
    k = max(0, min(len(ordered) - 1, int(round(pct / 100 * (len(ordered) - 1)))))
    return round(ordered[k], 2)


def summarize(samples: list[float]) -> dict:
    return {
        "n": len(samples),
        "p50_ms": percentile(samples, 50) if samples else None,
        "p95_ms": percentile(samples, 95) if samples else None,
        "max_ms": round(max(samples), 2) if samples else None,
        "samples_ms": samples,
        "dropped_outliers_ge_1000ms": 0,
    }


def assess(results: dict, baseline: dict | None = None, noise_ms: float = 0) -> tuple[int, list[str]]:
    verdict = []
    if baseline is not None and baseline.get("conditions") != results.get("conditions"):
        return 2, ["baseline conditions differ; comparison unverified"]
    failed = False
    for name, budget in (("normal_input_key_to_paint", 50), ("local_action_toggle_comment", 100)):
        metric = results[name]
        value = metric.get("p95_ms")
        if not metric.get("n") or value is None or not math.isfinite(value):
            return 2, [f"{name}: missing valid measurements"]
        over = value > budget
        if baseline is not None:
            old = baseline.get(name, {})
            if not old.get("samples_ms") or old.get("dropped_outliers_ge_1000ms"):
                return 2, [f"{name}: baseline lacks unfiltered raw samples"]
            over = over or value > old["p95_ms"] + noise_ms
        failed = failed or over
        verdict.append(f"{name}: {'failed' if over else 'within measured limits'}")
    if baseline is None:
        verdict.append("regression comparison unverified: no baseline supplied")
    return int(failed), verdict


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="perf_baseline")
    ap.add_argument("--base-url", default="http://localhost:5001")
    ap.add_argument("--keystrokes", type=int, default=200)
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--warmup", type=int, default=20)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--noise-ms", type=float, default=0, help="previously measured noise allowance")
    args = ap.parse_args(argv)
    if args.keystrokes < 20 or args.warmup < 0 or args.noise_ms < 0:
        ap.error("keystrokes must be >=20; warmup and noise must be nonnegative")

    from playwright.sync_api import sync_playwright

    results: dict = {"kind": "perf-baseline", "mode": "browser-renderer-proxy",
                      "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                      "base_url": args.base_url}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.base_url, wait_until="domcontentloaded")
        page.wait_for_selector("[data-testid='welcome-panel']", timeout=30_000)

        # Enter the workspace with the browser-VFS preview root (in-app prompt
        # is prefilled with /preview in stub mode).
        page.click("[data-testid='side-tab-tools']")
        page.wait_for_selector("[data-testid='sidebar-tools-panel']")
        page.click("[data-testid='sidebar-tool-code-workspace']")
        page.wait_for_selector("[data-testid='code-workspace-tab']")
        page.click("[data-testid='code-workspace-tree-add-folder']")
        page.wait_for_selector("[data-testid='text-input-dialog']")
        page.click("[data-testid='text-input-dialog-confirm']")
        page.wait_for_selector("[data-testid='code-workspace-tree-file']")
        page.click("[data-testid='code-workspace-tree-file']")
        page.wait_for_selector("[data-testid='code-workspace-editor-pane'] .cm-content")

        page.evaluate(KTP_HOOK)

        # --- normal input key-to-paint -----------------------------------
        content = page.locator("[data-testid='code-workspace-editor'] .cm-content")
        content.click()
        results["conditions"] = {
            "os": platform.platform(), "machine": platform.node(), "processor": platform.processor(),
            "browser": browser.version, "headless": not args.headed, "profile": "browser-dev",
            "keystrokes": args.keystrokes, "warmup": args.warmup,
            "dataset_sha256": hashlib.sha256(content.inner_text().encode()).hexdigest(),
        }
        from qa_ui_auto.provenance import source_identity
        results["source_sha256"] = source_identity(ROOT)
        page.keyboard.press("Control+End")
        page.keyboard.type("w" * args.warmup, delay=25)
        page.wait_for_timeout(100)
        results["warmup_samples_ms"] = page.evaluate("window.__perfKTP")
        page.evaluate("window.__perfKTP = []")
        chunk = ""
        typed = 0
        while typed < args.keystrokes:
            text = LONGTEXT[typed % len(LONGTEXT)]
            chunk += text
            page.keyboard.type(text, delay=25)
            typed += 1
            if len(chunk) >= 60:  # periodic newline keeps CM off one huge line
                page.keyboard.press("Enter")
                chunk = ""
        page.wait_for_timeout(100)
        ktp_raw = page.evaluate("window.__perfKTP")
        results["normal_input_key_to_paint"] = summarize(ktp_raw)
        results["normal_input_key_to_paint"]["target_p95_ms"] = 50

        # --- local action chord (toggle comment) -------------------------
        page.evaluate("window.__perfKTP = []")
        for _ in range(20):
            page.keyboard.press("Control+/")
            page.wait_for_timeout(120)
        results["local_action_toggle_comment"] = summarize(
            page.evaluate("window.__perfKTP"))
        results["local_action_toggle_comment"]["target_p95_ms"] = 100

        # --- long tasks / heap -------------------------------------------
        results["long_tasks"] = {
            "count": page.evaluate("window.__perfLongTasks.length"),
            "total_ms": round(sum(page.evaluate("window.__perfLongTasks")), 1),
        }
        heap = page.evaluate(
            "performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null")
        results["heap_used_mb"] = heap

        # --- explicitly unmeasured dimensions ----------------------------
        results["not_measured_here"] = {
            "completion_debounce_ipc_provider_paint": "provider-unverified",
            "completion_cancel_rate": "provider-unverified",
            "switcher_modifier_release_flow": "platform-unverified (needs real modifier hold)",
            "buffer_1mib": "environment-blocked (browser-VFS seed)",
            "candidates_10k": "environment-blocked",
            "workspace_10k_files": "environment-blocked",
            "splits_3plus": "environment-blocked (harness scope)",
            "native_webkitgtk_latency": "platform-unverified (run per-platform runbooks)",
        }

        browser.close()

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_json = EVIDENCE / f"perf-baseline-browser-{stamp}.json"
    out_json.write_text(json.dumps(results, indent=1), encoding="utf-8")

    ni = results["normal_input_key_to_paint"]
    la = results["local_action_toggle_comment"]
    baseline = json.loads(args.baseline.read_text(encoding="utf-8")) if args.baseline else None
    exit_code, verdict = assess(results, baseline, args.noise_ms)
    results["noise_ms"] = args.noise_ms
    results["baseline"] = str(args.baseline) if args.baseline else None
    results["exit_code"] = exit_code
    results["targets_verdict"] = verdict

    out_json.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(json.dumps({
        "artifact": str(out_json.relative_to(ROOT)),
        "key_to_paint": ni,
        "local_action": la,
        "verdict": verdict,
    }, indent=1))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
