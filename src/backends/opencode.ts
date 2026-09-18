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
  ResponsesFunctionCallOutput,
  ResponseFormat,
  ToolCall,
} from '../types.js';
import type { BackendConfig } from '../config.js';
import type { ModelInfo } from './registry.js';
import {
  basicAuthHeader,
  buildPartsFromMessages,
  parseUsage,
  parseResponsesUsage,
  parseResponseParts,
} from './shared/session-protocol.js';
import {
  validateStructuredOutput,
  formatValidationErrors,
} from './shared/structured.js';
import { uid, log } from '../utils.js';

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
  properties?: Record<string, unknown>;
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
  const { messages, model, maxTokens, minTokens: reqMinTokens, response_format } = request;
  const { baseUrl, auth, timeout } = oc;
  const minTokens = reqMinTokens || backendConfig.minTokens || 0;

  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts = buildPartsFromMessages(messages);

  interface MsgBody {
    model: { providerID: string; modelID: string };
    parts: { type: string; text?: string; mime?: string; url?: string }[];
    system?: string;
    maxTokens?: number;
    response_format?: ResponseFormat;
  }

  const msgBody: MsgBody = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };

  // Native system prompt: opencode's message endpoint accepts a top-level
  // ``system`` field. Inlining ``[System instructions: ...]`` into the user
  // text does NOT work — the model ignores it (verified: pirate test).
  if (system) {
    msgBody.system = system;
  }

  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }

  // Native structured output: forwarded best-effort to the upstream; the
  // guarantee comes from local validation below (validateStructuredOutput).
  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  const needsStructured = !!response_format && response_format.type !== 'text';

  async function sendOnce(extraFeedback?: string): Promise<MessageResponse> {
    const body: MsgBody = extraFeedback
      ? {
          ...msgBody,
          parts: [
            ...msgBody.parts,
            { type: 'text', text: `Your previous reply was invalid: ${extraFeedback}. Reply with valid output only.` },
          ],
        }
      : msgBody;
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
        body: JSON.stringify(body),
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

    return await msgRes.json() as MessageResponse;
  }

  let data = await sendOnce();
  let parsed = parseResponseParts(data);
  let content = parsed.text;
  const rawReasoning = parsed.reasoning;
  const toolCalls = parsed.toolCalls;

  // Structured output: validate locally, retry once with feedback.
  if (needsStructured && response_format) {
    let check = validateStructuredOutput(content, response_format);
    if (!check.ok) {
      log(`STRUCT retry model=${model} errors=${formatValidationErrors(check.errors)}`);
      data = await sendOnce(formatValidationErrors(check.errors));
      parsed = parseResponseParts(data);
      content = parsed.text;
      check = validateStructuredOutput(content, response_format);
      if (!check.ok) {
        throw new HttpError(
          `opencode structured output validation failed for model ${model}: ${formatValidationErrors(check.errors)}`,
          502,
        );
      }
    }
  }

  const usage = parseUsage(data);

  const message: { role: 'assistant'; content: string; reasoning?: string; tool_calls?: ToolCall[] } = { role: 'assistant', content };
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

