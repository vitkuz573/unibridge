import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
          parts: [{ type: 'text', text: 'ok' }],
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
      () => mod.completeStreaming({}, { messages: [], model: 'test' }, null),
      /not initialized/i
    );
  });

  it('openai: throws on null context', async () => {
    const mod = await import('../dist/backends/openai.js');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'test' }, null),
      /not initialized/i
    );
  });

    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'test' }, null),
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

describe('buildBody() — opencode via complete()', () => {
  it('converts user messages to parts with model structure', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello world' }],
      }, ctx);
      assert.equal(body().model.providerID, 'opencode');
      assert.equal(body().model.modelID, 'test-model');
      assert.equal(body().parts.length, 1);
      assert.equal(body().parts[0].type, 'text');
      assert.equal(body().parts[0].text, 'hello world');
    } finally { server.close(); }
  });

  it('maps maxTokens (not max_tokens)', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 512,
      }, ctx);
      assert.equal(body().maxTokens, 512);
    } finally { server.close(); }
  });

  it('uses minTokens when larger than maxTokens', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, minTokens: 200,
      }, ctx);
      assert.equal(body().maxTokens, 200);
    } finally { server.close(); }
  });

  it('omits maxTokens when not provided', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().maxTokens, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
    } finally { server.close(); }
  });

  it('prepends system message to first text part', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'hello' },
        ],
      }, ctx);
      assert.ok(body().parts[0].text.includes('[System instructions: Be helpful]'));
      assert.ok(body().parts[0].text.includes('hello'));
    } finally { server.close(); }
  });

  it('appends forceJson instruction to last text part', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({ forceJson: true }, {
        model: 'm', messages: [{ role: 'user', content: 'give json' }],
      }, ctx);
      const lastPart = body().parts[body().parts.length - 1];
      assert.ok(lastPart.text.includes('IMPORTANT: Output ONLY valid JSON'));
    } finally { server.close(); }
  });

  it('skips system messages in parts array', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
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
        model: 'm', messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      }, ctx);
      assert.deepEqual(body().response_format, { type: 'json_object' });
    } finally { server.close(); }
  });

  it('prepends system message to first text part', async () => {
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
      assert.ok(body().parts[0].text.includes('[System instructions: Be concise]'));
      assert.ok(body().parts[0].text.includes('hello'));
    } finally { server.close(); }
  });

  it('appends forceJson instruction to last text part', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({ forceJson: true }, {
        model: 'm', messages: [{ role: 'user', content: 'give json' }],
      }, ctx);
      const lastPart = body().parts[body().parts.length - 1];
      assert.ok(lastPart.text.includes('IMPORTANT: Output ONLY valid JSON'));
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

    it(`${name}: each returned model is a plain object with exactly id and object`, async () => {
      const mod = await import(`../dist/backends/${name}.js`);
      const result = mod.listModels({}, { models: ['x'] });
      const keys = Object.keys(result[0]).sort();
      assert.deepEqual(keys, ['id', 'object']);
    });
  }
});

// ---------------------------------------------------------------------------
// 12. complete() — undefined ctx and error message edge cases
// ---------------------------------------------------------------------------

describe('complete() — undefined ctx and error message edge cases', () => {

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
    const server = http.createServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session service unavailable' }));
    });
    const port = await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err.status >= 400);
      }
    } finally { server.close(); }
  });

  it('opencode: message endpoint error propagates with status', async () => {
    const { server, port } = await createErrorSessionServer(502);
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.equal(err.status, 502);
      }
    } finally { server.close(); }
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
    const { server, port } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(res.object, 'chat.completion');
      assert.ok(Array.isArray(res.choices));
      assert.ok('usage' in res);
      assert.equal(typeof res.usage.prompt_tokens, 'number');
      assert.equal(typeof res.usage.completion_tokens, 'number');
      assert.equal(typeof res.usage.total_tokens, 'number');
    } finally { server.close(); }
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
  it('converts image_url content parts to file parts', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
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
      const filePart = body().parts.find(p => p.type === 'file');
      assert.ok(filePart, 'should have a file part');
      assert.equal(filePart.mime, 'image/jpeg');
      assert.equal(filePart.url, 'https://example.com/img.png');
    } finally { server.close(); }
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
  it('produces empty parts when only system messages are sent', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [{ role: 'system', content: 'Only system message' }],
      }, ctx);
      assert.equal(body().parts.length, 0);
    } finally { server.close(); }
  });

  it('system is injected when user messages also present', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, {
        model: 'm',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'hi' },
        ],
      }, ctx);
      assert.ok(body().parts.length > 0);
      assert.ok(body().parts[0].text.includes('[System instructions: Be helpful]'));
    } finally { server.close(); }
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

  it('system is injected when user messages also present', async () => {
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
      assert.ok(body().parts[0].text.includes('[System instructions: Be helpful]'));
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 22. opencode — forceJson with system message
// ---------------------------------------------------------------------------

describe('opencode — forceJson with system message', () => {
  it('appends JSON instruction after system instruction prefix', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({ forceJson: true }, {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a parser' },
          { role: 'user', content: 'parse this' },
        ],
      }, ctx);
      const lastPart = body().parts[body().parts.length - 1];
      assert.ok(lastPart.text.includes('[System instructions:'));
      assert.ok(lastPart.text.includes('IMPORTANT: Output ONLY valid JSON'));
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------
// 23. mimocode — forceJson with system message
// ---------------------------------------------------------------------------

describe('mimocode — forceJson with system message', () => {
  it('appends JSON instruction after system instruction prefix', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../dist/backends/mimocode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({ forceJson: true }, {
        model: 'm',
        messages: [
          { role: 'system', content: 'You are a parser' },
          { role: 'user', content: 'parse this' },
        ],
      }, ctx);
      const lastPart = body().parts[body().parts.length - 1];
      assert.ok(lastPart.text.includes('[System instructions:'));
      assert.ok(lastPart.text.includes('IMPORTANT: Output ONLY valid JSON'));
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
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts++;
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('service unavailable');
    });
    const port = await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      try {
        await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err.status >= 500);
        assert.ok(attempts > 1, `expected multiple retry attempts, got ${attempts}`);
      }
    } finally { server.close(); }
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
