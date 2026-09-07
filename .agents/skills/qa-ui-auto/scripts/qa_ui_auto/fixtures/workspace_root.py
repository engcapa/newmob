"""Create an isolated scratch workspace root for native gate cases.

Native mode has no browser-VFS `/preview` root: the code workspace must add
a real directory from the host filesystem. This fixture provisions a fresh
temp directory seeded with files the G0/G1 cases assert against, and exposes
it to step templates as `${fixture.workspace_root}`.

Browser mode: FixtureSkip — the VFS cannot see host paths, so any case
depending on real disk effects is correctly environment-blocked there.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

SEED_FILES = {
    "README.md": "# qa workspace root\n\nSeeded by the qa-ui-auto workspace_root fixture.\n",
    "notes.txt": "scratch notes\n",
}


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode != "native":
        raise FixtureSkip(
            "workspace_root provisions a host directory; browser-VFS preview "
            "cannot observe it (case must run in native mode)"
        )
    # The packaged app may be launched with a different working directory than
    # the runner. Native IPC must therefore receive an absolute host path.
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-", dir=str(base)))
    for name, content in SEED_FILES.items():
        # Preserve the fixture's declared LF bytes on Windows; text-mode
        # writes would silently translate them to CRLF before the app opens it.
        (root / name).write_bytes(content.encode("utf-8"))
    values: dict[str, str] = getattr(ctx, "values")
    # These values are interpolated into JSON localStorage payloads and CSS
    # selectors. Slash-separated absolute paths work on Windows and POSIX.
    values["workspace_root"] = root.as_posix()


def teardown(ctx: Any) -> None:
    values: dict[str, str] = getattr(ctx, "values", {})
    root = values.get("workspace_root")
    if root:
        # Keep artifacts until report rotation; only clean the tree itself
        # when the run dir is removed wholesale. Deleting here would destroy
        # evidence referenced by failure reports.
        _ = root  # intentionally kept; rotation prunes qa-ui-auto-report/
