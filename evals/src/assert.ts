/**
 * Checking a run against a case's expectations.
 *
 * Each check returns a verdict with enough detail to act on. "Failed" is not
 * useful; "Drive moved from 0.62 to 0.8 and the case says it must not move"
 * tells you whether the model is wrong or the case is.
 */

import type { ParameterDiff } from '@bender/tone-tools';
import type { CaseExpectations, EvalCase, ParameterExpectation } from './case.js';

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RunObservations {
  diff: ParameterDiff[];
  toolsCalled: string[];
  failedToolCalls: string[];
  reply: string;
  roundTripStable: boolean;
  outputDiffersFromInput: boolean;
  /** Set when the run failed before producing a result. */
  error?: string;
}

function blockId(change: ParameterDiff): string {
  return `${change.dsp}/${change.slot}`;
}

/** Match an expectation against a diff entry by id or by block label. */
function matches(change: ParameterDiff, expectation: ParameterExpectation): boolean {
  const wanted = expectation.block.toLowerCase();
  const sameBlock =
    blockId(change).toLowerCase() === wanted || change.label.toLowerCase() === wanted;

  return (
    sameBlock && change.parameter.toLowerCase() === expectation.parameter.toLowerCase()
  );
}

function describe(change: ParameterDiff): string {
  return `${blockId(change)} ${change.parameter}: ${String(change.before)} -> ${String(change.after)}`;
}

function checkDirection(change: ParameterDiff, direction: string): boolean {
  if (direction === 'any') return true;
  if (typeof change.before !== 'number' || typeof change.after !== 'number') return false;
  return direction === 'increase' ? change.after > change.before : change.after < change.before;
}

export function evaluate(evalCase: EvalCase, run: RunObservations): Check[] {
  const expect: CaseExpectations = evalCase.expect;
  const checks: Check[] = [];

  if (run.error) {
    const expected = expect.outcome === 'error';
    return [
      {
        name: 'run completed',
        passed: expected,
        detail: expected ? `failed as expected: ${run.error}` : run.error,
      },
    ];
  }

  if (expect.outcome === 'error') {
    checks.push({ name: 'run failed', passed: false, detail: 'expected a failure but the run succeeded' });
  }

  // --- round trip -----------------------------------------------------------
  // Default on. Any case that produces a preset which will not reload is a
  // failure regardless of how good the tone advice was.
  if (expect.roundTrip !== false) {
    checks.push({
      name: 'round trip',
      passed: run.roundTripStable,
      detail: run.roundTripStable
        ? 'output reparses to identical bytes'
        : 'output does NOT reparse to identical bytes',
    });
  }

  // --- overall outcome ------------------------------------------------------
  if (expect.outcome === 'edits') {
    checks.push({
      name: 'made edits',
      passed: run.diff.length > 0,
      detail: run.diff.length > 0 ? `${run.diff.length} change(s)` : 'no changes were made',
    });
  } else if (expect.outcome === 'no-edits' || expect.outcome === 'refusal') {
    checks.push({
      name: 'made no edits',
      passed: run.diff.length === 0,
      detail:
        run.diff.length === 0
          ? 'preset untouched'
          : `expected no changes but got: ${run.diff.map(describe).join(', ')}`,
    });
  }

  // --- required changes -----------------------------------------------------
  for (const expectation of expect.mustChange ?? []) {
    const found = run.diff.find((change) => matches(change, expectation));
    const label = `${expectation.block} ${expectation.parameter}`;

    if (!found) {
      checks.push({ name: `changed ${label}`, passed: false, detail: 'was not changed' });
      continue;
    }

    const direction = expectation.direction ?? 'any';
    if (!checkDirection(found, direction)) {
      checks.push({
        name: `changed ${label}`,
        passed: false,
        detail: `expected ${direction}, got ${describe(found)}`,
      });
      continue;
    }

    const value = found.after;
    if (typeof value === 'number') {
      if (expectation.min !== undefined && value < expectation.min) {
        checks.push({
          name: `changed ${label}`,
          passed: false,
          detail: `${value} is below the expected minimum ${expectation.min}`,
        });
        continue;
      }
      if (expectation.max !== undefined && value > expectation.max) {
        checks.push({
          name: `changed ${label}`,
          passed: false,
          detail: `${value} is above the expected maximum ${expectation.max}`,
        });
        continue;
      }
    }

    checks.push({ name: `changed ${label}`, passed: true, detail: describe(found) });
  }

  // --- forbidden changes ----------------------------------------------------
  // The heart of most cases: proof that a constraint in the request was
  // actually honoured rather than merely acknowledged in prose.
  for (const expectation of expect.mustNotChange ?? []) {
    const found = run.diff.find((change) => matches(change, expectation));
    const label = `${expectation.block} ${expectation.parameter}`;

    checks.push({
      name: `left ${label} alone`,
      passed: !found,
      detail: found ? `was changed: ${describe(found)}` : 'unchanged',
    });
  }

  for (const block of expect.blocksUntouched ?? []) {
    const touched = run.diff.filter(
      (change) =>
        blockId(change).toLowerCase() === block.toLowerCase() ||
        change.label.toLowerCase() === block.toLowerCase(),
    );

    checks.push({
      name: `left ${block} alone`,
      passed: touched.length === 0,
      detail: touched.length === 0 ? 'unchanged' : touched.map(describe).join(', '),
    });
  }

  if (expect.maxEdits !== undefined) {
    checks.push({
      name: `at most ${expect.maxEdits} edits`,
      passed: run.diff.length <= expect.maxEdits,
      detail: `${run.diff.length} change(s)`,
    });
  }

  // --- tool usage -----------------------------------------------------------
  for (const tool of expect.toolsUsed ?? []) {
    checks.push({
      name: `used ${tool}`,
      passed: run.toolsCalled.includes(tool),
      detail: run.toolsCalled.includes(tool)
        ? 'called'
        : `not called; called: ${run.toolsCalled.join(', ') || '(none)'}`,
    });
  }

  for (const tool of expect.toolsNotUsed ?? []) {
    checks.push({
      name: `did not use ${tool}`,
      passed: !run.toolsCalled.includes(tool),
      detail: run.toolsCalled.includes(tool) ? 'was called' : 'not called',
    });
  }

  if (expect.allToolCallsSucceed) {
    checks.push({
      name: 'all tool calls succeeded',
      passed: run.failedToolCalls.length === 0,
      detail: run.failedToolCalls.length === 0 ? 'no failures' : run.failedToolCalls.join(', '),
    });
  }

  // --- explanation ----------------------------------------------------------
  for (const phrase of expect.replyMentions ?? []) {
    const present = normalizeProse(run.reply).includes(normalizeProse(phrase));
    checks.push({
      name: `explanation mentions "${phrase}"`,
      passed: present,
      detail: present ? 'present' : 'absent',
    });
  }

  return checks;
}

export function passed(checks: Check[]): boolean {
  return checks.length > 0 && checks.every((check) => check.passed);
}

/**
 * Models write prose, not string literals. They use typographic apostrophes
 * ("can’t"), en dashes, non-breaking spaces and markdown emphasis, and which
 * ones they use varies between runs of the same prompt. A `replyMentions`
 * check that compares raw substrings therefore fails on punctuation while the
 * answer itself is perfectly correct -- which is the worst kind of eval
 * failure, because it trains you to ignore red results.
 *
 * This flattens the variants that carry no meaning so the check tests what it
 * claims to test: whether the explanation says the thing.
 */
function normalizeProse(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
