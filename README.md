# opencode-graphify-bridge

OpenAI-compatible proxy that bridges [opencode](https://opencode.ai) local LLM models with tools that require OpenAI API — primarily [graphify](https://github.com/anomalco/graphify) for codebase knowledge graph extraction.

## Problem

Tools like graphify expect an OpenAI-compatible `/v1/chat/completions` endpoint with structured JSON output (`response_format`, system-prompt-driven schemas). opencode's native SDK uses a session/message protocol with no OpenAI-compatible endpoint. Reasoning models (`big-pickle`, `north-mini-code-free`, etc.) routinely ignore system-prompt JSON instructions — leading to hollow or invalid extractions.

## Solution

A lightweight Node.js proxy that:

1. Presents an OpenAI-compatible `/v1/chat/completions` endpoint
2. Translates requests to opencode's session/message protocol
3. **Injects a JSON-force instruction** into the last user message — reasoning models respect user messages far more reliably than system prompts
4. Strips markdown fences from responses
5. Respects `model` from the OpenAI request (parses `providerID/modelID` format)
6. Forwards `response_format` to the SDK for models that support it

## Architecture

```
graphify/claude/etc ──HTTP──> opencode-proxy (:5200) ──SDK──> opencode server (:5100) ──API──> model provider
```

- **Proxy**: `src/proxy.mjs` — stateless Node.js HTTP server
- **Target**: any opencode-local model (`big-pickle`, `north-mini-code-free`, etc.)
- **Protocol**: OpenAI `/v1/chat/completions` → opencode session/message bridge

## Quick Start

### Prerequisites

- Node.js ≥ 20 (for `AbortSignal.timeout`)
- opencode server running (`opencode serve --port 5100`)
- opencode SDK installed (comes with opencode CLI)

### 1. Clone & install

```bash
git clone <repo-url> ~/projects/opencode-graphify-bridge
cd ~/projects/opencode-graphify-bridge
npm install
```

Or without npm — the proxy has zero dependencies beyond the opencode SDK:

```bash
git clone <repo-url> ~/projects/opencode-graphify-bridge
```

### 2. Start the proxy

```bash
chmod +x scripts/start.sh
./scripts/start.sh
```

Or directly:

```bash
node src/proxy.mjs
```

Default: listens on `127.0.0.1:5200`.

### 3. Verify connectivity

```bash
./scripts/test.sh
# → big-pickle: OK (2.3s)
# → north-mini-code-free: OK (1.8s)
# → etc.
```

### 4. Use with graphify

```bash
OPENAI_API_KEY="ignored" \
OPENAI_BASE_URL="http://127.0.0.1:5200/v1" \
graphify extract . --backend openai --model big-pickle --max-concurrency 1 --api-timeout 600
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PROXY_PORT` | `5200` | Proxy listen port |
| `SDK_URL` | `http://127.0.0.1:5100` | opencode server URL |
| `PROXY_MODEL` | auto | Default model (overridden by request) |
| `PROXY_PROVIDER` | `opencode` | Provider namespace |

Copy `.env.example` to `.env` or set environment variables directly.

## How It Works: The JSON-Force Injection

The proxy's key innovation is appending a hard constraint to the **last user message** (not the system prompt):

```
IMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.
```

**Why this works**: opencode's reasoning models (`big-pickle`, `north-mini-code-free`, `deepseek-v4-flash-free`) heavily weight user messages during chain-of-thought reasoning. System prompts are treated as background context and routinely ignored for output formatting. Appending the constraint to the user message forces the reasoning path to produce parseable JSON.

Without this injection, graphify extractions produce natural-language analysis like `"Based on my analysis of the RemoteMaster repository..."` instead of structured `{"nodes": [...], "edges": [...]}`.

## Available Models

All opencode-local models are exposed through the proxy:

| Model ID | Type | Speed | JSON Reliability |
|---|---|---|---|
| `big-pickle` | Reasoning | Fastest (~2-3s) | High (with injection) |
| `north-mini-code-free` | Code | Fast (~2-3s) | High (with injection) |
| `deepseek-v4-flash-free` | Reasoning | Fast (~2-3s) | High (with injection) |
| `nemotron-3-ultra-free` | General | Medium (~7s) | High (with injection) |
| `mimo-v2.5-free` | General | Medium (~6s) | High (with injection) |

## Troubleshooting

### Proxy dies immediately after start

Ensure port 5200 is free:
```bash
fuser -k 5200/tcp 2>/dev/null
```

### "Connection error" from Python openai client

The proxy process was killed. Start it with `setsid` or `nohup`:
```bash
setsid -f node src/proxy.mjs </dev/null &>/tmp/proxy.log
```

### Empty or hollow responses

The SDK's `format: { type: "json_schema", ... }` parameter causes empty output with reasoning models. The proxy does NOT use this parameter — it relies on the JSON-force injection instead.

### Model not found

Ensure the model name matches the format `providerID/modelID`, e.g., `opencode/big-pickle`.

## Limitations

- `response_format: { type: "json_object" }` is forwarded to the SDK but opencode's server ignores it
- The SDK's native `format` parameter (`json_schema`) is NOT used — it causes empty responses with reasoning models
- No authentication/authorization (add a reverse proxy for production)
- No streaming support (graphify uses non-streaming)

## Integration with GSD (Guided Software Development)

This proxy is a core component of the GSD workflow. The `AGENTS.md` file in this repo documents how opencode agents should interact with and maintain the proxy. See `AGENTS.md` for details.

## License

MIT
