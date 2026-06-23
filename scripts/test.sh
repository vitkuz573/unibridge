#!/usr/bin/env bash
#
# test.sh — Verify connectivity to all models through unibridge.
#
# Usage:
#   ./scripts/test.sh

set -euo pipefail

PROXY_URL="${PROXY_URL:-http://127.0.0.1:5200/v1}"
TIMEOUT="${TIMEOUT:-30}"

if ! curl -sf --max-time 3 "$PROXY_URL/models" >/dev/null 2>&1; then
  echo "ERROR: unibridge not reachable at $PROXY_URL"
  echo "Start it: ./scripts/start.sh"
  exit 1
fi

echo "=== unibridge connectivity test ==="
echo "Proxy: $PROXY_URL"
echo ""

for model in big-pickle north-mini-code-free deepseek-v4-flash-free nemotron-3-ultra-free mimo-v2.5-free; do
  printf "%-30s " "$model"
  start=$(date +%s%N)
  response=$(timeout "$TIMEOUT" python3 -c "
from openai import OpenAI
import json
c = OpenAI(api_key='ignored', base_url='$PROXY_URL')
r = c.chat.completions.create(
    model='$model',
    messages=[{'role':'user','content':'Say only: {\"test\": \"ok\"}'}],
    max_tokens=30,
    timeout=$((TIMEOUT - 5))
)
print(json.dumps({'content': r.choices[0].message.content, 'tokens': r.usage.total_tokens}))
" 2>&1) || true
  end=$(date +%s%N)
  elapsed_ms=$(( (end - start) / 1000000 ))

  if echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['content'] == '{\"test\": \"ok\"}'" 2>/dev/null; then
    echo "OK ${elapsed_ms}ms"
  else
    echo "FAIL ${elapsed_ms}ms — ${response:0:80}"
  fi
done

echo ""
echo "Done."
