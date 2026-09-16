/**
 * What the guitarist thought.
 *
 * Every other signal in this harness is something a machine can check: did the
 * file survive, did gain stay put, did the model call the right tool. None of
 * them can tell you the preset sounded thin. That judgement only exists after
 * someone plugs in and plays, minutes or days after the run finished, and if
 * there is nowhere to put it, it evaporates.
 *
 * So feedback is recorded against a run id rather than typed into a case file,
 * and it carries a copy of what was judged -- the request, the fixture hash,
 * the exact edits -- so it stays meaningful after the run's transcript is
 * pruned. That record is the raw material for tuning prompts and for building
 * examples of what good actually sounds like.
 *
 * Unlike evals/results/, this directory is committed. A verdict about a tone
 * is worth more than the transcript that produced it and does not go stale.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, RESULTS_DIR } from './case.js';
import type { RunResult } from './run.js';

export const FEEDBACK_DIR = join(REPO_ROOT, 'evals/feedback');
export const FEEDBACK_FILE = join(FEEDBACK_DIR, 'feedback.jsonl');

/**
 * `good` and `bad` are about how it sounded, which is the whole point.
 * `mixed` exists because "right idea, too much of it" is the most common
 * verdict in practice and flattening it to bad would lose the useful half.
 */
export type Verdict = 'good' | 'bad' | 'mixed';

export const VERDICTS: readonly Verdict[] = ['good', 'bad', 'mixed'];

export interface FeedbackEntry {
  recordedAt: string;
  runId: string;
  caseId: string;
  verdict: Verdict;
  /** What was wrong, or what was right. The most valuable field here. */
  note?: string;

  /** A copy of what was judged, so the entry outlives the run's transcript. */
  request: string;
  fixture: string;
  fixtureSha256: string;
  model: string;
  edits: { block: string; parameter: string; before: unknown; after: unknown }[];
  /** Whether the automated checks agreed. Disagreement is the interesting case. */
  checksPassed: boolean;
  totalTokens?: number;
}

export class FeedbackError extends Error {}

function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

export function parseVerdict(value: string): Verdict {
  const normalized = value.trim().toLowerCase();
  if (!isVerdict(normalized)) {
    throw new FeedbackError(`Verdict must be one of: ${VERDICTS.join(', ')} (got "${value}")`);
  }
  return normalized;
}

interface StoredRun {
  runId?: string;
  results?: RunResult[];
}

/**
 * Find the run being judged.
 *
 * `target` is a run id, a case id, or omitted. A bare case id resolves to its
 * most recent run, because that is the one just played; anything else would
 * have someone attaching a verdict to a preset they never heard.
 */
export function findRun(target?: string, dir: string = RESULTS_DIR): { result: RunResult; path: string } {
  if (!existsSync(dir)) {
    throw new FeedbackError('No runs recorded yet. Run `pnpm eval` first.');
  }

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new FeedbackError('No runs recorded yet. Run `pnpm eval` first.');
  }

  for (const name of files) {
    const path = join(dir, name);
    let stored: StoredRun;
    try {
      stored = JSON.parse(readFileSync(path, 'utf8')) as StoredRun;
    } catch {
      continue; // A half-written result file should not block feedback.
    }

    const candidates = (stored.results ?? []).filter((result) => !result.skipped);
    const match = target
      ? candidates.find((result) => result.runId === target || result.caseId === target)
      : candidates[0];

    if (match) return { result: match, path };
  }

  throw new FeedbackError(
    target
      ? `No run found for "${target}". Pass a case id or a run id from evals/results/.`
      : 'No completed runs found in evals/results/.',
  );
}

export function recordFeedback(
  result: RunResult,
  verdict: Verdict,
  note?: string,
  file: string = FEEDBACK_FILE,
): FeedbackEntry {
  const entry: FeedbackEntry = {
    recordedAt: new Date().toISOString(),
    runId: result.runId,
    caseId: result.caseId,
    verdict,
    note: note?.trim() || undefined,
    request: result.request,
    fixture: result.fixture,
    fixtureSha256: result.fixtureSha256,
    model: result.model.provider,
    edits: result.diff.map((change) => ({
      block: `${change.dsp}/${change.slot}`,
      parameter: change.parameter,
      before: change.before,
      after: change.after,
    })),
    checksPassed: result.passed,
    totalTokens: result.model.usage.totalTokens,
  };

  mkdirSync(dirname(file), { recursive: true });
  // JSONL, appended: two people recording feedback at once cannot clobber each
  // other's line, and a corrupted line costs one verdict rather than the file.
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');

  return entry;
}

export function loadFeedback(file: string = FEEDBACK_FILE): FeedbackEntry[] {
  if (!existsSync(file)) return [];

  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FeedbackEntry];
      } catch {
        return [];
      }
    });
}

export function feedbackFor(caseId: string, file: string = FEEDBACK_FILE): FeedbackEntry[] {
  return loadFeedback(file).filter((entry) => entry.caseId === caseId);
}

/**
 * Where the ear and the checks disagree.
 *
 * A run that passed every check and sounded bad means the case is asserting
 * the wrong thing; a run that failed and sounded fine means the checks are too
 * strict. Both are bugs in the harness, and both are invisible without this.
 */
export function disagreements(file: string = FEEDBACK_FILE): FeedbackEntry[] {
  return loadFeedback(file).filter(
    (entry) =>
      (entry.checksPassed && entry.verdict === 'bad') ||
      (!entry.checksPassed && entry.verdict === 'good'),
  );
}
