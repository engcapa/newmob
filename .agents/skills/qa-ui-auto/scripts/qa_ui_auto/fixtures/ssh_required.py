"""ssh_required: TCP-probe the configured ssh.host:ssh.port. Skip the case
if unreachable (FixtureSkip), with an explicit hint pointing the user at
the network — never auto-fall back to a docker fixture.
"""

from __future__ import annotations

import socket
from typing import Any


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    section = cfg.get("ssh") or {}
    host = section.get("host")
    port = section.get("port")
    if not host or not port:
        from . import FixtureSkip
        raise FixtureSkip("ssh.host / ssh.port not set in qa-ui-auto.config.yaml")
    try:
        with socket.create_connection((host, int(port)), timeout=2.0):
            return
    except OSError as e:
        from . import FixtureSkip
        raise FixtureSkip(
            f"ssh server {host}:{port} unreachable ({e}). "
            "Fix the network/VPN/firewall — qa-ui-auto does not auto-fallback."
        ) from e
