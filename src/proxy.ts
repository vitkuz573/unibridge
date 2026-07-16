#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, watchConfig, onConfigChange } from './config.js';
import type { UnibridgeConfig, BackendConfig } from './config.js';
import * as registry from './backends/registry.js';
import type { RegisteredBackend } from './backends/registry.js';
import * as opencodeBackend from './backends/opencode.js';
import * as kilocodeBackend from './backends/kilocode.js';
import * as mimocodeBackend from './backends/mimocode.js';
import * as openaiBackend from './backends/openai.js';
import { createRateLimiter } from './rate-limiter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import * as metrics from './metrics.js';
import type {
  Message,
  ChatRequest,
  ChatCompletionResponse,
  Usage,
  ResponseObject,
  ResponsesReasoningOutput,
  ResponsesMessageOutput,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Route {
  backend: RegisteredBackend;
  model: string;
  backendConfig: BackendConfig;
}

interface ResponseCacheEntry {
  value: ChatCompletionResponse | ResponseObject | Record<string, unknown>;
  ts: number;
}

type RateLimitFn = (ip: string) => number;

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

const responseCache = new Map<string, ResponseCacheEntry>();
let CACHE_TTL = 60_000;

function cacheKey(backend: string, model: string, messages: Message[], maxTokens: number | undefined): string {
  return `${backend}:${model}:${JSON.stringify(messages)}:${maxTokens || ''}`;
}

function cacheGet(key: string): ChatCompletionResponse | ResponseObject | Record<string, unknown> | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: ChatCompletionResponse | ResponseObject | Record<string, unknown>): void {
  responseCache.set(key, { value, ts: Date.now() });
}

function cacheCleanup(): void {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (now - entry.ts > CACHE_TTL) responseCache.delete(key);
  }
}

let cacheCleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCacheCleanup(): void {
  if (cacheCleanupInterval) return;
  cacheCleanupInterval = setInterval(cacheCleanup, Math.max(CACHE_TTL, 10_000));
  cacheCleanupInterval.unref();
}

function stopCacheCleanup(): void {
  if (cacheCleanupInterval) { clearInterval(cacheCleanupInterval); cacheCleanupInterval = null; }
}

function log(...args: unknown[]): void {
  const entry = [new Date().toISOString(), ...args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  )].join(' ');
  try { fs.appendFileSync(config.logFile, entry + '\n'); } catch {}
}

process.on('unhandledRejection', (e: unknown) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  log('UNHANDLED REJECTION:', msg);
});

process.on('uncaughtException', (e: unknown) => {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  log('UNCAUGHT EXCEPTION:', msg);
});

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function responsesInputToMessages(input: unknown): Message[] {
  if (!input) return [{ role: 'user', content: '' }];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: '' }];
  const messages: Message[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj['type'] === 'message' || obj['type'] === 'easy_input_message') {
      const role = (typeof obj['role'] === 'string' ? obj['role'] : 'user') as Message['role'];
      let content = '';
      if (Array.isArray(obj['content'])) {
        content = obj['content'].map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (!c || typeof c !== 'object') return '';
          const cc = c as Record<string, unknown>;
          if (cc['type'] === 'input_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'output_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'text') return String(cc['text'] ?? '');
          return '';
        }).join('\n');
      } else if (typeof obj['content'] === 'string') {
        content = obj['content'];
      }
      messages.push({ role, content });
    } else if (obj['type'] === 'input_text') {
      messages.push({ role: 'user', content: String((obj as Record<string, unknown>)['text'] ?? '') });
    } else if (obj['type'] === 'input_image') {
      messages.push({ role: 'user', content: '[image]' });
    }
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

