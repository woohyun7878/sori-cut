/**
 * Reporting and result persistence.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './case.js';
import {
  formatAmount,
  formatTokens,
  loadPrices,
  summarizeCost,
  type CostSummary,
} from './cost.js';
import type { RunResult } from './run.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function out(text: string): void {
  process.stdout.write(text);
}

export function printResult(result: RunResult, verbose: boolean): void {
  if (result.skipped) {
    out(`${DIM}skip${RESET}  ${result.caseId}${result.skipReason ? ` — ${result.skipReason}` : ''}\n`);
    return;
  }

  const mark = result.passed ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`;
  const failures = result.checks.filter((check) => !check.passed).length;
  const tokens = result.model.usage.totalTokens;
  out(
    `${mark}  ${result.caseId}  ${DIM}${result.durationMs}ms, ${result.diff.length} edit(s), ` +
      `${result.transcript.length} tool call(s)` +
      `${tokens ? `, ${formatTokens(tokens)} tokens` : ''}${RESET}\n`,
  );

  for (const check of result.checks) {
    if (check.passed && !verbose) continue;
    const icon = check.passed ? `${GREEN}·${RESET}` : `${RED}×${RESET}`;
    out(`        ${icon} ${check.name}: ${check.detail}\n`);
  }

  if (verbose || !result.passed) {
    if (result.diff.length > 0) {
      out(`        ${DIM}changes:${RESET}\n`);
      for (const change of result.diff) {
        out(
          `          ${change.dsp}/${change.slot} ${change.parameter}: ` +
            `${String(change.before)} -> ${String(change.after)}\n`,
        );
      }
    }
    if (result.reply) out(`        ${DIM}reply: ${result.reply.replace(/\n/g, ' ')}${RESET}\n`);
    if (result.error) out(`        ${RED}error: ${result.error}${RESET}\n`);
  }

  if (failures > 0 && !verbose) out('\n');
}

export function printSummary(results: RunResult[]): void {
  const ran = results.filter((r) => !r.skipped);
  const passedCount = ran.filter((r) => r.passed).length;
  const skipped = results.length - ran.length;

  out(`\n${BOLD}${passedCount}/${ran.length} passed${RESET}`);
  if (skipped > 0) out(`, ${skipped} skipped`);

  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  out(` ${DIM}(${(totalMs / 1000).toFixed(1)}s)${RESET}\n`);

  printCost(summarizeCost(results));

  const failures = ran.filter((r) => !r.passed);
  if (failures.length > 0) {
    out(`\n${RED}Failing cases:${RESET} ${failures.map((f) => f.caseId).join(', ')}\n`);
  }
}

/**
 * What the run cost, printed next to whether it worked.
 *
 * Deliberately shown on every run rather than behind a flag. Cost is only ever
 * controlled by people who can see it, and a number you have to ask for is a
 * number nobody looks at.
 */
export function printCost(summary: CostSummary): void {
  if (summary.cases === 0 || summary.cost.totalTokens === 0) return;

  const parts = [
    `${formatTokens(summary.cost.totalTokens)} tokens`,
    `${formatTokens(summary.cost.inputTokens)} in`,
    `${formatTokens(summary.cost.outputTokens)} out`,
  ];
  if (summary.cost.reasoningTokens > 0) {
    // Called out separately because it is a subset of output tokens, and
    // because it is usually where a surprising bill comes from.
    parts.push(`${formatTokens(summary.cost.reasoningTokens)} reasoning`);
  }

  const amount = formatAmount(summary.cost);
  out(`${DIM}${parts.join(', ')}${amount ? ` — ${amount}` : ''}${RESET}\n`);

  const perRun = [
    `${summary.iterations} model turn(s)`,
    `${summary.toolCalls} tool call(s)`,
    `${summary.edits} edit(s)`,
  ];
  if (summary.failedToolCalls > 0) perRun.push(`${RED}${summary.failedToolCalls} failed${DIM}`);
  if (summary.tokensPerEdit !== undefined) {
    perRun.push(`${formatTokens(summary.tokensPerEdit)} tokens/edit`);
  }
  out(`${DIM}${perRun.join(', ')}${RESET}\n`);

  if (amount === undefined) {
    out(
      `${DIM}Set BENDER_PRICE_INPUT_PER_1M and BENDER_PRICE_OUTPUT_PER_1M for a cost estimate.${RESET}\n`,
    );
  }

  const worst = summary.perCase[0];
  if (summary.cases > 1 && worst && worst.cost.totalTokens > 0) {
    out(`${DIM}Most expensive: ${worst.caseId} (${formatTokens(worst.cost.totalTokens)})${RESET}\n`);
  }
}

/**
 * Write results to disk.
 *
 * Every run is written, not just failing ones. Feedback is recorded against a
 * run id after the fact -- typically after playing the preset -- and a run with
 * no file to attach to is feedback that cannot be given. Results are
 * gitignored, so this costs nothing but disk.
 *
 * Filenames carry the run id, which is timestamped, so successive runs
 * accumulate rather than overwrite. Comparing two runs of the same case is how
 * you tell whether a prompt change helped.
 */
export function writeResults(results: RunResult[], label = 'run'): string {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const runId = results[0]?.runId;
  const stamp = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${stamp}-${label}.json`);

  writeFileSync(
    path,
    `${JSON.stringify(
      {
        runId,
        runAt: new Date().toISOString(),
        total: results.length,
        passed: results.filter((r) => r.passed && !r.skipped).length,
        skipped: results.filter((r) => r.skipped).length,
        cost: summarizeCost(results, loadPrices()),
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return path;
}
