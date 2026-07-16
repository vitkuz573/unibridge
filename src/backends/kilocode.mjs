import { createProxyAgent, proxyFetch } from '../fetch-proxy.mjs';

export const name = 'kilocode';

export async function init(backendConfig) {
  const baseUrl = backendConfig.baseUrl || 'https://api.kilo.ai/api/gateway';
  const apiKey = backendConfig.apiKey || process.env.KILO_API_KEY || '';
  const dispatcher = await createProxyAgent(backendConfig.proxy);
  const timeout = backendConfig.timeout || 300_000;
  let models = backendConfig.models;

  if (!models) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    try {
      const res = await proxyFetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (res.ok) {
        const data = await res.json();
        models = (data.data || [])
          .map(m => m.id)
          .filter(id => id === 'kilo-auto/free' || id.endsWith(':free'));
      } else {
        throw new Error(`status ${res.status}`);
      }
    } catch {
      const res = await proxyFetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (!res.ok) throw new Error(`kilo gateway models ${res.status}`);
      const data = await res.json();
      const kp = (data.providers || []).find(p => p.id === 'kilocode');
      models = kp ? Object.keys(kp.models || {}) : [];
    }
  }

  return { baseUrl, apiKey, models, dispatcher, timeout };
}

export function listModels(backendConfig, ctx) {
  if (!ctx) return [];
  const models = ctx.models || [];
  return models.map(id => ({
    id: `kilocode/${id}`,
    object: 'model',
  }));
}

function buildBody(backendConfig, request) {
  const { messages, model, maxTokens, minTokens, response_format } = request;

  const body = {
    model,
    messages: messages || [],
  };
  if (maxTokens || minTokens) {
    body.max_tokens = Math.max(maxTokens || 0, minTokens || 0);
  }
  if (response_format?.type) {
    body.response_format = response_format;
  }
  return body;
}

function headers(ctx) {
  const h = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) h['X-Api-Key'] = ctx.apiKey;
  return h;
}

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);

  const res = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    const e = new Error(`kilocode ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  return await res.json();
}

export async function embed(backendConfig, request, ctx) {
  throw Object.assign(new Error('Embeddings not supported by kilocode backend'), { status: 501 });
}

export async function* completeStreaming(backendConfig, request, ctx) {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);
  body.stream = true;

  const res = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText = await res.text();
    const e = new Error(`kilocode ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}
