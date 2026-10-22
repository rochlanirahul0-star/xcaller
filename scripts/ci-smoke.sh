#!/usr/bin/env bash
# Start a throwaway server, run the realtime + call-signalling suite, stop it.
set -euo pipefail
cd "$(dirname "$0")/.."

export XC_DATA_DIR="$(mktemp -d)"
export PORT="${PORT:-3910}"
export HOST=127.0.0.1

node server.js >/tmp/xcaller-ci.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -rf "$XC_DATA_DIR"' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/chat/api/health" >/dev/null; then break; fi
  sleep 0.25
done

ADMIN_PW="$(grep '^password:' "$XC_DATA_DIR/ADMIN_PASSWORD.txt" | cut -d' ' -f2-)"
[ -n "$ADMIN_PW" ] || { echo "admin password was not seeded"; cat /tmp/xcaller-ci.log; exit 1; }

BASE="http://127.0.0.1:${PORT}/chat" ADMIN_PW="$ADMIN_PW" node test/realtime-check.mjs
