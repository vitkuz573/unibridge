import type { ToolCall, ToolDefinition } from '../../types.ts';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { validateStructuredOutput, extractJson } from './structured.ts';
import { uid } from '../../utils.ts';

// ---------------------------------------------------------------------------
// Client-executed tools decision contract.
//
// serve cannot accept foreign tool schemas (tools is a {name: bool} map of
// LOCAL tools only). So when the client sends its own tools and the backend
// is configured with clientTools:true, we do NOT offer local tools at all.
// Instead we ask the model — via the native response_format json_schema
// contract — to return either a function_call decision or a final answer,
// validate it locally, and hand tool calls back to the client (finish_reason
// tool_calls). The client executes and returns role:tool; the loop
// continues until the model returns text.
//
// A decision carries an ARRAY of calls so one round can request several
// independent read-only tools; the client executes them concurrently and
// keeps the provider-facing order stable.
//
// No prompt hacks: the choice schema travels in response_format, the tool
// schemas travel back to the client verbatim in tool_calls. The only text
// added is the minimal JSON-shape instruction the schema itself implies.
// ---------------------------------------------------------------------------

/** Upper bound on the calls one decision may request. */
export const MAX_PARALLEL_CALLS = 4;

export interface ClientToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ClientToolDecision = { calls: ClientToolCall[] } | { text: string };

// SDK ChatCompletionTool is a union (function | custom); clientTools only
// orchestrates function tools. Narrow once, use everywhere.
export type FunctionTool = ChatCompletionFunctionTool;
export function asFunctionTool(t: ToolDefinition): FunctionTool | null {
  return t.type === 'function' ? (t as FunctionTool) : null;
}
export function functionTools(tools: ToolDefinition[]): FunctionTool[] {
  const out: FunctionTool[] = [];
  for (const t of tools) {
    const f = asFunctionTool(t);
    if (f) out.push(f);
  }
  return out;
}

/**
 * The tools of a request, in the one spelling this contract reads.
 *
 * chat-completions nests a function tool's schema under `function`; the
 * Responses API keeps `name`, `description` and `parameters` flat beside
 * `type`. Both are real client requests for the same thing, and every reader
 * here — `choiceSchemaFor`, `clientToolsSystem`, `parseChoiceReply` — wants the
 * chat spelling, so the translation happens once, here.
 *
 * A cast at the call site would have been the cheaper mistake and a worse one:
 * `t.function.name` on a flat Responses tool is a TypeError on the first tool
 * of the first request, which is what a Responses client carrying tools used to
 * get instead of a tool call.
 *
 * Non-function tools (the Responses API's `web_search`, `file_search`, …) are
 * not part of the contract: the model cannot be asked for them through a JSON
 * decision, so they are dropped rather than described and then ignored.
 */
export function asChatTools(tools: unknown): FunctionTool[] {
  if (!Array.isArray(tools)) return [];
  const out: FunctionTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as {
      type?: unknown;
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    if (t.type !== 'function') continue;
    const fn = t.function;
    if (fn && typeof fn === 'object') {
      const nested = asFunctionTool(tool as ToolDefinition);
      if (nested) out.push(nested);
      continue;
    }
    if (typeof t.name !== 'string' || !t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        parameters: (t.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      },
    } as FunctionTool);
  }
  return out;
}

function callItemSchema(tools: ToolDefinition[]) {
  return {
    type: 'object',
    properties: {
      name: { enum: functionTools(tools).map(t => t.function.name) },
      arguments: { type: 'object' },
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  } as Record<string, unknown>;
}

function functionCallSchema(tools: ToolDefinition[]) {
  return {
    type: 'object',
    properties: {
      type: { const: 'function_call' },
      calls: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PARALLEL_CALLS,
        items: callItemSchema(tools),
      },
    },
    required: ['type', 'calls'],
    additionalProperties: false,
  } as Record<string, unknown>;
}

/**
 * One decision object per call, as the model writes them when it has several
 * in mind.
 *
 * The contract asks for a single object with a `calls` array, and the model
 * usually writes that. It also writes one object per call — three lines of
 * `{"type":"function_call","calls":[…]}`, each holding one — which is the same
 * answer spread over three JSON documents. `JSON.parse` reads that as a syntax
 * error ("unexpected non-whitespace character after JSON"), so the whole reply
 * is thrown away and a turn that had three perfectly good calls in it is
 * reported as no decision at all.
 *
 * Recognising it here keeps the promise the array makes — up to
 * {@link MAX_PARALLEL_CALLS} calls in one round — while accepting the way the
 * model actually delivers them. Only whole objects that parse are counted, and
 * only calls the client declared are kept, so a truncated tail or an invented
 * tool name still falls through to the normal validation and retry.
 */
function splitDecisionObjects(rawText: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch !== '}') continue;
    depth--;
    if (depth !== 0 || start < 0) continue;
    const slice = rawText.slice(start, i + 1);
    start = -1;
    try {
      const parsed = JSON.parse(slice) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A partial or malformed object contributes nothing; the reply is still
      // worth another look as a whole.
    }
  }
  return out;
}

