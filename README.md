<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vitkuz573/unibridge/master/docs/logo-dark.svg">
    <img alt="unibridge" src="https://raw.githubusercontent.com/vitkuz573/unibridge/master/docs/logo-light.svg" width="380">
  </picture>
</p>

<p align="center">
  <em>Pluggable proxy between OpenAI-compatible clients and any LLM backend protocol.</em>
</p>

<p align="center">
  <a href="https://github.com/vitkuz573/unibridge"><img src="https://img.shields.io/badge/version-2.0.0--dev-blue?logo=github" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License"></a>
  <a href="https://github.com/vitkuz573/unibridge"><img src="https://img.shields.io/github/stars/vitkuz573/unibridge?style=flat&label=stars&logo=github" alt="Stars"></a>
  <a href="https://hub.docker.com/r/vitkuz573/unibridge"><img src="https://img.shields.io/badge/docker-available-blue?logo=docker" alt="Docker"></a>
  <a href="https://www.npmjs.com/package/unibridge"><img src="https://img.shields.io/badge/npm-unibridge-blue?logo=npm" alt="npm"></a>
</p>

```ts
import OpenAI from 'openai';

// Point any OpenAI client at unibridge — it handles the rest
const client = new OpenAI({ baseURL: 'http://127.0.0.1:5200/v1' });

// Chat Completions API
const res = await client.chat.completions.create({
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'Hello' }],
});

// Responses API (OpenAI Codex CLI, etc.)
const stream = await client.responses.create({
  model: 'big-pickle',
  input: 'Hello',
  stream: true,
});
```

---

- **Protocol bridge, not provider router** — most proxies map between provider APIs (OpenAI ↔ Anthropic ↔ Cohere). unibridge maps between *protocols*: OpenAI API ↔ anything. Your backend speaks its own format? Write an adapter.
- **One config file** — `unibridge.json` holds everything. No env var explosion per backend.
- **TypeScript** — OpenAI SDK wire types, full type safety, starts in milliseconds.
- **Pluggable adapters** — `src/backends/<name>.ts` exports `{ name, init, listModels, complete }`. New backend in ~50 lines.
- **Model routing** — `backend/model`, alias map, default fallback.
- **For any OpenAI client** — Codex CLI, LangChain, LlamaIndex, raw curl, any OpenAI SDK. All speak OpenAI API.

---

<details>
<summary><b>Table of Contents</b></summary>

