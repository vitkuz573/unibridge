import http from 'node:http';
import { config } from '../config.ts';
import { log, sendJSON, verboseLog, routeModel, getBackendRateLimiters, responsesInputToMessages, buildResponseObject, defined } from '../utils.ts';
import { sendError, toOpenAIError } from '../errors.ts';
import { writeSSE, streamResponseSSE } from '../sse.ts';
import { asChatTools } from '../backends/shared/client-tools.ts';
import { ResponseCache, requestKey } from '../cache.ts';
import * as metrics from '../metrics.ts';
import type { ChatRequest, ResponsesRequest } from '../types.ts';

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
  const { model: reqModel, input, stream, max_output_tokens, temperature, instructions, tools, tool_choice, text: textParam } = parsed as {
    model: string;
    input: ResponsesRequest['input'];
    stream: boolean | undefined;
    max_output_tokens: number | undefined;
    temperature: number | undefined;
    instructions: string | undefined;
    tools: unknown[] | undefined;
    tool_choice: unknown | undefined;
    text: ResponsesRequest['text'];
  };
  const reasoningParam = parsed['reasoning'];
  const reasoningEffort =
    typeof parsed['reasoning_effort'] === 'string'
      ? parsed['reasoning_effort']
      : reasoningParam && typeof reasoningParam === 'object' && typeof (reasoningParam as { effort?: unknown }).effort === 'string'
        ? (reasoningParam as { effort: string }).effort
        : undefined;
  if (
    parsed['reasoning_effort'] != null && typeof parsed['reasoning_effort'] !== 'string'
  ) {
    return sendError(res, 400, 'reasoning_effort must be a string');
  }

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

  if (stream && route.backend.responsesStreaming) {
    const responsesRequest: ResponsesRequest = defined({
      model: route.model,
      input,
      max_output_tokens,
      temperature,
      stream,
      instructions,
      tools: tools as ResponsesRequest['tools'],
      tool_choice: tool_choice as ResponsesRequest['tool_choice'],
      text: textParam as ResponsesRequest['text'],
      reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    });

    // The first event is pulled before the headers are written.
    //
    // Every request-level refusal on this path — an unknown model, a backend
    // that cannot carry what the request asked for, a tool request the backend
    // has no contract for — is raised before the generator's first yield, and
    // a client that receives 200 for one of them cannot tell a refusal from a
    // turn: it sees a stream that ends without a terminal event, which is the
    // same observation as a provider that died mid-answer. After the first
    // event the status is committed and a mid-stream failure travels as an
    // `error` event, which is the only terminal left to send.
    const events = route.backend.responsesStreaming(route.backendConfig, responsesRequest, route.backend.ctx);
    let next: IteratorResult<import('openai/resources/responses/responses').ResponseStreamEvent>;
    try {
      next = await events.next();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      log('RESP STREAM ERR', msg);
      const { status, body: errBody } = toOpenAIError(e);
      metrics.inc('unibridge_errors_total', { status: String(status) });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(errBody));
      verboseLog('responses', body, status);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.socket?.setNoDelay();

    try {
      while (true) {
        if (!next.done) writeSSE(res, next.value);
        next = await events.next();
        if (next.done) break;
      }
    } catch (e: unknown) {
      // Headers are already sent: a Responses error event is the only
      // terminal that can still reach the client. A silent EOF would look
      // like a completed turn.
      const msg = e instanceof Error ? e.stack || e.message : String(e);
      log('RESP STREAM ERR', msg);
      const { status, body: errBody } = toOpenAIError(e);
      metrics.inc('unibridge_errors_total', { status: String(status) });
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: String(status), message: errBody.error.message })}\n\n`);
    }
    res.end();
    verboseLog('responses', body, 200);
    return;
  }

  if (route.backend.responses) {
    const responsesRequest: ResponsesRequest = defined({
      model: route.model,
      input,
      max_output_tokens,
      temperature,
      stream,
      instructions,
      tools: tools as ResponsesRequest['tools'],
      tool_choice: tool_choice as ResponsesRequest['tool_choice'],
      text: textParam as ResponsesRequest['text'],
      reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
    });

    const cKey = cacheEnabled
      ? requestKey(route.backend.name, route.model, responsesRequest)
      : null;
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

    const outText = respObj.output
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
      await streamResponseSSE(res, respObj, outText, reason);
      res.end();
      verboseLog('responses', body, 200);
    } else {
      sendJSON(res, 200, respObj);
      verboseLog('responses', body, 200);
    }
    return;
  }

  const messages = responsesInputToMessages(input);
  // Top-level `instructions` is the Responses-API equivalent of a system
  // prompt — prepend it natively instead of mutating user text.
  if (instructions && instructions.trim()) {
    messages.unshift({ role: 'system', content: instructions });
  }
  const request: ChatRequest = defined({
    messages,
    model: route.model,
    max_tokens: max_output_tokens ?? undefined,
    temperature,
    // Responses spells a function tool flat; chat-completions nests it. The
    // translation happens here rather than at each backend, which is what a
    // cast left to them: a flat tool reached a chat backend as an object with
    // no `function` on it.
    tools: asChatTools(tools),
    tool_choice: tool_choice as ChatRequest['tool_choice'],
    // Native structured output: Responses text.format maps 1:1 onto the
    // chat-completions response_format contract.
    response_format: textParam?.format,
  });

  const cKey = cacheEnabled ? requestKey(route.backend.name, route.model, request) : null;
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

  const ccMsg = ccResponse?.choices?.[0]?.message;
  const outText = typeof ccMsg?.content === 'string' ? ccMsg.content : '';
  const reasoningMsg = ccMsg as { reasoning_content?: string; reasoning?: string } | undefined;
  const reason = reasoningMsg?.reasoning_content || reasoningMsg?.reasoning || '';
  const toolCalls = ccMsg?.tool_calls?.filter((tc): tc is { id: string; type: 'function'; function: { name: string; arguments: string } } => tc.type === 'function');
  const respObj = buildResponseObject(route.model, outText, ccResponse?.usage, reqModel, reason, toolCalls);
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
    await streamResponseSSE(res, respObj, outText, reason);
    res.end();
    verboseLog('responses', body, 200);
  } else {
    sendJSON(res, 200, respObj);
    verboseLog('responses', body, 200);
  }
}
