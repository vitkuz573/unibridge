import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../dist/backends/shared/structured.js');

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
    const raw = 'Both reads are independent.\n{"type":"function_call","calls":[{"name":"list_hosts","arguments":{}}]}\nDone.';
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
    const S = await import('../dist/backends/shared/structured.js');
    assert.equal(S.schemaReminder(undefined), undefined);
    assert.equal(S.schemaReminder({ type: 'json_object' }), undefined);
    assert.equal(S.schemaReminder({ type: 'text' }), undefined);
  });

  it('emits exact field names for json_schema', async () => {
    const S = await import('../dist/backends/shared/structured.js');
    const r = S.schemaReminder(SCHEMA_FMT);
    assert.match(r, /Reply with raw JSON only/);
    assert.match(r, /"title"/);
    assert.match(r, /"required":\["title"\]/);
  });

  it('is bounded for huge schemas', async () => {
    const S = await import('../dist/backends/shared/structured.js');
    const big = { type: 'object', properties: {} };
    for (let i = 0; i < 200; i++) big.properties[`field_${i}`] = { type: 'string' };
    const r = S.schemaReminder({ type: 'json_schema', json_schema: { name: 'b', schema: big } });
    assert.ok((r || '').length <= 1400, `reminder too long: ${(r || '').length}`);
  });
});
