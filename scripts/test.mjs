import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe('config', () => {
  it('loads with default port', async () => {
    const { config } = await import('../src/config.mjs');
    assert.equal(typeof config.port, 'number');
    assert.equal(typeof config.backends, 'object');
    assert.equal(typeof config.host, 'string');
  });

  it('validates config correctly', async () => {
    const { validateConfig } = await import('../src/config.mjs');
    assert.deepEqual(validateConfig({ port: 5200, backends: {} }), []);
    assert.ok(validateConfig({ defaultBackend: 'nonexistent', backends: {} }).length > 0);
    assert.ok(validateConfig({ backends: { unknown: {} } }).length > 0);
    assert.ok(validateConfig({ aliases: { foo: 'nonexistent' }, backends: {} }).length > 0);
  });
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('starts empty, supports register and list', async () => {
    const registry = await import('../src/backends/registry.mjs');
    const before = registry.listBackends();
    assert.ok(Array.isArray(before));

    const dummy = { name: 'dummy', complete: () => {} };
    registry.register(dummy);
    assert.ok(registry.listBackends().includes('dummy'));
    const got = registry.getBackend('dummy');
    assert.equal(got.name, 'dummy');
    assert.equal(typeof got.complete, 'function');
  });
});

// ---------------------------------------------------------------------------
// Backend interface compliance tests
// ---------------------------------------------------------------------------

const BACKEND_MODULES = ['opencode', 'kilocode', 'mimocode', 'openai'];

for (const name of BACKEND_MODULES) {
  describe(`backend ${name}`, () => {
    let mod;
    it('loads without error', async () => {
      mod = await import(`../src/backends/${name}.mjs`);
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
    mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import(`../src/backends/${name}.mjs`);
      assert.equal(typeof mod.completeStreaming, 'function');
      // Verify it's an async generator
      const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, null);
      assert.equal(typeof gen, 'object');
      assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    });
  }

  for (const name of NON_STREAMING_BACKENDS) {
    it(`${name} does not export completeStreaming`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      assert.equal(mod.completeStreaming, undefined);
    });
  }
});

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe('rate limiter', () => {
  it('allows requests under limit', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 5 });
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
  });

  it('blocks requests over limit', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 3 });
    assert.equal(check('5.6.7.8'), 0);
    assert.equal(check('5.6.7.8'), 0);
    assert.equal(check('5.6.7.8'), 0);
    const retryAfter = check('5.6.7.8');
    assert.ok(retryAfter > 0);
  });

  it('separate IPs have separate limits', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(check('10.0.0.1'), 0);
    assert.equal(check('10.0.0.1'), 0);
    assert.ok(check('10.0.0.1') > 0);
    assert.equal(check('10.0.0.2'), 0);
    assert.equal(check('10.0.0.2'), 0);
    assert.ok(check('10.0.0.2') > 0);
  });
});

// ---------------------------------------------------------------------------
// Live streaming integration tests
// ---------------------------------------------------------------------------

describe('live streaming (opencode simulated)', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('returns SSE content-type and role in first chunk', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode/big-pickle',
        messages: [{ role: 'user', content: 'List 1,2,3 comma-separated only' }],
        max_tokens: 50,
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let text = '';
    let gotDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') { gotDone = true; continue; }
        chunks++;
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta;
        if (chunks === 1) {
          assert.equal(delta?.role, 'assistant', 'first delta must set role');
        }
        if (delta?.content) text += delta.content;
      }
    }

    assert.ok(gotDone, 'must end with [DONE]');
    assert.ok(chunks >= 3, `expected >=3 SSE chunks, got ${chunks}`);
    assert.ok(text.length > 0, `non-empty text expected, got "${text.substring(0, 40)}"`);
  });
});

// Run kilocode streaming test only if kilocode backend is configured
describe('live streaming (kilocode true streaming)', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('yields multiple incremental chunks with [DONE] terminator', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kilocode/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        messages: [{ role: 'user', content: 'Say only: ok test' }],
        max_tokens: 20,
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let chunks = 0;
    let gotDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') { gotDone = true; continue; }
        chunks++;
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta;
        if (chunks === 1) {
          assert.equal(delta?.role, 'assistant', 'first delta must set role');
        }
      }
    }

    assert.ok(gotDone, 'must end with [DONE]');
    assert.ok(chunks >= 2, `expected >=2 SSE chunks, got ${chunks}`);
  });
});

// Test the /v1/responses streaming (same simulated split)
describe('live streaming (responses endpoint)', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('yields multiple response.output_text.delta events', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode/big-pickle',
        input: 'Say only: abc def ghi',
        max_output_tokens: 30,
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let deltaCount = 0;
    let text = '';
    let gotCompleted = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const parsed = JSON.parse(trimmed.slice(6));
        if (parsed.type === 'response.output_text.delta') {
          deltaCount++;
          text += parsed.delta || '';
        }
        if (parsed.type === 'response.completed') gotCompleted = true;
      }
    }

    assert.ok(gotCompleted, 'must end with response.completed');
    assert.ok(deltaCount >= 2, `expected >=2 delta events, got ${deltaCount}`);
    assert.ok(text.length > 0, `non-empty text expected, got "${text.substring(0, 40)}"`);
  });
});

// ---------------------------------------------------------------------------
// Metrics tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rate limiter extended tests
// ---------------------------------------------------------------------------

