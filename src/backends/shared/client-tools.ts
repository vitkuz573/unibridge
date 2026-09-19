import type { ToolCall, ToolDefinition } from '../../types.js';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { validateStructuredOutput } from './structured.js';
import { uid } from '../../utils.js';

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

export function choiceSchemaFor(tools: ToolDefinition[], toolChoice: 'auto' | 'none' | 'required') {
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

/** System instruction appended to the request when client tools are active. */
export function clientToolsSystem(system: string, tools: ToolDefinition[]): string {
  return [
    system,
    `You have these client tools (executed by the client, NOT by you):\n${describeTools(tools)}`,
    `To call tools reply with EXACTLY this JSON: {"type":"function_call","calls":[{"name":"<tool>","arguments":{...}}]}. ` +
      `Put several independent read-only calls in the same array.`,
    'To answer reply with EXACTLY this JSON: {"type":"text","text":"<your answer>"}.',
    'Nothing else — raw JSON only.',
  ].filter(Boolean).join('\n\n');
}

export function toToolCalls(decision: ClientToolCall[]): ToolCall[] {
  return decision.map(call => ({
    id: uid('call'),
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

// Validate one raw model reply against the choice schema; returns the
// parsed decision or null when invalid (caller retries with feedback).
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
  if (!check.ok) return null;
  const v = check.value as Record<string, unknown>;
  if (v['type'] === 'text' && typeof v['text'] === 'string') return { text: v['text'] };
  if (v['type'] === 'function_call' && Array.isArray(v['calls'])) {
    const names = new Set(functionTools(tools).map(t => t.function.name));
    const calls: ClientToolCall[] = [];
    for (const raw of v['calls']) {
      if (typeof raw !== 'object' || raw === null) return null;
      const item = raw as Record<string, unknown>;
      if (typeof item['name'] !== 'string' || !names.has(item['name'])) return null;
      const args = item['arguments'];
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
      calls.push({ name: item['name'], arguments: args as Record<string, unknown> });
    }
    if (calls.length === 0 || calls.length > MAX_PARALLEL_CALLS) return null;
    return { calls };
  }
  return null;
}
