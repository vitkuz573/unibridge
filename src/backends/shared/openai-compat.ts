import type { ChatRequest } from '../../types.ts';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// Forwarding a request to an OpenAI-compatible server.
//
// Both the `openai` and `kilocode` backends talk to a server that speaks the
// OpenAI wire contract, and both used to carry their own copy of a `buildParams`
// listing the fields to copy. Two lists meant two places to forget a field, and
// they had already drifted: `kilocode` never forwarded `logprobs`, `top_logprobs`
// or `logit_bias`, so a caller asking for token log probabilities through one
// backend and not the other got answers from two different questions.
//
// There is no list here. The request arriving from the handler is the SDK's own
// `ChatCompletionCreateParamsBase`, which is the shape the provider expects, so
// forwarding is a spread — and a parameter the vendor adds after this was
// written reaches the upstream without a code change.
// ---------------------------------------------------------------------------

/**
 * The request as the provider's non-streaming create call wants it.
 *
 * `stream` is dropped because the transport mode is passed separately, as the
 * SDK's second argument; leaving it in the body would put the same fact in two
 * places, and the body would win for any server that reads it.
 *
 * `model` defaults to empty when absent rather than being sent as `undefined`:
 * an absent model is a routing failure upstream of here, and a body that says
 * so plainly beats one that omits a required field.
 */
export function chatCompletionParams(
  request: ChatRequest,
  model: string | undefined,
): ChatCompletionCreateParamsNonStreaming {
  const { stream: _stream, ...rest } = request;
  void _stream;
  return { ...rest, model: model || '' };
}