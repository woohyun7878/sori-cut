/**
 * Structural validation for Helix presets.
 *
 * Validation separates two very different things:
 *
 *   errors    the document is structurally wrong and Helix will likely
 *             reject it, or Bender would corrupt it by editing
 *   warnings  something is unfamiliar but harmless, usually a device,
 *             firmware or model we have not seen
 *
 * Unfamiliar is not invalid. The Helix model catalog is proprietary and grows
 * with every firmware release, so an unknown `@model` must never block an
 * edit. Only genuine structural impossibilities are errors.
 */

import { getMember, getPath, isNumber, isObject, isString, keysOf, type JsonNode } from '../json/ast.js';
import { DEVICE_NAMES } from './types.js';
import type { HelixPreset } from './preset.js';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Dotted path into the document, when the issue is localized. */
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function validatePreset(preset: HelixPreset): ValidationResult {
  const issues: ValidationIssue[] = [];
  const doc = preset.document;

  validateEnvelope(preset, doc, issues);
  validateRouting(preset, issues);
  validateSnapshotMirrors(preset, issues);

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return { ok: errors.length === 0, errors, warnings };
}

function validateEnvelope(
  preset: HelixPreset,
  doc: JsonNode,
  issues: ValidationIssue[],
): void {
  const schema = getMember(doc, 'schema');
  if (!isString(schema)) {
    issues.push({
      severity: 'error',
      code: 'missing-schema',
      message: 'Missing top-level "schema". This does not look like a Helix preset.',
      path: 'schema',
    });
  } else if (schema.value !== 'L6Preset') {
    issues.push({
      severity: 'warning',
      code: 'unexpected-schema',
      message: `Unexpected schema "${schema.value}". Only "L6Preset" has been verified.`,
      path: 'schema',
    });
  }

  const version = getMember(doc, 'version');
  if (isNumber(version) && version.value !== 6) {
    issues.push({
      severity: 'warning',
      code: 'unexpected-version',
      message: `Preset format version ${version.value}; only version 6 has been verified.`,
      path: 'version',
    });
  }

  if (!isObject(getMember(doc, 'data'))) {
    issues.push({
      severity: 'error',
      code: 'missing-data',
      message: 'Missing top-level "data" object.',
      path: 'data',
    });
    return;
  }

  if (!isObject(getPath(doc, 'data', 'tone'))) {
    issues.push({
      severity: 'error',
      code: 'missing-tone',
      message: 'Missing "data.tone". Bender cannot read the signal chain.',
      path: 'data.tone',
    });
  }

  const device = preset.device;
  if (device === undefined) {
    issues.push({
      severity: 'warning',
      code: 'missing-device',
      message: 'Missing "data.device". Bender cannot confirm which hardware this targets.',
      path: 'data.device',
    });
  } else if (!(device in DEVICE_NAMES)) {
    issues.push({
      severity: 'warning',
      code: 'unknown-device',
      message:
        `Unrecognized device id ${device}. Editing should still be safe, but Bender ` +
        'cannot reason about device-specific limits.',
      path: 'data.device',
    });
  }

  if (preset.dspKeys().length === 0) {
    issues.push({
      severity: 'error',
      code: 'no-dsp',
      message: 'No "dspN" sections found in data.tone. There is no signal chain to edit.',
      path: 'data.tone',
    });
  }
}

/**
 * Check that `(@path, @position)` is unique within each DSP.
 *
 * This pair, not the slot key, defines signal order. A clash means two blocks
 * claim the same place in the chain and any reordering would be ambiguous.
 * Verified unique across 882 of 882 sampled blocks, so a clash indicates a
 * genuinely damaged file.
 */
function validateRouting(preset: HelixPreset, issues: ValidationIssue[]): void {
  for (const dsp of preset.dspKeys()) {
    const seen = new Map<string, string>();

    for (const block of preset.blocks()) {
      if (block.dsp !== dsp || block.role !== 'block') continue;
      if (block.path === undefined || block.position === undefined) continue;

      const key = `${block.path}:${block.position}`;
      const existing = seen.get(key);

      if (existing) {
        issues.push({
          severity: 'error',
          code: 'duplicate-position',
          message:
            `${dsp}/${block.slot} and ${dsp}/${existing} both occupy path ` +
            `${block.path} position ${block.position}.`,
          path: `data.tone.${dsp}.${block.slot}`,
        });
      } else {
        seen.set(key, block.slot);
      }
    }
  }
}

/**
 * Check that the active snapshot agrees with the blocks it mirrors.
 *
 * Bypass state is stored in two places: on the block as `@enabled`, and in
 * `snapshotN.blocks[dsp][slot]` for the snapshot named by
 * `global.@current_snapshot`. Across 24 sampled presets these agreed with zero
 * exceptions, so disagreement means an edit wrote only one of the two and the
 * hardware will revert it on the next snapshot recall.
 */
function validateSnapshotMirrors(preset: HelixPreset, issues: ValidationIssue[]): void {
  const index = preset.currentSnapshot;
  if (index === undefined) return;

  const tone = getPath(preset.document, 'data', 'tone');
  const snapshot = getMember(tone, `snapshot${index}`);
  if (!isObject(snapshot)) {
    issues.push({
      severity: 'warning',
      code: 'missing-active-snapshot',
      message: `global.@current_snapshot is ${index} but snapshot${index} is absent.`,
      path: 'data.tone.global.@current_snapshot',
    });
    return;
  }

  const blocks = getMember(snapshot, 'blocks');
  if (!isObject(blocks)) return;

  for (const dsp of keysOf(blocks)) {
    const dspBlocks = getMember(blocks, dsp);
    if (!isObject(dspBlocks)) continue;

    for (const entry of dspBlocks.entries) {
      if (entry.value.kind !== 'boolean') continue;

      const info = preset.blockInfo({ dsp, slot: entry.key });
      if (!info || info.enabled === undefined) continue;

      if (info.enabled !== entry.value.value) {
        issues.push({
          severity: 'error',
          code: 'snapshot-bypass-mismatch',
          message:
            `${dsp}/${entry.key} is ${info.enabled ? 'enabled' : 'bypassed'} on the block but ` +
            `${entry.value.value ? 'enabled' : 'bypassed'} in the active snapshot${index}. ` +
            'The hardware will revert this on snapshot recall.',
          path: `data.tone.snapshot${index}.blocks.${dsp}.${entry.key}`,
        });
      }
    }
  }
}

/** Format a validation result for a log line or CLI output. */
export function formatValidation(result: ValidationResult): string {
  if (result.ok && result.warnings.length === 0) return 'Preset validated with no issues.';

  const lines: string[] = [];
  for (const issue of [...result.errors, ...result.warnings]) {
    const where = issue.path ? ` (${issue.path})` : '';
    lines.push(`${issue.severity.toUpperCase()} [${issue.code}]${where}: ${issue.message}`);
  }
  return lines.join('\n');
}
