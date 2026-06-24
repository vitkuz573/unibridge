import { describe, it } from 'node:test';
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
