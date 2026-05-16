"""Write summary.json, summary.md, JUnit XML, and a tiny report.html shim.

Stable JSON shape so Claude Code can parse failed cases reliably:

    {
      "schema": "qa-ui-auto.summary.v1",
      "started_at": "...",
      "finished_at": "...",
      "duration_sec": 47.3,
      "totals": {"total": N, "passed": N, "failed": N, "skipped": N},
      "cases": [
        {
          "id": "TC-001",
          "title": "...",
          "status": "passed|failed|skipped",
          "duration_sec": 12.4,
          "tags": [...],
          "covers": [...],
          "modes": [...],
          "fixtures_skipped": "...",
          "step_count": 14,
          "failure": null | {
            "step_index": 7,
            "verb": "click",
            "args": {...},
            "message": "...",
            "artifacts": {
              "screenshot": "TC-001/_failure-step7.png",
              "html":       "TC-001/_failure-step7.html",
              "console":    "TC-001/_failure-step7.console.json",
              "trace":      "TC-001/trace.zip"
            }
          }
        }
      ]
    }
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "qa-ui-auto.summary.v1"


def write_summary(report_root: Path, data: dict[str, Any]) -> Path:
    data = dict(data)
    data.setdefault("schema", SCHEMA_VERSION)
    out = report_root / "summary.json"
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return out


def write_markdown(report_root: Path, data: dict[str, Any]) -> Path:
    totals = data.get("totals", {})
    cases = data.get("cases", [])
    lines: list[str] = []
    lines.append(f"# qa-ui-auto run — {data.get('started_at', '?')}")
    lines.append("")
    lines.append(
        f"**{totals.get('passed', 0)} passed, "
        f"{totals.get('failed', 0)} failed, "
        f"{totals.get('skipped', 0)} skipped** "
        f"({totals.get('total', 0)} total) in "
        f"{data.get('duration_sec', 0):.1f}s"
    )
    lines.append("")
    lines.append("| Case | Status | Time | Notes |")
    lines.append("|------|--------|------|-------|")
    for c in cases:
        status = c["status"]
        emoji = {"passed": "✅", "failed": "❌", "skipped": "⏭"}.get(status, "?")
        notes = c.get("fixtures_skipped") or (c.get("failure") or {}).get("message") or ""
        notes = notes.replace("|", "\\|")[:120]
        lines.append(
            f"| `{c['id']}` {c['title']} | {emoji} {status} "
            f"| {c.get('duration_sec', 0):.1f}s | {notes} |"
        )
    failures = [c for c in cases if c["status"] == "failed"]
    if failures:
        lines.append("")
        lines.append("## Failures")
        for c in failures:
            f = c.get("failure") or {}
            lines.append(f"### `{c['id']}` — {c['title']}")
            lines.append("")
            lines.append(f"- step {f.get('step_index', '?')} (`{f.get('verb', '?')}`)")
            lines.append(f"- message: {f.get('message', '?')}")
            arts = f.get("artifacts") or {}
            for k in ("screenshot", "html", "console", "trace"):
                if k in arts:
                    lines.append(f"- {k}: `{arts[k]}`")
            lines.append("")
    out = report_root / "summary.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


def write_junit(report_root: Path, data: dict[str, Any]) -> Path:
    suites = ET.Element("testsuites")
    suite = ET.SubElement(suites, "testsuite", attrib={
        "name": "qa-ui-auto",
        "tests": str(data.get("totals", {}).get("total", 0)),
        "failures": str(data.get("totals", {}).get("failed", 0)),
        "skipped": str(data.get("totals", {}).get("skipped", 0)),
        "time": f"{data.get('duration_sec', 0):.3f}",
    })
    for c in data.get("cases", []):
        case_el = ET.SubElement(suite, "testcase", attrib={
            "classname": "qa-ui-auto",
            "name": f"{c['id']} {c['title']}",
            "time": f"{c.get('duration_sec', 0):.3f}",
        })
        if c["status"] == "skipped":
            ET.SubElement(case_el, "skipped", attrib={
                "message": c.get("fixtures_skipped") or "skipped",
            })
        elif c["status"] == "failed":
            f = c.get("failure") or {}
            failure_el = ET.SubElement(case_el, "failure", attrib={
                "type": "StepError",
                "message": f.get("message", "failed")[:240],
            })
            failure_el.text = (
                f"step {f.get('step_index', '?')} verb={f.get('verb', '?')}\n"
                f"args={json.dumps(f.get('args'), ensure_ascii=False)}\n"
                f"{f.get('message', '')}"
            )
    out = report_root / "junit.xml"
    ET.ElementTree(suites).write(out, encoding="utf-8", xml_declaration=True)
    return out


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
