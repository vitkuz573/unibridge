import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Reasoning channel tests — opencode session events → OpenAI chat chunks.
//
// Ground truth (opencode serve 1.18.x, verified live):
//   message.part.updated  { part: { id, type: 'reasoning' | 'text' | 'tool', ... } }
//   message.part.delta    { partID, field: 'text', delta }
//   message.updated       { info: { role, finish, tokens }, ... }
//
// Contract under test:
//   - reasoning deltas → delta.reasoning_content
//   - text deltas      → delta.content
//   - content never mixes chain-of-thought
//   - tool calls keep their own channel, order is preserved
//   - non-stream: message.content clean, message.reasoning_content separate
// ---------------------------------------------------------------------------

function sseEvent(type, properties) {
  return `data: ${JSON.stringify({ type, properties })}\n\n`;
}

function createOpencodeMock({ events = [], messageResponse = null } = {}) {
  let captured = null;
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'test-session' }));
      return;
    }
    if (req.method === 'GET' && url === '/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const event of events) res.write(sseEvent(event.type, event.properties));
      res.end();
      return;
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(url)) {
      req.resume();
      req.on('end', () => {
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/message$/.test(url)) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        captured = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messageResponse));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, body: () => captured });
    });
  });
}

async function collectStream(events) {
  const mock = await createOpencodeMock({ events });
  try {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${mock.port}` });
    const chunks = [];
    for await (const chunk of mod.completeStreaming(
      { streaming: true },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    )) {
      chunks.push(chunk);
    }
    return chunks;
  } finally {
    mock.server.close();
  }
}

async function runComplete(messageResponse) {
  const mock = await createOpencodeMock({ messageResponse });
  try {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: `http://127.0.0.1:${mock.port}` });
    return await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
  } finally {
    mock.server.close();
  }
}

function choiceChunks(chunks) {
  return chunks.filter(chunk => Array.isArray(chunk.choices) && chunk.choices.length > 0);
}

function joinDelta(chunks, field) {
  return choiceChunks(chunks)
    .map(chunk => chunk.choices[0].delta[field])
    .filter(value => typeof value === 'string')
    .join('');
}

function finishChunks(chunks) {
  return choiceChunks(chunks).filter(chunk => chunk.choices[0].finish_reason != null);
}

function toolCallChunks(chunks) {
  return choiceChunks(chunks).flatMap(chunk => chunk.choices[0].delta.tool_calls || []);
}

const reasoningPart = (id, text) => ({ type: 'message.part.updated', properties: { sessionID: 'test-session', part: { id, type: 'reasoning', text } } });
const textPart = (id, text) => ({ type: 'message.part.updated', properties: { sessionID: 'test-session', part: { id, type: 'text', text } } });
const delta = (partID, text) => ({ type: 'message.part.delta', properties: { sessionID: 'test-session', partID, field: 'text', delta: text } });

