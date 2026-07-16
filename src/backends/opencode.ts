import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';

export const name: string = 'opencode';

interface OpencodeContext {
  baseUrl: string;
  auth: Record<string, string>;
  models: string[];
  serverPassword: string;
  serverUsername: string;
  dispatcher: any;
  timeout: number;
}

interface MessagePart {
  type: string;
  text?: string;
  mime?: string;
  url?: string;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

async function retryFetch(url: string, opts: any, dispatcher: any, maxRetries: number = 2, delayMs: number = 1000): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await proxyFetch(url, opts, dispatcher);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.status = res.status;
      lastErr.response = res;
    } catch (err: any) {
      lastErr = err;
    }
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr;
}

function basicAuthHeader(username: string, password: string): Record<string, string> {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { 'Authorization': `Basic ${encoded}` };
}

export async function init(backendConfig: any): Promise<OpencodeContext> {
  const baseUrl = backendConfig.baseUrl || 'http://127.0.0.1:5100';
  const serverPassword = backendConfig.serverPassword || '';
  const serverUsername = backendConfig.serverUsername || 'opencode';
  const auth = basicAuthHeader(serverUsername, serverPassword);
  const timeout = backendConfig.timeout || 300_000;

  const dispatcher = await createProxyAgent(backendConfig.proxy);

  let models = backendConfig.models;
  if (!models) {
    const headers = { 'Content-Type': 'application/json', ...auth };
    const res = await proxyFetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(5000) }, dispatcher);
    const data = await res.json();
    const op = (data.providers || []).find((p: any) => p.id === 'opencode');
    models = op ? Object.keys(op.models) : [];
  }

  return { baseUrl, auth, models, serverPassword, serverUsername, dispatcher, timeout };
}

export function listModels(backendConfig: any, ctx: OpencodeContext | null): Array<{ id: string; object: string }> {
  if (!ctx) return [];
  const models = ctx.models || [];
  return models.map(id => ({
    id: `opencode/${id}`,
    object: 'model',
  }));
}

