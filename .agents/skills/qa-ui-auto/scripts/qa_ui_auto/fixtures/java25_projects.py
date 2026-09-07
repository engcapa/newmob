"""Provision and compile isolated Maven and Gradle projects targeting Java 25."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


MAVEN_POM = """\
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>taomni-java25-maven</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>25</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
"""

APP_JAVA = """\
package com.example.app;

public class App {
    public static void main(String[] args) {
        int value = 40;
        value += 2;
        System.out.println("debug-value=" + value);
    }

    static void completionTargets() {

    }
}
"""

HELPER_JAVA = """\
package com.example.other;

public final class Helper {
    private Helper() {}

    public static int answer() {
        return 42;
    }
}
// PERF:
"""

GRADLE_SETTINGS = "rootProject.name = 'taomni-java25-gradle'\n"
GRADLE_BUILD = """\
plugins {
    id 'java'
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}
"""

GRADLE_APP_JAVA = """\
package org.example.gradle;

public class GradleApp {
    public static void main(String[] args) {
        System.out.println("gradle-java25");
    }
}
"""


def _write(root: Path, relative: str, content: str) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _gradle_binary() -> str | None:
    direct = shutil.which("gradle")
    if direct:
        return direct
    candidates = sorted(
        (Path.home() / ".gradle/wrapper/dists").glob("gradle-*-bin/*/gradle-*/bin/gradle"),
        reverse=True,
    )
    return str(candidates[0]) if candidates else None


def _run_build(command: list[str], root: Path) -> dict[str, Any]:
    started = subprocess.run(
        command,
        cwd=root,
        env={**os.environ, "CI": "true"},
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
    )
    receipt = {
        "command": command,
        "cwd": str(root),
        "exitCode": started.returncode,
        "stdoutTail": started.stdout[-4000:],
        "stderrTail": started.stderr[-4000:],
    }
    if started.returncode != 0:
        raise RuntimeError(
            f"Java 25 fixture build failed ({' '.join(command)}): "
            f"{started.stderr[-1000:] or started.stdout[-1000:]}"
        )
    return receipt


def _jdtls_process_count() -> int:
    count = 0
    proc = Path("/proc")
    if not proc.is_dir():
        return 0
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if "org.eclipse.jdt.ls.core.id1" in command:
            count += 1
    return count


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    if (cfg.get("app") or {}).get("mode", "browser") != "native":
        raise FixtureSkip("java25_projects requires the native host filesystem")
    mvn = shutil.which("mvn")
    gradle = _gradle_binary()
    if not mvn or not gradle:
        raise FixtureSkip("Java 25 Maven/Gradle tooling is not available on this host")

    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    parent = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-java25-", dir=str(base)))
    maven_root = parent / "maven-java25"
    gradle_root = parent / "gradle-java25"

    _write(maven_root, "pom.xml", MAVEN_POM)
    _write(maven_root, "src/main/java/com/example/app/App.java", APP_JAVA)
    _write(maven_root, "src/main/java/com/example/other/Helper.java", HELPER_JAVA)
    _write(gradle_root, "settings.gradle", GRADLE_SETTINGS)
    _write(gradle_root, "build.gradle", GRADLE_BUILD)
    _write(gradle_root, "src/main/java/org/example/gradle/GradleApp.java", GRADLE_APP_JAVA)

    receipts = [
        _run_build([mvn, "-q", "-o", "-DskipTests", "package"], maven_root),
        _run_build([gradle, "--offline", "--no-daemon", "clean", "build"], gradle_root),
    ]
    case_dir = Path(getattr(ctx, "case_dir", report_root))
    (case_dir / "java25-build-receipt.json").write_text(
        json.dumps(receipts, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    values: dict[str, str] = getattr(ctx, "values")
    values.update({
        # These values are interpolated into JSON localStorage payloads and
        # CSS selectors. Slash-separated absolute paths work on Windows and
        # POSIX while remaining valid host paths for native assertions.
        "java25_maven_root": maven_root.as_posix(),
        "java25_gradle_root": gradle_root.as_posix(),
        "java25_maven_app": (maven_root / "src/main/java/com/example/app/App.java").as_posix(),
        "java25_maven_helper": (maven_root / "src/main/java/com/example/other/Helper.java").as_posix(),
        "jdtls_process_count_before": str(_jdtls_process_count()),
    })
