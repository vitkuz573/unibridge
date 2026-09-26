import { config, resolveBackend as resolveRoute } from '../config.js';
import type {
  BaseBackendContext,
  ChatRequest,
  ChatCompletionResponse,
  EmbedRequest,
  EmbeddingResponse,
  CompleteStreamingFn,
  ResponsesFn,
  ResponsesStreamingFn,
  ModelInfo,
} from '../types.js';
import type { BackendConfig } from '../config.js';

export type { ModelInfo } from '../types.js';

export interface BackendModule {
  name: string;
  init?: (config: BackendConfig) => Promise<BaseBackendContext>;
  listModels?: (config: BackendConfig, ctx: BaseBackendContext | null) => ModelInfo[];
  complete: (
    config: BackendConfig,
    request: ChatRequest,
    ctx: BaseBackendContext | null
  ) => Promise<ChatCompletionResponse>;
  embed?: (
    config: BackendConfig,
    request: EmbedRequest,
    ctx: BaseBackendContext | null
  ) => Promise<EmbeddingResponse>;
  completeStreaming?: CompleteStreamingFn;
  responses?: ResponsesFn;
  responsesStreaming?: ResponsesStreamingFn;
}

export interface RegisteredBackend {
  name: string;
  init?: (config: BackendConfig) => Promise<BaseBackendContext>;
  listModels?: (config: BackendConfig, ctx: BaseBackendContext | null) => ModelInfo[];
  complete: (
    config: BackendConfig,
    request: ChatRequest,
    ctx: BaseBackendContext | null
  ) => Promise<ChatCompletionResponse>;
  completeStreaming?: CompleteStreamingFn;
  responses?: ResponsesFn;
  responsesStreaming?: ResponsesStreamingFn;
  embed?: (
    config: BackendConfig,
    request: EmbedRequest,
    ctx: BaseBackendContext | null
  ) => Promise<EmbeddingResponse>;
  ctx: BaseBackendContext | null;
}

export interface RoutedBackend {
  backend: RegisteredBackend;
  backendConfig: BackendConfig;
  model: string;
}

const backends = new Map<string, RegisteredBackend>();

export function register(backendModule: BackendModule): void {
  const { name, init, listModels, complete, completeStreaming, embed, responses, responsesStreaming } = backendModule;
  if (!name || !complete) {
    throw new Error(`Invalid backend module: missing 'name' or 'complete()'`);
  }
  backends.set(name, { name, init, listModels, complete, completeStreaming, embed: embed ?? undefined, responses: responses ?? undefined, responsesStreaming: responsesStreaming ?? undefined, ctx: null });
}

export async function initAll(): Promise<void> {
  for (const [name, be] of backends) {
    const beConfig = config.backends[name];
    if (beConfig && be.init) {
      try {
        be.ctx = await be.init(beConfig);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`unibridge: backend "${name}" init failed: ${message}`);
      }
    }
  }
}

/**
 * Retry initialization for backends that are registered but have no context
 * yet (their server was unavailable at startup). Never throws: the caller is a
 * timer.
 */
export async function initMissing(): Promise<void> {
  for (const [name, be] of backends) {
    const beConfig = config.backends[name];
    if (!beConfig || !be.init || be.ctx) continue;
    try {
      be.ctx = await be.init(beConfig);
      console.error(`unibridge: backend "${name}" initialized (${be.ctx.models?.length ?? 0} models)`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`unibridge: backend "${name}" init retry failed: ${message}`);
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
      models.push(...be.listModels(beConfig, be.ctx));
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