describe('opencode streaming — reasoning channel', () => {
  it('reasoning-only frames land in delta.reasoning_content, content stays empty', async () => {
    const chunks = await collectStream([
      reasoningPart('pr1', ''),
      delta('pr1', 'Think'),
      delta('pr1', 'ing'),
      reasoningPart('pr1', 'Thinking'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'stop', tokens: { input: 10, output: 3, reasoning: 3 } },
        },
      },
    ]);

    assert.equal(joinDelta(chunks, 'content'), '');
    assert.equal(joinDelta(chunks, 'reasoning_content'), 'Thinking');
    assert.equal(choiceChunks(chunks)[0].choices[0].delta.role, 'assistant');
    assert.ok(!choiceChunks(chunks).some(chunk => 'content' in chunk.choices[0].delta), 'no content key on reasoning-only stream');

    const finishes = finishChunks(chunks);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].choices[0].finish_reason, 'stop');
    assert.equal(finishes[0].usage.prompt_tokens, 10);
    assert.equal(finishes[0].usage.completion_tokens, 3);
    assert.equal(finishes[0].usage.total_tokens, 13);
    assert.deepEqual(finishes[0].usage.completion_tokens_details, { reasoning_tokens: 3 });
  });

  it('text-only frames land in delta.content, reasoning_content stays empty', async () => {
    const chunks = await collectStream([
      textPart('pt1', ''),
      delta('pt1', 'Hello'),
      delta('pt1', ' world'),
      textPart('pt1', 'Hello world'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'stop', tokens: { input: 5, output: 2 } },
        },
      },
    ]);

    assert.equal(joinDelta(chunks, 'content'), 'Hello world');
    assert.equal(joinDelta(chunks, 'reasoning_content'), '');
    assert.ok(!choiceChunks(chunks).some(chunk => 'reasoning_content' in chunk.choices[0].delta), 'no reasoning_content key on text-only stream');
  });

  it('reasoning then text keeps chunk order and never leaks CoT into content', async () => {
    const chunks = await collectStream([
      reasoningPart('pr1', ''),
      delta('pr1', 'The user asks: '),
      delta('pr1', '9 sheep remain.'),
      textPart('pt1', ''),
      delta('pt1', '9 sheep are left.'),
      textPart('pt1', '9 sheep are left.'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'stop', tokens: { input: 7, output: 4 } },
        },
      },
    ]);

    const content = joinDelta(chunks, 'content');
    const reasoning = joinDelta(chunks, 'reasoning_content');
    assert.equal(reasoning, 'The user asks: 9 sheep remain.');
    assert.equal(content, '9 sheep are left.');
    assert.ok(!content.includes('The user asks'), 'reasoning text must not leak into content');

    const deltas = choiceChunks(chunks).map(chunk => chunk.choices[0].delta);
    const lastReasoningIndex = deltas.findLastIndex(d => typeof d.reasoning_content === 'string');
    const firstContentIndex = deltas.findIndex(d => typeof d.content === 'string');
    assert.ok(lastReasoningIndex >= 0 && firstContentIndex > lastReasoningIndex, 'reasoning chunks must precede text chunks');
  });

  it('tool call after reasoning: tool_calls channel intact, turn continues to final text', async () => {
    const chunks = await collectStream([
      reasoningPart('pr1', ''),
      delta('pr1', 'Let me check.'),
      { type: 'message.part.updated', properties: { sessionID: 'test-session', part: { id: 'tool1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'pending', input: {} } } } },
      { type: 'message.part.updated', properties: { sessionID: 'test-session', part: { id: 'tool1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running', input: { command: 'echo hi' } } } } },
      { type: 'message.part.updated', properties: { sessionID: 'test-session', part: { id: 'tool1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi' } } } } },
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'tool-calls', tokens: { input: 20, output: 6 } },
        },
      },
      textPart('pt2', ''),
      delta('pt2', 'Output: hi'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'stop', tokens: { input: 30, output: 9 } },
        },
      },
    ]);

    const calls = toolCallChunks(chunks);
    assert.equal(calls.length, 1, 'one tool call chunk, emitted once despite repeated updates');
    assert.equal(calls[0].id, 'call_1');
    assert.equal(calls[0].index, 0);
    assert.equal(calls[0].type, 'function');
    assert.equal(calls[0].function.name, 'bash');
    assert.equal(calls[0].function.arguments, '{"command":"echo hi"}');

    assert.equal(joinDelta(chunks, 'reasoning_content'), 'Let me check.');
    assert.equal(joinDelta(chunks, 'content'), 'Output: hi');

    const finishes = finishChunks(chunks);
    assert.equal(finishes.length, 1, 'intermediate tool-calls finish must not close the response');
    assert.equal(finishes[0].choices[0].finish_reason, 'stop');
    assert.equal(finishes[0].usage.prompt_tokens, 30);
  });

  it('two tool calls keep stable indices', async () => {
    const toolPart = (id, callID, name, input, status) => ({
      type: 'message.part.updated',
      properties: { sessionID: 'test-session', part: { id, type: 'tool', tool: name, callID, state: { status, input } } },
    });
    const chunks = await collectStream([
      toolPart('t1', 'call_a', 'bash', { command: 'a' }, 'running'),
      toolPart('t2', 'call_b', 'read', { path: '/x' }, 'running'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'tool-calls', tokens: { input: 1, output: 1 } },
        },
      },
      textPart('pt', ''),
      delta('pt', 'done'),
      {
        type: 'message.updated',
        properties: {
          sessionID: 'test-session',
          info: { role: 'assistant', finish: 'stop', tokens: { input: 2, output: 2 } },
        },
      },
    ]);

    const calls = toolCallChunks(chunks);
    assert.deepEqual(calls.map(c => c.index), [0, 1]);
    assert.deepEqual(calls.map(c => c.id), ['call_a', 'call_b']);
    assert.deepEqual(calls.map(c => c.function.name), ['bash', 'read']);
  });

  it('session.idle without a message finish still terminates with a finish chunk', async () => {
    const chunks = await collectStream([
      reasoningPart('pr1', ''),
      delta('pr1', 'quick'),
      { type: 'session.idle', properties: { sessionID: 'test-session' } },
    ]);
    const finishes = finishChunks(chunks);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].choices[0].finish_reason, 'stop');
  });
});

describe('opencode non-stream — reasoning channel', () => {
  it('keeps message.content clean and exposes reasoning_content', async () => {
    const res = await runComplete({
      parts: [
        { type: 'reasoning', text: 'Chain of thought.' },
        { type: 'text', text: 'Final answer.' },
      ],
      info: { tokens: { input: 11, output: 4, reasoning: 3 } },
    });

    const message = res.choices[0].message;
    assert.equal(message.content, 'Final answer.');
    assert.equal(message.reasoning_content, 'Chain of thought.');
    assert.equal(message.reasoning, 'Chain of thought.');
    assert.equal(res.choices[0].finish_reason, 'stop');
    assert.equal(res.usage.prompt_tokens, 11);
    assert.equal(res.usage.completion_tokens, 4);
    assert.deepEqual(res.usage.completion_tokens_details, { reasoning_tokens: 3 });
  });

  it('keeps tool calls separate and sets finish_reason=tool_calls', async () => {
    const res = await runComplete({
      parts: [
        { type: 'reasoning', text: 'I should call a tool.' },
        { type: 'text', text: '' },
        { type: 'tool_use', tool_use: { tool: 'bash', input: { command: 'ls' } } },
      ],
      info: { tokens: { input: 9, output: 2 } },
    });

    const message = res.choices[0].message;
    assert.equal(message.content, '');
    assert.equal(message.reasoning_content, 'I should call a tool.');
    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].function.name, 'bash');
    assert.equal(message.tool_calls[0].function.arguments, '{"command":"ls"}');
    assert.equal(res.choices[0].finish_reason, 'tool_calls');
  });

  it('omits reasoning fields entirely when the model does not reason', async () => {
    const res = await runComplete({
      parts: [{ type: 'text', text: 'plain' }],
      info: { tokens: { input: 3, output: 1 } },
    });
    const message = res.choices[0].message;
    assert.equal(message.content, 'plain');
    assert.ok(!('reasoning_content' in message));
    assert.ok(!('reasoning' in message));
  });
});