/**
 * Fold a reply that is one decision object per call into the single decision
 * the rest of the contract speaks.
 *
 * Returns `null` when the reply is not that shape, so every other spelling —
 * one object, prose, a truncated tail — keeps going through the ordinary
 * validation path untouched.
 */
function mergeSequentialDecisions(
  rawText: string,
  tools: ToolDefinition[],
): ClientToolDecision | null {
  const objects = splitDecisionObjects(rawText);
  if (objects.length < 2) return null;
  const calls: ClientToolCall[] = [];
  for (const obj of objects) {
    // A text decision anywhere ends the turn: the model answered, and a later
    // object cannot un-answer it. Neither may a shape this contract does not
    // define — a reply is merged only when every object in it is a call.
    if (obj['type'] !== 'function_call' || !Array.isArray(obj['calls'])) return null;
    const parsed = readCalls(obj['calls'] as unknown[], tools);
    if (!parsed) return null;
    calls.push(...parsed);
  }
  if (calls.length === 0) return null;
  // The array's own limit still holds. A reply claiming more calls than one
  // round may carry is truncated to what the contract promises rather than
  // refused: the calls are real, and dropping the turn would discard work the
  // client asked for.
  return { calls: calls.slice(0, MAX_PARALLEL_CALLS) };
}

// Validate one raw model reply against the choice schema; returns the parsed
// decision or null when invalid (the caller retries with feedback).
export function parseChoiceReply(
  rawText: string,
  tools: ToolDefinition[],
  toolChoice: 'auto' | 'none' | 'required',
  opts?: { repair?: boolean },
): ClientToolDecision | null {
  const schema = choiceSchemaFor(tools, toolChoice);
  const check = validateStructuredOutput(rawText, {
    type: 'json_schema',
    json_schema: { name: 'tool_choice', strict: true, schema },
  }, opts);
  if (!check.ok) {
    // A reply the model spread over one JSON document per call is still that
    // answer; the schema check simply cannot read it as a single object.
    return mergeSequentialDecisions(rawText, tools);
  }
  const v = check.value as Record<string, unknown>;
  if (v['type'] === 'text' && typeof v['text'] === 'string') return { text: v['text'] };
  if (v['type'] === 'function_call' && Array.isArray(v['calls'])) {
    const parsed = readCalls(v['calls'] as unknown[], tools);
    if (!parsed || parsed.length === 0 || parsed.length > MAX_PARALLEL_CALLS) return null;
    return { calls: parsed };
  }
  return null;
}

/**
 * The calls of one decision object, checked against what the client declared.
 *
 * A name the client never sent is refused rather than passed on: the client
 * cannot dispatch it, and forwarding a call it does not recognise turns a
 * recoverable turn into an error the caller has to interpret.
 */
function readCalls(rawCalls: unknown[], tools: ToolDefinition[]): ClientToolCall[] | null {
  const names = new Set(functionTools(tools).map(t => t.function.name));
  const calls: ClientToolCall[] = [];
  for (const raw of rawCalls) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const name = item['name'];
    if (typeof name !== 'string' || !names.has(name)) return null;
    const args = item['arguments'];
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    calls.push({ name, arguments: args as Record<string, unknown> });
  }
  return calls;
}

function textChoiceSchema() {
  return {
    type: 'object',
    properties: {
      type: { const: 'text' },
      text: { type: 'string' },
    },
    required: ['type', 'text'],
    additionalProperties: false,
  } as Record<string, unknown>;
}

export function choiceSchemaFor(
  tools: ToolDefinition[],
  toolChoice: 'auto' | 'none' | 'required',
): Record<string, unknown> {
  if (toolChoice === 'none') return textChoiceSchema();
  if (toolChoice === 'required') return functionCallSchema(tools);
  return {
    anyOf: [functionCallSchema(tools), textChoiceSchema()],
  } as Record<string, unknown>;
}

export function describeTools(tools: ToolDefinition[]): string {
  return functionTools(tools)
    .map(t => `- ${t.function.name}${t.function.description ? `: ${t.function.description}` : ''}\n  parameters: ${JSON.stringify(t.function.parameters || { type: 'object' })}`)
    .join('\n');
}

/**
 * System instruction appended to the request when client tools are active.
 *
 * The decision contract has to win against the model's native tool-calling
 * habit: serve offers no tools at all (the request carries `tools: {}`), and a
 * model that tries a native call only produces an upstream "unavailable tool"
 * error and then prose. The instruction is therefore explicit about raw JSON,
 * forbids native calls, and ships two short examples.
 *
 * The tool names go in twice, and the second copy is load-bearing. The first
 * (`describeTools`) explains each tool; the second lists the names flat, right
 * next to the reply format. A model reaching for a tool it knows from elsewhere
 * — "shell" where the client declared "bash" — otherwise gets back only
 * "must match at least one anyOf branch", because the schema carrying the enum
 * sits behind the instruction and never reaches the reply path. The retry
 * cannot fix a name it is never shown: measured on a live turn, the model
 * produced `shell` and `question` for tools declared as `bash` and
 * `ask_user_question`, and both replies were discarded with that same
 * unhelpful error until the names were stated where they are read.
 */
