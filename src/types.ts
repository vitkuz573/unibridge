import type { BackendConfig } from './config.js';
// OpenAI SDK is the single source of truth for the wire contract.
// Wire-facing types are re-exported from the SDK; only unibridge-internal
// shapes (backend contexts, orchestrator requests) are defined here.
import type {
  ChatCompletion,
  ChatCompletionChunk,
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

export interface ResponsesTextFormat {
  format?: ResponseFormat;
}

// ---------------------------------------------------------------------------
// Tool calling types — SDK wire types, re-exported
// ---------------------------------------------------------------------------

export type ToolDefinition = ChatCompletionTool;
export type ToolChoice = ChatCompletionToolChoiceOption;

export interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  minTokens?: number;
  temperature?: number;
  response_format?: ResponseFormat;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
}

export type EmbedRequestInput = EmbeddingCreateParams['input'];

export type EmbedRequest = Pick<EmbeddingCreateParams, 'model' | 'input'> &
  Pick<Partial<EmbeddingCreateParams>, 'encoding_format'>;

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
// Backend message part types (opencode/mimocode session API)
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
// Backend model info — full SDK Model shape
// ---------------------------------------------------------------------------

export type ModelInfo = Model;

// ---------------------------------------------------------------------------
// Backend context type
// ---------------------------------------------------------------------------

export interface BaseBackendContext {
  baseUrl: string;
  models: string[];
  dispatcher: object | undefined;
  timeout: number;
}

// ---------------------------------------------------------------------------
// Backend streaming type
// ---------------------------------------------------------------------------

export type CompleteStreamingFn = (config: BackendConfig, request: ChatRequest, ctx: BaseBackendContext | null) => AsyncGenerator<ChatCompletionChunk, void, unknown>;

// ---------------------------------------------------------------------------
// Responses API request type
// ---------------------------------------------------------------------------

export interface ResponsesRequest {
  model?: string;
  input: unknown;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  instructions?: string;
  tools?: ChatRequest['tools'];
  tool_choice?: ChatRequest['tool_choice'];
  text?: ResponsesTextFormat;
}

export type ResponsesFn = (
  config: BackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
) => Promise<ResponseObject>;
