# unibridge — Universal LLM backend proxy

Accepts OpenAI `/v1/chat/completions` requests and routes them to any configured backend (opencode, OpenAI, Ollama, etc.).

## Architecture

```
any OpenAI client ──HTTP──> unibridge (:5200) ──> backend (opencode / OpenAI / Ollama / ...)
```

- **Pluggable backends**: `src/backends/*.mjs` each exports `{ name, init, listModels, complete }`
- **Model routing**: model name `opencode/big-pickle` → opencode backend; `openai/gpt-4` → OpenAI backend
- **JSON-force injection**: appends JSON constraint to user message for extraction requests (opencode backend)

## Quick Start

```bash
# Start
UNIBRIDGE_PORT=5200 OPENCODE_BASE_URL=http://127.0.0.1:5100 node src/proxy.mjs

# or using config file
cp .env.example .env
./scripts/start.sh

# Test
./scripts/test.sh
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `UNIBRIDGE_PORT` | Listen port | `5200` |
| `UNIBRIDGE_DEFAULT_BACKEND` | Fallback backend name | none |
| `UNIBRIDGE_LOG` | Log file path | `/tmp/unibridge.log` |
| `UNIBRIDGE_ALIAS_<model>` | Map model name → backend | — |
| `OPENCODE_BASE_URL` | opencode server URL | `http://127.0.0.1:5100` |
| `OPENCODE_DEFAULT_MODEL` | opencode default model | `big-pickle` |

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
