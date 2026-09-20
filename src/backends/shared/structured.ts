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
// repair=true additionally attempts to salvage common model breakage:
// trailing prose after the JSON payload, truncated tails (unclosed
// brackets/quotes from max_tokens cuts). Pure extraction — the result is
// still validated against the schema, so nothing invalid can slip through.
export function extractJson(text: string, repair = false): { value?: unknown; parseError?: string; ok: boolean } {
  let cleaned = (text || '').trim();
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence && typeof fence[1] === 'string') cleaned = fence[1].trim();
  if (!cleaned) return { parseError: 'empty response, expected JSON', ok: false };
  const direct = tryParse(cleaned);
  if (direct.ok || !repair) return direct;
  // 1. Leading prose (for example a model sentence before the JSON object).
  const start = cleaned.search(/[{[]/);
  if (start > 0) {
    cleaned = cleaned.slice(start).trim();
    const withoutPrefix = tryParse(cleaned);
    if (withoutPrefix.ok) return withoutPrefix;
  }
  // 2. Trailing prose: cut at the last plausible JSON end.
  const trimmed = cutTrailingProse(cleaned);
  if (trimmed !== cleaned) {
    const r = tryParse(trimmed);
    if (r.ok) return r;
    cleaned = trimmed;
  }
  // 3. Truncated tail: close open brackets/quotes greedily.
  const closed = closeTruncated(cleaned);
  if (closed !== cleaned) return tryParse(closed);
  return direct;
}

function tryParse(s: string): { value?: unknown; parseError?: string; ok: boolean } {
  try {
    return { value: JSON.parse(s), ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { parseError: `invalid JSON: ${msg}`, ok: false };
  }
}

// Drop everything after the final closing brace/bracket when followed by
// non-JSON prose. Finds the last `}` or `]` and checks the prefix parses.
function cutTrailingProse(s: string): string {
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}' || ch === ']') {
      const prefix = s.slice(0, i + 1).trim();
      if (prefix) return prefix;
    }
  }
  return s;
}

// Close unclosed strings/brackets: walk the text tracking JSON structure
// (string-aware), then append the missing closers in reverse order.
function closeTruncated(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
    }
  }
  let out = s;
  if (inStr) out += '"';
  while (stack.length > 0) out += stack.pop();
  return out;
}

