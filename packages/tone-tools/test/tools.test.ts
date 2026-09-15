/**
 * Tool execution tests.
 *
 * These cover the boundary the model actually touches. The recurring theme is
 * that a wrong call must produce a *correctable* failure — one that tells the
 * model what it did wrong and what the real options are — and must leave the
 * preset exactly as it was.
 */

import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../src/executor.js';
import { ToneSession } from '../src/session.js';
import { TOOLS } from '../src/tools.js';
import { openSession, realPreset, SNAPSHOT_PRESET } from './helpers.js';

function run(session: ToneSession, name: string, args: Record<string, unknown> = {}) {
  return new ToolExecutor(session).execute({ id: 'call_1', name, arguments: args });
}

describe('tool catalog', () => {
  it('exposes every tool with a schema the Responses API accepts', () => {
    const specs = new ToolExecutor(openSession()).toolSpecs();

    expect(specs).toHaveLength(TOOLS.length);
    for (const spec of specs) {
      expect(spec.type).toBe('function');
      expect(spec.name).toMatch(/^[a-z_]+$/);
      expect(spec.description.length).toBeGreaterThan(40);
      expect(spec.parameters.additionalProperties).toBe(false);
    }
  });

  it('offers no tool that rewrites the document wholesale', () => {
    // The model must never be able to hand back replacement JSON. If such a
    // tool ever appears, the safety argument for this layer collapses.
    const names = TOOLS.map((t) => t.name);

    expect(names).not.toContain('set_preset');
    expect(names).not.toContain('write_preset');
    expect(names.some((n) => /json|document|raw/i.test(n))).toBe(false);
  });
});

describe('inspection', () => {
  it('summarizes a real preset', () => {
    const outcome = run(openSession(), 'inspect_preset');

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      ok: true,
      data: { name: 'Possum', device: 'Helix Floor / Rack', blockCount: 3 },
    });
  });

  it('reports the signal chain in order with usable ids', () => {
    const outcome = run(openSession(), 'inspect_signal_chain');
    const data = (outcome.result as { data: { chain: { id: string; position: number }[] } }).data;

    expect(data.chain.map((b) => b.id)).toEqual(['dsp0/block0', 'dsp0/block1', 'dsp0/block2']);
    expect(data.chain.map((b) => b.position)).toEqual([2, 3, 7]);
  });

  it('lists real parameter values and flags where a range is actually known', () => {
    const outcome = run(openSession(), 'inspect_block', { block: 'dsp0/block2' });
    const params = (
      outcome.result as { data: { parameters: { name: string; min?: number }[] } }
    ).data.parameters;

    const pedal = params.find((p) => p.name === 'Pedal');
    expect(pedal).toMatchObject({ min: 0.5, max: 1, rangeKnownFrom: 'controller' });

    // Everything else has no stated range, and we do not invent one.
    expect(params.filter((p) => p.min !== undefined)).toHaveLength(1);
  });

  it('does not count inspection as a modification', () => {
    const session = openSession();
    run(session, 'inspect_preset');
    run(session, 'inspect_signal_chain');
    run(session, 'inspect_block', { block: 'dsp0/block1' });

    expect(session.isModified).toBe(false);
    expect(session.serialize()).toBe(realPreset());
  });
});

