#!/bin/sh
# Wrapper entrypoint that patches signal-cli's supervisor config to add
# --send-read-receipts after the jsonrpc2-helper generates it.

exec /entrypoint.sh &
PID=$!

CONF=/etc/supervisor/conf.d/signal-cli-json-rpc-1.conf
FLAG="send-read-receipts"

patch_config() {
  if [ ! -f "$CONF" ]; then return 1; fi
  if grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then return 1; fi
  # Only patch if 'daemon' is in the command and flag is missing
  if grep -q "daemon" "$CONF" 2>/dev/null; then
    sed -i "s|daemon |daemon --${FLAG} |" "$CONF"
    sleep 2
    supervisorctl reread 2>/dev/null || true
    supervisorctl update 2>/dev/null || true
    sleep 1
    supervisorctl restart signal-cli-json-rpc-1 2>/dev/null || true
    echo "[read-receipts] Patched signal-cli config with --${FLAG}"
    return 0
  fi
  return 1
}

# Wait for supervisor config to appear and stabilize, then patch
for i in $(seq 1 90); do
  if [ -f "$CONF" ]; then
    if grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then
      echo "[read-receipts] --${FLAG} already present"
      break
    fi
    # Wait for jsonrpc2-helper to finish generating the config
    sleep 5
    patch_config && break
  fi
  sleep 1
done

# Background watcher: re-patch if config gets regenerated without the flag.
# Only checks — does not re-patch if flag is already present.
while kill -0 $PID 2>/dev/null; do
  sleep 60
  if [ -f "$CONF" ] && ! grep -q -- "--${FLAG}" "$CONF" 2>/dev/null; then
    echo "[read-receipts] Config regenerated without --${FLAG}, re-patching"
    patch_config
  fi
done &

wait $PID
