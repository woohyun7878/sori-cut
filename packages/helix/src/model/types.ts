/**
 * Typed view over a parsed Helix preset.
 *
 * Every claim encoded here traces to evidence recorded in
 * docs/helix-format-notes.md. Where the format is uncertain the types stay
 * permissive rather than asserting structure we have not verified.
 */

import { MODEL_NAMES } from './model-names.generated.js';

/** Value of a block parameter. Helix parameters are NOT normalized 0..1. */
export type ParamValue = number | boolean | string;

export type ParamKind = 'number' | 'boolean' | 'string';

export interface ParamInfo {
  /** Exact key as it appears in the file. Always write back using this. */
  name: string;
  value: ParamValue;
  kind: ParamKind;
  /**
   * Real range, when the preset itself reveals it.
   *
   * A controller assignment records the parameter's true display-unit min and
   * max. That is the only in-file source of range information, since the
   * official parameter catalog is proprietary.
   */
  min?: number;
  max?: number;
  /** True when a controller assignment supplied the range. */
  rangeSource?: 'controller';
}

/**
 * Block category codes seen in `@type`.
 *
 * Derived from one credible source and consistent with our samples, but not
 * exhaustively verified; a second public implementation publishes a
 * contradictory table. Treated as a hint, never as a constraint.
 */
export const BLOCK_TYPE_LABELS: Record<number, string> = {
  0: 'Effect',
  1: 'Amp',
  2: 'Cab',
  3: 'Amp + Cab',
  4: 'Dual Cab',
  5: 'Impulse Response',
  6: 'Looper',
  7: 'Delay / Reverb',
};

/** Structural role of a slot inside a `dspN` object. */
export type SlotRole = 'block' | 'cab' | 'input' | 'output' | 'split' | 'join' | 'unknown';

export interface BlockRef {
  /** DSP container key, e.g. "dsp0". */
  dsp: string;
  /** Slot key within the DSP, e.g. "block3" or "cab0". */
  slot: string;
}

export interface BlockInfo extends BlockRef {
  role: SlotRole;
  /**
   * Model identifier, e.g. "HD2_AmpEssexA30".
   *
   * Prefixes vary (`HD2_`, `HelixStomp_`, `HelixFx_`, `VIC_`, `L6SPB_`,
   * bare). Never assume a prefix. A few models appear under display names.
   */
  model?: string;
  /** Human-readable name derived from the model identifier. */
  label: string;
  /** Bypass state. `true` means the block is active. */
  enabled?: boolean;
  /** `0` = upper branch A, `1` = lower branch B. */
  path?: number;
  /** Slot index within its branch. NOT a global index, and NOT derivable from `slot`. */
  position?: number;
  /** Raw `@type` code, if present. */
  type?: number;
  /** Category label derived from `@type`, if recognized. */
  typeLabel?: string;
  /** Sibling slot key holding this amp's cab, e.g. "cab0". */
  cabSlot?: string;
  parameters: ParamInfo[];
  /** `@`-prefixed keys that are structural rather than user-facing parameters. */
  attributes: Record<string, ParamValue>;
}

export interface SnapshotInfo {
  /** Slot key, e.g. "snapshot0". */
  slot: string;
  index: number;
  name?: string;
  /** Helix marks unused snapshot slots with `@valid: false`. */
  valid: boolean;
  tempo?: number;
}

export interface ControllerAssignment {
  dsp: string;
  slot: string;
  parameter: string;
  controller: number;
  min?: number;
  max?: number;
}

export interface PresetSummary {
  name?: string;
  /** Device identifier from `data.device`, e.g. 2162694. */
  device?: number;
  /** Friendly device name, when the identifier is recognized. */
  deviceName?: string;
  /** Decoded firmware version, e.g. "3.11". */
  firmware?: string;
  /** Format schema string; expected to be "L6Preset". */
  schema?: string;
  /** Format version; expected to be 6. */
  version?: number;
  application?: string;
  tempo?: number;
  /** DSP container keys present, in source order. */
  dsps: string[];
  blocks: BlockInfo[];
  snapshots: SnapshotInfo[];
  currentSnapshot?: number;
  controllers: ControllerAssignment[];
  /** Routing topology strings per DSP, e.g. "SABJ". May be a number. */
  topology: Record<string, string | number>;
  /** Sections present in `data.tone` that Bender does not model. */
  unmodelledSections: string[];
}

