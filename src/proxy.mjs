#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, watchConfig, onConfigChange } from './config.mjs';
import * as registry from './backends/registry.mjs';
import * as opencodeBackend from './backends/opencode.mjs';
import * as kilocodeBackend from './backends/kilocode.mjs';
import * as mimocodeBackend from './backends/mimocode.mjs';
import * as openaiBackend from './backends/openai.mjs';
import { createRateLimiter } from './rate-limiter.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import * as metrics from './metrics.mjs';

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

const responseCache = new Map();
let CACHE_TTL = 60_000;

function cacheKey(backend, model, messages, maxTokens) {
  return `${backend}:${model}:${JSON.stringify(messages)}:${maxTokens || ''}`;
}

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  responseCache.set(key, { value, ts: Date.now() });
}

function cacheCleanup() {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (now - entry.ts > CACHE_TTL) responseCache.delete(key);
  }
}

let cacheCleanupInterval = null;

function startCacheCleanup() {
  if (cacheCleanupInterval) return;
  cacheCleanupInterval = setInterval(cacheCleanup, Math.max(CACHE_TTL, 10_000));
  cacheCleanupInterval.unref();
}

function stopCacheCleanup() {
  if (cacheCleanupInterval) { clearInterval(cacheCleanupInterval); cacheCleanupInterval = null; }
}

function log(...args) {
  const entry = [new Date().toISOString(), ...args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  )].join(' ');
  try { fs.appendFileSync(config.logFile, entry + '\n'); } catch {}
}

process.on('unhandledRejection', (e) => {
  log('UNHANDLED REJECTION:', e?.stack || e);
});

process.on('uncaughtException', (e) => {
  log('UNCAUGHT EXCEPTION:', e?.stack || e);
});

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function responsesInputToMessages(input) {
  if (!input) return [{ role: 'user', content: '' }];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: '' }];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' || item.type === 'easy_input_message') {
      const role = item.role || 'user';
      let content = '';
      if (Array.isArray(item.content)) {
        content = item.content.map(c => {
          if (typeof c === 'string') return c;
          if (c.type === 'input_text') return c.text;
          if (c.type === 'output_text') return c.text;
          if (c.type === 'text') return c.text;
          return '';
        }).join('\n');
      } else if (typeof item.content === 'string') {
        content = item.content;
      }
      messages.push({ role, content });
    } else if (item.type === 'input_text') {
      messages.push({ role: 'user', content: item.text });
    } else if (item.type === 'input_image') {
      messages.push({ role: 'user', content: '[image]' });
    }
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

function writeSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function ccUsageToResponses(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
}

function buildResponseObject(model, text, usage, reqModel, reasoning) {
  const rUsage = ccUsageToResponses(usage);
  const output = [];
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

async function streamResponseSSE(res, respObj, text, reasoning) {
  const id = respObj.id;
  const msgItem = respObj.output.find(o => o.type === 'message') || {};
  const msgId = msgItem.id || uid('msg');

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

function writeSSEChunk(res, id, created, model, delta, finish, usage) {
  const chunk = {
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
  if (usage) chunk.usage = usage;
  writeSSE(res, chunk);
}

// ---------------------------------------------------------------------------
// Register backends
// ---------------------------------------------------------------------------

registry.register(opencodeBackend);
registry.register(kilocodeBackend);
registry.register(mimocodeBackend);
registry.register(openaiBackend);
try { await registry.initAll(); } catch (e) { log('INIT ERR', e?.stack || e); }

log(`Backends: ${registry.listBackends().join(', ')}`);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: { message } });
}

function verboseLog(label, body, statusCode) {
  if (!config.verbose) return;
  const truncated = body.length > 500 ? body.slice(0, 500) + '…' : body;
  log(`VERBOSE ${label} status=${statusCode} body=${truncated}`);
}

async function routeModel(reqModel) {
  const route = await registry.route(reqModel);
  if (!route) {
    throw Object.assign(new Error('Model not found'), { status: 400 });
  }
  return route;
}

