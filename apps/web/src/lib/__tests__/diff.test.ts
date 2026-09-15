import { describe, expect, it } from 'vitest';
import { formatDiffValue, groupDiffByBlock } from '../diff';
import type { DiffEntry } from '../../api/types';

const diff: DiffEntry[] = [
  { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204', parameter: 'Master', before: 0.36, after: 0.48 },
  { dsp: 'dsp0', slot: 'block0', label: 'Compulsive Drive', parameter: 'Gain', before: 0.66, after: 0.7 },
  { dsp: 'dsp0', slot: 'block1', label: 'Amp Brit2204', parameter: 'Bass', before: 0.4, after: 0.5 },
];

describe('groupDiffByBlock', () => {
  it('groups changes by block, preserving first-seen order', () => {
    const groups = groupDiffByBlock(diff);

    expect(groups.map((g) => g.label)).toEqual(['Amp Brit2204', 'Compulsive Drive']);
    expect(groups[0]?.changes.map((c) => c.parameter)).toEqual(['Master', 'Bass']);
    expect(groups[1]?.changes).toHaveLength(1);
  });

  it('returns an empty array for an empty diff', () => {
    expect(groupDiffByBlock([])).toEqual([]);
  });
});

describe('formatDiffValue', () => {
  it('renders a placeholder for missing values', () => {
    expect(formatDiffValue(null)).toBe('—');
  });

  it('renders booleans as on/off', () => {
    expect(formatDiffValue(true)).toBe('on');
    expect(formatDiffValue(false)).toBe('off');
  });

  it('renders numbers and strings verbatim', () => {
    expect(formatDiffValue(0.48)).toBe('0.48');
    expect(formatDiffValue('bypassed')).toBe('bypassed');
  });
});
