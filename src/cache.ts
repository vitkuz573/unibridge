import { createHash } from 'node:crypto';
import type { ChatCompletionResponse, ResponseObject } from './types.ts';

type CacheValue = ChatCompletionResponse | ResponseObject | Record<string, unknown>;

interface CacheEntry {
  value: CacheValue;
  ts: number;
}

/**
 * A stable, order-preserving form of a JSON value.
 *
 * Object keys are sorted so two requests that spell a parameter object in a
 * different order are the same request. Lists keep their order — the message
 * list *is* the conversation, and normalising it gives `[Q1, A1, Q2]` and
 * `[Q2, A1, Q1]` one key, which answers one question with another's transcript.
 *
 * `undefined` members are dropped so an omitted knob and an explicit
 * `undefined` are the same request, and `1` and `1.0` are the same number.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = canonical((value as Record<string, unknown>)[key]);
      if (member !== undefined) out[key] = member;
    }
    return out;
  }
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return value;
}

/**
 * The cache key for one request, derived from all of it.
 *
 * It used to be a hand-picked list — backend, model, messages, max_tokens, and a
 * fourth argument each handler assembled from whatever it happened to remember.
 * Two requests differing only in a knob nobody listed shared one entry, so the
 * gateway replayed a stored answer as if it were the answer to this one. Now a
 * parameter is in the key by construction, including ones added later, and a
 * handler cannot forget one.
 *
 * Hashed rather than concatenated: a `:` in a model id and a `:` in a backend
 * name used to be the same separator, so `{backend: "a:b", model: "c"}` and
 * `{backend: "a", model: "b:c"}` were one key.
 */
export function requestKey(backend: string, model: string, request: unknown): string {
  const payload = JSON.stringify({
    backend,
    model,
    request: canonical(request),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private ttl = 60_000;
  private maxEntries: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs?: number, maxEntries = 1000) {
    if (ttlMs !== undefined) this.ttl = ttlMs;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.cache.size;
  }

  setTTL(ttlMs: number): void {
    this.ttl = ttlMs;
  }

  get(key: string): CacheValue | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: CacheValue): void {
    // A plain Map grows until the process dies. Expiry alone is not a bound: a
    // long TTL with steady traffic is an out-of-memory kill, not a cache. This
    // is least-recently-written eviction, which is the useful direction here —
    // the entries nobody re-asks for are the ones worth dropping.
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, ts: Date.now() });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.ts > this.ttl) this.cache.delete(key);
    }
  }

  startCleanup(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), Math.max(this.ttl, 10_000));
    this.cleanupInterval.unref();
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