function writeSSE(res: http.ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function ccUsageToResponses(usage: Usage | undefined): Usage {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

function buildResponseObject(model: string, text: string, usage: Usage | undefined, _reqModel: string, reasoning: string): ResponseObject {
  const rUsage = ccUsageToResponses(usage);
  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput> = [];
  if (reasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  output.push({
    id: uid('msg'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });
  return {
    id: uid('resp'),
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model,
    output,
    usage: rUsage,
  };
}

async function streamResponseSSE(res: http.ServerResponse, respObj: ResponseObject, text: string, reasoning: string): Promise<void> {
  const id = respObj.id;
  const msgItem = respObj.output.find(o => o.type === 'message') as ResponsesMessageOutput | undefined;
  const msgId = msgItem?.id || uid('msg');

  writeSSE(res, { type: 'response.created', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });
  writeSSE(res, { type: 'response.in_progress', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });

  let outputIndex = 0;

  if (reasoning) {
    const rid = uid('reas');
    writeSSE(res, {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] },
    });
    writeSSE(res, { type: 'response.reasoning_summary_part.added', summary_index: 0 });
    const RCHUNK = 20;
    for (let i = 0; i < reasoning.length; i += RCHUNK) {
      writeSSE(res, {
        type: 'response.reasoning_summary_text.delta',
        delta: reasoning.slice(i, i + RCHUNK),
        summary_index: 0,
      });
      await new Promise(r => setTimeout(r, 15));
    }
    writeSSE(res, {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] },
    });
    outputIndex++;
  }

  writeSSE(res, {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { id: msgId, type: 'message', role: 'assistant', content: [] },
  });
  writeSSE(res, {
    type: 'response.content_part.added',
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  const CHUNK = 5;
  for (let i = 0; i < text.length; i += CHUNK) {
    writeSSE(res, {
      type: 'response.output_text.delta',
      delta: text.slice(i, i + CHUNK),
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
    });
    await new Promise(r => setTimeout(r, 30));
  }

  writeSSE(res, {
    type: 'response.output_text.done',
    text,
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
  });
  writeSSE(res, {
    type: 'response.content_part.done',
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text },
  });
  writeSSE(res, {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
  writeSSE(res, { type: 'response.completed', response: respObj });
}

function writeSSEChunk(res: http.ServerResponse, id: string, created: number, model: string, delta: Record<string, unknown>, finish: string | null, usage?: Usage): void {
  const chunk: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finish || null,
    }],
  };
  if (usage) chunk['usage'] = usage;
  writeSSE(res, chunk);
}

// ---------------------------------------------------------------------------
// Register backends
// ---------------------------------------------------------------------------

registry.register(opencodeBackend);
registry.register(kilocodeBackend);
registry.register(mimocodeBackend);
registry.register(openaiBackend);
try { await registry.initAll(); } catch (e: unknown) {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  log('INIT ERR', msg);
}

log(`Backends: ${registry.listBackends().join(', ')}`);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer | string) => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: { message } });
}

function verboseLog(label: string, body: string, statusCode: number): void {
  if (!config.verbose) return;
  const truncated = body.length > 500 ? body.slice(0, 500) + '…' : body;
  log(`VERBOSE ${label} status=${statusCode} body=${truncated}`);
}

async function routeModel(reqModel: string): Promise<Route> {
  const route = await registry.route(reqModel);
  if (!route) {
    throw Object.assign(new Error('Model not found'), { status: 400 });
  }
  return route;
}

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

let rateLimiter = createRateLimiter(config.rateLimit);
const backendRateLimiters = new Map<string, RateLimitFn>();

function buildBackendRateLimiters(cfg: UnibridgeConfig): void {
  backendRateLimiters.clear();
  for (const [name, beCfg] of Object.entries(cfg.backends || {})) {
    if (beCfg?.rateLimit) {
      backendRateLimiters.set(name, createRateLimiter(beCfg.rateLimit));
    }
  }
}

buildBackendRateLimiters(config);

