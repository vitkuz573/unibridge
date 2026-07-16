#!/usr/bin/env node

const args: string[] = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
unibridge — Universal OpenAI-compatible proxy for any LLM backend
  Route /v1/chat/completions, /v1/completions, and /v1/responses to
  pluggable backends: opencode, kilocode, mimocode, openai.

Usage
  unibridge                       Start proxy (reads unibridge.json from CWD)
  unibridge --port 5200           Override listen port
  unibridge --config ./cfg.json  Use explicit config file
  unibridge --host 0.0.0.0       Bind to all interfaces (default: 127.0.0.1)
  unibridge --log ./out.log      Write log to file
  unibridge --streaming          Enable streaming for opencode/mimocode
  unibridge --json               Print startup state as JSON and exit
  unibridge --help               Show this message

Options
  -p, --port <port>      Listen port (default: 5200)
  -c, --config <path>    Config file path (default: unibridge.json in CWD / ~/)
  -H, --host <addr>      Bind address (default: 127.0.0.1)
  -l, --log <path>       Log file (default: /tmp/unibridge.log)
  -s, --streaming        Enable streaming for opencode/mimocode backends
  -j, --json             Print startup state as JSON and exit
  -h, --help             Show this help message

Environment variables
  UNIBRIDGE_PORT             Listen port
  UNIBRIDGE_CONFIG           Explicit config file path
  UNIBRIDGE_LOG              Log file path
  UNIBRIDGE_HOST             Bind host (default: 127.0.0.1)
  UNIBRIDGE_DEFAULT_BACKEND  Default backend name
  UNIBRIDGE_STREAMING        Enable streaming (true / false)
  UNIBRIDGE_VERBOSE          Verbose logging (true / false)

Defaults
  port         5200
  host         127.0.0.1
  logFile      /tmp/unibridge.log
  configFile   unibridge.json (CWD → ~/)
  streaming    false

Examples
  # Start with defaults
  unibridge

  # Bind to all interfaces on port 8080
  unibridge --port 8080 --host 0.0.0.0

  # Use a specific config file
  unibridge --config ./my-backends.json

  # Print startup state for scripting / CI
  unibridge --json | jq .

  # Pipe JSON state into a monitoring tool
  unibridge --json --config prod.json | jq '.backends[].models | length'

  # Enable streaming for opencode/mimocode
  unibridge --streaming

References
  GitHub      https://github.com/vitkuz573/unibridge
  Docs        https://github.com/vitkuz573/unibridge#readme
  Schema      https://unibridge.dev/unibridge.schema.json
  Issues      https://github.com/vitkuz573/unibridge/issues
`);
  process.exit(0);
}

// Apply CLI flags to env vars before config is loaded (config.ts reads env on import)
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const next = args[i + 1];
  if ((arg === '--port' || arg === '-p') && next) {
    process.env['UNIBRIDGE_PORT'] = args[++i];
  } else if ((arg === '--config' || arg === '-c') && next) {
    process.env['UNIBRIDGE_CONFIG'] = args[++i];
  } else if ((arg === '--log' || arg === '-l') && next) {
    process.env['UNIBRIDGE_LOG'] = args[++i];
  } else if ((arg === '--host' || arg === '-H') && next) {
    process.env['UNIBRIDGE_HOST'] = args[++i];
  } else if (arg === '--streaming' || arg === '-s') {
    process.env['UNIBRIDGE_STREAMING'] = 'true';
  }
}

const jsonMode = args.includes('--json') || args.includes('-j');

// --json mode: load config, init backends, print state, exit
if (jsonMode) {
  const { config, configPath } = await import('./config.js');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { version: pkg } = require('../package.json');

  const registry = await import('./backends/registry.js');
  const opencode = await import('./backends/opencode.js');
  const kilocode = await import('./backends/kilocode.js');
  const mimocode = await import('./backends/mimocode.js');
  const openai = await import('./backends/openai.js');

  registry.register(opencode);
  registry.register(kilocode);
  registry.register(mimocode);
  registry.register(openai);
  await registry.initAll();

  interface BackendState {
    name: string;
    type: string;
    baseUrl: string;
    initialized: boolean;
    models: string[];
  }

  const backends: BackendState[] = [];
  for (const name of Object.keys(config.backends)) {
    const beCfg = config.backends[name];
    const models: string[] = [];
    try {
      const registered = registry.getBackend(name);
      if (registered?.ctx && beCfg && registered.listModels) {
        for (const m of registered.listModels(beCfg, registered.ctx)) {
          models.push(m.id);
        }
      }
    } catch {}
    backends.push({
      name,
      type: name,
      baseUrl: (beCfg?.['baseUrl'] as string) || '',
      initialized: !!registry.getBackend(name)?.ctx,
      models,
    });
  }

  const state = {
    version: pkg,
    configPath: configPath ?? null,
    port: config.port,
    host: config.host,
    defaultBackend: config.defaultBackend,
    streaming: config.streaming,
    apiKey: !!config.apiKey,
    cache: config.cache,
    backends,
    aliases: config.aliases,
  };

  console.log(JSON.stringify(state, null, 2));
  process.exit(0);
}

const { start } = await import('./proxy.js');
start();