export function clientToolsSystem(system: string, tools: ToolDefinition[]): string {
  return [
    system,
    `You have these client tools (executed by the client, NOT by you). ` +
      `You cannot run them yourself and you must not attempt a native tool call:\n${describeTools(tools)}`,
    'Reply with raw JSON only — no markdown fences, no commentary, no native tool calls:\n' +
      '- To call one or more tools reply exactly ' +
      '{"type":"function_call","calls":[{"name":"<tool>","arguments":{...}}]} ' +
      '(up to 4 independent calls in one array; "arguments" must match the tool parameters).\n' +
      '- To answer without a tool reply exactly {"type":"text","text":"<your complete answer>"}.\n' +
    `Valid tool names — use these exactly, no others:\n${functionTools(tools).map(t => t.function.name).join(', ')}`,
    'Examples:\n' +
      'User: how many items are ready?\n' +
      'Assistant: {"type":"function_call","calls":[{"name":"list_items","arguments":{}}]}\n' +
      'User: hello\n' +
      'Assistant: {"type":"text","text":"Hello! How can I help?"}',
    'Always emit exactly one of these two JSON objects and nothing else.',
  ].filter(Boolean).join('\n\n');
}

// Two names are the same tool when they differ only in case or punctuation:
// `Bash`, `bash`, `read-file` and `read_file` are one slip, and the fix is the
// same. A *truncation* is not — `question` for a declared `ask_user_question`
// is a name the client cannot dispatch, so it is reported like any other.
const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The names the model asked for that the client never declared.
 *
 * Measured on live turns against a 26-tool client: the model reached for
 * "shell" where the client declared "bash", and for "question" where it
 * declared "ask_user_question". Both replies were discarded — correctly, since
 * the client cannot dispatch them — but the model was told only "must match at
 * least one anyOf branch", because the enum naming the real tools lives in the
 * schema, behind the prompt, and never appears in the feedback. So the retry
 * asked the same question the same blind way.
 *
 * Naming what it got wrong is what lets the next attempt be a different one.
 */
export function unknownToolNames(rawText: string, tools: ToolDefinition[]): string[] {
  const known = functionTools(tools).map(t => t.function.name);
  const normalized = new Set(known.map(normalizeName));
  // Only the decision envelope's own `name` fields are tool names. Anything
  // deeper is an argument the model is making up — a shell command holding
  // `{"name": "…"}`, a filter — and reading those as invented tools produces
  // feedback about a mistake the model did not make.
  const envelope = /"type"\s*:\s*"function_call"[\s\S]*?"calls"\s*:\s*\[([\s\S]*?)\]\s*\}\s*$/;
  const body = envelope.exec(rawText)?.[1] ?? rawText;
  const wanted: string[] = [];
  for (const match of body.matchAll(/\{\s*["']name["']\s*:\s*["']([^"']+)["']\s*,/g)) {
    const name = (match[1] || '').trim();
    if (!name) continue;
    if (!normalized.has(normalizeName(name))) wanted.push(name);
  }
  return [...new Set(wanted)];
}

export function toToolCalls(decision: ClientToolCall[]): ToolCall[] {
  return decision.map(call => ({
    id: uid('call'),
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recover a user-facing answer when the decision JSON is invalid or missing.
 *
 * A model that ignores the decision contract usually still answers in prose
 * (or in a `{"text": "..."}` object without the `type` discriminator). Losing
 * that text turns a useful reply into a hard error, so the caller falls back to
 * it before giving up. `decodedText` is whatever the incremental scanner
 * already decoded from a `text` field — it wins because it may already have
 * been streamed to the client.
 *
 * Returns '' when there is no meaningful answer to salvage (empty output, or
 * JSON that carries no text field).
 */
export function salvageAnswerText(rawText: string, decodedText = ''): string {
  if (decodedText.trim()) return decodedText;
  let text = (rawText || '').trim();
  if (!text) return '';
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence && typeof fence[1] === 'string') text = fence[1].trim();
  // A partially-shaped decision that still carries a text field is an answer.
  const extracted = extractJson(text, true);
  if (
    extracted.ok &&
    isRecord(extracted.value) &&
    typeof extracted.value['text'] === 'string' &&
    (extracted.value['text'] as string).trim()
  ) {
    return extracted.value['text'] as string;
  }
  // Otherwise keep the prose a model prepended to its broken JSON attempt.
  const firstJson = text.search(/[{[]/);
  if (firstJson === 0) return '';
  const prose = (firstJson > 0 ? text.slice(0, firstJson) : text).trim();
  return /^[{[]/.test(prose) ? '' : prose;
}


