import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';

function basicAuthHeader(username: string, password: string): Record<string, string> {
  if (!password) return {};
  const user = username || 'opencode';
  const encoded = Buffer.from(`${user}:${password}`).toString('base64');
  return { 'Authorization': `Basic ${encoded}` };
}

export const name: string = 'mimocode';

export interface MimocodeContext {
  baseUrl: string;
  auth: Record<string, string>;
  models: string[];
  serverPassword: string;
  serverUsername: string;
  dispatcher: any;
  timeout: number;
}

export interface BackendConfig {
  baseUrl?: string;
  serverPassword?: string;
  serverUsername?: string;
  timeout?: number;
  models?: string[];
  proxy?: any;
  freeOnly?: boolean;
  forceJson?: boolean;
  minTokens?: number;
}

interface MessageContent {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface Message {
  role: string;
  content?: string | MessageContent[];
}

interface ChatRequest {
  messages?: Message[];
  model?: string;
  maxTokens?: number;
  response_format?: { type?: string };
}

interface EmbedRequest {
  model?: string;
  input?: string | string[];
}

export async function init(backendConfig: BackendConfig): Promise<MimocodeContext> {
  const baseUrl: string = backendConfig.baseUrl || 'http://127.0.0.1:4096';
  const serverPassword: string = backendConfig.serverPassword || process.env.MIMOCODE_SERVER_PASSWORD || '';
  const serverUsername: string = backendConfig.serverUsername || process.env.MIMOCODE_SERVER_USERNAME || 'opencode';
  const auth: Record<string, string> = basicAuthHeader(serverUsername, serverPassword);
  const timeout: number = backendConfig.timeout || 300_000;

  let models: string[] | undefined = backendConfig.models;
  if (!models) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...auth };
    const res: any = await fetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(5000) });
    const data: any = await res.json();
    models = [];
    for (const p of data.providers || []) {
      for (const modelId of Object.keys(p.models || {})) {
        models.push(`${p.id}/${modelId}`);
      }
    }
    if (backendConfig.freeOnly !== false) {
      const freeModel = 'mimo/mimo-auto';
      models = models.filter((id: string) => id === freeModel);
    }
  }

  const dispatcher: any = await createProxyAgent(backendConfig.proxy);

  return { baseUrl, auth, models, serverPassword, serverUsername, dispatcher, timeout };
}

export function listModels(backendConfig: BackendConfig, ctx?: MimocodeContext): any[] {
  if (!ctx) return [];
  const models: string[] = ctx.models || [];
  return models.map((id: string) => ({
    id: `mimocode/${id}`,
    object: 'model',
  }));
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx?: MimocodeContext,
): Promise<any> {
  if (!ctx) throw new Error('mimocode backend not initialized');
  const { messages, model, maxTokens, response_format } = request;
  const { baseUrl, auth, dispatcher, timeout } = ctx;
  const forceJson: boolean = backendConfig.forceJson || false;
  const minTokens: number = backendConfig.minTokens || 0;

  const slashIdx: number = (model || '').indexOf('/');
  const providerID: string = slashIdx >= 0 ? model!.slice(0, slashIdx) : model!;
  const modelID: string = slashIdx >= 0 ? model!.slice(slashIdx + 1) : model!;

  const system: string = (messages || [])
    .filter((m: Message) => m.role === 'system')
    .map((m: Message) => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  const parts: any[] = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url!.url });
        }
      }
    }
  }

  if (system && parts.length > 0) {
    const firstText = parts.find((p: any) => p.type === 'text');
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
    model: { providerID, modelID },
    parts,
  };
  if (maxTokens || minTokens) {
    msgBody.maxTokens = Math.max(maxTokens || 0, minTokens);
  }
  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  const sessionRes: any = await proxyFetch(`${baseUrl}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      permission: [{ permission: '*', pattern: '**', action: 'allow' }],
    }),
    signal: AbortSignal.timeout(Math.min(timeout, 30_000)),
  }, dispatcher);

  if (!sessionRes.ok) {
    const errText: string = await sessionRes.text();
    const e: any = new Error(`mimocode session ${sessionRes.status}: ${errText.substring(0, 500)}`);
    e.status = sessionRes.status;
    throw e;
  }

  const session: any = await sessionRes.json();

  const msgRes: any = await proxyFetch(`${baseUrl}/session/${session.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(msgBody),
    signal: AbortSignal.timeout(timeout),
  }, dispatcher);

  if (!msgRes.ok) {
    const errText: string = await msgRes.text();
    const e: any = new Error(`mimocode ${msgRes.status}: ${errText.substring(0, 500)}`);
    e.status = msgRes.status;
    throw e;
  }

  const data: any = await msgRes.json();

  let content: string = '';
  let rawReasoning: string = '';
  let reasoningAnnotated: string = '';
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

export async function embed(
  backendConfig: BackendConfig,
  request: EmbedRequest,
  ctx?: MimocodeContext,
): Promise<any> {
  throw Object.assign(new Error('Embeddings not supported by mimocode backend'), { status: 501 });
}
