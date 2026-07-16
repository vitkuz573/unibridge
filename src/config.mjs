import fs from 'node:fs';
import path from 'node:path';

const BACKEND_NAMES = new Set(['opencode', 'kilocode', 'mimocode', 'openai']);

function findConfig() {
  if (process.env.UNIBRIDGE_CONFIG) {
    return process.env.UNIBRIDGE_CONFIG;
  }
  const cwd = process.cwd();
  for (const name of ['unibridge.json', 'unibridge.jsonc']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    for (const name of ['.unibridge.json', '.unibridge.jsonc']) {
      const p = path.join(home, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function getConfigPath() {
  return findConfig();
}

function applyEnvOverrides(cfg) {
  if (process.env.UNIBRIDGE_PORT) cfg.port = parseInt(process.env.UNIBRIDGE_PORT, 10);
  if (process.env.UNIBRIDGE_HOST) cfg.host = process.env.UNIBRIDGE_HOST;
  if (process.env.UNIBRIDGE_DEFAULT_BACKEND) cfg.defaultBackend = process.env.UNIBRIDGE_DEFAULT_BACKEND;
  if (process.env.UNIBRIDGE_LOG) cfg.logFile = process.env.UNIBRIDGE_LOG;
  if (process.env.UNIBRIDGE_VERBOSE) cfg.verbose = process.env.UNIBRIDGE_VERBOSE === 'true';
}

export function validateConfig(cfg) {
  const errors = [];
  if (cfg.port && (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535)) {
    errors.push(`Invalid port: ${cfg.port}`);
  }
  if (cfg.defaultBackend && !cfg.backends[cfg.defaultBackend]) {
    errors.push(`defaultBackend "${cfg.defaultBackend}" not found in backends`);
  }
  for (const [name, be] of Object.entries(cfg.backends || {})) {
    if (!BACKEND_NAMES.has(name)) {
      errors.push(`Unknown backend "${name}". Valid: ${[...BACKEND_NAMES].join(', ')}`);
    }
  }
  for (const [alias, backendName] of Object.entries(cfg.aliases || {})) {
    if (!cfg.backends[backendName]) {
      errors.push(`Alias "${alias}" points to unknown backend "${backendName}"`);
    }
  }
  return errors;
}

function loadConfig() {
  const configPath = findConfig();
  let cfg = {
    port: 5200,
    host: '127.0.0.1',
    defaultBackend: null,
    backends: {},
    aliases: {},
    logFile: '/tmp/unibridge.log',
    apiKey: '',
    rateLimit: { windowMs: 60_000, max: 60 },
    verbose: false,
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

  applyEnvOverrides(cfg);

  const errors = validateConfig(cfg);
  for (const err of errors) {
    console.error(`unibridge: config warning: ${err}`);
  }

  return { ...cfg, _configPath: configPath };
}

export const config = {};
const listeners = new Set();
let configPath = null;

export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(newCfg) {
  for (const fn of listeners) {
    try { fn(newCfg); } catch {}
  }
}

function reload() {
  const newCfg = loadConfig();
  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, newCfg);
  configPath = newCfg._configPath;
  notifyListeners(config);
}

export function watchConfig() {
  if (configPath && !process.env.UNIBRIDGE_CONFIG) {
    fs.watchFile(configPath, { interval: 2000 }, () => {
      try {
        reload();
        console.error(`unibridge: config reloaded from ${configPath}`);
      } catch (e) {
        console.error(`unibridge: config reload failed: ${e.message}`);
      }
    });
  }
}

// Initialize
const initial = loadConfig();
Object.assign(config, initial);
configPath = initial._configPath;

export function resolveBackend(requestModel) {
  if (!requestModel) return null;
  const trimmed = requestModel.trim();
  const lower = trimmed.toLowerCase();

  if (lower.includes('/')) {
    const idx = lower.indexOf('/');
    const name = lower.slice(0, idx);
    const model = trimmed.slice(idx + 1);
    if (config.backends[name]) {
      return { backend: config.backends[name], backendName: name, model };
    }
  }

  const fromAlias = config.aliases[lower];
  if (fromAlias && config.backends[fromAlias]) {
    return { backend: config.backends[fromAlias], backendName: fromAlias, model: trimmed };
  }

  if (config.defaultBackend && config.backends[config.defaultBackend]) {
    return { backend: config.backends[config.defaultBackend], backendName: config.defaultBackend, model: trimmed };
  }

  return null;
}
