/**
 * Compact text renderings of a preset for the model's context window.
 *
 * These exist separately from the inspection tools because they serve a
 * different purpose. The tools return JSON, which is precise and which the
 * model asks for deliberately. This is the always-present background the model
 * reads before it decides what to ask about, so it is prose-shaped and short:
 * every token here is spent on every turn whether it gets used or not.
 */

import type { HelixPreset } from '@bender/helix';

/** Preset identity and anything structurally unusual about it. */
export function describePreset(preset: HelixPreset): string {
  const s = preset.summary();
  const blocks = s.blocks.filter((b) => b.role === 'block');
  const lines: string[] = [];

  lines.push(`Name: ${s.name ?? '(unnamed)'}`);
  lines.push(
    `Device: ${s.deviceName ?? (s.device !== undefined ? `unrecognized (${s.device})` : 'unknown')}` +
      (s.firmware ? `, firmware ${s.firmware}` : ''),
  );
  if (s.tempo !== undefined) lines.push(`Tempo: ${s.tempo} BPM`);
  lines.push(`Blocks: ${blocks.length} across ${s.dsps.length} signal path(s)`);

  const named = s.snapshots.filter((snap) => snap.name);
  if (named.length > 0) {
    lines.push(
      `Snapshots: ${named.map((snap) => `${snap.index}=${snap.name}`).join(', ')}` +
        (s.currentSnapshot !== undefined ? ` (active: ${s.currentSnapshot})` : ''),
    );
  }

  if (s.controllers.length > 0) {
    lines.push(
      `Controller assignments: ${s.controllers.length}. These are the only parameters whose real ` +
        `range the preset states.`,
    );
  }

  // Naming what Bender does not model is more useful to the model than
  // silence, because it explains why some things cannot be inspected.
  if (s.unmodelledSections.length > 0) {
    lines.push(
      `Present but not modelled by Bender (preserved untouched): ${s.unmodelledSections.join(', ')}`,
    );
  }

  return lines.join('\n');
}

/**
 * The chain in signal order.
 *
 * Ordering is by path then position, which is the order the guitar signal
 * actually passes through -- not the order the blocks appear in the file,
 * which is arbitrary.
 */
export function describeChain(preset: HelixPreset): string {
  const blocks = preset.blocks();
  const chain = blocks.filter((b) => b.role === 'block');

  if (chain.length === 0) return 'This preset has no processing blocks.';

  const lines = chain.map((block) => {
    const id = `${block.dsp}/${block.slot}`;
    const path = block.path === 1 ? ' [path B]' : '';
    const state = block.enabled ? '' : ' (BYPASSED)';
    const cab = block.cabSlot ? ` -> cab ${block.cabSlot}` : '';
    return `  ${id}: ${block.label}${path}${state}${cab}`;
  });

  const cabs = blocks.filter((b) => b.role === 'cab');
  if (cabs.length > 0) {
    lines.push(
      ...cabs.map((cab) => `  ${cab.dsp}/${cab.slot}: ${cab.label} (cabinet)${cab.enabled ? '' : ' (BYPASSED)'}`),
    );
  }

  return lines.join('\n');
}