export async function complete(backendConfig: any, request: any, ctx: OpencodeContext | null): Promise<any> {
  if (!ctx) throw new Error('opencode backend not initialized (server unreachable)');
  const { messages, model, maxTokens, response_format } = request;
  const { baseUrl, auth, timeout } = ctx;
  const forceJson = backendConfig.forceJson || false;
  const minTokens = backendConfig.minTokens || 0;

  const system = (messages || [])
    .filter((m: any) => m.role === 'system')
    .map((m: any) => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts: MessagePart[] = [];
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

  if (system && parts.length > 0) {
    const firstText = parts.find(p => p.type === 'text');
    if (firstText) {
      firstText.text = `[System instructions: ${system}]\n\n${firstText.text}`;
    } else {
      parts.unshift({ type: 'text', text: `[System instructions: ${system}]` });
    }
  }

  if (forceJson && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }

  const msgBody: any = {
    model: {
      providerID: 'opencode',
      modelID: model,
    },
    parts,
  };

  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }

  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  let sessionRes: any;
  try {
    sessionRes = await retryFetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        permission: [{ permission: '*', pattern: '**', action: 'allow' }],
      }),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, ctx.dispatcher);
  } catch (err: any) {
    const e = new Error(`opencode session failed for model ${model}: ${err.message}`);
    (e as any).status = err.status || 503;
    throw e;
  }

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    const e = new Error(`opencode session ${sessionRes.status} for model ${model}: ${errText.substring(0, 500)}`);
    (e as any).status = sessionRes.status;
    throw e;
  }

  const session = await sessionRes.json();

  let msgRes: any;
  try {
    msgRes = await retryFetch(`${baseUrl}/session/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(msgBody),
      signal: AbortSignal.timeout(timeout),
    }, ctx.dispatcher);
  } catch (err: any) {
    const e = new Error(`opencode message failed for model ${model}: ${err.message}`);
    (e as any).status = err.status || 503;
    throw e;
  }

  if (!msgRes.ok) {
    const errText = await msgRes.text();
    const e = new Error(`opencode ${msgRes.status} for model ${model}: ${errText.substring(0, 500)}`);
    (e as any).status = msgRes.status;
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



  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }

  const message: any = { role: 'assistant', content };
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

export async function embed(backendConfig: any, request: any, ctx: OpencodeContext | null): Promise<any> {
  throw Object.assign(new Error('Embeddings not supported by opencode backend'), { status: 501 });
}

export async function* completeStreaming(backendConfig: any, request: any, ctx: OpencodeContext | null): AsyncGenerator<any, void, unknown> {
  if (!ctx) throw new Error('opencode backend not initialized (server unreachable)');
  if (!backendConfig.streaming) return;

  const { messages, model, maxTokens, response_format, temperature } = request;
  const { baseUrl, auth, timeout, dispatcher } = ctx;

  const system = (messages || [])
    .filter((m: any) => m.role === 'system')
    .map((m: any) => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts: MessagePart[] = [];
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

  if (system && parts.length > 0) {
    const firstText = parts.find(p => p.type === 'text');
    if (firstText) {
      firstText.text = `[System instructions: ${system}]\n\n${firstText.text}`;
    } else {
      parts.unshift({ type: 'text', text: `[System instructions: ${system}]` });
    }
  }

  if (backendConfig.forceJson && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }

  let sessionRes: any;
  try {
    sessionRes = await retryFetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        permission: [{ permission: '*', pattern: '**', action: 'allow' }],
      }),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, dispatcher);
  } catch (err: any) {
    const e = new Error(`opencode session failed for model ${model}: ${err.message}`);
    (e as any).status = err.status || 503;
    throw e;
  }

  if (!sessionRes.ok) {
    const errText = await sessionRes.text();
    const e = new Error(`opencode session ${sessionRes.status} for model ${model}: ${errText.substring(0, 500)}`);
    (e as any).status = sessionRes.status;
    throw e;
  }

  const session = await sessionRes.json();

  const msgBody: any = {
    model: { providerID: 'opencode', modelID: model },
    parts,
  };
  if (maxTokens || backendConfig.minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, backendConfig.minTokens || 0);
  }
  if (response_format?.type) msgBody.response_format = response_format;
  if (temperature != null) msgBody.temperature = temperature;

  let promptRes: any;
  try {
    promptRes = await retryFetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(msgBody),
      signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
    }, dispatcher);
  } catch (err: any) {
    const e = new Error(`opencode prompt_async failed for model ${model}: ${err.message}`);
    (e as any).status = err.status || 503;
    throw e;
  }

  if (!promptRes.ok && promptRes.status !== 204) {
    const errText = await promptRes.text();
    const e = new Error(`opencode prompt_async ${promptRes.status} for model ${model}: ${errText.substring(0, 500)}`);
    (e as any).status = promptRes.status;
    throw e;
  }

  let eventRes: any;
  try {
    eventRes = await retryFetch(`${baseUrl}/event`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...auth },
      signal: AbortSignal.timeout(timeout),
    }, dispatcher);
  } catch (err: any) {
    const e = new Error(`opencode event stream failed for model ${model}: ${err.message}`);
    (e as any).status = err.status || 503;
    throw e;
  }

  if (!eventRes.ok) {
    const errText = await eventRes.text();
    const e = new Error(`opencode event stream ${eventRes.status} for model ${model}: ${errText.substring(0, 500)}`);
    (e as any).status = eventRes.status;
    throw e;
  }

  const reader = eventRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let roleEmitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const raw = trimmed.slice(5).trim();
        if (!raw) continue;

        let envelope: any;
        try {
          envelope = JSON.parse(raw);
        } catch {
          continue;
        }

        const event = envelope?.payload || envelope;
        if (!event || typeof event.type !== 'string') continue;
        if (event.properties?.sessionID && event.properties.sessionID !== session.id) continue;

        if (event.type === 'message.part.delta') {
          const delta = event.properties?.delta;
          if (delta) {
            yield {
              id: `chatcmpl-${session.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: roleEmitted ? { content: delta } : { role: 'assistant', content: delta },
                finish_reason: null,
              }],
            };
            roleEmitted = true;
          }
        } else if (event.type === 'message.updated') {
          const info = event.properties?.info;
          const partsList = event.properties?.parts;
          if (info?.role === 'assistant' && Array.isArray(partsList)) {
            yield {
              id: `chatcmpl-${session.id}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop',
              }],
              usage: undefined,
            };
            return;
          }
        } else if (event.type === 'server.instance.disposed') {
          return;
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
}
