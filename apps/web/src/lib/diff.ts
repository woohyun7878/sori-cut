/**
 * Diff shaping for the changes panel.
 *
 * The server's diff is a flat list of changed parameters. Grouping by block
 * lets the UI show "what changed on the amp" as one unit, which is how a
 * player thinks about it.
 */

import type { DiffEntry } from '../api/types';

export interface DiffGroup {
  /** Stable id, `dsp/slot`. */
  id: string;
  label: string;
  changes: DiffEntry[];
}

/** Group changed parameters by their block, preserving first-seen order. */
export function groupDiffByBlock(diff: DiffEntry[]): DiffGroup[] {
  const groups: DiffGroup[] = [];
  const byId = new Map<string, DiffGroup>();

  for (const entry of diff) {
    const id = `${entry.dsp}/${entry.slot}`;
    let group = byId.get(id);
    if (!group) {
      group = { id, label: entry.label, changes: [] };
      byId.set(id, group);
      groups.push(group);
    }
    group.changes.push(entry);
  }

  return groups;
}

/** Render a diff value for display, tolerating nulls and booleans. */
export function formatDiffValue(value: DiffEntry['before']): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}
