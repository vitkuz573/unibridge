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
