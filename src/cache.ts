import type { ChatCompletionResponse, ResponseObject } from './types.js';
import type { Message } from './types.js';

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

  key(backend: string, model: string, messages: Message[], maxTokens: number | undefined): string {
    return `${backend}:${model}:${JSON.stringify(messages)}:${maxTokens || ''}`;
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
