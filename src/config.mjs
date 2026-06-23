export const config = {
  port: parseInt(process.env.UNIBRIDGE_PORT || '5200', 10),
  defaultBackend: process.env.UNIBRIDGE_DEFAULT_BACKEND || null,
  logFile: process.env.UNIBRIDGE_LOG || '/tmp/unibridge.log',
  backends: {
    opencode: {
      baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:5100',
      defaultModel: process.env.OPENCODE_DEFAULT_MODEL || 'big-pickle',
    },
  },
  modelAliases: parseAliases(),
};

function parseAliases() {
  const aliases = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('UNIBRIDGE_ALIAS_')) {
      const model = key.slice('UNIBRIDGE_ALIAS_'.length).replace(/_/g, '-').toLowerCase();
      aliases[model] = value;
    }
  }
  return aliases;
}

export function resolveBackend(requestModel) {
  if (!requestModel) return null;
  const lower = requestModel.toLowerCase().trim();

  // Explicit format: "backend/model" (e.g. "opencode/big-pickle")
  if (lower.includes('/')) {
    const [backend, modelId] = lower.split('/', 2);
    if (config.backends[backend]) {
      return { backend: config.backends[backend], backendName: backend, modelId: modelId || null };
    }
  }

  // Check alias map (e.g. UNIBRIDGE_ALIAS_big-pickle=opencode)
  const fromAlias = config.modelAliases[lower];
  if (fromAlias && config.backends[fromAlias]) {
    return { backend: config.backends[fromAlias], backendName: fromAlias, modelId: lower };
  }

  // Fall back to default backend
  if (config.defaultBackend && config.backends[config.defaultBackend]) {
    return { backend: config.backends[config.defaultBackend], backendName: config.defaultBackend, modelId: lower };
  }

  return null;
}