function buildPartsFromResponsesInput(input: unknown): { parts: Array<{ type: string; text?: string; mime?: string; url?: string; tool_use?: { tool: string; input: unknown }; tool_result?: { content: unknown } }>; system: string } {
  const parts: Array<{ type: string; text?: string; mime?: string; url?: string; tool_use?: { tool: string; input: unknown }; tool_result?: { content: unknown } }> = [];
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
    } else if (obj.type === 'function_call') {
      const fc = item as { name?: string; arguments?: string };
      parts.push({ type: 'tool_use', tool_use: { tool: fc.name || '', input: JSON.parse(fc.arguments || '{}') } });
    } else if (obj.type === 'function_call_output') {
      const fco = item as { output?: string };
      parts.push({ type: 'tool_result', tool_result: { content: fco.output ?? '' } });
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
  const { model, max_output_tokens, temperature, text } = request;
  const { baseUrl, auth, timeout } = oc;
  const minTokens = backendConfig.minTokens || 0;
  const response_format = text?.format;

  const { parts, system } = buildPartsFromResponsesInput(request.input);

  interface MsgBody {
    model: { providerID: string; modelID: string };
    parts: Array<{ type: string; text?: string; mime?: string; url?: string; tool_use?: { tool: string; input: unknown }; tool_result?: { content: unknown } }>;
    system?: string;
    maxTokens?: number;
    response_format?: ResponseFormat;
    temperature?: number;
  }

  const msgBody: MsgBody = {
    model: { providerID: 'opencode', modelID: model || '' },
    parts,
  };

  if (system) {
    msgBody.system = system;
  }

  if (max_output_tokens || minTokens) {
    msgBody.maxTokens = Math.max(max_output_tokens || 0, minTokens);
  }

  if (temperature != null) msgBody.temperature = temperature;

  // Native structured output (see complete() above).
  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  const needsStructured = !!response_format && response_format.type !== 'text';

  async function sendOnce(extraFeedback?: string): Promise<MessageResponse> {
    const body: MsgBody = extraFeedback
      ? {
          ...msgBody,
          parts: [
            ...msgBody.parts,
            { type: 'text', text: `Your previous reply was invalid: ${extraFeedback}. Reply with valid output only.` },
          ],
        }
      : msgBody;
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
        body: JSON.stringify(body),
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

    return await msgRes.json() as MessageResponse;
  }

  let data = await sendOnce();
  let parsed = parseResponseParts(data);
  let content = parsed.text;
  const rawReasoning = parsed.reasoning;
  const toolCalls = parsed.toolCalls;

  if (needsStructured && response_format) {
    let check = validateStructuredOutput(content, response_format);
    if (!check.ok) {
      log(`STRUCT retry model=${model} errors=${formatValidationErrors(check.errors)}`);
      data = await sendOnce(formatValidationErrors(check.errors));
      parsed = parseResponseParts(data);
      content = parsed.text;
      check = validateStructuredOutput(content, response_format);
      if (!check.ok) {
        throw new HttpError(
          `opencode structured output validation failed for model ${model}: ${formatValidationErrors(check.errors)}`,
          502,
        );
      }
    }
  }

  const usage = parseResponsesUsage(data);

  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput | ResponsesFunctionCallOutput> = [];
  if (rawReasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: rawReasoning }],
    });
  }
  for (const tc of toolCalls) {
    output.push({
      type: 'function_call',
      id: uid('fc'),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
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
    model: model || '',
    output,
    usage,
  };
}

export async function* responsesStreaming(
  backendConfig: OpencodeBackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;

  const { model, max_output_tokens, temperature, text } = request;
  const { baseUrl, auth, timeout, dispatcher } = oc;
  const minTokens = backendConfig.minTokens || 0;
  const response_format = text?.format;

  const { parts, system } = buildPartsFromResponsesInput(request.input);

  interface MsgBody {
    model: { providerID: string; modelID: string };
    parts: Array<{ type: string; text?: string; mime?: string; url?: string; tool_use?: { tool: string; input: unknown }; tool_result?: { content: unknown } }>;
    system?: string;
    maxTokens?: number;
    response_format?: ResponseFormat;
    temperature?: number;
  }

  const msgBody: MsgBody = {
    model: { providerID: 'opencode', modelID: model || '' },
    parts,
  };

  if (system) {
    msgBody.system = system;
  }

  if (max_output_tokens || minTokens) {
    msgBody.maxTokens = Math.max(max_output_tokens || 0, minTokens);
  }

  if (temperature != null) msgBody.temperature = temperature;

  // Native structured output (see complete() above). Streaming cannot retry
  // mid-stream, so validation happens client-side on the final text.
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

  const responseBody = eventRes.body;
  if (!responseBody) throw new HttpError('opencode event stream body is null', 500);
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const responseId = uid('resp');
  const created = Math.floor(Date.now() / 1000);
  let outputIndex = 0;
  let textBuffer = '';
  let textOutputItemId: string | null = null;
  let textPartOpened = false;
  let reasoningBuffer = '';
  let reasoningPartOpened = false;
  let messageItemAdded = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCacheReadTokens = 0;
  const partTypeMap = new Map<string, string>();
  const toolCallStates = new Map<string, 'pending' | 'running' | 'done'>();

  log(`RESP_STREAM starting session for model=${model}`);

  yield {
    type: 'response.created',
    response: { id: responseId, object: 'response', model: model || '', output: [], usage: null },
  };
  yield {
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', model: model || '', output: [], usage: null },
  };

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
        const props = event.properties as Record<string, unknown> | undefined;
        const evtSessionID = props?.['sessionID'] as string | undefined;
        if (evtSessionID && evtSessionID !== session.id) continue;

        if (event.type === 'message.part.updated') {
          const part = props?.['part'] as Record<string, unknown> | undefined;
          if (part?.['id'] && part?.['type']) {
            partTypeMap.set(String(part['id']), String(part['type']));
          }

          if (part?.['type'] === 'tool' || part?.['type'] === 'tool_use') {
            const toolName = (part['tool'] as string) || ((part['tool_use'] as Record<string, unknown>)?.['tool'] as string) || '';
            const state = (part['state'] || {}) as Record<string, unknown>;
            const status = (state['status'] as string) || 'pending';
            const inputObj = state?.['input'] ?? (part['tool_use'] as Record<string, unknown>)?.['input'];
            const callID = (part['callID'] as string) || `call_${outputIndex}`;
            const prev = toolCallStates.get(callID);

            if (status === 'pending' && !prev) {
              toolCallStates.set(callID, 'pending');
              const fcId = uid('fc');
              yield { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id: fcId, call_id: callID, name: toolName, arguments: '', status: 'in_progress' } };
              outputIndex++;
            } else if (status === 'running' && prev !== 'done') {
              toolCallStates.set(callID, 'running');
              const args = typeof inputObj === 'object' ? JSON.stringify(inputObj) : String(inputObj || '');
              const fcId = uid('fc');
              if (prev !== 'pending') {
                yield { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id: fcId, call_id: callID, name: toolName, arguments: '', status: 'in_progress' } };
                outputIndex++;
              }
              if (args && args !== '{}') {
                yield { type: 'response.function_call_arguments.delta', item_id: fcId, output_index: outputIndex - 1, delta: args };
              }
              yield { type: 'response.function_call_arguments.done', item_id: fcId, output_index: outputIndex - 1, name: toolName, arguments: args };
              yield { type: 'response.output_item.done', output_index: outputIndex - 1, item: { type: 'function_call', id: fcId, call_id: callID, name: toolName, arguments: args, status: 'completed' } };
              toolCallStates.set(callID, 'done');
            }
          } else if (part?.['type'] === 'step-start') {
          } else if (part?.['type'] === 'step-finish') {
            const stepTokens = (part['tokens'] || {}) as Record<string, unknown>;
            totalInputTokens = Math.max(totalInputTokens, (stepTokens['input'] as number) || 0);
            totalOutputTokens = Math.max(totalOutputTokens, (stepTokens['output'] as number) || 0);
            totalReasoningTokens = Math.max(totalReasoningTokens, (stepTokens['reasoning'] as number) || 0);
            const stepCache = (stepTokens['cache'] || {}) as Record<string, unknown>;
            totalCacheReadTokens = Math.max(totalCacheReadTokens, (stepCache['read'] as number) || 0);
          }
        } else if (event.type === 'message.part.delta') {
          const delta = props?.['delta'] as string | undefined;
          if (!delta) continue;
          const partID = (props?.['partID'] as string) || '';
          const pType = partTypeMap.get(partID) || 'text';

          if (pType === 'reasoning') {
            reasoningBuffer += delta;
            if (!messageItemAdded) {
              messageItemAdded = true;
              textOutputItemId = uid('msg');
              yield { type: 'response.output_item.added', output_index: outputIndex, item: { id: textOutputItemId, type: 'message', role: 'assistant', content: [] } };
            }
            if (!reasoningPartOpened) {
              reasoningPartOpened = true;
              yield { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, part: { type: 'reasoning', summary: [] } };
            }
            yield { type: 'response.reasoning_summary_text.delta', delta, item_id: textOutputItemId!, output_index: outputIndex, content_index: 0 };
          } else if (pType === 'text') {
            textBuffer += delta;
            if (!messageItemAdded) {
              messageItemAdded = true;
              textOutputItemId = uid('msg');
              yield { type: 'response.output_item.added', output_index: outputIndex, item: { id: textOutputItemId, type: 'message', role: 'assistant', content: [] } };
            }
            if (!textPartOpened) {
              textPartOpened = true;
              const textIdx = reasoningPartOpened ? 1 : 0;
              yield { type: 'response.content_part.added', output_index: outputIndex, content_index: textIdx, part: { type: 'output_text', text: '' } };
            }
            const textIdx = reasoningPartOpened ? 1 : 0;
            yield { type: 'response.output_text.delta', delta, item_id: textOutputItemId!, output_index: outputIndex, content_index: textIdx };
          }
        } else if (event.type === 'message.updated') {
          const info = props?.['info'] as Record<string, unknown> | undefined;
          if (info?.['role'] === 'assistant' && info?.['finish'] === 'stop') {
            const tokens = info?.['tokens'] as Record<string, unknown> | undefined;
            if (tokens) {
              totalInputTokens = (tokens['input'] as number) || 0;
              totalOutputTokens = (tokens['output'] as number) || 0;
              totalReasoningTokens = (tokens['reasoning'] as number) || 0;
              const cache = tokens['cache'] as Record<string, unknown> | undefined;
              totalCacheReadTokens = (cache?.['read'] as number) || 0;
            }

            if (messageItemAdded && textOutputItemId) {
              if (reasoningPartOpened) {
                yield { type: 'response.reasoning_summary_text.done', text: reasoningBuffer, item_id: textOutputItemId, output_index: outputIndex, content_index: 0 };
                yield { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, part: { type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningBuffer }] } };
              }

              if (textPartOpened) {
                const textIdx = reasoningPartOpened ? 1 : 0;
                yield { type: 'response.output_text.done', text: textBuffer, item_id: textOutputItemId, output_index: outputIndex, content_index: textIdx };
                yield { type: 'response.content_part.done', output_index: outputIndex, content_index: textIdx, part: { type: 'output_text', text: textBuffer } };
              }

              const content: Array<Record<string, unknown>> = [];
              if (reasoningPartOpened) content.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoningBuffer }] });
              if (textPartOpened) content.push({ type: 'output_text', text: textBuffer });

              yield { type: 'response.output_item.done', output_index: outputIndex, item: { id: textOutputItemId, type: 'message', role: 'assistant', content } };
            }

            const usage: Record<string, unknown> = {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              total_tokens: totalInputTokens + totalOutputTokens + totalReasoningTokens,
            };
            if (totalReasoningTokens) usage['reasoning_tokens'] = totalReasoningTokens;
            if (totalCacheReadTokens) {
              usage['input_tokens_details'] = { cached_tokens: totalCacheReadTokens };
            }

            yield {
              type: 'response.completed',
              response: {
                id: responseId,
                object: 'response',
                created,
                model: model || '',
                output: [],
                usage,
              },
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

  const { messages, model, maxTokens, minTokens: reqMinTokens, response_format, temperature } = request;
  const { baseUrl, auth, timeout, dispatcher } = oc;
  const minTokens = reqMinTokens || backendConfig.minTokens || 0;

  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts = buildPartsFromMessages(messages);

  interface StreamingMsgBody {
    model: { providerID: string; modelID: string };
    parts: { type: string; text?: string; mime?: string; url?: string }[];
    system?: string;
    maxTokens?: number;
    response_format?: ResponseFormat;
    temperature?: number;
  }

  const msgBody: StreamingMsgBody = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };
  if (system) {
    msgBody.system = system;
  }
  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }
  // Native structured output (see complete() above). Streaming cannot retry
  // mid-stream, so validation happens client-side on the final text.
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
        const props = event.properties as Record<string, unknown> | undefined;
        const evtSessionID = props?.['sessionID'] as string | undefined;
        if (evtSessionID && evtSessionID !== session.id) continue;

        if (event.type === 'message.part.updated') {
          const part = props?.['part'] as Record<string, unknown> | undefined;
          if (part?.['type'] === 'tool' || part?.['type'] === 'tool_use') {
            const toolName = (part['tool'] as string) || ((part['tool_use'] as Record<string, unknown>)?.['tool'] as string) || '';
            const state = (part['state'] || {}) as Record<string, unknown>;
            const status = (state['status'] as string) || 'pending';
            if (status !== 'running') continue;
            const inputObj = state?.['input'] ?? (part['tool_use'] as Record<string, unknown>)?.['input'];
            const args = typeof inputObj === 'object' ? JSON.stringify(inputObj) : String(inputObj || '');
            const callID = (part['callID'] as string) || `call_0`;
            if (!roleEmitted) {
              yield {
                id: `chatcmpl-${session.id}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              };
              roleEmitted = true;
            }
            yield {
              id: `chatcmpl-${session.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: callID,
                    type: 'function',
                    function: { name: toolName, arguments: args },
                  }],
                },
                finish_reason: null,
              }],
            };
          }
        } else if (event.type === 'message.part.delta') {
          const delta = props?.['delta'] as string | undefined;
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
          const info = props?.['info'] as Record<string, unknown> | undefined;
          const partsList = props?.['parts'] as unknown[] | undefined;
          if (info?.['role'] === 'assistant' && info?.['finish'] === 'stop') {
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
          if (info?.['role'] === 'assistant' && Array.isArray(partsList)) {
            let toolCallIndex = 0;
            for (const part of partsList) {
              if (part && typeof part === 'object' && 'type' in part && (part as Record<string, unknown>)['type'] === 'tool_use') {
                const tu = ((part as Record<string, unknown>)['tool_use'] || {}) as Record<string, unknown>;
                if (!roleEmitted) {
                  yield {
                    id: `chatcmpl-${session.id}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: request.model,
                    choices: [{
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null,
                    }],
                  };
                  roleEmitted = true;
                }
                yield {
                  id: `chatcmpl-${session.id}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: request.model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolCallIndex,
                        id: ((part as Record<string, unknown>)['id'] as string) || `call_${toolCallIndex}`,
                        type: 'function',
                        function: {
                          name: (tu['tool'] as string) || '',
                          arguments: typeof tu['input'] === 'object' ? JSON.stringify(tu['input']) : String(tu['input'] || ''),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                toolCallIndex++;
              }
            }
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
