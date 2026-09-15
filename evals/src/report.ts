/**
 * Reporting and result persistence.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './case.js';
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
  out(
    `${mark}  ${result.caseId}  ${DIM}${result.durationMs}ms, ${result.diff.length} edit(s), ` +
      `${result.transcript.length} tool call(s)${RESET}\n`,
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

  const failures = ran.filter((r) => !r.passed);
  if (failures.length > 0) {
    out(`\n${RED}Failing cases:${RESET} ${failures.map((f) => f.caseId).join(', ')}\n`);
    out(`${DIM}Full transcripts were written to evals/results/.${RESET}\n`);
  }
}

/**
 * Write results to disk.
 *
 * Filenames carry a timestamp so successive runs accumulate rather than
 * overwrite. Comparing two runs of the same case is how you tell whether a
 * prompt change helped.
 */
export function writeResults(results: RunResult[], label = 'run'): string {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${stamp}-${label}.json`);

  writeFileSync(
    path,
    `${JSON.stringify(
      {
        runAt: new Date().toISOString(),
        total: results.length,
        passed: results.filter((r) => r.passed && !r.skipped).length,
        skipped: results.filter((r) => r.skipped).length,
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return path;
}