onConfigChange((cfg: UnibridgeConfig) => {
  rateLimiter = createRateLimiter(cfg.rateLimit);
  buildBackendRateLimiters(cfg);
  const cacheCfg = cfg.cache || { enabled: false, ttl: 60 };
  CACHE_TTL = (cacheCfg.ttl || 60) * 1000;
  if (cacheCfg.enabled) startCacheCleanup(); else { stopCacheCleanup(); responseCache.clear(); }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleChatCompletions(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel, temperature, stream } = parsed as {
    messages: unknown[];
    max_tokens: number | undefined;
    max_completion_tokens: number | undefined;
    response_format: unknown;
    model: string;
    temperature: number | undefined;
    stream: boolean | undefined;
  };

  if (messages == null) {
    return sendError(res, 400, 'messages is required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, 'messages must not be empty');
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      return sendError(res, 400, 'each message must have role and content');
    }
    const m = msg as Record<string, unknown>;
    if (!m['role'] || m['content'] == null) {
      return sendError(res, 400, 'each message must have role and content');
    }
  }

  log(`REQ len=${body.length} msgs=${messages.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const beLimiter = backendRateLimiters.get(route.backend.name);
  if (beLimiter) {
    const ip = res.socket?.remoteAddress || 'unknown';
    const retryAfter = beLimiter(`${ip}:${route.backend.name}`);
    if (retryAfter > 0) {
      res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
      res.end(JSON.stringify({ error: { message: `Rate limit exceeded for backend ${route.backend.name}` } }));
      metrics.inc('unibridge_errors_total', { status: '429' });
      return;
    }
  }

  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }

  const request: ChatRequest = {
    messages: messages as Message[],
    model: route.model,
    maxTokens: (max_completion_tokens || max_tokens || 0) as number,
    response_format: response_format as ChatRequest['response_format'],
    temperature: temperature as number | undefined,
    tools: (parsed as Record<string, unknown>)['tools'] as ChatRequest['tools'],
    tool_choice: (parsed as Record<string, unknown>)['tool_choice'] as ChatRequest['tool_choice'],
  };

  const startTime = Date.now();

  const streamOptions = (parsed as Record<string, unknown>)['stream_options'] as { include_usage?: boolean } | undefined;
  const includeUsage = !!streamOptions?.include_usage;

  if (stream && route.backend.completeStreaming && (route.backendConfig as Record<string, unknown>)['streaming']) {
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let chunkCount = 0;
    let lastUsage: Usage | undefined;
    try {
      for await (const chunk of route.backend.completeStreaming(route.backendConfig, request, route.backend.ctx)) {
        chunk.model = reqModel;
        if (chunk.usage) lastUsage = chunk.usage;
        writeSSE(res, chunk as unknown as Record<string, unknown>);
        chunkCount++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      log('STREAM ERR', msg);
      res.end();
      throw e;
    }
    if (includeUsage) {
      const usageChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: reqModel,
        choices: [],
        usage: lastUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      writeSSE(res, usageChunk);
    }
    res.write('data: [DONE]\n\n');
    res.end();

    const elapsed = Date.now() - startTime;
    metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
    metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
    log(`OK stream backend=${route.backend.name} elapsed_ms=${elapsed} chunks=${chunkCount}`);
    return;
  }

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, messages as Message[], request.maxTokens) : null;
  if (cacheEnabled && cKey) {
    const cached = cacheGet(cKey);
    if (cached) {
      (cached as ChatCompletionResponse).model = reqModel;
      sendJSON(res, 200, cached as Record<string, unknown>);
      verboseLog('chat/completions', body, 200);
      return;
    }
  }

  const response = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const msg = response?.choices?.[0]?.message || { role: 'assistant' as const, content: '' };
  const text = msg.content || '';
  const reasoningText = msg.reasoning || '';
  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${response.usage?.total_tokens || '?'} chars=${text.length} stream=${!!stream}`);

  if (cacheEnabled && !stream && response?.choices && cKey) {
    const toCache = { ...response, model: reqModel };
    cacheSet(cKey, toCache);
  }

  if (stream) {
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.socket?.setNoDelay();

    writeSSEChunk(res, id, created, reqModel, { role: 'assistant', content: '' }, null);

    if (reasoningText) {
      const RCHUNK = 20;
      for (let i = 0; i < reasoningText.length; i += RCHUNK) {
        writeSSEChunk(res, id, created, reqModel, { reasoning_content: reasoningText.slice(i, i + RCHUNK) }, null);
        await new Promise(r => setTimeout(r, 15));
      }
    }

    const CHUNK = 5;
    for (let i = 0; i < text.length; i += CHUNK) {
      writeSSEChunk(res, id, created, reqModel, { content: text.slice(i, i + CHUNK) }, null);
      await new Promise(r => setTimeout(r, 30));
    }

    writeSSEChunk(res, id, created, reqModel, {}, 'stop');
    if (includeUsage) {
      const usageChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: reqModel,
        choices: [],
        usage: response?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      writeSSE(res, usageChunk);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    verboseLog('chat/completions', body, 200);
  } else {
    response.model = reqModel;
    sendJSON(res, 200, response as unknown as Record<string, unknown>);
    verboseLog('chat/completions', body, 200);
  }
}

async function handleResponses(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { model: reqModel, input, stream, max_output_tokens, temperature } = parsed as {
    model: string;
    input: unknown;
    stream: boolean | undefined;
    max_output_tokens: number | undefined;
    temperature: number | undefined;
  };

  if (input == null) {
    return sendError(res, 400, 'input is required');
  }

  log(`RESP REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`RESP ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const beLimiter = backendRateLimiters.get(route.backend.name);
  if (beLimiter) {
    const ip = res.socket?.remoteAddress || 'unknown';
    const retryAfter = beLimiter(`${ip}:${route.backend.name}`);
    if (retryAfter > 0) {
      res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
      res.end(JSON.stringify({ error: { message: `Rate limit exceeded for backend ${route.backend.name}` } }));
      metrics.inc('unibridge_errors_total', { status: '429' });
      return;
    }
  }

  const messages = responsesInputToMessages(input);
  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }
  const request: ChatRequest = {
    messages,
    model: route.model,
    maxTokens: max_output_tokens || 0,
    temperature: temperature as number | undefined,
  };

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, messages, request.maxTokens) : null;
  if (cacheEnabled && cKey) {
    const cached = cacheGet(cKey);
    if (cached) {
      (cached as ResponseObject).model = reqModel;
      sendJSON(res, 200, cached as Record<string, unknown>);
      verboseLog('responses', body, 200);
      return;
    }
  }

  const startTime = Date.now();
  const ccResponse = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const text = ccResponse?.choices?.[0]?.message?.content || '';
  const reason = ccResponse?.choices?.[0]?.message?.reasoning || '';
  const respObj = buildResponseObject(route.model, text, ccResponse?.usage, reqModel, reason);
  respObj.model = reqModel;

  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`RESP OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${respObj.usage?.total_tokens || '?'}`);

  if (cacheEnabled && cKey) {
    cacheSet(cKey, { ...respObj });
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(reason ? { 'X-Reasoning-Included': 'true' } : {}),
    });
    res.socket?.setNoDelay();
    await streamResponseSSE(res, respObj, text, reason);
    res.end();
    verboseLog('responses', body, 200);
  } else {
    sendJSON(res, 200, respObj as unknown as Record<string, unknown>);
    verboseLog('responses', body, 200);
  }
}

