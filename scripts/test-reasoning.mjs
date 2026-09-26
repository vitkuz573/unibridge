import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createV2Mock, v2Model, v2Assistant, v2TextEvents } from './helpers/opencode-v2-mock.mjs';

// ---------------------------------------------------------------------------
// Reasoning effort contract — opencode v2 variants → GET /v1/models reasoning
// metadata → session model ref variant.
//
// Ground truth (opencode 2.x): `Model.Info.variants[].id` are the named
// settings overrides the server applies when the session's `Model.Ref.variant`
// names them; `"default"` is unibridge's sentinel for "no variant override".
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REASONING_MODELS = [
  v2Model('reasoner', {
    compatibility: { reasoningField: 'reasoning_content' },
    variants: [
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'medium', settings: { reasoningEffort: 'medium' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ],
  }),
  v2Model('fixed', { compatibility: { reasoningField: 'reasoning_content' } }),
  v2Model('plain', { compatibility: null, capabilities: { tools: false, input: ['text'], output: ['text'] } }),
];

function reasoningMock(extra = {}) {
  return createV2Mock({
    models: REASONING_MODELS,
    assistant: () => v2Assistant({ text: 'pong' }),
    events: () => v2TextEvents({ text: 'pong' }),
    ...extra,
  });
}

async function withMock(run, extra = {}) {
  const mock = await reasoningMock(extra);
  try {
    return await run(mock);
  } finally {
    await mock.close();
  }
}

describe('opencode reasoning metadata', () => {
  it('advertises capabilities and levels per model', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
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

  it('filters out models of other providers and disabled models', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl });
      const ids = mod.listModels({}, ctx).map(m => m.id);
      assert.deepEqual(ids, ['opencode/reasoner', 'opencode/fixed', 'opencode/plain']);
    }, {
      models: [
        ...REASONING_MODELS,
        v2Model('other-model', { providerID: 'other' }),
        v2Model('disabled-model', { enabled: false }),
      ],
    });
  });

  it('operator-pinned model lists carry no metadata', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      assert.equal(ctx.modelMeta.size, 0);
      assert.equal(mock.state.modelCalls, 0, 'pinned lists never call /api/model');
      const models = mod.listModels({}, ctx);
      assert.equal(models[0].reasoning, undefined);
    });
  });
});

describe('opencode reasoning effort application', () => {
  it('sends the selected level as the session model variant', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const response = await mod.complete(
        {},
        { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high' },
        ctx,
      );
      assert.equal(response.choices[0].message.content, 'pong');
      assert.equal(mock.state.sessionBodies[0].model.variant, 'high');
    });
  });

  it('omits the variant for the default level and for absent effort', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'default' }, ctx);
      assert.equal('variant' in mock.state.sessionBodies[0].model, false);

      await mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal('variant' in mock.state.sessionBodies[1].model, false);
    });
  });

  it('rejects an unknown level with the supported list and no upstream call', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await assert.rejects(
        () => mod.complete({}, { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'ultra' }, ctx),
        (error) => {
          assert.equal(error.status, 400);
          assert.match(error.message, /not available for model 'reasoner'/);
          assert.match(error.message, /Supported: default, low, medium, high\./);
          return true;
        },
      );
      assert.equal(mock.state.sessionCalls, 0, 'no session for invalid level');
      assert.equal(mock.state.promptBodies.length, 0, 'no prompt for invalid level');
    });
  });

  it('rejects any level for a model without reasoning', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
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
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.complete({}, { model: 'fixed', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'default' }, ctx);
      assert.equal('variant' in mock.state.sessionBodies[0].model, false);
      await assert.rejects(
        () => mod.complete({}, { model: 'fixed', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' }, ctx),
        (error) => error.status === 400 && /Supported: default\./.test(error.message),
      );
    });
  });

  it('applies the variant on the streaming session path', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      const chunks = [];
      for await (const chunk of mod.completeStreaming(
        { streaming: true },
        { model: 'reasoner', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low' },
        ctx,
      )) {
        chunks.push(chunk);
      }
      assert.ok(chunks.length > 0);
      assert.equal(mock.state.sessionBodies[0].model.variant, 'low');
    });
  });

  it('passes model metadata through the Responses path', async () => {
    await withMock(async (mock) => {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl, serverPassword: '', serverUsername: 'opencode' });
      await mod.responses({}, { model: 'reasoner', input: 'hi', reasoning_effort: 'medium' }, ctx);
      assert.equal(mock.state.sessionBodies[0].model.variant, 'medium');
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the proxy HTTP surface (child process + mock backend).
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
  let mock;
  let child;
  let baseUrl;
  let tmpDir;
  let logFile;

  before(async () => {
    mock = await reasoningMock();
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
      backends: {
        opencode: {
          baseUrl: mock.baseUrl,
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
    if (mock) mock.close();
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
    const applied = mock.state.sessionBodies[mock.state.sessionBodies.length - 1];
    assert.equal(applied.model.variant, 'high');
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
    const applied = mock.state.sessionBodies[mock.state.sessionBodies.length - 1];
    assert.equal(applied.model.variant, 'low');
  });
});
