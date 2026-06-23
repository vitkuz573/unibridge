# Agent Guidelines — unibridge

## Purpose

Universal OpenAI-compatible proxy for any LLM backend. Routes `/v1/chat/completions` requests to pluggable backends (opencode, OpenAI, Ollama, etc.).

## Architecture

```
src/
  proxy.mjs          # HTTP server, request routing
  config.mjs         # typed config from env vars, model routing
  backends/
    registry.mjs     # backend registration and lookup
    opencode.mjs     # opencode protocol adapter
```

## Backend interface

Each `src/backends/<name>.mjs` must export:

```js
export const name = 'backend-name';
export function init(backendConfig) { return ctx; }
export function listModels(backendConfig) { return [{ id, object }]; }
export async function complete(backendConfig, request, ctx) { return response; }
```

## opencode backend specifics

- Creates a new opencode session per request
- JSON-force injection appended ONLY for requests with a system message (extraction)
- maxTokens floor at 4096 for reasoning models
- No streaming support

## Configuration

Env vars (no backward compat):

| Variable | Description |
|---|---|
| `UNIBRIDGE_PORT` | Listen port (default: 5200) |
| `UNIBRIDGE_DEFAULT_BACKEND` | Default backend name |
| `UNIBRIDGE_LOG` | Log file |
| `UNIBRIDGE_ALIAS_<model>` | Map model name to backend |
| `OPENCODE_BASE_URL` | opencode server URL |
| `OPENCODE_DEFAULT_MODEL` | opencode default model |

## Model routing

1. `backend/model` format → explicit backend
2. `UNIBRIDGE_ALIAS_<model>` env var → mapped backend
3. `UNIBRIDGE_DEFAULT_BACKEND` → fallback

## Testing

```bash
bash scripts/test.sh

# Or manually:
python3 -c "
from openai import OpenAI
c = OpenAI(api_key='ignored', base_url='http://127.0.0.1:5200/v1')
r = c.chat.completions.create(model='big-pickle', messages=[{'role':'user','content':'Say JSON: {\"hello\":\"world\"}'}], max_tokens=50)
print(r.choices[0].message.content)
"
```

## Adding a backend

1. Create `src/backends/<name>.mjs` with the standard interface
2. Import and register in `src/proxy.mjs`: `registry.register(yourBackend);`
3. Add config to `src/config.mjs` (env var parsing)
4. Document in README.md and AGENTS.md
