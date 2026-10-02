import type { BackendConfig } from './config.ts';
// OpenAI SDK is the single source of truth for the wire contract.
// Wire-facing types are re-exported from the SDK; only unibridge-internal
// shapes (backend contexts, orchestrator requests) are defined here.
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions';
import type {
  ResponseFormatJSONObject,
  ResponseFormatJSONSchema,
  ResponseFormatText,
} from 'openai/resources/shared';
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseFormatTextConfig,
  ResponseInput,
} from 'openai/resources/responses/responses';
import type { EmbeddingCreateParams, CreateEmbeddingResponse, Embedding } from 'openai/resources/embeddings';
import type { Model } from 'openai/resources/models';
import { APIError } from 'openai/core/error';

export { APIError };

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------
// HttpError stays as the internal error (status-carrying). The router maps
// it to the OpenAI error envelope; SDK APIError from passthrough backends
// is converted to HttpError at the backend boundary.

export class HttpError extends Error {
  public status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Convert an SDK APIError (or any upstream failure) into HttpError so the
// router always emits the OpenAI envelope.
export function toHttpError(e: unknown, prefix: string): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof APIError) {
    const msg = typeof e.message === 'string' && e.message ? e.message : `upstream error ${e.status}`;
    return new HttpError(`${prefix} ${e.status}: ${msg}`.substring(0, 500), e.status || 502);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new HttpError(`${prefix}: ${msg}`.substring(0, 500), 503);
}

// ---------------------------------------------------------------------------
// Message types — SDK wire types, re-exported
// ---------------------------------------------------------------------------

export type Message = ChatCompletionMessageParam;

// Internal tool call (subset of SDK function tool call we produce).
export type ToolCall = ChatCompletionMessageFunctionToolCall;

// ---------------------------------------------------------------------------
// Structured output types — SDK wire types, re-exported
// ---------------------------------------------------------------------------

export type JsonSchemaFormat = ResponseFormatJSONSchema;
export type JsonObjectFormat = ResponseFormatJSONObject;
export type TextFormat = ResponseFormatText;
export type ResponseFormat = ResponseFormatJSONSchema | ResponseFormatJSONObject | ResponseFormatText;

/**
 * A structured-output request as it arrives from either contract.
 *
 * chat-completions nests the schema under `json_schema`; the Responses API
 * keeps `name`, `schema` and `strict` flat beside `type`. Both are real client
 * requests, so this names both rather than mislabelling one as the other —
 * which is what the previous hand-written `ResponsesTextFormat` did, and why a
 * `json_schema` sent to `/v1/responses` read as having no schema at all.
 */
export type StructuredFormatRequest = ResponseFormat | ResponseFormatTextConfig;

// ---------------------------------------------------------------------------
// Tool calling types — SDK wire types, re-exported
// ---------------------------------------------------------------------------

export type ToolDefinition = ChatCompletionTool;
export type ToolChoice = ChatCompletionToolChoiceOption;

/**
 * The request type is the SDK's own, and the same object travels from the
 * handler to the backend.
 *
 * It used to be a private interface with camelCase names — `maxTokens`, `topP`,
 * `reasoningEffort` — which meant every OpenAI-compatible backend carried a
 * `buildParams` whose entire job was translating the caller's own request back
 * into the wire spelling it had arrived in. That is a second language for one
 * message, maintained by hand, and it is where dropped parameters went
 * unnoticed: `top_p`, `seed` and the penalties were absent from the private type
 * and so never had a place to be forwarded from.
 *
 * With the SDK type as the contract, an OpenAI-compatible backend forwards the
 * object it was given, and a backend on another protocol reads the fields its
 * protocol can carry. There is no third spelling.
 *
 * `ChatCompletionCreateParamsBase` rather than the `…NonStreaming` variant: the
 * handler needs to read `stream` off the same object it forwards, and the base
 * is the part the two streaming variants share.
 */
export type ChatRequest = ChatCompletionCreateParamsBase;

export type EmbedRequest = EmbeddingCreateParams;

// ---------------------------------------------------------------------------
// Response types — SDK wire types, re-exported
// ---------------------------------------------------------------------------