/**
 * Device identifiers observed in real presets.
 *
 * A preset for one device will not load on another.
 */
export const DEVICE_NAMES: Record<number, string> = {
  2162689: 'Helix Floor / Rack',
  2162690: 'Helix (2nd hardware variant)',
  2162692: 'Helix LT',
  2162693: 'HX Effects',
  2162694: 'HX Stomp',
  2162695: 'POD Go',
  2162696: 'POD Go (variant B)',
  2162699: 'HX Stomp XL',
  2162944: 'Helix Native',
  2359298: 'Yamaha THR-II',
  2424834: 'Line 6 Catalyst',
  2490368: 'Helix Stadium',
};

/**
 * Decode a packed-BCD firmware version such as 0x03110000 -> "3.11".
 *
 * Verified BCD in 110 of 110 sampled files: every byte had both nibbles <= 9.
 * Returns undefined when the value is not valid BCD, rather than guessing.
 */
export function decodeFirmwareVersion(raw: number | undefined): string | undefined {
  if (raw === undefined || !Number.isInteger(raw) || raw < 0) return undefined;

  const bytes = [(raw >>> 24) & 0xff, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff];
  for (const byte of bytes) {
    if ((byte & 0x0f) > 9 || ((byte >> 4) & 0x0f) > 9) return undefined;
  }

  const bcd = (byte: number): string => `${(byte >> 4) & 0x0f}${byte & 0x0f}`;
  const major = Number(bcd(bytes[0]!));
  const minor = bcd(bytes[1]!);
  const build = `${bcd(bytes[2]!)}${bcd(bytes[3]!)}`;

  return build === '0000' ? `${major}.${minor}` : `${major}.${minor} build ${build}`;
}

/** Classify a slot key inside a `dspN` object. */
export function slotRole(slot: string): SlotRole {
  if (/^block\d+$/.test(slot)) return 'block';
  if (/^cab\d+$/.test(slot)) return 'cab';
  if (/^input[A-Z]$/.test(slot)) return 'input';
  if (/^output[A-Z]$/.test(slot)) return 'output';
  if (slot === 'split') return 'split';
  if (slot === 'join') return 'join';
  return 'unknown';
}

/**
 * Derive a readable label from a Helix model identifier.
 *
 * "HD2_AmpEssexA30" -> "Amp Essex A30". Identifiers that are already display
 * names (a documented minority) pass through unchanged.
 *
 * A curated name wins when one exists. Line 6 does not publish a model
 * catalogue, so names are recorded by hand in
 * `packages/helix/data/model-names.json` as they are confirmed against real
 * hardware, and `pnpm helix:catalogue` compiles them in.
 *
 * Without one, the fallback is deliberately conservative. Splitting on case
 * boundaries is a real signal; splitting on digit boundaries is not.
 * `Cab4x121960T75` is "4x12 1960 Trem 75" to a guitarist, but nothing in the
 * identifier says where `4x12` ends and `1960` begins. Rather than guess and
 * render something wrong, the label keeps digit runs intact and the UI shows
 * the raw identifier alongside it.
 */
export function labelForModel(model: string | undefined): string {
  if (!model) return 'Unknown';

  const curated = MODEL_NAMES[model]?.label;
  if (curated) return curated;

  const withoutPrefix = model.replace(
    /^(HD2|HelixStomp|HelixFx|Helix|VIC|Victoria|L6SPB|P34)_/,
    '',
  );
  if (withoutPrefix !== model && withoutPrefix.length === 0) return model;

  const spaced = withoutPrefix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();

  return spaced.length > 0 ? spaced : model;
}

/**
 * Normalize a parameter name for lookup.
 *
 * Line 6's own spelling drifts between models and firmware eras: the same
 * control appears as `HighCut` and `High Cut`, `EarlyReflections` and
 * `Early Reflections`. Lookups fold case and strip whitespace; writes always
 * use the exact key already present in the file.
 */
export function normalizeParamName(name: string): string {
  return name.replace(/[\s_-]/g, '').toLowerCase();
}
