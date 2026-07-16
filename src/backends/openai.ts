import type { BackendConfig } from '../config.js';
import {
  HttpError,
  ChatRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  BaseBackendContext,
  EmbedRequest,
  EmbeddingResponse,
} from '../types.js';
import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';

export const name = 'openai';

export interface OpenAIContext extends BaseBackendContext {
  apiKey: string;
}

export interface OpenAIBackendConfig extends BackendConfig {
  baseUrl?: string;
  apiKey?: string;
  proxy?: string;
  timeout?: number;
  models?: string[];
}

interface OpenAIModelsResponse {
  data: Array<{ id: string }>;
}

interface OpenAIStreamingBody {
  model?: string;
  messages: ChatRequest['messages'];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type?: string };
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
}

interface OpenAIEmbedBody {
  model?: string;
  input: string | string[];
  encoding_format?: string;
}

function buildBody(_backendConfig: OpenAIBackendConfig, request: ChatRequest): OpenAIStreamingBody {
  const { messages, model, maxTokens, response_format, temperature } = request;

  const body: OpenAIStreamingBody = {
    model,
    messages: messages ?? [],
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;
  if (response_format?.type) body.response_format = response_format;
  if (request.tools) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;
  return body;
}

function headers(ctx: BaseBackendContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = (ctx as OpenAIContext).apiKey;
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

export async function init(backendConfig: OpenAIBackendConfig): Promise<OpenAIContext> {
  const baseUrl = backendConfig.baseUrl ?? 'http://127.0.0.1:11434/v1';
  const apiKey = backendConfig.apiKey ?? '';
  const timeout = backendConfig.timeout ?? 300_000;

  let models = backendConfig.models;
  if (!models) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data: OpenAIModelsResponse = await res.json();
        models = data.data?.map((m) => m.id) ?? [];
      }
    } catch {
      // silent: model discovery is best-effort
    }
  }

  const dispatcher = await createProxyAgent(backendConfig.proxy);
  return { baseUrl, apiKey, models: models ?? [], dispatcher, timeout };
}

export function listModels(_backendConfig: OpenAIBackendConfig, ctx: BaseBackendContext | null): Array<{ id: string; object: string }> {
  if (!ctx) return [];
  const openaiCtx = ctx as OpenAIContext;
  return (openaiCtx.models ?? []).map((id) => ({
    id: `openai/${id}`,
    object: 'model',
  }));
}

export async function complete(
  backendConfig: OpenAIBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
  const body = buildBody(backendConfig, request);

  const res = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(`openai ${res.status}: ${errText.substring(0, 500)}`, res.status);
  }

  return await res.json() as ChatCompletionResponse;
}

export async function embed(
  _backendConfig: OpenAIBackendConfig,
  request: EmbedRequest,
  ctx: BaseBackendContext | null,
): Promise<EmbeddingResponse> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
  const { model, input, encoding_format } = request;

  const body: OpenAIEmbedBody = { model, input };
  if (encoding_format) body.encoding_format = encoding_format;

  const res = await proxyFetch(`${ctx.baseUrl}/embeddings`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.min(ctx.timeout, 60_000)),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    throw new HttpError(`openai ${res.status}: ${errText.substring(0, 500)}`, res.status);
  }

  return await res.json() as EmbeddingResponse;
}

export async function* completeStreaming(
  backendConfig: OpenAIBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
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
    throw new HttpError(`openai ${res.status}: ${errText.substring(0, 500)}`, res.status);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as ChatCompletionChunk;
      } catch {
        // skip malformed SSE lines
      }
    }
  }
}
