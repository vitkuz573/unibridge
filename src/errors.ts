import http from 'node:http';
import { APIError } from 'openai/core/error';
import type { HttpError } from './types.js';

// ---------------------------------------------------------------------------
// OpenAI error envelope: {"error": {message, type, param, code}}.
// Maps internal HttpError / SDK APIError to the wire contract.
// ---------------------------------------------------------------------------

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | number | null;
  };
}

function typeForStatus(status: number): string {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 409) return 'conflict_error';
  if (status === 422) return 'unprocessable_entity_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export function toOpenAIError(e: unknown): { status: number; body: OpenAIErrorBody } {  if (e instanceof APIError) {
    const status = e.status || 500;
    return {
      status,
      body: {
        error: {
          message: e.message || 'Upstream error',
          type: typeForStatus(status),
          param: null,
          code: status,
        },
      },
    };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  let status = (e as Partial<HttpError>)?.status || 500;
  let message = err.message;
  if (status === 500 && /failed for model|unknown.*model/i.test(message)) {
    status = 400;
  }
  return {
    status,
    body: {
      error: {
        message,
        type: typeForStatus(status),
        param: null,
        code: status,
      },
    },
  };
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  const { body } = toOpenAIError(Object.assign(new Error(message), { status }));
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
