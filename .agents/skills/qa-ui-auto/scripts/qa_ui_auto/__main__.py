"""Two routine entry points; existing modules remain directly callable."""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="qa_ui_auto", description=__doc__)
    parser.add_argument("command", choices=["audit", "run"], help="run defaults to isolated native testing")
    if not argv:
        parser.print_help()
        return 0
    args = parser.parse_args(argv[:1])
    flags = argv[1:]
    if args.command == "audit":
        from .audit import main as audit_main
        return audit_main(flags)
    from .runner import main as runner_main
    if not any(flag == "--mode" or flag.startswith("--mode=") for flag in flags):
        flags.extend(["--mode", "native"])
    return runner_main(flags)


if __name__ == "__main__":
    raise SystemExit(main())
