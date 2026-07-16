import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';

export const name: string = 'kilocode';

export interface KilocodeContext {
  baseUrl: string;
  apiKey: string;
  models: string[];
  dispatcher: any;
  timeout: number;
}

export interface BackendConfig {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  models?: string[];
  proxy?: any;
}

interface ChatRequest {
  messages?: any[];
  model?: string;
  maxTokens?: number;
  minTokens?: number;
  response_format?: { type?: string };
  tools?: any[];
  tool_choice?: any;
}

export async function init(backendConfig: BackendConfig): Promise<KilocodeContext> {
  const baseUrl: string = backendConfig.baseUrl || 'https://api.kilo.ai/api/gateway';
  const apiKey: string = backendConfig.apiKey || process.env.KILO_API_KEY || '';
  const dispatcher: any = await createProxyAgent(backendConfig.proxy);
  const timeout: number = backendConfig.timeout || 300_000;
  let models = backendConfig.models;

  if (!models) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    try {
      const res: any = await proxyFetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (res.ok) {
        const data: any = await res.json();
        models = (data.data || [])
          .map((m: any) => m.id)
          .filter((id: string) => id === 'kilo-auto/free' || id.endsWith(':free'));
      } else {
        throw new Error(`status ${res.status}`);
      }
    } catch {
      const res: any = await proxyFetch(`${baseUrl}/config/providers`, { headers, signal: AbortSignal.timeout(10000) }, dispatcher);
      if (!res.ok) throw new Error(`kilo gateway models ${res.status}`);
      const data: any = await res.json();
      const kp = (data.providers || []).find((p: any) => p.id === 'kilocode');
      models = kp ? Object.keys(kp.models || {}) : [];
    }
  }

  return { baseUrl, apiKey, models: models || [], dispatcher, timeout };
}

export function listModels(backendConfig: BackendConfig, ctx?: KilocodeContext): any[] {
  if (!ctx) return [];
  const models: string[] = ctx.models || [];
  return models.map((id: string) => ({
    id: `kilocode/${id}`,
    object: 'model',
  }));
}

function buildBody(backendConfig: BackendConfig, request: ChatRequest): any {
  const { messages, model, maxTokens, minTokens, response_format } = request;

  const body: any = {
    model,
    messages: messages || [],
  };
  if (maxTokens || minTokens) {
    body.max_tokens = Math.max(maxTokens || 0, minTokens || 0);
  }
  if (response_format?.type) {
    body.response_format = response_format;
  }
  if (request.tools) {
    body.tools = request.tools;
  }
  if (request.tool_choice) {
    body.tool_choice = request.tool_choice;
  }
  return body;
}

function headers(ctx: KilocodeContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) h['X-Api-Key'] = ctx.apiKey;
  return h;
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx?: KilocodeContext,
): Promise<any> {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);

  const res: any = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText: string = await res.text();
    const e: any = new Error(`kilocode ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  return await res.json();
}

export async function embed(
  backendConfig: BackendConfig,
  request: any,
  ctx?: KilocodeContext,
): Promise<any> {
  throw Object.assign(new Error('Embeddings not supported by kilocode backend'), { status: 501 });
}

export async function* completeStreaming(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx?: KilocodeContext,
): AsyncGenerator<any, void, unknown> {
  if (!ctx) throw new Error('kilocode backend not initialized');
  const body = buildBody(backendConfig, request);
  body.stream = true;

  const res: any = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText: string = await res.text();
    const e: any = new Error(`kilocode ${res.status}: ${errText.substring(0, 500)}`);
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
    const lines: string[] = buffer.split('\n');
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
