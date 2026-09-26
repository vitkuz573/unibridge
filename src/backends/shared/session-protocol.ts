import type { ChatRequest, Usage, ResponsesUsage } from '../../types.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SessionResponse {
  id: string;
}

export interface Part {
  type: string;
  text?: string;
  mime?: string;
  url?: string;
  callID?: string;
  tool_use?: { tool?: string; input?: unknown };
  tool_result?: { content?: unknown };
}

// Local serve tools (bash/read/write/edit/...) must never be available to the
// model: every session-based backend creates sessions with this deny-all
// permission preset, and no tool overrides are ever sent to serve.
export const DENY_ALL_PERMISSION = [{ permission: '*', pattern: '**', action: 'deny' }];

// ---------------------------------------------------------------------------
// Shared helpers for the mimocode session-based backend (the opencode backend
// speaks the v2 /api/... protocol and keeps its own wire helpers).
// ---------------------------------------------------------------------------

export function basicAuthHeader(username: string, password: string): Record<string, string> {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

// The session protocol accepts only text/file/agent/subtask message parts, so tool
// history cannot travel as native tool_use/tool_result blocks. It travels as
// the same structured JSON the clientTools contract asks the model to emit:
// {"type":"function_call","id":...,"name":...,"arguments":{...}} for the
// assistant call and {"type":"tool_result","callID":...,"content":...} for the
// result. No prose placeholders.
export function toolCallPart(callID: string, name: string, args: unknown): Part {
  return {
    type: 'text',
    text: JSON.stringify({ type: 'function_call', id: callID, name, arguments: args }),
  };
}

export function toolResultPart(callID: string, content: string): Part {
  return {
    type: 'text',
    text: JSON.stringify({ type: 'tool_result', callID, content }),
  };
}

export function buildPartsFromMessages(
  messages: ChatRequest['messages'],
): Part[] {
  const parts: Part[] = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const toolCallId = (m as { tool_call_id?: string }).tool_call_id || '';
      const content = typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('') : '';
      parts.push(toolResultPart(toolCallId, content));
      continue;
    }

    if (m.role === 'assistant') {
      const toolCalls = (m as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          let input: unknown = tc.function.arguments;
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            // Keep the raw argument string when the provider sent non-JSON.
          }
          parts.push(toolCallPart(tc.id, tc.function.name, input));
        }
        continue;
      }
    }

    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') {
          parts.push({ type: 'text', text: p.text });
        } else if (p.type === 'image_url') {
          const url = p.image_url?.url ?? '';
          parts.push({ type: 'file', mime: 'image/jpeg', url });
        }
      }
    }
  }
  return parts;
}

export function injectSystemIntoParts(
  parts: Part[],
  system: string,
): void {
  if (system && parts.length > 0) {
    const firstText = parts.find(p => p.type === 'text');
    if (firstText) {
      firstText.text = `[System instructions: ${system}]\n\n${firstText.text}`;
    } else {
      parts.unshift({ type: 'text', text: `[System instructions: ${system}]` });
    }
  }
}

export function extractSessionData(response: unknown): SessionResponse {
  return response as SessionResponse;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

// Canonical Chat Completions usage from a session token bucket. The session
// reports `input` excluding prompt cache, so the OpenAI prompt_tokens — where
// cached tokens are a subset — is input + cache.read + cache.write.
export function usageFromTokens(tokens: TokenUsage | undefined): Usage | undefined {
  if (!tokens) return undefined;
  const cacheRead = tokens.cache?.read || 0;
  const cacheWrite = tokens.cache?.write || 0;
  const prompt = (tokens.input || 0) + cacheRead + cacheWrite;
  const completion = tokens.output || 0;
  const reasoning = tokens.reasoning || 0;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (cacheRead > 0) usage.prompt_tokens_details = { cached_tokens: cacheRead };
  if (reasoning > 0) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

export function parseUsage(data: ResponseData): Usage {
  return usageFromTokens(data.info?.tokens) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function parseResponsesUsage(data: ResponseData): ResponsesUsage {
  const input = data.info?.tokens?.input || 0;
  const output = data.info?.tokens?.output || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

interface ResponseData {
  parts?: Array<{
    type: string;
    text?: string;
    tool_use?: { tool?: string; input?: unknown };
    tool_result?: { content?: unknown };
  }>;
  info?: { tokens?: TokenUsage };
}

export interface ParsedResponse {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  toolResults: Array<{ toolCallId: string; content: string }>;
}

export function parseResponseParts(
  data: ResponseData,
): ParsedResponse {
  let text = '';
  let reasoning = '';
  const toolCalls: ParsedResponse['toolCalls'] = [];
  const toolResults: ParsedResponse['toolResults'] = [];
  let toolCallIndex = 0;
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) {
      text += p.text;
    } else if (p.type === 'reasoning' && p.text) {
      if (reasoning) reasoning += '\n';
      reasoning += p.text;
    } else if (p.type === 'tool_use' || p.type === 'tool') {
      const tu = p.tool_use || {};
      const state = (p as Record<string, unknown>)['state'] as Record<string, unknown> | undefined;
      const inputObj = tu.input ?? state?.['input'];
      const input = typeof inputObj === 'object' ? JSON.stringify(inputObj) : (String(inputObj || ''));
      const toolName = tu.tool || ((p as Record<string, unknown>)['tool'] as string) || '';
      toolCalls.push({
        id: `toolu_${toolCallIndex++}`,
        type: 'function',
        function: { name: toolName, arguments: input },
      });
    } else if (p.type === 'tool_result') {
      const tr = p.tool_result || {};
      const result = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
      const lastTc = toolCalls[toolCalls.length - 1];
      const toolCallId = lastTc ? lastTc.id : `toolu_${toolCallIndex}`;
      toolResults.push({ toolCallId, content: result });
    }
  }
  return { text, reasoning, toolCalls, toolResults };
}
