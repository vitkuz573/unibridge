interface UndiciModule {
  ProxyAgent: new (url: string) => unknown;
}

let undici: UndiciModule | null = null;

async function loadUndici(): Promise<UndiciModule | null> {
  if (undici) return undici;
  try {
    // @ts-expect-error — undici is an optional peer dependency, may not be installed
    const mod = await import('undici');
    if (mod && typeof mod.ProxyAgent === 'function') {
      undici = mod as unknown as UndiciModule;
    }
  } catch {
    undici = null;
  }
  return undici;
}

export async function createProxyAgent(proxyUrl?: string): Promise<unknown> {
  if (!proxyUrl) return undefined;
  const mod = await loadUndici();
  if (!mod?.ProxyAgent) {
    console.warn(`unibridge: proxy configured but undici not available, ignoring proxy`);
    return undefined;
  }
  return new mod.ProxyAgent(proxyUrl);
}

export async function proxyFetch(url: string | URL, opts: RequestInit, dispatcher?: unknown): Promise<Response> {
  if (dispatcher) {
    return fetch(url, { ...opts, dispatcher } as RequestInit & { dispatcher: unknown });
  }
  return fetch(url, opts);
}
