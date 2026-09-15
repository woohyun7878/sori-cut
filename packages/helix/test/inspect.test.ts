/**
 * Preset inspection: reading a chain correctly out of a real file.
 */

import { describe, expect, it } from 'vitest';
import { HelixPreset, decodeFirmwareVersion, labelForModel } from '../src/index.js';
import { MINIMAL_PRESET, readFixture } from './helpers.js';

describe('metadata', () => {
  it('reads the envelope of a real preset', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.name).toBe('Possum');
    expect(preset.schema).toBe('L6Preset');
    expect(preset.version).toBe(6);
    expect(preset.device).toBe(2162689);
    expect(preset.deviceName).toBe('Helix Floor / Rack');
    expect(preset.application).toBe('Helix');
  });

  it('decodes packed-BCD firmware versions', () => {
    // 0x03110000 -> 3.11. Every sampled file had both nibbles of every byte
    // <= 9, which is what makes BCD the right reading rather than a guess.
    expect(decodeFirmwareVersion(0x03110000)).toBe('3.11');
    expect(decodeFirmwareVersion(0x02800000)).toBe('2.80');
    expect(decodeFirmwareVersion(0x01000000)).toBe('1.00');
  });

  it('refuses to decode a value that is not valid BCD', () => {
    // 0x0a is not a BCD digit. Returning undefined is better than inventing
    // a version number out of it.
    expect(decodeFirmwareVersion(0x0a110000)).toBeUndefined();
    expect(decodeFirmwareVersion(undefined)).toBeUndefined();
  });

  it('reads firmware from a real preset', () => {
    expect(HelixPreset.parse(readFixture('hacklabs-template.hlx')).firmware).toBe('3.71');
  });
});

describe('blocks', () => {
  it('reads blocks, models and bypass state', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const amp = preset.blockInfo({ dsp: 'dsp0', slot: 'block1' });

    expect(amp?.model).toBe('HD2_AmpBrit2204');
    expect(amp?.label).toBe('Amp Brit2204');
    expect(amp?.enabled).toBe(true);
    expect(amp?.type).toBe(3);
    expect(amp?.cabSlot).toBe('cab0');
  });

  it('separates structural attributes from user-facing parameters', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const amp = preset.blockInfo({ dsp: 'dsp0', slot: 'block1' })!;

    const paramNames = amp.parameters.map((p) => p.name);
    expect(paramNames).toContain('Drive');
    expect(paramNames).toContain('Master');
    expect(paramNames.some((name) => name.startsWith('@'))).toBe(false);

    expect(amp.attributes['@model']).toBe('HD2_AmpBrit2204');
    expect(amp.attributes['@path']).toBe(0);
  });

  it('does not normalize parameter values to 0..1', () => {
    // A widespread misconception about this format. Real values carry real
    // units, and clamping them to 0..1 would destroy presets.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const cab = preset.blockInfo({ dsp: 'dsp0', slot: 'cab0' })!;

    const highCut = cab.parameters.find((p) => p.name === 'HighCut');
    expect(highCut?.value).toBe(20100);

    const input = preset.blockInfo({ dsp: 'dsp0', slot: 'inputA' })!;
    expect(input.parameters.find((p) => p.name === 'threshold')?.value).toBe(-48);
  });

  it('preserves boolean and string parameter types', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const input = preset.blockInfo({ dsp: 'dsp0', slot: 'inputA' })!;

    const gate = input.parameters.find((p) => p.name === 'noiseGate');
    expect(gate?.value).toBe(false);
    expect(gate?.kind).toBe('boolean');
  });

  it('orders blocks by signal flow, not by slot key', () => {
    // A block's key and its @position are independent: block0 sits at
    // position 2 while block1 sits at position 3. Sorting by key would put
    // them in the same order here by luck, so assert on positions directly.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const dsp0 = preset.blocks().filter((b) => b.dsp === 'dsp0' && b.role === 'block');

    const positions = dsp0.map((b) => b.position);
    expect(positions).toEqual([...positions].sort((a, b) => a! - b!));
    expect(dsp0.find((b) => b.slot === 'block0')?.position).toBe(2);
  });

  it('classifies slot roles', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const byRole = (slot: string) => preset.blockInfo({ dsp: 'dsp0', slot })?.role;

    expect(byRole('block0')).toBe('block');
    expect(byRole('cab0')).toBe('cab');
    expect(byRole('inputA')).toBe('input');
    expect(byRole('outputA')).toBe('output');
    expect(byRole('split')).toBe('split');
    expect(byRole('join')).toBe('join');
  });

  it('reads both DSP sections', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.dspKeys()).toEqual(['dsp1', 'dsp0']);
    expect(preset.summary().topology).toEqual({ dsp0: 'A', dsp1: 'A' });
  });
});

