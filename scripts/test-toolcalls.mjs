import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Tool calls — parseResponseParts
// ---------------------------------------------------------------------------

describe('tool calls — parseResponseParts', () => {
  let parseResponseParts;

  it('imports parseResponseParts', async () => {
    const mod = await import('../dist/backends/shared/session-protocol.js');
    parseResponseParts = mod.parseResponseParts;
  });

  it('returns empty toolCalls for text-only parts', () => {
    const result = parseResponseParts({ parts: [{ type: 'text', text: 'hello' }] });
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.text, 'hello');
  });

  it('parses a single tool_use part', () => {
    const result = parseResponseParts({
      parts: [{
        type: 'tool_use',
        tool_use: { tool: 'bash', input: { command: 'ls' } },
      }],
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].type, 'function');
    assert.equal(result.toolCalls[0].function.name, 'bash');
    assert.equal(result.toolCalls[0].function.arguments, '{"command":"ls"}');
    assert.ok(result.toolCalls[0].id.startsWith('toolu_'));
  });

  it('parses multiple tool_use parts', () => {
    const result = parseResponseParts({
      parts: [
        { type: 'tool_use', tool_use: { tool: 'bash', input: { command: 'ls' } } },
        { type: 'tool_use', tool_use: { tool: 'read', input: { path: '/etc/hosts' } } },
      ],
    });
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].function.name, 'bash');
    assert.equal(result.toolCalls[1].function.name, 'read');
    assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
  });

  it('parses tool_result parts', () => {
    const result = parseResponseParts({
      parts: [
        { type: 'tool_use', tool_use: { tool: 'bash', input: {} } },
        { type: 'tool_result', tool_result: { content: 'file1.txt\nfile2.txt' } },
      ],
    });
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].content, 'file1.txt\nfile2.txt');
    assert.equal(result.toolResults[0].toolCallId, result.toolCalls[0].id);
  });

  it('handles tool_use with string input', () => {
    const result = parseResponseParts({
      parts: [{ type: 'tool_use', tool_use: { tool: 'echo', input: 'hello' } }],
    });
    assert.equal(result.toolCalls[0].function.arguments, 'hello');
  });

  it('handles mixed text, reasoning, and tool calls', () => {
    const result = parseResponseParts({
      parts: [
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'let me run that' },
        { type: 'tool_use', tool_use: { tool: 'bash', input: {} } },
      ],
    });
    assert.equal(result.text, 'let me run that');
    assert.equal(result.reasoning, 'thinking...');
    assert.equal(result.toolCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Tool calls — buildResponseObject
// ---------------------------------------------------------------------------

describe('tool calls — buildResponseObject', () => {
  let buildResponseObject;

  it('imports buildResponseObject', async () => {
    const mod = await import('../dist/utils.js');
    buildResponseObject = mod.buildResponseObject;
  });

  it('builds response with text only (no tool calls)', () => {
    const resp = buildResponseObject(
      'model-a', 'hello world',
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      'req-model', '',
    );
    assert.equal(resp.object, 'response');
    assert.equal(resp.model, 'model-a');
    const msgItem = resp.output.find(o => o.type === 'message');
    assert.ok(msgItem);
    assert.equal(msgItem.content[0].text, 'hello world');
    const fcItems = resp.output.filter(o => o.type === 'function_call');
    assert.equal(fcItems.length, 0);
  });

  it('builds response with tool calls before message', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    ];
    const resp = buildResponseObject(
      'model-a', '', undefined, 'req', '',
      toolCalls,
    );
    const fcItem = resp.output.find(o => o.type === 'function_call');
    assert.ok(fcItem, 'should have function_call item');
    assert.equal(fcItem.name, 'bash');
    assert.equal(fcItem.arguments, '{"cmd":"ls"}');
    assert.equal(fcItem.call_id, 'call_1');
    assert.ok(fcItem.id.startsWith('fc_'));

    // Message should come after function_call
    const fcIdx = resp.output.indexOf(fcItem);
    const msgItem = resp.output.find(o => o.type === 'message');
    const msgIdx = resp.output.indexOf(msgItem);
    assert.ok(msgIdx > fcIdx, 'message should come after function_call');
  });

  it('builds response with multiple tool calls', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } },
    ];
    const resp = buildResponseObject('m', '', undefined, 'r', '', toolCalls);
    const fcItems = resp.output.filter(o => o.type === 'function_call');
    assert.equal(fcItems.length, 2);
    assert.equal(fcItems[0].name, 'bash');
    assert.equal(fcItems[1].name, 'read');
  });

  it('includes reasoning before tool calls', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ];
    const resp = buildResponseObject('m', 'text', undefined, 'r', 'thinking', toolCalls);
    const types = resp.output.map(o => o.type);
    assert.deepEqual(types, ['reasoning', 'function_call', 'message']);
  });
});

