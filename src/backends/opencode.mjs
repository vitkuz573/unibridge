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
  const auth = basicAuthHeader(serverUsername, serverPassword);

  let models = backendConfig.models;
  if (!models) {
    const headers = { 'Content-Type': 'application/json', ...auth };
    const res = await fetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const op = (data.providers || []).find(p => p.id === 'opencode');
    models = op ? Object.keys(op.models) : [];
  }

  return { baseUrl, auth, models, serverPassword, serverUsername };
}

export function listModels(backendConfig, ctx) {
  if (!ctx) return [];
  const models = ctx.models || [];
  return models.map(id => ({
    id: `opencode/${id}`,
    object: 'model',
  }));
}

export async function complete(backendConfig, request, ctx) {
  if (!ctx) throw new Error('opencode backend not initialized (server unreachable)');
  const { messages, model, maxTokens, response_format } = request;
  const { baseUrl, auth } = ctx;
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

  const sessionRes = await fetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      permission: [{ permission: '*', pattern: '**', action: 'allow' }],
    }),
  });

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    const e = new Error(`opencode session ${sessionRes.status}: ${errText.substring(0, 500)}`);
    e.status = sessionRes.status;
    throw e;
  }

  const session = await sessionRes.json();

  const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(msgBody),
    signal: AbortSignal.timeout(600_000),
  });

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    const e = new Error(`opencode ${msgRes.status}: ${errText.substring(0, 500)}`);
    e.status = msgRes.status;
    throw e;
  }

  const data = await msgRes.json();

  let content = '';
  let rawReasoning = '';
  let reasoningAnnotated = '';
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) {
      content += p.text;
    } else if (p.type === 'reasoning' && p.text) {
      if (rawReasoning) rawReasoning += '\n';
      rawReasoning += p.text;
      reasoningAnnotated += `[reasoning: ${p.text}]\n`;
    } else if (p.type === 'tool_use') {
      const tu = p.tool_use || {};
      const input = typeof tu.input === 'object' ? JSON.stringify(tu.input) : (tu.input || '');
      content += `\n[called tool: ${tu.tool}(${input})]\n`;
    } else if (p.type === 'tool_result') {
      const tr = p.tool_result || {};
      const result = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
      content += `${result}\n`;
    }
  }

  if (forceJson) {
    content = content
      .replace(/^```(?:json)?\s*\n?/gm, '')
      .replace(/\n?```\s*$/gm, '')
      .trim();
  }

  if (!forceJson && reasoningAnnotated) {
    content = reasoningAnnotated + (content ? '\n' + content : '');
  }

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }

  const message = { role: 'assistant', content };
  if (rawReasoning) message.reasoning = rawReasoning;

  return {
    id: `chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{
      index: 0,
      message,
      finish_reason: 'stop',
    }],
    usage,
  };
}