export type Usage = ChatCompletion['usage'];
export type ChatCompletionChoice = ChatCompletion.Choice;
export type ChatCompletionResponse = ChatCompletion;
export type ResponseObject = Response;
export type ResponsesRequestInput = ResponseInput;

export type EmbeddingData = Embedding;
export type EmbeddingResponse = CreateEmbeddingResponse;

// ---------------------------------------------------------------------------
// Streaming chunk types — SDK wire types
// ---------------------------------------------------------------------------

export type { ChatCompletionChunk } from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// OpenAI Responses API types — SDK wire types
// ---------------------------------------------------------------------------

export type {
  ResponseReasoningItem as ResponsesReasoningOutput,
  ResponseOutputMessage as ResponsesMessageOutput,
  ResponseFunctionToolCall as ResponsesFunctionCallOutput,
  ResponseFunctionToolCallOutputItem as ResponsesFunctionCallResult,
  ResponseUsage as ResponsesUsage,
} from 'openai/resources/responses/responses';

// SDK Responses stream events (SSE) — emitted by responsesStreaming().
export type { ResponseStreamEvent as ResponsesStreamEvent } from 'openai/resources/responses/responses';
export type ResponsesStreamingFn = (
  config: BackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
) => AsyncGenerator<import('openai/resources/responses/responses').ResponseStreamEvent, void, unknown>;

// ---------------------------------------------------------------------------
// Backend message part types (mimocode session API)
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text';
  text: string;
}

export interface FilePart {
  type: 'file';
  mime: string;
  url: string;
}

export type MessagePart = TextPart | FilePart;

// ---------------------------------------------------------------------------
// Backend model info — full SDK Model shape plus unibridge extensions
// ---------------------------------------------------------------------------

/** Reasoning metadata advertised per model on `GET /v1/models`. */
export interface ModelReasoningInfo {
  /** Whether the model reasons at all. */
  supported: boolean;
  /**
   * The request parameter that selects a level once the model is
   * configurable (`"reasoning_effort"`); `null` when reasoning is fixed.
   */
  parameter: 'reasoning_effort' | null;
  /** Level used when the request omits `reasoning_effort`; `null` if none. */
  default: string | null;
  /** Exact set of accepted `reasoning_effort` values, in preference order. */
  levels: string[];
}

export interface ModelCapabilitiesInfo {
  reasoning: boolean;
  tool_calls: boolean;
  attachments: boolean;
  /**
   * Whether unibridge can carry the parameter all the way to the provider.
   *
   * `false` is a hard no: the request carries the parameter, the gateway
   * accepts it, and there is no path that delivers it — the only signal a
   * caller can act on before the fact. `true` means the parameter is delivered
   * to the provider's request; whether the model then behaves differently is
   * the provider's own business and is not something unibridge can verify from
   * the outside. It used to be `false` everywhere, copied from the opencode
   * session protocol having no field for either — true of the protocol, and
   * true of nothing else, since a variant's `body` reaches the provider.
   */
  temperature: boolean;
  max_tokens: boolean;
}

export type ModelInfo = Model & {
  capabilities?: ModelCapabilitiesInfo;
  reasoning?: ModelReasoningInfo;
};

// ---------------------------------------------------------------------------
// Backend context type
// ---------------------------------------------------------------------------

export interface BaseBackendContext {
  baseUrl: string;
  models: string[];
  dispatcher: object | undefined;
  timeout: number;
  /**
   * Set by a backend whose model discovery returned nothing because the
   * upstream server is still warming up. The registry re-runs init while it
   * is set.
   */
  discoveryPending?: boolean;
}

// ---------------------------------------------------------------------------
// Backend streaming type
// ---------------------------------------------------------------------------

export type CompleteStreamingFn = (config: BackendConfig, request: ChatRequest, ctx: BaseBackendContext | null) => AsyncGenerator<ChatCompletionChunk, void, unknown>;

// ---------------------------------------------------------------------------
// Responses API request type
// ---------------------------------------------------------------------------

/**
 * The SDK's Responses request, for the same reason as {@link ChatRequest}: one
 * spelling, straight from the client, so a field cannot be dropped between the
 * wire and the backend.
 */
export type ResponsesRequest = ResponseCreateParamsBase;

export type ResponsesFn = (
  config: BackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
) => Promise<ResponseObject>;
