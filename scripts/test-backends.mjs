import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createV2Mock, v2Model, v2Assistant, v2TextEvents } from './helpers/opencode-v2-mock.mjs';

// ---------------------------------------------------------------------------
// Test infrastructure — lightweight HTTP servers for buildBody verification
// ---------------------------------------------------------------------------

function createEchoServer() {
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, body: () => captured });
    });
  });
}

function createDecisionServer(decision, usage = { input: 10, output: 5 }) {
  let sessionCount = 0;
  let messageCount = 0;
  let captured = null;
  let capturedSession = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/session') {
        sessionCount++;
        capturedSession = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `decision-session-${sessionCount}` }));
      } else if (req.url.endsWith('/message')) {
        messageCount++;
        captured = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          parts: [{ type: 'text', text: decision }],
          info: { tokens: usage },
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        body: () => captured,
        sessionBody: () => capturedSession,
        counts: () => ({ sessions: sessionCount, messages: messageCount }),
      });
    });
  });
}

function createDecisionStreamServer(decision, usage = { input: 3, output: 2 }, splitAt = 0) {
  let sessionCount = 0;
  let promptCount = 0;
  let captured = null;
  let capturedSession = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/session') {
        sessionCount++;
        capturedSession = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `decision-stream-${sessionCount}` }));
      } else if (req.url === '/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const sessionID = `decision-stream-${sessionCount}`;
        const payload = (event) => `data: ${JSON.stringify({ payload: event })}\n\n`;
        res.write(payload({ type: 'message.part.updated', properties: { sessionID, part: { id: 'p1', type: 'text' } } }));
        const pieces = splitAt > 0
          ? [decision.slice(0, splitAt), decision.slice(splitAt)]
          : [decision];
        for (const piece of pieces) {
          res.write(payload({ type: 'message.part.delta', properties: { sessionID, partID: 'p1', delta: piece } }));
        }
        res.write(payload({
          type: 'message.updated',
          properties: { sessionID, info: { role: 'assistant', finish: 'stop', tokens: usage } },
        }));
        res.write(payload({ type: 'session.idle', properties: { sessionID } }));
        res.end();
      } else if (req.url.endsWith('/prompt_async')) {
        promptCount++;
        captured = JSON.parse(body);
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        body: () => captured,
        sessionBody: () => capturedSession,
        counts: () => ({ sessions: sessionCount, prompts: promptCount }),
      });
    });
  });
}

function createSessionServer() {
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.url === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'test-session' }));
      } else {
        captured = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          parts: [{ type: 'text', text: '{"ok":true}' }],
          info: { tokens: { input: 10, output: 5 } },
        }));
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, body: () => captured });
    });
  });
}

// ---------------------------------------------------------------------------
// Backend interface compliance tests
// ---------------------------------------------------------------------------

const BACKEND_MODULES = ['opencode', 'kilocode', 'mimocode', 'openai'];

for (const name of BACKEND_MODULES) {
  describe(`backend ${name}`, () => {
    let mod;
    it('loads without error', async () => {
      mod = await import(`../dist/backends/${name}.js`);
    });

    it('exports required interface', () => {
      assert.equal(typeof mod.name, 'string');
      assert.equal(typeof mod.init, 'function');
      assert.equal(typeof mod.listModels, 'function');
      assert.equal(typeof mod.complete, 'function');
    });

    it('self-identifies correctly', () => {
      assert.equal(mod.name, name);
    });

    it('listModels returns empty array without context', () => {
      const result = mod.listModels({}, null);
      assert.deepEqual(result, []);
    });

    it('listModels prefixes model IDs', () => {
      const result = mod.listModels({}, { models: ['test-model'] });
      assert.ok(Array.isArray(result));
      if (result.length > 0) {
        assert.ok(result[0].id.startsWith(`${name}/`));
        assert.equal(result[0].object, 'model');
      }
    });

    it('complete throws without context', async () => {
      await assert.rejects(
        () => mod.complete({}, { messages: [], model: 'test' }, null),
        /not initialized/i
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Backend opencode edge cases
// ---------------------------------------------------------------------------

describe('backend opencode edge cases', () => {
  let mod;

  it('loads opencode module', async () => {
    mod = await import('../dist/backends/opencode.js');
  });

  it('complete() with empty messages and null ctx throws not initialized', async () => {
    await assert.rejects(
      () => mod.complete({}, { messages: [], model: 'test' }, null),
      /not initialized/i
    );
  });

  it('complete() without model field still throws on null ctx', async () => {
    await assert.rejects(
      () => mod.complete({}, { messages: [] }, null),
      /not initialized/i
    );
  });

  it('completeStreaming() throws on null ctx', async () => {
    const gen = mod.completeStreaming({ streaming: true }, { messages: [], model: 'test' }, null);
    await assert.rejects(() => gen.next(), /not initialized/i);
  });

  it('listModels prefixes all IDs with opencode/', () => {
    const result = mod.listModels({}, { models: ['alpha', 'beta', 'gamma'] });
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'opencode/alpha');
    assert.equal(result[1].id, 'opencode/beta');
    assert.equal(result[2].id, 'opencode/gamma');
    for (const m of result) {
      assert.equal(m.object, 'model');
    }
  });

  it('init() with explicit models skips network fetch', async () => {
    const ctx = await mod.init({
      baseUrl: 'http://192.0.2.1:99999',
      models: ['my-model', 'other-model'],
    });
    assert.deepEqual(ctx.models, ['my-model', 'other-model']);
    assert.equal(ctx.baseUrl, 'http://192.0.2.1:99999');
  });

  it('init() sets basic auth header when serverPassword provided', async () => {
    const ctx = await mod.init({
      models: ['test'],
      serverPassword: 'secret123',
      serverUsername: 'admin',
    });
    assert.ok(ctx.auth.Authorization.startsWith('Basic '));
    const decoded = Buffer.from(ctx.auth.Authorization.slice(6), 'base64').toString();
    assert.equal(decoded, 'admin:secret123');
  });

  it('init() returns empty auth when no serverPassword', async () => {
    const ctx = await mod.init({ models: ['test'] });
    assert.deepEqual(ctx.auth, {});
  });

  it('init() defaults username to opencode when password set without username', async () => {
    const ctx = await mod.init({
      models: ['test'],
      serverPassword: 'pass',
    });
    const decoded = Buffer.from(ctx.auth.Authorization.slice(6), 'base64').toString();
    assert.equal(decoded, 'opencode:pass');
  });
});

// ---------------------------------------------------------------------------
// Streaming compliance tests
// ---------------------------------------------------------------------------

describe('streaming support', () => {
  const STREAMING_BACKENDS = ['kilocode', 'openai'];
  const NON_STREAMING_BACKENDS = ['opencode', 'mimocode'];

  for (const name of STREAMING_BACKENDS) {
    it(`${name} exports completeStreaming`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      assert.equal(typeof mod.completeStreaming, 'function');
      // Verify it's an async generator
      const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, null);
      assert.equal(typeof gen, 'object');
      assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    });
  }

  for (const name of NON_STREAMING_BACKENDS) {
    it(`${name} exports completeStreaming`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      assert.equal(typeof mod.completeStreaming, 'function');
    });

    it(`${name} completeStreaming yields nothing when streaming disabled`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = { baseUrl: 'http://127.0.0.1:1', auth: {}, models: [], dispatcher: undefined, timeout: 1000 };
      const gen = mod.completeStreaming({ streaming: false }, { messages: [], model: 'test' }, ctx);
      const results = [];
      for await (const chunk of gen) results.push(chunk);
      assert.deepEqual(results, []);
    });
  }
});

// ---------------------------------------------------------------------------
// 1. init() — explicit models, all backends
// ---------------------------------------------------------------------------

describe('backend init() — explicit models', () => {
  const BACKENDS = [
    { name: 'opencode', defaultBaseUrl: 'http://127.0.0.1:5100' },
    { name: 'kilocode', defaultBaseUrl: 'https://api.kilo.ai/api/gateway' },
    { name: 'mimocode', defaultBaseUrl: 'http://127.0.0.1:4096' },
    { name: 'openai', defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
  ];

  for (const { name, defaultBaseUrl } of BACKENDS) {
    it(`${name}: returns context with correct models array`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['alpha', 'beta'], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, ['alpha', 'beta']);
    });

    it(`${name}: stores custom baseUrl`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://10.0.0.1:1234' });
      assert.equal(ctx.baseUrl, 'http://10.0.0.1:1234');
    });

    it(`${name}: uses default baseUrl when not provided`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.baseUrl, defaultBaseUrl);
    });

    it(`${name}: creates dispatcher (proxy handled)`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'] });
      assert.ok('dispatcher' in ctx, 'context must have dispatcher property');
    });

    it(`${name}: defaults timeout to 300000`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.timeout, 300_000);
    });

    it(`${name}: uses custom timeout`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], timeout: 42000 });
      assert.equal(ctx.timeout, 42000);
    });

    it(`${name}: skips network when models provided (unreachable baseUrl ok)`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, ['m']);
    });

    it(`${name}: empty models array is valid`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: [], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, []);
    });
  }

  it('opencode: stores serverPassword and serverUsername', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw', serverUsername: 'admin' });
    assert.equal(ctx.serverPassword, 'pw');
    assert.equal(ctx.serverUsername, 'admin');
  });

  it('mimocode: stores serverPassword and serverUsername', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw', serverUsername: 'admin' });
    assert.equal(ctx.serverPassword, 'pw');
    assert.equal(ctx.serverUsername, 'admin');
  });

  it('kilocode: stores apiKey', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'], apiKey: 'kilo-key' });
    assert.equal(ctx.apiKey, 'kilo-key');
  });

  it('openai: stores apiKey', async () => {
    const mod = await import('../dist/backends/openai.js');
    const ctx = await mod.init({ models: ['m'], apiKey: 'sk-test' });
    assert.equal(ctx.apiKey, 'sk-test');
  });
});

