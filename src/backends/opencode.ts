import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';
import {
  HttpError,
  ChatRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Usage,
  EmbedRequest,
  EmbeddingResponse,
  BaseBackendContext,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import type { ModelInfo } from './registry.js';

export const name = 'opencode' as const;

// ---------------------------------------------------------------------------
// Backend-specific types
// ---------------------------------------------------------------------------

export interface OpencodeContext extends BaseBackendContext {
  auth: Record<string, string>;
  serverPassword: string;
  serverUsername: string;
}

export interface OpencodeBackendConfig extends BackendConfig {
  baseUrl?: string;
  serverPassword?: string;
  serverUsername?: string;
  proxy?: string;
  forceJson?: boolean;
  minTokens?: number;
  timeout?: number;
  streaming?: boolean;
  models?: string[];
}

// ---------------------------------------------------------------------------
// opencode API response types
// ---------------------------------------------------------------------------

interface SessionResponse {
  id: string;
}

interface ResponsePart {
  type: string;
  text?: string;
  tool_use?: {
    tool: string;
    input: unknown;
  };
  tool_result?: {
    content: unknown;
  };
}

interface MessageResponse {
  parts: ResponsePart[];
  info?: {
    tokens?: {
      input: number;
      output: number;
    };
  };
}

interface ProviderConfig {
  id: string;
  models: Record<string, unknown>;
}

interface ProvidersResponse {
  providers?: ProviderConfig[];
}

interface OpencodeEventEnvelope {
  payload?: OpencodeEvent;
}

interface OpencodeEvent {
  type: string;
  properties?: {
    sessionID?: string;
    delta?: string;
    role?: string;
    info?: { role?: string };
    parts?: unknown[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function retryFetch(
  url: string,
  opts: RequestInit,
  dispatcher: unknown,
  maxRetries = 2,
  delayMs = 1000,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await proxyFetch(url, opts, dispatcher);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new HttpError(`HTTP ${res.status}`, res.status);
    } catch (err: unknown) {
      lastErr = err;
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr;
}

function basicAuthHeader(username: string, password: string): Record<string, string> {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

function getMessageContentString(content: string | { type: string; text?: string; image_url?: { url: string } }[]): string {
  if (typeof content === 'string') return content;
  return '';
}

// ---------------------------------------------------------------------------
// Exported backend interface
// ---------------------------------------------------------------------------

export async function init(backendConfig: OpencodeBackendConfig): Promise<OpencodeContext> {
  const baseUrl = backendConfig.baseUrl || 'http://127.0.0.1:5100';
  const serverPassword = backendConfig.serverPassword || '';
  const serverUsername = backendConfig.serverUsername || 'opencode';
  const auth = basicAuthHeader(serverUsername, serverPassword);
  const timeout = backendConfig.timeout || 300_000;

  const dispatcher = await createProxyAgent(backendConfig.proxy);

  let models: string[];
  if (backendConfig.models) {
    models = backendConfig.models;
  } else {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...auth };
    const res = await proxyFetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(5000) }, dispatcher);
    const data: ProvidersResponse = await res.json();
    const op = (data.providers || []).find((p: ProviderConfig) => p.id === 'opencode');
    models = op ? Object.keys(op.models) : [];
  }

  return { baseUrl, auth, models, serverPassword, serverUsername, dispatcher, timeout };
}

export function listModels(_backendConfig: OpencodeBackendConfig, ctx: BaseBackendContext | null): ModelInfo[] {
  if (!ctx) return [];
  const models = ctx.models || [];
  return models.map(id => ({
    id: `opencode/${id}`,
    object: 'model',
  }));
}

export async function complete(
  backendConfig: OpencodeBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  const { messages, model, maxTokens, response_format } = request;
  const { baseUrl, auth, timeout } = oc;
  const forceJson = backendConfig.forceJson || false;
  const minTokens = backendConfig.minTokens || 0;

  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => getMessageContentString(m.content))
    .join('\n');

  const parts: { type: string; text?: string; mime?: string; url?: string }[] = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url.url });
        }
      }
    }
  }

  if (system && parts.length > 0) {
    const firstText = parts.find(p => p.type === 'text');
    if (firstText) {
      firstText.text = `[System instructions: ${system}]\n\n${firstText.text}`;
    } else {
      parts.unshift({ type: 'text', text: `[System instructions: ${system}]` });
    }
  }

  if (forceJson && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }

  interface MsgBody {
    model: { providerID: string; modelID: string };
    parts: { type: string; text?: string; mime?: string; url?: string }[];
    maxTokens?: number;
    response_format?: { type?: string };
  }

  const msgBody: MsgBody = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };

  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }

  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  let sessionRes: Response;
  try {
    sessionRes = await retryFetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        permission: [{ permission: '*', pattern: '**', action: 'allow' }],
      }),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, oc.dispatcher);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status || 503;
    throw new HttpError(`opencode session failed for model ${model}: ${msg}`, status);
  }

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    throw new HttpError(`opencode session ${sessionRes.status} for model ${model}: ${errText.substring(0, 500)}`, sessionRes.status);
  }

  const session: SessionResponse = await sessionRes.json();

  let msgRes: Response;
  try {
    msgRes = await retryFetch(`${baseUrl}/session/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(msgBody),
      signal: AbortSignal.timeout(timeout),
    }, oc.dispatcher);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status || 503;
    throw new HttpError(`opencode message failed for model ${model}: ${msg}`, status);
  }

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    throw new HttpError(`opencode ${msgRes.status} for model ${model}: ${errText.substring(0, 500)}`, msgRes.status);
  }

  const data: MessageResponse = await msgRes.json();

  let content = '';
  let rawReasoning = '';
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) {
      content += p.text;
    } else if (p.type === 'reasoning' && p.text) {
      if (rawReasoning) rawReasoning += '\n';
      rawReasoning += p.text;
    } else if (p.type === 'tool_use') {
      const tu = p.tool_use || { tool: '', input: '' };
      const input = typeof tu.input === 'object' ? JSON.stringify(tu.input) : String(tu.input || '');
      content += `\n[called tool: ${tu.tool}(${input})]\n`;
    } else if (p.type === 'tool_result') {
      const tr = p.tool_result || { content: '' };
      const result = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
      content += `${result}\n`;
    }
  }

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }

  const message: { role: 'assistant'; content: string; reasoning?: string } = { role: 'assistant', content };
  if (rawReasoning) message.reasoning = rawReasoning;

  return {
    id: `chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{
      index: 0,
      message,
      finish_reason: 'stop',
    }],
    usage,
  };
}

