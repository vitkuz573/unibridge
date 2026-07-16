import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';
import { HttpError, type ChatRequest, type ChatCompletionResponse, type ChatCompletionChunk, type BaseBackendContext } from '../types.js';
import type { BackendConfig } from '../config.js';

export const name = 'kilocode' as const;

export interface KilocodeContext extends BaseBackendContext {
  apiKey: string;
}

export interface KilocodeBackendConfig extends BackendConfig {
  baseUrl?: string;
  apiKey?: string;
  proxy?: string;
  timeout?: number;
  models?: string[];
}

interface KilocodeModelResponse {
  data: Array<{ id: string }>;
}

interface KilocodeProvider {
  id: string;
  models: Record<string, unknown>;
}

interface KilocodeProvidersResponse {
  providers: KilocodeProvider[];
}

interface KilocodeRequestBody {
  model: string | undefined;
  messages: ChatRequest['messages'];
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type?: string };
  tools?: unknown[];
  tool_choice?: unknown;
}

export async function init(backendConfig: KilocodeBackendConfig): Promise<KilocodeContext> {
  const baseUrl = backendConfig.baseUrl || 'https://api.kilo.ai/api/gateway';
  const apiKey = backendConfig.apiKey || process.env['KILO_API_KEY'] || '';
  const dispatcher = await createProxyAgent(backendConfig.proxy);
  const timeout = backendConfig.timeout || 300_000;
  let models = backendConfig.models;

  if (!models) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    try {
      const res = await proxyFetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (res.ok) {
        const data: KilocodeModelResponse = await res.json() as KilocodeModelResponse;
        models = (data.data || [])
          .map((m) => m.id)
          .filter((id) => id === 'kilo-auto/free' || id.endsWith(':free'));
      } else {
        throw new HttpError(`status ${res.status}`, res.status);
      }
    } catch (e: unknown) {
      const res = await proxyFetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (!res.ok) throw new HttpError(`kilo gateway models ${res.status}`, res.status);
      const data: KilocodeProvidersResponse = await res.json() as KilocodeProvidersResponse;
      const kp = (data.providers || []).find((p) => p.id === 'kilocode');
      models = kp ? Object.keys(kp.models || {}) : [];
    }
  }

  return { baseUrl, apiKey, models: models || [], dispatcher, timeout };
}

export function listModels(_backendConfig: BackendConfig, ctx: BaseBackendContext | null): Array<{ id: string; object: string }> {
  if (!ctx) return [];
  const models: string[] = ctx.models || [];
  return models.map((id) => ({
    id: `kilocode/${id}`,
    object: 'model',
  }));
}

function buildBody(_backendConfig: BackendConfig, request: ChatRequest): KilocodeRequestBody {
  const { messages, model, maxTokens, minTokens, response_format, tools, tool_choice } = request;

  const body: KilocodeRequestBody = {
    model,
    messages: messages || [],
  };
  if (maxTokens || minTokens) {
    body.max_tokens = Math.max(maxTokens || 0, minTokens || 0);
  }
  if (response_format?.type) {
    body.response_format = response_format;
  }
  if (tools) {
    body.tools = tools as unknown[];
  }
  if (tool_choice) {
    body.tool_choice = tool_choice as unknown;
  }
  return body;
}

function headers(ctx: BaseBackendContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if ('apiKey' in ctx && typeof ctx.apiKey === 'string' && ctx.apiKey) {
    h['X-Api-Key'] = ctx.apiKey;
  }
  return h;
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);

  const res = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(`kilocode ${res.status}: ${errText.substring(0, 500)}`, res.status);
  }

  return await res.json() as ChatCompletionResponse;
}

export async function embed(
  _backendConfig: BackendConfig,
  _request: unknown,
  _ctx: BaseBackendContext | null,
): Promise<never> {
  throw new HttpError('Embeddings not supported by kilocode backend', 501);
}

export async function* completeStreaming(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);
  body.stream = true;

  const res = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(`kilocode ${res.status}: ${errText.substring(0, 500)}`, res.status);
  }

  const responseBody = res.body;
  if (!responseBody) throw new HttpError('kilocode response body is null', 500);
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as ChatCompletionChunk;
      } catch {
        // skip malformed JSON lines
      }
    }
  }
}
