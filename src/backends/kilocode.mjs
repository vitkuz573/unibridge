export const name = 'kilocode';

const GATEWAY_URL = 'https://api.kilo.ai/api/gateway';

export async function init(backendConfig) {
  const apiKey = backendConfig.apiKey || process.env.KILO_API_KEY || '';
  let models = backendConfig.models;

  if (!models) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const res = await fetch(`${GATEWAY_URL}/models`, { headers });
    if (!res.ok) throw new Error(`kilo gateway models ${res.status}`);
    const data = await res.json();
    models = (data.data || [])
      .map(m => m.id)
      .filter(id => id === 'kilo-auto/free' || id.endsWith(':free'));
  }

  return { apiKey, models };
}

export function listModels(backendConfig, ctx) {
  if (!ctx) return [];
  const models = ctx.models || [];
  return models.map(id => ({
    id: `kilocode/${id}`,
    object: 'model',
  }));
}

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const { messages, model, maxTokens, minTokens, response_format } = request;
  const { apiKey } = ctx;

  const slashIdx = model.indexOf('/');
  const gatewayModel = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

  const body = {
    model: gatewayModel,
    messages: messages || [],
  };
  if (maxTokens || minTokens) {
    body.max_tokens = Math.max(maxTokens || 0, minTokens || 0);
  }
  if (response_format?.type) {
    body.response_format = response_format;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const res = await fetch(`${GATEWAY_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`kilocode ${res.status}: ${errText.substring(0, 500)}`);
  }

  return await res.json();
}
