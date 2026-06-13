#!/usr/bin/env python3
"""Call Claude Code as a subagent and return compact JSON for Codex."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


def find_result_event(data: Any) -> dict[str, Any]:
    if isinstance(data, dict):
        if data.get("type") == "result" or "result" in data:
            return data
        return {}

    if isinstance(data, list):
        for item in reversed(data):
            if isinstance(item, dict) and item.get("type") == "result":
                return item
        for item in reversed(data):
            if isinstance(item, dict) and "result" in item:
                return item

    return {}


def extract_init_session_id(data: Any) -> str:
    if not isinstance(data, list):
        return ""
    for item in data:
        if isinstance(item, dict) and item.get("type") == "system" and item.get("subtype") == "init":
            session_id = item.get("session_id")
            if isinstance(session_id, str):
                return session_id
    return ""


def compact_output(raw_stdout: str, stderr: str, returncode: int) -> dict[str, Any]:
    try:
        data = json.loads(raw_stdout)
    except json.JSONDecodeError:
        return {
            "ok": returncode == 0,
            "session_id": "",
            "result": raw_stdout.strip(),
            "parse_error": "stdout was not valid JSON",
        }

    result_event = find_result_event(data)
    session_id = result_event.get("session_id") or extract_init_session_id(data)

    compact = {
        "ok": returncode == 0 and not bool(result_event.get("is_error")),
        "session_id": session_id or "",
        "result": result_event.get("result", ""),
    }

    return compact


def build_command(args: argparse.Namespace) -> list[str]:
    claude = args.claude or shutil.which("claude")
    if not claude:
        raise SystemExit("claude CLI not found. Pass --claude /path/to/claude.")
    if args.resume and args.session_id:
        raise SystemExit("Pass only one of --resume or --session-id, not both.")

    cmd = [
        claude,
        "-p",
        args.prompt,
        "--output-format",
        "json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--max-turns",
        str(args.max_turns),
    ]

    if args.resume:
        cmd.extend(["--resume", args.resume])
    elif args.session_id:
        cmd.extend(["--session-id", args.session_id])

    if args.append_system_prompt:
        cmd.extend(["--append-system-prompt", args.append_system_prompt])
    if args.model:
        cmd.extend(["--model", args.model])
    for directory in args.add_dir:
        cmd.extend(["--add-dir", directory])

    return cmd


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Call Claude Code and emit compact JSON.")
    parser.add_argument("prompt", help="Task to send to Claude Code")
    parser.add_argument("--cwd", default=".", help="Working directory for Claude Code")
    parser.add_argument("--claude", default="", help="Path to claude CLI")
    parser.add_argument("--resume", default="", help="Resume a Claude Code session_id")
    parser.add_argument("--session-id", default="", help="Start/use a specific Claude Code session_id")
    parser.add_argument("--max-turns", type=int, default=256)
    parser.add_argument("--append-system-prompt", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--add-dir", action="append", default=[])
    parser.add_argument("--raw-output", default="", help="Optional path to save raw Claude JSON stdout")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print compact JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cwd = Path(args.cwd).expanduser().resolve()
    if not cwd.exists():
        print(json.dumps({"ok": False, "is_error": True, "result": f"cwd does not exist: {cwd}"}))
        return 2

    proc = subprocess.run(
        build_command(args),
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )

    if args.raw_output:
        raw_path = Path(args.raw_output).expanduser()
        if not raw_path.is_absolute():
            raw_path = cwd / raw_path
        raw_path.parent.mkdir(parents=True, exist_ok=True)
        raw_path.write_text(proc.stdout, encoding="utf-8")

    compact = compact_output(proc.stdout, proc.stderr, proc.returncode)
    if args.raw_output:
        compact["raw_output_path"] = str(raw_path)

    json.dump(compact, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if compact.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
