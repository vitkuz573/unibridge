# Agent Guidelines — unibridge

## Purpose

Universal OpenAI-compatible proxy for any LLM backend. Routes `/v1/chat/completions`, `/v1/completions`, and `/v1/responses` requests to pluggable backends (opencode, kilocode, mimocode, openai).

## Architecture

```
src/
  cli.ts              # CLI entry point with arg parsing (--port, --config, --host, --log)
  proxy.ts            # thin re-export (delegates to server.ts)
  server.ts           # server lifecycle + backend registration
  router.ts           # URL routing to handlers
  config.ts           # config file loader, model routing
  types.ts            # shared TypeScript types
  sse.ts              # SSE streaming helpers
  cache.ts            # response caching
  utils.ts            # shared utilities (logging, body parsing, etc.)
  handlers/
    chat-completions.ts   # /v1/chat/completions
    completions.ts        # /v1/completions
    responses.ts          # /v1/responses
    embeddings.ts         # /v1/embeddings
  backends/
    index.ts              # single registration point (imports + registers all backends)
    registry.ts           # backend registration and lookup
    shared/
      session-protocol.ts # shared opencode/mimocode session logic
      sse-parser.ts       # shared SSE parsing
    opencode.ts           # opencode protocol adapter
    kilocode.ts           # kilocode Gateway API adapter
    mimocode.ts           # mimocode (mimo serve) protocol adapter
    openai.ts             # generic OpenAI-compatible backend (Ollama, LiteLLM, vLLM...)
```

## Backend interface

Each `src/backends/<name>.mjs` must export:

```js
export const name = 'backend-name';
export async function init(backendConfig) { return ctx; }
export function listModels(backendConfig, ctx) { return [{ id, object }]; }
export async function complete(backendConfig, request, ctx) { return response; }
export async function responses(backendConfig, request, ctx) { returnresponseObject; }  // optional
```

The optional `responses()` method provides native OpenAI Responses API support. If a backend exports it, `/v1/responses` calls use it directly instead of converting through chat completions.

## opencode backend specifics

- Speaks only the local `opencode serve` **v2 HTTP API** (`/api/model`, `/api/session`, `/api/session/{id}/prompt`, `/api/session/{id}/message`, `/api/session/{id}/permission`, `/api/event`). The server owns provider credentials and performs every upstream provider call; unibridge never contacts a provider endpoint and never reads provider settings from model metadata
- Creates a new opencode session per request with `Model.Ref` = the discovered `modelID`/`providerID` plus the selected `variant`
- Sessions are created with `[{ "action": "*", "resource": "*", "effect": "ask" }]`: the canonical agent tool profile stays advertised upstream (opencode's free tier rejects requests whose tool profile is stripped), while every actual execution needs approval. unibridge rejects every `permission.asked` event immediately, so no local tool ever runs
- Prompt input is one `text` string: the OpenAI message list is flattened into a transcript (`[System instructions: ...]` block, structured `function_call`/`tool_result` JSON for tool history). Generation knobs the v2 prompt API does not accept (`max_tokens`, `temperature`, `response_format`) are not sent; structured output is guaranteed locally by `backends/shared/structured.ts` with the schema reminder in the prompt and retries on mismatch
- minTokens configurable floor for maxTokens is retained for wire compatibility but is not forwarded (the v2 prompt API has no token limit field)
- Streaming optional; enable with `"streaming": true` in backend config or `UNIBRIDGE_STREAMING=true`; uses `POST /api/session/{id}/prompt` + `GET /api/event` (`session.text.*`, `session.reasoning.*`, `session.step.ended`, `session.execution.*`)
- Client tool decisions carry an array of calls (`{"type":"function_call","calls":[...]}`, max 4) so one round can request independent read-only tools; `completeStreaming` scans the streamed decision JSON incrementally and emits a text decision as token deltas, while a function-call decision surfaces as one `tool_calls` delta with all calls. The system instruction is strict JSON-only with few-shot examples because models otherwise attempt native tool calls. An unrecognized reply is retried up to 3 times with validation feedback; if it still fails but carries prose (or a bare `text` field), the prose is streamed as a normal answer with `finish_reason: stop`. Streams always terminate with a finish/error frame plus `[DONE]` — the handler catches mid-stream exceptions and emits an OpenAI error frame instead of a silent `res.end()`. Exactly one successful model call per round
- Reasoning/chain-of-thought never rides in `delta.content`: `session.reasoning.delta` events go to `delta.reasoning_content` and `session.text.delta` events to `delta.content`. Non-stream replies expose `message.reasoning_content` (alias `message.reasoning`) with clean `message.content`
- Supports `serverPassword` (required) and `serverUsername` (defaults to `opencode`) for HTTP Basic auth
  — mirrors `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` env vars on the server side
- Discovers per-model capabilities and reasoning metadata from `/api/model` and advertises it on `/v1/models` as
  `capabilities` + `reasoning` (`supported`, `parameter`, `default`, `levels`). Levels are `variant` ids plus the
  `"default"` sentinel (no override); a model with a `compatibility.reasoningField` but no variants exposes exactly
  `["default"]`, and a model without either exposes `[]`. `reasoning_effort` on the request is validated against the
  routed model (400 with the supported list otherwise) and applied as the session's `Model.Ref.variant`
- Every fetch is bounded and caught: a slow or unavailable opencode degrades to a logged init failure with a 30s
  background retry, and requests fail as HTTP errors instead of terminating the process
- Native Responses API support: exports `responses()` for `/v1/responses` endpoints, handling input parsing (string, array of message/text/image items), system/developer role extraction, and returning `ResponseObject` directly

## kilocode backend specifics

- Connects to **Kilo Gateway** (`https://api.kilo.ai/api/gateway`) — OpenAI-compatible API
- Model format: `kilocode/<provider>/<model>` (e.g. `kilocode/openai/gpt-5.5`)
- Auto-discovers all models from Gateway's `GET /models`
- Free models (`:free` suffix) work without API key
- Optional `apiKey` config for paid models (or `KILO_API_KEY` env var)
- No `kilo serve` required — connects directly to Kilo's cloud API
- No streaming support

## mimocode backend specifics

- Connects to **MiMoCode's headless server** (`mimo serve`) — its own session/message protocol
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
2. Import and register in `src/backends/index.ts`: `registry.register(yourBackend);`
3. Add backend config to your `unibridge.json` under `backends.<name>`
4. Add test file or extend `scripts/test.mjs` to verify interface compliance
5. Document in README.md and AGENTS.md
