import type { ChatCompletionResponse, ResponseObject, Message } from './types.js';

type CacheValue = ChatCompletionResponse | ResponseObject | Record<string, unknown>;

interface CacheEntry {
  value: CacheValue;
  ts: number;
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private ttl = 60_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs?: number) {
    if (ttlMs !== undefined) this.ttl = ttlMs;
  }

  get size(): number {
    return this.cache.size;
  }

  setTTL(ttlMs: number): void {
    this.ttl = ttlMs;
  }

  key(
    backend: string,
    model: string,
    messages: Message[],
    maxTokens: number | undefined,
    extra?: Record<string, unknown>,
  ): string {
    // Cache key must cover everything that changes the reply: backend,
    // model, full message history (incl. tool results), sampling params
    // and the response contract (response_format/tools/tool_choice).
    // Omitting any of these returns a wrong cached reply.
    return `${backend}:${model}:${JSON.stringify(messages)}:${maxTokens || ''}:${JSON.stringify(extra || {})}`;
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