// ---------------------------------------------------------------------------
// 2. listModels() — edge cases
// ---------------------------------------------------------------------------

describe('backend listModels() — edge cases', () => {
  const ALL = ['opencode', 'kilocode', 'mimocode', 'openai'];

  for (const name of ALL) {
    it(`${name}: returns [] for empty models array in ctx`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      assert.deepEqual(mod.listModels({}, { models: [] }), []);
    });

    it(`${name}: returns [] when ctx has no models property`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      assert.deepEqual(mod.listModels({}, {}), []);
    });

    it(`${name}: prefixes all IDs and sets object="model"`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['a', 'b', 'c'] });
      assert.equal(result.length, 3);
      assert.deepEqual(result.map(m => m.id), [`${name}/a`, `${name}/b`, `${name}/c`]);
      for (const m of result) assert.equal(m.object, 'model');
    });

    it(`${name}: handles models with slashes in ID`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['openai/gpt-4', 'provider/model-v2'] });
      assert.equal(result[0].id, `${name}/openai/gpt-4`);
      assert.equal(result[1].id, `${name}/provider/model-v2`);
    });

    it(`${name}: handles single model`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['solo'] });
      assert.equal(result.length, 1);
      assert.equal(result[0].id, `${name}/solo`);
    });

    it(`${name}: returns exactly ctx.models.length items`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const models = Array.from({ length: 10 }, (_, i) => `model-${i}`);
      const result = mod.listModels({}, { models });
      assert.equal(result.length, 10);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. complete() — additional null-context edge cases
// ---------------------------------------------------------------------------

describe('complete() — additional null-context edge cases', () => {
  const ALL = ['opencode', 'kilocode', 'mimocode', 'openai'];

  for (const name of ALL) {
    it(`${name}: throws on null ctx with empty messages`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      await assert.rejects(
        () => mod.complete({}, { messages: [], model: 'test' }, null),
        /not initialized/i
      );
    });

    it(`${name}: throws on null ctx with missing model field`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      await assert.rejects(
        () => mod.complete({}, { messages: [{ role: 'user', content: 'hi' }] }, null),
        /not initialized/i
      );
    });

    it(`${name}: throws on null ctx with complex request shape`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      await assert.rejects(
        () => mod.complete({}, {
          model: 'm',
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          ],
          maxTokens: 100,
          response_format: { type: 'json_object' },
        }, null),
        /not initialized/i
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 4. completeStreaming() — null context and valid-context shape
// ---------------------------------------------------------------------------

describe('completeStreaming() — null context', () => {
  it('kilocode: throws on null context', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    await assert.rejects(
      async () => { for await (const _c of mod.completeStreaming({}, { messages: [], model: 'test' }, null)) { /* drain */ } },
      /not initialized/i
    );
  });

  it('openai: throws on null context', async () => {
    const mod = await import('../dist/backends/openai.js');
    await assert.rejects(
      async () => { for await (const _c of mod.completeStreaming({}, { messages: [], model: 'test' }, null)) { /* drain */ } },
      /not initialized/i
    );
  });

  it('kilocode: returns async generator with valid context', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.equal(typeof gen, 'object');
    assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    await assert.rejects(() => gen.next());
  });

  it('openai: returns async generator with valid context', async () => {
    const mod = await import('../dist/backends/openai.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.equal(typeof gen, 'object');
    assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    await assert.rejects(() => gen.next());
  });
});

// ---------------------------------------------------------------------------
// 5. embed() — edge cases
// ---------------------------------------------------------------------------

describe('backend embed() — edge cases', () => {
  it('opencode: throws 501 with null ctx', async () => {
    const mod = await import('../dist/backends/opencode.js');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('kilocode: throws 501 with null ctx', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('mimocode: throws 501 with null ctx', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('opencode: throws 501 even with valid ctx', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('kilocode: throws 501 even with valid ctx', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('mimocode: throws 501 even with valid ctx', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('openai: throws 503 on null context', async () => {
    const mod = await import('../dist/backends/openai.js');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 503); return true; }
    );
  });
});

// ---------------------------------------------------------------------------
// 6. buildBody() — kilocode via complete()
// ---------------------------------------------------------------------------

describe('buildBody() — kilocode via complete()', () => {
  it('forwards messages and model', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
      }, ctx);
      assert.equal(body().model, 'test-model');
      assert.equal(body().messages.length, 2);
      assert.equal(body().messages[0].role, 'user');
      assert.equal(body().messages[1].content, 'hi');
    } finally { server.close(); }
  });

  it('maps maxTokens to max_tokens', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }, ctx);
      assert.equal(body().max_tokens, 500);
    } finally { server.close(); }
  });

  it('uses minTokens when larger than maxTokens', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, minTokens: 300,
      }, ctx);
      assert.equal(body().max_tokens, 300);
    } finally { server.close(); }
  });

  it('omits max_tokens when not provided', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().max_tokens, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
    } finally { server.close(); }
  });

  it('forwards tools and tool_choice', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        tools, tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }, ctx);
      assert.deepEqual(body().tools, tools);
      assert.deepEqual(body().tool_choice, { type: 'function', function: { name: 'get_weather' } });
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 7. buildBody() — openai via complete()
// ---------------------------------------------------------------------------

