import type { ToolCall, ToolDefinition } from '../../types.js';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { validateStructuredOutput } from './structured.js';

// ---------------------------------------------------------------------------
// Client-executed tools orchestrator (the ideal architecture).
//
// serve cannot accept foreign tool schemas (tools is a {name: bool} map of
// LOCAL tools only). So when the client sends its own tools and the backend
// is configured with clientTools:true, we do NOT offer local tools at all.
// Instead we ask the model — via the native response_format json_schema
// contract — to return either a tool call or a final answer, validate it
// locally, and hand tool calls back to the client (finish_reason
// tool_calls). The client executes and returns role:tool; the loop
// continues until the model returns text.
//
// No prompt hacks: the choice schema travels in response_format, the tool
// schemas travel back to the client verbatim in tool_calls. The only text
// added is the minimal JSON-shape instruction the schema itself implies.
// ---------------------------------------------------------------------------

export interface ClientToolsLoopRequest {
  model: string;
  system: string;
  tools: ToolDefinition[];
  toolChoice: 'auto' | 'none' | 'required';
  historyText: (round: number) => string;
  maxTokens?: number;
}

export interface ClientToolsRound {
  text: string;
  toolCalls: ToolCall[];
}

export interface ClientToolsDeps {
  // One proxied model call: returns validated parsed JSON for the choice schema.
  askChoice: (system: string, userText: string, maxTokens?: number) => Promise<{ name: string; arguments: unknown } | { text: string }>;
  maxRounds: number;
}

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

function toolChoiceSchema(tools: ToolDefinition[]) {
  return {
    type: 'object',
    properties: {
      type: { const: 'function_call' },
      name: { enum: functionTools(tools).map(t => t.function.name) },
      arguments: { type: 'object' },
    },
    required: ['type', 'name', 'arguments'],
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
  if (toolChoice === 'required') return toolChoiceSchema(tools);
  return {
    anyOf: [toolChoiceSchema(tools), textChoiceSchema()],
  } as Record<string, unknown>;
}

export function describeTools(tools: ToolDefinition[]): string {
  return functionTools(tools)
    .map(t => `- ${t.function.name}${t.function.description ? `: ${t.function.description}` : ''}\n  parameters: ${JSON.stringify(t.function.parameters || { type: 'object' })}`)
    .join('\n');
}

// Validate one raw model reply against the choice schema; returns the
// parsed decision or null when invalid (caller retries with feedback).
export function parseChoiceReply(
  rawText: string,
  tools: ToolDefinition[],
  toolChoice: 'auto' | 'none' | 'required',
): { name: string; arguments: unknown } | { text: string } | null {
  const schema = choiceSchemaFor(tools, toolChoice);
  const check = validateStructuredOutput(rawText, {
    type: 'json_schema',
    json_schema: { name: 'tool_choice', strict: true, schema },
  });
  if (!check.ok) return null;
  const v = check.value as Record<string, unknown>;
  if (v['type'] === 'text' && typeof v['text'] === 'string') return { text: v['text'] };
  if (v['type'] === 'function_call' && typeof v['name'] === 'string' && typeof v['arguments'] === 'object' && v['arguments'] !== null) {
    return { name: v['name'], arguments: v['arguments'] };
  }
  return null;
}

export async function runClientToolsLoop(
  req: ClientToolsLoopRequest,
  deps: ClientToolsDeps,
): Promise<ClientToolsRound> {
  const toolDoc = describeTools(req.tools);
  const system = [
    req.system,
    `You have these client tools (executed by the client, NOT by you):\n${toolDoc}`,
    'To call a tool reply with EXACTLY this JSON: {"type":"function_call","name":"<tool>","arguments":{...}}.',
    'To answer reply with EXACTLY this JSON: {"type":"text","text":"<your answer>"}.',
    'Nothing else — raw JSON only.',
  ].filter(Boolean).join('\n\n');

  const rounds = Math.max(1, deps.maxRounds);
  for (let round = 0; round < rounds; round++) {
    const decision = await deps.askChoice(system, req.historyText(round), req.maxTokens);
    if ('text' in decision) {
      return { text: decision.text, toolCalls: [] };
    }
    const def = functionTools(req.tools).find(t => t.function.name === decision.name);
    if (!def) {
      throw new Error(`model requested unknown tool '${decision.name}'`);
    }
    const toolCalls: ToolCall[] = [{
      id: `call_${Date.now()}_${round}`,
      type: 'function',
      function: { name: decision.name, arguments: JSON.stringify(decision.arguments) },
    }];
    return { text: '', toolCalls };
  }
  throw new Error(`tool loop did not converge after ${rounds} rounds`);
}
