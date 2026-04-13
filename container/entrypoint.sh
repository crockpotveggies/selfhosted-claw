#!/bin/bash
set -e

cd /app

# ── Fast-path: skip TypeScript recompilation if source is unchanged ──
#
# The Dockerfile pre-compiles /app/src → /app/dist at image build time and
# records a checksum of the source files in /app/.src-checksum.
#
# Per-group agent-runner customizations are mounted over /app/src by the host.
# If the mounted source matches the build checksum, we reuse /app/dist directly
# (saving 1-3 seconds). If it differs, we recompile to /tmp/dist.

BUILT_CHECKSUM=""
if [ -f /app/.src-checksum ]; then
  BUILT_CHECKSUM=$(cat /app/.src-checksum)
fi

CURRENT_CHECKSUM=$(find /app/src -name '*.ts' -exec md5sum {} \; | sort | md5sum | cut -d' ' -f1)

if [ "$BUILT_CHECKSUM" = "$CURRENT_CHECKSUM" ] && [ -d /app/dist ] && [ -f /app/dist/index.js ]; then
  # Source unchanged — use pre-built dist directly
  DIST_DIR=/app/dist
else
  # Source changed (group customization) — recompile
  npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  DIST_DIR=/tmp/dist
fi

# Read container input from stdin, then run the agent
cat > /tmp/input.json
node "$DIST_DIR/index.js" < /tmp/input.json
