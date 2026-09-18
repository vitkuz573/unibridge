import type { ResponseFormat } from '../../types.js';

// ---------------------------------------------------------------------------
// Native structured output (OpenAI contract, zero prompt hacks).
//
// The upstream (opencode serve / zen) does NOT reliably enforce
// ``response_format`` — it is forwarded best-effort, but the guarantee comes
// from local validation here: parse the model text as JSON and check it
// against the client-supplied schema. On mismatch the caller retries once
// with the validation error appended as feedback.
//
// Supported subset of JSON Schema (draft 2020-12), matching what OpenAI
// strict mode accepts: type, enum, const, properties, required,
// additionalProperties, items, prefixItems, anyOf, oneOf, min/maxLength,
// minimum/maximum, min/maxItems, pattern. Unknown keywords are ignored.
// $ref is resolved for local ``#``, ``#/$defs/...`` and ``#/...`` pointers.
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  message: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'object': return isObject(v);
    case 'array': return Array.isArray(v);
    default: return true;
  }
}

function resolveRef(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = schema;
  const seen = new Set<Record<string, unknown>>();
  while (isObject(current['$ref']) === false && typeof current['$ref'] === 'string' && !seen.has(current)) {
    seen.add(current);
    const ref = current['$ref'] as string;
    if (!ref.startsWith('#')) break;
    const pointer = ref.slice(1).split('/').filter(Boolean).map(p => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let target: unknown = root;
    for (const seg of pointer) {
      if (!isObject(target) || !(seg in target)) { target = undefined; break; }
      target = (target as Record<string, unknown>)[seg];
    }
    if (!isObject(target)) break;
    const { $ref: _dropped, ...rest } = current;
    current = { ...(target as Record<string, unknown>), ...rest };
    void _dropped;
  }
  return current;
}

function validateAgainst(
  value: unknown,
  schema: unknown,
  root: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push({ path, message: 'schema is false' });
    return;
  }
  if (!isObject(schema)) return;
  const s = resolveRef(schema, root);

  if (typeof s['const'] !== 'undefined') {
    if (JSON.stringify(value) !== JSON.stringify(s['const'])) {
      errors.push({ path, message: `must equal const ${JSON.stringify(s['const'])}` });
    }
    return;
  }
  if (Array.isArray(s['enum'])) {
    const ok = (s['enum'] as unknown[]).some(e => JSON.stringify(e) === JSON.stringify(value));
    if (!ok) errors.push({ path, message: `must be one of ${JSON.stringify(s['enum'])}` });
    return;
  }
  if (Array.isArray(s['anyOf'])) {
    const branches = s['anyOf'] as unknown[];
    const ok = branches.some(b => {
      const sub: ValidationError[] = [];
      validateAgainst(value, b, root, path, sub);
      return sub.length === 0;
    });
    if (!ok) errors.push({ path, message: 'must match at least one anyOf branch' });
    return;
  }
  if (Array.isArray(s['oneOf'])) {
    const branches = s['oneOf'] as unknown[];
    const matched = branches.filter(b => {
      const sub: ValidationError[] = [];
      validateAgainst(value, b, root, path, sub);
      return sub.length === 0;
    }).length;
    if (matched !== 1) errors.push({ path, message: `must match exactly one oneOf branch (matched ${matched})` });
    return;
  }

  const types = Array.isArray(s['type']) ? (s['type'] as string[]) : (typeof s['type'] === 'string' ? [s['type'] as string] : []);
  if (types.length > 0 && !types.some(t => matchesType(value, t))) {
    errors.push({ path, message: `expected ${types.join('|')}, got ${typeName(value)}` });
    return;
  }

  if (typeof value === 'string') {
    if (typeof s['minLength'] === 'number' && value.length < (s['minLength'] as number)) {
      errors.push({ path, message: `shorter than minLength ${(s['minLength'] as number)}` });
    }
    if (typeof s['maxLength'] === 'number' && value.length > (s['maxLength'] as number)) {
      errors.push({ path, message: `longer than maxLength ${(s['maxLength'] as number)}` });
    }
    if (typeof s['pattern'] === 'string') {
      try {
        if (!new RegExp(s['pattern'] as string).test(value)) errors.push({ path, message: `does not match pattern ${s['pattern'] as string}` });
      } catch { /* invalid pattern in schema — ignore */ }
    }
  }

  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < (s['minimum'] as number)) {
      errors.push({ path, message: `less than minimum ${(s['minimum'] as number)}` });
    }
    if (typeof s['maximum'] === 'number' && value > (s['maximum'] as number)) {
      errors.push({ path, message: `greater than maximum ${(s['maximum'] as number)}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < (s['minItems'] as number)) {
      errors.push({ path, message: `fewer items than minItems ${(s['minItems'] as number)}` });
    }
    if (typeof s['maxItems'] === 'number' && value.length > (s['maxItems'] as number)) {
      errors.push({ path, message: `more items than maxItems ${(s['maxItems'] as number)}` });
    }
    if (Array.isArray(s['prefixItems'])) {
      const prefix = s['prefixItems'] as unknown[];
      prefix.forEach((sub, i) => {
        if (i < value.length) validateAgainst(value[i], sub, root, `${path}/${i}`, errors);
      });
      if (s['items'] === false && value.length > prefix.length) {
        errors.push({ path, message: `more items (${value.length}) than prefixItems allows (${prefix.length})` });
      } else if (isObject(s['items'])) {
        for (let i = prefix.length; i < value.length; i++) {
          validateAgainst(value[i], s['items'], root, `${path}/${i}`, errors);
        }
      }
    } else if (isObject(s['items']) || typeof s['items'] === 'boolean') {
      value.forEach((item, i) => validateAgainst(item, s['items'], root, `${path}/${i}`, errors));
    }
  }

  if (isObject(value)) {
    const props = isObject(s['properties']) ? (s['properties'] as Record<string, unknown>) : {};
    const required = Array.isArray(s['required']) ? (s['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    for (const key of required) {
      if (!(key in value)) errors.push({ path: path ? `${path}/${key}` : `/${key}`, message: `missing required property '${key}'` });
    }
    for (const [key, val] of Object.entries(value)) {
      if (key in props) {
        validateAgainst(val, props[key], root, `${path}/${key}`, errors);
      } else if (s['additionalProperties'] === false) {
        errors.push({ path: path ? `${path}/${key}` : `/${key}`, message: `additional property '${key}' not allowed` });
      } else if (isObject(s['additionalProperties'])) {
        validateAgainst(val, s['additionalProperties'], root, `${path}/${key}`, errors);
      }
    }
  }
}

export interface StructuredResult {
  ok: boolean;
  value?: unknown;
  errors: ValidationError[];
}

// Strip markdown fences the model may wrap around JSON, then parse.
export function extractJson(text: string): { value?: unknown; parseError?: string } {
  let cleaned = (text || '').trim();
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence && typeof fence[1] === 'string') cleaned = fence[1].trim();
  if (!cleaned) return { parseError: 'empty response, expected JSON' };
  try {
    return { value: JSON.parse(cleaned) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { parseError: `invalid JSON: ${msg}` };
  }
}

export function validateStructuredOutput(text: string, format: ResponseFormat | undefined): StructuredResult {
  if (!format || format.type === 'text') return { ok: true, errors: [] };
  const { value, parseError } = extractJson(text);
  if (parseError) return { ok: false, errors: [{ path: '', message: parseError }] };
  if (format.type === 'json_object') return { ok: true, value, errors: [] };
  const schema = format.json_schema?.schema;
  if (!isObject(schema)) return { ok: true, value, errors: [] };
  const errors: ValidationError[] = [];
  validateAgainst(value, schema, schema, '', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value, errors: [] };
}

// Human-readable one-liner for the retry feedback message.
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.slice(0, 5).map(e => `${e.path || '<root>'}: ${e.message}`).join('; ');
}
