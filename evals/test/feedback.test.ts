import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disagreements,
  feedbackFor,
  FeedbackError,
  findRun,
  loadFeedback,
  parseVerdict,
  recordFeedback,
} from '../src/feedback.js';
import type { RunResult } from '../src/run.js';

let dir: string;
let results: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bender-feedback-'));
  results = join(dir, 'results');
  file = join(dir, 'feedback', 'feedback.jsonl');
  mkdirSync(results, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    caseId: 'tapping-sustain',
    runId: '260101120000-aaaa',
    request: 'more sustain for tapping',
    startedAt: new Date().toISOString(),
    durationMs: 100,
    fixture: 'lead.hlx',
    fixtureSha256: 'deadbeef',
    parser: { ok: true, warnings: [] },
    model: {
      provider: 'test',
      requestIds: [],
      iterations: 1,
      truncated: false,
      usage: { totalTokens: 900 },
      latencyMs: 100,
    },
    transcript: [],
    diff: [{ dsp: 'dsp0', slot: 'block1', parameter: 'Sustain', before: 0.4, after: 0.6 }],
    reply: '',
    output: { roundTripStable: true, differsFromInput: true },
    checks: [],
    passed: true,
    ...overrides,
  };
}

function writeRun(name: string, runResults: RunResult[]): void {
  writeFileSync(
    join(results, `${name}.json`),
    JSON.stringify({ runId: runResults[0]?.runId, results: runResults }),
    'utf8',
  );
}

describe('parseVerdict', () => {
  it('accepts the three verdicts in any casing', () => {
    expect(parseVerdict('GOOD')).toBe('good');
    expect(parseVerdict(' mixed ')).toBe('mixed');
  });

  it('rejects anything else rather than guessing', () => {
    expect(() => parseVerdict('meh')).toThrow(FeedbackError);
  });
});

describe('findRun', () => {
  it('explains itself when nothing has been run', () => {
    expect(() => findRun(undefined, join(dir, 'nowhere'))).toThrow(/Run `pnpm eval` first/);
  });

  it('finds a run by run id', () => {
    writeRun('a', [runResult({ runId: '260101120000-aaaa' })]);
    writeRun('b', [runResult({ caseId: 'other', runId: '260102120000-bbbb' })]);

    expect(findRun('260102120000-bbbb', results).result.caseId).toBe('other');
  });

  it('resolves a case id to its most recent run', () => {
    writeRun('260101120000-old', [runResult({ runId: 'old' })]);
    writeRun('260202120000-new', [runResult({ runId: 'new' })]);

    // Filenames sort chronologically, so the newest is the one just played.
    expect(findRun('tapping-sustain', results).result.runId).toBe('new');
  });

  it('defaults to the latest run when given no target', () => {
    writeRun('260202120000-new', [runResult({ runId: 'new' })]);

    expect(findRun(undefined, results).result.runId).toBe('new');
  });

  it('never returns a skipped case, which was never played', () => {
    writeRun('260202120000-new', [
      runResult({ caseId: 'skipped', skipped: true }),
      runResult({ caseId: 'ran' }),
    ]);

    expect(findRun(undefined, results).result.caseId).toBe('ran');
  });

  it('survives a half-written result file', () => {
    writeFileSync(join(results, '260303120000-broken.json'), '{ not json', 'utf8');
    writeRun('260202120000-good', [runResult()]);

    expect(findRun(undefined, results).result.caseId).toBe('tapping-sustain');
  });

  it('says so when the target does not exist', () => {
    writeRun('a', [runResult()]);

    expect(() => findRun('no-such-case', results)).toThrow(/No run found/);
  });
});

describe('recordFeedback', () => {
  it('keeps a copy of what was judged', () => {
    const entry = recordFeedback(runResult(), 'mixed', '  too woolly  ', file);

    expect(entry.note).toBe('too woolly');
    expect(entry.request).toBe('more sustain for tapping');
    expect(entry.fixtureSha256).toBe('deadbeef');
    // The edits matter most: they are what the verdict is actually about.
    expect(entry.edits).toEqual([
      { block: 'dsp0/block1', parameter: 'Sustain', before: 0.4, after: 0.6 },
    ]);
  });

  it('drops an empty note rather than storing whitespace', () => {
    expect(recordFeedback(runResult(), 'good', '   ', file).note).toBeUndefined();
  });

  it('appends, so verdicts accumulate', () => {
    recordFeedback(runResult(), 'good', 'first', file);
    recordFeedback(runResult({ caseId: 'other' }), 'bad', 'second', file);

    expect(loadFeedback(file).map((entry) => entry.note)).toEqual(['first', 'second']);
    expect(feedbackFor('other', file)).toHaveLength(1);
  });

  it('returns nothing when no feedback exists yet', () => {
    expect(loadFeedback(file)).toEqual([]);
  });
});

describe('disagreements', () => {
  it('surfaces runs where the checks and the ear disagreed', () => {
    recordFeedback(runResult({ caseId: 'passed-sounds-bad', passed: true }), 'bad', undefined, file);
    recordFeedback(runResult({ caseId: 'failed-sounds-good', passed: false }), 'good', undefined, file);
    recordFeedback(runResult({ caseId: 'agreed', passed: true }), 'good', undefined, file);
    recordFeedback(runResult({ caseId: 'unsure', passed: true }), 'mixed', undefined, file);

    expect(disagreements(file).map((entry) => entry.caseId)).toEqual([
      'passed-sounds-bad',
      'failed-sounds-good',
    ]);
  });
});
