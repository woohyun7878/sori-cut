import { describe, expect, it } from 'vitest';
import { costOf, formatAmount, formatTokens, loadPrices, summarizeCost } from '../src/cost.js';
import type { RunResult } from '../src/run.js';

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: 'case',
    runId: '260101120000-test',
    request: 'more sustain',
    startedAt: new Date().toISOString(),
    durationMs: 100,
    fixture: 'fixture.hlx',
    fixtureSha256: 'abc',
    parser: { ok: true, warnings: [] },
    model: {
      provider: 'test',
      requestIds: [],
      iterations: 2,
      truncated: false,
      usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 150, totalTokens: 1200 },
      latencyMs: 100,
    },
    transcript: [],
    diff: [],
    reply: '',
    output: { roundTripStable: true, differsFromInput: false },
    checks: [],
    passed: true,
    ...overrides,
  };
}

describe('prices', () => {
  it('reads per-million prices from the environment', () => {
    const prices = loadPrices({
      BENDER_PRICE_INPUT_PER_1M: '0.15',
      BENDER_PRICE_OUTPUT_PER_1M: '0.60',
    } as NodeJS.ProcessEnv);

    expect(prices).toEqual({ input: 0.15, output: 0.6, currency: 'USD' });
  });

  it('ignores values that are not usable prices', () => {
    const prices = loadPrices({
      BENDER_PRICE_INPUT_PER_1M: 'free',
      BENDER_PRICE_OUTPUT_PER_1M: '-1',
    } as NodeJS.ProcessEnv);

    expect(prices.input).toBeUndefined();
    expect(prices.output).toBeUndefined();
  });
});

describe('costOf', () => {
  it('reports tokens without prices configured', () => {
    const cost = costOf(runResult().model.usage, { currency: 'USD' });

    expect(cost.totalTokens).toBe(1200);
    expect(cost.amount).toBeUndefined();
  });

  it('bills reasoning tokens once, as part of output', () => {
    // The Responses API counts reasoning inside output tokens. Adding it again
    // would inflate every reasoning-model estimate.
    const cost = costOf(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 900_000 },
      { input: 1, output: 2, currency: 'USD' },
    );

    expect(cost.amount).toBeCloseTo(3, 10);
  });

  it('falls back to input + output when no total is reported', () => {
    const cost = costOf({ inputTokens: 10, outputTokens: 5 }, { currency: 'USD' });
    expect(cost.totalTokens).toBe(15);
  });

  it('treats missing usage as zero rather than failing', () => {
    expect(costOf({}, { currency: 'USD' }).totalTokens).toBe(0);
  });
});

describe('summarizeCost', () => {
  it('excludes skipped cases, which never reached a model', () => {
    const summary = summarizeCost([
      runResult(),
      runResult({ caseId: 'skipped', skipped: true, model: { ...runResult().model, usage: {} } }),
    ]);

    expect(summary.cases).toBe(1);
    expect(summary.cost.totalTokens).toBe(1200);
  });

  it('measures tokens per landed edit', () => {
    const summary = summarizeCost([
      runResult({
        diff: [
          {
            dsp: 'dsp0',
            slot: 'block0',
            label: 'Amp',
            parameter: 'Drive',
            before: 0.5,
            after: 0.6,
          },
          {
            dsp: 'dsp0',
            slot: 'block0',
            label: 'Amp',
            parameter: 'Bass',
            before: 0.5,
            after: 0.6,
          },
        ],
      }),
    ]);

    expect(summary.edits).toBe(2);
    expect(summary.tokensPerEdit).toBe(600);
  });

  it('leaves tokens per edit undefined when nothing changed', () => {
    expect(summarizeCost([runResult()]).tokensPerEdit).toBeUndefined();
  });

  it('counts failed tool calls, which are paid for and produce nothing', () => {
    const summary = summarizeCost([
      runResult({
        transcript: [
          { name: 'inspect', arguments: '', ok: true, output: '', durationMs: 1 },
          { name: 'set', arguments: '', ok: false, output: '', durationMs: 1, error: 'nope' },
        ],
      }),
    ]);

    expect(summary.toolCalls).toBe(2);
    expect(summary.failedToolCalls).toBe(1);
  });

  it('ranks the most expensive case first', () => {
    const cheap = runResult({ caseId: 'cheap', model: { ...runResult().model, usage: { totalTokens: 10 } } });
    const dear = runResult({ caseId: 'dear', model: { ...runResult().model, usage: { totalTokens: 90 } } });

    expect(summarizeCost([cheap, dear]).perCase[0]?.caseId).toBe('dear');
  });
});

describe('formatting', () => {
  it('abbreviates thousands', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1200)).toBe('1.2k');
  });

  it('shows enough decimals for a sub-cent run', () => {
    expect(formatAmount({ amount: 0.0032, currency: 'USD' })).toBe('0.0032 USD');
    expect(formatAmount({ amount: 1.5, currency: 'USD' })).toBe('1.50 USD');
    expect(formatAmount({ amount: undefined, currency: 'USD' })).toBeUndefined();
  });
});
