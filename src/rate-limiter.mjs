export function createRateLimiter(opts = {}) {
  const windowMs = opts.windowMs || 60_000;
  const max = opts.max || 60;
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.windowStart > windowMs * 2) hits.delete(key);
    }
  }, windowMs * 2).unref();

  return function check(ip) {
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      hits.set(ip, entry);
    }
    entry.count++;
    return entry.count > max ? (windowMs - (now - entry.windowStart)) : 0;
  };
}
