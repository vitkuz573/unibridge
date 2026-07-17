import fs from 'node:fs';
import path from 'node:path';

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface BackendConfig {
  [key: string]: unknown;
  rateLimit?: RateLimitConfig;
  baseUrl?: string;
  apiKey?: string;
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
}

export interface UnibridgeConfig {
  port: number;
  host: string;
  defaultBackend: string | null;
  backends: Record<string, BackendConfig>;
  aliases: Record<string, string>;
  logFile: string;
  apiKey: string;
  rateLimit: RateLimitConfig;
  cache: CacheConfig;
  verbose: boolean;
  streaming: boolean;
}

export interface ResolvedBackend {
  backend: BackendConfig;
  backendName: string;
  model: string;
}

let _BACKEND_NAMES: Set<string> | null = null;
function getBackendNames(): Set<string> {
  if (!_BACKEND_NAMES) {
    _BACKEND_NAMES = new Set(['opencode', 'kilocode', 'mimocode', 'openai']);
  }
  return _BACKEND_NAMES;
}

const BACKEND_DEFAULTS: Record<string, { rateLimit: RateLimitConfig }> = {
  opencode: { rateLimit: { windowMs: 60_000, max: 30 } },
  kilocode: { rateLimit: { windowMs: 60_000, max: 30 } },
  mimocode: { rateLimit: { windowMs: 60_000, max: 30 } },
  openai: { rateLimit: { windowMs: 60_000, max: 30 } },
};

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)
        && tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function findConfig(): string | null {
  if (process.env['UNIBRIDGE_CONFIG']) {
    return process.env['UNIBRIDGE_CONFIG'];
  }
  const cwd = process.cwd();
  for (const name of ['unibridge.json', 'unibridge.jsonc']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  const home = process.env['HOME'] || process.env['USERPROFILE'];
  if (home) {
    for (const name of ['.unibridge.json', '.unibridge.jsonc']) {
      const p = path.join(home, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function getConfigPath(): string | null {
  return findConfig();
}

function applyEnvOverrides(cfg: UnibridgeConfig): void {
  if (process.env['UNIBRIDGE_PORT']) cfg.port = parseInt(process.env['UNIBRIDGE_PORT'], 10);
  if (process.env['UNIBRIDGE_HOST']) cfg.host = process.env['UNIBRIDGE_HOST'];
  if (process.env['UNIBRIDGE_DEFAULT_BACKEND']) cfg.defaultBackend = process.env['UNIBRIDGE_DEFAULT_BACKEND'];
  if (process.env['UNIBRIDGE_LOG']) cfg.logFile = process.env['UNIBRIDGE_LOG'];
  if (process.env['UNIBRIDGE_VERBOSE']) cfg.verbose = process.env['UNIBRIDGE_VERBOSE'] === 'true';
  if (process.env['UNIBRIDGE_STREAMING']) cfg.streaming = process.env['UNIBRIDGE_STREAMING'] === 'true';
}

export function validateConfig(cfg: UnibridgeConfig): string[] {
  const errors: string[] = [];
  if (cfg.port && (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535)) {
    errors.push(`Invalid port: ${cfg.port}`);
  }
  if (cfg.defaultBackend && !cfg.backends[cfg.defaultBackend]) {
    errors.push(`defaultBackend "${cfg.defaultBackend}" not found in backends`);
  }
  for (const [name] of Object.entries(cfg.backends || {})) {
    if (!getBackendNames().has(name)) {
      errors.push(`Unknown backend "${name}". Valid: ${[...getBackendNames()].join(', ')}`);
    }
  }
  for (const [alias, backendName] of Object.entries(cfg.aliases || {})) {
    if (!cfg.backends[backendName]) {
      errors.push(`Alias "${alias}" points to unknown backend "${backendName}"`);
    }
  }
  return errors;
}

interface LoadedConfig extends UnibridgeConfig {
  _configPath: string | null;
}

function loadConfig(): LoadedConfig {
  const configPath = findConfig();
  let cfg: LoadedConfig = {
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
    streaming: false,
    _configPath: configPath,
  };

  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      cfg = { ...cfg, ...parsed, _configPath: configPath };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`unibridge: failed to read ${configPath}: ${msg}`);
    }
  }

  applyEnvOverrides(cfg);

  for (const [name, defaults] of Object.entries(BACKEND_DEFAULTS)) {
    if (cfg.backends[name]) {
      cfg.backends[name] = deepMerge(
        defaults as Record<string, unknown>,
        cfg.backends[name] as Record<string, unknown>,
      ) as BackendConfig;
    }
  }

  const errors = validateConfig(cfg);
  for (const err of errors) {
    console.error(`unibridge: config warning: ${err}`);
  }

  return cfg;
}

// Empty object used as a mutable singleton; immediately populated via Object.assign
export const config: UnibridgeConfig = {} as UnibridgeConfig;
const listeners: Set<(cfg: UnibridgeConfig) => void> = new Set();
export let configPath: string | null = null;

export function onConfigChange(fn: (cfg: UnibridgeConfig) => void): () => boolean {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(newCfg: UnibridgeConfig): void {
  for (const fn of listeners) {
    try { fn(newCfg); } catch {}
  }
}

function reload(): void {
  const newCfg = loadConfig();
  const errors = validateConfig(newCfg);
  if (errors.length > 0) {
    for (const err of errors) console.error(`unibridge: config validation: ${err}`);
  }
  const mutable = config as unknown as Record<string, unknown>;
  for (const k of Object.keys(config)) {
    delete mutable[k];
  }
  Object.assign(config, newCfg);
  configPath = newCfg._configPath;
  notifyListeners(config);
}

export function watchConfig(callback?: (cfg: UnibridgeConfig) => void): void {
  const cfgPath = configPath;
  if (!cfgPath || process.env['UNIBRIDGE_CONFIG']) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher = fs.watch(cfgPath, (eventType: string | null) => {
      if (eventType !== 'change') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          reload();
          console.error(`unibridge: config reloaded from ${cfgPath}`);
          if (callback) callback(config);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`unibridge: config reload failed: ${msg}`);
        }
      }, 500);
    });
    watcher.on('error', (e: Error) => {
      console.error(`unibridge: config watch error: ${e.message}`);
    });
  } catch {
    fs.watchFile(cfgPath, { interval: 2000 }, () => {
      try {
        reload();
        console.error(`unibridge: config reloaded from ${cfgPath}`);
        if (callback) callback(config);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`unibridge: config reload failed: ${msg}`);
      }
    });
  }
}

// Initialize
const initial = loadConfig();
Object.assign(config, initial);
configPath = initial._configPath;

export function resolveBackend(requestModel: string): ResolvedBackend | null {
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
    const backend = config.backends[config.defaultBackend];
    return { backend: backend!, backendName: config.defaultBackend, model: trimmed };
  }

  return null;
}
