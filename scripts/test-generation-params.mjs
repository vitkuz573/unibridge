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
    for (const field of [
      'max_tokens',
      'temperature',
      'top_p',
      'seed',
      'presence_penalty',
      'frequency_penalty',
      'n',
    ]) {
      const { ctx, get } = captureParams({});
      await mod.complete({}, { ...BASE, [field]: 0 }, ctx);
      assert.equal(get()[field], 0, `${field}: 0 must reach the wire`);
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
      top_p: 0.5,
      seed: 9,
      frequency_penalty: 0.1,
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
    // or providerOptions anywhere in 116 endpoints.
    //
    // The one route that does exist is a variant's `body`, which opencode
    // merges into the provider request — verified on 2.0.20 against a capture
    // provider. A model with no such variant therefore cannot apply these, and
    // saying so is the honest advertisement.
    const mod = await import('../src/backends/opencode.ts');
    const caps = mod.capabilitiesFor({ capabilities: { tools: true, input: ['text'] }, variants: [] });
    assert.equal(caps.temperature, false);
    assert.equal(caps.max_tokens, false);
  });

  it('reports what a model that does carry them can apply', async () => {
    // The flag is read from the model's own variants, so a model an operator
    // gave generation variants stops advertising a knob that would be dropped.
    const mod = await import('../src/backends/opencode.ts');
    const both = mod.capabilitiesFor({
      capabilities: { tools: true, input: ['text'] },
      variants: [
        { id: 'a', body: { temperature: 0.1, max_tokens: 100 } },
        { id: 'b', body: { temperature: 0.9, max_tokens: 900 } },
      ],
    });
    assert.equal(both.temperature, true);
    assert.equal(both.max_tokens, true);

    const tempOnly = mod.capabilitiesFor({
      capabilities: { tools: true, input: ['text'] },
      variants: [{ id: 'a', body: { temperature: 0.1 } }],
    });
    assert.equal(tempOnly.temperature, true);
    assert.equal(tempOnly.max_tokens, false, 'one knob is not the other');
  });

  it('counts a variant whose settings only carry reasoningEffort as unable', async () => {
    // `settings` goes to the runtime package's provider options; that is how
    // reasoningEffort reaches the model, and it is not how temperature would.
    const mod = await import('../src/backends/opencode.ts');
    const caps = mod.capabilitiesFor({
      capabilities: { tools: true, input: ['text'] },
      variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }],
    });
    assert.equal(caps.temperature, false);
    assert.equal(caps.max_tokens, false);
  });
});
describe('the two OpenAI-compatible backends forward identically', () => {
  // kilocode carried its own field list and it had fallen behind: logprobs,
  // top_logprobs, logit_bias and reasoning_effort were on none of it. A caller
  // asking the same question of two servers configured against this gateway
  // got two different questions answered — silently, since a dropped parameter
  // still returns 200.
  const ECHO = `
    const http = await import('node:http');
    const state = { body: null };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        state.body = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    state.baseUrl = 'http://127.0.0.1:' + server.address().port;
    state.close = () => new Promise(r => server.close(r));
    return state;
  `;

  const newEcho = () => (0, eval)(`(async () => { ${ECHO} })()`);

  const REQUEST = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    temperature: 0.3,
    top_p: 0.8,
    seed: 7,
    logprobs: true,
    top_logprobs: 2,
    logit_bias: { '42': -100 },
    reasoning_effort: 'low',
    user: 'tenant-7',
    stop: ['\n'],
  };

  async function forwardedBy(name) {
    const echo = await newEcho();
    try {
      const mod = await import(`../src/backends/${name}.ts`);
      const ctx = await mod.init({ models: ['m'], baseUrl: echo.baseUrl });
      await mod.complete({}, REQUEST, ctx);
      return echo.body;
    } finally {
      await echo.close();
    }
  }

  it('sends the same body for both', async () => {
    // Both bodies come off the wire, so this compares what each backend
    // actually sent rather than two readings of a hand-written field list.
    assert.deepEqual(await forwardedBy('kilocode'), await forwardedBy('openai'));
  });

  it('kilocode no longer drops the fields its list forgot', async () => {
    const body = await forwardedBy('kilocode');
    for (const field of ['logprobs', 'top_logprobs', 'logit_bias', 'reasoning_effort']) {
      assert.ok(field in body, `kilocode drops ${field}`);
    }
  });
});
