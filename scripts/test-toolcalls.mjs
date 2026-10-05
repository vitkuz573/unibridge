import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Tool calls — parseResponseParts
// ---------------------------------------------------------------------------

describe('tool calls — parseResponseParts', () => {
  let parseResponseParts;

  it('imports parseResponseParts', async () => {
    const mod = await import('../src/backends/shared/session-protocol.ts');
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
    const mod = await import('../src/utils.ts');
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
    assert.equal(fcItem.call_id, 'call_1');

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
    const { buildResponseObject } = await import('../src/utils.ts');
    const resp = buildResponseObject(
      'm', '', undefined, 'r', '',
      [{ id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{"a":1}' } }],
    );
    const fc = resp.output.find(o => o.type === 'function_call');
    assert.equal(fc.type, 'function_call');
    assert.equal(typeof fc.call_id, 'string');
    assert.equal(typeof fc.name, 'string');
    assert.equal(typeof fc.arguments, 'string');
  });

  it('usage has Responses API format', async () => {
    const { buildResponseObject } = await import('../src/utils.ts');
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
    const { ccUsageToResponses } = await import('../src/utils.ts');
    const result = ccUsageToResponses({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.equal(result.input_tokens, 100);
    assert.equal(result.output_tokens, 50);
    assert.equal(result.total_tokens, 150);
  });

  it('returns zeros for undefined usage', async () => {
    const { ccUsageToResponses } = await import('../src/utils.ts');
    const result = ccUsageToResponses(undefined);
    assert.equal(result.input_tokens, 0);
    assert.equal(result.output_tokens, 0);
    assert.equal(result.total_tokens, 0);
  });

  it('includes details objects', async () => {
    const { ccUsageToResponses } = await import('../src/utils.ts');
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
    const { responsesInputToMessages } = await import('../src/utils.ts');
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

  // The contract's own input message spells `type` optional (`type?:
  // 'message'`), and clients send it that way: an agent harness posting
  // `{"role":"user","content":[…]}` had every item dropped, so the model was
  // asked the question without the question and answered from the system
  // prompt alone. Both readers of `input` are covered — this one and the
  // opencode backend's — because a request that loses its input is a request
  // that succeeds and answers the wrong thing.
  it('reads a role-bearing item with no type as a message', async () => {
    const { responsesInputToMessages } = await import('../src/utils.ts');
    const messages = responsesInputToMessages([
      { role: 'system', content: [{ type: 'input_text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'what is the weather?' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '25C' }] },
    ]);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'be brief');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'what is the weather?');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].content, '25C');
  });

  it('still reads an explicit non-message type as itself', async () => {
    const { responsesInputToMessages } = await import('../src/utils.ts');
    const messages = responsesInputToMessages([
      { type: 'input_text', text: 'bare text item' },
      { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
      { role: 'user', content: 'plain string content' },
    ]);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'bare text item');
    assert.equal(messages[1].tool_calls[0].function.name, 'f');
    assert.equal(messages[2].content, 'plain string content');
  });

  it('the opencode backend reads the same typeless items into the prompt', async () => {
    const { createV2Mock, v2Assistant } = await import('./helpers/opencode-v2-mock.mjs');
    const mock = await createV2Mock({ assistant: () => v2Assistant({ text: 'ok' }) });
    try {
      const mod = await import('../src/backends/opencode.ts');
      const ctx = await mod.init({ models: ['m'], baseUrl: mock.baseUrl });
      await mod.responses({}, {
        model: 'm',
        input: [
          { role: 'system', content: [{ type: 'input_text', text: 'be brief' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'read /etc/hostname' }] },
        ],
      }, ctx);
      const text = mock.state.promptBodies[0].text;
      assert.ok(text.includes('be brief'), 'the system item reached the prompt');
      assert.ok(text.includes('read /etc/hostname'), 'and so did the user item');
    } finally { await mock.close(); }
  });
});

// ---------------------------------------------------------------------------
// Tool history — no local tools, structured JSON, deny-all sessions
// ---------------------------------------------------------------------------

describe('tool history — structured parts and deny-all sessions', () => {
  let buildPartsFromMessages;
  let DENY_ALL_PERMISSION;

  it('imports the session protocol helpers', async () => {
    const mod = await import('../src/backends/shared/session-protocol.ts');
    buildPartsFromMessages = mod.buildPartsFromMessages;
    DENY_ALL_PERMISSION = mod.DENY_ALL_PERMISSION;
  });

  it('every session carries the deny-all permission preset', () => {
    assert.deepEqual(DENY_ALL_PERMISSION, [{ permission: '*', pattern: '**', action: 'deny' }]);
  });

  it('assistant tool_calls become structured function_call JSON, not prose', () => {
    const parts = buildPartsFromMessages([
      { role: 'user', content: 'check weather' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"LA"}' } }],
      },
    ]);
    assert.equal(parts.length, 2);
    assert.deepEqual(JSON.parse(parts[1].text), {
      type: 'function_call',
      id: 'call_2',
      name: 'get_weather',
      arguments: { city: 'LA' },
    });
    assert.ok(!parts[1].text.includes('[calling tool'));
  });

  it('role:tool messages become structured tool_result JSON with the callID', () => {
    const parts = buildPartsFromMessages([
      { role: 'user', content: 'what is the weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":72}' },
      { role: 'user', content: 'thanks' },
    ]);
    assert.equal(parts.length, 4);
    assert.deepEqual(JSON.parse(parts[2].text), {
      type: 'tool_result',
      callID: 'call_1',
      content: '{"temp":72}',
    });
    assert.ok(!parts[2].text.includes('[tool result for'));
  });

  it('keeps non-JSON tool arguments verbatim', () => {
    const parts = buildPartsFromMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'echo', arguments: 'raw text' } }],
      },
    ]);
    assert.deepEqual(JSON.parse(parts[0].text), {
      type: 'function_call',
      id: 'call_3',
      name: 'echo',
      arguments: 'raw text',
    });
  });

  it('drops the shared local-tools mapping module', async () => {
    await assert.rejects(
      () => import('../src/backends/shared/tools.ts'),
      /Cannot find module|ERR_MODULE_NOT_FOUND/,
    );
  });
});

