/**
 * Running an evaluation case.
 *
 * A run captures everything needed to diagnose a failure later without
 * re-running it: the preset hash, the transcript, every operation, the diff,
 * validation output and the model's explanation. That record is what turns an
 * observed failure into a regression test, which is the point of the harness.
 */

import { createHash } from 'node:crypto';
import { HelixPreset } from '@bender/helix';
import { ToneSession, ToolExecutor } from '@bender/tone-tools';
import type { ModelProvider } from '../../apps/server/src/model/provider.js';
import { runAgentTurn } from '../../apps/server/src/agent/loop.js';
import { createLogger } from '../../apps/server/src/observability.js';
import { evaluate, passed, type Check, type RunObservations } from './assert.js';
import { readFixture, type EvalCase } from './case.js';

export interface ToolRecord {
  name: string;
  arguments: string;
  ok: boolean;
  /** Truncated: full tool output is often large and rarely needed in a report. */
  output: string;
  durationMs: number;
  error?: string;
}

export interface RunResult {
  caseId: string;
  /**
   * Identifies the invocation this result came from, shared by every case in
   * it. Feedback is recorded against a run, so without this there is no way to
   * say "that run of tapping-sustain sounded wrong" after the fact.
   */
  runId: string;
  request: string;
  startedAt: string;
  durationMs: number;

  fixture: string;
  /** SHA-256 of the input preset, so a changed fixture is never mistaken for a changed model. */
  fixtureSha256: string;

  parser: {
    ok: boolean;
    presetName?: string;
    device?: string;
    firmware?: string;
    blockCount?: number;
    warnings: string[];
    error?: string;
  };

  model: {
    provider: string;
    requestIds: string[];
    iterations: number;
    truncated: boolean;
    usage: Record<string, number | undefined>;
    latencyMs: number;
  };

  transcript: ToolRecord[];
  diff: RunObservations['diff'];
  reply: string;

  output: {
    roundTripStable: boolean;
    differsFromInput: boolean;
    /** Serialized result, kept only when the case failed. */
    preset?: string;
  };

  checks: Check[];
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

export interface RunOptions {
  provider: ModelProvider;
  /** Shared across every case in one invocation. See RunResult.runId. */
  runId?: string;
  maxIterations?: number;
  /** Keep the generated preset in the result. Defaults to on for failures only. */
  keepPreset?: boolean;
  verbose?: boolean;
}

/**
 * A short, sortable id for one invocation of the harness.
 *
 * Timestamp first so runs sort chronologically in a directory listing, with a
 * random tail because two runs started in the same second must not collide.
 */
export function newRunId(now = new Date()): string {
  // YYMMDDHHMMSS from the ISO string, which is already zero-padded and UTC.
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncate(text: string, limit = 800): string {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

export async function runCase(evalCase: EvalCase, options: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const fixture = readFixture(evalCase);

  const base: RunResult = {
    caseId: evalCase.id,
    runId: options.runId ?? newRunId(),
    request: evalCase.request,
    startedAt,
    durationMs: 0,
    fixture: evalCase.fixture,
    fixtureSha256: sha256(fixture),
    parser: { ok: false, warnings: [] },
    model: {
      provider: options.provider.description,
      requestIds: [],
      iterations: 0,
      truncated: false,
      usage: {},
      latencyMs: 0,
    },
    transcript: [],
    diff: [],
    reply: '',
    output: { roundTripStable: false, differsFromInput: false },
    checks: [],
    passed: false,
  };

  if (evalCase.skip) {
    return { ...base, skipped: true, skipReason: evalCase.skipReason, passed: true };
  }

  // --- parse ----------------------------------------------------------------
  const opened = ToneSession.open(fixture);
  if ('error' in opened) {
    // A parser failure is recorded as a parser failure rather than a model
    // failure. Conflating them sends the next person to the wrong place.
    const observations: RunObservations = {
      diff: [],
      toolsCalled: [],
      failedToolCalls: [],
      reply: '',
      roundTripStable: false,
      outputDiffersFromInput: false,
      error: opened.error.message,
    };
    const checks = evaluate(evalCase, observations);

    return {
      ...base,
      durationMs: Date.now() - started,
      parser: { ok: false, warnings: [], error: opened.error.message },
      checks,
      passed: passed(checks),
      error: opened.error.message,
    };
  }

  const { session, warnings } = opened;
  const summary = session.preset.summary();
  base.parser = {
    ok: true,
    presetName: summary.name,
    device: summary.deviceName,
    firmware: summary.firmware,
    blockCount: session.preset.blocks().length,
    warnings,
  };

  // --- run the model --------------------------------------------------------
  let reply = '';
  let transcript: ToolRecord[] = [];
  let runError: string | undefined;

  try {
    const result = await runAgentTurn(
      options.provider,
      { session, executor: new ToolExecutor(session), message: evalCase.request, history: [] },
      {
        maxIterations: options.maxIterations ?? 12,
        logger: createLogger(options.verbose ? 'info' : 'error'),
      },
    );

    reply = result.reply;
    transcript = result.toolCalls.map((call) => ({
      name: call.name,
      arguments: '',
      ok: call.ok,
      output: truncate(call.output),
      durationMs: call.durationMs,
      error: call.result.ok ? undefined : call.result.error.message,
    }));

    base.model = {
      provider: options.provider.description,
      requestIds: result.modelRequestIds,
      iterations: result.iterations,
      truncated: result.truncated,
      usage: result.usage as Record<string, number | undefined>,
      latencyMs: result.totalLatencyMs,
    };
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  // --- observe --------------------------------------------------------------
  const output = session.serialize();
  let roundTripStable: boolean;
  try {
    roundTripStable = HelixPreset.parse(output).serialize() === output;
  } catch {
    roundTripStable = false;
  }

  const observations: RunObservations = {
    diff: session.diff(),
    toolsCalled: transcript.map((t) => t.name),
    failedToolCalls: transcript.filter((t) => !t.ok).map((t) => `${t.name}: ${t.error ?? ''}`),
    reply,
    roundTripStable,
    outputDiffersFromInput: output !== fixture,
    error: runError,
  };

  const checks = evaluate(evalCase, observations);
  const ok = passed(checks);

  return {
    ...base,
    durationMs: Date.now() - started,
    transcript,
    diff: observations.diff,
    reply,
    output: {
      roundTripStable,
      differsFromInput: observations.outputDiffersFromInput,
      // Only kept on failure: a passing run's preset is reproducible from the
      // fixture hash and the transcript, and results should stay readable.
      preset: options.keepPreset || !ok ? output : undefined,
    },
    checks,
    passed: ok,
    error: runError,
  };
}
