/**
 * Corruption regression tests.
 *
 * Preset corruption is the critical failure mode: a subtly broken `.hlx` may
 * load on a user's hardware and sound wrong, or refuse to load at all, and
 * either way the user's work is gone. Each test here pins a specific way the
 * format has been observed to punish a careless writer.
 */

import { describe, expect, it } from 'vitest';
import { HelixPreset, validatePreset } from '../src/index.js';
import { MINIMAL_PRESET, presetFixtures, readFixture } from './helpers.js';

describe('edits change only what was asked for', () => {
  it('changes exactly one value and nothing else', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', 0.75);

    const diff = lineDiff(MINIMAL_PRESET, preset.serialize());
    expect(diff).toEqual([['     "Drive" : 0.620,', '     "Drive" : 0.750,']]);
  });

  it('leaves every other block untouched', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const before = preset.blockInfo({ dsp: 'dsp0', slot: 'block0' });

    preset.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive', 0.8);

    expect(preset.blockInfo({ dsp: 'dsp0', slot: 'block0' })).toEqual(before);
  });

  it('preserves key order after an edit', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const before = preset.slotKeys('dsp0');

    preset.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Master', 0.5);

    expect(preset.slotKeys('dsp0')).toEqual(before);
  });

  it('preserves sections Bender does not model', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    preset.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive', 0.9);

    const output = preset.serialize();
    expect(output).toContain('"@fs_label":"Compulsive Drive"');
    expect(output).toContain('"@variax_str1tuning":-1');
    expect(output).toContain('"tnid":3102282');
  });
});

describe('numeric formatting survives an edit', () => {
  it('keeps the float shape of the value it replaces', () => {
    // Replacing 0.620 with 0.75 must write 0.750, not 0.75. The file stops
    // looking like HX Edit wrote it otherwise, and diffs against an
    // untouched export become unreadable.
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', 0.75);

    expect(preset.serialize()).toContain('"Drive" : 0.750');
  });

  it('keeps integers bare when the original was an integer', () => {
    // @type and @position are written as bare integers. Emitting "3.0" for
    // @type would be numerically identical and stylistically wrong.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    preset.writeParameter({ dsp: 'dsp0', slot: 'cab0' }, 'HighCut', 8000);

    expect(preset.serialize()).toContain('"HighCut":8000');
    expect(preset.serialize()).not.toContain('"HighCut":8000.0');
  });

  it('never rounds away precision to match the template', () => {
    // 0.620 has three decimals, but 0.6215 needs four. Matching the template
    // would silently write 0.622 and lose the user's value.
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', 0.6215);

    expect(preset.serialize()).toContain('"Drive" : 0.6215');
    expect(reparse(preset).findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive')?.value).toBe(
      0.6215,
    );
  });

  it('round-trips an edited value through parse and serialize', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    preset.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Master', 0.42);

    const reloaded = reparse(preset);
    expect(reloaded.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Master')?.value).toBe(0.42);
    expect(reloaded.serialize()).toBe(preset.serialize());
  });

  it('refuses to write a non-finite number', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(() =>
      preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', Number.NaN),
    ).toThrow(/non-finite/);
    expect(() =>
      preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', Number.POSITIVE_INFINITY),
    ).toThrow(/non-finite/);
  });
});

describe('snapshot mirroring', () => {
  it('writes bypass state to both the block and the active snapshot', () => {
    // Bypass lives in two places. Writing only @enabled leaves the snapshot
    // disagreeing, and the hardware reverts the change on the next snapshot
    // recall, so the user sees their edit silently undo itself.
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    preset.writeEnabled({ dsp: 'dsp0', slot: 'block1' }, true);

    const output = preset.serialize();
    expect(output).toContain('"@enabled" : true');

    const reloaded = reparse(preset);
    expect(reloaded.blockInfo({ dsp: 'dsp0', slot: 'block1' })?.enabled).toBe(true);
    expect(validatePreset(reloaded).errors).toEqual([]);
  });

  it('leaves the preset internally consistent after a bypass change', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    preset.writeEnabled({ dsp: 'dsp0', slot: 'block0' }, false);
    preset.writeEnabled({ dsp: 'dsp0', slot: 'block1' }, true);

    expect(validatePreset(preset).ok).toBe(true);
  });

  it('detects a snapshot mismatch introduced behind its back', () => {
    // Simulates exactly the bug the mirroring exists to prevent: a writer
    // that only touched @enabled.
    const damaged = MINIMAL_PRESET.replace('"@enabled" : true', '"@enabled" : false');
    const result = validatePreset(HelixPreset.parse(damaged));

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('snapshot-bypass-mismatch');
  });

  it('mirrors a snapshot-controlled parameter into the active snapshot', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    const ref = { dsp: 'dsp0', slot: 'block0' };

    preset.writeParameter(ref, 'Drive', 0.8);
    expect(preset.mirrorParameterIntoActiveSnapshot(ref, 'Drive', 0.8)).toBe(true);

    expect(preset.serialize()).toContain('"@value" : 0.800');
  });

  it('does not invent snapshot entries for parameters that have none', () => {
    // Creating a controller entry would assert that this parameter is
    // snapshot-controlled, which the file does not say.
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    const ref = { dsp: 'dsp0', slot: 'block0' };

    expect(preset.mirrorParameterIntoActiveSnapshot(ref, 'Master', 0.5)).toBe(false);
    expect(preset.serialize()).not.toContain('"Master" : {');
  });
});