describe('buildBody() — openai via complete()', () => {
  it('forwards messages and model', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      }, ctx);
      assert.equal(body().model, 'gpt-4');
      assert.deepEqual(body().messages, [{ role: 'user', content: 'hello' }]);
    } finally { server.close(); }
  });

  it('maps maxTokens to max_tokens', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 }, ctx);
      assert.equal(body().max_tokens, 256);
    } finally { server.close(); }
  });

  it('omits max_tokens when not provided', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().max_tokens, undefined);
    } finally { server.close(); }
  });

  it('forwards temperature', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 }, ctx);
      assert.equal(body().temperature, 0.7);
    } finally { server.close(); }
  });

  it('omits temperature when null', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: null }, ctx);
      assert.equal(body().temperature, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
    } finally { server.close(); }
  });

  it('forwards tools and tool_choice', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const tools = [{ type: 'function', function: { name: 'search', parameters: {} } }];
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        tools, tool_choice: 'auto',
      }, ctx);
      assert.deepEqual(body().tools, tools);
      assert.equal(body().tool_choice, 'auto');
    } finally { server.close(); }
  });

  it('forwards empty messages array', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [] }, ctx);
      assert.deepEqual(body().messages, []);
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 8. buildBody() — opencode via complete()
// ---------------------------------------------------------------------------

describe('buildPrompt() — opencode v2 prompt shape', () => {
  it('creates a session with the model ref and ask-all permissions, then prompts with the transcript', async () => {
    const mock = await createV2Mock({ models: [v2Model('test-model')] });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello world' }],
      }, ctx);
      const session = mock.state.sessionBodies[0];
      assert.deepEqual(session.model, { id: 'test-model', providerID: 'opencode' });
      assert.deepEqual(session.permissions, [{ action: '*', resource: '*', effect: 'ask' }]);
      assert.equal(mock.state.promptBodies.length, 1);
      assert.equal(mock.state.promptBodies[0].text, 'hello world');
      assert.ok(mock.state.messageQueries[0].includes('type=assistant'));
    } finally { await mock.close(); }
  });

  it('does not forward generation knobs the v2 prompt API does not accept', async () => {
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: '{"ok":true}' }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 512,
        minTokens: 200,
        temperature: 0.5,
        response_format: { type: 'json_object' },
      }, ctx);
      const prompt = mock.state.promptBodies[0];
      assert.deepEqual(Object.keys(prompt), ['text']);
    } finally { await mock.close(); }
  });

  it('carries system instructions inside the prompt', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'hello' },
        ],
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.startsWith('[System instructions: Be helpful]'), text);
      assert.ok(text.includes('hello'));
    } finally { await mock.close(); }
  });

  it('adds the structured-output reminder inside the prompt', async () => {
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: '{"ok":true}' }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [{ role: 'user', content: '{"give":"json"}' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
        },
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('[Output format: Reply with raw JSON only'), text);
      assert.ok(text.includes('{"give":"json"}'));
    } finally { await mock.close(); }
  });

  it('rejects tools when clientTools is disabled instead of offering local tools', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];
      await assert.rejects(
        () => mod.complete({}, {
          model: 'm', messages: [{ role: 'user', content: 'hi' }],
          tools, tool_choice: { type: 'function', function: { name: 'get_weather' } },
        }, ctx),
        /clientTools/,
      );
      assert.equal(mock.state.sessionCalls, 0, 'no session must be created');
    } finally { await mock.close(); }
  });

  it('converts role:tool messages to structured tool_result JSON', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'what is the weather?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":72}' },
          { role: 'user', content: 'thanks' },
        ],
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      const toolResultLine = text.split('\n\n').find(line => line.includes('"tool_result"'));
      assert.ok(toolResultLine, 'should have a structured tool_result line');
      assert.deepEqual(JSON.parse(toolResultLine), {
        type: 'tool_result',
        callID: 'call_1',
        content: '{"temp":72}',
      });
      assert.ok(!text.includes('[tool result for'));
    } finally { await mock.close(); }
  });

  it('converts assistant tool_calls to structured function_call JSON', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'check weather' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"LA"}' } }] },
        ],
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      const callLine = text.split('\n\n').find(line => line.includes('"function_call"'));
      assert.ok(callLine, 'should have a structured function_call line');
      assert.deepEqual(JSON.parse(callLine), {
        type: 'function_call',
        id: 'call_2',
        name: 'get_weather',
        arguments: { city: 'LA' },
      });
      assert.ok(!text.includes('[calling tool'));
    } finally { await mock.close(); }
  });

  it('handles assistant message with tool_calls and no content', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'do something' },
          { role: 'assistant', content: null, tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'func_a', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'func_b', arguments: '{"x":1}' } },
          ] },
        ],
      }, ctx);
      const callLines = mock.state.promptBodies[0].text.split('\n\n').filter(line => line.includes('"function_call"'));
      assert.equal(callLines.length, 2);
      assert.deepEqual(JSON.parse(callLines[0]).name, 'func_a');
      assert.deepEqual(JSON.parse(callLines[1]).name, 'func_b');
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// 9. buildBody() — mimocode via complete()
// ---------------------------------------------------------------------------

