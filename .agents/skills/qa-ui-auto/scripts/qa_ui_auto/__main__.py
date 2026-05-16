"""Default entry: print usage."""
from __future__ import annotations

import sys

USAGE = """\
qa_ui_auto — NewMob E2E runner

Subcommands:
  python -m qa_ui_auto.runner   [--mode browser|native] [--tag SMOKE] [--filter TC-007] [--workers N] [--dry-run]
  python -m qa_ui_auto.lint     [--cases qa-ui-auto-tests/cases] [--features qa-ui-auto-tests/feature-list.md]

Run 'python -m qa_ui_auto.<sub> --help' for detailed flags.
"""


def main() -> int:
    sys.stderr.write(USAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
