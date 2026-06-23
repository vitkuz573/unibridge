#!/usr/bin/env node
/**
 * opencode-graphify-bridge — OpenAI-compatible proxy for opencode local LLMs.
 *
 * Translates OpenAI /v1/chat/completions requests into opencode session/message
 * protocol.
 *
 * JSON-force injection (appending a JSON instruction to the last user message)
 * is applied ONLY for extraction requests — those with a system message.
 * Labeling and other plain-text calls have no system message and rely on the
 * model following the prompt's own JSON instruction naturally.
 *
 * Environment:
 *   SDK_URL         opencode server URL              (default: http://127.0.0.1:5100)
 *   PROXY_PORT      listen port                       (default: 5200)
 *   PROXY_MODEL     fallback model ID                 (default: big-pickle)
 *   PROXY_PROVIDER  provider namespace                (default: opencode)
 *
 * Usage:
 *   node src/proxy.mjs
 *   PROXY_PORT=5200 SDK_URL=http://127.0.0.1:5100 node src/proxy.mjs
 */

import http from 'node:http';
import { createOpencodeClient } from '@opencode-ai/sdk';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENV = {
  SDK_URL: process.env.SDK_URL || 'http://127.0.0.1:5100',
  PORT: parseInt(process.env.PROXY_PORT || '5200', 10),
  MODEL: process.env.PROXY_MODEL || null,
  PROVIDER: process.env.PROXY_PROVIDER || 'opencode',
};

const LOG = '/tmp/opencode-proxy.log';

const MODELS = [
  'big-pickle',
  'north-mini-code-free',
  'deepseek-v4-flash-free',
  'nemotron-3-ultra-free',
  'mimo-v2.5-free',
];

const JSON_FORCE_SUFFIX =
  '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args) {
  const entry = [new Date().toISOString(), ...args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  )].join(' ');
  try { fs.appendFileSync(LOG, entry + '\n'); } catch {}
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
// opencode SDK client
// ---------------------------------------------------------------------------

const sdk = createOpencodeClient({ baseUrl: ENV.SDK_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripMarkdown(text) {
  return text
    .replace(/^```(?:json)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .trim();
}

function parseModel(modelStr) {
  if (!modelStr) return null;
  if (modelStr.includes('/')) {
    const [p, m] = modelStr.split('/', 2);
    return { providerID: p || ENV.PROVIDER, modelID: m };
  }
  return { providerID: ENV.PROVIDER, modelID: modelStr };
}

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

  // GET /v1/models — list available models
  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: MODELS.map(id => ({
        id: `${ENV.PROVIDER}/${id}`,
        object: 'model',
      })),
    }));
    return;
  }

  // POST /v1/chat/completions — main proxy endpoint
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => handleChatCompletion(body, res));
    return;
  }

  res.writeHead(404);
  res.end();
});

async function handleChatCompletion(body, res) {
  try {
    const parsed = JSON.parse(body);
    const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel } = parsed;

    const model = parseModel(reqModel)
      || parseModel(ENV.MODEL)
      || { providerID: ENV.PROVIDER, modelID: 'big-pickle' };

    log(`REQ len=${body.length} msgs=${messages?.length || 0} model=${model.modelID}`);

    // Build system text
    const system = (messages || [])
      .filter(m => m.role === 'system')
      .map(m => typeof m.content === 'string' ? m.content : '')
      .join('\n');

    // Build parts list (skip system messages)
    const parts = [];
    for (const m of messages || []) {
      if (m.role === 'system') continue;
      if (typeof m.content === 'string') {
        parts.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') parts.push({ type: 'text', text: p.text });
          else if (p.type === 'image_url') {
            parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url.url });
          }
        }
      }
    }

    // Inject JSON-force only for extraction requests (those with a system
    // message). Labeling calls have no system message and already instruct JSON
    // via the prompt itself — no append needed, and the blind force can break
    // community naming (the model returns misstructured JSON).
    const hasSystem = system.length > 0;
    if (hasSystem && parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last.type === 'text') {
        last.text += JSON_FORCE_SUFFIX;
        log('JSON_FORCE (system detected)');
      }
    }

    log(`PARTS text_len=${parts.filter(p => p.type === 'text').join(' ').length} count=${parts.length}`);

    // Create opencode session
    log('SESSION create...');
    const session = await sdk.session.create({
      permission: [{ permission: '*', pattern: '**', action: 'allow' }],
    });
    log(`SESSION id=${session.data.id}`);

    // Build SDK message body
    const msgBody = { model, parts };
    if (system) msgBody.system = system;

    // Ensure a generous token budget. Reasoning models (big-pickle) consume
    // output tokens for thinking before any visible text, so the client's
    // computed max_tokens (e.g. graphify's 64+24×100=2464) is often too tight
    // and truncates the response mid-JSON. Floor at 4096; let the client's
    // value win if it's already higher.
    const effectiveMaxTokens = Math.max(max_completion_tokens || 0, 4096);
    msgBody.maxTokens = effectiveMaxTokens;
    if (effectiveMaxTokens !== (max_completion_tokens || 0)) {
      log(`MAXTOKENS boost: ${max_completion_tokens || 'unset'} → ${effectiveMaxTokens}`);
    }

    // Forward response_format for models that support native JSON mode
    if (response_format?.type) {
      msgBody.response_format = response_format;
      log(`FORMAT ${JSON.stringify(response_format)}`);
    }

    log(`SEND keys=${Object.keys(msgBody).join(',')}`);

    // Send message to opencode
    const startTime = Date.now();
    const sdkRes = await fetch(`${ENV.SDK_URL}/session/${session.data.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
      signal: AbortSignal.timeout(600_000),
    });
    const elapsed = Date.now() - startTime;
    log(`SDK status=${sdkRes.status} elapsed_ms=${elapsed}`);

    if (!sdkRes.ok) {
      const errText = await sdkRes.text();
      log(`SDK_ERR ${errText.substring(0, 200)}`);
      throw new Error(`SDK ${sdkRes.status}: ${errText.substring(0, 500)}`);
    }

    const data = await sdkRes.json();

    // Extract text from response parts
    let content = '';
    for (const p of data.parts || []) {
      if (p.type === 'text' && p.text) content += p.text;
    }
    content = stripMarkdown(content);
    log(`CONTENT len=${content.length}`);

    // Build usage info
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (data.info?.tokens) {
      usage.prompt_tokens = data.info.tokens.input || 0;
      usage.completion_tokens = data.info.tokens.output || 0;
      usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
    }

    // OpenAI-compatible response
    const response = {
      id: `chat-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${model.providerID}/${model.modelID}`,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    log('OK');

  } catch (e) {
    log('ERR', e?.stack || e?.message || e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(ENV.PORT, '127.0.0.1', () => {
  log(`LISTEN :${ENV.PORT} SDK=${ENV.SDK_URL} model=${ENV.MODEL || 'auto'}`);
  console.log(`opencode-graphify-bridge :${ENV.PORT} → ${ENV.SDK_URL} [${ENV.MODEL || 'auto'}]`);
});
