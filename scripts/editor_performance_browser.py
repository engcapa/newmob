#!/usr/bin/env python3
"""Record ED-PERF-001 browser renderer typing samples against a Vite server."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from pathlib import Path


ROOT = Path.cwd()
HOOK = """
window.__edPerfSamples = [];
window.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  const started = performance.now();
  requestAnimationFrame(() => window.__edPerfSamples.push(performance.now() - started));
}, true);
'installed';
"""
TYPING_TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs."


def percentile_nearest_rank(samples: list[float], percentile: float) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    rank = max(1, int((percentile / 100.0 * len(ordered)) + 0.999999))
    return round(ordered[rank - 1], 3)


def summarize(samples: list[float]) -> dict[str, float | int]:
    return {
        "n": len(samples),
        "p50_ms": percentile_nearest_rank(samples, 50),
        "p95_ms": percentile_nearest_rank(samples, 95),
        "p99_ms": percentile_nearest_rank(samples, 99),
        "max_ms": round(max(samples), 3) if samples else 0.0,
        "mean_ms": round(statistics.fmean(samples), 3) if samples else 0.0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="editor_performance_browser")
    parser.add_argument("--base-url", default="http://localhost:5002")
    parser.add_argument("--variant", choices=("before", "after"), required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--keystrokes", type=int, default=205)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args(argv)

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.base_url, wait_until="domcontentloaded")
        page.wait_for_selector("[data-testid='welcome-panel']", timeout=30_000)
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

        content = page.locator("[data-testid='code-workspace-editor'] .cm-content")
        initial_text = content.inner_text()
        fixture = {
            "id": "browser-vfs-preview-first-file",
            "sha256": hashlib.sha256(initial_text.encode("utf-8")).hexdigest(),
            "utf8Bytes": len(initial_text.encode("utf-8")),
            "initialLines": initial_text.count("\n") + 1,
        }

        page.evaluate(HOOK)
        content.click()
        page.keyboard.press("Control+End")
        page.evaluate("window.__edPerfSamples = []")

        total = args.warmup + args.keystrokes
        page.keyboard.type("".join(TYPING_TEXT[index % len(TYPING_TEXT)] for index in range(total)), delay=25)
        page.wait_for_timeout(500)
        raw_samples = [float(value) for value in page.evaluate("window.__edPerfSamples")]
        if len(raw_samples) < total:
            browser.close()
            raise RuntimeError(f"expected at least {total} frame samples, got {len(raw_samples)}")
        warmup_samples = raw_samples[: args.warmup]
        measured_samples = raw_samples[args.warmup : args.warmup + args.keystrokes]
        long_tasks = [float(value) for value in page.evaluate(
            "performance.getEntriesByType('longtask').map((entry) => entry.duration)"
        )]
        heap_used = page.evaluate(
            "performance.memory ? performance.memory.usedJSHeapSize : null"
        )
        user_agent = page.evaluate("navigator.userAgent")
        browser.close()

    report = {
        "schemaVersion": 1,
        "taskId": "ED-PERF-001",
        "variant": args.variant,
        "commit": args.commit,
        "runner": "Python Playwright + Chromium + Vite production frontend",
        "environment": {
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "browser": "Chromium",
            "userAgent": user_agent,
            "viewport": "1440x900",
        },
        "fixture": fixture,
        "warmup": {
            "count": len(warmup_samples),
            "rawSamplesMs": warmup_samples,
        },
        "measurement": {
            "count": len(measured_samples),
            "rawSamplesMs": measured_samples,
            "percentile": "nearest-rank",
            "event": "keydown capture to next requestAnimationFrame",
            "typing": summarize(measured_samples),
            "budget": {
                "typingP95Ms": 50,
                "status": "passed" if percentile_nearest_rank(measured_samples, 95) <= 50 else "failed",
            },
        },
        "longTasks": {
            "count": len(long_tasks),
            "totalMs": round(sum(long_tasks), 3),
        },
        "heapUsedBytes": heap_used,
        "limitations": [
            "Chromium renderer measurement uses synthetic keyboard input and browser-VFS fixture",
            "excludes OS/compositor latency and does not prove Tauri/WebKitGTK/native performance",
            "does not measure provider IPC, completion, or cancellation latency",
        ],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "artifact": str(output_path),
        "variant": args.variant,
        "fixture": fixture,
        "typing": report["measurement"]["typing"],
        "budget": report["measurement"]["budget"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
