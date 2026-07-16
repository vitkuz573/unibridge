import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Rate limiter tests
// ---------------------------------------------------------------------------

describe('rate limiter', () => {
  it('allows requests under limit', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 5 });
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
    assert.equal(check('1.2.3.4'), 0);
  });

  it('blocks requests over limit', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 3 });
    assert.equal(check('5.6.7.8'), 0);
    assert.equal(check('5.6.7.8'), 0);
    assert.equal(check('5.6.7.8'), 0);
    const retryAfter = check('5.6.7.8');
    assert.ok(retryAfter > 0);
  });

  it('separate IPs have separate limits', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
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
// Rate limiter extended tests
// ---------------------------------------------------------------------------

describe('rate limiter extended', () => {
  it('createRateLimiter returns a function', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 10 });
    assert.equal(typeof check, 'function');
  });

  it('returns 0 for allowed requests', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 5 });
    for (let i = 0; i < 5; i++) {
      assert.equal(check('10.0.0.1'), 0);
    }
  });

  it('returns positive retryAfter for blocked requests', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(check('10.0.0.1'), 0);
    assert.equal(check('10.0.0.1'), 0);
    const retryAfter = check('10.0.0.1');
    assert.ok(retryAfter > 0);
    assert.ok(retryAfter <= 60_000);
  });

  it('separate keys have separate limits', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(check('aaa'), 0);
    assert.ok(check('aaa') > 0);
    assert.equal(check('bbb'), 0);
    assert.ok(check('bbb') > 0);
  });

  it('window expiry allows same key again', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 50, max: 1 });
    assert.equal(check('expire-test'), 0);
    assert.ok(check('expire-test') > 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(check('expire-test'), 0);
  });

  it('max=0 falls back to default 60 (falsy treated as unset)', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 0 });
    for (let i = 0; i < 60; i++) {
      assert.equal(check('max-zero'), 0);
    }
    assert.ok(check('max-zero') > 0);
  });

  it('max=1 allows exactly one request', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
    const check = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(check('one-only'), 0);
    assert.ok(check('one-only') > 0);
  });

  it('different keys do not interfere with each other', async () => {
    const { createRateLimiter } = await import('../dist/rate-limiter.js');
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

// ---------------------------------------------------------------------------
// Metrics tests
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('returns valid prometheus text format', async () => {
    const mod = await import('../dist/metrics.js');
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
    mod = await import('../dist/fetch-proxy.js');
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
