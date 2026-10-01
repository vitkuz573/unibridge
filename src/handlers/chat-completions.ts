import http from 'node:http';
import { config } from '../config.ts';
import { log, sendJSON, verboseLog, routeModel, getBackendRateLimiters, numOrUndefined, defined } from '../utils.ts';
import { sendError, toOpenAIError } from '../errors.ts';
import { ResponseCache, requestKey } from '../cache.ts';
import { writeSSE, writeSSEChunk } from '../sse.ts';
import * as metrics from '../metrics.ts';
import type { Message, ChatRequest, ChatCompletionResponse, Usage } from '../types.ts';

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
  const { messages, max_tokens, max_completion_tokens, response_format, model: reqModel, temperature, stream, reasoning_effort } = parsed as {
    messages: unknown[];
    max_tokens: number | undefined;
    max_completion_tokens: number | undefined;
    response_format: unknown;
    model: string;
    temperature: number | undefined;
    stream: boolean | undefined;
    reasoning_effort: unknown;
  };

  if (reasoning_effort != null && typeof reasoning_effort !== 'string') {
    return sendError(res, 400, 'reasoning_effort must be a string');
  }

  // The remaining generation knobs. Parsed here even for backends whose
  // protocol cannot carry them, so that the request object is the whole client
  // intent: the cache key is derived from it, and a parameter a backend drops
  // still separates two requests that differ in it.
  const topP = numOrUndefined(parsed['top_p']);
  const seed = numOrUndefined(parsed['seed']);
  const presencePenalty = numOrUndefined(parsed['presence_penalty']);
  const frequencyPenalty = numOrUndefined(parsed['frequency_penalty']);
  const n = numOrUndefined(parsed['n']);
  const topLogprobs = numOrUndefined(parsed['top_logprobs']);
  const logprobs = parsed['logprobs'] === true ? true : undefined;
  const parallelToolCalls =
    typeof parsed['parallel_tool_calls'] === 'boolean' ? parsed['parallel_tool_calls'] : undefined;
  const user = typeof parsed['user'] === 'string' ? parsed['user'] : undefined;
  const stopRaw = parsed['stop'];
  const stop =
    typeof stopRaw === 'string' || (Array.isArray(stopRaw) && stopRaw.every((s) => typeof s === 'string'))
      ? (stopRaw as string | string[])
      : undefined;
  let logitBias: Record<string, number> | undefined;
  const biasRaw = parsed['logit_bias'];
  if (biasRaw != null && typeof biasRaw === 'object' && !Array.isArray(biasRaw)) {
    const entries = Object.entries(biasRaw as Record<string, unknown>).filter(
      (pair): pair is [string, number] => typeof pair[1] === 'number',
    );
    if (entries.length) logitBias = Object.fromEntries(entries);
  }

  // A rejected value is a caller bug, and silently coercing it to a default is
  // how "set temperature to 5" ends up answered with temperature 1.
  for (const [name, value] of [
    ['temperature', temperature],
    ['top_p', topP],
    ['presence_penalty', presencePenalty],
    ['frequency_penalty', frequencyPenalty],
  ] as const) {
    if (value != null && (typeof value !== 'number' || Number.isNaN(value))) {
      return sendError(res, 400, `${name} must be a number`);
    }
  }
  for (const [name, value, min, max] of [
    ['temperature', temperature, 0, 2],
    ['top_p', topP, 0, 1],
    ['presence_penalty', presencePenalty, -2, 2],
    ['frequency_penalty', frequencyPenalty, -2, 2],
  ] as const) {
    if (value != null && (value < min || value > max)) {
      return sendError(res, 400, `${name} must be between ${min} and ${max}`);
    }
  }
  if (stopRaw != null && stop === undefined) {
    return sendError(res, 400, 'stop must be a string or an array of strings');
  }
  if (n != null && (!Number.isInteger(n) || n < 1)) {
    return sendError(res, 400, 'n must be a positive integer');
  }
  if (max_tokens != null && (typeof max_tokens !== 'number' || max_tokens < 0)) {
    return sendError(res, 400, 'max_tokens must be a non-negative number');
  }

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
    if (!m['role']) {
      return sendError(res, 400, 'each message must have role');
    }
    if (m['role'] === 'tool') {
      if (!m['tool_call_id']) {
        return sendError(res, 400, 'tool message must have tool_call_id');
      }
    } else if (m['content'] == null && !m['tool_calls']) {
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

  const request: ChatRequest = defined({
    messages: messages as Message[],
    model: route.model,
    max_completion_tokens: max_completion_tokens ?? undefined,
    max_tokens: max_tokens ?? max_completion_tokens ?? undefined,
    temperature,
    top_p: topP,
    stop,
    seed,
    presence_penalty: presencePenalty,
    frequency_penalty: frequencyPenalty,
    n,
    logprobs,
    top_logprobs: topLogprobs,
    logit_bias: logitBias,
    parallel_tool_calls: parallelToolCalls,
    user,
    response_format: response_format as ChatRequest['response_format'],
    tools: parsed['tools'] as ChatRequest['tools'],
    tool_choice: parsed['tool_choice'] as ChatRequest['tool_choice'],
    // `default` means "provider default" and is left off the wire: upstreams
    // that do not know the parameter reject it, and a caller who did not ask
    // for it should not be the reason the request fails.
    reasoning_effort:
      typeof reasoning_effort === 'string' && reasoning_effort.toLowerCase() !== 'default'
        ? (reasoning_effort as ChatRequest['reasoning_effort'])
        : undefined,
  });

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
    let finishSeen = false;
    try {
      for await (const chunk of route.backend.completeStreaming(route.backendConfig, request, route.backend.ctx)) {
        chunk.model = reqModel;
        if (chunk.usage) {
          lastUsage = chunk.usage;
          // With include_usage the OpenAI contract puts usage in the dedicated
          // final chunk; withholding it here keeps usage from appearing twice.
          if (includeUsage) delete chunk.usage;
        }
        if (chunk.choices?.[0]?.finish_reason) finishSeen = true;
        writeSSE(res, chunk as unknown as Record<string, unknown>);
        chunkCount++;
      }
    } catch (e: unknown) {
      // Headers are already sent, so the only terminal that can still reach
      // the client is an SSE error frame. Never end the stream silently: an
      // empty EOF is indistinguishable from a completed empty answer.
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      log('STREAM ERR', msg);
      const { status, body } = toOpenAIError(e);
      metrics.inc('unibridge_errors_total', { status: String(status) });
      writeSSE(res, body as unknown as Record<string, unknown>);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // A backend that ends without a finish_reason still gets a terminal
    // choice chunk, so every successful stream carries exactly one finish.
    if (!finishSeen) {
      const final = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: reqModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(lastUsage && !includeUsage ? { usage: lastUsage } : {}),
      };
      writeSSE(res, final);
      chunkCount++;
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
  const cKey = cacheEnabled ? requestKey(route.backend.name, route.model, request) : null;
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

  const msg = response?.choices?.[0]?.message;
  const text = typeof msg?.content === 'string' ? msg.content : '';
  // Reasoning travels outside `content`: reasoning_content is the canonical
  // DeepSeek-compatible field, reasoning its OpenRouter-compatible alias.
  const reasoningMsg = msg as { reasoning_content?: string; reasoning?: string } | undefined;
  const reasoningText = reasoningMsg?.reasoning_content || reasoningMsg?.reasoning || '';
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

    const toolCalls = msg?.tool_calls?.filter((tc): tc is { id: string; type: 'function'; function: { name: string; arguments: string } } => tc.type === 'function');
    if (toolCalls && toolCalls.length > 0) {
      for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx++) {
        const tc = toolCalls[tcIdx]!;
        const tcChunk = { index: tcIdx, id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: '' } };
        writeSSEChunk(res, id, created, reqModel, { tool_calls: [tcChunk] }, null);
        const argStr = tc.function.arguments;
        const ARG_CHUNK = 10;
        for (let i = 0; i < argStr.length; i += ARG_CHUNK) {
          const argChunk = { index: tcIdx, function: { arguments: argStr.slice(i, i + ARG_CHUNK) } };
          writeSSEChunk(res, id, created, reqModel, { tool_calls: [argChunk] }, null);
          await new Promise(r => setTimeout(r, 15));
        }
      }
    } else {
      const CHUNK = 5;
      for (let i = 0; i < text.length; i += CHUNK) {
        writeSSEChunk(res, id, created, reqModel, { content: text.slice(i, i + CHUNK) }, null);
        await new Promise(r => setTimeout(r, 30));
      }
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
