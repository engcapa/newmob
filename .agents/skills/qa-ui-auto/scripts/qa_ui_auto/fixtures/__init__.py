"""Fixtures applied per testcase. Each one is `setup(ctx)` and optional `teardown(ctx)`.

Fixtures are referenced from a testcase's `fixtures: [...]` list. Builtin set:

* reset_db        - clears NewMob persistent state for this worker before the case
* ssh_required    - probe the configured ssh.host:port over TCP; skip case otherwise
* sftp_required   - probe the configured sftp.host:port over TCP; skip case otherwise

Custom fixtures should live in this package and register via `register(name, fn)`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from . import reset_db, ssh_required, sftp_required


class FixtureContext(Protocol):
    page: object
    cfg: dict
    env: dict
    worker_id: int


@dataclass
class Fixture:
    name: str
    setup: Callable[..., None]
    teardown: Callable[..., None] | None = None


REGISTRY: dict[str, Fixture] = {
    "reset_db":     Fixture("reset_db",     reset_db.setup,     reset_db.teardown),
    "ssh_required": Fixture("ssh_required", ssh_required.setup),
    "sftp_required": Fixture("sftp_required", sftp_required.setup),
}


class FixtureSkip(Exception):
    """Fixture decided this case is not runnable in the current environment."""


def get(name: str) -> Fixture:
    if name not in REGISTRY:
        raise KeyError(f"unknown fixture: {name}. Known: {sorted(REGISTRY)}")
    return REGISTRY[name]