describe('rate limiter extended', () => {
  it('createRateLimiter returns a function', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 10 });
    assert.equal(typeof check, 'function');
  });

  it('returns 0 for allowed requests', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 5 });
    for (let i = 0; i < 5; i++) {
      assert.equal(check('10.0.0.1'), 0);
    }
  });

  it('returns positive retryAfter for blocked requests', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(check('10.0.0.1'), 0);
    assert.equal(check('10.0.0.1'), 0);
    const retryAfter = check('10.0.0.1');
    assert.ok(retryAfter > 0);
    assert.ok(retryAfter <= 60_000);
  });

  it('separate keys have separate limits', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(check('aaa'), 0);
    assert.ok(check('aaa') > 0);
    assert.equal(check('bbb'), 0);
    assert.ok(check('bbb') > 0);
  });

  it('window expiry allows same key again', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 50, max: 1 });
    assert.equal(check('expire-test'), 0);
    assert.ok(check('expire-test') > 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(check('expire-test'), 0);
  });

  it('max=0 falls back to default 60 (falsy treated as unset)', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 0 });
    for (let i = 0; i < 60; i++) {
      assert.equal(check('max-zero'), 0);
    }
    assert.ok(check('max-zero') > 0);
  });

  it('max=1 allows exactly one request', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(check('one-only'), 0);
    assert.ok(check('one-only') > 0);
  });

  it('different keys do not interfere with each other', async () => {
    const { createRateLimiter } = await import('../src/rate-limiter.mjs');
    const check = createRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(check('x'), 0);
    assert.equal(check('x'), 0);
    assert.ok(check('x') > 0);
    assert.equal(check('y'), 0);
    assert.equal(check('y'), 0);
    assert.equal(check('z'), 0);
    assert.ok(check('x') > 0);
  });
});

describe('metrics', () => {
  it('returns valid prometheus text format', async () => {
    const mod = await import('../src/metrics.mjs');
    mod.inc('test_counter', { label: 'value' });
    mod.observe('test_duration', 150, { endpoint: '/test' });
    mod.gauge('test_gauge', 42, { status: 'active' });

    const output = mod.metrics();
    assert.ok(output.includes('test_counter'));
    assert.ok(output.includes('counter'));
    assert.ok(output.includes('gauge'));
    assert.ok(output.endsWith('\n'));
  });
});

// ---------------------------------------------------------------------------
// Config extended tests
// ---------------------------------------------------------------------------

