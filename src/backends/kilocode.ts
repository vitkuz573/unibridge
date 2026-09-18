import OpenAI from 'openai';
import {
  HttpError,
  toHttpError,
  type ChatRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type BaseBackendContext,
  type ModelInfo,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

export const name = 'kilocode' as const;

export interface KilocodeContext extends BaseBackendContext {
  apiKey: string;
  client: OpenAI;
}

export interface KilocodeBackendConfig extends BackendConfig {
  baseUrl?: string;
  apiKey?: string;
  proxy?: string;
  timeout?: number;
  models?: string[];
  maxRetries?: number;
}

interface KilocodeModel {
  id: string;
  isFree?: boolean;
}

export async function init(backendConfig: KilocodeBackendConfig): Promise<KilocodeContext> {
  const baseUrl = backendConfig.baseUrl || 'https://api.kilo.ai/api/gateway';
  const apiKey = backendConfig.apiKey || process.env['KILO_API_KEY'] || '';
  const timeout = backendConfig.timeout || 300_000;
  const maxRetries = typeof backendConfig.maxRetries === 'number' ? backendConfig.maxRetries : 2;
  const { createProxyAgent } = await import('../fetch-proxy.js');
  const dispatcher = await createProxyAgent(backendConfig.proxy);
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey: apiKey || 'none',
    timeout,
    maxRetries,
    fetchOptions: dispatcher ? { dispatcher } as Record<string, unknown> : undefined,
  });
  let models = backendConfig.models;

  if (!models) {
    try {
      // Kilo gateway exposes a plain model list; fetch directly (SDK has
      // no typed method for this non-standard endpoint).
      const { proxyFetch } = await import('../fetch-proxy.js');
      const res = await proxyFetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10000) }, dispatcher);
      if (res.ok) {
        const data = await res.json() as { data: KilocodeModel[] };
        models = (data.data || [])
          .filter((m) => m.isFree)
          .map((m) => m.id);
      }
    } catch {
      // silent: model discovery is best-effort
    }
  }

  return { baseUrl, apiKey, models: models || [], dispatcher, timeout, client };
}

export function listModels(_backendConfig: BackendConfig, ctx: BaseBackendContext | null): ModelInfo[] {
  if (!ctx) return [];
  const models: string[] = ctx.models || [];
  return models.map((id) => ({
    id: `kilocode/${id}`,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'kilocode',
  }));
}

function buildParams(request: ChatRequest, backendConfig: BackendConfig): ChatCompletionCreateParamsNonStreaming {
  const minTokensRaw = (backendConfig as Record<string, unknown>)['minTokens'];
  const minTokens = request.minTokens || (typeof minTokensRaw === 'number' ? minTokensRaw : 0);
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: request.model,
    messages: request.messages || [],
  };
  if (request.maxTokens || minTokens) {
    params.max_tokens = Math.max(request.maxTokens || 0, minTokens || 0);
  }
  if (request.response_format?.type) {
    params.response_format = request.response_format;
  }
  if (request.tools) {
    params.tools = request.tools;
  }
  if (request.tool_choice) {
    params.tool_choice = request.tool_choice;
  }
  return params;
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const kc = ctx as KilocodeContext;
  void backendConfig;
  try {
    return await kc.client.chat.completions.create(buildParams(request, backendConfig), { stream: false });
  } catch (e: unknown) {
    throw toHttpError(e, 'kilocode');
  }
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
  const kc = ctx as KilocodeContext;
  void backendConfig;
  try {
    const stream = await kc.client.chat.completions.create({ ...buildParams(request, backendConfig), stream: true });
    for await (const chunk of stream) {
      yield chunk;
    }
  } catch (e: unknown) {
    throw toHttpError(e, 'kilocode');
  }
}
