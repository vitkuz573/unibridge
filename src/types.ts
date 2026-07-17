import type { BackendConfig } from './config.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  public status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface MessageContentText {
  type: 'text';
  text: string;
}

export interface MessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

export type MessageContent = MessageContentText | MessageContentImage;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContent[];
  name?: string;
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface ChatRequest {
  messages: Message[];
  model: string;
  maxTokens?: number;
  minTokens?: number;
  temperature?: number;
  response_format?: { type?: string };
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface EmbedRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
    reasoning?: string;
  };
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
}

export interface EmbeddingData {
  object: string;
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: string;
  data: EmbeddingData[];
  model: string;
  usage: Usage;
}

// ---------------------------------------------------------------------------
// Streaming chunk types
// ---------------------------------------------------------------------------

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API types
// ---------------------------------------------------------------------------

export interface ResponsesReasoningOutput {
  id: string;
  type: 'reasoning';
  summary: Array<{ type: 'summary_text'; text: string }>;
}

export interface ResponsesMessageOutput {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string }>;
}

export interface ResponseObject {
  id: string;
  object: 'response';
  created: number;
  model: string;
  output: Array<ResponsesReasoningOutput | ResponsesMessageOutput>;
  usage: Usage;
}

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
// Backend model info
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  object: string;
}

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
  model: string;
  input: unknown;
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  instructions?: string;
}

export type ResponsesFn = (
  config: BackendConfig,
  request: ResponsesRequest,
  ctx: BaseBackendContext | null,
) => Promise<ResponseObject>;