describe('invalid operations are rejected, not absorbed', () => {
  it('rejects a write to a slot that does not exist', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(() =>
      preset.writeParameter({ dsp: 'dsp0', slot: 'block99' }, 'Drive', 0.5),
    ).toThrow(/No such slot/);
  });

  it('rejects a write to a parameter the block does not have', () => {
    // Silently adding an unknown parameter would produce a file that loads
    // but ignores the edit, which is worse than an error.
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(() =>
      preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Sustain', 0.5),
    ).toThrow(/no parameter named/);
  });

  it('leaves the document untouched when a write is rejected', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(() =>
      preset.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Sustain', 0.5),
    ).toThrow();
    expect(preset.serialize()).toBe(MINIMAL_PRESET);
  });

  it('returns the previous value so a caller can undo', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);
    const ref = { dsp: 'dsp0', slot: 'block0' };

    const previous = preset.writeParameter(ref, 'Drive', 0.75);
    expect(previous).toBe(0.62);

    preset.writeParameter(ref, 'Drive', previous as number);
    expect(preset.serialize()).toBe(MINIMAL_PRESET);
  });
});

describe('clone isolation', () => {
  it('does not let an edit on a clone reach the original', () => {
    // Undo and transactional edits both depend on this. A shared subtree
    // would make a "rolled back" edit permanent.
    const original = HelixPreset.parse(MINIMAL_PRESET);
    const copy = original.clone();

    copy.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive', 0.99);

    expect(original.serialize()).toBe(MINIMAL_PRESET);
    expect(copy.serialize()).not.toBe(MINIMAL_PRESET);
  });

  it('does not let an edit on the original reach a clone', () => {
    const original = HelixPreset.parse(MINIMAL_PRESET);
    const copy = original.clone();

    original.writeEnabled({ dsp: 'dsp0', slot: 'block0' }, false);

    expect(copy.serialize()).toBe(MINIMAL_PRESET);
  });
});

describe('validation separates warnings from errors', () => {
  it.each(presetFixtures())('accepts %s without errors', (name) => {
    expect(validatePreset(HelixPreset.parse(readFixture(name))).errors).toEqual([]);
  });

  it('treats an unknown device as a warning, not a failure', () => {
    // The device list will always lag Line 6's releases. Refusing to edit a
    // preset for a device we have not catalogued would age badly.
    const preset = HelixPreset.parse(MINIMAL_PRESET.replace('2162689', '9999999'));
    const result = validatePreset(preset);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain('unknown-device');
  });

  it('treats an unknown model as no issue at all', () => {
    // The model catalog is proprietary and grows every firmware release.
    const preset = HelixPreset.parse(
      MINIMAL_PRESET.replace('HD2_AmpBrit2204', 'HD2_AmpNotYetReleased'),
    );

    expect(validatePreset(preset).ok).toBe(true);
  });

  it('treats a missing signal chain as an error', () => {
    const preset = HelixPreset.parse('{"data":{"tone":{}},"schema":"L6Preset","version":6}');
    const result = validatePreset(preset);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('no-dsp');
  });

  it('treats two blocks in the same chain position as an error', () => {
    // (@path, @position) was unique across every sampled block, so a clash
    // means the file is genuinely damaged.
    const preset = HelixPreset.parse(
      MINIMAL_PRESET.replace('"@position" : 1', '"@position" : 0'),
    );
    const result = validatePreset(preset);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('duplicate-position');
  });

  it('rejects a setlist file as not a preset', () => {
    // .hls wraps compressed preset data. Reading it as a preset would find no
    // signal chain rather than half-parsing something meaningless.
    const result = validatePreset(HelixPreset.parse(readFixture('hacklabs-setlist.hls')));

    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

function reparse(preset: HelixPreset): HelixPreset {
  return HelixPreset.parse(preset.serialize());
}

/** Pairs of (before, after) for lines that differ. Length-preserving edits only. */
function lineDiff(before: string, after: string): [string, string][] {
  const a = before.split('\n');
  const b = after.split('\n');

  expect(b).toHaveLength(a.length);

  const out: [string, string][] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push([a[i]!, b[i]!]);
  }
  return out;
}
