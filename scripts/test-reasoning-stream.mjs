import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createV2Mock, v2Assistant } from './helpers/opencode-v2-mock.mjs';

// ---------------------------------------------------------------------------
// Reasoning channel tests — opencode v2 events → OpenAI chat chunks.
//
// Ground truth (opencode 2.x):
//   session.reasoning.started/delta/ended  { assistantMessageID, ordinal, delta }
//   session.text.started/delta/ended       { assistantMessageID, ordinal, delta }
//   session.tool.called                    { name }
//   session.step.ended                     { finish, tokens }
//   session.execution.succeeded/failed
//   permission.asked                       { id, sessionID, action, resources }
//
// Contract under test:
//   - reasoning deltas → delta.reasoning_content
//   - text deltas      → delta.content
//   - content never mixes chain-of-thought
//   - native tool attempts are rejected, never executed, and retried as text
//   - non-stream: message.content clean, message.reasoning_content separate
// ---------------------------------------------------------------------------

const SESSION = '{session}';

const reasoningDelta = (text) => ({ type: 'session.reasoning.delta', data: { sessionID: SESSION, assistantMessageID: 'msg_a', ordinal: 0, delta: text } });
const textDelta = (text) => ({ type: 'session.text.delta', data: { sessionID: SESSION, assistantMessageID: 'msg_a', ordinal: 0, delta: text } });
const stepEnded = (finish = 'stop', tokens = { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }) => ({
  type: 'session.step.ended',
  data: { sessionID: SESSION, assistantMessageID: 'msg_a', finish, rawFinish: finish, tokens },
});
const succeeded = () => ({ type: 'session.execution.succeeded', data: { sessionID: SESSION } });
const toolCalled = (name) => ({ type: 'session.tool.called', data: { sessionID: SESSION, assistantMessageID: 'msg_a', name } });
const permissionAsked = (id, action = 'read') => ({
  type: 'permission.asked',
  data: { id, sessionID: SESSION, action, resources: ['etc/hostname'], source: { type: 'tool', messageID: 'msg_a', id: 'call_1' } },
});

async function collectStream(events) {
  const mock = await createV2Mock({ events, models: [] });
  try {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
    const chunks = [];
    for await (const chunk of mod.completeStreaming(
      { streaming: true },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    )) {
      chunks.push(chunk);
    }
    return { chunks, mock };
  } finally {
    await mock.close();
  }
}

async function collectStreamWithMock(events) {
  const mock = await createV2Mock({ events, models: [] });
  const mod = await import('../dist/backends/opencode.js');
  const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
  const chunks = [];
  try {
    for await (const chunk of mod.completeStreaming(
      { streaming: true },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    )) {
      chunks.push(chunk);
    }
    return chunks;
  } finally {
    await mock.close();
  }
}

