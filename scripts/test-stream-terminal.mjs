import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Chat-completions stream terminals, end to end through the real HTTP server.
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

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Minimal opencode-serve stand-in. `scenario` runs once per /event connection
// and receives the session attempt number plus event writers.
function createUpstream(scenario) {
  let sessionCount = 0;
  let promptCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      sessionCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `ses-${sessionCount}` }));
      return;
    }
    if (req.method === 'GET' && req.url === '/event') {
      const sessionID = `ses-${sessionCount}`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      scenario({
        attempt: sessionCount,
        res,
        emit: event => res.write(sseFrame({ payload: event })),
        part: (type, id = 'p1') => res.write(sseFrame({
          type: 'message.part.updated',
          properties: { sessionID, part: { id, type } },
        })),
        delta: (text, id = 'p1') => res.write(sseFrame({
          type: 'message.part.delta',
          properties: { sessionID, partID: id, delta: text },
        })),
        finish: tokens => res.write(sseFrame({
          type: 'message.updated',
          properties: { sessionID, info: { role: 'assistant', finish: 'stop', tokens } },
        })),
        idle: () => res.write(sseFrame({ type: 'session.idle', properties: { sessionID } })),
      });
      return;
    }
    if (req.method === 'POST' && /\/prompt_async$/.test(req.url)) {
      promptCount += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      sessions: () => sessionCount,
      prompts: () => promptCount,
    }));
  });
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
    defaultBackend: 'opencode',
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

async function withUpstream(scenario, run) {
  const upstream = await createUpstream(scenario);
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
    await withUpstream(({ part, delta, finish }) => {
      part('text');
      delta(prose);
      finish({ input: 10, output: 6 });
    }, async ({ base, upstream }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.status, 200);
      assert.equal(result.done, 1, 'exactly one [DONE]');
      assert.deepEqual(errors(result), [], 'no error frame');
      assert.equal(deltas(result, 'content').join(''), prose, 'model answer is not lost');
      assert.deepEqual(finishReasons(result), ['stop']);
      assert.equal(upstream.prompts(), 1, 'salvage, not a retry');
    });
  });

  it('invalid decision without text ends with an error frame and one [DONE]', async () => {
    await withUpstream(({ part, delta, finish }) => {
      part('text');
      delta('{"type":"function_call"}');
      finish({ input: 4, output: 1 });
    }, async ({ base, upstream }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.status, 200);
      assert.equal(result.done, 1, 'exactly one [DONE]');
      const frameErrors = errors(result);
      assert.equal(frameErrors.length, 1, 'one structured error frame');
      assert.equal(frameErrors[0].type, 'server_error');
      assert.equal(frameErrors[0].code, 502);
      assert.equal(deltas(result, 'content').join(''), '');
      assert.deepEqual(finishReasons(result), [], 'error replaces the finish chunk');
      assert.equal(upstream.prompts(), 3, 'invalid replies are retried before failing');
    });
  });

  it('valid function_call decision surfaces tool_calls with a tool_calls finish', async () => {
    await withUpstream(({ part, delta, finish }) => {
      part('text');
      delta(JSON.stringify({ type: 'function_call', calls: [{ name: 'list_hosts', arguments: {} }] }));
      finish({ input: 5, output: 2 });
    }, async ({ base }) => {
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
    await withUpstream(({ part, delta, res }) => {
      part('text');
      delta('{"type":"text","text":"partial ans');
      setTimeout(() => {
        if (typeof res.socket?.resetAndDestroy === 'function') res.socket.resetAndDestroy();
        else res.destroy();
      }, 20);
    }, async ({ base }) => {
      const result = await chat(base, ASK_TOOLS);
      assert.equal(result.done, 1, 'aborted stream must still be terminated');
      assert.equal(errors(result).length, 1, 'abort surfaces as an error frame');
      assert.deepEqual(finishReasons(result), [], 'no finish chunk after an abort');
    });
  });

  it('include_usage emits usage exactly once across a retry', async () => {
    await withUpstream(({ attempt, part, delta, finish }) => {
      part('text');
      if (attempt === 1) {
        delta('{}');
        finish({ input: 100, output: 50 });
      } else {
        delta(JSON.stringify({ type: 'text', text: 'second attempt' }));
        finish({ input: 7, output: 3 });
      }
    }, async ({ base, upstream }) => {
      const result = await chat(base, { ...ASK_TOOLS, stream_options: { include_usage: true } });
      assert.equal(result.done, 1);
      assert.equal(upstream.prompts(), 2);
      const usages = usageEvents(result);
      assert.equal(usages.length, 1, 'usage appears once, not per attempt');
      assert.equal(usages[0].usage.total_tokens, 10, 'usage is the successful attempt only');
      const finals = finishReasons(result);
      assert.deepEqual(finals, ['stop']);
    });
  });
});
