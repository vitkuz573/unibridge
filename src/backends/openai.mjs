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

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
  const { messages, model, maxTokens, response_format, temperature } = request;
  const { baseUrl, apiKey } = ctx;

  const slashIdx = model.indexOf('/');
  const upstreamModel = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

  const body = {
    model: upstreamModel,
    messages: messages || [],
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;
  if (response_format?.type) body.response_format = response_format;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
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
