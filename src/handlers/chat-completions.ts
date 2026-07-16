import http from 'node:http';
import { config } from '../config.js';
import { log, sendJSON, sendError, verboseLog, routeModel, getBackendRateLimiters } from '../utils.js';
import { ResponseCache } from '../cache.js';
import { writeSSE, writeSSEChunk } from '../sse.js';
import * as metrics from '../metrics.js';
import type { Message, ChatRequest, ChatCompletionResponse, Usage } from '../types.js';

export async function handleChatCompletions(
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

  const request: ChatRequest = {
    messages: messages as Message[],
    model: route.model,
    maxTokens: (max_completion_tokens || max_tokens || 0),
    response_format: response_format as ChatRequest['response_format'],
    temperature,
    tools: parsed['tools'] as ChatRequest['tools'],
    tool_choice: parsed['tool_choice'] as ChatRequest['tool_choice'],
  };

  const startTime = Date.now();

  const streamOptions = parsed['stream_options'] as { include_usage?: boolean } | undefined;
  const includeUsage = !!streamOptions?.include_usage;

  if (stream && route.backend.completeStreaming && route.backendConfig['streaming']) {
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
  const cKey = cacheEnabled ? responseCache.key(route.backend.name, route.model, messages as Message[], request.maxTokens) : null;
  if (cacheEnabled && cKey) {
    const cached = responseCache.get(cKey);
    if (cached) {
      (cached as ChatCompletionResponse).model = reqModel;
      sendJSON(res, 200, cached);
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
    responseCache.set(cKey, toCache);
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
    sendJSON(res, 200, response);
    verboseLog('chat/completions', body, 200);
  }
}
