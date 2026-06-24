#!/usr/bin/env node
/**
 * unibridge — Universal OpenAI-compatible proxy for any LLM backend.
 *
 * Accepts OpenAI /v1/chat/completions and /v1/responses requests and routes
 * them to configured backends (opencode, OpenAI, Ollama, etc.) via pluggable
 * adapters.
 *
 * All backend config lives in unibridge.json (autodetected: CWD, ~/).
 * Env overrides for top-level settings only:
 *   UNIBRIDGE_CONFIG           explicit config file path
 *   UNIBRIDGE_PORT             listen port
 *   UNIBRIDGE_DEFAULT_BACKEND  default backend name
 *   UNIBRIDGE_LOG              log file path
 *
 * Usage:
 *   node src/proxy.mjs                     # reads unibridge.json
 *   UNIBRIDGE_PORT=5200 node src/proxy.mjs # port override
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.mjs';
import * as registry from './backends/registry.mjs';
import * as opencodeBackend from './backends/opencode.mjs';
import * as kilocodeBackend from './backends/kilocode.mjs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Responses API → Chat Completions conversion
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSE streaming helpers
// ---------------------------------------------------------------------------

function writeSSE(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  writeSSE(res, {
    type: 'response.output_text.delta',
    delta: text,
    item_id: msgId,
    output_index: 0,
    content_index: 0,
  });
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

// ---------------------------------------------------------------------------
// Register backends
// ---------------------------------------------------------------------------

registry.register(opencodeBackend);
registry.register(kilocodeBackend);
try { await registry.initAll(); } catch (e) { log('INIT ERR', e?.stack || e); }

log(`Backends: ${registry.listBackends().join(', ')}`);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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

    // GET /v1/models
    if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: registry.allModels() }));
      return;
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => handleRequest(body, res).catch(e => log('UNCAUGHT', e?.stack || e)));
      return;
    }

    // POST /v1/responses (Responses API bridge)
    if (req.method === 'POST' && (req.url === '/v1/responses' || req.url === '/responses')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => handleResponsesRequest(body, res).catch(e => log('UNCAUGHT', e?.stack || e)));
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    log('FATAL request handler:', e?.stack || e);
    try { res.writeHead(500); res.end(); } catch {}
  }
});

server.on('error', (e) => {
  log('SERVER ERROR', e?.stack || e);
});

async function handleRequest(body, res) {
  try {
    const parsed = JSON.parse(body);
    const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel, temperature } = parsed;

    log(`REQ len=${body.length} msgs=${messages?.length || 0} model=${reqModel || 'unset'}`);

    // Route to backend
    const route = await registry.route(reqModel);
    if (!route) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `No backend configured for model "${reqModel}". Available backends: ${registry.listBackends().join(', ')}`,
        },
      }));
      return;
    }

    log(`ROUTE ${reqModel || 'auto'} → ${route.backend.name} model=${route.model}`);

    const request = {
      messages,
      model: route.model,
      maxTokens: max_completion_tokens || max_tokens || 0,
      response_format,
      temperature,
    };

    const startTime = Date.now();
    const response = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
    const elapsed = Date.now() - startTime;

    log(`OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${response.usage?.total_tokens || '?'}`);

    response.model = reqModel;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));

  } catch (e) {
    log('ERR', e?.stack || e?.message || e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

// ---------------------------------------------------------------------------
// Responses API handler
// ---------------------------------------------------------------------------

async function handleResponsesRequest(body, res) {
  try {
    const parsed = JSON.parse(body);
    const { model: reqModel, input, stream, max_output_tokens, temperature } = parsed;

    log(`RESP REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

    const route = await registry.route(reqModel);
    if (!route) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `No backend configured for model "${reqModel}"` },
      }));
      return;
    }

    log(`RESP ROUTE ${reqModel || 'auto'} → ${route.backend.name} model=${route.model}`);

    const messages = responsesInputToMessages(input);

    const ccRequest = {
      messages,
      model: route.model,
      maxTokens: max_output_tokens || 0,
      temperature,
    };

    const startTime = Date.now();
    const ccResponse = await route.backend.complete(route.backendConfig, ccRequest, route.backend.ctx);
    const elapsed = Date.now() - startTime;

    const text = ccResponse?.choices?.[0]?.message?.content || '';
    const respObj = buildResponseObject(route.model, text, ccResponse?.usage, reqModel);
    respObj.model = reqModel;

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respObj));
    }

  } catch (e) {
    log('RESP ERR', e?.stack || e?.message || e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(config.port, '127.0.0.1', () => {
  log(`LISTEN :${config.port} backends=${registry.listBackends().join(',')}`);
  console.log(`unibridge :${config.port} [${registry.listBackends().join(', ')}]`);
});
