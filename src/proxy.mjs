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
import * as metrics from './metrics.mjs';

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

function buildResponseObject(model, text, usage, reqModel) {
  const rUsage = ccUsageToResponses(usage);
  return {
    id: uid('resp'),
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model,
    output: [{
      id: uid('msg'),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    usage: rUsage,
  };
}

function streamResponseSSE(res, respObj, text) {
  const id = respObj.id;
  const msg = respObj.output[0];
  const msgId = msg ? msg.id : uid('msg');

  writeSSE(res, { type: 'response.created', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });
  writeSSE(res, { type: 'response.in_progress', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });
  writeSSE(res, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: msgId, type: 'message', role: 'assistant', content: [] },
  });
  writeSSE(res, {
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  const CHUNK = 20;
  for (let i = 0; i < text.length; i += CHUNK) {
    writeSSE(res, {
      type: 'response.output_text.delta',
      delta: text.slice(i, i + CHUNK),
      item_id: msgId,
      output_index: 0,
      content_index: 0,
    });
  }

  writeSSE(res, {
    type: 'response.output_text.done',
    text,
    item_id: msgId,
    output_index: 0,
    content_index: 0,
  });
  writeSSE(res, {
    type: 'response.content_part.done',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text },
  });
  writeSSE(res, {
    type: 'response.output_item.done',
    output_index: 0,
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

async function routeModel(reqModel) {
  const route = await registry.route(reqModel);
  if (!route) {
    throw Object.assign(new Error(`No backend configured for model "${reqModel}". Available: ${registry.listBackends().join(', ')}`), { status: 400 });
  }
  return route;
}

async function handleChatCompletions(body, res) {
  const parsed = JSON.parse(body);
  const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel, temperature, stream } = parsed;

  log(`REQ len=${body.length} msgs=${messages?.length || 0} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

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

  const response = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const text = response?.choices?.[0]?.message?.content || '';
  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${response.usage?.total_tokens || '?'} chars=${text.length} stream=${!!stream}`);

  if (stream) {
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    writeSSEChunk(res, id, created, reqModel, { role: 'assistant', content: '' }, null);

    const CHUNK = 20;
    for (let i = 0; i < text.length; i += CHUNK) {
      writeSSEChunk(res, id, created, reqModel, { content: text.slice(i, i + CHUNK) }, null);
    }

    const last = {
      id, object: 'chat.completion.chunk', created, model: reqModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    if (response.usage) last.usage = response.usage;
    writeSSE(res, last);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    response.model = reqModel;
    sendJSON(res, 200, response);
  }
}

async function handleResponses(body, res) {
  const parsed = JSON.parse(body);
  const { model: reqModel, input, stream, max_output_tokens, temperature } = parsed;

  log(`RESP REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`RESP ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const messages = responsesInputToMessages(input);
  const request = {
    messages,
    model: route.model,
    maxTokens: max_output_tokens || 0,
    temperature,
  };

  const startTime = Date.now();
  const ccResponse = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const text = ccResponse?.choices?.[0]?.message?.content || '';
  const respObj = buildResponseObject(route.model, text, ccResponse?.usage, reqModel);
  respObj.model = reqModel;

  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`RESP OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${respObj.usage?.total_tokens || '?'}`);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    streamResponseSSE(res, respObj, text);
    res.end();
  } else {
    sendJSON(res, 200, respObj);
  }
}

async function handleCompletions(body, res) {
  const parsed = JSON.parse(body);
  const { prompt, model: reqModel, max_tokens, temperature, stream } = parsed;

  log(`LEGACY REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`LEGACY ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

  const promptText = Array.isArray(prompt) ? prompt.join('') : (prompt || '');
  const request = {
    messages: [{ role: 'user', content: promptText }],
    model: route.model,
    maxTokens: max_tokens || 0,
    temperature,
  };

  const startTime = Date.now();
  const ccResponse = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  const text = ccResponse?.choices?.[0]?.message?.content || '';
  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`LEGACY OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${ccResponse?.usage?.total_tokens || '?'}`);

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
  }
}

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

let rateLimiter = createRateLimiter(config.rateLimit);

onConfigChange((cfg) => {
  rateLimiter = createRateLimiter(cfg.rateLimit);
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

      // GET /health or GET /
      if (req.method === 'GET' && (url === '/health' || url === '/' || url === '/v1')) {
        sendJSON(res, 200, {
          status: 'ok',
          backends: registry.listBackends(),
          total_models: registry.allModels().length,
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
        sendError(res, 501, 'Embeddings not supported by any backend');
        return;
      }

      sendError(res, 404, `Unknown endpoint: ${req.method} ${url}`);
    } catch (e) {
      log('FATAL', e?.stack || e);
      const status = e.status || 500;
      metrics.inc('unibridge_errors_total', { status: String(status) });
      try { sendError(res, status, e.message); } catch {}
    }
  });

  server.on('error', (e) => {
    log('SERVER ERROR', e?.stack || e);
  });

  const host = config.host || '127.0.0.1';
  server.listen(config.port, host, () => {
    log(`LISTEN ${host}:${config.port} backends=${registry.listBackends().join(',')}`);
    console.log(`unibridge ${host}:${config.port} [${registry.listBackends().join(', ')}]`);
  });

  watchConfig();
}

// Auto-start when run directly (node src/proxy.mjs)
if (process.argv[1]?.endsWith('proxy.mjs')) {
  start();
}
