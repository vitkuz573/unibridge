import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';
import {
  HttpError,
  ChatRequest,
  ChatCompletionResponse,
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
  Usage,
  ResponsesUsage,
  type ModelCapabilitiesInfo,
  type ModelReasoningInfo,
} from '../types.js';
import type { ChatCompletionMessage, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { BackendConfig } from '../config.js';
import type { ModelInfo } from './registry.js';
import {
  basicAuthHeader,
  type TokenUsage,
} from './shared/session-protocol.js';
import {
  validateStructuredOutput,
  formatValidationErrors,
  buildRetryFeedback,
  schemaReminder,
} from './shared/structured.js';
import {
  choiceSchemaFor,
  clientToolsSystem,
  parseChoiceReply,
  salvageAnswerText,
  toToolCalls,
  type ClientToolDecision,
} from './shared/client-tools.js';
import { DecisionStreamScanner } from './shared/decision-stream.js';
import { uid, log } from '../utils.js';

// ---------------------------------------------------------------------------
// opencode v2 backend.
//
// unibridge talks only to the local `opencode serve` process over its v2 HTTP
// API (`/api/...`). The server owns provider credentials and performs every
// upstream provider call; unibridge never contacts a provider endpoint and
// never reads provider settings from model metadata.
//
// Wire contract (opencode 2.x):
//   GET  /api/model                                  -> { data: Model.Info[] }
//   POST /api/session                                -> { data: Session.Info }
//   POST /api/session/{id}/prompt                    -> { data: Inbox.User }
//   POST /api/session/{id}/permission/{permissionID}/reply
//   GET  /api/session/{id}/message                   -> { data: Message[], cursor }
//   GET  /api/session/{id}/permission                -> { data: Permission.Request[] }
//   POST /api/experimental/session/{id}/wait         -> 204 when the loop idles
//   GET  /api/event                                  -> SSE stream of v2 events
//   DELETE /api/session/{id}
//
// Sessions are created with an ask-all permission ruleset: the canonical
// agent tool profile stays advertised upstream (opencode's free tier rejects
// requests whose tool profile is stripped), while every actual tool execution
// requires approval. unibridge rejects those requests immediately, so no local
// tool ever runs on this host.
// ---------------------------------------------------------------------------

export const name = 'opencode' as const;

const DEFAULT_BASE_URL = 'http://127.0.0.1:5100';

/** Ask-all ruleset: tools stay advertised, nothing executes without approval. */
export const ASK_ALL_PERMISSIONS = [{ action: '*', resource: '*', effect: 'ask' }] as const;

// ---------------------------------------------------------------------------
// Backend-specific types
// ---------------------------------------------------------------------------

export interface OpencodeContext extends BaseBackendContext {
  auth: Record<string, string>;
  serverPassword: string;
  serverUsername: string;
  /** Per-model metadata discovered from `/api/model`. */
  modelMeta: Map<string, OpencodeModelMeta>;
}

export interface OpencodeModelMeta {
  /** Canonical id used inside `Model.Ref` on session create. */
  modelID: string;
  providerID: string;
  capabilities: ModelCapabilitiesInfo;
  reasoning: ModelReasoningInfo;
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
  // Client-executed tools: when true and the request carries OpenAI tools,
  // local serve tools are NOT offered. Instead the model is asked (via an
  // explicit JSON decision contract carried in the prompt) to return a tool
  // call, which is passed back to the client as finish_reason tool_calls —
  // the client executes and returns role:tool, and the loop continues until
  // text.
  clientTools?: boolean;
  // Max orchestrator rounds for clientTools (default 5).
  maxToolRounds?: number;
}

// ---------------------------------------------------------------------------
// opencode v2 wire types
// ---------------------------------------------------------------------------

export interface V2ModelVariant {
  id: string;
  settings?: Record<string, unknown>;
}

export interface V2ModelInfo {
  id: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  family?: string | null;
  compatibility?: { reasoningField?: string } | null;
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
  };
  variants?: V2ModelVariant[];
  status?: string;
  enabled?: boolean;
  limit?: { context?: number; input?: number; output?: number };
}

interface V2ModelListResponse {
  data?: V2ModelInfo[];
}

export interface V2ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

interface V2SessionInfo {
  id: string;
  model?: V2ModelRef;
}

interface V2SessionCreateResponse {
  data?: V2SessionInfo;
}

export interface V2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

interface V2PermissionListResponse {
  data?: V2PermissionRequest[];
}

export interface V2MessagePart {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  state?: { status?: string };
}

export interface V2AssistantMessage {
  id: string;
  type: 'assistant';
  content?: V2MessagePart[];
  finish?: string | null;
  error?: { type?: string; message?: string; status?: number } | null;
  tokens?: TokenUsage;
}

interface V2MessageListResponse {
  data?: Array<Record<string, unknown>>;
}

