export const name = 'openai';

export async function init(backendConfig) {
  const baseUrl = backendConfig.baseUrl || 'http://127.0.0.1:11434/v1';
  const apiKey = backendConfig.apiKey || '';

  let models = backendConfig.models;
  if (!models) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        models = (data.data || []).map(m => m.id);
      }
    } catch {}
  }

  return { baseUrl, apiKey, models: models || [] };
}

export function listModels(backendConfig, ctx) {
  if (!ctx) return [];
  return (ctx.models || []).map(id => ({
    id: `openai/${id}`,
    object: 'model',
  }));
}

function buildBody(backendConfig, request) {
  const { messages, model, maxTokens, response_format, temperature } = request;
  const slashIdx = model.indexOf('/');
  const upstreamModel = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

  const body = {
    model: upstreamModel,
    messages: messages || [],
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;
  if (response_format?.type) body.response_format = response_format;
  return body;
}

function headers(ctx) {
  const h = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) h['Authorization'] = `Bearer ${ctx.apiKey}`;
  return h;
}

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
  const body = buildBody(backendConfig, request);

  const res = await fetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    const e = new Error(`openai ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  return await res.json();
}

export async function* completeStreaming(backendConfig, request, ctx) {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
  const body = buildBody(backendConfig, request);
  body.stream = true;

  const res = await fetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    const e = new Error(`openai ${res.status}: ${errText.substring(0, 500)}`);
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
