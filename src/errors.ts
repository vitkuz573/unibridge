import http from 'node:http';
import { APIError, type OpenAI } from 'openai';
import type { HttpError } from './types.ts';

// ---------------------------------------------------------------------------
// The OpenAI error envelope, `{"error": {message, type, param, code}}`.
//
// The shape is the SDK's own `ErrorObject` rather than a local copy of four
// fields. The local copy had drifted: it allowed `code` to be a number, which
// the contract does not, and it declared `param` non-optional where the contract
// allows it to be absent. A response built here is now checked against the same
// type a client checks it against.
// ---------------------------------------------------------------------------

export type OpenAIErrorBody = { error: OpenAI.ErrorObject };

/**
 * The `type` for a status unibridge originated.
 *
 * Upstream errors keep the `type` the upstream sent — it is the more specific
 * answer, and retyping it by status would lose that. This is only for errors
 * unibridge raises itself, where there is no upstream wording to preserve.
 */
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

/** A present-but-empty field is what "the contract has no value for this" looks like. */
function orNull(value: string | null | undefined): string | null {
  return value ?? null;
}

export function toOpenAIError(e: unknown): { status: number; body: OpenAIErrorBody } {
  if (e instanceof APIError) {
    // `code`, `param` and `type` are the upstream's own account of what went
    // wrong, parsed by the SDK out of its body. Falling back to the status only
    // when an upstream omits them — a client retrying on `code` sees the real
    // reason, and one that sees only a status still sees a well-formed body.
    const status = e.status || 500;
    return {
      status,
      body: {
        error: {
          message: e.message || 'Upstream error',
          type: e.type ?? typeForStatus(status),
          param: orNull(e.param),
          code: orNull(e.code) ?? String(status),
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
        code: String(status),
      },
    },
  };
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  const { body } = toOpenAIError(Object.assign(new Error(message), { status }));
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}