export interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
}

interface RateLimiterEntry {
  windowStart: number;
  count: number;
}

export function createRateLimiter(opts: RateLimiterOptions = {}): (ip: string) => number {
  const windowMs: number = opts.windowMs || 60_000;
  const max: number = opts.max || 60;
  const hits: Map<string, RateLimiterEntry> = new Map();

  const intervalId = setInterval((): void => {
    const now: number = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs * 2) hits.delete(key);
    }
  }, windowMs * 2);
  intervalId.unref();

  return function check(ip: string): number {
    const now: number = Date.now();
    let entry: RateLimiterEntry | undefined = hits.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      hits.set(ip, entry);
    }
    entry.count++;
    return entry.count > max ? (windowMs - (now - entry.windowStart)) : 0;
  };
}