// Both of the following were measured on live turns against a 26-tool client.
// Each is a reply the model actually produced, and each was a turn that had
// usable work in it and was reported as nothing.

describe('tool calling — replies the model actually writes', () => {
  let parseChoiceReply;
  let clientToolsSystem;
  let unknownToolNames;
  const TOOLS = ['bash', 'read', 'glob', 'grep', 'edit', 'ask_user_question']
    .map(name => ({ type: 'function', function: { name, description: '', parameters: { type: 'object' } } }));

  before(async () => {
    const mod = await import('../src/backends/shared/client-tools.ts');
    parseChoiceReply = mod.parseChoiceReply;
    clientToolsSystem = mod.clientToolsSystem;
    unknownToolNames = mod.unknownToolNames;
  });

  it('reads one decision object per call as one decision', () => {
    // Three JSON documents, one call each. `JSON.parse` calls this a syntax
    // error; the turn had three good calls in it.
    const raw = [
      '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"ls"}}]}',
      '{"type":"function_call","calls":[{"name":"glob","arguments":{"pattern":"**/*.tsx"}}]}',
      '{"type":"function_call","calls":[{"name":"grep","arguments":{"pattern":"trajectory"}}]}',
    ].join('\n');
    const decision = parseChoiceReply(raw, TOOLS, 'auto', { repair: true });
    assert.deepEqual(decision, {
      calls: [
        { name: 'bash', arguments: { command: 'ls' } },
        { name: 'glob', arguments: { pattern: '**/*.tsx' } },
        { name: 'grep', arguments: { pattern: 'trajectory' } },
      ],
    });
  });

  it('reads a per-call reply whose last object is truncated', () => {
    const raw = [
      '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"a"}}]}',
      '{"type":"function_call","calls":[{"name":"grep","arguments":{"command":"grep -ril \\"token.s',
    ].join('\n');
    const decision = parseChoiceReply(raw, TOOLS, 'auto', { repair: true });
    assert.deepEqual(decision, { calls: [{ name: 'bash', arguments: { command: 'a' } }] });
  });

  it('still refuses a per-call reply naming a tool the client lacks', () => {
    const raw = [
      '{"type":"function_call","calls":[{"name":"shell","arguments":{"command":"ls"}}]}',
      '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"pwd"}}]}',
    ].join('\n');
    assert.equal(parseChoiceReply(raw, TOOLS, 'auto', { repair: true }), null);
  });

  it('does not merge a text decision with calls', () => {
    const raw = [
      '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"ls"}}]}',
      '{"type":"text","text":"done"}',
    ].join('\n');
    assert.equal(parseChoiceReply(raw, TOOLS, 'auto', { repair: true }), null);
  });

  it('leaves a single object and prose exactly as they were', () => {
    const one = '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"ls"}}]}';
    assert.deepEqual(parseChoiceReply(one, TOOLS, 'auto', { repair: true }), {
      calls: [{ name: 'bash', arguments: { command: 'ls' } }],
    });
    assert.equal(parseChoiceReply('I will look into that.', TOOLS, 'auto', { repair: true }), null);
    assert.equal(parseChoiceReply('{"type":"function_call"}', TOOLS, 'auto', { repair: true }), null);
  });

  it('states the valid names where the model reads them', () => {
    // The enum naming the real tools lives in the schema, which never reaches
    // the reply path — so the retry could only ever say "must match at least
    // one anyOf branch". The names have to be in the instruction too.
    const instruction = clientToolsSystem('', TOOLS);
    for (const name of ['bash', 'ask_user_question']) {
      assert.ok(instruction.includes(name), `${name} is stated in the instruction`);
    }
    assert.ok(instruction.includes('Valid tool names'), 'and marked as the closed list');
  });

  it('names the tools a reply invented, so the retry can be a different one', () => {
    const raw = '{"type":"function_call","calls":[{"name":"shell","arguments":{"command":"pwd"}}]}';
    assert.deepEqual(unknownToolNames(raw, TOOLS), ['shell']);
    const two = '{"type":"function_call","calls":[{"name":"shell","arguments":{}},{"name":"question","arguments":{}}]}';
    assert.deepEqual(unknownToolNames(two, TOOLS), ['shell', 'question']);
    assert.deepEqual(unknownToolNames('{"type":"function_call","calls":[{"name":"bash","arguments":{}}]}', TOOLS), []);
  });

  it('treats a near miss as the same mistake', () => {
    // `Bash` and `bash_tool` are the same failure as `shell`: the client has no
    // such tool, and the fix is the same. Only a wholly different name is left
    // for the plain unknown-name path.
    const raw = '{"type":"function_call","calls":[{"name":"Bash","arguments":{}}]}';
    assert.deepEqual(unknownToolNames(raw, TOOLS), []);
  });
});

