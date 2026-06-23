# GSD Prompt Injection: JSON-Force for Reasoning Models

## Problem

Graphify sends a system prompt instructing the model to output valid JSON:

```
Output ONLY valid JSON — no explanation, no markdown fences, no preamble.
```

Reasoning models (`big-pickle`, `north-mini-code-free`, `deepseek-v4-flash-free`) consistently ignore this instruction. They output natural-language analysis instead of structured JSON, causing graphify to reject the chunk as "invalid JSON" or "hollow response".

## Root Cause

System prompts are treated by reasoning models as background context. During chain-of-thought reasoning, the model prioritizes the user message content over system-level formatting instructions. This is by design in reasoning architectures — system instructions about *format* are deprioritized relative to *content* instructions in the user message.

## Solution

The proxy appends a hard constraint to the **last user message text** after graphify has built its prompt:

```
\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.
```

This lands inside the user message — the highest-priority context for reasoning models. The model's chain-of-thought path now includes a terminal JSON constraint that it cannot ignore.

## Injection Point

In `src/proxy.mjs`, after building the `parts` array from messages:

```javascript
if (parts.length > 0) {
  const last = parts[parts.length - 1];
  if (last.type === 'text') {
    last.text += JSON_FORCE_SUFFIX;
  }
}
```

## Effect

| Without injection | With injection |
|---|---|
| `Based on my analysis of the RemoteMaster repository...` | `{"nodes": [...], "edges": [...]}` |
| Graphify: `LLM returned invalid JSON, skipping chunk` | Graphify: `chunk 1/5 done` |
| 0 useful nodes | 29,247 nodes, 53,214 edges |

## Why Not Use SDK's `format` Parameter

The opencode SDK's `format: { type: "json_schema", schema: {...} }` parameter triggers a special API mode. With reasoning models, this mode produces **empty responses** (0 text parts, 0 content length). The underlying model provider likely doesn't support constrained decoding for reasoning architectures.

The `response_format` OpenAI parameter is forwarded to the SDK but the opencode server ignores unknown fields in the message body.

## Maintenance

If a model update changes behavior:
1. Test with and without `JSON_FORCE_SUFFIX`
2. Update `JSON_FORCE_SUFFIX` text if needed (make it more explicit)
3. If the SDK adds `response_format` passthrough, the proxy's forwarding code can be reactivated
