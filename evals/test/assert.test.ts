/**
 * Tests for the harness's own judgement.
 *
 * These matter more than they look. Every future regression case inherits
 * whatever `evaluate` decides, so a bug here does not fail one case -- it
 * silently changes the verdict on all of them. The cases below are written
 * against the failure modes that actually cost us time.
 */

import { describe, expect, it } from 'vitest';
import type { ParameterDiff } from '@bender/tone-tools';
import { evaluate, passed, type RunObservations } from '../src/assert.js';
import type { EvalCase } from '../src/case.js';

function change(over: Partial<ParameterDiff> = {}): ParameterDiff {
  return {
    dsp: 'dsp0',
    slot: 'block1',
    label: 'Amp Brit2204',
    parameter: 'Master',
    before: 0.36,
    after: 0.48,
    ...over,
  };
}

function run(over: Partial<RunObservations> = {}): RunObservations {
  return {
    diff: [change()],
    toolsCalled: ['inspect_block', 'set_parameter'],
    failedToolCalls: [],
    reply: 'I brought the master up.',
    roundTripStable: true,
    outputDiffersFromInput: true,
    ...over,
  };
}

function evalCase(expectations: Partial<EvalCase['expect']> = {}): EvalCase {
  return {
    id: 'test',
    fixture: 'packages/helix/test/fixtures/possum.hlx',
    request: 'more sustain',
    expect: { outcome: 'edits', ...expectations },
  };
}

describe('round trip', () => {
  it('fails a run whose preset will not reload, however good the advice was', () => {
    const checks = evaluate(evalCase(), run({ roundTripStable: false }));
    const check = checks.find((c) => c.name === 'round trip');

    expect(check?.passed).toBe(false);
  });

  it('is checked by default, without the case having to ask', () => {
    const checks = evaluate(evalCase(), run());

    expect(checks.map((c) => c.name)).toContain('round trip');
  });
});

describe('mustNotChange', () => {
  it('catches the lazy answer: gain raised when the user asked for no extra noise', () => {
    const checks = evaluate(
      evalCase({ mustNotChange: [{ block: 'dsp0/block1', parameter: 'Drive' }] }),
      run({ diff: [change({ parameter: 'Drive', before: 0.62, after: 0.8 })] }),
    );

    expect(passed(checks)).toBe(false);
    const detail = checks.find((c) => !c.passed)?.detail ?? '';
    expect(detail).toContain('0.62');
    expect(detail).toContain('0.8');
  });

  it('matches by block label as well as by id, since cases are written by humans', () => {
    const checks = evaluate(
      evalCase({ mustNotChange: [{ block: 'Amp Brit2204', parameter: 'Master' }] }),
      run(),
    );

    expect(passed(checks)).toBe(false);
  });

  it('passes when the forbidden parameter was genuinely left alone', () => {
    const checks = evaluate(
      evalCase({ mustNotChange: [{ block: 'dsp0/block1', parameter: 'Drive' }] }),
      run(),
    );

    expect(passed(checks)).toBe(true);
  });
});

describe('replyMentions', () => {
  // The bug this pins cost a false failure on a live run: the model refused
  // correctly and named the right replacement model, but wrote "can’t" with a
  // typographic apostrophe while the case said "can't".
  it('ignores typographic punctuation the model chose for itself', () => {
    const checks = evaluate(
      evalCase({ outcome: 'refusal', replyMentions: ["can't swap"] }),
      run({
        diff: [],
        reply: 'I can\u2019t swap amp models with the available controls.',
        outputDiffersFromInput: false,
      }),
    );

    expect(passed(checks)).toBe(true);
  });

  it('ignores markdown emphasis around the phrase', () => {
    const checks = evaluate(
      evalCase({ replyMentions: ['Brit 2204'] }),
      run({ reply: 'I adjusted the **Brit 2204** power section.' }),
    );

    expect(checks.find((c) => c.name.startsWith('explanation mentions'))?.passed).toBe(true);
  });

  it('still fails when the explanation genuinely omits the phrase', () => {
    const checks = evaluate(
      evalCase({ replyMentions: ['high cut'] }),
      run({ reply: 'I raised the master volume.' }),
    );

    expect(passed(checks)).toBe(false);
  });
});

describe('outcome', () => {
  it('fails a refusal case that actually edited the preset', () => {
    const checks = evaluate(evalCase({ outcome: 'refusal' }), run());

    expect(passed(checks)).toBe(false);
  });

  it('fails an edits case that changed nothing', () => {
    const checks = evaluate(
      evalCase({ outcome: 'edits' }),
      run({ diff: [], outputDiffersFromInput: false }),
    );

    expect(passed(checks)).toBe(false);
  });

  it('reports a crashed run as a single check rather than a wall of noise', () => {
    const checks = evaluate(evalCase(), run({ error: 'connection reset' }));

    expect(checks).toHaveLength(1);
    expect(checks[0]?.passed).toBe(false);
    expect(checks[0]?.detail).toContain('connection reset');
  });

  it('treats a crash as success when the case expects a failure', () => {
    const checks = evaluate(
      evalCase({ outcome: 'error' }),
      run({ error: 'unsupported device' }),
    );

    expect(passed(checks)).toBe(true);
  });
});

describe('edit budget', () => {
  it('catches a model that rewrote half the preset to answer one question', () => {
    const checks = evaluate(
      evalCase({ maxEdits: 2 }),
      run({
        diff: [
          change({ parameter: 'Master' }),
          change({ parameter: 'Sag' }),
          change({ parameter: 'BiasX' }),
        ],
      }),
    );

    expect(passed(checks)).toBe(false);
  });
});

describe('failed tool calls', () => {
  it('fails when a tool call errored, even if the final preset looks fine', () => {
    const checks = evaluate(
      evalCase({ allToolCallsSucceed: true }),
      run({ failedToolCalls: ['set_parameter: unknown parameter "Sustain"'] }),
    );

    expect(passed(checks)).toBe(false);
    expect(checks.find((c) => !c.passed)?.detail).toContain('Sustain');
  });
});

describe('passed', () => {
  it('treats an empty check list as a failure, so a case that asserts nothing cannot pass', () => {
    expect(passed([])).toBe(false);
  });
});