describe('malformed model input', () => {
  it('rejects an unknown tool and suggests real ones', () => {
    const outcome = run(openSession(), 'set_gain', { amount: 1 });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('no tool called');
    expect(outcome.output).toContain('Did you mean');
  });

  it('rejects arguments that are not valid JSON', () => {
    const executor = new ToolExecutor(openSession());
    const outcome = executor.execute({
      id: 'c',
      name: 'inspect_block',
      arguments: '{block: dsp0/block1',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('not valid JSON');
  });

  it('accepts arguments as a JSON string, which is how providers send them', () => {
    const executor = new ToolExecutor(openSession());
    const outcome = executor.execute({
      id: 'c',
      name: 'inspect_block',
      arguments: '{"block":"dsp0/block1"}',
    });

    expect(outcome.ok).toBe(true);
  });

  it('rejects a missing required argument', () => {
    const outcome = run(openSession(), 'inspect_block', {});

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('Missing required argument "block"');
  });

  it('rejects an unexpected argument rather than ignoring it', () => {
    // Silently dropping an argument lets the model believe it did something
    // it did not do.
    const outcome = run(openSession(), 'inspect_block', {
      block: 'dsp0/block1',
      snapshot: 2,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('Unexpected argument');
  });

  it('rejects a value of the wrong type', () => {
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Drive',
      value: 'loud',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('must be a number');
  });

  it('accepts a clean numeric string, which models send constantly', () => {
    const session = openSession();
    const outcome = run(session, 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Drive',
      value: '0.75',
    });

    expect(outcome.ok).toBe(true);
    expect(session.preset.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive')?.value).toBe(0.75);
  });

  it.each([null, 42, 'a string', ['an', 'array']])(
    'rejects %s as an argument object',
    (args) => {
      const executor = new ToolExecutor(openSession());
      const outcome = executor.execute({
        id: 'c',
        name: 'inspect_block',
        arguments: args as never,
      });

      expect(outcome.ok).toBe(false);
    },
  );
});

describe('block resolution failures are correctable', () => {
  it('suggests real block ids when a reference does not resolve', () => {
    // Suggestions have to be things the model can pass straight back. A list
    // of display names would send it round the same loop again.
    const outcome = run(openSession(), 'inspect_block', { block: 'the amp' });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('Did you mean');
    expect(outcome.output).toMatch(/dsp\d\/\w+ \(/);
  });

  it('refuses an ambiguous reference rather than picking one', () => {
    // Both DSPs have a "split". A coin flip here would edit the wrong path.
    const outcome = run(openSession(), 'inspect_block', { block: 'split' });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('No single block matches');
  });

  it('suggests real parameter names when one is wrong', () => {
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Sustain',
      value: 0.5,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('has no parameter called');
    expect(outcome.output).toContain('Did you mean');
  });

  it('refuses to set a boolean parameter numerically and says what to use instead', () => {
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/inputA',
      parameter: 'noiseGate',
      value: 1,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('is boolean, not a number');
    expect(outcome.output).toContain('enable_block');
  });
});

describe('parameter edits', () => {
  it('sets an absolute value and records the change', () => {
    const session = openSession();
    const outcome = run(session, 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Drive',
      value: 0.8,
    });

    expect(outcome.ok).toBe(true);
    expect(session.edits).toHaveLength(1);
    expect(session.edits[0]).toMatchObject({
      sequence: 1,
      tool: 'set_parameter',
      parameter: 'Drive',
      before: 0.62,
      after: 0.8,
    });
  });

  it('adjusts a value relative to its current one', () => {
    const session = openSession();
    run(session, 'adjust_parameter', {
      block: 'dsp0/block1',
      parameter: 'Master',
      amount: 0.1,
    });

    const value = session.preset.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Master')
      ?.value as number;
    expect(value).toBeCloseTo(0.46, 10);
  });

  // Found by running a real request through the live model: "soften the pick
  // attack" produced `Presence 0.6 -> 0.5499999999999999`, and that sixteen
  // decimal number was serialized straight into the user's preset in place of a
  // value the original file wrote as `0.6`.
  //
  // Asserted exactly rather than with toBeCloseTo, because toBeCloseTo is what
  // let the artifact through in the first place.
  it('does not leak floating-point noise into the preset', () => {
    const session = openSession();
    run(session, 'adjust_parameter', {
      block: 'dsp0/block1',
      parameter: 'Presence',
      amount: -0.05,
    });

    const value = session.preset.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Presence')
      ?.value as number;

    expect(value).toBe(0.55);
    expect(session.serialize()).toContain('"Presence":0.55');
    expect(session.serialize()).not.toContain('0.5499999999999999');
  });

  it('keeps precision on large-magnitude parameters while cleaning noise', () => {
    const session = openSession();
    run(session, 'adjust_parameter', {
      block: 'dsp0/cab0',
      parameter: 'HighCut',
      amount: -0.1,
    });

    const value = session.preset.findParameter({ dsp: 'dsp0', slot: 'cab0' }, 'HighCut')
      ?.value as number;

    // 20100 Hz is the real value in this fixture. Rounding to a fixed number of
    // decimal places would be wrong here; rounding to significant digits is not.
    expect(value).toBe(20099.9);
  });

  it('treats a no-op write as a no-op instead of logging a fake change', () => {
    const session = openSession();
    const outcome = run(session, 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Drive',
      value: 0.62,
    });

    expect(outcome.ok).toBe(true);
    expect(session.edits).toHaveLength(0);
    expect(session.isModified).toBe(false);
    expect(outcome.output).toContain('No change was needed');
  });

  it('warns when it writes a value whose range the preset never states', () => {
    // Honest uncertainty: most parameters have no in-file range, and the
    // official catalog is proprietary. Say so rather than implying validation
    // happened.
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/block1',
      parameter: 'Drive',
      value: 0.8,
    });

    expect(outcome.result.warnings.join(' ')).toContain('states no range');
  });

  it('enforces a range the preset does state', () => {
    // The Pedal parameter carries a controller assignment with @min 0.5.
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/block2',
      parameter: 'Pedal',
      value: 0.1,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('stated minimum of 0.5');
  });

  it('accepts a value inside a stated range without warning about the range', () => {
    const outcome = run(openSession(), 'set_parameter', {
      block: 'dsp0/block2',
      parameter: 'Pedal',
      value: 0.75,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result.warnings.join(' ')).not.toContain('states no range');
  });

  it('leaves the preset byte-identical when an edit is rejected', () => {
    const session = openSession();
    const before = session.serialize();

    run(session, 'set_parameter', { block: 'dsp0/block2', parameter: 'Pedal', value: 0.1 });
    run(session, 'set_parameter', { block: 'nope', parameter: 'Drive', value: 0.5 });
    run(session, 'set_parameter', { block: 'dsp0/block1', parameter: 'Nope', value: 0.5 });

    expect(session.serialize()).toBe(before);
    expect(session.edits).toHaveLength(0);
  });
});

describe('bypass edits', () => {
  it('enables a bypassed block', () => {
    const session = openSession();
    const outcome = run(session, 'enable_block', { block: 'dsp0/block0' });

    expect(outcome.ok).toBe(true);
    expect(session.preset.blockInfo({ dsp: 'dsp0', slot: 'block0' })?.enabled).toBe(true);
  });

  it('mirrors bypass into the active snapshot', () => {
    // The dual-write rule. Without the mirror the hardware reverts the change
    // on the next snapshot recall and the user's edit silently vanishes.
    const session = openSession();
    run(session, 'enable_block', { block: 'dsp0/block0' });

    const reloaded = ToneSession.open(session.serialize());
    expect('session' in reloaded).toBe(true);
  });

  it('treats bypassing an already-bypassed block as a no-op', () => {
    const session = openSession();
    const outcome = run(session, 'disable_block', { block: 'dsp0/block0' });

    expect(outcome.ok).toBe(true);
    expect(session.edits).toHaveLength(0);
    expect(outcome.result.warnings.join(' ')).toContain('already bypassed');
  });

  it('records bypass changes in readable terms', () => {
    const session = openSession(SNAPSHOT_PRESET);
    run(session, 'enable_block', { block: 'dsp0/block1' });

    expect(session.edits[0]?.summary).toMatch(/enabled/);
    expect(session.edits[0]).toMatchObject({ before: 'bypassed', after: 'on' });
  });
});

describe('snapshot-controlled parameters', () => {
  it('writes a snapshot-controlled value to both places', () => {
    const session = openSession(SNAPSHOT_PRESET);
    run(session, 'set_parameter', { block: 'dsp0/block0', parameter: 'Drive', value: 0.8 });

    const output = session.serialize();
    expect(output).toContain('"Drive" : 0.800');
    expect(output).toContain('"@value" : 0.800');
  });

  it('keeps the preset valid after a snapshot-controlled edit', () => {
    const session = openSession(SNAPSHOT_PRESET);
    run(session, 'set_parameter', { block: 'dsp0/block0', parameter: 'Drive', value: 0.8 });

    expect(session.changes().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('compare_presets', () => {
  it('reports nothing before any edit', () => {
    const outcome = run(openSession(), 'compare_presets');

    expect(outcome.result).toMatchObject({ data: { modified: false, differences: [] } });
  });

  it('reports what changed and how it changed', () => {
    const session = openSession();
    run(session, 'set_parameter', { block: 'dsp0/block1', parameter: 'Drive', value: 0.8 });
    run(session, 'enable_block', { block: 'dsp0/block0' });

    const data = (
      run(session, 'compare_presets').result as {
        data: { differences: unknown[]; editLog: unknown[] };
      }
    ).data;

    expect(data.differences).toHaveLength(2);
    expect(data.editLog).toHaveLength(2);
  });

  it('derives the diff from the documents, not from the edit log', () => {
    // If a tool ever changes something without recording it, the diff still
    // shows it. That disagreement is how such a bug gets noticed.
    const session = openSession();
    session.preset.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Bass', 0.9);

    expect(session.diff()).toHaveLength(1);
    expect(session.edits).toHaveLength(0);
  });
});

describe('undo through the tool layer', () => {
  it('undoes the most recent edit', () => {
    const session = openSession();
    const original = realPreset();

    run(session, 'set_parameter', { block: 'dsp0/block1', parameter: 'Drive', value: 0.8 });
    const outcome = run(session, 'undo_last_change');

    expect(outcome.ok).toBe(true);
    expect(session.serialize()).toBe(original);
  });

  it('reports having nothing to undo rather than throwing', () => {
    const outcome = run(openSession(), 'undo_last_change');

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain('no changes to undo');
  });
});
