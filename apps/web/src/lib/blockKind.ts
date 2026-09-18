import type { ChainBlock } from '../api/types';

/**
 * A short, human-readable family for a Helix block.
 *
 * Helix model ids encode the family in the identifier itself —
 * `HD2_AmpBrit2204`, `HD2_DistScream808`, `HD2_ReverbGanymede` — so this reads
 * it from the id rather than importing `@bender/helix`'s block catalogue. The
 * catalogue carries a curated `category` and would be more precise, but it is
 * ~160 KB of generated data that is currently tree-shaken out of the web
 * bundle, which is far too much weight for a one-word label.
 *
 * Order matters: longer prefixes are tested before the prefixes they contain.
 */
const FAMILIES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['AppDSPFlowSplit', 'Split'],
  ['AppDSPFlowJoin', 'Join'],
  ['AppDSPFlowInput', 'Input'],
  ['AppDSPFlowOutput', 'Output'],
  ['AppDSPFlow', 'Routing'],
  ['CabMicIr', 'IR'],
  ['Cab', 'Cab'],
  ['Amp', 'Amp'],
  ['Dist', 'Distortion'],
  ['Delay', 'Delay'],
  ['Reverb', 'Reverb'],
  ['DynPlate', 'Reverb'],
  ['RetroReel', 'Delay'],
  ['Compressor', 'Compressor'],
  ['Gate', 'Gate'],
  ['EQ', 'EQ'],
  ['Chorus', 'Modulation'],
  ['Flanger', 'Modulation'],
  ['Phaser', 'Modulation'],
  ['Pitch', 'Pitch'],
  ['Preamp', 'Preamp'],
  ['VolPan', 'Volume'],
  ['Wah', 'Wah'],
  ['FXLoop', 'FX loop'],
];

/** Strip the device/firmware prefix: `HD2_AmpBrit2204` -> `AmpBrit2204`. */
function stripPrefix(model: string): string {
  const underscore = model.indexOf('_');
  return underscore === -1 ? model : model.slice(underscore + 1);
}

export function blockKind(block: ChainBlock): string {
  const id = stripPrefix(block.model ?? '');
  for (const [prefix, label] of FAMILIES) {
    if (id.startsWith(prefix)) return label;
  }
  // Nothing matched — say what the server called it rather than guessing.
  return block.role === 'block' ? 'Block' : capitalise(block.role);
}

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}
