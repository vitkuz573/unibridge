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
}

// ---------------------------------------------------------------------------
// Shared helpers for opencode/mimocode session-based backends
// ---------------------------------------------------------------------------

export function basicAuthHeader(username: string, password: string): Record<string, string> {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
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
        Array.isArray(m.content) ? m.content.map((c: any) => c.text || '').join('') : '';
      parts.push({ type: 'text', text: `[tool result for ${toolCallId}]: ${content}` });
      continue;
    }

    if (m.role === 'assistant') {
      const toolCalls = (m as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          parts.push({ type: 'text', text: `[calling tool ${tc.id}: ${tc.function.name}(${tc.function.arguments})]` });
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

export function injectForceJson(parts: Part[]): void {
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }
}

export function extractSessionData(response: unknown): SessionResponse {
  return response as SessionResponse;
}

export function parseUsage(data: ResponseData): Usage {
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }
  return usage;
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
  info?: { tokens?: { input?: number; output?: number } };
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
    } else if (p.type === 'tool_use') {
      const tu = p.tool_use || {};
      const input = typeof tu.input === 'object' ? JSON.stringify(tu.input) : (String(tu.input || ''));
      toolCalls.push({
        id: `toolu_${toolCallIndex++}`,
        type: 'function',
        function: { name: tu.tool || '', arguments: input },
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