describe('buildBody() — mimocode via complete()', () => {
  it('converts messages to parts with provider/model structure', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['mimo/mimo-auto'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'mimo/mimo-auto',
        messages: [{ role: 'user', content: 'hello' }],
      }, ctx);
      assert.equal(body().model.providerID, 'mimo');
      assert.equal(body().model.modelID, 'mimo-auto');
      assert.equal(body().parts.length, 1);
      assert.equal(body().parts[0].type, 'text');
      assert.equal(body().parts[0].text, 'hello');
    } finally { server.close(); }
  });

  it('parses model string with no slash', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'baremodel',
        messages: [{ role: 'user', content: 'hi' }],
      }, ctx);
      assert.equal(body().model.providerID, 'baremodel');
      assert.equal(body().model.modelID, 'baremodel');
    } finally { server.close(); }
  });

  it('maps maxTokens', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 300,
      }, ctx);
      assert.equal(body().maxTokens, 300);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: '{"hi":1}' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
    } finally { server.close(); }
  });

  it('sends system via native field, parts stay clean', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
        ],
      }, ctx);
      assert.equal(body().system, 'Be concise');
      assert.equal(body().parts[0].text, 'hello');
    } finally { server.close(); }
  });

  it('forwards response_format json_object natively (no prompt injection)', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: '{"give":"json"}' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
      assert.equal(body().parts[body().parts.length - 1].text, '{"give":"json"}');
    } finally { server.close(); }
  });

  it('skips system messages in parts array', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'System msg' },
          { role: 'user', content: 'User msg' },
        ],
      }, ctx);
      for (const p of body().parts) {
        assert.notEqual(p.type, 'system');
      }
    } finally { server.close(); }
  });

  it('rejects tools; local tools are never offered', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }];
      await assert.rejects(
        () => mod.complete({}, {
          model: 'm', messages: [{ role: 'user', content: 'hi' }],
          tools, tool_choice: { type: 'function', function: { name: 'get_weather' } },
        }, ctx),
        /tools are not supported/,
      );
      assert.equal(body(), null, 'no message must reach the backend');
    } finally { server.close(); }
  });

  it('converts role:tool messages to text parts', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'what is the weather?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":72}' },
          { role: 'user', content: 'thanks' },
        ],
      }, ctx);
      const toolPart = body().parts.find(p => p.type === 'text' && p.text.includes('"tool_result"'));
      assert.ok(toolPart, 'should have a structured tool_result part');
      assert.deepEqual(JSON.parse(toolPart.text), { type: 'tool_result', callID: 'call_1', content: '{"temp":72}' });
    } finally { server.close(); }
  });

  it('converts assistant tool_calls to text parts', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'check weather' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"LA"}' } }] },
        ],
      }, ctx);
      const toolCallPart = body().parts.find(p => p.type === 'text' && p.text.includes('"function_call"'));
      assert.ok(toolCallPart, 'should have a structured function_call part');
      assert.deepEqual(JSON.parse(toolCallPart.text), { type: 'function_call', id: 'call_2', name: 'get_weather', arguments: { city: 'LA' } });
    } finally { server.close(); }
  });

  it('handles assistant message with tool_calls and no content', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'user', content: 'do something' },
          { role: 'assistant', content: null, tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'func_a', arguments: '{}' } },
            { id: 'call_b', type: 'function', function: { name: 'func_b', arguments: '{"x":1}' } },
          ] },
        ],
      }, ctx);
      const callParts = body().parts.filter(p => p.type === 'text' && p.text.includes('"function_call"'));
      assert.equal(callParts.length, 2);
      assert.equal(JSON.parse(callParts[0].text).name, 'func_a');
      assert.equal(JSON.parse(callParts[1].text).name, 'func_b');
    } finally { server.close(); }
  });
});

// ===========================================================================
// Additional comprehensive edge-case tests — ALL 4 backends
// ===========================================================================

// ---------------------------------------------------------------------------
// 10. init() — additional edge cases
// ---------------------------------------------------------------------------

describe('init() — additional edge cases', () => {
  const ALL = [
    { name: 'opencode', defaultBaseUrl: 'http://127.0.0.1:5100' },
    { name: 'kilocode', defaultBaseUrl: 'https://api.kilo.ai/api/gateway' },
    { name: 'mimocode', defaultBaseUrl: 'http://127.0.0.1:4096' },
    { name: 'openai', defaultBaseUrl: 'http://127.0.0.1:11434/v1' },
  ];

  for (const { name, defaultBaseUrl } of ALL) {
    it(`${name}: undefined proxy leaves dispatcher as undefined`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.dispatcher, undefined);
    });

    it(`${name}: empty string proxy leaves dispatcher as undefined`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], proxy: '' });
      assert.equal(ctx.dispatcher, undefined);
    });

    it(`${name}: context has all required keys`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'] });
      assert.ok('baseUrl' in ctx);
      assert.ok('models' in ctx);
      assert.ok('dispatcher' in ctx);
      assert.ok('timeout' in ctx);
    });

    it(`${name}: large models array preserved exactly`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const big = Array.from({ length: 50 }, (_, i) => `model-${i}`);
      const ctx = await mod.init({ models: big, baseUrl: 'http://192.0.2.1:99999' });
      assert.equal(ctx.models.length, 50);
      assert.equal(ctx.models[0], 'model-0');
      assert.equal(ctx.models[49], 'model-49');
    });

    it(`${name}: baseUrl with port is preserved`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://10.0.0.5:8080' });
      assert.equal(ctx.baseUrl, 'http://10.0.0.5:8080');
    });

    it(`${name}: baseUrl with path is preserved`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'https://example.com/api/v2' });
      assert.equal(ctx.baseUrl, 'https://example.com/api/v2');
    });
  }

  it('opencode: default username is opencode when password set', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw' });
    assert.equal(ctx.serverUsername, 'opencode');
    assert.equal(ctx.serverPassword, 'pw');
  });

  it('mimocode: default username is opencode when password set', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw' });
    assert.equal(ctx.serverUsername, 'opencode');
    assert.equal(ctx.serverPassword, 'pw');
  });

  it('kilocode: empty apiKey stored as empty string', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'] });
    assert.equal(ctx.apiKey, '');
  });

  it('openai: empty apiKey stored as empty string', async () => {
    const mod = await import('../dist/backends/openai.js');
    const ctx = await mod.init({ models: ['m'] });
    assert.equal(ctx.apiKey, '');
  });
});

// ---------------------------------------------------------------------------
// 11. listModels() — additional edge cases
// ---------------------------------------------------------------------------

describe('listModels() — additional edge cases', () => {
  const ALL = ['opencode', 'kilocode', 'mimocode', 'openai'];

  for (const name of ALL) {
    it(`${name}: null ctx returns []`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, null);
      assert.deepEqual(result, []);
    });

    it(`${name}: undefined ctx returns []`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, undefined);
      assert.deepEqual(result, []);
    });

    it(`${name}: model ID with slashes gets prefixed correctly`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['anthropic/claude-3.5-sonnet'] });
      assert.equal(result[0].id, `${name}/anthropic/claude-3.5-sonnet`);
    });

    it(`${name}: empty string model ID is prefixed`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: [''] });
      assert.equal(result[0].id, `${name}/`);
      assert.equal(result[0].object, 'model');
    });

    it(`${name}: model ID with special characters`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['model@v2.1-beta'] });
      assert.equal(result[0].id, `${name}/model@v2.1-beta`);
      assert.equal(result[0].object, 'model');
    });

    it(`${name}: returns new array each call (no shared reference)`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const ctx = { models: ['a', 'b'] };
      const r1 = mod.listModels({}, ctx);
      const r2 = mod.listModels({}, ctx);
      assert.notEqual(r1, r2);
    });

    it(`${name}: each returned model is a full SDK Model`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['x'] });
      assert.equal(result[0].id, `${name}/x`);
      assert.equal(result[0].object, 'model');
      assert.equal(typeof result[0].created, 'number');
      assert.equal(result[0].owned_by, name);
    });
  }
});

