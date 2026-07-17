import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';
import {
  HttpError,
  ChatRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  EmbedRequest,
  EmbeddingResponse,
  BaseBackendContext,
  ResponsesRequest,
  ResponseObject,
  ResponsesReasoningOutput,
  ResponsesMessageOutput,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import type { ModelInfo } from './registry.js';
import {
  basicAuthHeader,
  buildPartsFromMessages,
  injectSystemIntoParts,
  injectForceJson,
  parseUsage,
  parseResponseParts,
} from './shared/session-protocol.js';
import { uid } from '../utils.js';

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
  dispatcher: object | undefined,
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
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts = buildPartsFromMessages(messages);
  injectSystemIntoParts(parts, system);
  if (forceJson) injectForceJson(parts);

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

  let { content, rawReasoning } = parseResponseParts(data);

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  const usage = parseUsage(data);

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

// ---------------------------------------------------------------------------
// Responses API support
// ---------------------------------------------------------------------------

interface ResponsesInputItem {
  type?: string;
  role?: string;
  text?: string;
  content?: unknown;
  image_url?: { url: string };
}

function buildPartsFromResponsesInput(input: unknown): { parts: { type: string; text?: string; mime?: string; url?: string }[]; system: string } {
  const parts: { type: string; text?: string; mime?: string; url?: string }[] = [];
  let system = '';

  if (typeof input === 'string') {
    parts.push({ type: 'text', text: input });
    return { parts, system };
  }

  if (!Array.isArray(input)) {
    parts.push({ type: 'text', text: '' });
    return { parts, system };
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as ResponsesInputItem;

    if (obj.type === 'message' || obj.type === 'easy_input_message') {
      const role = obj.role || 'user';
      if (role === 'system' || role === 'developer') {
        let text = '';
        if (typeof obj.content === 'string') {
          text = obj.content;
        } else if (Array.isArray(obj.content)) {
          text = obj.content.map((c: unknown) => {
            if (typeof c === 'string') return c;
            if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text ?? '');
            return '';
          }).join('\n');
        }
        if (text) system += (system ? '\n' : '') + text;
        continue;
      }
      let text = '';
      if (typeof obj.content === 'string') {
        text = obj.content;
      } else if (Array.isArray(obj.content)) {
        text = obj.content.map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (!c || typeof c !== 'object') return '';
          const cc = c as Record<string, unknown>;
          if (cc['type'] === 'input_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'output_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'text') return String(cc['text'] ?? '');
          return '';
        }).join('\n');
      }
      parts.push({ type: 'text', text });
    } else if (obj.type === 'input_text') {
      parts.push({ type: 'text', text: String(obj.text ?? '') });
    } else if (obj.type === 'input_image') {
      const url = obj.image_url?.url ?? '';
      parts.push({ type: 'file', mime: 'image/jpeg', url });
    }
  }

  if (!parts.length) parts.push({ type: 'text', text: '' });
  return { parts, system };
}

export async function responses(
  backendConfig: OpencodeBackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
): Promise<ResponseObject> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  const { model, max_output_tokens, temperature } = request;
  const { baseUrl, auth, timeout } = oc;
  const forceJson = backendConfig.forceJson || false;
  const minTokens = backendConfig.minTokens || 0;

  const { parts, system } = buildPartsFromResponsesInput(request.input);

  if (system) {
    const firstText = parts.find(p => p.type === 'text');
    if (firstText) {
      firstText.text = `[System instructions: ${system}]\n\n${firstText.text}`;
    } else {
      parts.unshift({ type: 'text', text: `[System instructions: ${system}]` });
    }
  }

  if (forceJson) injectForceJson(parts);

  interface MsgBody {
    model: { providerID: string; modelID: string };
    parts: { type: string; text?: string; mime?: string; url?: string }[];
    maxTokens?: number;
    response_format?: { type?: string };
    temperature?: number;
  }

  const msgBody: MsgBody = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };

  if (max_output_tokens || minTokens) {
    msgBody.maxTokens = Math.max(max_output_tokens || 0, minTokens);
  }

  if (temperature != null) msgBody.temperature = temperature;

  if (forceJson) {
    msgBody.response_format = { type: 'json_object' };
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

  let { content, rawReasoning } = parseResponseParts(data);

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  const usage = parseUsage(data);

  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput> = [];
  if (rawReasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: rawReasoning }],
    });
  }
  output.push({
    id: uid('msg'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: content }],
  });

  return {
    id: uid('resp'),
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model,
    output,
    usage,
  };
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
    .map(m => typeof m.content === 'string' ? m.content : '')
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

  const responseBody = eventRes.body;
  if (!responseBody) throw new HttpError('opencode event stream body is null', 500);
  const reader = responseBody.getReader();
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
