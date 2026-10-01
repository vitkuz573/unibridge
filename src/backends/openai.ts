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
} from '../types.ts';
import type { BackendConfig } from '../config.ts';
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

  const { createProxyAgent } = await import('../fetch-proxy.ts');
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
    // The whole point of this backend is that it speaks the OpenAI contract, and
    // the contract carries the generation knobs. It forwards every one of them.
    capabilities: {
      reasoning: true,
      tool_calls: true,
      attachments: false,
      temperature: true,
      max_tokens: true,
    },
  }));
}

/**
 * Forward every knob the caller set.
 *
 * `!= null` rather than truthiness throughout: `max_tokens: 0`, `temperature: 0`
 * and `seed: 0` are all meaningful values that a truthy test silently drops, so
 * a caller asking for a deterministic answer with temperature 0 was getting the
 * provider's default instead. Unknown members are passed through as-is — the
 * OpenAI-compatible surface is exactly where a provider's own extensions
 * belong, and inventing a subset here is how half of them get lost.
 */
function buildParams(request: ChatRequest, model: string | undefined): ChatCompletionCreateParamsNonStreaming {
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: model || '',
    messages: request.messages ?? [],
  };
  if (request.maxTokens != null) params.max_tokens = request.maxTokens;
  if (request.temperature != null) params.temperature = request.temperature;
  if (request.topP != null) params.top_p = request.topP;
  if (request.stop != null) params.stop = request.stop as ChatCompletionCreateParamsNonStreaming['stop'];
  if (request.seed != null) params.seed = request.seed;
  if (request.presencePenalty != null) params.presence_penalty = request.presencePenalty;
  if (request.frequencyPenalty != null) params.frequency_penalty = request.frequencyPenalty;
  if (request.n != null) params.n = request.n;
  if (request.logprobs != null) params.logprobs = request.logprobs;
  if (request.topLogprobs != null) params.top_logprobs = request.topLogprobs;
  if (request.logitBias != null) params.logit_bias = request.logitBias;
  if (request.parallelToolCalls != null) params.parallel_tool_calls = request.parallelToolCalls;
  if (request.user != null) params.user = request.user;
  if (request.response_format?.type) params.response_format = request.response_format;
  if (request.tools) params.tools = request.tools;
  if (request.tool_choice) params.tool_choice = request.tool_choice;
  // Forward the requested level verbatim; `default` means "provider default"
  // and is omitted. Upstreams that do not know the parameter reject it, which
  // the caller sees as a provider error.
  const effort = request.reasoningEffort?.trim();
  if (effort && effort.toLowerCase() !== 'default') {
    // The SDK union does not cover every level a provider may advertise
    // (for example unibridge-only names); the wire field stays a string.
    Object.assign(params, { reasoning_effort: effort });
  }
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