// ---------------------------------------------------------------------------
// Tool calls — ResponsesFunctionCallOutput type in ResponseObject
// ---------------------------------------------------------------------------

describe('tool calls — ResponseObject shape', () => {
  it('function_call output item has required fields', async () => {
    const { buildResponseObject } = await import('../dist/utils.js');
    const resp = buildResponseObject(
      'm', '', undefined, 'r', '',
      [{ id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } }],
    );
    const fc = resp.output.find(o => o.type === 'function_call');
    assert.equal(typeof fc.id, 'string');
    assert.equal(fc.type, 'function_call');
    assert.equal(typeof fc.call_id, 'string');
    assert.equal(typeof fc.name, 'string');
    assert.equal(typeof fc.arguments, 'string');
  });

  it('usage has Responses API format', async () => {
    const { buildResponseObject } = await import('../dist/utils.js');
    const resp = buildResponseObject(
      'm', 'hi',
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      'r', '',
    );
    assert.equal(typeof resp.usage.input_tokens, 'number');
    assert.equal(typeof resp.usage.output_tokens, 'number');
    assert.equal(typeof resp.usage.total_tokens, 'number');
    assert.ok(resp.usage.input_tokens_details);
    assert.ok(resp.usage.output_tokens_details);
  });
});

// ---------------------------------------------------------------------------
// Tool calls — ccUsageToResponses
// ---------------------------------------------------------------------------

describe('tool calls — ccUsageToResponses', () => {
  it('converts prompt_tokens to input_tokens', async () => {
    const { ccUsageToResponses } = await import('../dist/utils.js');
    const result = ccUsageToResponses({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.equal(result.input_tokens, 100);
    assert.equal(result.output_tokens, 50);
    assert.equal(result.total_tokens, 150);
  });

  it('returns zeros for undefined usage', async () => {
    const { ccUsageToResponses } = await import('../dist/utils.js');
    const result = ccUsageToResponses(undefined);
    assert.equal(result.input_tokens, 0);
    assert.equal(result.output_tokens, 0);
    assert.equal(result.total_tokens, 0);
  });

  it('includes details objects', async () => {
    const { ccUsageToResponses } = await import('../dist/utils.js');
    const result = ccUsageToResponses({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    assert.deepEqual(result.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 });
    assert.deepEqual(result.output_tokens_details, { reasoning_tokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tool calls — responsesInputToMessages (function_call input items)
// ---------------------------------------------------------------------------

describe('tool calls — responsesInputToMessages with function_call', () => {
  it('converts function_call input to assistant tool_calls message', async () => {
    const { responsesInputToMessages } = await import('../dist/utils.js');
    const input = [
      { type: 'message', role: 'user', content: 'what is the weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Moscow"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '25C sunny' },
    ];
    const messages = responsesInputToMessages(input);
    assert.equal(messages.length, 3);

    // function_call → assistant message with tool_calls
    const assistantMsg = messages[1];
    assert.equal(assistantMsg.role, 'assistant');
    assert.ok(assistantMsg.tool_calls);
    assert.equal(assistantMsg.tool_calls.length, 1);
    assert.equal(assistantMsg.tool_calls[0].id, 'call_1');
    assert.equal(assistantMsg.tool_calls[0].function.name, 'get_weather');

    // function_call_output → tool message
    const toolMsg = messages[2];
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.equal(toolMsg.content, '25C sunny');
  });
});
