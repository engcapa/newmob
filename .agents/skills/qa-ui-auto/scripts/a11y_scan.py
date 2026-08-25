#!/usr/bin/env python3
"""Automated a11y role/name/state scan (R9 §8.19.10).

Drives the running dev server (browser mode) across a few core surfaces and
collects ARIA contract violations:

* dialog / alertdialog without an accessible name
* menu / menuitem / listbox / option / tab / treeitem without a name
* tab not exposing aria-selected state
* focusable buttons with no accessible name

This scan COMPLEMENTS but never replaces the per-platform manual
keyboard/screen-reader smoke (see qa-ui-auto-tests/native/a11y-manual-checklist.md).

Output: qa-ui-auto-report/evidence/a11y-scan-browser-<ts>.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path.cwd()
EVIDENCE = ROOT / "qa-ui-auto-report" / "evidence"

SCAN_FN = """
() => {
  const named = (el) => {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const src = document.getElementById(labelledby);
      if (src && src.textContent.trim()) return src.textContent.trim();
    }
    if (el.textContent && el.textContent.trim()) return el.textContent.trim();
    if (el.getAttribute('title')) return el.getAttribute('title');
    return '';
  };
  const violations = [];
  const counts = {};
  const record = (role, el, problem) => {
    counts[role] = (counts[role] || 0) + 1;
    violations.push({
      role, problem,
      testid: el.getAttribute('data-testid') || null,
      name: named(el).slice(0, 60) || null,
    });
  };
  for (const el of document.querySelectorAll('[role]')) {
    const role = el.getAttribute('role');
    if (['dialog', 'alertdialog'].includes(role) && !named(el)) record(role, el, 'missing accessible name');
    if (['menu', 'menubar', 'listbox', 'tree'].includes(role) && !named(el) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
      record(role, el, 'container without aria-label/labelledby');
    if (['menuitem', 'option', 'tab', 'treeitem'].includes(role) && !named(el)) record(role, el, 'missing accessible name');
    if (role === 'tab' && el.getAttribute('aria-selected') === null && el.getAttribute('aria-expanded') === null)
      record(role, el, 'no aria-selected state');
  }
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (el.offsetParent === null) continue;  // not rendered
    if (!named(el)) record('button', el, 'rendered button without accessible name');
  }
  return { violations, counts };
}
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="a11y_scan")
    ap.add_argument("--base-url", default="http://localhost:5001")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args(argv)

    from playwright.sync_api import sync_playwright

    surfaces: list[dict] = []

    def scan(page, label: str) -> None:
        result = page.evaluate(SCAN_FN)
        surfaces.append({"surface": label,
                         "violations": result["violations"],
                         "roles_seen": result["counts"]})

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.base_url, wait_until="domcontentloaded")
        page.wait_for_selector("[data-testid='welcome-panel']", timeout=30_000)
        scan(page, "welcome")

        # App main menu (shared context menu surface)
        try:
            page.click("[data-testid='app-main-menu']", timeout=5_000)
            page.wait_for_selector("[data-testid='context-menu']", timeout=5_000)
            scan(page, "app-main-menu open")
            page.keyboard.press("Escape")
        except Exception as e:  # noqa: BLE001
            surfaces.append({"surface": "app-main-menu open", "error": str(e)})

        # Code workspace surface
        try:
            page.click("[data-testid='side-tab-tools']")
            page.click("[data-testid='sidebar-tool-code-workspace']")
            page.wait_for_selector("[data-testid='code-workspace-tab']", timeout=10_000)
            page.click("[data-testid='code-workspace-tree-add-folder']")
            page.wait_for_selector("[data-testid='text-input-dialog']")
            scan(page, "text-input-dialog (add workspace root)")
            page.click("[data-testid='text-input-dialog-confirm']")
            page.wait_for_selector("[data-testid='code-workspace-tree-file']")
            scan(page, "code-workspace shell")
        except Exception as e:  # noqa: BLE001
            surfaces.append({"surface": "code-workspace", "error": str(e)})

        browser.close()

    violations = [v for s in surfaces for v in s.get("violations", [])]
    report = {
        "kind": "a11y-scan",
        "mode": "browser (Chromium); complements manual per-platform smoke",
        "collected_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base_url": args.base_url,
        "surfaces": surfaces,
        "total_violations": len(violations),
    }
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    out = EVIDENCE / f"a11y-scan-browser-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"artifact": str(out.relative_to(ROOT)),
                      "total_violations": len(violations),
                      "by_surface": {s["surface"]: len(s.get("violations", [])) for s in surfaces}},
                     indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
