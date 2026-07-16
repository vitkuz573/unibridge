#!/usr/bin/env bash
#
# start.sh — Start the unibridge proxy.
#
# Usage:
#   ./scripts/start.sh                              # default port 5200
#   UNIBRIDGE_PORT=5200 ./scripts/start.sh           # explicit port
#
# Daemonized via setsid. Logs to /tmp/unibridge.log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${UNIBRIDGE_PORT:-5200}"
LOG="/tmp/unibridge.log"
OUT="/tmp/unibridge-stdout.log"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "unibridge already running on :$PORT"
  echo "Stop with: fuser -k ${PORT}/tcp"
  exit 0
fi

fuser -k "$PORT/tcp" 2>/dev/null || true
: > "$LOG"

setsid -f node "$SCRIPT_DIR/dist/cli.js" </dev/null &>"$OUT"

for i in $(seq 1 10); do
  if lsof -i ":$PORT" >/dev/null 2>&1; then
    echo "unibridge running on :${PORT}"
    echo "Log: $LOG"
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: unibridge failed to start (check $OUT)" >&2
exit 1