export async function embed(
  _backendConfig: OpencodeBackendConfig,
  _request: EmbedRequest,
  _ctx: BaseBackendContext | null,
): Promise<EmbeddingResponse> {
  throw new HttpError('Embeddings not supported by opencode backend', 501);
}

function buildPartsFromMessages(
  messages: ChatRequest['messages'],
): { type: string; text?: string; mime?: string; url?: string }[] {
  const parts: { type: string; text?: string; mime?: string; url?: string }[] = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url.url });
        }
      }
    }
  }
  return parts;
}

function injectSystemIntoParts(
  parts: { type: string; text?: string; mime?: string; url?: string }[],
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

function injectForceJson(
  parts: { type: string; text?: string; mime?: string; url?: string }[],
): void {
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last && last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }
}

function extractStatusFromUnknown(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return 503;
}

export async function* completeStreaming(
  backendConfig: OpencodeBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  if (!backendConfig.streaming) return;

  const { messages, model, maxTokens, response_format, temperature } = request;
  const { baseUrl, auth, timeout, dispatcher } = oc;

  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => getMessageContentString(m.content))
    .join('\n');

  const parts = buildPartsFromMessages(messages);
  injectSystemIntoParts(parts, system);
  if (backendConfig.forceJson) injectForceJson(parts);

  interface StreamingMsgBody {
    model: { providerID: string; modelID: string };
    parts: { type: string; text?: string; mime?: string; url?: string }[];
    maxTokens?: number;
    response_format?: { type?: string };
    temperature?: number;
  }

  const msgBody: StreamingMsgBody = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };
  if (maxTokens || backendConfig.minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, backendConfig.minTokens || 0);
  }
  if (response_format?.type) msgBody.response_format = response_format;
  if (temperature != null) msgBody.temperature = temperature;

  let sessionRes: Response;
  try {
    sessionRes = await retryFetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        permission: [{ permission: '*', pattern: '**', action: 'allow' }],
      }),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, dispatcher);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(`opencode session failed for model ${model}: ${msg}`, extractStatusFromUnknown(err));
  }

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    throw new HttpError(`opencode session ${sessionRes.status} for model ${model}: ${errText.substring(0, 500)}`, sessionRes.status);
  }

  const session: SessionResponse = await sessionRes.json();

  let promptRes: Response;
  try {
    promptRes = await retryFetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(msgBody),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, dispatcher);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(`opencode prompt_async failed for model ${model}: ${msg}`, extractStatusFromUnknown(err));
  }

  if (!promptRes.ok && promptRes.status !== 204) {
    const errText = await promptRes.text();
    throw new HttpError(`opencode prompt_async ${promptRes.status} for model ${model}: ${errText.substring(0, 500)}`, promptRes.status);
  }

  let eventRes: Response;
  try {
    eventRes = await retryFetch(`${baseUrl}/event`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...auth },
      signal: AbortSignal.timeout(timeout),
    }, dispatcher);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(`opencode event stream failed for model ${model}: ${msg}`, extractStatusFromUnknown(err));
  }

  if (!eventRes.ok) {
    const errText = await eventRes.text();
    throw new HttpError(`opencode event stream ${eventRes.status} for model ${model}: ${errText.substring(0, 500)}`, eventRes.status);
  }

  const reader = eventRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let roleEmitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const raw = trimmed.slice(5).trim();
        if (!raw) continue;

        let envelope: OpencodeEventEnvelope;
        try {
          envelope = JSON.parse(raw) as OpencodeEventEnvelope;
        } catch {
          continue;
        }

        const candidate = envelope?.payload || envelope;
        if (!candidate || !('type' in candidate) || typeof candidate.type !== 'string') continue;
        const event = candidate as OpencodeEvent;
        if (event.properties?.sessionID && event.properties.sessionID !== session.id) continue;

        if (event.type === 'message.part.delta') {
          const delta = event.properties?.delta;
          if (delta) {
            yield {
              id: `chatcmpl-${session.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: roleEmitted ? { content: delta } : { role: 'assistant', content: delta },
                finish_reason: null,
              }],
            };
            roleEmitted = true;
          }
        } else if (event.type === 'message.updated') {
          const info = event.properties?.info;
          const partsList = event.properties?.parts;
          if (info?.role === 'assistant' && Array.isArray(partsList)) {
            yield {
              id: `chatcmpl-${session.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
            };
            return;
          }
        } else if (event.type === 'server.instance.disposed') {
          return;
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}
