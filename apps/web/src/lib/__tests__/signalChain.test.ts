import { describe, expect, it } from 'vitest';
import {
  branchLabel,
  cabForBlock,
  changedBlockIds,
  groupChainByPath,
} from '../signalChain';
import type { ChainBlock, DiffEntry } from '../../api/types';

function block(overrides: Partial<ChainBlock> & Pick<ChainBlock, 'id'>): ChainBlock {
  return {
    label: 'Block',
    model: 'HD2_Model',
    role: 'block',
    path: 0,
    position: 0,
    enabled: true,
    cab: null,
    ...overrides,
  };
}

describe('groupChainByPath', () => {
  it('orders blocks by position within a branch, not by array order', () => {
    // Deliberately out of order, mirroring possum where block0 sits at position 2.
    const chain: ChainBlock[] = [
      block({ id: 'dsp0/block2', label: 'Volume Pedal', position: 7 }),
      block({ id: 'dsp0/block0', label: 'Compulsive Drive', position: 2 }),
      block({ id: 'dsp0/block1', label: 'Amp Brit2204', position: 3 }),
    ];

    const [branch] = groupChainByPath(chain);

    expect(branch?.blocks.map((b) => b.label)).toEqual([
      'Compulsive Drive',
      'Amp Brit2204',
      'Volume Pedal',
    ]);
  });

  it('excludes non-block roles and their absent/misleading positions before ordering', () => {
    // A split legitimately reports position 0 and a cab/output report none at
    // all; if the array were sorted before filtering, the split would lead.
    const chain: ChainBlock[] = [
      block({ id: 'dsp0/split', role: 'split', position: 0, path: undefined }),
      block({ id: 'dsp0/block0', role: 'block', position: 2 }),
      block({ id: 'dsp0/cab0', role: 'cab', position: undefined, path: undefined }),
      block({ id: 'dsp0/outputA', role: 'output', position: undefined, path: undefined }),
    ];

    const groups = groupChainByPath(chain);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.blocks).toHaveLength(1);
    expect(groups[0]?.blocks[0]?.id).toBe('dsp0/block0');
  });

  it('reduces the full possum chain to its three playable blocks in signal order', () => {
    // Mirrors the real /api/sessions response for possum.hlx: two DSPs, routing
    // entries with absent path/position (splits/joins keep only a position),
    // and every playable block living on dsp0.
    const chain: ChainBlock[] = [
      block({ id: 'dsp1/split', role: 'split', label: 'App DSP Flow Split Y', position: 0, path: undefined }),
      block({ id: 'dsp1/join', role: 'join', label: 'App DSP Flow Join', position: 8, path: undefined }),
      block({ id: 'dsp1/inputA', role: 'input', label: 'App DSP Flow1 Input', position: undefined, path: undefined }),
      block({ id: 'dsp1/outputA', role: 'output', label: 'App DSP Flow Output', position: undefined, path: undefined }),
      block({ id: 'dsp0/split', role: 'split', label: 'App DSP Flow Split Y', position: 0, path: undefined }),
      block({ id: 'dsp0/block2', role: 'block', label: 'Vol Pan Vol', path: 0, position: 7 }),
      block({ id: 'dsp0/block0', role: 'block', label: 'Dist Compulsive Drive', path: 0, position: 2, enabled: false }),
      block({ id: 'dsp0/block1', role: 'block', label: 'Amp Brit2204', path: 0, position: 3, cab: 'cab0' }),
      block({ id: 'dsp0/join', role: 'join', label: 'App DSP Flow Join', position: 8, path: undefined }),
      block({ id: 'dsp0/cab0', role: 'cab', label: 'Cab4x121960 T75', position: undefined, path: undefined }),
      block({ id: 'dsp0/inputA', role: 'input', label: 'App DSP Flow1 Input', position: undefined, path: undefined }),
      block({ id: 'dsp0/outputA', role: 'output', label: 'App DSP Flow Output', position: undefined, path: undefined }),
    ];

    const groups = groupChainByPath(chain);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.blocks.map((b) => b.label)).toEqual([
      'Dist Compulsive Drive',
      'Amp Brit2204',
      'Vol Pan Vol',
    ]);
    expect(groups[0]?.blocks.every((b) => b.role === 'block')).toBe(true);
  });

  it('groups by path and returns branches in ascending path order', () => {
    const chain: ChainBlock[] = [
      block({ id: 'dsp0/block1', path: 1, position: 1 }),
      block({ id: 'dsp0/block0', path: 0, position: 1 }),
    ];

    const groups = groupChainByPath(chain);

    expect(groups.map((g) => g.path)).toEqual([0, 1]);
  });
});

describe('changedBlockIds', () => {
  it('maps diff entries to their dsp/slot block id', () => {
    const diff: DiffEntry[] = [
      { dsp: 'dsp0', slot: 'block1', label: 'Amp', parameter: 'Master', before: 0.3, after: 0.4 },
      { dsp: 'dsp0', slot: 'block1', label: 'Amp', parameter: 'Bass', before: 0.4, after: 0.5 },
    ];

    const ids = changedBlockIds(diff);

    expect(ids.has('dsp0/block1')).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe('cabForBlock', () => {
  it('resolves the cab paired with an amp block', () => {
    const amp = block({ id: 'dsp0/block1', cab: 'cab0' });
    const cab = block({ id: 'dsp0/cab0', role: 'cab', label: 'Cab 4x12' });
    const chain = [amp, cab];

    expect(cabForBlock(chain, amp)?.label).toBe('Cab 4x12');
  });

  it('returns undefined when the block has no cab', () => {
    const amp = block({ id: 'dsp0/block1', cab: null });
    expect(cabForBlock([amp], amp)).toBeUndefined();
  });
});

describe('branchLabel', () => {
  it('maps path indices to letters', () => {
    expect(branchLabel(0)).toBe('A');
    expect(branchLabel(1)).toBe('B');
  });
});