describe('model labels', () => {
  it.each([
    ['HD2_AmpEssexA30', 'Amp Essex A30'],
    ['HD2_DistCompulsiveDrive', 'Dist Compulsive Drive'],
    ['HelixStomp_AmpPlaceholder', 'Amp Placeholder'],
    ['HD2_AppDSPFlow1Input', 'App DSP Flow1 Input'],
  ])('labels %s as %s', (model, expected) => {
    expect(labelForModel(model)).toBe(expected);
  });

  it('leaves identifiers without a known prefix alone', () => {
    // A documented minority of models appear under display names rather than
    // prefixed identifiers. Mangling those would be worse than passing through.
    expect(labelForModel('Teemah!')).toBe('Teemah!');
  });

  it('does not invent word breaks inside digit runs', () => {
    // "Cab4x121960T75" is "4x12 1960 Trem 75" to a guitarist, but nothing in
    // the identifier marks where 4x12 ends and 1960 begins. Guessing would
    // render a confidently wrong name, so digit runs stay intact and the UI
    // shows the raw identifier next to the label.
    expect(labelForModel('HD2_Cab4x121960T75')).toBe('Cab4x121960 T75');
    expect(labelForModel('HD2_AmpBrit2204')).toBe('Amp Brit2204');
  });

  it('handles a missing model', () => {
    expect(labelForModel(undefined)).toBe('Unknown');
  });
});

describe('parameter lookup', () => {
  it('finds a parameter by its exact name', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(preset.findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Drive')?.value).toBe(0.62);
  });

  it('tolerates Line 6 spelling drift', () => {
    // The same control is spelled HighCut on one model and "High Cut" on
    // another. Lookups fold case and whitespace; writes still use the file's
    // own key.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const ref = { dsp: 'dsp0', slot: 'cab0' };

    expect(preset.findParameter(ref, 'High Cut')?.name).toBe('HighCut');
    expect(preset.findParameter(ref, 'highcut')?.name).toBe('HighCut');
    expect(preset.findParameter(ref, 'early reflections')?.name).toBe('EarlyReflections');
  });

  it('returns undefined rather than guessing at an unknown parameter', () => {
    const preset = HelixPreset.parse(MINIMAL_PRESET);

    expect(preset.findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Sustain')).toBeUndefined();
  });
});

describe('block resolution', () => {
  it('resolves a fully qualified reference', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.resolveBlock('dsp0/block1')).toEqual({ dsp: 'dsp0', slot: 'block1' });
  });

  it('resolves by model name', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.resolveBlock('HD2_AmpBrit2204')).toEqual({ dsp: 'dsp0', slot: 'block1' });
    expect(preset.resolveBlock('Amp Brit 2204')).toEqual({ dsp: 'dsp0', slot: 'block1' });
  });

  it('refuses to guess when a bare slot name is ambiguous across DSPs', () => {
    // Both dsp0 and dsp1 have a "split". Picking one would be a coin flip,
    // and the caller can disambiguate but a silent wrong answer cannot.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.resolveBlock('split')).toBeUndefined();
    expect(preset.resolveBlock('dsp1/split')).toEqual({ dsp: 'dsp1', slot: 'split' });
  });

  it('returns undefined for an unknown reference', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.resolveBlock('dsp9/block0')).toBeUndefined();
    expect(preset.resolveBlock('NotARealAmp')).toBeUndefined();
  });
});

describe('snapshots and controllers', () => {
  it('reads all snapshot slots in index order', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const snapshots = preset.snapshots();

    expect(snapshots).toHaveLength(8);
    expect(snapshots.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(snapshots[0]?.name).toBe('SNAPSHOT 1');
    expect(preset.currentSnapshot).toBe(0);
  });

  it('reads controller assignments', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const controllers = preset.controllers();

    expect(controllers).toHaveLength(1);
    expect(controllers[0]).toMatchObject({
      dsp: 'dsp0',
      slot: 'block2',
      parameter: 'Pedal',
      controller: 2,
      min: 0.5,
      max: 1,
    });
  });

  it('uses controller assignments as the only in-file source of parameter ranges', () => {
    // The official parameter catalog is proprietary, so a controller's
    // @min/@max is the only place a preset states a parameter's real range.
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const pedal = preset.findParameter({ dsp: 'dsp0', slot: 'block2' }, 'Pedal');

    expect(pedal).toMatchObject({ min: 0.5, max: 1, rangeSource: 'controller' });
  });

  it('leaves ranges undefined when nothing in the file states them', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));
    const drive = preset.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive');

    expect(drive?.min).toBeUndefined();
    expect(drive?.max).toBeUndefined();
  });
});

describe('summary', () => {
  it('reports sections it does not model instead of hiding them', () => {
    const preset = HelixPreset.parse(readFixture('possum.hlx'));

    expect(preset.summary().unmodelledSections).toEqual(['footswitch']);
  });

  it('summarizes an empty preset without inventing content', () => {
    const summary = HelixPreset.parse(readFixture('hacklabs-template.hlx')).summary();

    expect(summary.name).toBe('New Preset');
    expect(summary.blocks.every((b) => b.role !== 'block')).toBe(true);
    expect(summary.controllers).toEqual([]);
  });
});
