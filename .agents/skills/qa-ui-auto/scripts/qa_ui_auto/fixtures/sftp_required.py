"""sftp_required: same as ssh_required but for the sftp section."""

from __future__ import annotations

import socket
from typing import Any


def setup(ctx: Any) -> None:
    cfg = getattr(ctx, "cfg", {}) or {}
    section = cfg.get("sftp") or {}
    host = section.get("host")
    port = section.get("port")
    if not host or not port:
        from . import FixtureSkip
        raise FixtureSkip("sftp.host / sftp.port not set in qa-ui-auto.config.yaml")
    try:
        with socket.create_connection((host, int(port)), timeout=2.0):
            return
    except OSError as e:
        from . import FixtureSkip
        raise FixtureSkip(
            f"sftp server {host}:{port} unreachable ({e}). "
            "Fix the network/VPN/firewall — qa-ui-auto does not auto-fallback."
        ) from e
