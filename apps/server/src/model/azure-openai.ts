/**
 * Azure OpenAI Responses API provider.
 *
 * Uses the official SDK's AzureOpenAI client so that retries, timeouts and
 * the api-version handshake are not reimplemented here.
 */

import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import type { AzureConfig } from '../config.js';
import {
  ModelError,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelToolSpec,
} from './provider.js';

/** Shape of one entry in the Responses API `input` array. */
type ResponseInputItem =
  | { role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export class AzureOpenAIProvider implements ModelProvider {
  private readonly client: AzureOpenAI;
  readonly description: string;

  constructor(private readonly config: AzureConfig) {
    const common = {
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
      deployment: config.deployment,
    };

    if (config.authMode === 'api-key') {
      if (!config.apiKey) throw new ModelError('auth', 'API key auth selected but no key supplied.');
      this.client = new AzureOpenAI({ ...common, apiKey: config.apiKey });
    } else {
      // DefaultAzureCredential picks up az login, managed identity, env vars
      // and workload identity, so the same code works locally and deployed.
      this.client = new AzureOpenAI({
        ...common,
        azureADTokenProvider: getBearerTokenProvider(new DefaultAzureCredential(), config.scope),
      });
    }

    this.description = `azure-openai:${config.deployment}`;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const started = Date.now();

    let raw: Record<string, unknown>;
    try {
      raw = (await this.client.responses.create(
        {
          model: this.config.deployment,
          instructions: request.instructions,
          input: toResponsesInput(request.messages),
          tools: toResponsesTools(request.tools),
          ...(request.previousResponseId
            ? { previous_response_id: request.previousResponseId }
            : {}),
        },
        request.signal ? { signal: request.signal } : {},
      )) as unknown as Record<string, unknown>;
    } catch (error) {
      throw translateError(error, this.config);
    }

    return readResponse(raw, Date.now() - started);
  }
}

/**
 * Flatten conversation history into the Responses API `input` array.
 *
 * Tool calls and their results are siblings at the top level rather than
 * nested inside an assistant message, which is the part that most often trips
 * people up when moving from Chat Completions.
 */
export function toResponsesInput(messages: ModelMessage[]): ResponseInputItem[] {
  return messages.map((message) => {
    switch (message.type) {
      case 'message':
        return { role: message.role, content: message.content };
      case 'tool_call':
        return {
          type: 'function_call' as const,
          call_id: message.callId,
          name: message.name,
          arguments: message.arguments,
        };
      case 'tool_result':
        return {
          type: 'function_call_output' as const,
          call_id: message.callId,
          output: message.output,
        };
    }
  });
}

/**
 * Tools are sent with `strict: false` on purpose.
 *
 * Strict mode would have the provider reject malformed arguments for us, but
 * it also constrains what the schema may express, and more importantly it
 * turns a recoverable mistake into an opaque provider-side failure. Bender's
 * own validation produces errors that name the offending argument and list
 * the valid alternatives, which is what actually gets a model back on track.
 */
export function toResponsesTools(tools: ModelToolSpec[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

/** Pull the pieces we care about out of a Responses API payload. */
export function readResponse(raw: Record<string, unknown>, latencyMs: number): ModelResponse {
  const output = Array.isArray(raw.output) ? (raw.output as Record<string, unknown>[]) : [];
  const textParts: string[] = [];
  const toolCalls: ModelResponse['toolCalls'] = [];

  for (const item of output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        callId: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      });
      continue;
    }

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Record<string, unknown>[]) {
        if (typeof part.text === 'string') textParts.push(part.text);
      }
    }
    // `reasoning` items are deliberately dropped. Exposing raw chain-of-thought
    // is not something the UI should be doing.
  }

  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const incomplete = (raw.incomplete_details ?? null) as Record<string, unknown> | null;

  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    text: textParts.join('\n').trim(),
    toolCalls,
    usage: {
      inputTokens: numberOrUndefined(usage.input_tokens),
      outputTokens: numberOrUndefined(usage.output_tokens),
      reasoningTokens: numberOrUndefined(details.reasoning_tokens),
      totalTokens: numberOrUndefined(usage.total_tokens),
    },
    incomplete: raw.status === 'incomplete' || incomplete !== null,
    incompleteReason: incomplete && typeof incomplete.reason === 'string' ? incomplete.reason : undefined,
    latencyMs,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Turn an SDK error into a ModelError carrying an actionable hint.
 *
 * The two hints worth spelling out are the ones this project actually hit:
 * a 403 because key authentication is switched off at the resource, and a 404
 * because a model name was passed where a deployment name was expected.
 */
export function translateError(error: unknown, config: AzureConfig): ModelError {
  if (error instanceof ModelError) return error;

  const err = error as {
    status?: number;
    message?: string;
    code?: string;
    name?: string;
    error?: { code?: string; message?: string };
  };
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const code = err?.error?.code ?? err?.code;
  const message = err?.error?.message ?? err?.message ?? String(error);

  if (err?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return new ModelError('timeout', 'The model request timed out.', {
      retryable: true,
      cause: error,
    });
  }

  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return new ModelError('network', `Could not reach ${config.endpoint}.`, {
      retryable: true,
      hint: 'Check network access and AZURE_OPENAI_ENDPOINT.',
      cause: error,
    });
  }

  if (status === 401 || status === 403) {
    const keyDisabled = /AuthenticationTypeDisabled/i.test(message);
    return new ModelError('auth', `Azure OpenAI rejected the credentials: ${message}`, {
      status,
      hint: keyDisabled
        ? 'This resource has key authentication disabled. Unset AZURE_OPENAI_API_KEY to use Entra ID, ' +
          'run `az login`, and make sure the signed-in identity has the Cognitive Services OpenAI User role.'
        : config.authMode === 'entra'
          ? 'Run `az login` and confirm the identity has the Cognitive Services OpenAI User role on the resource.'
          : 'Check AZURE_OPENAI_API_KEY.',
      cause: error,
    });
  }

  if (status === 404) {
    return new ModelError('not_found', `Deployment "${config.deployment}" was not found.`, {
      status,
      hint: 'AZURE_OPENAI_DEPLOYMENT must be the deployment name from your Azure resource, not a model name.',
      cause: error,
    });
  }

  if (status === 429) {
    return new ModelError('rate_limit', 'Azure OpenAI rate limit reached.', {
      status,
      retryable: true,
      cause: error,
    });
  }

  if (code === 'content_filter' || /content management policy|ResponsibleAI/i.test(message)) {
    return new ModelError('content_filter', 'The request was blocked by a content filter.', {
      status,
      cause: error,
    });
  }

  if (status !== undefined && status >= 500) {
    return new ModelError('server', `Azure OpenAI returned ${status}: ${message}`, {
      status,
      retryable: true,
      cause: error,
    });
  }

  if (status !== undefined && status >= 400) {
    return new ModelError('bad_request', `Azure OpenAI rejected the request: ${message}`, {
      status,
      cause: error,
    });
  }

  return new ModelError('unknown', message, { status, cause: error });
}
