#!/usr/bin/env node
/**
 * unibridge — Universal OpenAI-compatible proxy for any LLM backend.
 *
 * Accepts OpenAI /v1/chat/completions requests and routes them to
 * configured backends (opencode, OpenAI, Ollama, etc.) via pluggable adapters.
 *
 * Environment:
 *   UNIBRIDGE_PORT           listen port                        (default: 5200)
 *   UNIBRIDGE_DEFAULT_BACKEND default backend name              (default: null)
 *   UNIBRIDGE_LOG             log file                          (default: /tmp/unibridge.log)
 *   OPENCODE_BASE_URL         opencode server URL               (default: http://127.0.0.1:5100)
 *   OPENCODE_DEFAULT_MODEL    opencode fallback model            (default: big-pickle)
 *   UNIBRIDGE_ALIAS_<model>   map model name to backend          (e.g. UNIBRIDGE_ALIAS_big-pickle=opencode)
 *
 * Usage:
 *   node src/proxy.mjs
 *   UNIBRIDGE_PORT=5200 OPENCODE_BASE_URL=http://127.0.0.1:5100 node src/proxy.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import { config } from './config.mjs';
import * as registry from './backends/registry.mjs';
import * as opencodeBackend from './backends/opencode.mjs';

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
  log('FATAL unhandledRejection:', e?.stack || e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  log('FATAL uncaughtException:', e?.stack || e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Register backends
// ---------------------------------------------------------------------------

registry.register(opencodeBackend);
registry.initAll();

log(`Backends: ${registry.listBackends().join(', ')}`);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
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
    req.on('end', () => handleRequest(body, res));
    return;
  }

  res.writeHead(404);
  res.end();
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

    log(`ROUTE ${reqModel || 'auto'} → ${route.backend.name} model=${route.modelId}`);

    const request = {
      messages,
      modelId: route.modelId,
      maxTokens: Math.max(max_completion_tokens || max_tokens || 0, 4096),
      response_format,
      temperature,
    };

    const startTime = Date.now();
    const response = await route.backend.complete(route.backendConfig, request, route.backend.ctx);
    const elapsed = Date.now() - startTime;

    log(`OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${response.usage?.total_tokens || '?'}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));

  } catch (e) {
    log('ERR', e?.stack || e?.message || e);
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