// ---------------------------------------------------------------------------
// 12. complete() — undefined ctx and error message edge cases
// ---------------------------------------------------------------------------

describe('complete() — undefined ctx and error message edge cases', () => {
  const ALL = ['opencode', 'kilocode', 'mimocode', 'openai'];

  for (const name of ALL) {
    it(`${name}: throws on undefined ctx`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      await assert.rejects(
        () => mod.complete({}, { messages: [{ role: 'user', content: 'hi' }], model: 'm' }, undefined),
        /not initialized/i
      );
    });

    it(`${name}: error message includes backend name`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      try {
        await mod.complete({}, { messages: [], model: 'm' }, null);
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err.message.includes(name), `error should mention "${name}": ${err.message}`);
      }
    });

    it(`${name}: complete with empty messages array and null ctx still throws`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      await assert.rejects(
        () => mod.complete({}, { model: 'm' }, null),
        /not initialized/i
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 13. completeStreaming() — additional edge cases
// ---------------------------------------------------------------------------

describe('completeStreaming() — additional edge cases', () => {
  it('kilocode: returns async iterable on valid ctx (network fail)', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.ok(typeof gen[Symbol.asyncIterator] === 'function');
    await assert.rejects(() => gen.next());
  });

  it('openai: returns async iterable on valid ctx (network fail)', async () => {
    const mod = await import('../dist/backends/openai.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.ok(typeof gen[Symbol.asyncIterator] === 'function');
    await assert.rejects(() => gen.next());
  });

  it('kilocode: null ctx error is instance of Error', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    try {
      await mod.completeStreaming({}, { messages: [], model: 'm' }, null).next();
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('openai: null ctx error is instance of Error', async () => {
    const mod = await import('../dist/backends/openai.js');
    try {
      await mod.completeStreaming({}, { messages: [], model: 'm' }, null).next();
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('kilocode: undefined ctx also throws', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'm' }, undefined).next(),
      /not initialized/i
    );
  });

  it('openai: undefined ctx also throws', async () => {
    const mod = await import('../dist/backends/openai.js');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'm' }, undefined).next(),
      /not initialized/i
    );
  });
});

// ---------------------------------------------------------------------------
// 14. embed() — additional edge cases
// ---------------------------------------------------------------------------

describe('embed() — additional edge cases', () => {
  it('opencode: error message mentions "not supported"', async () => {
    const mod = await import('../dist/backends/opencode.js');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('kilocode: error message mentions "not supported"', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('mimocode: error message mentions "not supported"', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('opencode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('kilocode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../dist/backends/kilocode.js');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('mimocode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../dist/backends/mimocode.js');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('openai: null ctx throws 503 with message', async () => {
    const mod = await import('../dist/backends/openai.js');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 503);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('openai: undefined ctx also throws 503', async () => {
    const mod = await import('../dist/backends/openai.js');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, undefined);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 503);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. complete() — server error propagation
// ---------------------------------------------------------------------------

describe('complete() — server error propagation', () => {
  function createErrorServer(statusCode) {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'backend failure', type: 'server_error' } }));
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port });
      });
    });
  }

  function createErrorSessionServer(statusCode) {
    const server = http.createServer((req, res) => {
      if (req.url === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'err-session' }));
      } else {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'message endpoint failure' } }));
      }
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port });
      });
    });
  }

  it('kilocode: throws on 401 with status property', async () => {
    const { server, port } = await createErrorServer(401);
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('401'));
      }
    } finally { server.close(); }
  });

  it('kilocode: throws on 429 with status property', async () => {
    const { server, port } = await createErrorServer(429);
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 429);
      }
    } finally { server.close(); }
  });

  it('kilocode: throws on 500 with status property', async () => {
    const { server, port } = await createErrorServer(500);
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 500);
      }
    } finally { server.close(); }
  });

  it('openai: throws on 401 with status property', async () => {
    const { server, port } = await createErrorServer(401);
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('401'));
      }
    } finally { server.close(); }
  });

  it('openai: throws on 429 with status property', async () => {
    const { server, port } = await createErrorServer(429);
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 429);
      }
    } finally { server.close(); }
  });

  it('opencode: session error propagates with status', async () => {
    const mock = await createV2Mock({ sessionStatus: 503, models: [v2Model('m')] });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 503);
      }
      assert.ok(mock.state.sessionCalls > 1, 'session create is retried on 5xx');
    } finally { await mock.close(); }
  });

  it('opencode: message endpoint error propagates with status', async () => {
    const mock = await createV2Mock({ messageStatus: 502 });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 502);
      }
    } finally { await mock.close(); }
  });

  it('mimocode: session error propagates with status', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session service unavailable' }));
    });
    const port = await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err.status >= 400);
      }
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 16. completeStreaming() — server error propagation
// ---------------------------------------------------------------------------

describe('completeStreaming() — server error propagation', () => {
  function createErrorServer(statusCode) {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'streaming backend failure' } }));
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port });
      });
    });
  }

  it('kilocode: throws on 500 during streaming', async () => {
    const { server, port } = await createErrorServer(500);
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx).next();
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 500);
      }
    } finally { server.close(); }
  });

  it('openai: throws on 500 during streaming', async () => {
    const { server, port } = await createErrorServer(500);
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx).next();
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 500);
      }
    } finally { server.close(); }
  });

  it('kilocode: throws on 401 during streaming', async () => {
    const { server, port } = await createErrorServer(401);
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx).next();
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 401);
      }
    } finally { server.close(); }
  });

  it('openai: throws on 401 during streaming', async () => {
    const { server, port } = await createErrorServer(401);
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx).next();
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 401);
      }
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 17. complete() — response shape validation
// ---------------------------------------------------------------------------

describe('complete() — response shape validation', () => {
  it('kilocode: returns valid OpenAI-shaped response', async () => {
    const { server, port } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(res.object, 'chat.completion');
      assert.ok(typeof res.id === 'string');
      assert.ok(typeof res.created === 'number');
      assert.ok(Array.isArray(res.choices));
      assert.equal(res.choices.length, 1);
      assert.equal(res.choices[0].message.role, 'assistant');
      assert.ok('usage' in res);
    } finally { server.close(); }
  });

  it('openai: returns valid OpenAI-shaped response', async () => {
    const { server, port } = await createEchoServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(res.object, 'chat.completion');
      assert.ok(typeof res.id === 'string');
      assert.ok(typeof res.created === 'number');
      assert.ok(Array.isArray(res.choices));
      assert.equal(res.choices.length, 1);
      assert.equal(res.choices[0].message.role, 'assistant');
      assert.ok('usage' in res);
    } finally { server.close(); }
  });

  it('opencode: returns valid response with usage tokens', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(res.object, 'chat.completion');
      assert.ok(Array.isArray(res.choices));
      assert.ok('usage' in res);
      assert.equal(typeof res.usage.prompt_tokens, 'number');
      assert.equal(typeof res.usage.completion_tokens, 'number');
      assert.equal(typeof res.usage.total_tokens, 'number');
    } finally { await mock.close(); }
  });

  it('mimocode: returns valid response with usage tokens', async () => {
    const { server, port } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(res.object, 'chat.completion');
      assert.ok(Array.isArray(res.choices));
      assert.ok('usage' in res);
      assert.equal(typeof res.usage.prompt_tokens, 'number');
      assert.equal(typeof res.usage.completion_tokens, 'number');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 18. opencode — image_url message parts conversion
// ---------------------------------------------------------------------------

describe('opencode — image_url message parts', () => {
  it('converts image_url content parts to prompt file attachments', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
          ],
        }],
      }, ctx);
      const prompt = mock.state.promptBodies[0];
      assert.ok(prompt.text.includes('describe this'));
      assert.deepEqual(prompt.files, [{ uri: 'https://example.com/img.png' }]);
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// 19. mimocode — image_url message parts conversion
// ---------------------------------------------------------------------------