interface V2Event {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

function providerMatches(providerID: string | undefined): boolean {
  if (!providerID) return false;
  return providerID === 'opencode' || providerID.startsWith('opencode/');
}

/**
 * Reasoning levels advertised for one v2 model. Levels are the variant ids
 * (opencode's own named settings overrides) plus the `"default"` sentinel,
 * which means "send no variant". A model that declares a reasoning field but
 * no variants is a fixed-reasoning model: it advertises exactly `["default"]`.
 */
export function reasoningInfoFor(meta: V2ModelInfo): ModelReasoningInfo {
  const variants = (meta.variants ?? [])
    .map(v => v?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const reasoningField = meta.compatibility?.reasoningField ?? null;
  if (variants.length === 0 && !reasoningField) {
    return { supported: false, parameter: null, default: null, levels: [] };
  }
  if (variants.length === 0) {
    return { supported: true, parameter: null, default: 'default', levels: ['default'] };
  }
  return {
    supported: true,
    parameter: 'reasoning_effort',
    default: 'default',
    levels: ['default', ...variants],
  };
}

export function capabilitiesFor(meta: V2ModelInfo): ModelCapabilitiesInfo {
  const reasoning = reasoningInfoFor(meta).supported;
  const input = meta.capabilities?.input ?? [];
  return {
    reasoning,
    tool_calls: meta.capabilities?.tools === true,
    attachments: input.some(kind => kind !== 'text'),
    // The v2 model contract does not expose a temperature capability; the
    // session prompt API carries no generation knobs at all.
    temperature: false,
  };
}

export function metaFor(meta: V2ModelInfo): OpencodeModelMeta {
  return {
    modelID: meta.modelID || meta.id,
    providerID: meta.providerID || 'opencode',
    capabilities: capabilitiesFor(meta),
    reasoning: reasoningInfoFor(meta),
  };
}

// ---------------------------------------------------------------------------
// Reasoning level resolution
// ---------------------------------------------------------------------------

/**
 * Maps a requested `reasoning_effort` to an opencode variant id. Returns
 * `undefined` for the model default (no variant override). Unknown levels and
 * non-reasoning models are rejected with a 400 before any upstream call.
 */
export function resolveVariant(
  oc: OpencodeContext,
  model: string,
  reasoningEffort: string | undefined,
): string | undefined {
  if (reasoningEffort === undefined) return undefined;
  const requested = reasoningEffort.trim().toLowerCase();
  if (requested === '') return undefined;

  const meta = oc.modelMeta.get(model);
  if (!meta) {
    // Model list is operator-pinned and carries no metadata: keep the level
    // as-is; the server ignores variants a model does not declare.
    return requested === 'default' ? undefined : requested;
  }

  if (!meta.reasoning.supported) {
    throw new HttpError(`Model '${model}' does not support reasoning_effort.`, 400);
  }
  if (!meta.reasoning.levels.includes(requested)) {
    throw new HttpError(
      `Reasoning effort '${reasoningEffort}' is not available for model '${model}'. ` +
        `Supported: ${meta.reasoning.levels.join(', ')}.`,
      400,
    );
  }
  return requested === 'default' ? undefined : requested;
}

// ---------------------------------------------------------------------------
// Local request helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch against the local opencode server. Retries idempotent requests only;
 * every rejection is converted into an HttpError so a slow or unavailable
 * server can never surface as an unhandled rejection.
 */
async function ocFetch(
  oc: OpencodeContext,
  path: string,
  init: RequestInit,
  options: { timeoutMs?: number; retries?: number; what?: string } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? oc.timeout;
  const retries = options.retries ?? 0;
  const what = options.what ?? `${init.method ?? 'GET'} ${path}`;
  const url = `${oc.baseUrl}${path}`;
  const opts: RequestInit = {
    ...init,
    headers: { 'Content-Type': 'application/json', ...oc.auth, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await proxyFetch(url, opts, oc.dispatcher);
      if (res.status < 500) return res;
      lastErr = new HttpError(`opencode ${what} returned HTTP ${res.status}`, res.status);
    } catch (err: unknown) {
      lastErr = err;
    }
    if (attempt < retries) await sleep(500);
  }

  if (lastErr instanceof HttpError) throw lastErr;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new HttpError(`opencode ${what} failed: ${msg}`, 503);
}

async function ocJson<T>(
  oc: OpencodeContext,
  path: string,
  init: RequestInit,
  options: { timeoutMs?: number; retries?: number; what?: string } = {},
): Promise<T> {
  const what = options.what ?? `${init.method ?? 'GET'} ${path}`;
  const res = await ocFetch(oc, path, init, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      `opencode ${what} returned HTTP ${res.status}${text ? `: ${text.substring(0, 300)}` : ''}`,
      res.status,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError(`opencode ${what} returned invalid JSON`, 502);
  }
}

async function ocSend(
  oc: OpencodeContext,
  path: string,
  init: RequestInit,
  options: { timeoutMs?: number; retries?: number; what?: string } = {},
): Promise<void> {
  const what = options.what ?? `${init.method ?? 'POST'} ${path}`;
  const res = await ocFetch(oc, path, init, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      `opencode ${what} returned HTTP ${res.status}${text ? `: ${text.substring(0, 300)}` : ''}`,
      res.status,
    );
  }
  // Drain the body so the connection can be reused; failures are irrelevant.
  await res.arrayBuffer().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function createSession(
  oc: OpencodeContext,
  model: string,
  variant: string | undefined,
): Promise<string> {
  const meta = oc.modelMeta.get(model);
  const ref: V2ModelRef = {
    id: meta?.modelID ?? model,
    providerID: meta?.providerID ?? 'opencode',
  };
  if (variant) ref.variant = variant;

  const body = JSON.stringify({ model: ref, permissions: ASK_ALL_PERMISSIONS });
  const data = await ocJson<V2SessionCreateResponse>(
    oc,
    '/api/session',
    { method: 'POST', body },
    { timeoutMs: Math.min(oc.timeout, 30_000), retries: 1, what: `session create for model ${model}` },
  );
  const id = data?.data?.id;
  if (!id) throw new HttpError('opencode session create returned no session id', 502);
  return id;
}

async function promptSession(
  oc: OpencodeContext,
  sessionID: string,
  text: string,
): Promise<void> {
  await ocSend(
    oc,
    `/api/session/${encodeURIComponent(sessionID)}/prompt`,
    { method: 'POST', body: JSON.stringify({ text }) },
    { timeoutMs: Math.min(oc.timeout, 30_000), retries: 0, what: 'session prompt' },
  );
}

async function deleteSession(oc: OpencodeContext, sessionID: string): Promise<void> {
  try {
    await ocSend(
      oc,
      `/api/session/${encodeURIComponent(sessionID)}`,
      { method: 'DELETE' },
      { timeoutMs: 10_000, retries: 0, what: 'session delete' },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`OPENCODE session cleanup failed id=${sessionID}: ${msg}`);
  }
}

async function pendingPermissions(
  oc: OpencodeContext,
  sessionID: string,
): Promise<V2PermissionRequest[]> {
  const data = await ocJson<V2PermissionListResponse>(
    oc,
    `/api/session/${encodeURIComponent(sessionID)}/permission`,
    { method: 'GET' },
    { timeoutMs: 10_000, retries: 1, what: 'session permission list' },
  );
  return data?.data ?? [];
}

/**
 * Reject every pending permission request for this session. The model is told
 * that server-side tools are disabled; no local tool is ever approved.
 */
async function rejectPendingPermissions(oc: OpencodeContext, sessionID: string): Promise<number> {
  const pending = await pendingPermissions(oc, sessionID);
  let rejected = 0;
  for (const request of pending) {
    try {
      await ocSend(
        oc,
        `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(request.id)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision: 'reject',
            message: 'Tool use is disabled on this endpoint; answer with text only.',
          }),
        },
        { timeoutMs: 10_000, retries: 0, what: 'permission reply' },
      );
      rejected++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`OPENCODE permission reject failed session=${sessionID} request=${request.id}: ${msg}`);
    }
  }
  return rejected;
}

function assistantOf(messages: Array<Record<string, unknown>>): V2AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as unknown as V2AssistantMessage;
    if (m && m.type === 'assistant') return m;
  }
  return undefined;
}

async function sessionAssistant(
  oc: OpencodeContext,
  sessionID: string,
): Promise<V2AssistantMessage | undefined> {
  const data = await ocJson<V2MessageListResponse>(
    oc,
    `/api/session/${encodeURIComponent(sessionID)}/message?order=asc&type=assistant`,
    { method: 'GET' },
    { timeoutMs: Math.min(oc.timeout, 30_000), retries: 1, what: 'session message list' },
  );
  return assistantOf(data?.data ?? []);
}

/**
 * Wait until the session's agent loop settles and return the final assistant
 * message. `POST .../wait` shortens the wait; the message poll is the source
 * of truth, so an early return can never race the answer. Pending tool
 * approvals are rejected while waiting.
 */
async function waitForAssistant(
  oc: OpencodeContext,
  sessionID: string,
): Promise<V2AssistantMessage> {
  const deadline = Date.now() + oc.timeout;
  try {
    await ocSend(
      oc,
      `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`,
      { method: 'POST' },
      { timeoutMs: oc.timeout, retries: 0, what: 'session wait' },
    );
  } catch (err: unknown) {
    // wait is an optimization; polling below observes the same state.
    const msg = err instanceof Error ? err.message : String(err);
    log(`OPENCODE session wait unavailable id=${sessionID}: ${msg}`);
  }

  let assistant: V2AssistantMessage | undefined;
  while (Date.now() < deadline) {
    try {
      await rejectPendingPermissions(oc, sessionID);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`OPENCODE permission sweep failed id=${sessionID}: ${msg}`);
    }
    assistant = await sessionAssistant(oc, sessionID);
    if (assistant && assistant.finish != null) return assistant;
    await sleep(300);
  }
  throw new HttpError(`opencode turn did not settle within ${oc.timeout}ms`, 504);
}

// ---------------------------------------------------------------------------
// Message parsing and prompt construction
// ---------------------------------------------------------------------------

export interface ParsedAssistant {
  text: string;
  reasoning: string;
  toolNames: string[];
  usage: Usage;
}

export function parseAssistantMessage(assistant: V2AssistantMessage): ParsedAssistant {
  let text = '';
  let reasoning = '';
  const toolNames: string[] = [];
  for (const part of assistant.content ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      reasoning += (reasoning ? '\n' : '') + part.text;
    } else if (part.type === 'tool') {
      if (part.name) toolNames.push(part.name);
    }
  }
  return { text, reasoning, toolNames, usage: usageFromTokens(assistant.tokens) };
}

/**
 * Canonical Chat Completions usage from an opencode v2 token bucket. opencode
 * reports `input` excluding prompt cache, so the OpenAI prompt_tokens — where
 * cached tokens are a subset — is input + cache.read + cache.write.
 */
export function usageFromTokens(tokens: TokenUsage | undefined): Usage {
  const input = tokens?.input || 0;
  const output = tokens?.output || 0;
  const reasoning = tokens?.reasoning || 0;
  const cacheRead = tokens?.cache?.read || 0;
  const cacheWrite = tokens?.cache?.write || 0;
  const prompt = input + cacheRead + cacheWrite;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
  };
  if (cacheRead > 0) usage.prompt_tokens_details = { cached_tokens: cacheRead };
  if (reasoning > 0) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

export function usageFromV2TokensResponses(tokens: TokenUsage | undefined): ResponsesUsage {
  const input = tokens?.input || 0;
  const output = tokens?.output || 0;
  const reasoning = tokens?.reasoning || 0;
  const cacheRead = tokens?.cache?.read || 0;
  const cacheWrite = tokens?.cache?.write || 0;
  const prompt = input + cacheRead + cacheWrite;
  return {
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: prompt + output + reasoning,
    input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        const t = (part as { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface PromptFile {
  uri: string;
}

export interface BuiltPrompt {
  text: string;
  files: PromptFile[];
}

/**
 * Flatten an OpenAI message list into one opencode v2 prompt. v2 takes a single
 * `text` input per turn, so the conversation travels as a transcript. Tool
 * history stays structured JSON (`function_call` / `tool_result`) exactly as
 * the clientTools contract asks the model to emit.
 */
export function buildPrompt(
  messages: ChatRequest['messages'],
  options: { system?: string; reminder?: string; feedback?: string } = {},
): BuiltPrompt {
  const files: PromptFile[] = [];
  const chunks: string[] = [];

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const toolCallId = (m as { tool_call_id?: string }).tool_call_id || '';
      chunks.push(JSON.stringify({ type: 'tool_result', callID: toolCallId, content: contentToText(m.content) }));
      continue;
    }

    if (m.role === 'assistant') {
      const toolCalls = (m as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          let input: unknown = tc.function.arguments;
          try {
            input = JSON.parse(tc.function.arguments || '{}');
          } catch {
            // Keep the raw argument string when the client sent non-JSON.
          }
          chunks.push(JSON.stringify({ type: 'function_call', id: tc.id, name: tc.function.name, arguments: input }));
        }
        continue;
      }
      const text = contentToText(m.content);
      if (text) chunks.push(text);
      continue;
    }

    // user
    if (typeof m.content === 'string') {
      if (m.content) chunks.push(m.content);
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as unknown as Record<string, unknown>;
        if (p['type'] === 'text' && typeof p['text'] === 'string') {
          textParts.push(p['text'] as string);
        } else if (p['type'] === 'image_url') {
          const url = (p['image_url'] as { url?: string } | undefined)?.url;
          if (url) files.push({ uri: url });
        }
      }
      if (textParts.length) chunks.push(textParts.join('\n'));
    }
  }

  const blocks: string[] = [];
  const system = options.system?.trim();
  if (system) blocks.push(`[System instructions: ${system}]`);
  const reminder = options.reminder?.trim();
  if (reminder) blocks.push(`[Output format: ${reminder}]`);
  blocks.push(chunks.join('\n\n'));
  if (options.feedback) {
    blocks.push(`Your previous reply was invalid: ${options.feedback} Reply with valid output only.`);
  }

  return { text: blocks.filter(block => block !== '').join('\n\n'), files };
}

function systemFromMessages(messages: ChatRequest['messages']): string {
  return (messages || [])
    .filter(m => m && m.role === 'system')
    .map(m => contentToText(m.content))
    .filter(Boolean)
    .join('\n');
}

function assertAssistantOk(assistant: V2AssistantMessage, model: string): void {
  if (!assistant.error) return;
  const status = assistant.error.status && assistant.error.status >= 400 && assistant.error.status < 600
    ? assistant.error.status
    : 502;
  throw new HttpError(
    `opencode provider error for model ${model} (${assistant.error.type || 'unknown'}): ${assistant.error.message || 'unknown error'}`,
    status,
  );
}

// ---------------------------------------------------------------------------
// Buffered turns
// ---------------------------------------------------------------------------

interface BufferedTurnOptions {
  variant: string | undefined;
  reminder?: string;
  feedback?: string;
}

async function runBufferedTurn(
  oc: OpencodeContext,
  model: string,
  messages: ChatRequest['messages'],
  options: BufferedTurnOptions,
): Promise<ParsedAssistant> {
  const system = systemFromMessages(messages);
  const prompt = buildPrompt(messages, {
    system,
    reminder: options.reminder,
    feedback: options.feedback,
  });
  const sessionID = await createSession(oc, model, options.variant);
  try {
    if (prompt.files.length > 0) {
      await ocSend(
        oc,
        `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        { method: 'POST', body: JSON.stringify({ text: prompt.text, files: prompt.files }) },
        { timeoutMs: Math.min(oc.timeout, 30_000), retries: 0, what: 'session prompt' },
      );
    } else {
      await promptSession(oc, sessionID, prompt.text);
    }
    const assistant = await waitForAssistant(oc, sessionID);
    assertAssistantOk(assistant, model);
    return parseAssistantMessage(assistant);
  } finally {
    await deleteSession(oc, sessionID);
  }
}

// ---------------------------------------------------------------------------
// Streaming turns
// ---------------------------------------------------------------------------

interface TurnStreamResult {
  rawText: string;
  reasoning: string;
  usage: Usage | undefined;
  toolNames: string[];
  roleEmitted: boolean;
  textEmitted: number;
}

async function* iterateEvents(
  oc: OpencodeContext,
  sessionID: string,
  abort: AbortController,
  onOpen?: () => Promise<void>,
): AsyncGenerator<V2Event, void, unknown> {
  const res = await ocFetch(
    oc,
    '/api/event',
    {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    },
    { timeoutMs: oc.timeout, retries: 2, what: 'event stream' },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(
      `opencode event stream returned HTTP ${res.status}${text ? `: ${text.substring(0, 300)}` : ''}`,
      res.status,
    );
  }
  const body = res.body;
  if (!body) throw new HttpError('opencode event stream body is null', 502);

  // The prompt must be sent only after the subscription is live, so no early
  // delta can be missed.
  if (onOpen) await onOpen();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw) continue;
        let event: V2Event;
        try {
          event = JSON.parse(raw) as V2Event;
        } catch {
          continue;
        }
        if (!event || typeof event.type !== 'string') continue;
        const evtSession = event.data?.['sessionID'];
        if (typeof evtSession === 'string' && evtSession !== sessionID) continue;
        yield event;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

/**
 * One streamed model round against a fresh session. Emits content/reasoning
 * deltas, rejects tool approvals, and returns the raw reply text plus usage.
 * A `tool-calls` finish is a terminal outcome of the round, surfaced through
 * `toolNames` and `rawText` so the caller can retry with feedback.
 */
async function* streamTurn(
  oc: OpencodeContext,
  model: string,
  messages: ChatRequest['messages'],
  opts: {
    variant: string | undefined;
    responseModel: string | undefined;
    reminder?: string;
    feedback?: string;
    systemOverride?: string;
    scanner?: DecisionStreamScanner;
    emitReasoning?: boolean;
    chunkId?: string;
    created?: number;
    roleEmittedInitially?: boolean;
  },
): AsyncGenerator<ChatCompletionChunk, TurnStreamResult, unknown> {
  const chunkId = opts.chunkId ?? `chatcmpl-${Date.now()}`;
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  let roleEmitted = opts.roleEmittedInitially ?? false;

  const makeChunk = (
    delta: Record<string, unknown>,
    finish: ChatCompletionChunk['choices'][number]['finish_reason'] = null,
  ): ChatCompletionChunk => ({
    id: chunkId,
    object: 'chat.completion.chunk',
    created,
    model: opts.responseModel ?? '',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const system = opts.systemOverride ?? systemFromMessages(messages);
  const prompt = buildPrompt(messages, {
    system,
    reminder: opts.reminder,
    feedback: opts.feedback,
  });

  const sessionID = await createSession(oc, model, opts.variant);
  const abort = new AbortController();
  const sendPrompt = async (): Promise<void> => {
    if (prompt.files.length > 0) {
      await ocSend(
        oc,
        `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        { method: 'POST', body: JSON.stringify({ text: prompt.text, files: prompt.files }) },
        { timeoutMs: Math.min(oc.timeout, 30_000), retries: 0, what: 'session prompt' },
      );
    } else {
      await promptSession(oc, sessionID, prompt.text);
    }
  };
  let usage: Usage | undefined;
  let rawText = '';
  let reasoningText = '';
  let textEmitted = 0;
  const toolNames: string[] = [];
  let settled = false;
  const scanner = opts.scanner;

  try {
    for await (const event of iterateEvents(oc, sessionID, abort, sendPrompt)) {
      const data = event.data ?? {};
      switch (event.type) {
        case 'permission.asked': {
          const requestID = data['id'];
          if (typeof requestID === 'string') {
            const requestSession = typeof data['sessionID'] === 'string' ? data['sessionID'] : sessionID;
            try {
              await ocSend(
                oc,
                `/api/session/${encodeURIComponent(requestSession)}/permission/${encodeURIComponent(requestID)}/reply`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    decision: 'reject',
                    message: 'Tool use is disabled on this endpoint; answer with text only.',
                  }),
                },
                { timeoutMs: 10_000, retries: 0, what: 'permission reply' },
              );
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`OPENCODE permission reject failed session=${sessionID} request=${requestID}: ${msg}`);
            }
          }
          break;
        }
        case 'session.text.delta': {
          const delta = data['delta'];
          if (typeof delta !== 'string' || !delta) break;
          if (scanner) {
            const decoded = scanner.push(delta);
            if (decoded) {
              yield roleEmitted ? makeChunk({ content: decoded }) : makeChunk({ role: 'assistant', content: decoded });
              roleEmitted = true;
              textEmitted += decoded.length;
            }
          } else {
            yield roleEmitted ? makeChunk({ content: delta }) : makeChunk({ role: 'assistant', content: delta });
            roleEmitted = true;
            textEmitted += delta.length;
          }
          break;
        }
        case 'session.reasoning.delta': {
          const delta = data['delta'];
          if (typeof delta !== 'string' || !delta) break;
          reasoningText += delta;
          if (opts.emitReasoning !== false) {
            yield roleEmitted
              ? makeChunk({ reasoning_content: delta })
              : makeChunk({ role: 'assistant', reasoning_content: delta });
            roleEmitted = true;
          }
          break;
        }
        case 'session.tool.called': {
          const name = data['name'] ?? data['tool'];
          if (typeof name === 'string' && name) toolNames.push(name);
          break;
        }
        case 'session.step.ended': {
          const tokens = data['tokens'] as TokenUsage | undefined;
          if (tokens) usage = usageFromTokens(tokens);
          settled = true;
          break;
        }
        case 'session.usage.updated': {
          const tokens = data['tokens'] as TokenUsage | undefined;
          if (tokens) usage = usageFromTokens(tokens);
          break;
        }
        case 'session.execution.failed': {
          const error = data['error'] as { type?: string; message?: string; status?: number } | undefined;
          const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 502;
          throw new HttpError(
            `opencode provider error for model ${model} (${error?.type || 'unknown'}): ${error?.message || 'execution failed'}`,
            status,
          );
        }
        case 'session.execution.succeeded':
        case 'session.execution.interrupted': {
          settled = true;
          break;
        }
        default:
          break;
      }

      if (scanner) rawText = scanner.rawText;
      if (settled) break;
    }
  } finally {
    abort.abort();
    await deleteSession(oc, sessionID);
  }

  if (scanner) rawText = scanner.rawText;
  return { rawText, reasoning: reasoningText, usage, toolNames, roleEmitted, textEmitted };
}

// ---------------------------------------------------------------------------
// Client-executed tools
// ---------------------------------------------------------------------------

interface ClientToolsDecisionResult {
  decision: ClientToolDecision;
  usage: Usage | undefined;
}

/**
 * Buffered clientTools round. The model is asked for a raw JSON decision; a
 * valid decision is returned, an invalid reply is retried with validation
 * feedback, and a prose answer is salvaged instead of failing the request.
 */
async function runClientToolsDecision(
  oc: OpencodeContext,
  model: string,
  system: string,
  messages: ChatRequest['messages'],
  tools: ChatRequest['tools'],
  choice: 'auto' | 'none' | 'required',
  variant: string | undefined,
): Promise<ClientToolsDecisionResult> {
  const defs = tools ?? [];
  const choiceFormat = {
    type: 'json_schema',
    json_schema: { name: 'tool_choice', strict: true, schema: choiceSchemaFor(defs, choice) },
  } as ResponseFormat;
  const choiceSystem = clientToolsSystem(system, defs);

  const MAX_CHOICE_ATTEMPTS = 3;
  let lastRaw = '';
  let usage: Usage | undefined;

  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt++) {
    const feedback = attempt > 0
      ? validateStructuredOutput(lastRaw, choiceFormat, { repair: attempt > 1 })
      : null;
    const feedbackText = feedback && !feedback.ok
      ? buildRetryFeedback(lastRaw, choiceFormat, feedback.errors, attempt - 1)
      : undefined;

    const parsed = await runBufferedTurnWithSystem(
      oc,
      model,
      messages,
      choiceSystem,
      variant,
      schemaReminder(choiceFormat),
      feedbackText,
    );
    lastRaw = parsed.text;
    usage = parsed.usage || usage;

    const decision = parseChoiceReply(lastRaw, defs, choice, { repair: attempt > 0 });
    if (decision) return { decision, usage };

    if (attempt < MAX_CHOICE_ATTEMPTS - 1) {
      const check = validateStructuredOutput(lastRaw, choiceFormat, { repair: attempt > 0 });
      log(
        `CLIENTTOOLS retry model=${model} attempt=${attempt + 1}/${MAX_CHOICE_ATTEMPTS} ` +
          `errors=${formatValidationErrors(check.errors)}`,
      );
    }
  }

  const salvaged = salvageAnswerText(lastRaw);
  if (salvaged.trim()) {
    log(`CLIENTTOOLS model=${model} decision=salvage chars=${salvaged.length}`);
    return { decision: { text: salvaged }, usage };
  }
  throw new HttpError(`opencode clientTools decision invalid for model ${model}`, 502);
}

/**
 * Buffered turn with an explicit system instruction override (clientTools).
 */
async function runBufferedTurnWithSystem(
  oc: OpencodeContext,
  model: string,
  messages: ChatRequest['messages'],
  system: string,
  variant: string | undefined,
  reminder: string | undefined,
  feedback: string | undefined,
): Promise<ParsedAssistant> {
  const prompt = buildPrompt(messages, { system, reminder, feedback });
  const sessionID = await createSession(oc, model, variant);
  try {
    if (prompt.files.length > 0) {
      await ocSend(
        oc,
        `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        { method: 'POST', body: JSON.stringify({ text: prompt.text, files: prompt.files }) },
        { timeoutMs: Math.min(oc.timeout, 30_000), retries: 0, what: 'session prompt' },
      );
    } else {
      await promptSession(oc, sessionID, prompt.text);
    }
    const assistant = await waitForAssistant(oc, sessionID);
    assertAssistantOk(assistant, model);
    return parseAssistantMessage(assistant);
  } finally {
    await deleteSession(oc, sessionID);
  }
}

/**
 * Streaming clientTools decision. The model still answers with raw JSON, but
 * the raw stream is scanned incrementally: once the top-level type is `text`,
 * the answer characters are decoded and streamed as they arrive. Function-call
 * decisions accumulate and surface as tool_calls on the final chunk.
 */
async function* streamClientToolsDecision(
  oc: OpencodeContext,
  model: string,
  system: string,
  messages: ChatRequest['messages'],
  tools: ChatRequest['tools'],
  choice: 'auto' | 'none' | 'required',
  responseModel: string | undefined,
  variant: string | undefined,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const defs = tools ?? [];
  const choiceFormat = {
    type: 'json_schema',
    json_schema: { name: 'tool_choice', strict: true, schema: choiceSchemaFor(defs, choice) },
  } as ResponseFormat;
  const choiceSystem = clientToolsSystem(system, defs);

  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;
  const makeChunk = (
    delta: Record<string, unknown>,
    finish: ChatCompletionChunk['choices'][number]['finish_reason'] = null,
  ): ChatCompletionChunk => ({
    id: chunkId,
    object: 'chat.completion.chunk',
    created,
    model: responseModel ?? '',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const emitContent = (text: string): ChatCompletionChunk =>
    makeChunk(roleEmitted ? { content: text } : { role: 'assistant', content: text });

  const MAX_STREAM_ATTEMPTS = 3;
  let decision: ClientToolDecision | null = null;
  let usage: Usage | undefined;
  let decoded = '';
  let raw = '';
  let feedback = '';
  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    const scanner = new DecisionStreamScanner();
    const round: TurnStreamResult = yield* streamTurn(oc, model, messages, {
      variant,
      responseModel,
      reminder: schemaReminder(choiceFormat),
      feedback: feedback || undefined,
      systemOverride: choiceSystem,
      scanner,
      emitReasoning: attempt === 0,
      chunkId,
      created,
      roleEmittedInitially: roleEmitted,
    });
    roleEmitted = round.roleEmitted;
    usage = round.usage || usage;
    raw = round.rawText;
    decoded = scanner.decoded;
    decision = parseChoiceReply(raw, defs, choice, { repair: attempt > 0 });
    if (decision) {
      if (attempt > 0) log(`CLIENTTOOLS stream model=${model} decision=valid attempt=${attempt + 1}`);
      break;
    }
    const salvaged = salvageAnswerText(raw, decoded);
    if (salvaged.trim()) {
      decision = { text: salvaged };
      log(`CLIENTTOOLS stream model=${model} decision=salvage chars=${salvaged.length} attempt=${attempt + 1}`);
      break;
    }
    const check = validateStructuredOutput(raw, choiceFormat, { repair: attempt > 0 });
    feedback = buildRetryFeedback(raw, choiceFormat, check.errors, attempt);
    if (attempt < MAX_STREAM_ATTEMPTS - 1) {
      log(
        `CLIENTTOOLS stream retry model=${model} attempt=${attempt + 1}/${MAX_STREAM_ATTEMPTS} ` +
          `errors=${formatValidationErrors(check.errors)}`,
      );
    }
  }
  if (!decision) {
    throw new HttpError(`opencode clientTools decision invalid for model ${model}: ${feedback}`, 502);
  }

  if ('text' in decision) {
    // The scanner already streamed the decoded prefix; a layout the scanner
    // could not follow emits the remainder as one final delta.
    const remaining = decision.text.slice(decoded.length);
    log(`CLIENTTOOLS stream model=${model} decision=text chars=${decision.text.length} streamed=${decoded.length}`);
    if (remaining) {
      yield emitContent(remaining);
      roleEmitted = true;
    }
    const final = makeChunk({}, 'stop');
    final.usage = usage;
    yield final;
    return;
  }

  log(`CLIENTTOOLS stream model=${model} decision=function_call calls=${decision.calls.length}`);
  const calls = toToolCalls(decision.calls);
  const toolDelta = {
    tool_calls: calls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function' as const,
      function: call.function,
    })),
  };
  yield roleEmitted
    ? makeChunk(toolDelta)
    : makeChunk({ role: 'assistant', ...toolDelta });
  const final = makeChunk({}, 'tool_calls');
  final.usage = usage;
  yield final;
}

// ---------------------------------------------------------------------------
// Exported backend interface
// ---------------------------------------------------------------------------

export async function init(backendConfig: OpencodeBackendConfig): Promise<OpencodeContext> {
  const baseUrl = backendConfig.baseUrl || DEFAULT_BASE_URL;
  const serverPassword = backendConfig.serverPassword || '';
  const serverUsername = backendConfig.serverUsername || 'opencode';
  const auth = basicAuthHeader(serverUsername, serverPassword);
  const timeout = backendConfig.timeout || 300_000;

  const dispatcher = await createProxyAgent(backendConfig.proxy);

  const models: string[] = [];
  const modelMeta = new Map<string, OpencodeModelMeta>();
  const ctx: OpencodeContext = { baseUrl, auth, models, serverPassword, serverUsername, dispatcher, timeout, modelMeta };

  if (backendConfig.models) {
    models.push(...backendConfig.models);
  } else {
    let list: V2ModelInfo[];
    try {
      const data = await ocJson<V2ModelListResponse>(
        ctx,
        '/api/model',
        { method: 'GET' },
        { timeoutMs: Math.min(timeout, 30_000), retries: 2, what: 'model list' },
      );
      list = Array.isArray(data?.data) ? data.data : [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(`opencode model discovery failed at ${baseUrl}/api/model: ${msg}`, 503);
    }
    for (const meta of list) {
      if (!providerMatches(meta.providerID)) continue;
      if (meta.enabled === false) continue;
      if (!meta.id) continue;
      models.push(meta.id);
      modelMeta.set(meta.id, metaFor(meta));
    }
    if (models.length === 0) {
      log(`OPENCODE model list is empty (provider filter opencode/opencode/*) at ${baseUrl}`);
    } else {
      log(`OPENCODE discovered ${models.length} models at ${baseUrl}`);
    }
  }

  return ctx;
}

export function listModels(_backendConfig: OpencodeBackendConfig, ctx: BaseBackendContext | null): ModelInfo[] {
  if (!ctx) return [];
  const meta = ctx as Partial<OpencodeContext>;
  const models = ctx.models || [];
  return models.map(id => {
    const modelMeta = meta.modelMeta?.get(id);
    const info: ModelInfo = {
      id: `opencode/${id}`,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'opencode',
    };
    if (modelMeta) {
      info.capabilities = modelMeta.capabilities;
      info.reasoning = modelMeta.reasoning;
    }
    return info;
  });
}

export async function complete(
  backendConfig: OpencodeBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): Promise<ChatCompletionResponse> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  const { messages, model, response_format, tools, tool_choice, reasoningEffort } = request;
  const variant = resolveVariant(oc, model, reasoningEffort);

  const system = systemFromMessages(messages);
  const needsStructured = !!response_format && response_format.type !== 'text';
  const reminder = needsStructured ? schemaReminder(response_format) : undefined;

  // Local serve tools are never offered. Client tools travel through the
  // clientTools decision contract below; when it is not enabled the request is
  // rejected instead of silently falling back to local tools.
  const hasTools = !!tools && tools.length > 0;
  if (hasTools && !backendConfig.clientTools) {
    throw new HttpError(`opencode backend: tools require clientTools:true for model ${model}`, 400);
  }

  if (hasTools && tools) {
    const choice = normalizeToolChoice(tool_choice);
    const { decision, usage } = await runClientToolsDecision(
      oc, model, system, messages, tools, choice, variant,
    );
    const base = {
      id: `chat-${Date.now()}`,
      object: 'chat.completion' as const,
      created: Math.floor(Date.now() / 1000),
      model: '',
    };
    if ('text' in decision) {
      return {
        ...base,
        choices: [{ index: 0, logprobs: null, message: { role: 'assistant', content: decision.text, refusal: null }, finish_reason: 'stop' }],
        usage,
      };
    }
    const clientCalls: ToolCall[] = toToolCalls(decision.calls);
    return {
      ...base,
      choices: [{ index: 0, logprobs: null, message: { role: 'assistant', content: null, refusal: null, tool_calls: clientCalls }, finish_reason: 'tool_calls' }],
      usage,
    };
  }

  let parsed = await runBufferedTurn(oc, model, messages, { variant, reminder });
  let content = parsed.text;
  let usage = parsed.usage;

  // Server-side tool attempts are rejected; ask the model for a text answer
  // once before giving up on the turn. The v2 agent advertises its own tools,
  // so a stray native call must not fail an otherwise valid chat request.
  if (!content.trim() && parsed.toolNames.length > 0) {
    log(`OPENCODE tool attempt model=${model} tools=${parsed.toolNames.join(',')}; retrying with text-only feedback`);
    parsed = await runBufferedTurn(oc, model, messages, {
      variant,
      reminder,
      feedback: 'Server-side tool use is disabled on this endpoint. Do not call tools; answer with text only.',
    });
    content = parsed.text;
    usage = parsed.usage || usage;
    if (!content.trim() && parsed.toolNames.length > 0) {
      throw new HttpError(
        `opencode model ${model} attempted server-side tool use (${parsed.toolNames.join(', ')}); local tools are disabled`,
        502,
      );
    }
  }

  // Structured output: validate locally, retry up to 3 times with escalating
  // feedback (errors → +key diff → +schema excerpts). The v2 prompt API does
  // not carry response_format, so the guarantee is entirely local.
  if (needsStructured && response_format) {
    const MAX_STRUCT_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_STRUCT_ATTEMPTS; attempt++) {
      const check = validateStructuredOutput(content, response_format, { repair: attempt > 0 });
      if (check.ok) break;
      const feedback = buildRetryFeedback(content, response_format, check.errors, attempt);
      log(`STRUCT retry model=${model} attempt=${attempt + 1}/${MAX_STRUCT_ATTEMPTS} errors=${formatValidationErrors(check.errors)}`);
      parsed = await runBufferedTurn(oc, model, messages, { variant, reminder, feedback });
      content = parsed.text;
      usage = parsed.usage || usage;
      if (attempt === MAX_STRUCT_ATTEMPTS - 1) {
        const final = validateStructuredOutput(content, response_format, { repair: true });
        if (!final.ok) {
          throw new HttpError(
            `opencode structured output validation failed for model ${model}: ${formatValidationErrors(final.errors)}`,
            502,
          );
        }
      }
    }
  }

  // Chain-of-thought never travels in `content`: the canonical field is
  // `reasoning_content` (DeepSeek-compatible), with `reasoning` kept as the
  // OpenRouter-compatible alias. `content` carries the answer only.
  const message: ChatCompletionMessage = { role: 'assistant', content, refusal: null };
  if (parsed.reasoning) {
    (message as { reasoning_content?: string }).reasoning_content = parsed.reasoning;
    (message as { reasoning?: string }).reasoning = parsed.reasoning;
  }

  return {
    id: `chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{
      index: 0,
      logprobs: null,
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

function normalizeToolChoice(choice: ChatRequest['tool_choice']): 'auto' | 'none' | 'required' {
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  return 'auto';
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

function buildResponsesMessages(input: unknown): ChatRequest['messages'] {
  const messages: ChatRequest['messages'] = [];
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: '' });
    return messages;
  }
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as ResponsesInputItem;
    if (obj.type === 'message' || obj.type === 'easy_input_message') {
      const role = obj.role || 'user';
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
      const roleName = role === 'system' || role === 'developer' ? 'system' : role;
      if (roleName === 'assistant') {
        messages.push({ role: 'assistant', content: text });
      } else if (roleName === 'system') {
        messages.push({ role: 'system', content: text });
      } else {
        messages.push({ role: 'user', content: text });
      }
    } else if (obj.type === 'input_text') {
      messages.push({ role: 'user', content: String(obj.text ?? '') });
    } else if (obj.type === 'input_image') {
      const url = obj.image_url?.url ?? '';
      messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] });
    } else if (obj.type === 'function_call') {
      const fc = item as { name?: string; arguments?: string; call_id?: string; id?: string };
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: fc.call_id || fc.id || uid('call'),
          type: 'function',
          function: { name: fc.name || '', arguments: fc.arguments || '{}' },
        }],
      });
    } else if (obj.type === 'function_call_output') {
      const fco = item as { call_id?: string; output?: string };
      messages.push({ role: 'tool', tool_call_id: fco.call_id || '', content: fco.output ?? '' });
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: '' });
  return messages;
}

export async function responses(
  _backendConfig: OpencodeBackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
): Promise<ResponseObject> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  const { model, text, tools, instructions } = request;
  const response_format = text?.format;
  const variant = resolveVariant(oc, model || '', request.reasoning_effort);
  const messages = buildResponsesMessages(request.input);
  if (instructions) messages.unshift({ role: 'system', content: instructions });

  const needsStructured = !!response_format && response_format.type !== 'text';
  const reminder = needsStructured ? schemaReminder(response_format) : undefined;

  // The Responses API has no clientTools decision path, so tool requests are
  // rejected instead of silently falling back to local tools.
  if (tools && tools.length > 0) {
    throw new HttpError('opencode backend: tools are not supported on the Responses API', 400);
  }

  let parsed = await runBufferedTurn(oc, model || '', messages, { variant, reminder });
  let content = parsed.text;
  let usage = parsed.usage;

  if (!content.trim() && parsed.toolNames.length > 0) {
    log(`OPENCODE responses tool attempt model=${model} tools=${parsed.toolNames.join(',')}; retrying with text-only feedback`);
    parsed = await runBufferedTurn(oc, model || '', messages, {
      variant,
      reminder,
      feedback: 'Server-side tool use is disabled on this endpoint. Do not call tools; answer with text only.',
    });
    content = parsed.text;
    usage = parsed.usage || usage;
    if (!content.trim() && parsed.toolNames.length > 0) {
      throw new HttpError(
        `opencode model ${model} attempted server-side tool use (${parsed.toolNames.join(', ')}); local tools are disabled`,
        502,
      );
    }
  }

  if (needsStructured && response_format) {
    const MAX_STRUCT_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_STRUCT_ATTEMPTS; attempt++) {
      const check = validateStructuredOutput(content, response_format, { repair: attempt > 0 });
      if (check.ok) break;
      const feedback = buildRetryFeedback(content, response_format, check.errors, attempt);
      log(`STRUCT retry model=${model} path=responses attempt=${attempt + 1}/${MAX_STRUCT_ATTEMPTS} errors=${formatValidationErrors(check.errors)}`);
      parsed = await runBufferedTurn(oc, model || '', messages, { variant, reminder, feedback });
      content = parsed.text;
      usage = parsed.usage || usage;
      if (attempt === MAX_STRUCT_ATTEMPTS - 1) {
        const final = validateStructuredOutput(content, response_format, { repair: true });
        if (!final.ok) {
          throw new HttpError(
            `opencode structured output validation failed for model ${model}: ${formatValidationErrors(final.errors)}`,
            502,
          );
        }
      }
    }
  }

  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput | ResponsesFunctionCallOutput> = [];
  if (parsed.reasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: parsed.reasoning }],
    });
  }
  output.push({
    id: uid('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text: content }],
  });

  const responsesUsage: ResponsesUsage = usageFromV2TokensResponses({
    input: usage?.prompt_tokens,
    output: usage?.completion_tokens,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens,
  });

  return {
    id: uid('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: model || '',
    output,
    output_text: content,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage: responsesUsage,
  };
}

export async function* responsesStreaming(
  _backendConfig: OpencodeBackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ResponseStreamEvent, void, unknown> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;

  const { model, text, tools, instructions } = request;
  const response_format = text?.format;
  const variant = resolveVariant(oc, model || '', request.reasoning_effort);
  const messages = buildResponsesMessages(request.input);
  if (instructions) messages.unshift({ role: 'system', content: instructions });

  // Streaming cannot retry mid-stream, so structured validation stays a
  // client-side concern; the schema reminder still travels in the prompt.
  const reminder = response_format && response_format.type !== 'text'
    ? schemaReminder(response_format)
    : undefined;

  // The Responses API has no clientTools decision path, so tool requests are
  // rejected instead of silently falling back to local tools.
  if (tools && tools.length > 0) {
    throw new HttpError('opencode backend: tools are not supported on the Responses API', 400);
  }

  const responseId = uid('resp');
  const created = Math.floor(Date.now() / 1000);
  const outputIndex = 0;
  let textBuffer = '';
  let textOutputItemId: string | null = null;
  let textPartOpened = false;
  let reasoningBuffer = '';
  let reasoningPartOpened = false;
  let messageItemAdded = false;

  let seq = 0;
  const nextSeq = () => seq++;

  yield {
    type: 'response.created',
    sequence_number: nextSeq(),
    response: {
      id: responseId,
      object: 'response',
      created_at: created,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: model || '',
      output: [],
      output_text: '',
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  };

  const rounds = streamTurn(oc, model || '', messages, {
    variant,
    responseModel: model,
    reminder,
  });
  let next: IteratorResult<ChatCompletionChunk, TurnStreamResult>;
  while (!(next = await rounds.next()).done) {
    const delta = (next.value.choices?.[0]?.delta ?? {}) as {
      content?: string;
      reasoning_content?: string;
    };

    if (delta.reasoning_content) {
      if (!messageItemAdded) {
        messageItemAdded = true;
        textOutputItemId = uid('msg');
        yield { type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex, item: { id: textOutputItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } };
      }
      if (!reasoningPartOpened) {
        reasoningPartOpened = true;
        yield { type: 'response.content_part.added', sequence_number: nextSeq(), output_index: outputIndex, item_id: textOutputItemId!, content_index: 0, part: { type: 'reasoning_text', text: '' } };
      }
      reasoningBuffer += delta.reasoning_content;
      yield { type: 'response.reasoning_text.delta', sequence_number: nextSeq(), delta: delta.reasoning_content, item_id: textOutputItemId!, output_index: outputIndex, content_index: 0 };
    }

    if (delta.content) {
      if (!messageItemAdded) {
        messageItemAdded = true;
        textOutputItemId = uid('msg');
        yield { type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex, item: { id: textOutputItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } };
      }
      if (!textPartOpened) {
        textPartOpened = true;
        const textIdx = reasoningPartOpened ? 1 : 0;
        yield { type: 'response.content_part.added', sequence_number: nextSeq(), output_index: outputIndex, item_id: textOutputItemId!, content_index: textIdx, part: { type: 'output_text', annotations: [], text: '' } };
      }
      textBuffer += delta.content;
      const textIdx = reasoningPartOpened ? 1 : 0;
      yield { type: 'response.output_text.delta', sequence_number: nextSeq(), delta: delta.content, item_id: textOutputItemId!, output_index: outputIndex, content_index: textIdx, logprobs: [] };
    }
  }

  const usage: Usage | undefined = next.value.usage;

  if (messageItemAdded && textOutputItemId) {
    if (reasoningPartOpened) {
      yield { type: 'response.reasoning_text.done', sequence_number: nextSeq(), text: reasoningBuffer, item_id: textOutputItemId, output_index: outputIndex, content_index: 0 };
      yield { type: 'response.content_part.done', sequence_number: nextSeq(), output_index: outputIndex, item_id: textOutputItemId, content_index: 0, part: { type: 'reasoning_text', text: reasoningBuffer } };
    }
    if (textPartOpened) {
      const textIdx = reasoningPartOpened ? 1 : 0;
      yield { type: 'response.output_text.done', sequence_number: nextSeq(), text: textBuffer, item_id: textOutputItemId, output_index: outputIndex, content_index: textIdx, logprobs: [] };
      yield { type: 'response.content_part.done', sequence_number: nextSeq(), output_index: outputIndex, item_id: textOutputItemId, content_index: textIdx, part: { type: 'output_text', annotations: [], text: textBuffer } };
    }
    const content: Array<{ type: 'output_text'; annotations: []; text: string }> = [];
    if (textPartOpened) content.push({ type: 'output_text', annotations: [], text: textBuffer });
    yield { type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex, item: { id: textOutputItemId, type: 'message', status: 'completed', role: 'assistant', content } };
  }

  const responsesUsage: ResponsesUsage = usageFromV2TokensResponses({
    input: usage?.prompt_tokens,
    output: usage?.completion_tokens,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens,
  });

  yield {
    type: 'response.completed',
    sequence_number: nextSeq(),
    response: {
      id: responseId,
      object: 'response',
      created_at: created,
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: model || '',
      output: [],
      output_text: textBuffer,
      parallel_tool_calls: true,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      usage: responsesUsage,
    },
  };
}
export async function* completeStreaming(
  backendConfig: OpencodeBackendConfig,
  request: ChatRequest,
  ctx: BaseBackendContext | null,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  if (!ctx || !('auth' in ctx)) throw new Error('opencode backend not initialized (server unreachable)');
  const oc = ctx as OpencodeContext;
  if (!backendConfig.streaming) return;

  const { messages, model, response_format, tools, tool_choice, reasoningEffort } = request;
  const variant = resolveVariant(oc, model, reasoningEffort);

  const system = systemFromMessages(messages);
  const needsStructured = !!response_format && response_format.type !== 'text';
  const reminder = needsStructured ? schemaReminder(response_format) : undefined;

  // Local serve tools are never offered. Client tools run the streaming
  // decision contract: the model answers with raw JSON, a function_call
  // decision surfaces as tool_calls, and a text decision streams the final
  // answer token by token. Exactly one successful model call per round.
  const streamHasTools = !!tools && tools.length > 0;
  if (streamHasTools && !backendConfig.clientTools) {
    throw new HttpError(`opencode backend: tools require clientTools:true for model ${model}`, 400);
  }
  if (streamHasTools && tools) {
    const choice = normalizeToolChoice(tool_choice);
    yield* streamClientToolsDecision(oc, model, system, messages, tools, choice, request.model, variant);
    return;
  }

  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let usage: Usage | undefined;
  let roleEmitted = false;
  let toolNames: string[] = [];

  const round = yield* streamTurn(oc, model, messages, {
    variant,
    responseModel: request.model,
    reminder,
    chunkId,
    created,
  });
  usage = round.usage;
  roleEmitted = round.roleEmitted;
  toolNames = round.toolNames;

  // A finish with no text and server-side tool attempts means the model tried
  // to use a local tool. Ask once for a text-only answer, then emit the
  // terminal chunk so the client always sees a finish.
  if (round.textEmitted === 0 && toolNames.length > 0) {
    log(`OPENCODE stream tool attempt model=${model} tools=${toolNames.join(',')}; retrying with text-only feedback`);
    const retry = yield* streamTurn(oc, model, messages, {
      variant,
      responseModel: request.model,
      reminder,
      feedback: 'Server-side tool use is disabled on this endpoint. Do not call tools; answer with text only.',
      chunkId,
      created,
      roleEmittedInitially: roleEmitted,
    });
    usage = retry.usage || usage;
    roleEmitted = retry.roleEmitted;
    if (retry.textEmitted === 0 && retry.toolNames.length > 0) {
      throw new HttpError(
        `opencode model ${model} attempted server-side tool use (${retry.toolNames.join(', ')}); local tools are disabled`,
        502,
      );
    }
  }

  const final = {
    id: chunkId,
    object: 'chat.completion.chunk' as const,
    created,
    model: request.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
    ...(usage ? { usage } : {}),
  };
  yield final;
}
