import { config, resolveBackend as resolveRoute } from '../config.js';

export interface ModelInfo {
  id: string;
  object: string;
}

export interface BackendModule {
  name: string;
  init?: (config: any) => Promise<any>;
  listModels?: (config: any, ctx: any) => ModelInfo[];
  complete: Function;
  embed?: Function;
}

export interface RegisteredBackend {
  name: string;
  init?: Function;
  listModels?: Function;
  complete: Function;
  embed?: Function | null;
  ctx: any;
}

export interface RoutedBackend {
  backend: RegisteredBackend;
  backendConfig: any;
  model: string;
}

const backends = new Map<string, RegisteredBackend>();

export function register(backendModule: BackendModule): void {
  const { name, init, listModels, complete, embed } = backendModule;
  if (!name || !complete) {
    throw new Error(`Invalid backend module: missing 'name' or 'complete()'`);
  }
  backends.set(name, { name, init, listModels, complete, embed: embed || null, ctx: null });
}

export async function initAll(): Promise<void> {
  for (const [name, be] of backends) {
    const beConfig = config.backends[name];
    if (beConfig && be.init) {
      try {
        be.ctx = await (be.init as (config: any) => Promise<any>)(beConfig);
      } catch (e: any) {
        console.error(`unibridge: backend "${name}" init failed: ${e.message}`);
      }
    }
  }
}

export function getBackend(name: string): RegisteredBackend | null {
  return backends.get(name) || null;
}

export function allModels(): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const [, be] of backends) {
    const beConfig = config.backends[be.name];
    if (beConfig && be.listModels && be.ctx) {
      models.push(...(be.listModels as (config: any, ctx: any) => ModelInfo[])(beConfig, be.ctx));
    }
  }
  return models;
}

export function listBackends(): string[] {
  return Array.from(backends.keys());
}

export async function route(requestModel: string): Promise<RoutedBackend | null> {
  const resolved = resolveRoute(requestModel);
  if (!resolved) return null;

  const be = backends.get(resolved.backendName);
  if (!be) return null;

  return {
    backend: be,
    backendConfig: resolved.backend,
    model: resolved.model,
  };
}
