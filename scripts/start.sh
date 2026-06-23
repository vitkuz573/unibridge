#!/usr/bin/env bash
#
# start.sh — Start the opencode-graphify-bridge proxy.
#
# Usage:
#   ./scripts/start.sh                    # default port 5200
#   PROXY_PORT=5200 ./scripts/start.sh    # explicit port
#
# The proxy is daemonized via setsid so it survives the terminal session.
# Logs go to /tmp/opencode-proxy.log and /tmp/opencode-proxy-stdout.log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_PORT="${PROXY_PORT:-5200}"
SDK_URL="${SDK_URL:-http://127.0.0.1:5100}"
PROXY_MODEL="${PROXY_MODEL:-}"
PROXY_LOG="/tmp/opencode-proxy.log"
PROXY_OUT="/tmp/opencode-proxy-stdout.log"

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# Check if already running
if lsof -i ":$PROXY_PORT" >/dev/null 2>&1; then
  echo "opencode-graphify-bridge already running on :$PROXY_PORT"
  echo "Stop with: fuser -k ${PROXY_PORT}/tcp"
  exit 0
fi

# Kill any stale proxy on this port
fuser -k "$PROXY_PORT/tcp" 2>/dev/null || true

# Clear log
: > "$PROXY_LOG"

# Start
export SDK_URL PROXY_MODEL
setsid -f node "$SCRIPT_DIR/src/proxy.mjs" </dev/null &>"$PROXY_OUT"

# Wait for startup
for i in $(seq 1 10); do
  if lsof -i ":$PROXY_PORT" >/dev/null 2>&1; then
    echo "opencode-graphify-bridge running on :$PROXY_PORT → $SDK_URL"
    echo "Log: $PROXY_LOG"
    exit 0
  fi
  sleep 0.5
done

echo "ERROR: proxy failed to start (check $PROXY_OUT)" >&2
exit 1