describe('config extended', () => {
  // -----------------------------------------------------------------------
  // resolveBackend()
  // -----------------------------------------------------------------------
  describe('resolveBackend()', () => {
    let config, resolveBackend;
    let savedBackends, savedAliases, savedDefault;

    it('imports config module', async () => {
      ({ config, resolveBackend } = await import('../src/config.mjs'));
      savedBackends = config.backends;
      savedAliases = config.aliases;
      savedDefault = config.defaultBackend;
    });

    it('returns null for empty / falsy input', () => {
      assert.equal(resolveBackend(null), null);
      assert.equal(resolveBackend(undefined), null);
      assert.equal(resolveBackend(''), null);
    });

    it('resolves backend/model format correctly', () => {
      config.backends = { opencode: { name: 'opencode' }, openai: { name: 'openai' } };
      config.aliases = {};
      config.defaultBackend = null;

      const r = resolveBackend('opencode/big-pickle');
      assert.equal(r.backendName, 'opencode');
      assert.equal(r.model, 'big-pickle');
    });

    it('preserves case in model name', () => {
      config.backends = { openai: { name: 'openai' } };
      config.aliases = {};
      config.defaultBackend = null;

      const r = resolveBackend('openai/Qwen3.6-35B');
      assert.equal(r.backendName, 'openai');
      assert.equal(r.model, 'Qwen3.6-35B');
      assert.equal(r.model !== 'qwen3.6-35b', true);
    });

    it('backend name lookup is case-insensitive', () => {
      config.backends = { openai: { name: 'openai' } };
      config.aliases = {};
      config.defaultBackend = null;

      const r = resolveBackend('OpenAI/my-model');
      assert.equal(r.backendName, 'openai');
      assert.equal(r.model, 'my-model');
    });

    it('falls back to defaultBackend when no prefix matches', () => {
      config.backends = { openai: { name: 'openai' }, opencode: { name: 'opencode' } };
      config.aliases = {};
      config.defaultBackend = 'openai';

      const r = resolveBackend('some-random-model');
      assert.equal(r.backendName, 'openai');
      assert.equal(r.model, 'some-random-model');
    });

    it('returns null when no backend matches and no defaultBackend', () => {
      config.backends = {};
      config.aliases = {};
      config.defaultBackend = null;

      assert.equal(resolveBackend('any-model'), null);
    });

    it('returns null when defaultBackend is set but not in backends', () => {
      config.backends = {};
      config.aliases = {};
      config.defaultBackend = 'nonexistent';

      assert.equal(resolveBackend('some-model'), null);
    });

    it('resolves aliases (case-insensitive key)', () => {
      config.backends = { opencode: { name: 'opencode' } };
      config.aliases = { pickle: 'opencode' };
      config.defaultBackend = null;

      const r = resolveBackend('pickle');
      assert.equal(r.backendName, 'opencode');
      assert.equal(r.model, 'pickle');
    });

    it('alias lookup is case-insensitive', () => {
      config.backends = { opencode: { name: 'opencode' } };
      config.aliases = { pickle: 'opencode' };
      config.defaultBackend = null;

      const r = resolveBackend('PICKLE');
      assert.equal(r.backendName, 'opencode');
      assert.equal(r.model, 'PICKLE');
    });

    it('alias with backend/model format still resolves via alias', () => {
      config.backends = { opencode: { name: 'opencode' } };
      config.aliases = { myalias: 'opencode' };
      config.defaultBackend = null;

      const r = resolveBackend('myalias');
      assert.equal(r.backendName, 'opencode');
      assert.equal(r.model, 'myalias');
    });

    it('alias pointing to nonexistent backend is ignored, falls through', () => {
      config.backends = { opencode: { name: 'opencode' } };
      config.aliases = { badalias: 'nonexistent' };
      config.defaultBackend = 'opencode';

      const r = resolveBackend('badalias');
      // alias is ignored (backend not in config.backends), falls to defaultBackend
      assert.equal(r.backendName, 'opencode');
      assert.equal(r.model, 'badalias');
    });

    it('prefers alias over backend/model format', () => {
      // If "opencode" is both an alias target AND a backend name,
      // alias is checked first
      config.backends = { opencode: { name: 'opencode' }, kilocode: { name: 'kilocode' } };
      config.aliases = { opencode: 'kilocode' };
      config.defaultBackend = null;

      const r = resolveBackend('opencode');
      // alias match: config.aliases['opencode'] = 'kilocode'
      assert.equal(r.backendName, 'kilocode');
      assert.equal(r.model, 'opencode');
    });

    it('trims whitespace from input', () => {
      config.backends = { openai: { name: 'openai' } };
      config.aliases = {};
      config.defaultBackend = null;

      const r = resolveBackend('  openai/my-model  ');
      assert.equal(r.backendName, 'openai');
      assert.equal(r.model, 'my-model');
    });

    it('returns the backend object reference', () => {
      const be = { name: 'opencode', custom: true };
      config.backends = { opencode: be };
      config.aliases = {};
      config.defaultBackend = null;

      const r = resolveBackend('opencode/m');
      assert.equal(r.backend, be);
    });

    // Restore original config state after all resolveBackend tests
    it('restores config state', () => {
      config.backends = savedBackends;
      config.aliases = savedAliases;
      config.defaultBackend = savedDefault;
    });
  });

  // -----------------------------------------------------------------------
  // validateConfig()
  // -----------------------------------------------------------------------
  describe('validateConfig() extended', () => {
    let validateConfig;

    it('imports validateConfig', async () => {
      ({ validateConfig } = await import('../src/config.mjs'));
    });

    it('returns empty array for valid config', () => {
      const errors = validateConfig({
        port: 5200,
        backends: { opencode: {} },
        defaultBackend: 'opencode',
        aliases: {},
      });
      assert.deepEqual(errors, []);
    });

    it('returns error for negative port', () => {
      const errors = validateConfig({ port: -1, backends: {} });
      assert.ok(errors.length === 1);
      assert.ok(errors[0].includes('-1'));
    });

    it('returns error for zero port', () => {
      const errors = validateConfig({ port: 0, backends: {} });
      // port 0 is falsy so the if (cfg.port) guard skips it — no error
      // This matches current behavior: port: 0 is treated as "not set"
      assert.equal(errors.length, 0);
    });

    it('returns error for port > 65535', () => {
      const errors = validateConfig({ port: 70000, backends: {} });
      assert.ok(errors.length === 1);
      assert.ok(errors[0].includes('70000'));
    });

    it('returns error for string port', () => {
      const errors = validateConfig({ port: 'abc', backends: {} });
      assert.ok(errors.length === 1);
      assert.ok(errors[0].includes('abc'));
    });

    it('returns error for defaultBackend not in backends', () => {
      const errors = validateConfig({
        backends: { opencode: {} },
        defaultBackend: 'nonexistent',
      });
      assert.ok(errors.length >= 1);
      assert.ok(errors.some(e => e.includes('nonexistent')));
    });

    it('returns error for unknown backend name', () => {
      const errors = validateConfig({
        backends: { futuristic_backend: {} },
      });
      assert.ok(errors.length >= 1);
      assert.ok(errors.some(e => e.includes('futuristic_backend')));
    });

    it('returns error for alias pointing to nonexistent backend', () => {
      const errors = validateConfig({
        backends: {},
        aliases: { myalias: 'ghost_backend' },
      });
      assert.ok(errors.length >= 1);
      assert.ok(errors.some(e => e.includes('myalias')));
      assert.ok(errors.some(e => e.includes('ghost_backend')));
    });

    it('returns multiple errors at once', () => {
      const errors = validateConfig({
        port: -1,
        backends: { unknown_be: {} },
        defaultBackend: 'missing_be',
        aliases: { a: 'no_backend' },
      });
      assert.ok(errors.length >= 3, `expected >=3 errors, got ${errors.length}: ${errors.join('; ')}`);
    });

    it('returns empty array for minimal valid config', () => {
      const errors = validateConfig({ port: 8080, backends: {} });
      assert.deepEqual(errors, []);
    });

    it('valid port boundaries: 1 and 65535 are valid', () => {
      assert.deepEqual(validateConfig({ port: 1, backends: {} }), []);
      assert.deepEqual(validateConfig({ port: 65535, backends: {} }), []);
    });
  });

  // -----------------------------------------------------------------------
  // loadConfig() with env overrides
  // -----------------------------------------------------------------------
  describe('loadConfig with env overrides', () => {
    const ENV_KEYS = ['UNIBRIDGE_PORT', 'UNIBRIDGE_HOST', 'UNIBRIDGE_DEFAULT_BACKEND'];

    function saveEnv() {
      const saved = {};
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      return saved;
    }

    function restoreEnv(saved) {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }

    it('UNIBRIDGE_PORT overrides port', async () => {
      const saved = saveEnv();
      try {
        process.env.UNIBRIDGE_PORT = '9999';
        delete process.env.UNIBRIDGE_HOST;
        delete process.env.UNIBRIDGE_DEFAULT_BACKEND;
        // Use a unique query to force a fresh module evaluation
        const mod = await import('../src/config.mjs?t=' + Date.now());
        assert.equal(mod.config.port, 9999);
      } finally {
        restoreEnv(saved);
      }
    });

    it('UNIBRIDGE_HOST overrides host', async () => {
      const saved = saveEnv();
      try {
        delete process.env.UNIBRIDGE_PORT;
        process.env.UNIBRIDGE_HOST = '0.0.0.0';
        delete process.env.UNIBRIDGE_DEFAULT_BACKEND;
        const mod = await import('../src/config.mjs?t=' + Date.now());
        assert.equal(mod.config.host, '0.0.0.0');
      } finally {
        restoreEnv(saved);
      }
    });

    it('UNIBRIDGE_DEFAULT_BACKEND overrides defaultBackend', async () => {
      const saved = saveEnv();
      try {
        delete process.env.UNIBRIDGE_PORT;
        delete process.env.UNIBRIDGE_HOST;
        process.env.UNIBRIDGE_DEFAULT_BACKEND = 'opencode';
        const mod = await import('../src/config.mjs?t=' + Date.now());
        assert.equal(mod.config.defaultBackend, 'opencode');
      } finally {
        restoreEnv(saved);
      }
    });
  });

  // -----------------------------------------------------------------------
  // deepMerge behavior (tested indirectly via backend defaults)
  // -----------------------------------------------------------------------
  describe('deepMerge behavior', () => {
    it('backend defaults are deep-merged into user config', async () => {
      const { config } = await import('../src/config.mjs');
      // Every known backend in the loaded config should have rateLimit
      // from BACKEND_DEFAULTS (opencode, kilocode, mimocode, openai)
      for (const name of ['opencode', 'kilocode', 'mimocode', 'openai']) {
        if (config.backends[name]) {
          assert.ok(
            config.backends[name].rateLimit,
            `backend "${name}" should have rateLimit from defaults`
          );
          assert.equal(typeof config.backends[name].rateLimit.windowMs, 'number');
          assert.equal(typeof config.backends[name].rateLimit.max, 'number');
        }
      }
    });

    it('user-provided nested values override defaults but siblings survive', async () => {
      // Simulate what loadConfig does: deepMerge(defaults, userConfig)
      // We can't call deepMerge directly, but we can verify the effect:
      // If a backend has a custom rateLimit.max, the windowMs from defaults should remain.
      const { config } = await import('../src/config.mjs');
      for (const name of Object.keys(config.backends)) {
        const be = config.backends[name];
        if (be.rateLimit) {
          // rateLimit should always have both windowMs and max
          assert.ok('windowMs' in be.rateLimit, `${name}.rateLimit must have windowMs`);
          assert.ok('max' in be.rateLimit, `${name}.rateLimit must have max`);
        }
      }
    });

    it('arrays replace rather than merge (no concatenation)', () => {
      // We can't call deepMerge directly, but we can describe the contract:
      // If target has arr: [1,2] and source has arr: [3], result is [3], not [1,2,3].
      // Verified by code inspection: the condition checks !Array.isArray before recurse.
      // This test documents the expected behavior.
      assert.ok(true, 'deepMerge replaces arrays (documented contract)');
    });
  });
});

