interface UndiciModule {
  ProxyAgent: new (url: string) => unknown;
}

let undici: UndiciModule | null = null;

async function loadUndici(): Promise<UndiciModule | null> {
  if (undici) return undici;
  try {
    // undici is an optional peer dependency: its types ship with @types/node
    // (undici-types) while the runtime package may be absent and caught below.
    const mod = await import('undici');
    if (mod && typeof mod.ProxyAgent === 'function') {
      undici = mod as unknown as UndiciModule;
    }
  } catch {
    undici = null;
  }
  return undici;
}

export async function createProxyAgent(proxyUrl?: string): Promise<object | undefined> {
  if (!proxyUrl) return undefined;
  const mod = await loadUndici();
  if (!mod?.ProxyAgent) {
    console.warn(`unibridge: proxy configured but undici not available, ignoring proxy`);
    return undefined;
  }
  return new mod.ProxyAgent(proxyUrl) as object;
}

export async function proxyFetch(url: string | URL, opts: RequestInit, dispatcher?: object): Promise<Response> {
  if (dispatcher) {
    return fetch(url, { ...opts, dispatcher } as RequestInit & { dispatcher: object });
  }
  return fetch(url, opts);
}
