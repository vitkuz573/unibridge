import http from 'node:http';
import { config } from '../config.ts';
import { log, sendJSON, verboseLog, routeModel, getBackendRateLimiters, defined } from '../utils.ts';
import { sendError } from '../errors.ts';
import { ResponseCache, requestKey } from '../cache.ts';
import { writeSSE } from '../sse.ts';
import * as metrics from '../metrics.ts';
import type { ChatRequest, Message } from '../types.ts';

export async function handleCompletions(
  body: string,
  res: http.ServerResponse,
  responseCache: ResponseCache,
): Promise<void> {
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

  const beLimiter = getBackendRateLimiters().get(route.backend.name);
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
  const request: ChatRequest = defined({
    messages: [{ role: 'user', content: promptText }] as Message[],
    model: route.model,
    max_tokens: max_tokens ?? undefined,
    temperature,
  });

  const cacheEnabled = config.cache?.enabled && !stream;
  const cKey = cacheEnabled ? requestKey(route.backend.name, route.model, request) : null;
  if (cacheEnabled && cKey) {
    const cached = responseCache.get(cKey);
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

  if (cacheEnabled && cKey) {
    responseCache.set(cKey, {
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
