import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import type { BackendConfig, UnibridgeConfig } from './config.js';
import * as registry from './backends/registry.js';
import type { RegisteredBackend } from './backends/registry.js';
import { createRateLimiter } from './rate-limiter.js';
import type { Message, Usage, ResponsesUsage, ResponseObject, ResponsesReasoningOutput, ResponsesMessageOutput } from './types.js';

export interface Route {
  backend: RegisteredBackend;
  model: string;
  backendConfig: BackendConfig;
}

export type RateLimitFn = (ip: string) => number;

export function log(...args: unknown[]): void {
  const entry = [new Date().toISOString(), ...args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  )].join(' ');
  try { fs.appendFileSync(config.logFile, entry + '\n'); } catch {}
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: { message } });
}

export function verboseLog(label: string, body: string, statusCode: number): void {
  if (!config.verbose) return;
  const truncated = body.length > 500 ? body.slice(0, 500) + '…' : body;
  log(`VERBOSE ${label} status=${statusCode} body=${truncated}`);
}

export function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer | string) => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function routeModel(reqModel: string): Promise<Route> {
  const route = await registry.route(reqModel);
  if (!route) {
    throw Object.assign(new Error('Model not found'), { status: 400 });
  }
  return route;
}

export function responsesInputToMessages(input: unknown): Message[] {
  if (!input) return [{ role: 'user', content: '' }];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: '' }];
  const messages: Message[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (obj['type'] === 'message' || obj['type'] === 'easy_input_message') {
      const role = (typeof obj['role'] === 'string' ? obj['role'] : 'user') as Message['role'];
      let content = '';
      if (Array.isArray(obj['content'])) {
        content = obj['content'].map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (!c || typeof c !== 'object') return '';
          const cc = c as Record<string, unknown>;
          if (cc['type'] === 'input_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'output_text') return String(cc['text'] ?? '');
          if (cc['type'] === 'text') return String(cc['text'] ?? '');
          return '';
        }).join('\n');
      } else if (typeof obj['content'] === 'string') {
        content = obj['content'];
      }
      messages.push({ role, content });
    } else if (obj['type'] === 'input_text') {
      messages.push({ role: 'user', content: String(obj['text'] ?? '') });
    } else if (obj['type'] === 'input_image') {
      messages.push({ role: 'user', content: '[image]' });
    } else if (obj['type'] === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [{
          id: (obj as { call_id?: string }).call_id || '',
          type: 'function',
          function: {
            name: (obj as { name?: string }).name || '',
            arguments: (obj as { arguments?: string }).arguments || '',
          },
        }],
      });
    } else if (obj['type'] === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: (obj as { call_id?: string }).call_id || '',
        content: (obj as { output?: string }).output || '',
      });
    }
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

export function ccUsageToResponses(usage: Usage | undefined): ResponsesUsage {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

export function buildResponseObject(model: string, text: string, usage: Usage | undefined, _reqModel: string, reasoning: string): ResponseObject {
  const rUsage = ccUsageToResponses(usage);
  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput> = [];
  if (reasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  output.push({
    id: uid('msg'),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });
  return {
    id: uid('resp'),
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model,
    output,
    usage: rUsage,
  };
}

let _rateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const _backendRateLimiters = new Map<string, RateLimitFn>();

export function getRateLimiter(): (ip: string) => number {
  return _rateLimiter;
}

export function getBackendRateLimiters(): Map<string, RateLimitFn> {
  return _backendRateLimiters;
}

export function updateRateLimiters(cfg: UnibridgeConfig): void {
  _rateLimiter = createRateLimiter(cfg.rateLimit);
  _backendRateLimiters.clear();
  for (const [name, beCfg] of Object.entries(cfg.backends || {})) {
    if (beCfg?.rateLimit) {
      _backendRateLimiters.set(name, createRateLimiter(beCfg.rateLimit));
    }
  }
}
