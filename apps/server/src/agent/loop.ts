/**
 * The model/tool loop.
 *
 * One user message can take several model turns: inspect, reason, edit,
 * verify, explain. This runs that loop until the model stops calling tools,
 * with a hard ceiling so a confused model cannot spin forever.
 */

import type { ToolCallOutcome, ToolExecutor, ToneSession } from '@bender/tone-tools';
import {
  ModelError,
  type ModelMessage,
  type ModelProvider,
  type ModelUsage,
} from '../model/provider.js';
import { buildInstructions } from './system-prompt.js';
import type { Logger } from '../observability.js';

export interface AgentTurnRequest {
  session: ToneSession;
  executor: ToolExecutor;
  /** The user's natural-language request. */
  message: string;
  /** Conversation so far, excluding this message. Mutated as the turn runs. */
  history: ModelMessage[];
  signal?: AbortSignal;
}

/** One entry in the activity feed the UI shows while Bender works. */
export interface ActivityEvent {
  kind: 'model' | 'tool';
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export interface AgentTurnResult {
  /** Bender's prose reply. */
  reply: string;
  activity: ActivityEvent[];
  toolCalls: ToolCallOutcome[];
  modelRequestIds: string[];
  iterations: number;
  usage: ModelUsage;
  totalLatencyMs: number;
  /** Set when the loop hit its ceiling rather than the model finishing. */
  truncated: boolean;
}

export interface AgentOptions {
  maxIterations: number;
  logger: Logger;
  /** Attempts per model call, including the first. */
  maxAttempts?: number;
  /** Injectable for tests so retries do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runAgentTurn(
  provider: ModelProvider,
  request: AgentTurnRequest,
  options: AgentOptions,
): Promise<AgentTurnResult> {
  const { session, executor, history } = request;
  const { logger, maxIterations } = options;
  const startedAt = Date.now();

  const activity: ActivityEvent[] = [];
  const toolCalls: ToolCallOutcome[] = [];
  const modelRequestIds: string[] = [];
  const usage: ModelUsage = {};
  const editsAtStart = session.edits.length;

  history.push({ type: 'message', role: 'user', content: request.message });

  let reply = '';
  let iterations = 0;
  let truncated = false;

  while (iterations < maxIterations) {
    iterations += 1;

    const response = await callWithRetry(
      provider,
      {
        // Rebuilt every iteration: tools change the preset, so instructions
        // written before the first edit would describe a preset that no
        // longer exists.
        instructions: buildInstructions({
          presetSummary: session.describe(),
          signalChain: session.describeChain(),
          hasEdits: session.edits.length > 0,
        }),
        messages: history,
        tools: executor.toolSpecs().map((spec) => ({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters as unknown as Record<string, unknown>,
        })),
        signal: request.signal,
      },
      options,
    );

    if (response.id) modelRequestIds.push(response.id);
    accumulate(usage, response.usage);
    activity.push({
      kind: 'model',
      name: 'reasoning',
      ok: true,
      detail:
        response.toolCalls.length > 0
          ? `requested ${response.toolCalls.length} tool call${response.toolCalls.length === 1 ? '' : 's'}`
          : 'composed a reply',
      durationMs: response.latencyMs,
    });
    logger.info('model.response', {
      requestId: response.id,
      iteration: iterations,
      toolCalls: response.toolCalls.map((c) => c.name),
      latencyMs: response.latencyMs,
      incomplete: response.incomplete,
    });

    if (response.text) reply = response.text;

    if (response.toolCalls.length === 0) {
      if (response.incomplete) {
        truncated = true;
        logger.warn('model.incomplete', { reason: response.incompleteReason });
      }
      break;
    }

    // Record the calls before running them. If a tool throws the loop still
    // has a coherent history to send back.
    for (const call of response.toolCalls) {
      history.push({
        type: 'tool_call',
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
    }

    for (const call of response.toolCalls) {
      const outcome = executor.execute({
        id: call.callId,
        name: call.name,
        arguments: call.arguments,
      });

      toolCalls.push(outcome);
      history.push({ type: 'tool_result', callId: call.callId, output: outcome.output });
      activity.push({
        kind: 'tool',
        name: outcome.name,
        ok: outcome.ok,
        detail: outcome.ok
          ? summarizeSuccess(outcome)
          : (outcome.result.ok ? undefined : outcome.result.error.message),
        durationMs: outcome.durationMs,
      });

      logger.info('tool.call', {
        tool: outcome.name,
        ok: outcome.ok,
        durationMs: outcome.durationMs,
        error: outcome.result.ok ? undefined : outcome.result.error.code,
      });
    }

    if (iterations >= maxIterations) {
      truncated = true;
      logger.warn('agent.truncated', { maxIterations });
    }
  }

  if (!reply) {
    reply = fallbackReply(session.edits.length - editsAtStart, truncated);
  }

  return {
    reply,
    activity,
    toolCalls,
    modelRequestIds,
    iterations,
    usage,
    totalLatencyMs: Date.now() - startedAt,
    truncated,
  };
}

/**
 * Retry only what is worth retrying.
 *
 * Transient failures get exponential backoff; a bad deployment name or a
 * disabled authentication type will fail identically every time, so those are
 * surfaced immediately instead of after three pointless attempts.
 */
async function callWithRetry(
  provider: ModelProvider,
  request: Parameters<ModelProvider['respond']>[0],
  options: AgentOptions,
) {
  const attempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await provider.respond(request);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ModelError && error.retryable;

      if (!retryable || attempt === attempts) break;

      const delay = 400 * 2 ** (attempt - 1);
      options.logger.warn('model.retry', {
        attempt,
        delayMs: delay,
        kind: error instanceof ModelError ? error.kind : 'unknown',
      });
      await sleep(delay);
    }
  }

  throw lastError;
}

function summarizeSuccess(outcome: ToolCallOutcome): string | undefined {
  if (!outcome.result.ok) return undefined;
  const data = outcome.result.data as { summary?: unknown } | null;
  return data && typeof data.summary === 'string' ? data.summary : undefined;
}

/**
 * What to say when the model called tools but never produced prose.
 *
 * Silence after a preset has been modified is the worst possible outcome, so
 * this at least tells the truth about whether anything changed.
 */
function fallbackReply(newEdits: number, truncated: boolean): string {
  if (truncated) {
    return newEdits > 0
      ? `I made ${newEdits} change${newEdits === 1 ? '' : 's'} but ran out of steps before finishing. Check the diff, and ask me to continue if it looks incomplete.`
      : 'I ran out of steps before I could finish working on that. Try narrowing the request.';
  }
  return newEdits > 0
    ? `I made ${newEdits} change${newEdits === 1 ? '' : 's'} to the preset. The diff shows exactly what moved.`
    : 'I looked at the preset but did not change anything.';
}

function accumulate(total: ModelUsage, next: ModelUsage | undefined): void {
  if (!next) return;
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const) {
    const value = next[key];
    if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
  }
}
