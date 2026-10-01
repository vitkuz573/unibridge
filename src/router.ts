import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import * as registry from './backends/registry.ts';
import * as metrics from './metrics.ts';
import { log, sendJSON, parseBody, getRateLimiter } from './utils.ts';
import { toOpenAIError, sendError } from './errors.ts';
import { ResponseCache } from './cache.ts';
import { handleChatCompletions } from './handlers/chat-completions.ts';
import { handleResponses } from './handlers/responses.ts';
import { handleCompletions } from './handlers/completions.ts';
import { handleEmbeddings } from './handlers/embeddings.ts';

/**
 * Compare two secrets without leaking their common prefix length.
 *
 * `a !== b` on a bearer credential returns as soon as it finds a difference, so
 * the time it takes tells an attacker how many leading characters they have
 * already guessed. `timingSafeEqual` compares every byte regardless. Length is
 * compared first because the function refuses unequal inputs — and length is
 * not a secret here, both sides are fixed-width keys.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  responseCache: ResponseCache,
): Promise<void> {
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

    if (config.apiKey && url !== '/health' && url !== '/' && url !== '/v1') {
      const auth = req.headers['authorization'];
      if (!auth) {
        return sendError(res, 401, 'API key required');
      }
      const match = auth.match(/^Bearer\s+(.+)$/i);
      const presented = match?.[1];
      if (presented === undefined || !constantTimeEquals(presented, config.apiKey)) {
        return sendError(res, 401, 'Invalid API key');
      }
    }

    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      sendJSON(res, 200, { data: registry.allModels() });
      return;
    }

    if (req.method === 'GET' && (url === '/v1/aliases' || url === '/aliases')) {
      sendJSON(res, 200, { aliases: config.aliases || {} });
      return;
    }

    if (req.method === 'GET' && url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics.metrics());
      return;
    }

    if (url !== '/health' && url !== '/' && url !== '/v1') {
      const ip = req.socket.remoteAddress || 'unknown';
      const retryAfter = getRateLimiter()(ip);
      if (retryAfter > 0) {
        res.writeHead(429, { 'Retry-After': Math.ceil(retryAfter / 1000) });
        res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
        metrics.inc('unibridge_errors_total', { status: '429' });
        return;
      }
    }

    if (req.method === 'GET' && url === '/') {
      sendJSON(res, 200, {
        service: 'unibridge',
        version,
        docs: 'https://github.com/vitkuz573/unibridge',
      });
      return;
    }

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

    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      const body = await parseBody(req);
      await handleChatCompletions(body, res, responseCache);
      return;
    }

    if (req.method === 'POST' && (url === '/v1/responses' || url === '/responses')) {
      const body = await parseBody(req);
      await handleResponses(body, res, responseCache);
      return;
    }

    if (req.method === 'POST' && (url === '/v1/completions' || url === '/completions')) {
      const body = await parseBody(req);
      await handleCompletions(body, res, responseCache);
      return;
    }

    if (req.method === 'POST' && (url === '/v1/embeddings' || url === '/embeddings')) {
      const body = await parseBody(req);
      await handleEmbeddings(body, res);
      return;
    }

    sendError(res, 404, `Unknown endpoint: ${req.method} ${url}`);
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    log('FATAL', err.stack || err.message);
    const { status, body } = toOpenAIError(e);
    metrics.inc('unibridge_errors_total', { status: String(status) });
    try {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch {}
  }
}
