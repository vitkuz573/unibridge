import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';
import {
  HttpError,
  ChatRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Message,
  MessagePart,
  BaseBackendContext,
  EmbedRequest,
  EmbeddingResponse,
  ToolCall,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import {
  basicAuthHeader,
  buildPartsFromMessages,
  injectSystemIntoParts,
  injectForceJson,
  parseUsage,
  parseResponseParts,
} from './shared/session-protocol.js';

// ---------------------------------------------------------------------------
// Mimocode-specific types
// ---------------------------------------------------------------------------

export interface MimocodeContext extends BaseBackendContext {
  auth: Record<string, string>;
  serverPassword: string;
  serverUsername: string;
}

export interface MimocodeBackendConfig extends BackendConfig {
  baseUrl?: string;
  serverPassword?: string;
  serverUsername?: string;
  proxy?: unknown;
  forceJson?: boolean;
  minTokens?: number;
  timeout?: number;
  freeOnly?: boolean;
  models?: string[];
}

interface SessionResponse {
  id: string;
}

interface ResponsePart {
  type: string;
  text?: string;
  tool_use?: { tool?: string; input?: unknown };
  tool_result?: { content?: unknown };
}

interface MessageResponse {
  parts: ResponsePart[];
  info?: {
    tokens?: { input?: number; output?: number };
  };
}

interface ProviderResponse {
  providers: Array<{
    id: string;
    models: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export const name: string = 'mimocode';

export async function init(backendConfig: MimocodeBackendConfig): Promise<MimocodeContext> {
  const baseUrl = backendConfig.baseUrl || 'http://127.0.0.1:4096';
  const serverPassword = backendConfig.serverPassword || process.env['MIMOCODE_SERVER_PASSWORD'] || '';
  const serverUsername = backendConfig.serverUsername || process.env['MIMOCODE_SERVER_USERNAME'] || 'opencode';
  const auth = basicAuthHeader(serverUsername, serverPassword);
  const timeout = backendConfig.timeout || 300_000;

  let models: string[] = backendConfig.models ?? [];
  if (backendConfig.models === undefined) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...auth };
    const res = await fetch(`${baseUrl}/config/providers`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const data: ProviderResponse = await res.json() as ProviderResponse;
    models = [];
    for (const p of data.providers || []) {
      for (const modelId of Object.keys(p.models || {})) {
        models.push(`${p.id}/${modelId}`);
      }
    }
    if (backendConfig.freeOnly !== false) {
      const freeModel = 'mimo/mimo-auto';
      models = models.filter((id: string) => id === freeModel);
    }
  }

  const dispatcher = await createProxyAgent(backendConfig.proxy as string | undefined);

  return { baseUrl, auth, models, serverPassword, serverUsername, dispatcher, timeout };
}

export function listModels(
  _backendConfig: BackendConfig,
  ctx: BaseBackendContext | null,
): Array<{ id: string; object: string }> {
  if (!ctx) return [];
  const mc = ctx as MimocodeContext;
  const models: string[] = mc.models || [];
  return models.map((id: string) => ({
    id: `mimocode/${id}`,
    object: 'model',
  }));
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx) throw new HttpError('mimocode backend not initialized', 503);
  const mc = ctx as MimocodeContext;
  const bc = backendConfig as MimocodeBackendConfig;
  const { messages, model, maxTokens, response_format } = request;
  const { baseUrl, auth, timeout } = mc;
  const forceJson = bc.forceJson || false;
  const minTokens = bc.minTokens || 0;

  const requestModel = model || '';
  const slashIdx = requestModel.indexOf('/');
  const providerID = slashIdx >= 0 ? requestModel.slice(0, slashIdx) : requestModel;
  const modelID = slashIdx >= 0 ? requestModel.slice(slashIdx + 1) : requestModel;

  const system: string = (messages || [])
    .filter((m: Message) => m.role === 'system')
    .map((m: Message) => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts: MessagePart[] = buildPartsFromMessages(messages) as MessagePart[];
  injectSystemIntoParts(parts, system);
  if (forceJson) injectForceJson(parts);

  const msgBody: Record<string, unknown> = {
    model: { providerID, modelID },
    parts,
  };
  if (maxTokens || minTokens) {
    msgBody['maxTokens'] = Math.max(maxTokens || 0, minTokens);
  }
  if (response_format?.type) {
    msgBody['response_format'] = response_format;
  }

  const dispatcher = mc.dispatcher as Parameters<typeof proxyFetch>[2];

  const sessionRes = await proxyFetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      permission: [{ permission: '*', pattern: '**', action: 'allow' }],
    }),
    signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
  }, dispatcher);

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    throw new HttpError(
      `mimocode session ${sessionRes.status}: ${errText.substring(0, 500)}`,
      sessionRes.status,
    );
  }

  const session: SessionResponse = await sessionRes.json() as SessionResponse;

  const msgRes = await proxyFetch(`${baseUrl}/session/${session.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(msgBody),
    signal: AbortSignal.timeout(timeout),
  }, dispatcher);

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    throw new HttpError(
      `mimocode ${msgRes.status}: ${errText.substring(0, 500)}`,
      msgRes.status,
    );
  }

  const data: MessageResponse = await msgRes.json() as MessageResponse;

  let { text: content, reasoning: rawReasoning, toolCalls } = parseResponseParts(data);
  let reasoningAnnotated = '';
  if (rawReasoning) {
    for (const line of rawReasoning.split('\n')) {
      if (line) reasoningAnnotated += `[reasoning: ${line}]\n`;
    }
  }

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  if (!forceJson && reasoningAnnotated) {
    content = reasoningAnnotated + (content ? '\n' + content : '');
  }

  const usage = parseUsage(data);

  const message: { role: 'assistant'; content: string; reasoning?: string; tool_calls?: ToolCall[] } = {
    role: 'assistant',
    content,
  };
  if (rawReasoning) message.reasoning = rawReasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

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

export async function* completeStreaming(
  _backendConfig: BackendConfig,
  _request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx) throw new HttpError('mimocode backend not initialized', 503);
  const bc = _backendConfig as MimocodeBackendConfig;
  if (!bc['streaming']) return;
  throw new HttpError('Streaming not supported by mimocode backend', 501);
}

export async function embed(
  _backendConfig: BackendConfig,
  _request: EmbedRequest,
  _ctx: BaseBackendContext | null,
): Promise<EmbeddingResponse> {
  throw new HttpError('Embeddings not supported by mimocode backend', 501);
}
