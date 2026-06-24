import { createOpencodeClient } from '@opencode-ai/sdk';

export const name = 'opencode';

function basicAuthHeader(username, password) {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { 'Authorization': `Basic ${encoded}` };
}

export async function init(backendConfig) {
  const baseUrl = backendConfig.baseUrl || 'http://127.0.0.1:5100';
  const serverPassword = backendConfig.serverPassword || '';
  const serverUsername = backendConfig.serverUsername || 'opencode';
  const sdk = createOpencodeClient({ baseUrl });
  const auth = basicAuthHeader(serverUsername, serverPassword);

  if (auth.Authorization) {
    sdk._client.interceptors.request.use((request) => {
      request.headers.set('Authorization', auth.Authorization);
      return request;
    });
  }

  let models = backendConfig.models;
  if (!models) {
    const headers = { 'Content-Type': 'application/json', ...auth };
    const res = await fetch(`${baseUrl}/config/providers`, { headers });
    const data = await res.json();
    const op = (data.providers || []).find(p => p.id === 'opencode');
    models = op ? Object.keys(op.models) : [];
  }

  return { sdk, baseUrl, models, serverPassword, serverUsername };
}

export function listModels(backendConfig, ctx) {
  const models = ctx.models || [];
  return models.map(id => ({
    id: `opencode/${id}`,
    object: 'model',
  }));
}

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw new Error('opencode backend not initialized (server unreachable)');
  const { messages, model, maxTokens, response_format } = request;
  const { sdk, baseUrl, serverPassword, serverUsername } = ctx;
  const forceJson = backendConfig.forceJson || false;
  const minTokens = backendConfig.minTokens || 0;

  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url.url });
        }
      }
    }
  }

  if (forceJson && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }

  const msgBody = {
    model: {
      providerID: 'opencode',
      modelID: model,
    },
    parts,
  };
  if (system) msgBody.system = system;

  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }

  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  const session = await sdk.session.create({
    permission: [{ permission: '*', pattern: '**', action: 'allow' }],
  });

  const msgHeaders = { 'Content-Type': 'application/json', ...basicAuthHeader(serverUsername, serverPassword) };

  const sdkRes = await fetch(`${baseUrl}/session/${session.data.id}/message`, {
    method: 'POST',
    headers: msgHeaders,
    body: JSON.stringify(msgBody),
    signal: AbortSignal.timeout(600_000),
  });

  if (!sdkRes.ok) {
    const errText = await sdkRes.text();
    const e = new Error(`opencode ${sdkRes.status}: ${errText.substring(0, 500)}`);
    e.status = sdkRes.status;
    throw e;
  }

  const data = await sdkRes.json();

  let content = '';
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) content += p.text;
  }

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }

  return {
    id: `chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage,
  };
}
