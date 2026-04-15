#!/usr/bin/env sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

if [ ! -f "graphify.toml" ]; then
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN=python
elif command -v py >/dev/null 2>&1; then
  PYTHON_BIN="py -3"
else
  exit 0
fi

# Keep the local graph fresh before each commit without blocking git on tool issues.
sh -c "$PYTHON_BIN tools/agent/build_graphify.py --config graphify.toml" >/dev/null 2>&1 || true
