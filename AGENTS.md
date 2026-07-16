# Agent Guidelines — unibridge

## Purpose


## Architecture

```
src/
  cli.mjs             # CLI entry point with arg parsing (--port, --config, --host, --log)
  proxy.mjs           # HTTP server, request routing (exports `start()`)
  config.mjs          # config file loader, model routing
  backends/
    registry.mjs      # backend registration and lookup
    opencode.mjs      # opencode protocol adapter
    kilocode.mjs      # kilocode Gateway API adapter
    mimocode.mjs      # mimocode (mimo serve) protocol adapter
    openai.mjs        # generic OpenAI-compatible backend (Ollama, LiteLLM, vLLM...)
```

## Backend interface

Each `src/backends/<name>.mjs` must export:

```js
export const name = 'backend-name';
export async function init(backendConfig) { return ctx; }
export function listModels(backendConfig, ctx) { return [{ id, object }]; }
export async function complete(backendConfig, request, ctx) { return response; }
```

## opencode backend specifics

- Creates a new opencode session per request
- JSON-force injection appended ONLY for requests with a system message (extraction)
- minTokens configurable floor for maxTokens (default 0)
- Streaming optional; enable with `"streaming": true` in backend config or `UNIBRIDGE_STREAMING=true`; uses opencode `/session/:id/prompt_async` + `/event`
- Supports `serverPassword` (required) and `serverUsername` (defaults to `opencode`) for HTTP Basic auth
  — mirrors `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` env vars on the server side

## kilocode backend specifics

- Connects to **Kilo Gateway** (`https://api.kilo.ai/api/gateway`) — OpenAI-compatible API
- Model format: `kilocode/<provider>/<model>` (e.g. `kilocode/openai/gpt-5.5`)
- Auto-discovers all models from Gateway's `GET /models`
- Free models (`:free` suffix) work without API key
- Optional `apiKey` config for paid models (or `KILO_API_KEY` env var)
- No `kilo serve` required — connects directly to Kilo's cloud API
- No streaming support

## mimocode backend specifics

- Connects to **MiMoCode's headless server** (`mimo serve`) — uses same session/message protocol as opencode
- Model format: `mimocode/<provider>/<model>` (e.g. `mimocode/mimo/mimo-auto`)
- Auto-discovers models from `mimo serve`'s `/config/providers`
- Default baseUrl is `http://127.0.0.1:4096`
- Supports `serverPassword` / `serverUsername` for Basic auth (mirrors `MIMOCODE_SERVER_PASSWORD` / `MIMOCODE_SERVER_USERNAME`)
- Shows only `mimo-auto` (free channel) by default; set `freeOnly: false` to expose all configured models
- No streaming support

## openai backend specifics

- Generic OpenAI-compatible backend — works with **any** server exposing the OpenAI chat completions API
- Model format: `openai/<model-id>` (e.g. `openai/llama3`, `openai/gpt-4`)
- Auto-discovers models from the server's `GET /v1/models`
- Config: `baseUrl` (default `http://localhost:11434/v1`) and optional `apiKey`
- Use with: Ollama, LiteLLM, vLLM, text-generation-webui, LocalAI, any OpenAI-compatible endpoint
- Model auto-discovery failures are silent (shows 0 models, `complete()` still works)


- Auto-discovers models from the server's `GET /models`
- Requires `apiKey` config (or set via config file)
- Supports streaming (`stream: true`)
- Extra request params: `plugin` (array of plugin names), `web_search` (boolean) — pass via OpenAI-compatible body fields

## Configuration

All backend config lives in **`unibridge.json`** (autodetected: CWD, `~/`). Copy from `unibridge.example.json`. The file is gitignored.

Top-level env overrides:

| Variable | Description |
|---|---|
| `UNIBRIDGE_CONFIG` | Explicit config file path |
| `UNIBRIDGE_PORT` | Listen port (default: 5200) |
| `UNIBRIDGE_HOST` | Bind address (default: 127.0.0.1) |
| `UNIBRIDGE_DEFAULT_BACKEND` | Default backend name |
| `UNIBRIDGE_LOG` | Log file |
| `UNIBRIDGE_STREAMING` | Enable streaming for opencode/mimocode backends (`true`/`false`) |

No backend-specific env vars. All per-backend config (baseUrl, apiKey, etc.) goes in the config file.

## CLI usage

```bash
unibridge                    # uses unibridge.json in CWD
unibridge --port 5200        # override port
unibridge --config ./cfg.json  # explicit config
unibridge --host 0.0.0.0     # bind all interfaces
unibridge --help             # show help
```

## Model routing

1. `backend/model` format → explicit backend
2. `aliases.<model>` in config file → mapped backend
3. `defaultBackend` in config file → fallback

## Testing

```bash
npm test
# or: node --test scripts/test.mjs

# Smoke test with live proxy:
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
4. Add test file or extend `scripts/test.mjs` to verify interface compliance
5. Document in README.md and AGENTS.md