describe('mimocode — image_url message parts', () => {
  it('converts image_url content parts to file parts', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
          ],
        }],
      }, ctx);
      const filePart = body().parts.find(p => p.type === 'file');
      assert.ok(filePart, 'should have a file part');
      assert.equal(filePart.mime, 'image/jpeg');
      assert.equal(filePart.url, 'https://example.com/photo.jpg');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 20. opencode — system-only message with no user parts
// ---------------------------------------------------------------------------

describe('opencode — system-only message edge case', () => {
  it('produces a system-only prompt when only system messages are sent', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [{ role: 'system', content: 'Only system message' }],
      }, ctx);
      assert.equal(mock.state.promptBodies[0].text, '[System instructions: Only system message]');
    } finally { await mock.close(); }
  });

  it('carries system and user text in one prompt', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'hi' },
        ],
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('[System instructions: Be helpful]'));
      assert.ok(text.includes('hi'));
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// 21. mimocode — system-only message with no user parts
// ---------------------------------------------------------------------------

describe('mimocode — system-only message edge case', () => {
  it('produces empty parts when only system messages are sent', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [{ role: 'system', content: 'Only system message' }],
      }, ctx);
      assert.equal(body().parts.length, 0);
    } finally { server.close(); }
  });

  it('sends system via native field, parts stay clean', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'hi' },
        ],
      }, ctx);
      assert.ok(body().parts.length > 0);
      assert.equal(body().system, 'Be helpful');
      assert.equal(body().parts[0].text, 'hi');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 22. opencode — response_format with system message (native, no hacks)
// ---------------------------------------------------------------------------

describe('opencode — response_format with system message', () => {
  it('inlines system and schema guidance, never a native response_format field', async () => {
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: '{"ok":true}' }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a parser' },
          { role: 'user', content: 'parse this' },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'parsed', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
        },
      }, ctx);
      const prompt = mock.state.promptBodies[0];
      assert.equal(prompt.response_format, undefined);
      assert.ok(prompt.text.includes('[System instructions: You are a parser]'));
      assert.ok(prompt.text.includes('parse this'));
      assert.ok(prompt.text.includes('Reply with raw JSON only'));
    } finally { await mock.close(); }
  });
});
// ---------------------------------------------------------------------------
// 23. mimocode — response_format with system message (native, no hacks)
// ---------------------------------------------------------------------------

describe('mimocode — response_format with system message', () => {
  it('sends system and response_format via native fields, parts stay clean', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a parser' },
          { role: 'user', content: 'parse this' },
        ],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.equal(body().system, 'You are a parser');
      assert.deepEqual(body().response_format, { type: 'json_object' });
      const lastPart = body().parts[body().parts.length - 1];
      assert.ok(!lastPart.text.includes('[System instructions:'));
      assert.ok(!lastPart.text.includes('IMPORTANT:'));
      assert.equal(lastPart.text, 'parse this');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 24. embed() — openai error message includes status
// ---------------------------------------------------------------------------

describe('embed() — openai error message format', () => {
  it('null ctx error message includes "not initialized"', async () => {
    const mod = await import('../dist/backends/openai.js');
    try {
      await mod.embed({}, { model: 'text-embedding-ada-002', input: 'hello' }, null);
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err.message.includes('not initialized'));
      assert.equal(err.status, 503);
    }
  });

  it('valid ctx but unreachable server throws network error', async () => {
    const mod = await import('../dist/backends/openai.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'text' }, ctx)
    );
  });
});

// ---------------------------------------------------------------------------
// 25. opencode/mimocode — retry behavior on 5xx session failure
// ---------------------------------------------------------------------------

describe('opencode — session retry on 5xx', () => {
  it('throws after retries on persistent 5xx session error', async () => {
    const mock = await createV2Mock({ sessionStatus: 503 });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 503);
        assert.ok(mock.state.sessionCalls > 1, `expected multiple retry attempts, got ${mock.state.sessionCalls}`);
      }
    } finally { await mock.close(); }
  });
});

