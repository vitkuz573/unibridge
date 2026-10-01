import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requestKey } from '../src/cache.ts';

// The cache key used to be assembled by hand at each call site — backend, model,
// messages, max_tokens, plus a fourth argument each handler remembered to fill in.
// Two requests differing only in a knob nobody listed shared one entry, so the
// gateway replayed a stored answer as if it were the answer to this one.

const base = {
  messages: [{ role: 'user', content: 'hi' }],
  model: 'gpt-4o',
};

describe('cache key', () => {
  it('separates requests that differ in any generation parameter', () => {
    const key = (patch) => requestKey('openai', 'gpt-4o', { ...base, ...patch });
    const reference = key({});
    for (const patch of [
      { temperature: 0.2 },
      { topP: 0.9 },
      { stop: ['\n'] },
      { seed: 1 },
      { presencePenalty: 0.5 },
      { frequencyPenalty: 0.5 },
      { n: 2 },
      { maxTokens: 10 },
      { maxTokens: 4000 },
      { parallelToolCalls: false },
      { user: 'tenant-7' },
      { logitBias: { '1': -100 } },
      { response_format: { type: 'json_object' } },
      { tools: [{ type: 'function' }] },
    ]) {
      assert.notEqual(key(patch), reference, JSON.stringify(patch));
    }
  });

  it('separates requests that differ in the message order', () => {
    // The conversation *is* the order. Normalising it gives [Q1, A1, Q2] and
    // [Q2, A1, Q1] one key, which answers one question with another's reply.
    const forward = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ];
    const a = requestKey('openai', 'gpt-4o', { ...base, messages: forward });
    const b = requestKey('openai', 'gpt-4o', { ...base, messages: [...forward].reverse() });
    assert.notEqual(a, b);
  });

  it('separates tenants and models', () => {
    const request = { ...base };
    assert.notEqual(requestKey('a', 'm', request), requestKey('b', 'm', request));
    assert.notEqual(requestKey('a', 'm', request), requestKey('a', 'n', request));
  });

  it('does not let a separator inside a name forge another key', () => {
    // Concatenation made these one key, because `:` separated the parts.
    assert.notEqual(
      requestKey('a:b', 'c', { ...base, model: 'm' }),
      requestKey('a', 'b:c', { ...base, model: 'm' }),
    );
  });

  it('treats spelling differences that are not differences', () => {
    assert.equal(
      requestKey('openai', 'gpt-4o', { ...base, temperature: 1.0 }),
      requestKey('openai', 'gpt-4o', { ...base, temperature: 1 }),
    );
    // A parameter object written in a different order is the same request.
    assert.equal(
      requestKey('openai', 'gpt-4o', { ...base, a: 1, b: 2 }),
      requestKey('openai', 'gpt-4o', { ...base, b: 2, a: 1 }),
    );
  });
});

describe('response cache', () => {
  it('is bounded, because expiry alone is not a bound', async () => {
    const { ResponseCache } = await import('../src/cache.ts');
    const cache = new ResponseCache(60_000, 10);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, { i });
    assert.equal(cache.size, 10);
    // The newest survive; the oldest are the ones nobody asked for twice.
    assert.deepEqual(cache.get('k99'), { i: 99 });
    assert.equal(cache.get('k0'), null);
  });
});