import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../src/backends/shared/structured.ts');

const SCHEMA_FMT = {
  type: 'json_schema',
  json_schema: {
    name: 't',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
};

describe('structured — extractJson repair', () => {
  it('parses clean JSON without repair', () => {
    const r = S.extractJson('{"a": 1}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
  });

  it('no-repair keeps trailing prose as error (contract)', () => {
    const r = S.extractJson('{"a": 1} trailing words');
    assert.equal(r.ok, false);
    assert.match(r.parseError || '', /invalid JSON/);
  });

  it('repair cuts trailing prose', () => {
    const r = S.extractJson('{"a": 1} here is your json, enjoy', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
  });

  it('repair cuts leading prose', () => {
    const r = S.extractJson('Calling both tools in one round.{"a": 1}', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
  });

  it('repair cuts leading and trailing prose around a call list', () => {
    const raw = 'Both reads are independent.\n{"type":"function_call","calls":[{"name":"list_items","arguments":{}}]}\nDone.';
    const r = S.extractJson(raw, true);
    assert.equal(r.ok, true);
    assert.equal(r.value.type, 'function_call');
    assert.equal(r.value.calls.length, 1);
  });

  it('repair closes truncated tails', () => {
    const r = S.extractJson('{"a": 1, "b": {"c": [1, 2', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1, b: { c: [1, 2] } });
  });

  it('repair closes unclosed string', () => {
    const r = S.extractJson('{"a": "hel', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 'hel' });
  });

  it('repair does not invent valid JSON from garbage', () => {
    const r = S.extractJson('hello world, no json here', true);
    assert.equal(r.ok, false);
  });

  // Measured on live turns. Each of these is a reply the model wrote with both
  // members present, which `JSON.parse` refused and the turn was lost over.
  it('repair restores a dropped comma between members', () => {
    const raw = '{"type":"function_call","calls":[{"name":"bash" "arguments":{"command":"pwd"}}]}';
    const r = S.extractJson(raw, true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.calls[0], { name: 'bash', arguments: { command: 'pwd' } });
  });

  it('repair restores a dropped colon after a key', () => {
    const r = S.extractJson('{"name" "bash"}', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { name: 'bash' });
  });

  it('repair restores dropped separators at any depth', () => {
    const r = S.extractJson('{"a":{"b":1 "c":2},"d":3}', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: { b: 1, c: 2 }, d: 3 });
    const arr = S.extractJson('{"calls":[{"n":"a"} {"n":"b"}]}', true);
    assert.equal(arr.ok, true);
    assert.equal(arr.value.calls.length, 2);
  });

  it('repair drops a trailing comma the model left behind', () => {
    assert.deepEqual(S.extractJson('{"a":1,"b":2,}', true).value, { a: 1, b: 2 });
    assert.deepEqual(S.extractJson('{"a":[1,2,]}', true).value, { a: [1, 2] });
    assert.deepEqual(S.extractJson('{"a":{"b":1,},"c":2}', true).value, { a: { b: 1 }, c: 2 });
  });

  it('repairs a reply that did all three at once', () => {
    const raw = '{"type":"function_call","calls":[{"name":"bash" "arguments":{"command":"pwd"}}]}]}\n';
    const r = S.extractJson(raw, true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.calls[0], { name: 'bash', arguments: { command: 'pwd' } });
  });

  it('repair leaves a second document a second document', () => {
    // A missing separator at the top level would be a different reply than the
    // model wrote, so nothing is inserted there: the first value is the answer.
    const r = S.extractJson('{"a":1}\n{"b":2}', true);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
  });

  it('repair does not touch separators inside strings', () => {
    assert.deepEqual(S.extractJson('{"t":"a, b } c","u":"x:y"}', true).value, { t: 'a, b } c', u: 'x:y' });
  });

  it('repair leaves correct JSON exactly as it is', () => {
    const raw = '{"a":1,"b":[1,2],"c":{"d":3},"e":"x,y"}';
    assert.deepEqual(S.extractJson(raw, true).value, { a: 1, b: [1, 2], c: { d: 3 }, e: 'x,y' });
  });

  it('validateStructuredOutput with repair salvages prose-wrapped JSON', () => {
    const v = S.validateStructuredOutput('{"title": "x"} done!', SCHEMA_FMT, { repair: true });
    assert.equal(v.ok, true);
  });
});

describe('structured — buildRetryFeedback levels', () => {
  const bad = JSON.stringify({ topic: 'x', question: 'y' });
  const v = S.validateStructuredOutput(bad, SCHEMA_FMT);
  assert.equal(v.ok, false);

  it('level 0 is bare errors', () => {
    const fb = S.buildRetryFeedback(bad, SCHEMA_FMT, v.errors, 0);
    assert.match(fb, /missing required property 'title'/);
    assert.doesNotMatch(fb, /Hints/);
  });

  it('level 1 adds key diff', () => {
    const fb = S.buildRetryFeedback(bad, SCHEMA_FMT, v.errors, 1);
    assert.match(fb, /'topic' is not a valid key here, expected one of \[title, count\]/);
    assert.match(fb, /use one of \[title, count\]/);
  });

  it('level 2 adds compact schema excerpt', () => {
    const fb = S.buildRetryFeedback(bad, SCHEMA_FMT, v.errors, 2);
    assert.match(fb, /schema at \/: \{"type":"object"/);
    assert.match(fb, /"required":\["title"\]/);
  });

  it('level 2 bounds excerpts (no explosion on big schemas)', () => {
    const fb = S.buildRetryFeedback(bad, SCHEMA_FMT, v.errors, 2);
    assert.ok(fb.length < 2000, `feedback too long: ${fb.length}`);
  });
});

describe('structured — schemaReminder', () => {
  it('returns undefined for non-schema formats', async () => {
    const S = await import('../src/backends/shared/structured.ts');
    assert.equal(S.schemaReminder(undefined), undefined);
    assert.equal(S.schemaReminder({ type: 'json_object' }), undefined);
    assert.equal(S.schemaReminder({ type: 'text' }), undefined);
  });

  it('emits exact field names for json_schema', async () => {
    const S = await import('../src/backends/shared/structured.ts');
    const r = S.schemaReminder(SCHEMA_FMT);
    assert.match(r, /Reply with raw JSON only/);
    assert.match(r, /"title"/);
    assert.match(r, /"required":\["title"\]/);
  });

  it('is bounded for huge schemas', async () => {
    const S = await import('../src/backends/shared/structured.ts');
    const big = { type: 'object', properties: {} };
    for (let i = 0; i < 200; i++) big.properties[`field_${i}`] = { type: 'string' };
    const r = S.schemaReminder({ type: 'json_schema', json_schema: { name: 'b', schema: big } });
    assert.ok((r || '').length <= 1400, `reminder too long: ${(r || '').length}`);
  });
});

// The Responses API spells structured output flat, beside `type`; chat
// nests it under `json_schema`. Same contract, two spellings — and a client
// that asks for structured output on /v1/responses must get it enforced.
const RESPONSES_FLAT_FMT = {
  type: 'json_schema',
  name: 't',
  strict: true,
  schema: {
    type: 'object',
    properties: { title: { type: 'string' }, count: { type: 'integer' } },
    required: ['title'],
    additionalProperties: false,
  },
};

describe('structured — asResponseFormat', () => {
  it('reads the schema out of the Responses spelling', () => {
    const fmt = S.asResponseFormat(RESPONSES_FLAT_FMT);
    assert.deepEqual(fmt, SCHEMA_FMT);
  });

  it('leaves the chat spelling unchanged', () => {
    assert.equal(S.asResponseFormat(SCHEMA_FMT), SCHEMA_FMT);
  });

  it('passes the schemaless formats through', () => {
    assert.deepEqual(S.asResponseFormat({ type: 'json_object' }), { type: 'json_object' });
    assert.deepEqual(S.asResponseFormat({ type: 'text' }), { type: 'text' });
  });

  it('has no contract for absent or unusable input', () => {
    assert.equal(S.asResponseFormat(undefined), undefined);
    // `json_schema` without a schema names a contract that does not exist;
    // reporting "no contract" is better than enforcing an empty one.
    assert.equal(S.asResponseFormat({ type: 'json_schema', name: 't' }), undefined);
  });
});

describe('structured — Responses spelling reaches the same enforcement', () => {
  it('a violating answer is rejected instead of passing unchecked', () => {
    const r = S.validateStructuredOutput(
      '{"count": 7}',
      S.asResponseFormat(RESPONSES_FLAT_FMT),
    );
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /title/);
  });

  it('a satisfying answer passes', () => {
    const r = S.validateStructuredOutput(
      '{"title": "ok"}',
      S.asResponseFormat(RESPONSES_FLAT_FMT),
    );
    assert.equal(r.ok, true);
  });

  it('the schema reminder carries the field names', () => {
    const r = S.schemaReminder(S.asResponseFormat(RESPONSES_FLAT_FMT));
    assert.match(r, /Reply with raw JSON only/);
    assert.match(r, /"title"/);
  });

  it('retry feedback names the missing field', () => {
    const v = S.validateStructuredOutput(
      '{"count": 7}',
      S.asResponseFormat(RESPONSES_FLAT_FMT),
    );
    const fb = S.buildRetryFeedback(
      '{"count": 7}',
      S.asResponseFormat(RESPONSES_FLAT_FMT),
      v.errors,
      1,
    );
    assert.match(fb, /"required":\["title"\]/);
  });
});
