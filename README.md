# unibridge — Universal LLM backend proxy

Accepts OpenAI `/v1/chat/completions` requests and routes them to any configured backend (opencode, OpenAI, Ollama, etc.).

## Architecture

```
any OpenAI client ──HTTP──> unibridge (:5200) ──> backend (opencode / OpenAI / Ollama / ...)
```

- **Pluggable backends**: `src/backends/*.mjs` each exports `{ name, init, listModels, complete }`
- **Model routing**: model name `opencode/big-pickle` → opencode backend; `openai/gpt-4` → OpenAI backend
- **Config file**: all backend config in `unibridge.json` (copy from `unibridge.example.json`)

## Quick Start

```bash
# Create config
cp unibridge.example.json unibridge.json

# Start
node src/proxy.mjs

# or using script
./scripts/start.sh

# Test
./scripts/test.sh
```

## Configuration

All backend config goes in `unibridge.json`:

```json
{
  "port": 5200,
  "defaultBackend": "opencode",
  "backends": {
    "opencode": {
      "baseUrl": "http://127.0.0.1:5100",
      "defaultModel": "big-pickle"
    }
  },
  "aliases": {
    "big-pickle": "opencode",
    "deepseek-v4-flash-free": "opencode"
  }
}
```

Top-level env overrides (no backend-specific env vars):

| Variable | Description | Default |
|---|---|---|
| `UNIBRIDGE_CONFIG` | Explicit config path | auto-detect |
| `UNIBRIDGE_PORT` | Listen port | `5200` |
| `UNIBRIDGE_DEFAULT_BACKEND` | Fallback backend name | from config |
| `UNIBRIDGE_LOG` | Log file path | `/tmp/unibridge.log` |

## Backend interface

Each backend in `src/backends/<name>.mjs` exports:

```js
export const name = 'opencode';                    // unique backend name
export function init(backendConfig) {}             // called once at startup
export function listModels(backendConfig) { [...] } // model list for /v1/models
export async function complete(backendConfig, request, context) { ... }
```

`request` shape:
```ts
{ messages, modelId, maxTokens, response_format, temperature }
```

Returns OpenAI-compatible response `{ id, object, created, model, choices, usage }`.