async function runComplete(assistant) {
  const mock = await createV2Mock({ assistant, models: [] });
  try {
    const mod = await import('../dist/backends/opencode.js');
    const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
    return await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
  } finally {
    await mock.close();
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

describe('opencode streaming — reasoning channel', () => {
  it('reasoning-only frames land in delta.reasoning_content, content stays empty', async () => {
    const { chunks } = await collectStream([
      reasoningDelta('Think'),
      reasoningDelta('ing'),
      stepEnded('stop', { input: 10, output: 3, reasoning: 3, cache: { read: 0, write: 0 } }),
      succeeded(),
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
    const { chunks } = await collectStream([
      textDelta('Hello'),
      textDelta(' world'),
      stepEnded('stop', { input: 5, output: 2, reasoning: 0, cache: { read: 7, write: 1 } }),
      succeeded(),
    ]);

    assert.equal(joinDelta(chunks, 'content'), 'Hello world');
    assert.equal(joinDelta(chunks, 'reasoning_content'), '');
    assert.ok(!choiceChunks(chunks).some(chunk => 'reasoning_content' in chunk.choices[0].delta), 'no reasoning_content key on text-only stream');

    const finishes = finishChunks(chunks);
    assert.equal(finishes[0].usage.prompt_tokens, 13, 'cached prompt tokens are part of prompt_tokens');
    assert.equal(finishes[0].usage.completion_tokens, 2);
    assert.equal(finishes[0].usage.total_tokens, 15);
    assert.deepEqual(finishes[0].usage.prompt_tokens_details, { cached_tokens: 7 });
  });

  it('reasoning then text keeps chunk order and never leaks CoT into content', async () => {
    const { chunks } = await collectStream([
      reasoningDelta('The user asks: '),
      reasoningDelta('9 sheep remain.'),
      textDelta('9 sheep are left.'),
      stepEnded('stop', { input: 7, output: 4, reasoning: 3, cache: { read: 0, write: 0 } }),
      succeeded(),
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

  it('rejects a native tool attempt and retries with text-only feedback', async () => {
    const mock = await createV2Mock({
      models: [],
      events: (sessionID) => sessionID.endsWith('_1')
        ? [
            permissionAsked('per_1'),
            toolCalled('read'),
            stepEnded('tool-calls', { input: 20, output: 6, reasoning: 0, cache: { read: 0, write: 0 } }),
            succeeded(),
          ]
        : [
            textDelta('Recovered.'),
            stepEnded('stop', { input: 30, output: 9, reasoning: 0, cache: { read: 0, write: 0 } }),
            succeeded(),
          ],
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const chunks = [];
      for await (const chunk of mod.completeStreaming(
        { streaming: true },
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        ctx,
      )) {
        chunks.push(chunk);
      }

      assert.equal(mock.state.sessionCalls, 2, 'one retry after the rejected tool attempt');
      assert.equal(mock.state.permissionReplies.length, 1);
      assert.equal(mock.state.permissionReplies[0].body.decision, 'reject');
      assert.equal(joinDelta(chunks, 'content'), 'Recovered.');
      const finishes = finishChunks(chunks);
      assert.equal(finishes.length, 1);
      assert.equal(finishes[0].choices[0].finish_reason, 'stop');
      assert.equal(finishes[0].usage.prompt_tokens, 30);
    } finally {
      await mock.close();
    }
  });

  it('throws when the model keeps attempting server-side tools after the retry', async () => {
    const mock = await createV2Mock({
      models: [],
      events: () => [
        permissionAsked('per_1'),
        toolCalled('read'),
        stepEnded('tool-calls', { input: 20, output: 6, reasoning: 0, cache: { read: 0, write: 0 } }),
        succeeded(),
      ],
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await assert.rejects(
        async () => {
          for await (const _chunk of mod.completeStreaming(
            { streaming: true },
            { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
            ctx,
          )) { /* consume */ }
        },
        /attempted server-side tool use/,
      );
      assert.equal(mock.state.permissionReplies.length, 2);
    } finally {
      await mock.close();
    }
  });

  it('execution.succeeded without a step finish still terminates with a finish chunk', async () => {
    const { chunks } = await collectStream([
      reasoningDelta('quick'),
      succeeded(),
    ]);
    const finishes = finishChunks(chunks);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].choices[0].finish_reason, 'stop');
  });

  it('propagates provider execution failures as status-carrying errors', async () => {
    const mock = await createV2Mock({
      models: [],
      events: () => [
        { type: 'session.execution.failed', data: { sessionID: SESSION, error: { type: 'provider.auth', message: 'denied', status: 403 } } },
      ],
    });
    try {
      const mod = await import('../dist/backends/opencode.js');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      try {
        for await (const _chunk of mod.completeStreaming(
          { streaming: true },
          { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
          ctx,
        )) { /* consume */ }
        assert.fail('should throw');
      } catch (error) {
        assert.equal(error.status, 403);
        assert.match(error.message, /denied/);
      }
    } finally {
      await mock.close();
    }
  });
});

describe('opencode non-stream — reasoning channel', () => {
  it('keeps message.content clean and exposes reasoning_content', async () => {
    const res = await runComplete(() => v2Assistant({
      reasoning: 'Chain of thought.',
      text: 'Final answer.',
      tokens: { input: 11, output: 4, reasoning: 3, cache: { read: 0, write: 0 } },
    }));

    const message = res.choices[0].message;
    assert.equal(message.content, 'Final answer.');
    assert.equal(message.reasoning_content, 'Chain of thought.');
    assert.equal(message.reasoning, 'Chain of thought.');
    assert.equal(res.choices[0].finish_reason, 'stop');
    assert.equal(res.usage.prompt_tokens, 11);
    assert.equal(res.usage.completion_tokens, 4);
    assert.deepEqual(res.usage.completion_tokens_details, { reasoning_tokens: 3 });
  });

  it('retries a native tool attempt with text-only feedback instead of executing it', async () => {
    let sessions = 0;
    const mod = await import('../dist/backends/opencode.js');
    const mock = await createV2Mock({
      models: [],
      assistant: (sessionID) => {
        sessions = Math.max(sessions, Number(sessionID.split('_').pop()));
        return sessionID.endsWith('_1')
          ? v2Assistant({ reasoning: 'I should call a tool.', text: '', tools: ['read'] })
          : v2Assistant({ text: 'No tool needed.', tokens: { input: 9, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
      },
    });
    try {
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      const res = await mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx);
      assert.equal(sessions, 2, 'one retry after the rejected tool attempt');
      assert.equal(res.choices[0].message.content, 'No tool needed.');
      assert.equal(res.choices[0].message.reasoning_content, undefined);
      assert.equal(res.choices[0].finish_reason, 'stop');
    } finally {
      await mock.close();
    }
  });

  it('throws when the retry still only attempts tools', async () => {
    const mod = await import('../dist/backends/opencode.js');
    const mock = await createV2Mock({
      models: [],
      assistant: () => v2Assistant({ text: '', tools: ['read'] }),
    });
    try {
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await assert.rejects(
        () => mod.complete({}, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ctx),
        /attempted server-side tool use/,
      );
    } finally {
      await mock.close();
    }
  });

  it('omits reasoning fields entirely when the model does not reason', async () => {
    const res = await runComplete(() => v2Assistant({ text: 'plain' }));
    const message = res.choices[0].message;
    assert.equal(message.content, 'plain');
    assert.ok(!('reasoning_content' in message));
    assert.ok(!('reasoning' in message));
  });
});