- [Quick Start](#quick-start)
- [Why this instead of LiteLLM?](#why-this-instead-of-litellm)
- [Configuration](#configuration)
- [Model Routing](#model-routing)
- [API Endpoints](#api-endpoints)
- [API Key Authentication](#api-key-authentication)
- [Security](#security)
- [Rate Limiting](#rate-limiting)
- [Response Caching](#response-caching)
- [Timeouts](#timeouts)
- [Network Proxy](#network-proxy)
- [Model Aliases](#model-aliases)
- [Config Hot-Reload](#config-hot-reload)
- [Verbose Logging](#verbose-logging)
- [Backend Interface](#backend-interface)
- [Docker](#docker)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

</details>

---

## Quick Start

### npx (no install)

```bash
cp unibridge.example.json unibridge.json
npx unibridge
```

### npm global

```bash
npm install -g unibridge
cp unibridge.example.json unibridge.json
unibridge --port 5200
```

### Docker

```bash
docker run -p 5200:5200 \
  -v $(pwd)/unibridge.json:/app/unibridge.json \
  ghcr.io/vitkuz573/unibridge
```

### Docker Compose

```bash
docker compose up -d
```

### Build from source (Docker)

```bash
docker build -t unibridge .
docker run -p 5200:5200 -v $(pwd)/unibridge.json:/app/unibridge.json unibridge
```

### From source

```bash
git clone https://github.com/vitkuz573/unibridge.git
cd unibridge
npm install
cp unibridge.example.json unibridge.json
npm run dev
```

```bash
# Chat Completions
curl http://127.0.0.1:5200/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"Hello"}]}'

# Responses API (Codex CLI, etc.)
curl http://127.0.0.1:5200/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","input":"Hello","stream":true}'
```

```bash
# Or point any OpenAI-compatible tool:
export OPENAI_BASE_URL="http://127.0.0.1:5200/v1"
```

### From any OpenAI client

```python
from openai import OpenAI
client = OpenAI(base_url='http://127.0.0.1:5200/v1', api_key='ignored')

# Chat Completions
reply = client.chat.completions.create(
    model='big-pickle',
    messages=[{'role': 'user', 'content': 'Hello'}],
)

# Responses API
stream = client.responses.create(
    model='big-pickle',
    input='Hello',
    stream=True,
)
```

---

## Why this instead of LiteLLM?

LiteLLM routes between *provider APIs*. It knows the wire format of 100+ SaaS providers.

unibridge bridges *protocols*. It sits between an OpenAI API client and a backend that doesn't speak OpenAI API. Completely different problem.

| | LiteLLM | unibridge |
|---|---|---|
| Problem | Unify 15 SaaS providers | Connect OpenAI client to non-OpenAI backend |
| Approach | 100+ provider templates | Adapter pattern — you write the glue |
| Runtime | Python, heavy | Single TypeScript project, zero deps |
| Config | Env vars per provider | One config file |
| When to use | You have GPT-4, Claude, Gemini, etc. | Your backend has its own protocol (custom SDK, gRPC, WebSocket, etc.) |

---

## Configuration

Config lives in `unibridge.json` (auto-detected: CWD, `~/`). Copy from `unibridge.example.json`.

```json
{
  "port": 5200,
  "host": "127.0.0.1",
  "apiKey": "",
  "defaultBackend": null,
  "logFile": "/tmp/unibridge.log",
  "verbose": false,
  "streaming": false,
  "rateLimit": {
    "windowMs": 60000,
    "max": 60
  },
  "cache": {
    "enabled": false,
    "ttl": 60
  },
  "backends": {
    "opencode": {
      "baseUrl": "http://127.0.0.1:5100",
      "serverPassword": "",
      "serverUsername": "opencode",
      "minTokens": 0
    },
    "kilocode": {
      "baseUrl": "http://127.0.0.1:5101",
      "minTokens": 0
    },
    "mimocode": {
      "baseUrl": "http://127.0.0.1:4096",
      "serverPassword": "",
      "serverUsername": "mimocode",
      "minTokens": 0
    },
    "openai": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": ""
    }
  },
  "aliases": {
    "pickle": "opencode/big-pickle",
    "fast": "kilocode/stepfun/step-3.7-flash:free"
  }
}
```

| Setting | Description |
|---|---|
| `port` | Listen port (default: `5200`) |
| `host` | Bind address (default: `127.0.0.1`) |
| `apiKey` | Require `Authorization: Bearer <key>` on all API requests (except `/health`, `/`, `/v1`) |
| `defaultBackend` | Fallback backend name |
| `logFile` | Log file path |
| `verbose` | Log request/response bodies (default: `false`) |
| `streaming` | Enable streaming for opencode/mimocode backends (default: `false`) |
| `rateLimit` | Global rate limit: `{ windowMs, max }` |
| `cache` | Response cache: `{ enabled, ttl }` (ttl in seconds) |
| `backends.<name>` | Per-backend config (see below) |
| `aliases.<model>` | Map model name to backend |

Per-backend options:

| Option | Description | Default |
|---|---|---|
| `baseUrl` | Backend API URL | — |
| `apiKey` | API key (openai, kilocode) | — |
| `serverPassword` | HTTP Basic auth password (opencode, mimocode) | — |
| `serverUsername` | HTTP Basic auth username (opencode, mimocode) | `opencode` |
| `proxy` | HTTP/HTTPS proxy URL for backend requests (requires `undici`) | — |
| `timeout` | Request timeout in ms | `300000` (5 min) |
| `rateLimit` | Per-backend rate limit: `{ windowMs, max }` | `{ windowMs: 60000, max: 30 }` |
| `minTokens` | Minimum `maxTokens` floor (opencode, kilocode, mimocode) | `0` |

Top-level env overrides:

| Variable | Description | Default |
|---|---|---|
| `UNIBRIDGE_CONFIG` | Explicit config path | auto-detect |
| `UNIBRIDGE_PORT` | Listen port | from config |
| `UNIBRIDGE_HOST` | Bind address | `127.0.0.1` |
| `UNIBRIDGE_DEFAULT_BACKEND` | Fallback backend | from config |
| `UNIBRIDGE_LOG` | Log file path | from config |
| `UNIBRIDGE_VERBOSE` | Enable verbose logging (`true`/`false`) | `false` |
| `UNIBRIDGE_STREAMING` | Enable streaming for opencode/mimocode backends (`true`/`false`) | `false` |

---

## Model Routing

| Pattern | Example | Behaviour |
|---|---|---|
| `backend/model` | `my-backend/gpt-4` | Route to explicit backend |
| `model` only | `some-model` | Look up `aliases`, fall back to `defaultBackend` |
| `/v1/models` | — | Lists all models from all configured backends |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Service info (name, version, docs URL) |
| GET | `/health` | Health check — status, uptime, backends, cache size |
| GET | `/v1` | Health check (alias for `/health`) |
| GET | `/v1/models` | List all models from all configured backends |
| GET | `/v1/aliases` | List configured model aliases |
| GET | `/metrics` | Prometheus-format metrics (counters, histograms) |
| POST | `/v1/chat/completions` | Chat Completions API (supports `response_format`) |
| POST | `/v1/completions` | Legacy Completions API |
| POST | `/v1/responses` | Responses API (supports `text.format`) |
| POST | `/v1/embeddings` | Embeddings API (requires backend support) |

---

## Structured Output

Native OpenAI contract, no prompt hacks. Send `response_format` and unibridge
validates the model reply locally against your schema:

```json
{
  "model": "opencode/muse-spark-1.3-contributor-free",
  "messages": [{ "role": "user", "content": "The sky is blue." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "sky",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "sky": { "type": "string" } },
        "required": ["sky"],
        "additionalProperties": false
      }
    }
  }
}
```

- `{"type": "json_object"}` — reply must be valid JSON (any shape).
- `{"type": "json_schema", "json_schema": {"schema": {...}}}` — reply must be
  valid JSON **and** match the schema (strict subset: type, enum, const,
  properties, required, additionalProperties, items, anyOf/oneOf, string/number
  bounds, pattern, local `$ref`).
- `/v1/responses` accepts the same contract as `text.format`.
- The `response_format` is forwarded best-effort to the upstream; the
  guarantee comes from local validation. On mismatch the request is retried
  once with the validation error as feedback; if it still fails you get
  `502 structured output validation failed` with the exact errors.
- Streaming cannot retry mid-stream — validate the final text client-side.

---

## Reasoning / Chain of Thought

Models that reason before answering (for example `opencode/big-pickle`) can
stream their internal chain of thought. unibridge keeps it off the answer
channel and maps it to the industry-standard fields:

- **Streaming** — reasoning deltas arrive in `choices[].delta.reasoning_content`
  (DeepSeek-compatible); `choices[].delta.content` carries the final answer
  only. Chunk order is preserved: reasoning, then text, then tool calls, then
  the finish chunk.
- **Non-stream** — `choices[].message.content` is the answer only;
  `choices[].message.reasoning_content` carries the reasoning, with
  `message.reasoning` as an OpenRouter-compatible alias.
- **Responses API** — reasoning is emitted as a separate `reasoning` output
  item, never inside `output_text`.

```text
data: {"choices":[{"delta":{"reasoning_content":"All but 9 run away..."},"finish_reason":null}]}
data: {"choices":[{"delta":{"content":"9 sheep are left."},"finish_reason":null}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":...}}
```

Clients that render only `delta.content` never see the chain of thought;
clients that understand reasoning can render it separately.

---

## Tool Calling

Native OpenAI contract: `tools` + `tool_choice` in, `tool_calls` +
`finish_reason: tool_calls` out. Multi-turn via `role: tool` messages.

Two modes on the opencode backend:

**Default — local tools.** Non-empty `tools` offers all local serve tools
(`{"*": true}`); the model executes them inside the opencode session and you
get the final text. `tool_choice`: `none` → `none`, `required` → `required`,
anything else → `auto`. Your JSON schemas are not sent upstream — serve only
accepts a `{name: bool}` map, so this mode is for agentic execution, not for
client-side functions.

**`clientTools: true` — client-executed tools (the ideal).** Your tool
schemas never go to serve (local tools stay disabled). The model is asked via
native `response_format json_schema` to return either
`{"type":"function_call","name":...,"arguments":{...}}` or
`{"type":"text","text":...}`, validated locally. You get `tool_calls` to
execute yourself, return `role: tool`, and the loop continues until text:

```json
{
  "backends": {
    "opencode": {
      "baseUrl": "http://127.0.0.1:5100",
      "clientTools": true
    }
  }
}
```

kilocode/openai backends always proxy `tools`/`tool_choice` 1:1 (natively
OpenAI-compatible upstream).

---

## API Key Authentication

Set `apiKey` in config to require `Authorization: Bearer <key>` on all API requests:

```json
{
  "apiKey": "my-secret-key"
}
```

Endpoints exempt from auth: `/health`, `/`, `/v1`.

---

## Security

By default unibridge binds to `127.0.0.1` (localhost only). If you set `host: "0.0.0.0"` or use `--host 0.0.0.0`, the proxy is accessible from your entire network. In that case:

1. **Set `apiKey`** in your config to require Bearer tokens on all API requests.
2. **Set `serverPassword`** on opencode/mimocode backends so unibridge authenticates to them.
3. **Set `apiKey`** on openai/kilocode backends to authenticate upstream requests.
4. **Use HTTPS** in front of unibridge (nginx, Caddy, cloud LB) — unibridge itself serves plain HTTP.

Never expose unibridge to the public internet without API key authentication enabled.

---

## Rate Limiting

Global rate limiting applies to all endpoints (except `/health`, `/`, `/v1`):

```json
{
  "rateLimit": {
    "windowMs": 60000,
    "max": 60
  }
}
```

Per-backend rate limiting is also supported — each backend has its own default of 30 req/min:

```json
{
  "backends": {
    "openai": {
      "rateLimit": {
        "windowMs": 60000,
        "max": 100
      }
    }
  }
}
```

Rate limits are enforced per IP address. Exceeding the limit returns `429 Too Many Requests` with a `Retry-After` header.

---

## Response Caching

Enable response caching to avoid redundant calls to backends:

```json
{
  "cache": {
    "enabled": true,
    "ttl": 120
  }
}
```

- `ttl` is in seconds (default: 60)
- Cache is keyed on `backend:model:messages:maxTokens`
- Streaming responses are never cached
- Cache is automatically cleaned up on TTL expiry

---

## Timeouts

Each backend has a configurable request timeout (default: 300000ms / 5 min):

```json
{
  "backends": {
    "opencode": {
      "timeout": 600000
    }
  }
}
```

---

## Network Proxy

Route backend traffic through an HTTP/HTTPS proxy:

```json
{
  "backends": {
    "openai": {
      "proxy": "http://proxy.example.com:8080"
    }
  }
}
```

Requires `undici` to be installed (`npm install undici`). If `undici` is not available, the proxy setting is silently ignored.

---

## Model Aliases

Map friendly model names to backends:

```json
{
  "aliases": {
    "pickle": "opencode/big-pickle",
    "fast": "kilocode/stepfun/step-3.7-flash:free",
    "qwen": "openai/Qwen3.6-35B-A3B-UD-Q3_K_S.gguf"
  }
}
```

Then request `model: "pickle"` and unibridge routes to `opencode/big-pickle`.

---

## Config Hot-Reload

Edit `unibridge.json` while the proxy is running — changes are picked up automatically (rate limits, cache settings, new backends, etc.). No restart needed. Uses `fs.watch` with a 500ms debounce.

---

## Verbose Logging

Enable verbose logging to see truncated request/response bodies in the log file:

```bash
UNIBRIDGE_VERBOSE=true unibridge
```

Or in config:

```json
{
  "verbose": true
}
```

---

## Backend Interface

Each `src/backends/<name>.ts` exports a standard adapter implementing the `BackendModule` interface:

```ts
export const name = 'my-backend';

export async function init(backendConfig: BackendConfig): Promise<BaseBackendContext> {
  // Called once at startup. Returns context for complete().
  return { baseUrl, models, dispatcher, timeout };
}

export function listModels(backendConfig: BackendConfig, ctx: BaseBackendContext): ModelInfo[] {
  return [{ id: 'my-backend/model-name', object: 'model' }];
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  // request: { messages, model, maxTokens, temperature, response_format, ... }
  // Must return OpenAI-compatible response shape.
  return { id, object: 'chat.completion', created, model, choices, usage };
}

// Optional:
export async function embed(backendConfig, request, ctx): Promise<EmbeddingResponse> { ... }
export async function responses(backendConfig, request, ctx): Promise<ResponseObject> { ... }
export async function* completeStreaming(backendConfig, request, ctx): AsyncGenerator<ChatCompletionChunk> { ... }
export async function* responsesStreaming(backendConfig, request, ctx): AsyncGenerator<Record<string, unknown>> { ... }
```

To add a backend:
1. Create `src/backends/<name>.ts`
2. Import and register in `src/server.ts`: `registry.register(yourBackend)`
3. Add config to your `unibridge.json`

### Built-in backends

| Backend | Adapter | Streaming | Embeddings | Auth |
|---|---|---|---|---|
| `opencode` | `src/backends/opencode.ts` | Native (`/event` SSE + `/prompt_async`) | — | HTTP Basic Auth |
| `kilocode` | `src/backends/kilocode.ts` | Via SSE parser | — | X-Api-Key (optional for free models) |
| `mimocode` | `src/backends/mimocode.ts` | — | — | HTTP Basic Auth |
| `openai` | `src/backends/openai.ts` | Via OpenAI SDK (retries, timeout, SSE) | Yes | Bearer token |

**opencode** — connects to a local opencode server. Requires `serverPassword` (mirrors `OPENCODE_SERVER_PASSWORD` env var on the server side). Creates a new opencode session per request. Native structured output: `response_format` is forwarded to the upstream and the reply is validated locally against your schema (one retry with feedback on mismatch). Streaming is optional; enable with `"streaming": true` in backend config or `UNIBRIDGE_STREAMING=true`. Also supports native Responses API via `responses()` export.

**kilocode** — connects directly to Kilo Gateway (`https://api.kilo.ai/api/gateway`). Model format: `kilocode/<provider>/<model>`. Free models (`:free` suffix) work without an API key. Set `apiKey` in config or `KILO_API_KEY` env var for paid models.

**mimocode** — connects to MiMoCode's headless server (`mimo serve`). Uses the same session/message protocol as opencode (via shared `session-protocol.ts`). Default baseUrl: `http://127.0.0.1:4096`. Shows only `mimo-auto` (free channel) by default; set `freeOnly: false` to expose all configured models.

**openai** — generic backend for any OpenAI-compatible endpoint. Default baseUrl: `http://localhost:11434/v1`. Works with Ollama, LiteLLM, vLLM, text-generation-webui, LocalAI, and more. Supports embeddings.

---

## Architecture

```
src/
├── cli.ts                    # CLI entry point (arg parsing, --json mode)
├── proxy.ts                  # Re-exports start() from server.ts
├── server.ts                 # Server lifecycle, backend registration, cache, config watcher
├── router.ts                 # URL routing to handlers, CORS, auth, rate limiting
├── config.ts                 # Config file loader, hot-reload, model routing
├── types.ts                  # All TypeScript type definitions
├── cache.ts                  # TTL-based response cache
├── sse.ts                    # SSE streaming helpers
├── utils.ts                  # Shared utilities (logging, body parsing, rate limiter mgmt)
├── metrics.ts                # Prometheus-compatible metrics
├── rate-limiter.ts           # Per-IP sliding-window rate limiter
├── fetch-proxy.ts            # HTTP proxy agent (undici)
├── handlers/
│   ├── chat-completions.ts   # /v1/chat/completions handler
│   ├── completions.ts        # /v1/completions handler
│   ├── responses.ts          # /v1/responses handler
│   └── embeddings.ts         # /v1/embeddings handler
└── backends/
    ├── index.ts              # Re-exports all backend modules
    ├── registry.ts           # Backend registration, init, and lookup
    ├── shared/
    │   ├── session-protocol.ts  # Shared opencode/mimocode session logic
    │   └── sse-parser.ts        # Typed SSE parser (SDK ChatCompletionChunk)
    ├── opencode.ts           # opencode protocol adapter
    ├── kilocode.ts           # Kilo Gateway API adapter
    ├── mimocode.ts           # MiMoCode (mimo serve) adapter
    └── openai.ts             # Generic OpenAI-compatible backend
```

```
any OpenAI client ──HTTP──> unibridge (:5200) ──adapter──> your backend
(graphify, curl, SDK)       │                         (any protocol)
                            ├── opencode — local opencode server
                            ├── kilocode — Kilo Gateway API (free models)
                            ├── mimocode — mimo serve
                            ├── openai — Ollama, LiteLLM, vLLM, ...
                            └── custom — your adapter
```

---

## Docker

### Run

```bash
docker run -p 5200:5200 \
  -v $(pwd)/unibridge.json:/app/unibridge.json \
  ghcr.io/vitkuz573/unibridge
```

### Build

```bash
docker build -t unibridge .
docker run -p 5200:5200 -v $(pwd)/unibridge.json:/app/unibridge.json unibridge
```

### Docker Compose

```bash
docker compose up -d
```

```yaml
# docker-compose.yml
services:
  unibridge:
    build: .
    network_mode: host
    volumes:
      - ./unibridge.json:/app/unibridge.json:ro
    restart: unless-stopped
    environment:
      - UNIBRIDGE_PORT=5200
      - UNIBRIDGE_HOST=0.0.0.0
```

---

## Development

```bash
git clone https://github.com/vitkuz573/unibridge.git
cd unibridge
npm install
cp unibridge.example.json unibridge.json
npm run dev
```

### Test

```bash
npm test
# or: node --test scripts/test.mjs
```

### CLI Reference

```
unibridge — Universal OpenAI-compatible proxy for any LLM backend

Usage:
  unibridge                          Start proxy (reads unibridge.json from CWD)
  unibridge --port 5200              Override port
  unibridge --config ./cfg.json      Explicit config path
  unibridge --log ./unibridge.log    Log file path
  unibridge --host 0.0.0.0           Bind to all interfaces
  unibridge --streaming              Enable streaming for opencode/mimocode
  unibridge --json                   Print startup state as JSON and exit
  unibridge --help                   Show help

Options:
  -p, --port <port>      Listen port (default: 5200)
  -c, --config <path>    Config file path (default: unibridge.json in CWD / ~/)
  -H, --host <addr>      Bind address (default: 127.0.0.1)
  -l, --log <path>       Log file (default: /tmp/unibridge.log)
  -s, --streaming        Enable streaming for opencode/mimocode backends
  -j, --json             Print startup state as JSON and exit
  -h, --help             Show help

Environment variables:
  UNIBRIDGE_PORT             Listen port
  UNIBRIDGE_CONFIG           Explicit config path
  UNIBRIDGE_LOG              Log file
  UNIBRIDGE_HOST             Bind host (default: 127.0.0.1)
  UNIBRIDGE_DEFAULT_BACKEND  Fallback backend name
  UNIBRIDGE_STREAMING        Enable streaming (true/false)
  UNIBRIDGE_VERBOSE          Verbose logging (true/false)
```

CLI flags override config file values. Env vars override both.

### Build from source

```bash
npm run build
node dist/cli.js
```

### Adding a backend

```bash
cp src/backends/opencode.ts src/backends/my-backend.ts
```

Your module must export:

| Export | Required | Signature |
|---|---|---|
| `name` | yes | `string` — unique backend identifier |
| `init` | no | `async (backendConfig) => BaseBackendContext` — called once at startup |
| `listModels` | no | `(backendConfig, ctx) => ModelInfo[]` — return model list |
| `complete` | yes | `async (backendConfig, request, ctx) => ChatCompletionResponse` — handle completion |
| `embed` | no | `async (backendConfig, request, ctx) => EmbeddingResponse` — handle embeddings |
| `responses` | no | `async (backendConfig, request, ctx) => ResponseObject` — native Responses API |
| `completeStreaming` | no | `async function*(...)` — streaming chat completions |
| `responsesStreaming` | no | `async function*(...)` — streaming Responses API |

The `complete` function receives a `ChatRequest`:

```ts
{
  messages: Message[],        // chat messages (for /chat/completions)
  model: string,              // resolved model name
  maxTokens?: number,         // from client or config
  temperature?: number,       // optional
  response_format?: { type }, // optional
  tools?: ToolDefinition[],   // optional
  tool_choice?: string | object, // optional
}
```

Then register it in `src/server.ts` and add config to `unibridge.json`.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
