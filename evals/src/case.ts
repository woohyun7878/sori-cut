/**
 * Evaluation case schema and loading.
 *
 * A case is a preset, something a guitarist said, and a set of claims about
 * what a correct response looks like. The claims are deliberately loose about
 * *how* a request is satisfied and strict about what must not happen: there
 * are several defensible ways to add sustain, but exactly one acceptable
 * outcome for "did the preset survive".
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CASES_DIR = join(REPO_ROOT, 'evals/cases');
export const RESULTS_DIR = join(REPO_ROOT, 'evals/results');

/** Which way a value is expected to move. */
export type Direction = 'increase' | 'decrease' | 'any';

export interface ParameterExpectation {
  /** Block id such as "dsp0/block1", or a block name. */
  block: string;
  parameter: string;
  direction?: Direction;
  /** Inclusive bounds the final value must fall within. */
  min?: number;
  max?: number;
}

export interface CaseExpectations {
  /**
   * What should happen overall.
   *
   * `edits`    the model should change something
   * `no-edits` the model should decide nothing needs changing
   * `refusal`  the model should explain it cannot do this
   * `error`    the request should fail before reaching the model
   */
  outcome?: 'edits' | 'no-edits' | 'refusal' | 'error';

  /** Parameters that must have moved, optionally in a stated direction. */
  mustChange?: ParameterExpectation[];

  /**
   * Parameters that must be byte-identical afterwards.
   *
   * This is usually the most valuable part of a case. "Give me sustain
   * without more noise" is only satisfied if gain really did not move.
   */
  mustNotChange?: ParameterExpectation[];

  /** Blocks where nothing at all may change. */
  blocksUntouched?: string[];

  /** Ceiling on edits. Catches a model that shotguns the whole preset. */
  maxEdits?: number;

  /** Tools that must appear in the transcript, e.g. proof it inspected first. */
  toolsUsed?: string[];

  /** Tools that must not appear. */
  toolsNotUsed?: string[];

  /** Every tool call must succeed. Defaults to false: recovery is allowed. */
  allToolCallsSucceed?: boolean;

  /** The output must reparse to identical bytes. Defaults to true. */
  roundTrip?: boolean;

  /** Case-insensitive substrings the explanation should contain. */
  replyMentions?: string[];
}

export interface EvalCase {
  id: string;
  description?: string;
  /** Path to the .hlx file, relative to the repository root. */
  fixture: string;
  /** What the guitarist said. */
  request: string;
  expect: CaseExpectations;
  /**
   * A canned model transcript.
   *
   * Cases carrying one can run with `--mock` and no network, which makes them
   * usable as ordinary regression tests. Cases without one need a live model.
   * Both are legitimate: a mocked case pins the tool layer's behaviour, a live
   * case measures whether the model actually reasons well.
   */
  mock?: MockTurn[];
  /** Free-form human notes. Never sent to the model. */
  notes?: string;
  /** Excluded from `eval:all` runs. Use for cases pending a real fixture. */
  skip?: boolean;
  /** Why it is skipped. */
  skipReason?: string;
}

export interface MockTurn {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> | string }[];
}

export class CaseError extends Error {}

function requireString(value: unknown, field: string, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CaseError(`Case "${id}": "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

export function parseCase(raw: unknown, filename: string): EvalCase {
  if (!raw || typeof raw !== 'object') {
    throw new CaseError(`${filename} does not contain a JSON object.`);
  }

  const data = raw as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : filename.replace(/\.json$/i, '');

  const evalCase: EvalCase = {
    id,
    description: typeof data.description === 'string' ? data.description : undefined,
    fixture: requireString(data.fixture, 'fixture', id),
    request: requireString(data.request, 'request', id),
    expect: (data.expect ?? {}) as CaseExpectations,
    mock: Array.isArray(data.mock) ? (data.mock as MockTurn[]) : undefined,
    notes: typeof data.notes === 'string' ? data.notes : undefined,
    skip: data.skip === true,
    skipReason: typeof data.skipReason === 'string' ? data.skipReason : undefined,
  };

  // Fail at load rather than mid-run. A typo in a fixture path should not be
  // discovered after a minute of model calls.
  const fixturePath = resolve(REPO_ROOT, evalCase.fixture);
  if (!existsSync(fixturePath)) {
    throw new CaseError(
      `Case "${id}": fixture "${evalCase.fixture}" does not exist. ` +
        `Paths are relative to the repository root.`,
    );
  }

  return evalCase;
}

export function loadCases(dir: string = CASES_DIR): EvalCase[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => parseCase(JSON.parse(readFileSync(join(dir, name), 'utf8')), name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadCase(id: string, dir: string = CASES_DIR): EvalCase | undefined {
  return loadCases(dir).find((c) => c.id === id);
}

export function readFixture(evalCase: EvalCase): string {
  return readFileSync(resolve(REPO_ROOT, evalCase.fixture), 'utf8');
}