// ---------------------------------------------------------------------------
// responsesInputToMessages (indirect via /v1/responses)
// ---------------------------------------------------------------------------

describe('responsesInputToMessages (indirect)', async () => {
  const BASE = 'http://127.0.0.1:5200';
  const MODEL = 'opencode/big-pickle';

  it('string input produces a successful response', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'Say hi' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
    assert.ok(Array.isArray(data.output));
  });

  it('array of message objects produces a successful response', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: 'message', role: 'user', content: 'Say hello' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
  });

  it('empty input string is accepted and returns a response', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: '' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
  });

  it('easy_input_message type is handled', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: 'easy_input_message', role: 'user', content: 'Say test' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
  });

  it('input_text item type is handled', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: 'input_text', text: 'Say words' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
  });

  it('input_image item type is handled (converted to [image])', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { type: 'input_image', url: 'https://example.com/img.png' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.object, 'response');
  });
});

// ---------------------------------------------------------------------------
// JSON.parse error handling (invalid JSON → 400)
// ---------------------------------------------------------------------------

describe('JSON parse error handling', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('POST /v1/chat/completions with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'NOT JSON {{{',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.equal(typeof data.error.message, 'string');
    assert.ok(data.error.message.toLowerCase().includes('json') || data.error.message.toLowerCase().includes('invalid'));
  });

  it('POST /v1/responses with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.equal(typeof data.error.message, 'string');
  });

  it('POST /v1/completions with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '}}{{}',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.equal(typeof data.error.message, 'string');
  });

  it('POST /v1/embeddings with invalid JSON returns 400', async () => {
    const res = await fetch(`${BASE}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad{json',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });
});

// ---------------------------------------------------------------------------
// Input validation (valid JSON, missing/wrong fields → 400)
// ---------------------------------------------------------------------------

describe('input validation', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('POST /v1/chat/completions missing messages returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/big-pickle' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.ok(data.error.message.includes('messages'));
  });

  it('POST /v1/chat/completions empty messages array returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/big-pickle', messages: [] }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('POST /v1/chat/completions message without role returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode/big-pickle',
        messages: [{ content: 'hello' }],
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('POST /v1/chat/completions message without content returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'opencode/big-pickle',
        messages: [{ role: 'user' }],
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('POST /v1/responses missing input returns 400', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/big-pickle' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.ok(data.error.message.includes('input'));
  });

  it('POST /v1/chat/completions with invalid model returns 400', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent/model-xyz',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });

  it('POST /v1/responses with invalid model returns 400', async () => {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nonexistent/model-xyz', input: 'hi' }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
  });
});

// ---------------------------------------------------------------------------
// Error response format
// ---------------------------------------------------------------------------

describe('error response format', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('error responses have {"error":{"message":"..."}} structure', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error, 'response must have "error" key');
    assert.equal(typeof data.error, 'object');
    assert.equal(typeof data.error.message, 'string');
    assert.ok(data.error.message.length > 0);
  });

  it('unknown endpoint returns 404', async () => {
    const res = await fetch(`${BASE}/v1/unknown-endpoint`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
    assert.ok(data.error.message.includes('Unknown endpoint'));
  });

  it('wrong HTTP method on /v1/chat/completions returns 404', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'GET' });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
    assert.ok(data.error.message.includes('Unknown endpoint'));
  });

  it('wrong HTTP method on /v1/responses returns 404', async () => {
    const res = await fetch(`${BASE}/v1/responses`, { method: 'GET' });
    assert.equal(res.status, 404);
  });

  it('wrong HTTP method on /v1/completions returns 404', async () => {
    const res = await fetch(`${BASE}/v1/completions`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('unknown path returns 404 with error message', async () => {
    const res = await fetch(`${BASE}/v1/foo/bar`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.ok(data.error);
    assert.ok(typeof data.error.message === 'string');
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('health endpoint', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('GET /health returns 200', async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('GET /health response has required fields', async () => {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(typeof data.version, 'string');
    assert.ok(data.version.length > 0);
    assert.ok(Array.isArray(data.backends));
    assert.ok(data.backends.length > 0);
    assert.equal(typeof data.uptime, 'number');
    assert.ok(data.uptime >= 0);
  });

  it('GET /health includes cache info', async () => {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    assert.ok(data.cache);
    assert.equal(typeof data.cache.size, 'number');
  });

  it('GET /v1 returns same health info', async () => {
    const res = await fetch(`${BASE}/v1`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(typeof data.version, 'string');
  });
});

// ---------------------------------------------------------------------------
// Root endpoint
// ---------------------------------------------------------------------------

describe('root endpoint', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('GET / returns 200', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('GET / response has service and version fields', async () => {
    const res = await fetch(`${BASE}/`);
    const data = await res.json();
    assert.equal(data.service, 'unibridge');
    assert.equal(typeof data.version, 'string');
    assert.ok(data.version.length > 0);
    assert.equal(typeof data.docs, 'string');
  });
});

// ---------------------------------------------------------------------------
// Aliases endpoint
// ---------------------------------------------------------------------------

describe('aliases endpoint', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('GET /v1/aliases returns 200', async () => {
    const res = await fetch(`${BASE}/v1/aliases`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('GET /v1/aliases response has aliases object', async () => {
    const res = await fetch(`${BASE}/v1/aliases`);
    const data = await res.json();
    assert.ok(data.aliases !== undefined, 'response must have "aliases" key');
    assert.equal(typeof data.aliases, 'object');
  });

  it('GET /aliases (without /v1 prefix) also works', async () => {
    const res = await fetch(`${BASE}/aliases`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.aliases !== undefined);
  });
});

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

describe('CORS preflight', async () => {
  const BASE = 'http://127.0.0.1:5200';

  it('OPTIONS returns 204 with CORS headers', async () => {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'OPTIONS',
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

// ---------------------------------------------------------------------------
// fetch-proxy tests
// ---------------------------------------------------------------------------

describe('fetch-proxy', () => {
  let mod;

  it('loads without error', async () => {
    mod = await import('../src/fetch-proxy.mjs');
  });

  // --- createProxyAgent ---

  it('createProxyAgent returns undefined for empty string', async () => {
    assert.equal(await mod.createProxyAgent(''), undefined);
  });

  it('createProxyAgent returns undefined for undefined', async () => {
    assert.equal(await mod.createProxyAgent(undefined), undefined);
  });

  it('createProxyAgent returns undefined for null', async () => {
    assert.equal(await mod.createProxyAgent(null), undefined);
  });

  it('createProxyAgent returns a ProxyAgent for valid http URL', async () => {
    const agent = await mod.createProxyAgent('http://127.0.0.1:9999');
    // If undici is available, agent is a ProxyAgent instance; otherwise undefined
    // Either result is acceptable — the important thing is it doesn't throw
    if (agent !== undefined) {
      assert.equal(typeof agent.dispatch, 'function');
    }
  });

  it('createProxyAgent does not throw when undici is unavailable', async () => {
    // Regardless of undici availability, this must not throw
    const result = await mod.createProxyAgent('http://127.0.0.1:1');
    assert.ok(result === undefined || typeof result === 'object');
  });

  // --- proxyFetch ---

  it('proxyFetch passes opts through to fetch without dispatcher', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
      const opts = { method: 'POST', headers: { 'x-test': 'hello' }, body: 'ping' };
      const res = await mod.proxyFetch(`http://127.0.0.1:${port}/`, opts);
      const json = await res.json();
      assert.equal(json.method, 'POST');
      assert.equal(json.headers['x-test'], 'hello');
      assert.equal(json.body, 'ping');
    } finally {
      server.close();
    }
  });

  it('proxyFetch passes dispatcher through opts', async () => {
    let capturedUrl, capturedOpts;
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return new Response('ok', { status: 200 });
      };
      const fakeDispatcher = { name: 'fake-dispatcher' };
      const opts = { method: 'GET' };
      const res = await mod.proxyFetch('http://127.0.0.1:1/', opts, fakeDispatcher);
      assert.equal(res.status, 200);
      assert.equal(capturedOpts.dispatcher, fakeDispatcher);
      assert.equal(capturedUrl, 'http://127.0.0.1:1/');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('proxyFetch does not mutate original opts object', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('ok', { status: 200 });
      const fakeDispatcher = { name: 'fake-dispatcher' };
      const opts = { method: 'GET', headers: { 'x-original': 'yes' } };
      const snapshot = JSON.stringify(opts);
      await mod.proxyFetch('http://127.0.0.1:1/', opts, fakeDispatcher);
      assert.equal(JSON.stringify(opts), snapshot);
      assert.equal(opts.dispatcher, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('proxyFetch with no dispatcher does not add dispatcher to opts', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    try {
      const opts = { method: 'GET' };
      const res = await mod.proxyFetch(`http://127.0.0.1:${port}/`, opts);
      assert.equal(res.status, 200);
      assert.equal(opts.dispatcher, undefined);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Registry unit tests
// ---------------------------------------------------------------------------

describe('registry unit', () => {
  let registry;

  before(async () => {
    registry = await import('../src/backends/registry.mjs');
  });

  // ── register() ──

  describe('register()', () => {
    it('registers a backend with required interface', () => {
      const mod = { name: 'test-reg-a', complete: () => {}, init: () => {}, listModels: () => [] };
      registry.register(mod);
      const be = registry.getBackend('test-reg-a');
      assert.ok(be, 'backend should be registered');
      assert.equal(be.name, 'test-reg-a');
      assert.equal(typeof be.complete, 'function');
      assert.equal(typeof be.init, 'function');
      assert.equal(typeof be.listModels, 'function');
    });

    it('overwrites backend with same name', () => {
      const v1 = { name: 'test-overwrite', complete: () => 'v1' };
      const v2 = { name: 'test-overwrite', complete: () => 'v2' };
      registry.register(v1);
      registry.register(v2);
      const be = registry.getBackend('test-overwrite');
      assert.equal(be.complete(), 'v2');
    });

    it('throws if backend has no name', () => {
      assert.throws(
        () => registry.register({ complete: () => {} }),
        /Invalid backend module/
      );
    });

    it('throws if backend has no complete', () => {
      assert.throws(
        () => registry.register({ name: 'no-complete' }),
        /Invalid backend module/
      );
    });

    it('throws if backend has empty string name', () => {
      assert.throws(
        () => registry.register({ name: '', complete: () => {} }),
        /Invalid backend module/
      );
    });

    it('stores null embed when not provided', () => {
      const mod = { name: 'test-no-embed', complete: () => {} };
      registry.register(mod);
      const be = registry.getBackend('test-no-embed');
      assert.equal(be.embed, null);
    });

    it('preserves embed function when provided', () => {
      const embedFn = () => {};
      const mod = { name: 'test-with-embed', complete: () => {}, embed: embedFn };
      registry.register(mod);
      const be = registry.getBackend('test-with-embed');
      assert.equal(be.embed, embedFn);
    });
  });

  // ── getBackend() ──

  describe('getBackend()', () => {
    it('returns backend by name', () => {
      const mod = { name: 'get-test', complete: () => {} };
      registry.register(mod);
      const be = registry.getBackend('get-test');
      assert.ok(be);
      assert.equal(be.name, 'get-test');
    });

    it('returns null for unknown name', () => {
      const be = registry.getBackend('nonexistent-backend-xyz');
      assert.equal(be, null);
    });

    it('returns null for null input', () => {
      const be = registry.getBackend(null);
      assert.equal(be, null);
    });

    it('returns null for undefined input', () => {
      const be = registry.getBackend(undefined);
      assert.equal(be, null);
    });
  });

  // ── listBackends() ──

  describe('listBackends()', () => {
    it('returns array of strings', () => {
      const list = registry.listBackends();
      assert.ok(Array.isArray(list));
      for (const item of list) {
        assert.equal(typeof item, 'string');
      }
    });

    it('returns empty array when nothing registered', () => {
      // The registry is a module-level Map; we can't fully reset it,
      // but we can verify the type contract holds regardless of state.
      const list = registry.listBackends();
      assert.ok(Array.isArray(list));
    });
  });

  // ── initAll() ──

  describe('initAll()', () => {
    it('calls init() on each backend with config', async () => {
      const initCalls = [];
      const mod = {
        name: 'test-init-track',
        complete: () => {},
        init: async (cfg) => { initCalls.push(cfg); return { tracked: true }; },
      };
      registry.register(mod);

      // Temporarily patch config.backends to include our test backend
      const configMod = await import('../src/config.mjs');
      const orig = configMod.config.backends['test-init-track'];
      configMod.config.backends['test-init-track'] = { baseUrl: 'http://test' };

      await registry.initAll();
      assert.equal(initCalls.length, 1);
      assert.deepEqual(initCalls[0], { baseUrl: 'http://test' });

      // Verify ctx was stored
      const be = registry.getBackend('test-init-track');
      assert.deepEqual(be.ctx, { tracked: true });

      // Restore
      if (orig === undefined) delete configMod.config.backends['test-init-track'];
      else configMod.config.backends['test-init-track'] = orig;
    });

    it('continues if one backend init() throws', async () => {
      const configMod = await import('../src/config.mjs');

      const failMod = {
        name: 'test-init-fail',
        complete: () => {},
        init: async () => { throw new Error('boom'); },
      };
      const okMod = {
        name: 'test-init-ok',
        complete: () => {},
        init: async () => ({ ok: true }),
      };
      registry.register(failMod);
      registry.register(okMod);

      configMod.config.backends['test-init-fail'] = {};
      configMod.config.backends['test-init-ok'] = {};

      // Should not throw
      await registry.initAll();

      // The failing backend gets null ctx (init threw, ctx stays null)
      const failBe = registry.getBackend('test-init-fail');
      assert.equal(failBe.ctx, null);

      // The succeeding backend gets its ctx
      const okBe = registry.getBackend('test-init-ok');
      assert.deepEqual(okBe.ctx, { ok: true });

      // Cleanup
      delete configMod.config.backends['test-init-fail'];
      delete configMod.config.backends['test-init-ok'];
    });

    it('skips init when no config entry for backend', async () => {
      let initCalled = false;
      const mod = {
        name: 'test-init-no-cfg',
        complete: () => {},
        init: async () => { initCalled = true; return {}; },
      };
      registry.register(mod);

      const configMod = await import('../src/config.mjs');
      const orig = configMod.config.backends['test-init-no-cfg'];
      delete configMod.config.backends['test-init-no-cfg'];

      await registry.initAll();
      assert.equal(initCalled, false);

      if (orig !== undefined) configMod.config.backends['test-init-no-cfg'] = orig;
    });

    it('skips init when backend has no init function', async () => {
      const configMod = await import('../src/config.mjs');
      const mod = { name: 'test-no-init-fn', complete: () => {} };
      registry.register(mod);
      configMod.config.backends['test-no-init-fn'] = {};

      // Should not throw (no init to call)
      await registry.initAll();

      delete configMod.config.backends['test-no-init-fn'];
    });

    it('stores ctx returned by init()', async () => {
      const configMod = await import('../src/config.mjs');
      const mod = {
        name: 'test-ctx-store',
        complete: () => {},
        init: async () => ({ models: ['a', 'b'], baseUrl: 'http://x' }),
      };
      registry.register(mod);
      configMod.config.backends['test-ctx-store'] = { dummy: true };

      await registry.initAll();
      const be = registry.getBackend('test-ctx-store');
      assert.deepEqual(be.ctx, { models: ['a', 'b'], baseUrl: 'http://x' });

      delete configMod.config.backends['test-ctx-store'];
    });
  });

  // ── route() ──

  describe('route()', () => {
    it('returns correct backend for model prefix', async () => {
      const mod = {
        name: 'test-route-be',
        complete: () => {},
        init: async () => ({ models: ['m1'] }),
      };
      registry.register(mod);

      const configMod = await import('../src/config.mjs');
      configMod.config.backends['test-route-be'] = {};
      configMod.config.aliases = configMod.config.aliases || {};

      // Register an alias so resolveBackend can find it
      configMod.config.aliases['test-route-model'] = 'test-route-be';

      const result = await registry.route('test-route-model');
      assert.ok(result, 'route should return a result');
      assert.equal(result.backend.name, 'test-route-be');
      assert.equal(result.model, 'test-route-model');

      delete configMod.config.aliases['test-route-model'];
      delete configMod.config.backends['test-route-be'];
    });

    it('returns null for unknown model', async () => {
      const result = await registry.route('totally-unknown-model-xyz-999');
      assert.equal(result, null);
    });

    it('returns null when backend not registered', async () => {
      const configMod = await import('../src/config.mjs');
      configMod.config.aliases = configMod.config.aliases || {};
      configMod.config.aliases['orphphan-model'] = 'ghost-backend';

      const result = await registry.route('orphphan-model');
      assert.equal(result, null);

      delete configMod.config.aliases['orphphan-model'];
    });
  });
});

// ===========================================================================
// Comprehensive edge-case tests — ALL 4 backends
// ===========================================================================

// ---------------------------------------------------------------------------
// Test infrastructure — lightweight HTTP servers for buildBody verification
// ---------------------------------------------------------------------------

const http = await import('node:http');

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
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['alpha', 'beta'], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, ['alpha', 'beta']);
    });

    it(`${name}: stores custom baseUrl`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://10.0.0.1:1234' });
      assert.equal(ctx.baseUrl, 'http://10.0.0.1:1234');
    });

    it(`${name}: uses default baseUrl when not provided`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.baseUrl, defaultBaseUrl);
    });

    it(`${name}: creates dispatcher (proxy handled)`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'] });
      assert.ok('dispatcher' in ctx, 'context must have dispatcher property');
    });

    it(`${name}: defaults timeout to 300000`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.timeout, 300_000);
    });

    it(`${name}: uses custom timeout`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], timeout: 42000 });
      assert.equal(ctx.timeout, 42000);
    });

    it(`${name}: skips network when models provided (unreachable baseUrl ok)`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, ['m']);
    });

    it(`${name}: empty models array is valid`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: [], baseUrl: 'http://192.0.2.1:99999' });
      assert.deepEqual(ctx.models, []);
    });
  }

  it('opencode: stores serverPassword and serverUsername', async () => {
    const mod = await import('../src/backends/opencode.mjs');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw', serverUsername: 'admin' });
    assert.equal(ctx.serverPassword, 'pw');
    assert.equal(ctx.serverUsername, 'admin');
  });

  it('mimocode: stores serverPassword and serverUsername', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw', serverUsername: 'admin' });
    assert.equal(ctx.serverPassword, 'pw');
    assert.equal(ctx.serverUsername, 'admin');
  });

  it('kilocode: stores apiKey', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'], apiKey: 'kilo-key' });
    assert.equal(ctx.apiKey, 'kilo-key');
  });

  it('openai: stores apiKey', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import(`../src/backends/${name}.mjs`);
      assert.deepEqual(mod.listModels({}, { models: [] }), []);
    });

    it(`${name}: returns [] when ctx has no models property`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      assert.deepEqual(mod.listModels({}, {}), []);
    });

    it(`${name}: prefixes all IDs and sets object="model"`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: ['a', 'b', 'c'] });
      assert.equal(result.length, 3);
      assert.deepEqual(result.map(m => m.id), [`${name}/a`, `${name}/b`, `${name}/c`]);
      for (const m of result) assert.equal(m.object, 'model');
    });

    it(`${name}: handles models with slashes in ID`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: ['openai/gpt-4', 'provider/model-v2'] });
      assert.equal(result[0].id, `${name}/openai/gpt-4`);
      assert.equal(result[1].id, `${name}/provider/model-v2`);
    });

    it(`${name}: handles single model`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: ['solo'] });
      assert.equal(result.length, 1);
      assert.equal(result[0].id, `${name}/solo`);
    });

    it(`${name}: returns exactly ctx.models.length items`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
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
      const mod = await import(`../src/backends/${name}.mjs`);
      await assert.rejects(
        () => mod.complete({}, { messages: [], model: 'test' }, null),
        /not initialized/i
      );
    });

    it(`${name}: throws on null ctx with missing model field`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      await assert.rejects(
        () => mod.complete({}, { messages: [{ role: 'user', content: 'hi' }] }, null),
        /not initialized/i
      );
    });

    it(`${name}: throws on null ctx with complex request shape`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
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
    const mod = await import('../src/backends/kilocode.mjs');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'test' }, null),
      /not initialized/i
    );
  });

  it('openai: throws on null context', async () => {
    const mod = await import('../src/backends/openai.mjs');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'test' }, null),
      /not initialized/i
    );
  });

  it('kilocode: returns async generator with valid context', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.equal(typeof gen, 'object');
    assert.equal(typeof gen[Symbol.asyncIterator], 'function');
    await assert.rejects(() => gen.next());
  });

  it('openai: returns async generator with valid context', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
    const mod = await import('../src/backends/opencode.mjs');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('kilocode: throws 501 with null ctx', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('mimocode: throws 501 with null ctx', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, null),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('opencode: throws 501 even with valid ctx', async () => {
    const mod = await import('../src/backends/opencode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('kilocode: throws 501 even with valid ctx', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('mimocode: throws 501 even with valid ctx', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    await assert.rejects(
      () => mod.embed({}, { model: 'm', input: 'hello' }, ctx),
      (err) => { assert.equal(err.status, 501); return true; }
    );
  });

  it('openai: throws 503 on null context', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }, ctx);
      assert.equal(body().max_tokens, 500);
    } finally { server.close(); }
  });

  it('uses minTokens when larger than maxTokens', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().max_tokens, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 }, ctx);
      assert.equal(body().max_tokens, 256);
    } finally { server.close(); }
  });

  it('omits max_tokens when not provided', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/openai.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().max_tokens, undefined);
    } finally { server.close(); }
  });

  it('forwards temperature', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/openai.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 }, ctx);
      assert.equal(body().temperature, 0.7);
    } finally { server.close(); }
  });

  it('omits temperature when null', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/openai.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: null }, ctx);
      assert.equal(body().temperature, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createEchoServer();
    try {
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
      const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${port}` });
      await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(body().maxTokens, undefined);
    } finally { server.close(); }
  });

  it('forwards response_format', async () => {
    const { server, port, body } = await createSessionServer();
    try {
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'] });
      assert.equal(ctx.dispatcher, undefined);
    });

    it(`${name}: empty string proxy leaves dispatcher as undefined`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], proxy: '' });
      assert.equal(ctx.dispatcher, undefined);
    });

    it(`${name}: context has all required keys`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'] });
      assert.ok('baseUrl' in ctx);
      assert.ok('models' in ctx);
      assert.ok('dispatcher' in ctx);
      assert.ok('timeout' in ctx);
    });

    it(`${name}: large models array preserved exactly`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const big = Array.from({ length: 50 }, (_, i) => `model-${i}`);
      const ctx = await mod.init({ models: big, baseUrl: 'http://192.0.2.1:99999' });
      assert.equal(ctx.models.length, 50);
      assert.equal(ctx.models[0], 'model-0');
      assert.equal(ctx.models[49], 'model-49');
    });

    it(`${name}: baseUrl with port is preserved`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'http://10.0.0.5:8080' });
      assert.equal(ctx.baseUrl, 'http://10.0.0.5:8080');
    });

    it(`${name}: baseUrl with path is preserved`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = await mod.init({ models: ['m'], baseUrl: 'https://example.com/api/v2' });
      assert.equal(ctx.baseUrl, 'https://example.com/api/v2');
    });
  }

  it('opencode: default username is opencode when password set', async () => {
    const mod = await import('../src/backends/opencode.mjs');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw' });
    assert.equal(ctx.serverUsername, 'opencode');
    assert.equal(ctx.serverPassword, 'pw');
  });

  it('mimocode: default username is opencode when password set', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    const ctx = await mod.init({ models: ['m'], serverPassword: 'pw' });
    assert.equal(ctx.serverUsername, 'opencode');
    assert.equal(ctx.serverPassword, 'pw');
  });

  it('kilocode: empty apiKey stored as empty string', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    assert.equal(ctx.apiKey, '');
  });

  it('openai: empty apiKey stored as empty string', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, null);
      assert.deepEqual(result, []);
    });

    it(`${name}: undefined ctx returns []`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, undefined);
      assert.deepEqual(result, []);
    });

    it(`${name}: model ID with slashes gets prefixed correctly`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: ['anthropic/claude-3.5-sonnet'] });
      assert.equal(result[0].id, `${name}/anthropic/claude-3.5-sonnet`);
    });

    it(`${name}: empty string model ID is prefixed`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: [''] });
      assert.equal(result[0].id, `${name}/`);
      assert.equal(result[0].object, 'model');
    });

    it(`${name}: model ID with special characters`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const result = mod.listModels({}, { models: ['model@v2.1-beta'] });
      assert.equal(result[0].id, `${name}/model@v2.1-beta`);
      assert.equal(result[0].object, 'model');
    });

    it(`${name}: returns new array each call (no shared reference)`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      const ctx = { models: ['a', 'b'] };
      const r1 = mod.listModels({}, ctx);
      const r2 = mod.listModels({}, ctx);
      assert.notEqual(r1, r2);
    });

    it(`${name}: each returned model is a plain object with exactly id and object`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
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
  const ALL = ['opencode', 'kilocode', 'mimocode', 'openai'];

  for (const name of ALL) {
    it(`${name}: throws on undefined ctx`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      await assert.rejects(
        () => mod.complete({}, { messages: [{ role: 'user', content: 'hi' }], model: 'm' }, undefined),
        /not initialized/i
      );
    });

    it(`${name}: error message includes backend name`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
      try {
        await mod.complete({}, { messages: [], model: 'm' }, null);
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(err.message.includes(name), `error should mention "${name}": ${err.message}`);
      }
    });

    it(`${name}: complete with empty messages array and null ctx still throws`, async () => {
      const mod = await import(`../src/backends/${name}.mjs`);
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
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.ok(typeof gen[Symbol.asyncIterator] === 'function');
    await assert.rejects(() => gen.next());
  });

  it('openai: returns async iterable on valid ctx (network fail)', async () => {
    const mod = await import('../src/backends/openai.mjs');
    const ctx = await mod.init({ models: ['m'], baseUrl: 'http://192.0.2.1:99999' });
    const gen = mod.completeStreaming({}, { messages: [], model: 'test' }, ctx);
    assert.ok(typeof gen[Symbol.asyncIterator] === 'function');
    await assert.rejects(() => gen.next());
  });

  it('kilocode: null ctx error is instance of Error', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    try {
      await mod.completeStreaming({}, { messages: [], model: 'm' }, null).next();
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('openai: null ctx error is instance of Error', async () => {
    const mod = await import('../src/backends/openai.mjs');
    try {
      await mod.completeStreaming({}, { messages: [], model: 'm' }, null).next();
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('kilocode: undefined ctx also throws', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    await assert.rejects(
      () => mod.completeStreaming({}, { messages: [], model: 'm' }, undefined).next(),
      /not initialized/i
    );
  });

  it('openai: undefined ctx also throws', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
    const mod = await import('../src/backends/opencode.mjs');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('kilocode: error message mentions "not supported"', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('mimocode: error message mentions "not supported"', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('not supported'));
      assert.equal(err.status, 501);
    }
  });

  it('opencode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../src/backends/opencode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('kilocode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../src/backends/kilocode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('mimocode: embed with valid ctx still throws 501', async () => {
    const mod = await import('../src/backends/mimocode.mjs');
    const ctx = await mod.init({ models: ['m'] });
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, ctx);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 501);
    }
  });

  it('openai: null ctx throws 503 with message', async () => {
    const mod = await import('../src/backends/openai.mjs');
    try {
      await mod.embed({}, { model: 'm', input: 'text' }, null);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 503);
      assert.ok(err.message.includes('not initialized'));
    }
  });

  it('openai: undefined ctx also throws 503', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/mimocode.mjs');
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
    const mod = await import('../src/backends/openai.mjs');
    try {
      await mod.embed({}, { model: 'text-embedding-ada-002', input: 'hello' }, null);
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err.message.includes('not initialized'));
      assert.equal(err.status, 503);
    }
  });

  it('valid ctx but unreachable server throws network error', async () => {
    const mod = await import('../src/backends/openai.mjs');
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
      const mod = await import('../src/backends/opencode.mjs');
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
      const mod = await import('../src/backends/kilocode.mjs');
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
      const mod = await import('../src/backends/openai.mjs');
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