async function handleCompletions(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { prompt, model: reqModel, max_tokens, temperature, stream } = parsed as {
    prompt: string | string[] | undefined;
    model: string;
    max_tokens: number | undefined;
    temperature: number | undefined;
    stream: boolean | undefined;
  };

  log(`LEGACY REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`LEGACY ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const beLimiter = backendRateLimiters.get(route.backend.name);
  if (beLimiter) {
    const ip = res.socket?.remoteAddress || 'unknown';
    const retryAfter = beLimiter(`${ip}:${route.backend.name}`);
    if (retryAfter > 0) {
      res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
      res.end(JSON.stringify({ error: { message: `Rate limit exceeded for backend ${route.backend.name}` } }));
      metrics.inc('unibridge_errors_total', { status: '429' });
      return;
    }
  }

  const promptText = Array.isArray(prompt) ? prompt.join('') : (prompt || '');
  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }
  const request: ChatRequest = {
    messages: [{ role: 'user', content: promptText }],
    model: route.model,
    maxTokens: max_tokens || 0,
    temperature: temperature as number | undefined,
  };

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, request.messages, request.maxTokens) : null;
  if (cacheEnabled && cKey) {
    const cached = cacheGet(cKey);
    if (cached) {
      sendJSON(res, 200, cached as Record<string, unknown>);
      verboseLog('completions', body, 200);
      return;
    }
  }

  const startTime = Date.now();
  const ccResponse = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const text = ccResponse?.choices?.[0]?.message?.content || '';
  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`LEGACY OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${ccResponse?.usage?.total_tokens || '?'}`);

  if (cacheEnabled && cKey) {
    cacheSet(cKey, {
      id: `cmpl-${Date.now()}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: reqModel,
      choices: [{ index: 0, text, logprobs: null, finish_reason: 'stop' }],
      usage: ccResponse?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  if (stream) {
    const id = `cmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    writeSSE(res, {
      id, object: 'text_completion.chunk', created, model: reqModel,
      choices: [{ index: 0, text: '', logprobs: null, finish_reason: null }],
    });
    writeSSE(res, {
      id, object: 'text_completion.chunk', created, model: reqModel,
      choices: [{ index: 0, text, logprobs: null, finish_reason: null }],
    });
    writeSSE(res, {
      id, object: 'text_completion.chunk', created, model: reqModel,
      choices: [{ index: 0, text: '', logprobs: null, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
    verboseLog('completions', body, 200);
  } else {
    sendJSON(res, 200, {
      id: `cmpl-${Date.now()}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: reqModel,
      choices: [{
        index: 0,
        text,
        logprobs: null,
        finish_reason: 'stop',
      }],
      usage: ccResponse?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as Record<string, unknown>);
    verboseLog('completions', body, 200);
  }
}

async function handleEmbeddings(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { model: reqModel, input, encoding_format } = parsed as {
    model: string;
    input: string | string[];
    encoding_format: string | undefined;
  };

  if (!reqModel) {
    return sendError(res, 400, 'model is required');
  }
  if (input == null) {
    return sendError(res, 400, 'input is required');
  }

  log(`EMB REQ len=${body.length} model=${reqModel} input_type=${Array.isArray(input) ? `array[${input.length}]` : typeof input}`);

  const route = await routeModel(reqModel);
  log(`EMB ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const beLimiter = backendRateLimiters.get(route.backend.name);
  if (beLimiter) {
    const ip = res.socket?.remoteAddress || 'unknown';
    const retryAfter = beLimiter(`${ip}:${route.backend.name}`);
    if (retryAfter > 0) {
      res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
      res.end(JSON.stringify({ error: { message: `Rate limit exceeded for backend ${route.backend.name}` } }));
      metrics.inc('unibridge_errors_total', { status: '429' });
      return;
    }
  }

  if (!route.backend.embed) {
    return sendError(res, 501, `Embeddings not supported by ${route.backend.name} backend`);
  }

  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }

  const startTime = Date.now();
  const response = await route.backend.embed(route.backendConfig, {
    model: route.model,
    input,
    encoding_format,
  }, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`EMB OK backend=${route.backend.name} elapsed_ms=${elapsed} data_count=${response?.data?.length || '?'}`);

  sendJSON(res, 200, response as unknown as Record<string, unknown>);
  verboseLog('embeddings', body, 200);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function start(): void {
  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? '';

      // API key auth (skip for /health, /, /v1)
      if (config.apiKey && url !== '/health' && url !== '/' && url !== '/v1') {
        const auth = req.headers['authorization'];
        if (!auth) {
          return sendError(res, 401, 'API key required');
        }
        const match = auth.match(/^Bearer\s+(.+)$/i);
        if (!match || match[1] !== config.apiKey) {
          return sendError(res, 401, 'Invalid API key');
        }
      }

      // GET /v1/models
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        sendJSON(res, 200, { data: registry.allModels() } as Record<string, unknown>);
        return;
      }

      // GET /v1/aliases
      if (req.method === 'GET' && (url === '/v1/aliases' || url === '/aliases')) {
        sendJSON(res, 200, { aliases: config.aliases || {} } as Record<string, unknown>);
        return;
      }

      // GET /metrics
      if (req.method === 'GET' && url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(metrics.metrics());
        return;
      }

      // Rate limit check for non-health endpoints
      if (url !== '/health' && url !== '/' && url !== '/v1') {
        const ip = req.socket.remoteAddress || 'unknown';
        const retryAfter = rateLimiter(ip);
        if (retryAfter > 0) {
          res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
          res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
          metrics.inc('unibridge_errors_total', { status: '429' });
          return;
        }
      }

      // GET / (service info)
      if (req.method === 'GET' && url === '/') {
        sendJSON(res, 200, {
          service: 'unibridge',
          version,
          docs: 'https://github.com/vitkuz573/unibridge',
        });
        return;
      }

      // GET /health or GET /v1
      if (req.method === 'GET' && (url === '/health' || url === '/v1')) {
        sendJSON(res, 200, {
          status: 'ok',
          version,
          backends: registry.listBackends(),
          uptime: Math.floor(process.uptime()),
          cache: { size: responseCache.size },
        });
        return;
      }

      // POST /v1/chat/completions
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        const body = await parseBody(req);
        await handleChatCompletions(body, res);
        return;
      }

      // POST /v1/responses
      if (req.method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
        const body = await parseBody(req);
        await handleResponses(body, res);
        return;
      }

      // POST /v1/completions (legacy)
      if (req.method === 'POST' && (url === '/v1/completions' || url === '/completions')) {
        const body = await parseBody(req);
        await handleCompletions(body, res);
        return;
      }

      // POST /v1/embeddings
      if (req.method === 'POST' && (url === '/v1/embeddings' || url === '/embeddings')) {
        const body = await parseBody(req);
        await handleEmbeddings(body, res);
        return;
      }

      sendError(res, 404, `Unknown endpoint: ${req.method} ${url}`);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      log('FATAL', err.stack || err.message);
      let status = (e as { status?: number }).status || 500;
      let message = err.message;
      if (status === 500 && /failed for model|unknown.*model/i.test(message)) {
        status = 400;
      }
      metrics.inc('unibridge_errors_total', { status: String(status) });
      try { sendError(res, status, message); } catch {}
    }
  });

  server.on('error', (e: Error) => {
    log('SERVER ERROR', e.stack || e.message);
  });

  const host = config.host || '127.0.0.1';
  server.listen(config.port, host, () => {
    log(`LISTEN ${host}:${config.port} backends=${registry.listBackends().join(',')}`);
    console.log(`unibridge ${host}:${config.port} [${registry.listBackends().join(', ')}]`);
    if (config.cache?.enabled) {
      CACHE_TTL = (config.cache.ttl || 60) * 1000;
      startCacheCleanup();
      log(`CACHE enabled ttl=${CACHE_TTL}ms`);
    }
  });

  const shutdown = (signal: string): void => {
    log(`Received ${signal}, shutting down...`);
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      log('Forced shutdown');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  watchConfig((cfg: UnibridgeConfig) => {
    log(`Config reloaded. backends=${Object.keys(cfg.backends || {}).join(',')}`);
  });
}

// Auto-start when run directly (node src/proxy.ts)
if (process.argv[1]?.endsWith('proxy.ts')) {
  start();
}
