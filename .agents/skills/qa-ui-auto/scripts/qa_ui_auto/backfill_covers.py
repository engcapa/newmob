#!/usr/bin/env python3
"""Backfill `covers: [F.x]` on migrated YAML cases.

The migrator emits `covers: []   # TODO: link to features.yaml IDs`. This
script reads qa-ui-auto-tests/cases/*.testcase.yaml and replaces empty covers with a
hand-mapped list. Idempotent — only rewrites cases whose covers are still
empty (so manual edits are preserved).

Usage: PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.backfill_covers
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Manual case → features mapping. Conservative: each case lists features that
# its title or steps clearly exercise. When unsure, leave empty (humans
# will add via gen-coverage when they revisit needs-review cases).
COVERS: dict[str, list[str]] = {
    # Already hand-authored: TC-001, TC-004, TC-008, TC-032 (smoke), TC-038, TC-040
    "TC-002": ["F11.1", "F5.2"],     # Settings + terminal appearance
    "TC-003": ["F6.3", "F3.2"],      # Session editor + advanced SSH
    "TC-005": ["F2.1", "F2.2"],      # Local PTY + terminal panel
    "TC-006": ["F6.4", "F3.1"],      # Quick connect + SSH
    "TC-007": ["F4.1", "F4.2", "F4.7"],  # Right-click: copy/paste, font/display, event log
    "TC-009": ["F7.2", "F7.3"],      # SFTP browser + transfer queue
    "TC-010": ["F7.5"],              # SFTP context menu chmod/rename
    "TC-011": ["F7.4"],              # Standalone SFTP tab
    "TC-012": ["F3.3", "F7.4"],      # OSC 7 + SFTP open-terminal-here
    "TC-013": ["F6.2"],              # Session tree menus
    "TC-014": ["F1.5"],              # Tab right-click
    "TC-015": ["F5.5"],              # App theme persistence
    "TC-016": ["F6.3", "F6.5"],      # Auth methods in editor
    "TC-017": ["F6.3", "F3.2"],      # Port forwarding rows
    "TC-018": ["F6.3"],              # Protocol switch
    "TC-019": ["F4.8"],              # Terminal shortcuts
    "TC-020": ["F4.2"],              # Display toggles (read-only/fullscreen/scrollbar)
    "TC-021": ["F5.2"],              # Theme hot-swap
    "TC-022": ["F4.4"],              # Macro record/replay
    "TC-023": ["F4.5"],              # Output recording
    "TC-024": ["F3.1"],              # SIGINT
    "TC-025": ["F4.7"],              # Event log
    "TC-026": ["F7.2"],              # Hidden file toggle
    "TC-027": ["F7.2"],              # Column sorting
    "TC-028": ["F7.2"],              # Breadcrumb navigation
    "TC-029": ["F7.2"],              # Orientation
    "TC-030": ["F7.2"],              # Folder + multi-select
    "TC-031": ["F7.3"],              # Transfer queue controls
    "TC-033": ["F8.2"],              # Tunnel autostart/credentials
    "TC-034": ["F1.7"],              # Status bar
    "TC-035": ["F1.2"],              # Menubar dropdowns
    "TC-036": ["F6.2"],              # Session folders/move
    "TC-037": ["F1.6", "F6.2"],      # Sidebar search
    "TC-039": ["F6.4"],              # Quick-connect validation
    "TC-041": ["F6.6"],              # OpenSSH import
    "TC-042": ["F1.5"],              # Tab middle-click
    "TC-043": ["F7.4"],              # SFTP detach
    "TC-044": ["F3.3", "F7.2"],      # OSC 7 + SFTP sync
    "TC-045": ["F1.5"],              # Close confirmation
    "TC-046": ["F8.2"],              # Tunnel auth display
    "TC-047": ["F8.2"],              # Tunnel reorder
    "TC-048": ["F7.2", "F7.3"],      # Cross-pane drag-drop
    "TC-049": ["F7.2"],              # Double-click download
    "TC-050": ["F7.2"],              # Multi-select
    "TC-051": ["F7.2"],              # Column resize
    "TC-052": ["F7.2"],              # Local new folder
    "TC-053": ["F6.2"],              # Session tree drag-drop
    "TC-054": ["F6.6"],              # Import/export
    "TC-055": ["F6.6"],              # OpenSSH import (welcome)
    "TC-056": ["F8.2"],              # Tunnel editor types
    "TC-057": ["F8.2"],              # Tunnel test/edit/reorder
    "TC-058": ["F2.1"],              # Local admin terminal
    "TC-059": ["F4.3"],              # Syntax highlighting
    "TC-060": ["F5.2"],              # Font ligatures
    "TC-061": ["F1.5"],              # Tab middle-click
    "TC-062": ["F1.6"],              # Welcome active connections
    "TC-063": ["F3.2", "F6.3"],      # Advanced SSH switches
}


COVERS_LINE_RE = re.compile(r"^covers:\s*\[\]\s*(?:#.*)?$", re.MULTILINE)


def backfill(cases_dir: Path) -> tuple[int, int]:
    updated = 0
    skipped = 0
    for path in sorted(cases_dir.glob("*.testcase.yaml")):
        text = path.read_text(encoding="utf-8")
        m = re.search(r"^id:\s*(\S+)\s*$", text, re.MULTILINE)
        if not m:
            continue
        case_id = m.group(1)
        if case_id not in COVERS:
            skipped += 1
            continue
        if not COVERS_LINE_RE.search(text):
            skipped += 1
            continue
        new_covers = "covers: [" + ", ".join(COVERS[case_id]) + "]"
        text = COVERS_LINE_RE.sub(new_covers, text, count=1)
        path.write_text(text, encoding="utf-8")
        updated += 1
    return updated, skipped


def main() -> int:
    cases_dir = Path("qa-ui-auto-tests/cases")
    if not cases_dir.exists():
        print(f"backfill: directory not found: {cases_dir}", file=sys.stderr)
        return 2
    upd, skip = backfill(cases_dir)
    print(f"backfill: updated {upd}, skipped {skip} (already populated or unmapped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
