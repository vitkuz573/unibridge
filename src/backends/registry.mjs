import { config, resolveBackend as resolveRoute } from '../config.mjs';

const backends = new Map();

export function register(backendModule) {
  const { name, init, listModels, complete } = backendModule;
  if (!name || !complete) {
    throw new Error(`Invalid backend module: missing 'name' or 'complete()'`);
  }
  backends.set(name, { name, init, listModels, complete, ctx: null });
}

export async function initAll() {
  for (const [name, be] of backends) {
    const beConfig = config.backends[name];
    if (beConfig && be.init) {
      be.ctx = await be.init(beConfig);
    }
  }
}

export function getBackend(name) {
  return backends.get(name) || null;
}

export function allModels() {
  const models = [];
  for (const [, be] of backends) {
    const beConfig = config.backends[be.name];
    if (beConfig && be.listModels) {
      models.push(...be.listModels(beConfig));
    }
  }
  return models;
}

export function listBackends() {
  return Array.from(backends.keys());
}

export async function route(requestModel) {
  const route = resolveRoute(requestModel);
  if (!route) return null;

  const be = backends.get(route.backendName);
  if (!be) return null;

  return {
    backend: be,
    backendConfig: route.backend,
    modelId: route.modelId,
  };
}
