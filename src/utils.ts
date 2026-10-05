import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.ts';
import type { BackendConfig, UnibridgeConfig } from './config.ts';
import * as registry from './backends/registry.ts';
import type { RegisteredBackend } from './backends/registry.ts';
import { createRateLimiter } from './rate-limiter.ts';
import type { Message, Usage, ResponsesUsage, ResponseObject, ResponsesReasoningOutput, ResponsesMessageOutput, ResponsesFunctionCallOutput } from './types.ts';

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

/**
 * A numeric request field, or undefined when it is absent or not a number.
 *
 * Coercing here instead of at the call site is what keeps `"top_p": "0.5"` from
 * reaching a provider as the string it was typed as. Callers range-check the
 * result; this only decides what counts as a number at all.
 */
export function numOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The shape of `T` with every member that may be `undefined` removed.
 *
 * Keyed out rather than widened, so "the caller may not have sent it" becomes
 * "there is no such key" in the type as well as in the object.
 */
export type WithoutUndefined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: Exclude<T[K], undefined>;
};

/**
 * Drop `undefined` members from an object, in the type as well as at runtime.
 *
 * The SDK's request types spell an optional field `field?: T`, which means
 * "absent" — not "present, and undefined". A request assembled from parsed JSON
 * naturally carries the second form, and handing that straight to a provider
 * puts `max_tokens: undefined` on the wire, where a strict server reads it as a
 * request for zero.
 *
 * One boundary, between parsing and forwarding, instead of a conditional spread
 * per field at every call site. The compiler then agrees with the wire: a field
 * that cannot survive this call cannot be read as present either.
 */
export function defined<T extends object>(value: T): WithoutUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member;
  }
  return out as WithoutUndefined<T>;
}

export async function routeModel(reqModel: string): Promise<Route> {
  const route = await registry.route(reqModel);
  if (!route) {
    throw Object.assign(new Error('Model not found'), { status: 400 });
  }
  return route;
}

/**
 * Whether one item of a Responses `input` array is a message.
 *
 * `type` is optional on the contract's own input message — the SDK spells it
 * `EasyInputMessage` with `type?: 'message'` — so a `role` is what makes an
 * item a message. Requiring `type` dropped the item instead, and a dropped
 * input item is the worst kind of wrong here: the request still succeeded, and
 * the model answered from the system prompt alone with no task in front of it.
 * An agent harness that sends `{"role":"user","content":[…]}` — every item,
 * every turn — got answers to a conversation that was not there.
 *
 * An explicit non-message type still wins: `function_call`,
 * `function_call_output`, `input_text` and the rest are read as themselves.
 */
export function isResponsesMessageItem(item: Record<string, unknown>): boolean {
  const type = item['type'];
  if (type === 'message' || type === 'easy_input_message') return true;
  return type === undefined && typeof item['role'] === 'string';
}

export function responsesInputToMessages(input: unknown): Message[] {
  if (!input) return [{ role: 'user', content: '' }];
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [{ role: 'user', content: '' }];
  const messages: Message[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (isResponsesMessageItem(obj)) {
      const rawRole = typeof obj['role'] === 'string' ? obj['role'] : 'user';
      const role = (['system', 'user', 'assistant', 'tool'].includes(rawRole) ? rawRole : 'user') as Message extends never ? never : 'system' | 'user' | 'assistant' | 'tool';
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
      messages.push({ role, content } as Message);
    } else if (obj['type'] === 'input_text') {
      messages.push({ role: 'user', content: String(obj['text'] ?? '') });
    } else if (obj['type'] === 'input_image') {
      messages.push({ role: 'user', content: '[image]' });
    } else if (obj['type'] === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
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

export function buildResponseObject(
  model: string,
  text: string,
  usage: Usage | undefined,
  _reqModel: string,
  reasoning: string,
  toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>,
): ResponseObject {
  const rUsage = ccUsageToResponses(usage);
  const output: Array<ResponsesReasoningOutput | ResponsesMessageOutput | ResponsesFunctionCallOutput> = [];
  if (reasoning) {
    output.push({
      id: uid('reas'),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }
  output.push({
    id: uid('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text }],
  });
  return {
    id: uid('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model,
    output,
    output_text: text,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
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
