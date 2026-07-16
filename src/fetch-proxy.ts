import { createRequire } from 'node:module';

let undici: any;

async function loadUndici(): Promise<any> {
  if (undici) return undici;
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve('undici');
    undici = await import(path);
  } catch {
    undici = null;
  }
  return undici;
}

export async function createProxyAgent(proxyUrl?: string): Promise<any> {
  if (!proxyUrl) return undefined;
  const mod = await loadUndici();
  if (!mod?.ProxyAgent) {
    console.warn(`unibridge: proxy configured but undici not available, ignoring proxy`);
    return undefined;
  }
  return new mod.ProxyAgent(proxyUrl);
}

export async function proxyFetch(url: string | URL, opts: RequestInit, dispatcher?: any): Promise<Response> {
  if (dispatcher) {
    opts = { ...opts, dispatcher } as any;
  }
  return fetch(url, opts);
}
