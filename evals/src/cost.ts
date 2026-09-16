/**
 * What a run cost.
 *
 * The harness exists to make the agent better *and* cheaper, and the second
 * half of that is unmeasurable without this. A run that passes every check by
 * calling ten tools and burning 40k tokens is not a good run, and nothing in
 * the pass/fail report would ever tell you.
 *
 * Prices are read from the environment rather than hardcoded. Azure OpenAI
 * pricing varies by model, region and deployment type, and a table baked into
 * this repo would be wrong within a month and wrong silently. With no prices
 * configured the harness still reports tokens, iterations and tool calls,
 * which is most of the signal; the dollar figure is a convenience on top.
 */

import type { RunResult } from './run.js';

/** Per-million-token prices, as they appear on the Azure pricing page. */
export interface Prices {
  input?: number;
  output?: number;
  currency: string;
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  /**
   * A *subset* of outputTokens, not an addition to them. The Responses API
   * counts reasoning inside output tokens, so adding it to the bill again
   * would roughly double the cost of a reasoning model.
   */
  reasoningTokens: number;
  totalTokens: number;
  /** Undefined when no prices are configured. */
  amount?: number;
  currency: string;
}

export interface RunEfficiency {
  caseId: string;
  cost: Cost;
  iterations: number;
  toolCalls: number;
  /** Tool calls that errored. Pure waste: paid for, produced nothing. */
  failedToolCalls: number;
  edits: number;
  durationMs: number;
  passed: boolean;
}

export interface CostSummary {
  cases: number;
  cost: Cost;
  iterations: number;
  toolCalls: number;
  failedToolCalls: number;
  edits: number;
  /** Tokens per edit actually landed. The number to drive down. */
  tokensPerEdit?: number;
  /** Sorted by token spend, most expensive first. */
  perCase: RunEfficiency[];
}

export function loadPrices(env: NodeJS.ProcessEnv = process.env): Prices {
  const number = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };

  return {
    input: number(env.BENDER_PRICE_INPUT_PER_1M),
    output: number(env.BENDER_PRICE_OUTPUT_PER_1M),
    currency: env.BENDER_PRICE_CURRENCY?.trim() || 'USD',
  };
}

export function costOf(
  usage: Record<string, number | undefined>,
  prices: Prices = loadPrices(),
): Cost {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

  const priced = prices.input !== undefined || prices.output !== undefined;
  const amount = priced
    ? (inputTokens * (prices.input ?? 0) + outputTokens * (prices.output ?? 0)) / 1_000_000
    : undefined;

  return { inputTokens, outputTokens, reasoningTokens, totalTokens, amount, currency: prices.currency };
}

export function efficiencyOf(result: RunResult, prices: Prices = loadPrices()): RunEfficiency {
  return {
    caseId: result.caseId,
    cost: costOf(result.model.usage, prices),
    iterations: result.model.iterations,
    toolCalls: result.transcript.length,
    failedToolCalls: result.transcript.filter((call) => !call.ok).length,
    edits: result.diff.length,
    durationMs: result.durationMs,
    passed: result.passed,
  };
}

export function summarizeCost(
  results: readonly RunResult[],
  prices: Prices = loadPrices(),
): CostSummary {
  // Skipped cases never reached a model, so counting them would dilute every
  // average with zeros.
  const perCase = results.filter((result) => !result.skipped).map((r) => efficiencyOf(r, prices));

  const sum = (pick: (run: RunEfficiency) => number): number =>
    perCase.reduce((total, run) => total + pick(run), 0);

  const amounts = perCase.map((run) => run.cost.amount).filter((a): a is number => a !== undefined);
  const edits = sum((run) => run.edits);
  const totalTokens = sum((run) => run.cost.totalTokens);

  return {
    cases: perCase.length,
    cost: {
      inputTokens: sum((run) => run.cost.inputTokens),
      outputTokens: sum((run) => run.cost.outputTokens),
      reasoningTokens: sum((run) => run.cost.reasoningTokens),
      totalTokens,
      amount: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : undefined,
      currency: prices.currency,
    },
    iterations: sum((run) => run.iterations),
    toolCalls: sum((run) => run.toolCalls),
    failedToolCalls: sum((run) => run.failedToolCalls),
    edits,
    tokensPerEdit: edits > 0 ? Math.round(totalTokens / edits) : undefined,
    perCase: [...perCase].sort((a, b) => b.cost.totalTokens - a.cost.totalTokens),
  };
}

/** Compact token count: 1234 -> "1.2k". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}

export function formatAmount(cost: Pick<Cost, 'amount' | 'currency'>): string | undefined {
  if (cost.amount === undefined) return undefined;
  // Sub-cent runs are the normal case for a small preset edit, so two decimal
  // places would print "$0.00" for everything and look broken.
  const digits = cost.amount > 0 && cost.amount < 0.01 ? 4 : 2;
  return `${cost.amount.toFixed(digits)} ${cost.currency}`;
}
