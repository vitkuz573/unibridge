import fs from 'node:fs';
import path from 'node:path';

const BACKEND_NAMES = new Set(['opencode', 'kilocode', 'mimocode', 'openai']);

const BACKEND_DEFAULTS = {
  opencode: { rateLimit: { windowMs: 60_000, max: 30 } },
  kilocode: { rateLimit: { windowMs: 60_000, max: 30 } },
  mimocode: { rateLimit: { windowMs: 60_000, max: 30 } },
  openai: { rateLimit: { windowMs: 60_000, max: 30 } },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

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
    cache: { enabled: false, ttl: 60 },
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

  for (const [name, defaults] of Object.entries(BACKEND_DEFAULTS)) {
    if (cfg.backends[name]) {
      cfg.backends[name] = deepMerge(defaults, cfg.backends[name]);
    }
  }

  const errors = validateConfig(cfg);
  for (const err of errors) {
    console.error(`unibridge: config warning: ${err}`);
  }

  return { ...cfg, _configPath: configPath };
}

export const config = {};
const listeners = new Set();
export let configPath = null;

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
  const errors = validateConfig(newCfg);
  if (errors.length > 0) {
    for (const err of errors) console.error(`unibridge: config validation: ${err}`);
  }
  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, newCfg);
  configPath = newCfg._configPath;
  notifyListeners(config);
}

export function watchConfig(callback) {
  const cfgPath = configPath;
  if (!cfgPath || process.env.UNIBRIDGE_CONFIG) return;

  let debounceTimer = null;
  try {
    const watcher = fs.watch(cfgPath, (eventType) => {
      if (eventType !== 'change') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          reload();
          console.error(`unibridge: config reloaded from ${cfgPath}`);
          if (callback) callback(config);
        } catch (e) {
          console.error(`unibridge: config reload failed: ${e.message}`);
        }
      }, 500);
    });
    watcher.on('error', (e) => {
      console.error(`unibridge: config watch error: ${e.message}`);
    });
  } catch {
    fs.watchFile(cfgPath, { interval: 2000 }, () => {
      try {
        reload();
        console.error(`unibridge: config reloaded from ${cfgPath}`);
        if (callback) callback(config);
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

  const fromAlias = config.aliases[lower];
  if (fromAlias && config.backends[fromAlias]) {
    return { backend: config.backends[fromAlias], backendName: fromAlias, model: trimmed };
  }

  if (lower.includes('/')) {
    const idx = lower.indexOf('/');
    const name = lower.slice(0, idx);
    const model = trimmed.slice(idx + 1);
    if (config.backends[name]) {
      return { backend: config.backends[name], backendName: name, model };
    }
  }

  if (config.defaultBackend && config.backends[config.defaultBackend]) {
    return { backend: config.backends[config.defaultBackend], backendName: config.defaultBackend, model: trimmed };
  }

  return null;
}
