import type { ChatRequest, Usage } from '../../types.js';

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

interface ResponseData {
  parts?: Array<{
    type: string;
    text?: string;
    tool_use?: { tool?: string; input?: unknown };
    tool_result?: { content?: unknown };
  }>;
  info?: { tokens?: { input?: number; output?: number } };
}

export function parseResponseParts(
  data: ResponseData,
): { content: string; rawReasoning: string } {
  let content = '';
  let rawReasoning = '';
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) {
      content += p.text;
    } else if (p.type === 'reasoning' && p.text) {
      if (rawReasoning) rawReasoning += '\n';
      rawReasoning += p.text;
    } else if (p.type === 'tool_use') {
      const tu = p.tool_use || {};
      const input = typeof tu.input === 'object' ? JSON.stringify(tu.input) : (String(tu.input || ''));
      content += `\n[called tool: ${tu.tool}(${input})]\n`;
    } else if (p.type === 'tool_result') {
      const tr = p.tool_result || {};
      const result = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
      content += `${result}\n`;
    }
  }
  return { content, rawReasoning };
}
