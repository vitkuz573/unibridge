import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Reasoning effort contract — opencode variants → GET /v1/models reasoning
// metadata → request variant. Ground truth (opencode 1.18.31): a model's
// `variants` map holds the option overrides opencode merges for the named
// variant; `variant: "default"` is the sentinel for "no override".
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sseEvent(type, properties) {
  return `data: ${JSON.stringify({ type, properties })}\n\n`;
}

function createOpencodeStub() {
  let messageBody = null;
  let promptBody = null;
  let messageCalls = 0;
  let sessionCount = 0;
  let currentSessionId = 'stub-session-0';
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'GET' && url === '/config/providers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        providers: [{
          id: 'opencode',
          models: {
            reasoner: {
              capabilities: { reasoning: true, toolcall: true, attachment: false, temperature: true },
              variants: {
                low: { reasoningEffort: 'low' },
                medium: { reasoningEffort: 'medium' },
                high: { reasoningEffort: 'high' },
              },
            },
            fixed: {
              capabilities: { reasoning: true, toolcall: true, attachment: false, temperature: true },
              variants: {},
            },
            plain: {
              capabilities: { reasoning: false, toolcall: false, attachment: false, temperature: false },
              variants: {},
            },
          },
        }],
      }));
      return;
    }
    if (req.method === 'POST' && url === '/session') {
      sessionCount++;
      currentSessionId = `stub-session-${sessionCount}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: currentSessionId }));
      return;
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/message$/.test(url)) {
      messageCalls++;
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        messageBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          parts: [{ type: 'text', text: 'pong' }],
          info: { tokens: { input: 1, output: 1 } },
        }));
      });
      return;
    }
    if (req.method === 'GET' && url === '/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(sseEvent('message.part.updated', { sessionID: currentSessionId, part: { id: 'p1', type: 'text' } }));
      res.write(sseEvent('message.part.delta', { sessionID: currentSessionId, partID: 'p1', field: 'text', delta: 'pong' }));
      res.write(sseEvent('message.updated', { sessionID: currentSessionId, info: { role: 'assistant', finish: 'stop', tokens: { input: 1, output: 1 } } }));
      res.write(sseEvent('session.idle', { sessionID: currentSessionId }));
      res.end();
      return;
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(url)) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        promptBody = JSON.parse(body);
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        messageBody: () => messageBody,
        promptBody: () => promptBody,
        messageCalls: () => messageCalls,
      });
    });
  });
}

async function withStub(run) {
  const stub = await createOpencodeStub();
  try {
    return await run(stub);
  } finally {
    stub.server.close();
  }
}

describe('opencode reasoning metadata', () => {
  it('advertises capabilities and levels per model', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const models = mod.listModels({}, ctx);

      const reasoner = models.find(m => m.id === 'opencode/reasoner');
      assert.ok(reasoner, 'reasoner must be listed');
      assert.deepEqual(reasoner.reasoning, {
        supported: true,
        parameter: 'reasoning_effort',
        default: 'default',
        levels: ['default', 'low', 'medium', 'high'],
      });
      assert.equal(reasoner.capabilities.reasoning, true);
      assert.equal(reasoner.capabilities.tool_calls, true);

      const fixed = models.find(m => m.id === 'opencode/fixed');
      assert.deepEqual(fixed.reasoning, {
        supported: true,
        parameter: null,
        default: 'default',
        levels: ['default'],
      });

      const plain = models.find(m => m.id === 'opencode/plain');
      assert.deepEqual(plain.reasoning, {
        supported: false,
        parameter: null,
        default: null,
        levels: [],
      });
    });
  });

  it('operator-pinned model lists carry no metadata', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: stub.baseUrl });
      assert.equal(ctx.modelMeta.size, 0);
      const models = mod.listModels({}, ctx);
      assert.equal(models[0].reasoning, undefined);
    });
  });
});

describe('opencode reasoning effort application', () => {
  it('sends the selected level as the opencode variant', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const response = await mod.complete(
        {},
        { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high' },
        ctx,
      );
      assert.equal(response.choices[0].message.content, 'pong');
      assert.equal(stub.messageBody().variant, 'high');
    });
  });

  it('omits the variant for the default level and for absent effort', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'default' }, ctx);
      assert.equal('variant' in stub.messageBody(), false);

      await mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal('variant' in stub.messageBody(), false);
    });
  });

  it('rejects an unknown level with the supported list and no upstream call', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const callsBefore = stub.messageCalls();
      await assert.rejects(
        () => mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'ultra' }, ctx),
        (error) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /not available for model 'reasoner'/);
          assert.match(error.message, /Supported: default, low, medium, high\./);
          return true;
        },
      );
      assert.equal(stub.messageCalls(), callsBefore, 'no upstream call for invalid level');
    });
  });

  it('rejects any level for a model without reasoning', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await assert.rejects(
        () => mod.complete({}, { model: 'plain', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' }, ctx),
        (error) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /does not support reasoning_effort/);
          return true;
        },
      );
    });
  });

  it('allows the single fixed level and rejects variants for a fixed model', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.complete({}, { model: 'fixed', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'default' }, ctx);
      assert.equal('variant' in stub.messageBody(), false);
      await assert.rejects(
        () => mod.complete({}, { model: 'fixed', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' }, ctx),
        (error) => error.status === 400 && /Supported: default\./.test(error.message),
      );
    });
  });

  it('applies the variant on the streaming prompt path', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const chunks = [];
      for await (const chunk of mod.completeStreaming(
        { streaming: true },
        { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' },
        ctx,
      )) {
        chunks.push(chunk);
      }
      assert.ok(chunks.length > 0);
      assert.equal(stub.promptBody().variant, 'low');
    });
  });

  it('passes model metadata through the Responses path', async () => {
    await withStub(async (stub) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: stub.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.responses({}, { model: 'reasoner', input: 'hi', reasoning_effort: 'medium' }, ctx);
      assert.equal(stub.messageBody().variant, 'medium');
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the proxy HTTP surface (child process + stub backend).
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('unibridge test instance did not become healthy');
}

describe('proxy reasoning effort end to end', { timeout: 60_000 }, () => {
  let stub;
  let child;
  let baseUrl;
  let tmpDir;
  let logFile;

  before(async () => {
    stub = await createOpencodeStub();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unibridge-reasoning-'));
    logFile = path.join(tmpDir, 'unibridge.log');
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const configPath = path.join(tmpDir, 'unibridge.json');
    fs.writeFileSync(configPath, JSON.stringify({
      port,
      host: '127.0.0.1',
      apiKey: 'test-key',
      logFile,
      defaultBackend: 'opencode',
      backends: {
        opencode: {
          baseUrl: stub.baseUrl,
          serverPassword: '',
          serverUsername: 'opencode',
          streaming: true,
          clientTools: true,
        },
      },
    }));
    child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'cli.js')], {
      cwd: repoRoot,
      env: { ...process.env, UNIBRIDGE_CONFIG: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForHealth(baseUrl);
  });

  after(() => {
    if (child) child.kill('SIGTERM');
    if (stub) stub.server.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function headers() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' };
  }

  it('lists real reasoning levels on /v1/models', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: headers() });
    assert.equal(res.status, 200);
    const payload = await res.json();
    const reasoner = payload.data.find(m => m.id === 'opencode/reasoner');
    assert.deepEqual(reasoner.reasoning.levels, ['default', 'low', 'medium', 'high']);
    assert.equal(reasoner.reasoning.default, 'default');
    const plain = payload.data.find(m => m.id === 'opencode/plain');
    assert.deepEqual(plain.reasoning.levels, []);
    assert.equal(plain.reasoning.supported, false);
  });

  it('applies reasoning_effort through /v1/chat/completions', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'opencode/reasoner',
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'high',
      }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.choices[0].message.content, 'pong');
    assert.equal(stub.messageBody().variant, 'high');
  });

  it('rejects an invalid level with 400 and a supported list', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'opencode/reasoner',
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'ultra',
      }),
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error.message, /Supported: default, low, medium, high/);
  });

  it('rejects a non-string reasoning_effort with 400', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'opencode/reasoner',
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 3,
      }),
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error.message, /reasoning_effort must be a string/);
  });

  it('accepts reasoning.effort on /v1/responses', async () => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: 'opencode/reasoner',
        input: 'ping',
        reasoning: { effort: 'low' },
      }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.output_text, 'pong');
    assert.equal(stub.messageBody().variant, 'low');
  });
});
