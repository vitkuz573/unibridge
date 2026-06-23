import { createOpencodeClient } from '@opencode-ai/sdk';

export const name = 'opencode';
export const builtinModels = [
  'big-pickle',
  'north-mini-code-free',
  'deepseek-v4-flash-free',
  'nemotron-3-ultra-free',
  'mimo-v2.5-free',
];

export function init(backendConfig) {
  const sdk = createOpencodeClient({ baseUrl: backendConfig.baseUrl });
  return { sdk, baseUrl: backendConfig.baseUrl };
}

export function listModels(backendConfig) {
  const models = backendConfig.models || builtinModels;
  return models.map(id => ({
    id: `opencode/${id}`,
    object: 'model',
  }));
}

export async function complete(backendConfig, request, context) {
  const { messages, modelId, maxTokens: clientMaxTokens, response_format } = request;
  const { sdk, baseUrl } = context;

  // Build system text
  const system = (messages || [])
    .filter(m => m.role === 'system')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join('\n');

  // Build parts list (skip system)
  const parts = [];
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      parts.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          parts.push({ type: 'file', mime: 'image/jpeg', url: p.image_url.url });
        }
      }
    }
  }

  // JSON-force injection for extraction requests (those with a system message)
  const hasSystem = system.length > 0;
  if (hasSystem && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last.type === 'text') {
      last.text += '\n\nIMPORTANT: Output ONLY valid JSON. No natural language, no explanations. Raw JSON only.';
    }
  }

  // Build SDK message body
  const msgBody = {
    model: {
      providerID: 'opencode',
      modelID: modelId || backendConfig.defaultModel || 'big-pickle',
    },
    parts,
  };
  if (system) msgBody.system = system;

  // maxTokens floor at 4096 for reasoning models
  const effectiveMaxTokens = Math.max(clientMaxTokens || 0, 4096);
  msgBody.maxTokens = effectiveMaxTokens;

  if (response_format?.type) {
    msgBody.response_format = response_format;
  }

  // Create session
  const session = await sdk.session.create({
    permission: [{ permission: '*', pattern: '**', action: 'allow' }],
  });

  // Send message via raw fetch
  const sdkRes = await fetch(`${baseUrl}/session/${session.data.id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msgBody),
    signal: AbortSignal.timeout(600_000),
  });

  if (!sdkRes.ok) {
    const errText = await sdkRes.text();
    throw new Error(`opencode SDK ${sdkRes.status}: ${errText.substring(0, 500)}`);
  }

  const data = await sdkRes.json();

  // Extract text from response parts
  let content = '';
  for (const p of data.parts || []) {
    if (p.type === 'text' && p.text) content += p.text;
  }

  // Strip markdown fences
  content = content
    .replace(/^```(?:json)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .trim();

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (data.info?.tokens) {
    usage.prompt_tokens = data.info.tokens.input || 0;
    usage.completion_tokens = data.info.tokens.output || 0;
    usage.total_tokens = (data.info.tokens.input || 0) + (data.info.tokens.output || 0);
  }

  return {
    id: `chat-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `opencode/${modelId || backendConfig.defaultModel}`,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage,
  };
}