// ---------------------------------------------------------------------------
// Tool calling — clientTools orchestrator (shared/client-tools.ts)
// ---------------------------------------------------------------------------

describe('tool calling — clientTools choice schema', () => {
  let choiceSchemaFor;
  let parseChoiceReply;
  let describeTools;
  let clientToolsSystem;
  let unknownToolNames;

  it('imports helpers', async () => {
    const mod = await import('../src/backends/shared/client-tools.ts');
    choiceSchemaFor = mod.choiceSchemaFor;
    parseChoiceReply = mod.parseChoiceReply;
    describeTools = mod.describeTools;
    clientToolsSystem = mod.clientToolsSystem;
    unknownToolNames = mod.unknownToolNames;
  });

  it('none -> text-only schema', () => {
    const s = choiceSchemaFor([{ type: 'function', function: { name: 'calc' } }], 'none');
    assert.equal(s.properties.type.const, 'text');
  });

  it('required -> function_call schema with the tool enum inside calls', () => {
    const tools = [{ type: 'function', function: { name: 'calc' } }, { type: 'function', function: { name: 'weather' } }];
    const s = choiceSchemaFor(tools, 'required');
    assert.deepEqual(s.properties.calls.items.properties.name.enum, ['calc', 'weather']);
    assert.equal(s.properties.calls.minItems, 1);
    assert.ok(s.properties.calls.maxItems >= 2);
  });

  it('auto -> anyOf both', () => {
    const s = choiceSchemaFor([{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.ok(Array.isArray(s.anyOf) && s.anyOf.length === 2);
  });

  it('parses text decision', () => {
    const d = parseChoiceReply('{"type":"text","text":"hello"}', [{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.deepEqual(d, { text: 'hello' });
  });

  it('parses a single-call function_call decision', () => {
    const d = parseChoiceReply('{"type":"function_call","calls":[{"name":"calc","arguments":{"expr":"2+2"}}]}', [{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.deepEqual(d, { calls: [{ name: 'calc', arguments: { expr: '2+2' } }] });
  });

  it('parses a parallel multi-call function_call decision in order', () => {
    const tools = [{ type: 'function', function: { name: 'list_items' } }, { type: 'function', function: { name: 'list_events' } }];
    const d = parseChoiceReply(
      '{"type":"function_call","calls":[{"name":"list_items","arguments":{}},{"name":"list_events","arguments":{"limit":3}}]}',
      tools,
      'auto',
    );
    assert.deepEqual(d, {
      calls: [
        { name: 'list_items', arguments: {} },
        { name: 'list_events', arguments: { limit: 3 } },
      ],
    });
  });

  it('rejects unknown tool', () => {
    const d = parseChoiceReply('{"type":"function_call","calls":[{"name":"evil","arguments":{}}]}', [{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.equal(d, null);
  });

  it('rejects empty call list', () => {
    const d = parseChoiceReply('{"type":"function_call","calls":[]}', [{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.equal(d, null);
  });

  it('rejects garbage', () => {
    const d = parseChoiceReply('hello world', [{ type: 'function', function: { name: 'calc' } }], 'auto');
    assert.equal(d, null);
  });

  it('describeTools lists names and schemas', () => {
    const doc = describeTools([{ type: 'function', function: { name: 'calc', description: 'Calculate', parameters: { type: 'object' } } }]);
    assert.ok(doc.includes('calc') && doc.includes('Calculate'));
  });
});

describe('tool calling — salvageAnswerText', () => {
  let salvageAnswerText;

  it('imports the helper', async () => {
    ({ salvageAnswerText } = await import('../src/backends/shared/client-tools.ts'));
  });

  it('prefers the decoded text the scanner already streamed', () => {
    assert.equal(salvageAnswerText('{"type":"text","text":"partial answ', 'partial answ'), 'partial answ');
  });

  it('accepts plain prose', () => {
    assert.equal(salvageAnswerText('Ünicöde prose stays intact.'), 'Ünicöde prose stays intact.');
  });

  it('accepts a text field without the type discriminator', () => {
    assert.equal(salvageAnswerText('{"text":"inner text"}'), 'inner text');
  });

  it('keeps the prose before a broken JSON attempt', () => {
    assert.equal(salvageAnswerText('No tools here.\n{"type":'), 'No tools here.');
  });

  it('returns empty for JSON with no text field', () => {
    assert.equal(salvageAnswerText('{"type":"function_call","calls":[]}'), '');
    assert.equal(salvageAnswerText('{"type":"function_call"}'), '');
  });

  it('returns empty for empty output', () => {
    assert.equal(salvageAnswerText(''), '');
    assert.equal(salvageAnswerText('   '), '');
  });

  it('unwraps markdown-fenced prose', () => {
    assert.equal(salvageAnswerText('```\nplain answer\n```'), 'plain answer');
  });
});

// ---------------------------------------------------------------------------
// Tool calling — decision stream scanner (token streaming of the answer)
// ---------------------------------------------------------------------------

describe('tool calling — DecisionStreamScanner', () => {
  let DecisionStreamScanner;
  let parseChoiceReply;

  it('imports the scanner', async () => {
    ({ DecisionStreamScanner } = await import('../src/backends/shared/decision-stream.ts'));
    ({ parseChoiceReply } = await import('../src/backends/shared/client-tools.ts'));
  });

  it('streams the text field decoded, character by character', () => {
    const scanner = new DecisionStreamScanner();
    const chunks = [
      '{"type":"te',
      'xt","text":"Hel',
      'lo, wo',
      'rld"}',
    ];
    let out = '';
    for (const chunk of chunks) out += scanner.push(chunk);
    assert.equal(out, 'Hello, world');
    assert.equal(scanner.emittedLength, 12);
    assert.equal(scanner.decisionType, 'text');
  });

  it('decodes escapes across chunk boundaries', () => {
    const scanner = new DecisionStreamScanner();
    let out = '';
    out += scanner.push('{"type":"text","text":"line\\');
    out += scanner.push('nquote: \\" back');
    out += scanner.push('slash: \\\\ done"}');
    assert.equal(out, 'line\nquote: " backslash: \\ done');
  });

  it('decodes unicode escapes split across chunks', () => {
    const scanner = new DecisionStreamScanner();
    let out = '';
    out += scanner.push('{"type":"text","text":"\\u00');
    out += scanner.push('c9ok"}');
    assert.equal(out, 'Éok');
  });

  it('never leaks function_call arguments and detects the type', () => {
    const scanner = new DecisionStreamScanner();
    let out = '';
    out += scanner.push('{"type":"function_call","calls":[{"name":"list_items","arguments":{"text":"not answer"}}]}');
    assert.equal(out, '');
    assert.equal(scanner.decisionType, 'function_call');
  });

  it('ignores nested type/text keys inside arguments', () => {
    const scanner = new DecisionStreamScanner();
    let out = '';
    out += scanner.push('{"type":"function_call","calls":[{"name":"x","arguments":{"type":"text","text":"nested"}}],"extra":"tail"}');
    assert.equal(out, '');
    assert.equal(scanner.decisionType, 'function_call');
  });

  it('stops streaming at the closing quote of the text value', () => {
    const scanner = new DecisionStreamScanner();
    let out = scanner.push('{"type":"text","text":"answer","extra":"not streamed"}');
    assert.equal(out, 'answer');
    assert.equal(scanner.emittedLength, 6);
  });

  it('keeps collecting raw text after the first object closes', () => {
    // The scanner stops *decoding* at the end of the first decision, but the
    // raw text has to keep growing: a model asked for several calls sometimes
    // writes one object per call, and a reply cut off mid-second-object reads
    // as a syntax error and discards the calls that were really in it.
    const reply = [
      '{"type":"function_call","calls":[{"name":"bash","arguments":{"command":"a"}}]}',
      '{"type":"function_call","calls":[{"name":"glob","arguments":{"pattern":"x"}}]}',
      '{"type":"function_call","calls":[{"name":"grep","arguments":{"pattern":"y"}}]}',
    ].join('\n');
    const scanner = new DecisionStreamScanner();
    let emitted = '';
    for (let i = 0; i < reply.length; i += 5) emitted += scanner.push(reply.slice(i, i + 5));
    assert.equal(scanner.rawText, reply, 'every character the model wrote is kept');
    assert.equal(emitted, '', 'and none of it is decoded — no call arguments reach the client');
    assert.deepEqual(parseChoiceReply(scanner.rawText, [
      { type: 'function', function: { name: 'bash' } },
      { type: 'function', function: { name: 'glob' } },
      { type: 'function', function: { name: 'grep' } },
    ], 'auto', { repair: true }), {
      calls: [
        { name: 'bash', arguments: { command: 'a' } },
        { name: 'glob', arguments: { pattern: 'x' } },
        { name: 'grep', arguments: { pattern: 'y' } },
      ],
    });
  });

  it('still decodes a text decision exactly once', () => {
    const scanner = new DecisionStreamScanner();
    let out = '';
    for (const chunk of ['{"type":"text","text":"hel', 'lo"}', ' trailing junk']) {
      out += scanner.push(chunk);
    }
    assert.equal(out, 'hello');
    assert.equal(scanner.decoded, 'hello');
  });
});
