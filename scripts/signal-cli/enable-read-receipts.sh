#!/bin/sh
# Wrapper entrypoint that patches signal-cli's supervisor config to add
# --send-read-receipts after the jsonrpc2-helper generates it.

exec /entrypoint.sh &
PID=$!

CONF=/etc/supervisor/conf.d/signal-cli-json-rpc-1.conf
FLAG="send-read-receipts"

# Wait for supervisorctl to be reachable, then reload and restart the process.
# This is separate from patch_config because supervisord may not be up yet
# when the config file first appears — we must not let the restart step fail
# silently and leave the process running without the flag.
supervisorctl_reload() {
  for j in $(seq 1 30); do
    if supervisorctl version >/dev/null 2>&1; then
      supervisorctl reread 2>/dev/null || true
      supervisorctl update 2>/dev/null || true
      sleep 1
      supervisorctl restart signal-cli-json-rpc-1 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  echo "[read-receipts] WARNING: supervisorctl not reachable after 30s, process restart skipped"
  return 1
}

patch_config() {
  if [ ! -f "$CONF" ]; then return 1; fi
  if grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then return 1; fi
  # Only patch once jsonrpc2-helper has written the daemon subcommand line
  if grep -q "daemon" "$CONF" 2>/dev/null; then
    sed -i "s|daemon |daemon --${FLAG} |" "$CONF"
    echo "[read-receipts] Config patched with --${FLAG}, waiting for supervisorctl..."
    supervisorctl_reload
    echo "[read-receipts] Done"
    return 0
  fi
  return 1
}

# Wait for the daemon subcommand to appear in the config, then patch.
# Checking for "daemon" (not just the file existing) avoids patching a
# partially-written config before jsonrpc2-helper has finished.
for i in $(seq 1 90); do
  if grep -q "daemon" "$CONF" 2>/dev/null; then
    if grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then
      echo "[read-receipts] --${FLAG} already present"
      break
    fi
    patch_config && break
  fi
  sleep 1
done

# Background watcher: re-patch if config is regenerated without the flag.
while kill -0 $PID 2>/dev/null; do
  sleep 60
  if [ -f "$CONF" ] && ! grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then
    echo "[read-receipts] Config regenerated without --${FLAG}, re-patching"
    patch_config
  fi
done &

wait $PID
