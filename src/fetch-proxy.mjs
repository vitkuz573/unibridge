import { createRequire } from 'node:module';

let undici;

async function loadUndici() {
  if (!undici) {
    const require = createRequire(import.meta.url);
    const path = require.resolve('undici');
    undici = await import(path);
  }
  return undici;
}

export async function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  const { ProxyAgent } = await loadUndici();
  return new ProxyAgent(proxyUrl);
}

export async function proxyFetch(url, opts, dispatcher) {
  if (dispatcher) {
    opts = { ...opts, dispatcher };
  }
  return fetch(url, opts);
}