describe('opencode — slow server hardening', () => {
  it('a hanging server yields clear HTTP errors and never an unhandled rejection', async () => {
    const hang = http.createServer(() => { /* accept and never respond */ });
    await new Promise(resolve => hang.listen(0, '127.0.0.1', resolve));
    const port = hang.address().port;
    try {
      const mod = await import('../dist/backends/opencode.js');
      await assert.rejects(
        () => mod.init({ baseUrl: `http://127.0.0.1:${port}`, timeout: 300 }),
        (error) => {
          assert.equal(error.status, 503);
          assert.match(error.message, /model discovery failed/);
          return true;
        },
      );

      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}`, timeout: 300 });
      await assert.rejects(
        () => mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx),
        (error) => error.status >= 500,
      );
    } finally {
      hang.closeAllConnections?.();
      hang.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 26. Streaming SSE parsing — server sends [DONE]
// ---------------------------------------------------------------------------

describe('completeStreaming() — SSE [DONE] parsing', () => {
  function createSSEServer() {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port });
      });
    });
  }

  it('kilocode: yields parsed objects and terminates on [DONE]', async () => {
    const { server, port } = await createSSEServer();
    try {
      const mod = await import('../dist/backends/kilocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const chunks = [];
      for await (const chunk of mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx)) {
        chunks.push(chunk);
      }
      assert.equal(chunks.length, 2);
      assert.ok(chunks[0].choices);
      assert.ok(chunks[1].choices);
    } finally { server.close(); }
  });

  it('openai: yields parsed objects and terminates on [DONE]', async () => {
    const { server, port } = await createSSEServer();
    try {
      const mod = await import('../dist/backends/openai.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const chunks = [];
      for await (const chunk of mod.completeStreaming({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx)) {
        chunks.push(chunk);
      }
      assert.equal(chunks.length, 2);
      assert.ok(chunks[0].choices);
      assert.ok(chunks[1].choices);
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 27. opencode responses() — function_call and function_call_output input items
// ---------------------------------------------------------------------------

describe('opencode responses() — function_call input items', () => {
  it('handles function_call input items without crashing', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, {
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: 'what is the weather?' },
          { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"NYC"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"temp":72}' },
          { type: 'message', role: 'user', content: 'thanks' },
        ],
      }, ctx);
      assert.equal(res.object, 'response');
      assert.ok(Array.isArray(res.output));
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('"function_call"'));
      assert.ok(text.includes('"tool_result"'));
    } finally { await mock.close(); }
  });

  it('handles plain string input', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, { model: 'm', input: 'hello world' }, ctx);
      assert.equal(res.object, 'response');
      assert.equal(mock.state.promptBodies[0].text, 'hello world');
    } finally { await mock.close(); }
  });

  it('handles input_text items', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, {
        model: 'm',
        input: [{ type: 'input_text', text: 'hello from input_text' }],
      }, ctx);
      assert.equal(res.object, 'response');
      assert.equal(mock.state.promptBodies[0].text, 'hello from input_text');
    } finally { await mock.close(); }
  });

  it('handles developer role message as system', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, {
        model: 'm',
        input: [
          { type: 'message', role: 'developer', content: 'Be concise' },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      }, ctx);
      assert.equal(res.object, 'response');
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('[System instructions: Be concise]'));
      assert.ok(text.includes('hi'));
    } finally { await mock.close(); }
  });

  it('handles easy_input_message type', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, {
        model: 'm',
        input: [{ type: 'easy_input_message', role: 'user', content: 'quick msg' }],
      }, ctx);
      assert.equal(res.object, 'response');
      assert.equal(mock.state.promptBodies[0].text, 'quick msg');
    } finally { await mock.close(); }
  });

  it('handles empty input array', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, { model: 'm', input: [] }, ctx);
      assert.equal(res.object, 'response');
      assert.equal(mock.state.promptBodies[0].text, '');
    } finally { await mock.close(); }
  });

  it('handles null/undefined input gracefully', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.responses({}, { model: 'm' }, ctx);
      assert.equal(res.object, 'response');
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// 28. opencode responses() — max_output_tokens and temperature
// ---------------------------------------------------------------------------

describe('opencode responses() — additional parameters', () => {
  it('does not forward max_output_tokens or temperature (v2 has no generation knobs)', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.responses({ minTokens: 100 }, {
        model: 'm', input: 'hi', max_output_tokens: 256, temperature: 0.5,
      }, ctx);
      const prompt = mock.state.promptBodies[0];
      assert.deepEqual(Object.keys(prompt), ['text']);
    } finally { await mock.close(); }
  });

  it('adds a schema reminder for text.format json_schema', async () => {
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: '{"ok":true}' }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.responses({}, {
        model: 'm', input: '{"give":"json"}',
        text: { format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } },
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('Reply with raw JSON only'));
      assert.ok(text.includes('{"give":"json"}'));
    } finally { await mock.close(); }
  });

  it('does not invent a response_format field for json_object', async () => {
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: '{"ok":true}' }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.responses({}, {
        model: 'm', input: '{"give":"json"}',
        text: { format: { type: 'json_object' } },
      }, ctx);
      const prompt = mock.state.promptBodies[0];
      assert.equal(prompt.response_format, undefined);
      assert.ok(!prompt.text.includes('Output format:'));
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// 35. opencode — client tools (no local tools, deny-all sessions)
// ---------------------------------------------------------------------------

describe('opencode — client tools', () => {
  const TOOLS = [{ type: 'function', function: { name: 'calc', description: 'Calculate', parameters: { type: 'object' } } }];

  it('omits tools when absent', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
      }, ctx);
      assert.equal(mock.state.promptBodies[0].tools, undefined);
    } finally { await mock.close(); }
  });

  it('creates every session with the ask-all ruleset (no local tool executes)', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.complete({ clientTools: true }, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
      }, ctx);
      assert.deepEqual(mock.state.sessionBodies[0].permissions, [{ action: '*', resource: '*', effect: 'ask' }]);
      assert.equal(mock.state.promptBodies[0].tools, undefined, 'no local tools offered');
    } finally { await mock.close(); }
  });

  it('clientTools decision: one call, one session, usage once', async () => {
    const decision = JSON.stringify({ type: 'function_call', calls: [{ name: 'calc', arguments: { expr: '2+2' } }] });
    const mock = await createV2Mock({
      assistant: () => v2Assistant({ text: decision, tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({ clientTools: true }, {
        model: 'm', messages: [{ role: 'user', content: '2+2?' }],
        tools: TOOLS, tool_choice: 'required',
      }, ctx);
      assert.equal(mock.state.sessionCalls, 1, 'exactly one model call');
      assert.equal(mock.state.promptBodies.length, 1);
      assert.ok(mock.state.promptBodies[0].text.includes('"type":"function_call"'), 'decision contract travels in the prompt');
      assert.equal(res.choices[0].finish_reason, 'tool_calls');
      assert.equal(res.choices[0].message.tool_calls[0].function.name, 'calc');
      assert.equal(res.choices[0].message.tool_calls[0].function.arguments, '{"expr":"2+2"}');
      assert.equal(res.usage.prompt_tokens, 11);
      assert.equal(res.usage.completion_tokens, 7);
    } finally { await mock.close(); }
  });

  it('clientTools decision: parallel calls come back in provider order', async () => {
    const decision = JSON.stringify({
      type: 'function_call',
      calls: [
        { name: 'calc', arguments: { expr: '1+1' } },
        { name: 'weather', arguments: { city: 'NYC' } },
      ],
    });
    const tools = [
      ...TOOLS,
      { type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } } },
    ];
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: decision }) });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({ clientTools: true }, {
        model: 'm', messages: [{ role: 'user', content: 'check both' }],
        tools, tool_choice: 'required',
      }, ctx);
      const calls = res.choices[0].message.tool_calls;
      assert.equal(calls.length, 2);
      assert.equal(calls[0].function.name, 'calc');
      assert.equal(calls[1].function.name, 'weather');
      assert.notEqual(calls[0].id, calls[1].id);
      assert.equal(mock.state.sessionCalls, 1);
    } finally { await mock.close(); }
  });

  it('clientTools text decision returns stop with the answer and usage', async () => {
    const decision = JSON.stringify({ type: 'text', text: 'all clear' });
    const mock = await createV2Mock({
      assistant: () => v2Assistant({ text: decision, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({ clientTools: true }, {
        model: 'm', messages: [{ role: 'user', content: 'status?' }], tools: TOOLS,
      }, ctx);
      assert.equal(res.choices[0].finish_reason, 'stop');
      assert.equal(res.choices[0].message.content, 'all clear');
      assert.equal(res.choices[0].message.tool_calls, undefined);
      assert.equal(res.usage.total_tokens, 8);
      assert.equal(mock.state.sessionCalls, 1);
    } finally { await mock.close(); }
  });

  it('clientTools non-stream salvages a prose answer instead of erroring', async () => {
    const prose = 'Я не могу вызвать этот инструмент, но отвечаю текстом.';
    let calls = 0;
    const mock = await createV2Mock({
      assistant: () => {
        calls++;
        return calls === 1
          ? v2Assistant({ text: '{}', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } })
          : v2Assistant({ text: prose, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } });
      },
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({ clientTools: true }, {
        model: 'm', messages: [{ role: 'user', content: 'status?' }], tools: TOOLS,
      }, ctx);
      assert.equal(res.choices[0].finish_reason, 'stop');
      assert.equal(res.choices[0].message.content, prose);
      assert.ok(mock.state.sessionCalls >= 2, 'the invalid first reply was retried before salvage');
      assert.equal(res.usage.total_tokens, 10);
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools streams parallel tool_calls then one finish chunk', async () => {
    const decision = JSON.stringify({
      type: 'function_call',
      calls: [
        { name: 'calc', arguments: { expr: '1+1' } },
        { name: 'weather', arguments: { city: 'LA' } },
      ],
    });
    const tools = [
      ...TOOLS,
      { type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object' } } },
    ];
    const mock = await createV2Mock({
      events: () => {
        const events = v2TextEvents({ text: decision, usage: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
        return events;
      },
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: 'ping' }], tools,
      }, ctx)) chunks.push(chunk);
      const finals = chunks.filter(chunk => chunk.choices[0].finish_reason != null);
      assert.equal(finals.length, 1);
      assert.equal(finals[0].choices[0].finish_reason, 'tool_calls');
      const calls = chunks[0].choices[0].delta.tool_calls;
      assert.equal(calls.length, 2);
      assert.equal(calls[0].index, 0);
      assert.equal(calls[0].function.name, 'calc');
      assert.equal(calls[0].function.arguments, '{"expr":"1+1"}');
      assert.equal(calls[1].index, 1);
      assert.equal(calls[1].function.name, 'weather');
      assert.equal(finals[0].usage.prompt_tokens, 4);
      assert.equal(mock.state.sessionCalls, 1, 'exactly one model call per round');
      assert.deepEqual(mock.state.sessionBodies[0].permissions, [{ action: '*', resource: '*', effect: 'ask' }]);
      assert.equal(mock.state.promptBodies[0].tools, undefined, 'no local tools offered');
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools streams the final text token by token', async () => {
    const decision = JSON.stringify({ type: 'text', text: 'the final answer, streamed.' });
    const mock = await createV2Mock({
      events: () => v2TextEvents({ text: decision, usage: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const content = [];
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: 'answer?' }], tools: TOOLS,
      }, ctx)) {
        chunks.push(chunk);
        const text = chunk.choices[0].delta?.content;
        if (typeof text === 'string') content.push(text);
      }
      assert.equal(content.join(''), 'the final answer, streamed.');
      assert.ok(content.length >= 2, 'answer must arrive in more than one delta');
      assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
      assert.equal(chunks[chunks.length - 1].usage.completion_tokens, 2);
      assert.equal(mock.state.sessionCalls, 1);
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools ignores nested type/text keys in call arguments', async () => {
    const decision = JSON.stringify({
      type: 'function_call',
      calls: [{ name: 'calc', arguments: { type: 'text', text: 'not the answer' } }],
    });
    const mock = await createV2Mock({
      events: () => v2TextEvents({ text: decision, usage: { input: 6, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const content = [];
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: '?' }], tools: TOOLS,
      }, ctx)) {
        chunks.push(chunk);
        const text = chunk.choices[0].delta?.content;
        if (typeof text === 'string') content.push(text);
      }
      assert.deepEqual(content, [], 'arguments must never leak as answer text');
      const finals = chunks.filter(chunk => chunk.choices[0].finish_reason != null);
      const calls = finals[0].choices[0].delta?.tool_calls ?? chunks[0].choices[0].delta.tool_calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, 'calc');
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools salvages a prose answer as a text stream', async () => {
    const prose = 'У меня нет доступа к списку хостов.';
    const mock = await createV2Mock({
      events: () => v2TextEvents({ text: prose, usage: { input: 8, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const content = [];
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: 'сколько хостов?' }], tools: TOOLS,
      }, ctx)) {
        chunks.push(chunk);
        const text = chunk.choices[0].delta?.content;
        if (typeof text === 'string') content.push(text);
      }
      assert.equal(content.join(''), prose, 'the model answer must not be lost');
      assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
      assert.equal(mock.state.sessionCalls, 1, 'prose is salvage, not a retry');
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools salvages a text field without the type discriminator', async () => {
    const decision = JSON.stringify({ text: 'salvaged from a malformed decision' });
    const mock = await createV2Mock({
      events: () => v2TextEvents({ text: decision, usage: { input: 6, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }),
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const content = [];
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
      }, ctx)) {
        chunks.push(chunk);
        const text = chunk.choices[0].delta?.content;
        if (typeof text === 'string') content.push(text);
      }
      assert.equal(content.join(''), 'salvaged from a malformed decision');
      assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
      assert.equal(chunks[chunks.length - 1].usage.prompt_tokens, 6);
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools retries invalid replies and reports usage once', async () => {
    const decisionsBySession = new Map();
    let attempt = 0;
    const mock = await createV2Mock({
      assistant: () => v2Assistant({ text: '{}' }),
      events: (sessionID) => {
        attempt++;
        decisionsBySession.set(sessionID, attempt === 1
          ? { text: '{}', usage: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }
          : { text: JSON.stringify({ type: 'text', text: 'second attempt answer' }), usage: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } });
        const decision = decisionsBySession.get(sessionID);
        return v2TextEvents({ text: decision.text, usage: decision.usage });
      },
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const content = [];
      const chunks = [];
      for await (const chunk of mod.completeStreaming({ clientTools: true, streaming: true }, {
        model: 'm', messages: [{ role: 'user', content: 'answer?' }], tools: TOOLS,
      }, ctx)) {
        chunks.push(chunk);
        const text = chunk.choices[0].delta?.content;
        if (typeof text === 'string') content.push(text);
      }
      assert.equal(mock.state.sessionCalls, 2, 'one retry after the invalid first reply');
      assert.equal(content.join(''), 'second attempt answer');
      const finals = chunks.filter(chunk => chunk.choices[0].finish_reason != null);
      assert.equal(finals.length, 1);
      assert.equal(finals[0].usage.prompt_tokens, 7, 'usage is the last attempt, not the sum');
      assert.equal(finals[0].usage.total_tokens, 10);
    } finally { await mock.close(); }
  });

  it('completeStreaming with clientTools rejects tools when clientTools is disabled', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'] });
    const gen = mod.completeStreaming({ streaming: true }, {
      model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
    }, ctx);
    await assert.rejects(() => gen.next(), /clientTools/);
  });

  it('parseAssistantMessage surfaces tool parts without leaking them as text', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const parsed = mod.parseAssistantMessage({
      id: 'msg_x',
      type: 'assistant',
      content: [{ type: 'tool', id: 'tool_1', name: 'shell', state: { status: 'error' } }],
      finish: 'tool-calls',
    });
    assert.deepEqual(parsed.toolNames, ['shell']);
    assert.equal(parsed.text, '');
  });

  it('responses() rejects tools instead of offering local tools', async () => {
    const mock = await createV2Mock({});
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await assert.rejects(
        () => mod.responses({}, { model: 'm', input: 'hi', tools: TOOLS, tool_choice: 'none' }, ctx),
        /not supported on the Responses API/,
      );
      assert.equal(mock.state.sessionCalls, 0);
    } finally { await mock.close(); }
  });
});