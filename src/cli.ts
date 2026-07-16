#!/usr/bin/env node

const args: string[] = process.argv.slice(2);
const help = `
unibridge — Universal OpenAI-compatible proxy for any LLM backend

Usage:
  unibridge                    Start proxy (uses unibridge.json)
  unibridge --port 5200        Override port
  unibridge --config ./cfg.json  Explicit config path
  unibridge --log ./unibridge.log  Log file path
  unibridge --host 0.0.0.0     Bind to all interfaces
  unibridge --streaming        Enable streaming for opencode/mimocode backends
  unibridge --help             Show this message

Environment variables:
  UNIBRIDGE_PORT      Listen port
  UNIBRIDGE_CONFIG    Explicit config path
  UNIBRIDGE_LOG       Log file
  UNIBRIDGE_HOST      Bind host (default: 127.0.0.1)
  UNIBRIDGE_STREAMING Enable streaming for opencode/mimocode backends (true/false)
`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(help);
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && args[i + 1]) {
    process.env.UNIBRIDGE_PORT = args[++i];
  } else if (arg === '--config' && args[i + 1]) {
    process.env.UNIBRIDGE_CONFIG = args[++i];
  } else if (arg === '--log' && args[i + 1]) {
    process.env.UNIBRIDGE_LOG = args[++i];
  } else if (arg === '--host' && args[i + 1]) {
    process.env.UNIBRIDGE_HOST = args[++i];
  } else if (arg === '--streaming') {
    process.env.UNIBRIDGE_STREAMING = 'true';
  }
}

const { start } = await import('./proxy.js');
start();
