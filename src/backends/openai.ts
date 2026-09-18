import OpenAI from 'openai';
import {
  HttpError,
  toHttpError,
  type ChatRequest,
  type ChatCompletionResponse,
  type ChatCompletionChunk,
  type BaseBackendContext,
  type EmbedRequest,
  type EmbeddingResponse,
  type ModelInfo,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { EmbeddingCreateParams } from 'openai/resources/embeddings';

export const name = 'openai' as const;

export interface OpenAIContext extends BaseBackendContext {
  apiKey: string;
  client: OpenAI;
}

export interface OpenAIBackendConfig extends BackendConfig {
  baseUrl?: string;
  apiKey?: string;
  proxy?: string;
  timeout?: number;
  models?: string[];
  maxRetries?: number;
}

function clientOptions(
  baseUrl: string,
  apiKey: string,
  timeout: number,
  dispatcher: object | undefined,
  maxRetries: number,
): ConstructorParameters<typeof OpenAI>[0] {
  return {
    baseURL: baseUrl,
    apiKey: apiKey || 'none',
    timeout,
    maxRetries,
    fetchOptions: dispatcher ? { dispatcher } as Record<string, unknown> : undefined,
  };
}

export async function init(backendConfig: OpenAIBackendConfig): Promise<OpenAIContext> {
  const baseUrl = backendConfig.baseUrl ?? 'http://127.0.0.1:11434/v1';
  const apiKey = backendConfig.apiKey ?? '';
  const timeout = backendConfig.timeout ?? 300_000;
  const maxRetries = typeof backendConfig.maxRetries === 'number' ? backendConfig.maxRetries : 2;

  const { createProxyAgent } = await import('../fetch-proxy.js');
  const dispatcher = await createProxyAgent(backendConfig.proxy);
  const client = new OpenAI(clientOptions(baseUrl, apiKey, timeout, dispatcher, maxRetries));

  let models = backendConfig.models;
  if (!models) {
    try {
      const page = await client.models.list();
      models = page.data?.map((m) => m.id) ?? [];
    } catch {
      // silent: model discovery is best-effort
    }
  }

  return { baseUrl, apiKey, models: models ?? [], dispatcher, timeout, client };
}

export function listModels(_backendConfig: OpenAIBackendConfig, ctx: BaseBackendContext | null): ModelInfo[] {
  if (!ctx) return [];
  const openaiCtx = ctx as OpenAIContext;
  return (openaiCtx.models ?? []).map((id) => ({
    id: `openai/${id}`,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'openai',
  }));
}

function buildParams(request: ChatRequest, model: string | undefined): ChatCompletionCreateParamsNonStreaming {
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: model || '',
    messages: request.messages ?? [],
  };
  if (request.maxTokens) params.max_tokens = request.maxTokens;
  if (request.temperature != null) params.temperature = request.temperature;
  if (request.response_format?.type) params.response_format = request.response_format;
  if (request.tools) params.tools = request.tools;
  if (request.tool_choice) params.tool_choice = request.tool_choice;
  return params;
}

export async function complete(
  _backendConfig: OpenAIBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
  const oc = ctx as OpenAIContext;
  try {
    return await oc.client.chat.completions.create(buildParams(request, request.model), { stream: false });
  } catch (e: unknown) {
    throw toHttpError(e, 'openai');
  }
}

export async function embed(
  _backendConfig: OpenAIBackendConfig,
  request: EmbedRequest,
  ctx: BaseBackendContext | null,
): Promise<EmbeddingResponse> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
  const oc = ctx as OpenAIContext;
  const params: EmbeddingCreateParams = { model: request.model, input: request.input };
  if (request.encoding_format) params.encoding_format = request.encoding_format;
  try {
    return await oc.client.embeddings.create(params);
  } catch (e: unknown) {
    throw toHttpError(e, 'openai');
  }
}

export async function* completeStreaming(
  backendConfig: OpenAIBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx) throw new HttpError('openai backend not initialized', 503);
  const oc = ctx as OpenAIContext;
  void backendConfig;
  try {
    const stream = await oc.client.chat.completions.create({ ...buildParams(request, request.model), stream: true });
    for await (const chunk of stream) {
      yield chunk;
    }
  } catch (e: unknown) {
    throw toHttpError(e, 'openai');
  }
}
