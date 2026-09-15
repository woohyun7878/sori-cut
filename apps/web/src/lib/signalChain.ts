/**
 * Signal-chain shaping for the UI.
 *
 * The server returns every slot — amps, cabs, inputs, outputs, splits, joins —
 * flattened and already ordered by signal flow. The chain view shows the
 * musical blocks a guitarist reasons about, grouped by branch and ordered by
 * the block's own `position` (which is deliberately not the array order).
 */

import type { ChainBlock, DiffEntry } from '../api/types';

export interface ChainBranch {
  /** 0 = branch A, 1 = branch B. */
  path: number;
  blocks: ChainBlock[];
}

/**
 * Group the playable blocks by branch, each branch ordered by position.
 *
 * Only `role === 'block'` entries are shown; cabs are surfaced against their
 * amp, and structural I/O / split / join slots are routing plumbing rather
 * than something a player tweaks. Those routing slots also carry an absent (or,
 * for a split, a misleading `0`) position, so filtering by role first is what
 * keeps them from reordering the chain.
 */
export function groupChainByPath(chain: ChainBlock[]): ChainBranch[] {
  const byPath = new Map<number, ChainBlock[]>();

  for (const block of chain) {
    if (block.role !== 'block' || block.path === undefined || block.position === undefined) {
      continue;
    }
    const bucket = byPath.get(block.path);
    if (bucket) bucket.push(block);
    else byPath.set(block.path, [block]);
  }

  return [...byPath.entries()]
    .sort(([a], [b]) => a - b)
    .map(([path, blocks]) => ({
      path,
      blocks: [...blocks].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    }));
}

/** The set of block ids (`dsp/slot`) touched by the current diff. */
export function changedBlockIds(diff: DiffEntry[]): Set<string> {
  return new Set(diff.map((entry) => `${entry.dsp}/${entry.slot}`));
}

/** The cab paired with an amp block, if the chain carries it separately. */
export function cabForBlock(chain: ChainBlock[], block: ChainBlock): ChainBlock | undefined {
  if (!block.cab) return undefined;
  const dsp = block.id.split('/')[0];
  const cabId = `${dsp}/${block.cab}`;
  return chain.find((entry) => entry.id === cabId);
}

/** "A" for path 0, "B" for path 1, and so on. */
export function branchLabel(path: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + path);
}
