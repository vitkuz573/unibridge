import http from 'node:http';
import { log, sendJSON, sendError, verboseLog, routeModel, getBackendRateLimiters } from '../utils.js';
import * as metrics from '../metrics.js';

export async function handleEmbeddings(body: string, res: http.ServerResponse): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Invalid JSON');
  }
  const { model: reqModel, input, encoding_format } = parsed as {
    model: string;
    input: string | string[];
    encoding_format: string | undefined;
  };

  if (!reqModel) {
    return sendError(res, 400, 'model is required');
  }
  if (input == null) {
    return sendError(res, 400, 'input is required');
  }

  log(`EMB REQ len=${body.length} model=${reqModel} input_type=${Array.isArray(input) ? `array[${input.length}]` : typeof input}`);

  const route = await routeModel(reqModel);
  log(`EMB ROUTE ${reqModel} → ${route.backend.name} model=${route.model}`);

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

  if (!route.backend.embed) {
    return sendError(res, 501, `Embeddings not supported by ${route.backend.name} backend`);
  }

  if (!route.backend.ctx) {
    return sendError(res, 503, `Backend ${route.backend.name} not initialized`);
  }

  const startTime = Date.now();
  const response = await route.backend.embed(route.backendConfig, {
    model: route.model,
    input,
    encoding_format,
  }, route.backend.ctx);
  const elapsed = Date.now() - startTime;

  metrics.inc('unibridge_requests_total', { backend: route.backend.name, model: reqModel, status: '200' });
  metrics.observe('unibridge_request_duration_ms', elapsed, { backend: route.backend.name });
  log(`EMB OK backend=${route.backend.name} elapsed_ms=${elapsed} data_count=${response?.data?.length || '?'}`);

  sendJSON(res, 200, response);
  verboseLog('embeddings', body, 200);
}
