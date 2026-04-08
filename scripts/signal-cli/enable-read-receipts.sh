#!/bin/sh
# Wrapper entrypoint that patches signal-cli's supervisor config to add
# --send-read-receipts after the jsonrpc2-helper generates it.
#
# The original /entrypoint.sh runs jsonrpc2-helper (which generates the
# supervisor config), starts supervisor, then execs signal-cli-rest-api.
# We can't simply mount a config because jsonrpc2-helper overwrites it.
#
# Strategy: run the original entrypoint, then patch the running supervisor.

exec /entrypoint.sh &
PID=$!

# Wait for supervisor config to appear (jsonrpc2-helper creates it)
CONF=/etc/supervisor/conf.d/signal-cli-json-rpc-1.conf
for i in $(seq 1 60); do
  if [ -f "$CONF" ]; then
    if ! grep -q "send-read-receipts" "$CONF" 2>/dev/null; then
      sed -i 's|daemon |daemon --send-read-receipts |' "$CONF"
      # Wait for supervisor to be up, then reread + update + restart
      sleep 3
      supervisorctl reread 2>/dev/null || true
      supervisorctl update 2>/dev/null || true
      sleep 1
      supervisorctl restart signal-cli-json-rpc-1 2>/dev/null || true
      echo "[read-receipts] Patched signal-cli config with --send-read-receipts"
    else
      echo "[read-receipts] --send-read-receipts already present"
    fi
    break
  fi
  sleep 1
done

wait $PID
