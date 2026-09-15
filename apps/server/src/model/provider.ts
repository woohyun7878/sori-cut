/**
 * The boundary between Bender and whatever model is behind it.
 *
 * Everything above this file is written against these types, so swapping
 * Azure OpenAI for another provider means writing one new implementation and
 * changing one line of wiring.
 */

/** A tool the model may call, in provider-neutral form. */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelTextMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ModelToolCallMessage {
  type: 'tool_call';
  callId: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
}

export interface ModelToolResultMessage {
  type: 'tool_result';
  callId: string;
  output: string;
}

export type ModelMessage = ModelTextMessage | ModelToolCallMessage | ModelToolResultMessage;

export interface ModelRequest {
  instructions: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  /**
   * Provider-side conversation id from the previous turn. Providers that can
   * continue a conversation server-side may use it; others ignore it.
   */
  previousResponseId?: string;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  /** Provider request id. Worth logging: it is what support can trace. */
  id?: string;
  /** Assistant prose, empty when the model only called tools. */
  text: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
  usage?: ModelUsage;
  /** True when the model stopped early, e.g. hitting a token ceiling. */
  incomplete?: boolean;
  incompleteReason?: string;
  latencyMs: number;
}

export type ModelErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'content_filter'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'unknown';

/**
 * A model failure translated into something the caller can act on.
 *
 * The distinction that matters is `retryable`: a rate limit is worth retrying,
 * a disabled authentication type is not, and treating them the same either
 * wastes a minute or gives up too early.
 */
export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      /** Guidance aimed at whoever is running the server. */
      hint?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ModelError';
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get hint(): string | undefined {
    return this.options.hint;
  }
}

export interface ModelProvider {
  /** Identifies the provider and deployment in logs. */
  readonly description: string;
  respond(request: ModelRequest): Promise<ModelResponse>;
}
