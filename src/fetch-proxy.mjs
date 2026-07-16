import { createRequire } from 'node:module';

let undici;

async function loadUndici() {
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

export async function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  const mod = await loadUndici();
  if (!mod?.ProxyAgent) {
    console.warn(`unibridge: proxy configured but undici not available, ignoring proxy`);
    return undefined;
  }
  return new mod.ProxyAgent(proxyUrl);
}

export async function proxyFetch(url, opts, dispatcher) {
  if (dispatcher) {
    opts = { ...opts, dispatcher };
  }
  return fetch(url, opts);
}
