# Agent Guidelines — unibridge

## Purpose

Universal OpenAI-compatible proxy for any LLM backend. Routes `/v1/chat/completions` requests to pluggable backends (opencode, OpenAI, Ollama, etc.).

## Architecture

```
src/
  proxy.mjs          # HTTP server, request routing
  config.mjs         # config file loader, model routing
  backends/
    registry.mjs     # backend registration and lookup
    opencode.mjs     # opencode protocol adapter
    kilocode.mjs     # kilocode (kilo serve) protocol adapter
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

## kilocode backend specifics

- Connects to **Kilo Gateway** (`https://api.kilo.ai/api/gateway`) — OpenAI-compatible API
- Model format: `kilocode/<provider>/<model>` (e.g. `kilocode/openai/gpt-5.5`)
- Auto-discovers all models from Gateway's `GET /models`
- Free models (`:free` suffix) work without API key
- Optional `apiKey` config for paid models (or `KILO_API_KEY` env var)
- No `kilo serve` required — connects directly to Kilo's cloud API
- No streaming support

## Configuration

All backend config lives in **`unibridge.json`** (autodetected: CWD, `~/`). Copy from `unibridge.example.json`. The file is gitignored.

Top-level env overrides:

| Variable | Description |
|---|---|
| `UNIBRIDGE_CONFIG` | Explicit config file path |
| `UNIBRIDGE_PORT` | Listen port (default: 5200) |
| `UNIBRIDGE_DEFAULT_BACKEND` | Default backend name |
| `UNIBRIDGE_LOG` | Log file |

No backend-specific env vars. All per-backend config (baseUrl, apiKey, etc.) goes in the config file.

## Model routing

1. `backend/model` format → explicit backend
2. `aliases.<model>` in config file → mapped backend
3. `defaultBackend` in config file → fallback

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
3. Add backend config to your `unibridge.json` under `backends.<name>`
4. Document in README.md and AGENTS.md
