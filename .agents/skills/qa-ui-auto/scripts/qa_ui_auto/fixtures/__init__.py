"""Fixtures applied per testcase. Each one is `setup(ctx)` and optional `teardown(ctx)`.

Fixtures are referenced from a testcase's `fixtures: [...]` list. Builtin set:

* reset_db        - clears Taomni persistent state for this worker before the case
* ssh_required    - probe the configured ssh.host:port over TCP; skip case otherwise
* sftp_required   - probe the configured sftp.host:port over TCP; skip case otherwise
* jdtls_required  - JDK-on-PATH probe; skip case otherwise (never auto-fallback)
* linux_x11_required - require the Linux X11/fcitx5 tools used by X11 gates
* workspace_root  - native-only: temp host dir seeded with files, exposed as
                    ${fixture.workspace_root}
* java_sample_projects - expose in-repo sample Maven/Gradle project roots as
                    ${fixture.maven_single_root} / ${fixture.gradle_single_root}
* java25_projects - create and compile isolated Maven + Gradle Java 25 projects
* git_diff_repo    - native-only reproducible Git history and worktree state

Custom fixtures should live in this package and register via `register(name, fn)`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from . import git_diff_repo, java25_projects, java_sample_projects, jdtls_required, linux_x11_required, reset_db, sftp_required, ssh_required, welcome_recents, workspace_root


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
    "jdtls_required": Fixture("jdtls_required", jdtls_required.setup),
    "linux_x11_required": Fixture("linux_x11_required", linux_x11_required.setup),
    "workspace_root": Fixture("workspace_root", workspace_root.setup, workspace_root.teardown),
    "java_sample_projects": Fixture("java_sample_projects", java_sample_projects.setup),
    "java25_projects": Fixture("java25_projects", java25_projects.setup),
    "git_diff_repo": Fixture("git_diff_repo", git_diff_repo.setup, git_diff_repo.teardown),
    "welcome_recents": Fixture("welcome_recents", welcome_recents.setup, welcome_recents.teardown),
}


class FixtureSkip(Exception):
    """Fixture decided this case is not runnable in the current environment."""


def get(name: str) -> Fixture:
    if name not in REGISTRY:
        raise KeyError(f"unknown fixture: {name}. Known: {sorted(REGISTRY)}")
    return REGISTRY[name]
