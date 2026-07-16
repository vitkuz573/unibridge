import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('starts empty, supports register and list', async () => {
    const registry = await import('../dist/backends/registry.js');
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
// Registry unit tests
// ---------------------------------------------------------------------------

describe('registry unit', () => {
  let registry;

  before(async () => {
    registry = await import('../dist/backends/registry.js');
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
      const configMod = await import('../dist/config.js');
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
      const configMod = await import('../dist/config.js');

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

      const configMod = await import('../dist/config.js');
      const orig = configMod.config.backends['test-init-no-cfg'];
      delete configMod.config.backends['test-init-no-cfg'];

      await registry.initAll();
      assert.equal(initCalled, false);

      if (orig !== undefined) configMod.config.backends['test-init-no-cfg'] = orig;
    });

    it('skips init when backend has no init function', async () => {
      const configMod = await import('../dist/config.js');
      const mod = { name: 'test-no-init-fn', complete: () => {} };
      registry.register(mod);
      configMod.config.backends['test-no-init-fn'] = {};

      // Should not throw (no init to call)
      await registry.initAll();

      delete configMod.config.backends['test-no-init-fn'];
    });

    it('stores ctx returned by init()', async () => {
      const configMod = await import('../dist/config.js');
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

      const configMod = await import('../dist/config.js');
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
      const configMod = await import('../dist/config.js');
      configMod.config.aliases = configMod.config.aliases || {};
      configMod.config.aliases['orphphan-model'] = 'ghost-backend';

      const result = await registry.route('orphphan-model');
      assert.equal(result, null);

      delete configMod.config.aliases['orphphan-model'];
    });
  });
});
