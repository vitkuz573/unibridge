import http from 'node:http';
import { config, watchConfig, onConfigChange } from './config.js';
import type { UnibridgeConfig } from './config.js';
import * as registry from './backends/registry.js';
import * as opencodeBackend from './backends/opencode.js';
import * as kilocodeBackend from './backends/kilocode.js';
import * as mimocodeBackend from './backends/mimocode.js';
import * as openaiBackend from './backends/openai.js';
import { log, updateRateLimiters } from './utils.js';
import { ResponseCache } from './cache.js';
import { handleRequest } from './router.js';

registry.register(opencodeBackend);
registry.register(kilocodeBackend);
registry.register(mimocodeBackend);
registry.register(openaiBackend);
try { await registry.initAll(); } catch (e: unknown) {
  const msg = e instanceof Error ? e.stack || e.message : String(e);
  log('INIT ERR', msg);
}

log(`Backends: ${registry.listBackends().join(', ')}`);

const responseCache = new ResponseCache();

updateRateLimiters(config);

onConfigChange((cfg: UnibridgeConfig) => {
  updateRateLimiters(cfg);
  const cacheCfg = cfg.cache || { enabled: false, ttl: 60 };
  responseCache.setTTL((cacheCfg.ttl || 60) * 1000);
  if (cacheCfg.enabled) responseCache.startCleanup(); else { responseCache.stopCleanup(); responseCache.clear(); }
});

export function start(): void {
  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    await handleRequest(req, res, responseCache);
  });

  server.on('error', (e: Error) => {
    log('SERVER ERROR', e.stack || e.message);
  });

  const host = config.host || '127.0.0.1';
  server.listen(config.port, host, () => {
    log(`LISTEN ${host}:${config.port} backends=${registry.listBackends().join(',')}`);
    console.log(`unibridge ${host}:${config.port} [${registry.listBackends().join(', ')}]`);
    if (config.cache?.enabled) {
      responseCache.setTTL((config.cache.ttl || 60) * 1000);
      responseCache.startCleanup();
      log(`CACHE enabled ttl=${(config.cache.ttl || 60) * 1000}ms`);
    }
  });

  const shutdown = (signal: string): void => {
    log(`Received ${signal}, shutting down...`);
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      log('Forced shutdown');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  watchConfig((cfg: UnibridgeConfig) => {
    log(`Config reloaded. backends=${Object.keys(cfg.backends || {}).join(',')}`);
  });
}
