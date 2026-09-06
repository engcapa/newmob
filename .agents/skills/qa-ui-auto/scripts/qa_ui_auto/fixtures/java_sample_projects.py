"""java_sample_projects: expose in-repo sample Maven/Gradle projects for native gates.

ED-PROJECT-002 (Maven) and ED-PROJECT-003 (Gradle) require `native`
evidence: the packaged Tauri app must ingest a REAL build project through
the production `useProjectFacts -> fetchProjectFacts -> workspace_ingest_*`
chain and render the ready badge. The native case seeds a recent workspace
whose root is the sample project directory, so this fixture only resolves
absolute on-disk paths and proves the descriptor files exist; it never
executes build tooling itself.

Exposes:
* ${fixture.maven_single_root}  - single-module Maven sample (pom.xml)
* ${fixture.gradle_single_root} - single-module Gradle sample (build.gradle)
"""

from __future__ import annotations

from pathlib import Path
import shutil
from typing import Any

SAMPLES = {
    "maven_single_root": (
        Path("src/components/editor/workspace/__fixtures__/jdtls/projects/maven-single"),
        "pom.xml",
    ),
    "gradle_single_root": (
        Path("src/components/editor/workspace/__fixtures__/jdtls/projects/gradle-single"),
        "build.gradle",
    ),
}


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    repo = Path.cwd()
    values: dict[str, str] = getattr(ctx, "values")
    for key, (rel, marker) in SAMPLES.items():
        root = (repo / rel).resolve()
        if not (root / marker).is_file():
            raise FixtureSkip(
                f"java sample project missing: {root / marker} not found; "
                "the in-repo __fixtures__/jdtls/projects tree must be checked out"
            )
        # Native create/rename/undo tests must not mutate the checkout's samples.
        destination = Path(ctx.case_dir) / "fixture-workspaces" / key
        if any(path.is_symlink() for path in root.rglob("*")):
            raise FixtureSkip(f"sample contains symlinks; cannot isolate workspace: {root}")
        shutil.copytree(root, destination, ignore=shutil.ignore_patterns("target", "build", ".gradle", ".git"))
        values[key] = destination.resolve().as_posix()
