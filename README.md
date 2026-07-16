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

```js
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
- **Pluggable adapters** — `src/backends/<name>.mjs` exports `{ name, init, listModels, complete }`. New backend in ~50 lines.
- **Minimal** — single Node.js file, one npm dependency, starts in milliseconds. No Docker, no Python, no 100-provider routing table.
- **Model routing** — `backend/model`, alias map, default fallback.
- **For any OpenAI client** — Codex CLI, graphify, LangChain, LlamaIndex, raw curl, any OpenAI SDK. All speak OpenAI API.

---

<details>
<summary><b>Table of Contents</b></summary>

- [Quick Start](#quick-start)
- [Why this instead of LiteLLM?](#why-this-instead-of-litellm)
- [Configuration](#configuration)
- [Model Routing](#model-routing)
- [API Endpoints](#api-endpoints)
- [API Key Authentication](#api-key-authentication)
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
# Create config, then run
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
node src/cli.mjs --port 5200
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
| Runtime | Python, heavy | Single Node.js file |
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
      "proxy": "",
      "timeout": 300000,
      "rateLimit": {
        "windowMs": 60000,
        "max": 30
      },
      "forceJson": false,
      "minTokens": 0
    },
    "kilocode": {
      "baseUrl": "http://127.0.0.1:5101",
      "apiKey": "",
      "proxy": "",
      "timeout": 300000,
      "rateLimit": {
        "windowMs": 60000,
        "max": 30
      },
      "forceJson": false,
      "minTokens": 0
    },
    "mimocode": {
      "baseUrl": "http://127.0.0.1:4096",
      "serverPassword": "",
      "serverUsername": "mimocode",
      "proxy": "",
      "timeout": 300000,
      "rateLimit": {
        "windowMs": 60000,
        "max": 30
      },
      "forceJson": false,
      "minTokens": 0
    },
    "openai": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "",
      "proxy": "",
      "timeout": 300000,
      "rateLimit": {
        "windowMs": 60000,
        "max": 30
      }
    }
  },
  "aliases": {}
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
| `proxy` | HTTP/HTTPS proxy URL for backend requests | — |
| `timeout` | Request timeout in ms | `300000` (5 min) |
| `rateLimit` | Per-backend rate limit: `{ windowMs, max }` | `{ windowMs: 60000, max: 30 }` |
| `forceJson` | Force JSON mode on backend requests | `false` |
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

---

## Model Routing

| Pattern | Example | Behaviour |
|---|---|---|
| `backend/model` | `my-backend/gpt-4` | Route to explicit backend |
| `model` only | `some-model` | Look up `aliases`, fall back to `defaultBackend` |
| `/v1/models` | — | Lists all models from all configured backends |
| `/v1/chat/completions` | `model`, `messages` | Chat Completions API — standard OpenAI chat |
| `/v1/completions` | `model`, `prompt` | Legacy Completions API (text completion) |
| `/v1/responses` | `model`, `input` | Responses API — used by Codex CLI, OpenAI Responses SDK |
| `/v1/embeddings` | `model`, `input` | Embeddings API — requires backend `embed()` support |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Service info (name, version, docs URL) |
| GET | `/health` | Health check — status, uptime, backends, cache size |
| GET | `/v1/models` | List all models from all configured backends |
| GET | `/metrics` | Prometheus-format metrics (counters, histograms) |
| POST | `/v1/chat/completions` | Chat Completions API |
| POST | `/v1/completions` | Legacy Completions API |
| POST | `/v1/responses` | Responses API |
| POST | `/v1/embeddings` | Embeddings API (requires backend support) |

---

## API Key Authentication

Set `apiKey` in config to require `Authorization: Bearer <key>` on all API requests:

```json
{
  "apiKey": "my-secret-key"
}
```

Endpoints exempt from auth: `/health`, `/`, `/v1` (model list).

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

Edit `unibridge.json` while the proxy is running — changes are picked up automatically (rate limits, cache settings, new backends, etc.). No restart needed.

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

Each `src/backends/<name>.mjs` exports a standard adapter:

```js
export const name = 'my-backend';

export function init(backendConfig) {
  // Called once. Returns context for complete().
  return { client };
}

export function listModels(backendConfig) {
  return [{ id: 'my-backend/model-name', object: 'model' }];
}

export async function complete(backendConfig, request, ctx) {
  // request: { messages, modelId, maxTokens, response_format, temperature }
  // Must return OpenAI-compatible response shape.
  return { id, object, created, model, choices, usage };
}
```

To add a backend:
1. Create `src/backends/<name>.mjs`
2. Register in `src/proxy.mjs`: `registry.register(yourBackend)`
3. Add config to your `unibridge.json`

### Built-in backends

| Backend | Adapter | Auto-discovers models | Authentication |
|---|---|---|---|
| `opencode` | `src/backends/opencode.mjs` | Yes (`/config/providers`) | HTTP Basic Auth |
| `kilocode` | `src/backends/kilocode.mjs` | Yes (Gateway `/models`) | `X-Api-Key` (optional for free models) |
| `mimocode` | `src/backends/mimocode.mjs` | Yes (`/config/providers`) | HTTP Basic Auth |
| `openai` | `src/backends/openai.mjs` | Yes (`/v1/models`) | `Bearer <apiKey>` |

**Generic OpenAI-compatible backend** (`openai`) works with any server exposing the OpenAI API: Ollama, LiteLLM, vLLM, text-generation-webui, LocalAI, and more.

---

## Architecture

```
src/
├── cli.mjs            # CLI entry point (arg parsing)
├── proxy.mjs          # HTTP server, request routing, caching, rate limiting
├── config.mjs         # Config file loader, hot-reload, model routing
├── rate-limiter.mjs   # Sliding-window rate limiter
├── metrics.mjs        # Prometheus-compatible metrics
├── fetch-proxy.mjs    # HTTP proxy agent (undici)
└── backends/
    ├── registry.mjs   # Backend registration & lookup
    ├── opencode.mjs   # opencode protocol adapter
    ├── kilocode.mjs   # Kilo Gateway API adapter
    ├── mimocode.mjs   # MiMoCode (mimo serve) adapter
    └── openai.mjs     # Generic OpenAI-compatible backend
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
    ports:
      - "5200:5200"
    volumes:
      - ./unibridge.json:/app/unibridge.json:ro
    restart: unless-stopped
```

---

## Development

```bash
git clone https://github.com/vitkuz573/unibridge.git
cd unibridge
npm install
cp unibridge.example.json unibridge.json
node src/proxy.mjs
```

### Test

```bash
npm test
# or: node --test scripts/test.mjs
```

### CLI flags

```bash
unibridge --help
unibridge --port 5200 --config ./unibridge.json --log ./unibridge.log --host 0.0.0.0
```

### Build Docker

```bash
docker build -t unibridge .
docker run -p 5200:5200 -v $(pwd)/unibridge.json:/app/unibridge.json unibridge
```

### Adding a backend

```bash
cp src/backends/opencode.mjs src/backends/my-backend.mjs
# edit adapter, register in proxy.mjs, add config to unibridge.json
```

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
