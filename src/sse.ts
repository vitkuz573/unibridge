import http from 'node:http';
import { uid } from './utils.js';
import type { Usage, ResponseObject, ResponsesMessageOutput } from './types.js';

export function writeSSE(res: http.ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSSEChunk(res: http.ServerResponse, id: string, created: number, model: string, delta: Record<string, unknown>, finish: string | null, usage?: Usage): void {
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
  writeSSE(res, chunk);
}

export async function streamResponseSSE(res: http.ServerResponse, respObj: ResponseObject, text: string, reasoning: string): Promise<void> {
  const id = respObj.id;
  const msgItem = respObj.output.find(o => o.type === 'message') as ResponsesMessageOutput | undefined;
  const msgId = msgItem?.id || uid('msg');

  writeSSE(res, { type: 'response.created', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });
  writeSSE(res, { type: 'response.in_progress', response: { id, object: 'response', model: respObj.model, output: [], usage: null } });

  let outputIndex = 0;

  if (reasoning) {
    const rid = uid('reas');
    writeSSE(res, {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] },
    });
    writeSSE(res, { type: 'response.reasoning_summary_part.added', summary_index: 0 });
    const RCHUNK = 20;
    for (let i = 0; i < reasoning.length; i += RCHUNK) {
      writeSSE(res, {
        type: 'response.reasoning_summary_text.delta',
        delta: reasoning.slice(i, i + RCHUNK),
        summary_index: 0,
      });
      await new Promise(r => setTimeout(r, 15));
    }
    writeSSE(res, {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { id: rid, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] },
    });
    outputIndex++;
  }

  writeSSE(res, {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { id: msgId, type: 'message', role: 'assistant', content: [] },
  });
  writeSSE(res, {
    type: 'response.content_part.added',
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });

  const CHUNK = 5;
  for (let i = 0; i < text.length; i += CHUNK) {
    writeSSE(res, {
      type: 'response.output_text.delta',
      delta: text.slice(i, i + CHUNK),
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
    });
    await new Promise(r => setTimeout(r, 30));
  }

  writeSSE(res, {
    type: 'response.output_text.done',
    text,
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
  });
  writeSSE(res, {
    type: 'response.content_part.done',
    output_index: outputIndex,
    content_index: 0,
    part: { type: 'output_text', text },
  });
  writeSSE(res, {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
  writeSSE(res, { type: 'response.completed', response: respObj });
}
