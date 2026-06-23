# Agent Guidelines — opencode-graphify-bridge

## Purpose

This repository provides an OpenAI-compatible proxy for opencode local LLMs, enabling tools like graphify to use opencode models for structured output extraction.

## How it works

1. Tools (graphify, etc.) call the proxy at `/v1/chat/completions`
2. Proxy translates to opencode's session/message protocol
3. Proxy strips markdown fences from responses
4. Proxy conditionally appends JSON-force instruction:
   - **Extraction** (has system message) → JSON appended to force structured output
   - **Labeling / plain-text** (no system message) → no JSON-force, model follows prompt naturally

## Critical invariants

1. **Model selection**: The proxy respects the `model` field from OpenAI requests. Format: `opencode/big-pickle`. If the model field is absent or `null`, the proxy falls back to `PROXY_MODEL` env var, then to `big-pickle`.

2. **`response_format`**: Passed through to the SDK but currently ignored by the opencode server. The proxy relies on the JSON-force injection instead.

3. **`format` parameter (json_schema)**: NOT used. Causes empty responses with reasoning models. The `session.prompt()` SDK method with `format: { type: 'json_schema', schema: {...} }` is explicitly avoided.

 4. **JSON-force injection**: Appended ONLY for requests with a system message (extraction). Detection is by `hasSystem = system.length > 0`. Labeling calls (graphify cluster-only) send no system message — the model follows the prompt's own JSON instruction without interference.
    ```
    IMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.
    ```
    Reasoning models (big-pickle, north-mini-code-free) heavily weight user messages. System-prompt JSON constraints are routinely ignored; user-message constraints are reliably followed.

5. **Session management**: A new opencode session is created per request. No session caching.

6. **Startup**: The proxy must be started with `setsid -f` or `nohup` to survive the parent shell. The `scripts/start.sh` script handles this.

## Updating the model list

When new models become available, add them to the `MODELS` array in `src/proxy.mjs`. Both the `/v1/models` endpoint and the model parsing logic will pick them up automatically.

## Testing

```bash
# Start proxy
bash scripts/start.sh

# Run connectivity test
bash scripts/test.sh

# Manual test
python3 -c "
from openai import OpenAI
c = OpenAI(api_key='ignored', base_url='http://127.0.0.1:5200/v1')
r = c.chat.completions.create(
    model='big-pickle',
    messages=[{'role':'user','content':'Say a JSON with hello: world'}],
    max_tokens=50,
)
print(r.choices[0].message.content)
"
```

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Connection error` | Proxy process killed | `setsid -f node src/proxy.mjs` |
| Empty response | `format` parameter used | Remove `format`, rely on JSON-force injection |
| Natural language output (extraction) | Missing JSON-force injection for system-bearing requests | Check `hasSystem && parts.length > 0` branch |
| `SDK 404` | opencode server not running | Start `opencode serve --port 5100` |
| Slow response | Large prompt or slow model | Use `big-pickle` (fastest), check network |
