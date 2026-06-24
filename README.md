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
- [Backend Interface](#backend-interface)
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
  "defaultBackend": null,
  "logFile": "/tmp/unibridge.log",
  "backends": {
    "my-backend": {
      "baseUrl": "http://localhost:9000"
    }
  },
  "aliases": {
    "some-model": "my-backend"
  }
}
```

| Setting | Description |
|---|---|
| `port` | Listen port |
| `defaultBackend` | Fallback backend name |
| `logFile` | Log file path |
| `backends.<name>` | Per-backend config (shape defined by adapter) |
| `aliases.<model>` | Map model name to backend |

Top-level env overrides:

| Variable | Description | Default |
|---|---|---|
| `UNIBRIDGE_CONFIG` | Explicit config path | auto-detect |
| `UNIBRIDGE_PORT` | Listen port | from config |
| `UNIBRIDGE_DEFAULT_BACKEND` | Fallback backend | from config |
| `UNIBRIDGE_LOG` | Log file path | from config |
| `UNIBRIDGE_HOST` | Bind address | `127.0.0.1` |

---

## Model Routing

| Pattern | Example | Behaviour |
|---|---|---|
| `backend/model` | `my-backend/gpt-4` | Route to explicit backend |
| `model` only | `some-model` | Look up `aliases`, fall back to `defaultBackend` |
| `/v1/models` | — | Lists all models from all configured backends |
| `/v1/chat/completions` | `model`, `messages` | Chat Completions API — standard OpenAI chat |
| `/v1/responses` | `model`, `input` | Responses API — used by Codex CLI, OpenAI Responses SDK |

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
├── proxy.mjs          # HTTP server, request routing
├── config.mjs         # Config file loader, model routing
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
