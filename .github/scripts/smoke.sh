#!/usr/bin/env bash
set -euo pipefail

export SMOKE_PORT="${SMOKE_PORT:-7499}"

# Refuse to touch an existing service on the test port.
python3 - <<'PY'
import os
import socket
with socket.socket() as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', int(os.environ['SMOKE_PORT'])))
PY
smoke_root=$(mktemp -d)
export CLAUDE_OFFICE_HOME="$smoke_root/home"
export CLAUDE_OFFICE_CONFIG="$smoke_root/config"
export CLAUDE_OFFICE_STATE="$smoke_root/state"
export CLAUDE_OFFICE_DATA="$smoke_root/data"
python3 -m office serve --demo --port "$SMOKE_PORT" > "$smoke_root/server.log" 2>&1 &
smoke_pid=$!
cleanup() {
  cat "$smoke_root/server.log"
  # Target this port, never a process-name pattern.
  if kill -0 "$smoke_pid" 2>/dev/null; then
    fuser -k -TERM "$SMOKE_PORT/tcp" >/dev/null 2>&1 || true
  fi
  wait "$smoke_pid" 2>/dev/null || true
  rm -rf "$smoke_root"
}
trap cleanup EXIT
for attempt in {1..50}; do
  if curl --silent --fail --max-time 1 "http://127.0.0.1:$SMOKE_PORT/healthz" > /dev/null; then
    break
  fi
  kill -0 "$smoke_pid"
  sleep 0.1
done
for path in /healthz /api/state '/api/history?hours=6' /api/stats /api/settings /; do
  status=$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$SMOKE_PORT$path")
  test "$status" = 200
  echo "$path: $status"
done
status=$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' \
  -H 'Host: foreign.example' "http://127.0.0.1:$SMOKE_PORT/healthz")
test "$status" = 403
echo "Foreign Host: $status"