async function handleChatCompletions(body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel, temperature, stream } = parsed;

  if (messages == null) {
    return sendError(res, 400, 'messages is required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, 'messages must not be empty');
  }
  for (const msg of messages) {
    if (!msg || !msg.role || msg.content == null) {
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

  const request = {
    messages,
    model: route.model,
    maxTokens: max_completion_tokens || max_tokens || 0,
    response_format,
    temperature,
  };

  const startTime = Date.now();

  if (stream && route.backend.completeStreaming) {
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let chunkCount = 0;
    try {
      for await (const chunk of route.backend.completeStreaming(route.backendConfig, request, route.backend.ctx)) {
        chunk.model = reqModel;
        writeSSE(res, chunk);
        chunkCount++;
      }
    } catch (e) {
      log('STREAM ERR', e?.stack || e);
      res.end();
      throw e;
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
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, messages, request.maxTokens) : null;
  if (cacheEnabled) {
    const cached = cacheGet(cKey);
    if (cached) {
      cached.model = reqModel;
      sendJSON(res, 200, cached);
      verboseLog('chat/completions', body, 200);
      return;
    }
  }

  const response = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const msg = response?.choices?.[0]?.message || {};
  const text = msg.content || '';
  const reasoningText = msg.reasoning || '';
  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${response.usage?.total_tokens || '?'} chars=${text.length} stream=${!!stream}`);

  if (cacheEnabled && !stream && response?.choices) {
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

    const last = {
      id, object: 'chat.completion.chunk', created, model: reqModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    if (response.usage) last.usage = response.usage;
    writeSSE(res, last);
    res.write('data: [DONE]\n\n');
    res.end();
    verboseLog('chat/completions', body, 200);
  } else {
    response.model = reqModel;
    sendJSON(res, 200, response);
    verboseLog('chat/completions', body, 200);
  }
}

async function handleResponses(body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { model: reqModel, input, stream, max_output_tokens, temperature } = parsed;

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
  const request = {
    messages,
    model: route.model,
    maxTokens: max_output_tokens || 0,
    temperature,
  };

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, messages, request.maxTokens) : null;
  if (cacheEnabled) {
    const cached = cacheGet(cKey);
    if (cached) {
      cached.model = reqModel;
      sendJSON(res, 200, cached);
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

  if (cacheEnabled) {
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
    sendJSON(res, 200, respObj);
    verboseLog('responses', body, 200);
  }
}

async function handleCompletions(body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { prompt, model: reqModel, max_tokens, temperature, stream } = parsed;

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
  const request = {
    messages: [{ role: 'user', content: promptText }],
    model: route.model,
    maxTokens: max_tokens || 0,
    temperature,
  };

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? cacheKey(route.backend.name, route.model, request.messages, request.maxTokens) : null;
  if (cacheEnabled) {
    const cached = cacheGet(cKey);
    if (cached) {
      sendJSON(res, 200, cached);
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

  if (cacheEnabled) {
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
    });
    verboseLog('completions', body, 200);
  }
}

async function handleEmbeddings(body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { model: reqModel, input, encoding_format } = parsed;

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

  sendJSON(res, 200, response);
  verboseLog('embeddings', body, 200);
}

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

let rateLimiter = createRateLimiter(config.rateLimit);
const backendRateLimiters = new Map();

function buildBackendRateLimiters(cfg) {
  backendRateLimiters.clear();
  for (const [name, beCfg] of Object.entries(cfg.backends || {})) {
    if (beCfg?.rateLimit) {
      backendRateLimiters.set(name, createRateLimiter(beCfg.rateLimit));
    }
  }
}

buildBackendRateLimiters(config);

onConfigChange((cfg) => {
  rateLimiter = createRateLimiter(cfg.rateLimit);
  buildBackendRateLimiters(cfg);
  const cacheCfg = cfg.cache || {};
  CACHE_TTL = (cacheCfg.ttl || 60) * 1000;
  if (cacheCfg.enabled) startCacheCleanup(); else { stopCacheCleanup(); responseCache.clear(); }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function start() {
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url;

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
        sendJSON(res, 200, { data: registry.allModels() });
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
    } catch (e) {
      log('FATAL', e?.stack || e);
      let status = e.status || 500;
      let message = e.message;
      if (status === 500 && /failed for model|unknown.*model/i.test(message)) {
        status = 400;
      }
      metrics.inc('unibridge_errors_total', { status: String(status) });
      try { sendError(res, status, message); } catch {}
    }
  });

  server.on('error', (e) => {
    log('SERVER ERROR', e?.stack || e);
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

  const shutdown = (signal) => {
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

  watchConfig((cfg) => {
    log(`Config reloaded. backends=${Object.keys(cfg.backends || {}).join(',')}`);
  });
}

// Auto-start when run directly (node src/proxy.mjs)
if (process.argv[1]?.endsWith('proxy.mjs')) {
  start();
}
