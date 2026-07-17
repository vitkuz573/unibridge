import http from 'node:http';
import { config } from '../config.js';
import { log, sendJSON, sendError, verboseLog, routeModel, getBackendRateLimiters, responsesInputToMessages, buildResponseObject } from '../utils.js';
import { ResponseCache } from '../cache.js';
import { streamResponseSSE } from '../sse.js';
import * as metrics from '../metrics.js';
import type { ChatRequest, ResponsesRequest } from '../types.js';

export async function handleResponses(
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
  const { model: reqModel, input, stream, max_output_tokens, temperature, instructions, tools, tool_choice } = parsed as {
    model: string;
    input: unknown;
    stream: boolean | undefined;
    max_output_tokens: number | undefined;
    temperature: number | undefined;
    instructions: string | undefined;
    tools: unknown[] | undefined;
    tool_choice: unknown | undefined;
  };

  if (input == null) {
    return sendError(res, 400, 'input is required');
  }

  log(`RESP REQ len=${body.length} model=${reqModel || 'unset'} stream=${!!stream}`);

  const route = await routeModel(reqModel);
  log(`RESP ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

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

  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }

  const cacheEnabled = config.cache?.enabled && !stream;

  if (route.backend.responses) {
    const responsesRequest: ResponsesRequest = {
      model: route.model,
      input,
      max_output_tokens,
      temperature,
      stream,
      instructions,
      tools: tools as ChatRequest['tools'],
      tool_choice: tool_choice as ChatRequest['tool_choice'],
    };

    const messages = responsesInputToMessages(input);
    const cKey = cacheEnabled ? responseCache.key(route.backend.name, route.model, messages, max_output_tokens || 0) : null;
    if (cacheEnabled && cKey) {
      const cached = responseCache.get(cKey);
      if (cached) {
        (cached as { model: string }).model = reqModel;
        sendJSON(res, 200, cached);
        verboseLog('responses', body, 200);
        return;
      }
    }

    const startTime = Date.now();
    const respObj = await route.backend.responses(route.backendConfig, responsesRequest, route.backend.ctx);
    const elapsed = Date.now() - startTime;

    respObj.model = reqModel;

    const text = respObj.output
      .filter(o => o.type === 'message')
      .map(o => (o as { content?: Array<{ text?: string }> }).content?.map(c => c.text ?? '').join('') ?? '')
      .join('') || '';
    const reason = respObj.output
      .filter(o => o.type === 'reasoning')
      .map(o => (o as { summary?: Array<{ text?: string }> }).summary?.map(s => s.text ?? '').join('') ?? '')
      .join('\n') || '';

    metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
    metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
    log(`RESP OK backend=${route.backend.name} elapsed_ms=${elapsed} tokens=${respObj.usage?.total_tokens || '?'}`);

    if (cacheEnabled && cKey) {
      responseCache.set(cKey, { ...respObj });
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
    return;
  }

  const messages = responsesInputToMessages(input);
  const request: ChatRequest = {
    messages,
    model: route.model,
    maxTokens: max_output_tokens || 0,
    temperature,
    tools: tools as ChatRequest['tools'],
    tool_choice: tool_choice as ChatRequest['tool_choice'],
  };

  const cKey = cacheEnabled ? responseCache.key(route.backend.name, route.model, messages, request.maxTokens) : null;
  if (cacheEnabled && cKey) {
    const cached = responseCache.get(cKey);
    if (cached) {
      (cached as { model: string }).model = reqModel;
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

  if (cacheEnabled && cKey) {
    responseCache.set(cKey, { ...respObj });
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
