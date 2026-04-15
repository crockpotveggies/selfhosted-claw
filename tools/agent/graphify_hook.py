#!/usr/bin/env python3
"""PreToolUse hook for Claude Code."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GRAPH_PATH = REPO_ROOT / ".graphify" / "graph.json"


def main() -> None:
    if not GRAPH_PATH.exists():
        sys.exit(0)

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})

    query: str | None = None
    if tool_name == "Grep":
        query = tool_input.get("pattern") or tool_input.get("query")
    elif tool_name == "Glob":
        query = tool_input.get("pattern")

    if not query:
        sys.exit(0)

    try:
        result = subprocess.run(
            [sys.executable, "-m", "graphify", "query", query, "--graph", str(GRAPH_PATH)],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=str(REPO_ROOT),
        )
        if result.returncode == 0 and result.stdout.strip():
            message = " ".join(result.stdout.split())[:500]
            print(
                json.dumps(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": "PreToolUse",
                            "additionalContext": f"[graphify] {message}",
                        }
                    }
                )
            )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
