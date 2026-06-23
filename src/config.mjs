import fs from 'node:fs';
import path from 'node:path';

function findConfig() {
  // 1. Explicit env override
  if (process.env.UNIBRIDGE_CONFIG) {
    return process.env.UNIBRIDGE_CONFIG;
  }
  // 2. CWD
  const cwd = process.cwd();
  for (const name of ['unibridge.json', 'unibridge.jsonc']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  // 3. Home dir
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    for (const name of ['.unibridge.json', '.unibridge.jsonc']) {
      const p = path.join(home, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function loadConfig() {
  const configPath = findConfig();
  let cfg = {
    port: 5200,
    defaultBackend: null,
    backends: {},
    aliases: {},
    logFile: '/tmp/unibridge.log',
  };

  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      cfg = { ...cfg, ...parsed };
    } catch (e) {
      console.error(`unibridge: failed to read ${configPath}: ${e.message}`);
    }
  }

  // Env overrides for top-level settings only
  if (process.env.UNIBRIDGE_PORT) cfg.port = parseInt(process.env.UNIBRIDGE_PORT, 10);
  if (process.env.UNIBRIDGE_DEFAULT_BACKEND) cfg.defaultBackend = process.env.UNIBRIDGE_DEFAULT_BACKEND;
  if (process.env.UNIBRIDGE_LOG) cfg.logFile = process.env.UNIBRIDGE_LOG;

  // Backend configs come ONLY from config file. No env var convention.
  // Each backend type knows its own config shape.

  return cfg;
}

export const config = loadConfig();

export function resolveBackend(requestModel) {
  if (!requestModel) return null;
  const lower = requestModel.toLowerCase().trim();

  // Explicit: "backend/model"
  if (lower.includes('/')) {
    const [name, modelId] = lower.split('/', 2);
    if (config.backends[name]) {
      return { backend: config.backends[name], backendName: name, modelId: modelId || null };
    }
  }

  // Alias map
  const fromAlias = config.aliases[lower];
  if (fromAlias && config.backends[fromAlias]) {
    return { backend: config.backends[fromAlias], backendName: fromAlias, modelId: lower };
  }

  // Default backend
  if (config.defaultBackend && config.backends[config.defaultBackend]) {
    return { backend: config.backends[config.defaultBackend], backendName: config.defaultBackend, modelId: lower };
  }

  return null;
}
