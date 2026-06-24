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
