import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createV2Mock, v2TextEvents } from './helpers/opencode-v2-mock.mjs';

// ---------------------------------------------------------------------------
// Chat-completions stream terminals, end to end through the real HTTP server
// and a mock of the opencode v2 API.
//
// The clientTools decision contract can fail in several ways (prose answer,
// invalid JSON, upstream abort). Every path must end with exactly one terminal
// frame: either a finish_reason chunk plus `data: [DONE]`, or an OpenAI error
// frame plus `data: [DONE]`. A bare EOF is the bug this suite locks down.
// ---------------------------------------------------------------------------

const REPO = path.resolve(new URL('..', import.meta.url).pathname);

const TOOLS = [{
  type: 'function',
  function: {
    name: 'list_hosts',
    description: 'List hosts',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}];

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Minimal opencode v2 stand-in for the abort scenario: streams one delta and
// then destroys the socket.
async function createAbortUpstream() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST' && url === '/api/session') return json({ data: { id: 'ses-abort' } });
    if (req.method === 'POST' && url.endsWith('/prompt')) return json({ data: {} });
    if (req.method === 'GET' && url.startsWith('/api/session/ses-abort/permission')) return json({ data: [] });
    if (req.method === 'GET' && url.startsWith('/api/session/ses-abort/message')) return json({ data: [], cursor: {} });
    if (req.method === 'DELETE' && url.startsWith('/api/session/ses-abort')) {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url === '/api/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        type: 'session.text.delta',
        data: { sessionID: 'ses-abort', assistantMessageID: 'msg_a', ordinal: 0, delta: '{"type":"text","text":"partial ans' },
      })}\n\n`);
      setTimeout(() => {
        if (typeof res.socket?.resetAndDestroy === 'function') res.socket.resetAndDestroy();
        else res.destroy();
      }, 20);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** v2 mock whose events depend on the session attempt number. */
async function createScenarioUpstream(scenario) {
  const mock = await createV2Mock({
    models: [],
    events: (sessionID) => scenario(Number(sessionID.split('_').pop())),
  });
  return mock;
}

async function startUnibridge(upstreamPort) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-terminal-'));
  const configPath = path.join(dir, 'unibridge.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port,
    host: '127.0.0.1',
    apiKey: 'test-key',
    logFile: path.join(dir, 'unibridge.log'),
    streaming: true,
    backends: {
      opencode: {
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        streaming: true,
        clientTools: true,
        timeout: 15000,
        models: ['m'],
      },
    },
  }));
  const child = spawn(process.execPath, [path.join(REPO, 'dist', 'cli.js'), '--config', configPath], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { child, base, dir };
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`unibridge did not start:\n${logs.join('')}`);
}

async function stopUnibridge(instance) {
  instance.child.kill('SIGTERM');
  await new Promise(resolve => {
    instance.child.once('exit', resolve);
    setTimeout(() => {
      instance.child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
  fs.rmSync(instance.dir, { recursive: true, force: true });
}

async function chat(base, body) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = [];
  let done = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done += 1;
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ unparseable: data });
    }
  }
  return { status: res.status, events, done, text };
}

function deltas(result, field) {
  return result.events
    .flatMap(event => event.choices || [])
    .map(choice => choice.delta?.[field])
    .filter(value => typeof value === 'string');
}

function finishReasons(result) {
  return result.events
    .flatMap(event => event.choices || [])
    .filter(choice => choice.finish_reason != null)
    .map(choice => choice.finish_reason);
}

function errors(result) {
  return result.events.filter(event => event.error).map(event => event.error);
}

function usageEvents(result) {
  return result.events.filter(event => event.usage);
}

async function withScenarioUpstream(scenario, run) {
  const upstream = await createScenarioUpstream(scenario);
  let instance;
  try {
    instance = await startUnibridge(upstream.port);
    await run({ ...instance, upstream });
  } finally {
    if (instance) await stopUnibridge(instance);
    await upstream.close();
  }
}

async function withAbortUpstream(run) {
  const upstream = await createAbortUpstream();
  let instance;
  try {
    instance = await startUnibridge(upstream.port);
    await run({ ...instance, upstream });
  } finally {
    if (instance) await stopUnibridge(instance);
    upstream.server.close();
  }
}

const ASK_TOOLS = {
  model: 'opencode/m',
  messages: [{ role: 'user', content: 'сколько хостов онлайн?' }],
  stream: true,
  tools: TOOLS,
  tool_choice: 'auto',
};

describe('chat stream terminals — clientTools', () => {
  it('invalid decision with a prose answer streams the text and one [DONE]', async () => {
    const prose = 'Я ассистент RemoteMaster и отвечаю текстом.';
    await withScenarioUpstream(() => v2TextEvents({ text: prose, usage: { input: 10, output: 6, reasoning: 0, cache: { read: 0, write: 0 } } }),
    async ({ base, upstream }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.status, 200);
      assert.equal(result.done, 1, 'exactly one [DONE]');
      assert.deepEqual(errors(result), [], 'no error frame');
      assert.equal(deltas(result, 'content').join(''), prose, 'model answer is not lost');
      assert.deepEqual(finishReasons(result), ['stop']);
      assert.equal(upstream.state.sessionCalls, 1, 'salvage, not a retry');
    });
  });

  it('invalid decision without text ends with an error frame and one [DONE]', async () => {
    await withScenarioUpstream(() => v2TextEvents({ text: '{"type":"function_call"}' }),
    async ({ base, upstream }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.status, 200);
      assert.equal(result.done, 1, 'exactly one [DONE]');
      const frameErrors = errors(result);
      assert.equal(frameErrors.length, 1, 'one structured error frame');
      assert.equal(frameErrors[0].type, 'server_error');
      assert.equal(frameErrors[0].code, 502);
      assert.equal(deltas(result, 'content').join(''), '');
      assert.deepEqual(finishReasons(result), [], 'error replaces the finish chunk');
      assert.equal(upstream.state.sessionCalls, 3, 'invalid replies are retried before failing');
    });
  });

  it('valid function_call decision surfaces tool_calls with a tool_calls finish', async () => {
    const decision = JSON.stringify({ type: 'function_call', calls: [{ name: 'list_hosts', arguments: {} }] });
    await withScenarioUpstream(() => v2TextEvents({ text: decision, usage: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }),
    async ({ base }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.done, 1);
      assert.deepEqual(errors(result), []);
      const calls = result.events
        .flatMap(event => event.choices || [])
        .flatMap(choice => choice.delta?.tool_calls || []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].function.name, 'list_hosts');
      assert.equal(calls[0].function.arguments, '{}');
      assert.deepEqual(finishReasons(result), ['tool_calls']);
    });
  });

  it('an upstream abort mid-stream still ends with an error frame and one [DONE]', async () => {
    await withAbortUpstream(async ({ base }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.done, 1, 'aborted stream must still be terminated');
      assert.equal(errors(result).length, 1, 'abort surfaces as an error frame');
      assert.deepEqual(finishReasons(result), [], 'no finish chunk after an abort');
    });
  });
});

describe('chat stream terminals — retry usage', () => {
  it('include_usage emits usage exactly once across a retry', async () => {
    await withScenarioUpstream((attempt) => attempt === 1
      ? v2TextEvents({ text: '{}', usage: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } })
      : v2TextEvents({
          text: JSON.stringify({ type: 'text', text: 'second attempt' }),
          usage: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
    async ({ base, upstream }) => {
      const result = await chat(base, { ...ASK_TOOLS, stream_options: { include_usage: true } });
      assert.equal(result.done, 1);
      assert.equal(upstream.state.sessionCalls, 2);
      const usages = usageEvents(result);
      assert.equal(usages.length, 1, 'usage appears once, not per attempt');
      assert.equal(usages[0].usage.total_tokens, 10, 'usage is the successful attempt only');
      const finals = finishReasons(result);
      assert.deepEqual(finals, ['stop']);
    });
  });
});