export function validateStructuredOutput(
  text: string,
  format: ResponseFormat | undefined,
  opts?: { repair?: boolean },
): StructuredResult {
  if (!format || format.type === 'text') return { ok: true, errors: [] };
  const { value, parseError } = extractJson(text, opts?.repair);
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

// Compact schema reminder for the FIRST attempt: the exact JSON contract
// (field names, types, required, enum) as text the model can follow.
// Same bytes the client sent in response_format — contract transmission,
// not invented instructions. Bounded (~1200 chars) to save tokens.
export function schemaReminder(format: ResponseFormat | undefined): string | undefined {
  if (!format || format.type !== 'json_schema') return undefined;
  const schema = format.json_schema?.schema;
  if (!isObject(schema)) return undefined;
  const compact = compactSchema(schema, schema);
  const trimmed = compact.length > 1200 ? `${compact.slice(0, 1200)}…` : compact;
  return `Reply with raw JSON only, exactly matching this schema (use these exact field names, all required fields, no extra fields): ${trimmed}`;
}

// ---------------------------------------------------------------------------
// Retry feedback builder: turns validation errors into actionable guidance.
// Every level includes a compact schema reminder FIRST (field names +
// required, no prose) so the model sees the exact contract before the
// error list — zen models respond to concrete key lists, not to abstract
// complaints. Level 0: schema reminder + bare errors. Level 1: + key diff
// ("got X, expected one of [...]"). Level 2: + full compact excerpts for
// the failing paths.
// ---------------------------------------------------------------------------

function expectedKeys(schema: unknown, root: Record<string, unknown>): string[] {
  if (!isObject(schema)) return [];
  const s = resolveRef(schema, root);
  if (!isObject(s['properties'])) return [];
  return Object.keys(s['properties'] as Record<string, unknown>);
}

function schemaAtPath(schema: unknown, path: string, root: Record<string, unknown>): unknown {
  if (!path || path === '/') return schema;
  const segs = path.split('/').filter(Boolean);
  let cur: unknown = schema;
  for (const seg of segs) {
    if (!isObject(cur)) return undefined;
    const resolved: Record<string, unknown> = resolveRef(cur, root);
    const props = isObject(resolved['properties']) ? (resolved['properties'] as Record<string, unknown>) : undefined;
    if (props && seg in props) { cur = props[seg]; continue; }
    if (resolved['type'] === 'array' && /^\d+$/.test(seg)) {
      const items = resolved['items'];
      if (items !== undefined) { cur = items; continue; }
      return undefined;
    }
    return undefined;
  }
  return cur;
}

function compactSchema(schema: unknown, root: Record<string, unknown>): string {
  if (!isObject(schema)) return JSON.stringify(schema);
  const s = resolveRef(schema, root);
  const out: Record<string, unknown> = {};
  if (s['type'] !== undefined) out['type'] = s['type'];
  if (Array.isArray(s['enum'])) out['enum'] = s['enum'];
  if (Array.isArray(s['required'])) out['required'] = s['required'];
  if (s['additionalProperties'] === false) out['additionalProperties'] = false;
  if (isObject(s['properties'])) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s['properties'] as Record<string, unknown>)) {
      props[k] = compactSchema(v, root);
    }
    out['properties'] = props;
  }
  if (s['items'] !== undefined && (isObject(s['items']) || typeof s['items'] === 'boolean')) {
    out['items'] = isObject(s['items'])
      ? compactSchema(s['items'] as Record<string, unknown>, root)
      : s['items'];
  }
  return JSON.stringify(out);
}

export function buildRetryFeedback(
  rawText: string,
  format: ResponseFormat | undefined,
  errors: ValidationError[],
  level: number,
): string {
  const base = formatValidationErrors(errors);
  if (!format || format.type !== 'json_schema') return base;
  const schema = format.json_schema?.schema;
  if (!isObject(schema)) return base;
  const root = schema;
  // Schema reminder first: exact contract (required + properties) before
  // the complaint list. Compact (no whitespace) to save tokens.
  const reminder = `Expected JSON shape: ${compactSchema(schema, root)}.`;
  const hints: string[] = [];
  if (level >= 1) {
    // Key diff: for each missing/additional-property error, show what the
    // model produced vs what the schema expects at that path.
    for (const e of errors.slice(0, 5)) {
      const parentPath = e.path.includes('/')
        ? e.path.slice(0, e.path.lastIndexOf('/')) || '/'
        : '/';
      if (e.message.startsWith('missing required property')) {
        const expected = expectedKeys(schemaAtPath(schema, parentPath, root), root);
        if (expected.length > 0) {
          hints.push(`${e.path}: use one of [${expected.join(', ')}]`);
        }
      } else if (e.message.startsWith('additional property')) {
        const m = e.message.match(/'([^']+)'/);
        const expected = expectedKeys(schemaAtPath(schema, parentPath, root), root);
        if (m && expected.length > 0) {
          hints.push(`${e.path}: '${m[1]}' is not a valid key here, expected one of [${expected.join(', ')}]`);
        }
      }
    }
  }
  if (level >= 2) {
    // Compact schema excerpts for failing paths (bounded: 3 paths max).
    const seen = new Set<string>();
    for (const e of errors.slice(0, 3)) {
      const p = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) || '/' : '/';
      if (seen.has(p)) continue;
      seen.add(p);
      const sub = schemaAtPath(schema, p, root);
      if (sub !== undefined) hints.push(`schema at ${p || '/'}: ${compactSchema(sub, root)}`);
    }
  }
  const extra = hints.length > 0 ? ` Hints: ${hints.join(' | ')}` : '';
  void rawText;
  return `${reminder} Errors: ${base}.${extra}`;
}
