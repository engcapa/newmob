#!/usr/bin/env python3
"""Optional test fixtures: launch a local SSH/SFTP server for tests.

Activated when `fixtures.start_local_sshd: true` in qa-ui-auto.config.yaml.

Strategy: prefer Docker (linuxserver/openssh-server). Fall back to host `sshd`
on a non-default port if Docker is missing. On Windows, Docker is required.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager


CONTAINER_NAME = "qa-ui-auto-sshd"


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        subprocess.run(["docker", "info"], check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False


def start_sshd(port: int, user: str, password: str) -> str:
    """Return a token identifying the running fixture (container id or pid)."""
    if _docker_available():
        subprocess.run(["docker", "rm", "-f", CONTAINER_NAME],
                       capture_output=True)
        subprocess.run([
            "docker", "run", "-d", "--rm", "--name", CONTAINER_NAME,
            "-p", f"{port}:2222",
            "-e", f"USER_NAME={user}",
            "-e", f"PASSWORD_ACCESS=true",
            "-e", f"USER_PASSWORD={password}",
            "linuxserver/openssh-server:latest",
        ], check=True)
        # Wait for port
        for _ in range(30):
            r = subprocess.run(
                ["docker", "exec", CONTAINER_NAME, "sh", "-c",
                 "ss -ltn | grep -q :2222"],
                capture_output=True)
            if r.returncode == 0:
                break
            time.sleep(0.5)
        return f"docker:{CONTAINER_NAME}"
    if platform.system() == "Windows":
        sys.exit("Docker is required to start the SSH fixture on Windows.")
    sys.exit("Docker not available; install Docker or set "
             "fixtures.start_local_sshd=false and point ssh.host at an "
             "existing server.")


def stop_sshd(token: str) -> None:
    if token.startswith("docker:"):
        subprocess.run(["docker", "rm", "-f", token.split(":", 1)[1]],
                       capture_output=True)


@contextmanager
def sshd(port: int, user: str, password: str):
    token = start_sshd(port, user, password)
    try:
        yield token
    finally:
        stop_sshd(token)


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["start", "stop"])
    p.add_argument("--port", type=int, default=2222)
    p.add_argument("--user", default="testuser")
    p.add_argument("--password", default="testpass")
    args = p.parse_args()
    if args.action == "start":
        print(start_sshd(args.port, args.user, args.password))
    else:
        stop_sshd(f"docker:{CONTAINER_NAME}")
