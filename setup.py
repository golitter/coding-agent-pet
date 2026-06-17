#!/usr/bin/env python3
"""Kotori Pet setup 入口分发器。

根据当前平台调用对应的平台入口脚本（Windows → PowerShell，macOS/Linux → bash）。
逻辑与历史 setup.mjs 对齐：仅做平台分发，真正的工作在平台脚本里。
"""

import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
PLATFORM_DIR = ROOT_DIR / "desktop" / "cross-platform"


def main() -> int:
    system = sys.platform

    if system == "win32":
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(PLATFORM_DIR / "scripts" / "windows" / "setup.ps1"),
        ]
    elif system in ("darwin", "linux"):
        command = ["bash", str(PLATFORM_DIR / "scripts" / "macos" / "setup.sh")]
    else:
        print(f"Unsupported platform: {system}", file=sys.stderr)
        return 1

    try:
        result = subprocess.run(command, cwd=ROOT_DIR)
    except FileNotFoundError as exc:
        print(f"Failed to start setup command: {exc}", file=sys.stderr)
        return 1

    return result.returncode if result.returncode is not None else 1


if __name__ == "__main__":
    sys.exit(main())
