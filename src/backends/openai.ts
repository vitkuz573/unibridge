import { createProxyAgent, proxyFetch } from '../fetch-proxy.js';

export const name: string = 'openai';

export interface OpenAIContext {
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
  response_format?: { type?: string };
  temperature?: number;
  tools?: any[];
  tool_choice?: any;
}

interface EmbedRequest {
  model?: string;
  input?: string | string[];
  encoding_format?: string;
}

export async function init(backendConfig: BackendConfig): Promise<OpenAIContext> {
  const baseUrl: string = backendConfig.baseUrl || 'http://127.0.0.1:11434/v1';
  const apiKey: string = backendConfig.apiKey || '';
  const timeout: number = backendConfig.timeout || 300_000;

  let models = backendConfig.models;
  if (!models) {
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data: any = await res.json();
        models = (data.data || []).map((m: any) => m.id);
      }
    } catch {}
  }

  const dispatcher: any = await createProxyAgent(backendConfig.proxy);
  return { baseUrl, apiKey, models: models || [], dispatcher, timeout };
}

export function listModels(backendConfig: BackendConfig, ctx?: OpenAIContext): any[] {
  if (!ctx) return [];
  return (ctx.models || []).map((id: string) => ({
    id: `openai/${id}`,
    object: 'model',
  }));
}

function buildBody(backendConfig: BackendConfig, request: ChatRequest): any {
  const { messages, model, maxTokens, response_format, temperature } = request;

  const body: any = {
    model,
    messages: messages || [],
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;
  if (response_format?.type) body.response_format = response_format;
  if (request.tools) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;
  return body;
}

function headers(ctx: OpenAIContext): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx.apiKey) h['Authorization'] = `Bearer ${ctx.apiKey}`;
  return h;
}

export async function complete(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx?: OpenAIContext,
): Promise<any> {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
  const body = buildBody(backendConfig, request);

  const res: any = await proxyFetch(`${ctx.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeout),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText: string = await res.text();
    const e: any = new Error(`openai ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  return await res.json();
}

export async function embed(
  backendConfig: BackendConfig,
  request: EmbedRequest,
  ctx?: OpenAIContext,
): Promise<any> {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
  const { model, input, encoding_format } = request;

  const body: any = { model };
  if (Array.isArray(input)) {
    body.input = input;
  } else {
    body.input = input;
  }
  if (encoding_format) body.encoding_format = encoding_format;

  const res: any = await proxyFetch(`${ctx.baseUrl}/embeddings`, {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.min(ctx.timeout, 60_000)),
  }, ctx.dispatcher);

  if (!res.ok) {
    const errText: string = await res.text();
    const e: any = new Error(`openai ${res.status}: ${errText.substring(0, 500)}`);
    e.status = res.status;
    throw e;
  }

  return await res.json();
}

export async function* completeStreaming(
  backendConfig: BackendConfig,
  request: ChatRequest,
  ctx?: OpenAIContext,
): AsyncGenerator<any, void, unknown> {
  if (!ctx) throw Object.assign(new Error('openai backend not initialized'), { status: 503 });
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
    const e: any = new Error(`openai ${res.status}: ${errText.substring(0, 500)}`);
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
