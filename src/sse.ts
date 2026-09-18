import http from 'node:http';
import { uid } from './utils.js';
import type { Usage, ResponseObject, ResponsesMessageOutput, ResponsesFunctionCallOutput, ResponsesStreamEvent } from './types.js';

export function writeSSE(res: http.ServerResponse, event: ResponsesStreamEvent | Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSSEChunk(
  res: http.ServerResponse,
  id: string,
  created: number,
  model: string,
  delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: unknown[] },
  finish: string | null,
  usage?: Usage,
): void {
  const chunk: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: delta || {},
      finish_reason: finish || null,
    }],
  };
  if (usage) chunk['usage'] = usage;
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function streamResponseSSE(res: http.ServerResponse, respObj: ResponseObject, text: string, reasoning: string): Promise<void> {
  const id = respObj.id;
  const msgItem = respObj.output.find(o => o.type === 'message') as ResponsesMessageOutput | undefined;
  const msgId = msgItem?.id || uid('msg');

  let seq = 0;
  const nextSeq = () => seq++;
  const baseResponse = (output: unknown[]) => ({
    id,
    object: 'response' as const,
    created_at: respObj.created_at,
    error: null,
    model: respObj.model,
    output,
    output_text: text,
    usage: respObj.usage,
  });

  writeSSE(res, { type: 'response.created', sequence_number: nextSeq(), response: baseResponse([]) } as ResponsesStreamEvent);

  let outputIndex = 0;

  if (reasoning) {
    const rid = uid('reas');
    writeSSE(res, {
      type: 'response.output_item.added',
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [] },
    } as ResponsesStreamEvent);
    const RCHUNK = 20;
    for (let i = 0; i < reasoning.length; i += RCHUNK) {
      writeSSE(res, {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: nextSeq(),
        delta: reasoning.slice(i, i + RCHUNK),
        item_id: rid,
        output_index: outputIndex,
      } as ResponsesStreamEvent);
      await new Promise(r => setTimeout(r, 15));
    }
    writeSSE(res, {
      type: 'response.output_item.done',
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] },
    } as ResponsesStreamEvent);
    outputIndex++;
  }

  const fcItems = respObj.output.filter(o => o.type === 'function_call') as ResponsesFunctionCallOutput[];
  for (const fc of fcItems) {
    const fcId = fc.id || uid('fc');
    writeSSE(res, {
      type: 'response.output_item.added',
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item: { type: 'function_call', id: fcId, call_id: fc.call_id, name: fc.name, arguments: '' },
    } as ResponsesStreamEvent);
    writeSSE(res, {
      type: 'response.function_call_arguments.delta',
      sequence_number: nextSeq(),
      item_id: fcId,
      output_index: outputIndex,
      delta: fc.arguments,
    } as ResponsesStreamEvent);
    writeSSE(res, {
      type: 'response.function_call_arguments.done',
      sequence_number: nextSeq(),
      item_id: fcId,
      output_index: outputIndex,
      arguments: fc.arguments,
    } as ResponsesStreamEvent);
    writeSSE(res, {
      type: 'response.output_item.done',
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item: { type: 'function_call', id: fcId, call_id: fc.call_id, name: fc.name, arguments: fc.arguments },
    } as ResponsesStreamEvent);
    outputIndex++;
  }

  writeSSE(res, {
    type: 'response.output_item.added',
    sequence_number: nextSeq(),
    output_index: outputIndex,
    item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  } as ResponsesStreamEvent);
  writeSSE(res, {
    type: 'response.content_part.added',
    sequence_number: nextSeq(),
    output_index: outputIndex,
    item_id: msgId,
    content_index: 0,
    part: { type: 'output_text', annotations: [], text: '' },
  } as ResponsesStreamEvent);

  const CHUNK = 5;
  for (let i = 0; i < text.length; i += CHUNK) {
    writeSSE(res, {
      type: 'response.output_text.delta',
      sequence_number: nextSeq(),
      delta: text.slice(i, i + CHUNK),
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      logprobs: [],
    } as ResponsesStreamEvent);
    await new Promise(r => setTimeout(r, 30));
  }

  writeSSE(res, {
    type: 'response.output_text.done',
    sequence_number: nextSeq(),
    text,
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
    logprobs: [],
  } as ResponsesStreamEvent);
  writeSSE(res, {
    type: 'response.content_part.done',
    sequence_number: nextSeq(),
    output_index: outputIndex,
    item_id: msgId,
    content_index: 0,
    part: { type: 'output_text', annotations: [], text },
  } as ResponsesStreamEvent);
  writeSSE(res, {
    type: 'response.output_item.done',
    sequence_number: nextSeq(),
    output_index: outputIndex,
    item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text }] },
  } as ResponsesStreamEvent);
  writeSSE(res, { type: 'response.completed', sequence_number: nextSeq(), response: baseResponse(respObj.output) } as ResponsesStreamEvent);
}
