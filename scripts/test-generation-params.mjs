import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The openai backend is the whole point of "any OpenAI-compatible server", and
// the OpenAI contract carries generation knobs. It used to forward four of them
// and silently drop the rest, so `top_p: 0.1` and `seed: 42` were accepted,
// billed, cached, and then answered as if the caller had never sent them.

/** Captures the params the backend hands to the SDK. */
function captureParams(request, { model = 'gpt-4o' } = {}) {
  let seen = null;
  const ctx = {
    baseUrl: 'http://stub/v1',
    apiKey: 'k',
    models: [],
    dispatcher: undefined,
    timeout: 1000,
    client: {
      chat: {
        completions: {
          create: async (params) => {
            seen = params;
            return { id: 'x', object: 'chat.completion', created: 0, model, choices: [] };
          },
        },
      },
      embeddings: { create: async () => ({ data: [] }) },
      models: { list: async () => ({ data: [] }) },
    },
  };
  return { ctx, get: () => seen, model };
}

const BASE = {
  messages: [{ role: 'user', content: 'hi' }],
  model: 'gpt-4o',
};

describe('openai backend — generation parameters', () => {
  it('forwards every knob the OpenAI contract defines', async () => {
    const mod = await import('../src/backends/openai.ts');
    const { ctx, get } = captureParams({});
    await mod.complete({}, {
      ...BASE,
      maxTokens: 256,
      temperature: 0.25,
      topP: 0.9,
      stop: ['\n\n'],
      seed: 1234,
      presencePenalty: 0.5,
      frequencyPenalty: -0.25,
      n: 2,
      logprobs: true,
      topLogprobs: 3,
      logitBias: { '42': -100 },
      parallelToolCalls: false,
      user: 'tenant-7',
    }, ctx);

    assert.deepEqual(get(), {
      model: 'gpt-4o',
      messages: BASE.messages,
      max_tokens: 256,
      temperature: 0.25,
      top_p: 0.9,
      stop: ['\n\n'],
      seed: 1234,
      presence_penalty: 0.5,
      frequency_penalty: -0.25,
      n: 2,
      logprobs: true,
      top_logprobs: 3,
      logit_bias: { '42': -100 },
      parallel_tool_calls: false,
      user: 'tenant-7',
    });
  });

  it('treats 0 as a value, not as absent', async () => {
    // A truthiness test drops every one of these, and they are precisely the
    // values a caller sets on purpose: deterministic output, no repeat, no
    // length limit, no penalty.
    const mod = await import('../src/backends/openai.ts');
    for (const [field, wire] of [
      ['maxTokens', 'max_tokens'],
      ['temperature', 'temperature'],
      ['topP', 'top_p'],
      ['seed', 'seed'],
      ['presencePenalty', 'presence_penalty'],
      ['frequencyPenalty', 'frequency_penalty'],
      ['n', 'n'],
    ]) {
      const { ctx, get } = captureParams({});
      await mod.complete({}, { ...BASE, [field]: 0 }, ctx);
      assert.equal(get()[wire], 0, `${field}: 0 must reach the wire`);
    }
  });

  it('omits a knob the caller never set', async () => {
    const mod = await import('../src/backends/openai.ts');
    const { ctx, get } = captureParams({});
    await mod.complete({}, BASE, ctx);
    assert.deepEqual(get(), { model: 'gpt-4o', messages: BASE.messages });
  });

  it('advertises the knobs it can apply', async () => {
    const mod = await import('../src/backends/openai.ts');
    const [info] = mod.listModels({}, { models: ['gpt-4o'] });
    assert.equal(info.capabilities.temperature, true);
    assert.equal(info.capabilities.max_tokens, true);
  });
});

describe('kilocode backend — generation parameters', () => {
  it('forwards the knobs the Gateway contract defines', async () => {
    const mod = await import('../src/backends/kilocode.ts');
    let seen = null;
    const ctx = {
      baseUrl: 'https://api.kilo.ai/api/gateway/v1',
      apiKey: 'k',
      models: [],
      dispatcher: undefined,
      timeout: 1000,
      client: {
        chat: {
          completions: {
            create: async (params) => {
              seen = params;
              return { id: 'x', object: 'chat.completion', created: 0, choices: [] };
            },
          },
        },
        models: { list: async () => ({ data: [] }) },
      },
    };
    await mod.complete({}, {
      ...BASE,
      temperature: 0,
      topP: 0.5,
      seed: 9,
      frequencyPenalty: 0.1,
    }, ctx);
    assert.equal(seen.temperature, 0);
    assert.equal(seen.top_p, 0.5);
    assert.equal(seen.seed, 9);
    assert.equal(seen.frequency_penalty, 0.1);
  });
});

describe('opencode backend — the knobs it cannot apply', () => {
  it('reports both as unsupported rather than pretending', async () => {
    // The v2 session prompt payload is `{text, files, agents, skills,
    // metadata}` and closes itself to additional properties; the server's own
    // OpenAPI document has no field named temperature, maxTokens, top_p, seed
    // or providerOptions anywhere in 116 endpoints. So a request carrying them
    // is accepted and dropped, and the only honest advertisement is false.
    const mod = await import('../src/backends/opencode.ts');
    const caps = mod.capabilitiesFor({ capabilities: { tools: true, input: ['text'] } });
    assert.equal(caps.temperature, false);
    assert.equal(caps.max_tokens, false);
  });
});