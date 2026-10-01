import OpenAI from 'openai';
import {
  HttpError,
  toHttpError,
  type ChatRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type BaseBackendContext,
  type ModelInfo,
} from '../types.ts';
import type { BackendConfig } from '../config.ts';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { chatCompletionParams } from './shared/openai-compat.ts';

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
  const { createProxyAgent } = await import('../fetch-proxy.ts');
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
      const { proxyFetch } = await import('../fetch-proxy.ts');
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

/**
 * The forwarded request, with `max_tokens` raised to the operator's floor.
 *
 * The floor is a backend setting, not a request field — it used to be readable
 * from the request too, which nothing ever populated, so the only effect was a
 * branch that could not be taken. Everything else is forwarded as it arrived.
 */
function buildParams(request: ChatRequest, backendConfig: BackendConfig): ChatCompletionCreateParamsNonStreaming {
  const floor = (backendConfig as Record<string, unknown>)['minTokens'];
  const params = chatCompletionParams(request, request.model);
  if (typeof floor === 'number' && floor > 0) {
    params.max_tokens = Math.max(params.max_tokens ?? 0, floor);
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
