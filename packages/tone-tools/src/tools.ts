/**
 * The operations Bender's model is allowed to perform.
 *
 * Tool descriptions here are load-bearing. They are the model's only guide to
 * when each operation applies, so they describe *what the tool does* and what
 * it refuses — not tone recipes. Deciding that a thin lead needs more
 * compression is the model's job; making sure the resulting write cannot
 * corrupt the preset is this layer's job.
 *
 * Deliberately absent: anything that rewrites the document wholesale, adds or
 * removes blocks, or changes routing. Those are the operations most likely to
 * produce an invalid preset and least likely to be what a tone request
 * actually needs. They can be added once there is evidence they are required.
 */

import type { BlockInfo, ParamValue } from '@bender/helix';
import type { ToneSession } from './session.js';
import { closestNames } from './validate-args.js';
import type { EditRecord, JsonSchema, ToolDefinition, ToolResult } from './types.js';

const BLOCK_ARG = {
  type: 'string',
  description:
    'Which block to act on. Use the "id" from inspect_signal_chain (for example "dsp0/block2"). ' +
    'A model name works too when only one block uses it.',
} as const;

function schema(
  properties: JsonSchema['properties'],
  required: string[] = Object.keys(properties),
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function fail(
  code: import('./types.js').ToolErrorCode,
  message: string,
  suggestions?: string[],
): ToolResult<never> {
  return { ok: false, warnings: [], error: { code, message, suggestions } };
}

function ok<R>(data: R, warnings: string[] = []): ToolResult<R> {
  return { ok: true, data, warnings };
}

/* ------------------------------------------------------------------ */
/* Shared resolution                                                   */
/* ------------------------------------------------------------------ */

function resolve(
  session: ToneSession,
  reference: string,
): { ok: true; block: BlockInfo } | { ok: false; result: ToolResult<never> } {
  const ref = session.preset.resolveBlock(reference);

  if (!ref) {
    // Suggestions must be things the model can pass straight back. Scoring
    // considers the label, since that is usually what the model guessed at,
    // but what comes back is always the id plus the label for context.
    const candidates = session.preset.blocks().map((b) => ({
      id: `${b.dsp}/${b.slot}`,
      label: b.label,
    }));

    const ranked = closestNames(
      reference,
      candidates.map((c) => `${c.id} ${c.label}`),
    ).map((match) => {
      const found = candidates.find((c) => `${c.id} ${c.label}` === match)!;
      return `${found.id} (${found.label})`;
    });

    return {
      ok: false,
      result: fail(
        'unknown_block',
        `No single block matches "${reference}". Use an id from inspect_signal_chain.`,
        ranked,
      ),
    };
  }

  return { ok: true, block: session.preset.blockInfo(ref)! };
}

/**
 * Check a proposed value against what the preset itself says about the range.
 *
 * Returns an error only when the preset states a range and the value falls
 * outside it. Most parameters have no in-file range, and inventing one from
 * the official catalog is not possible — it is proprietary. Guessing a range
 * would reject legitimate edits, which is worse than allowing an odd one.
 */
function checkRange(
  block: BlockInfo,
  parameter: string,
  value: number,
): { error?: string; warning?: string } {
  const param = block.parameters.find((p) => p.name === parameter);
  if (!param) return {};

  if (param.min !== undefined && value < param.min) {
    return {
      error: `${parameter} on ${block.label} has a stated minimum of ${param.min}; ${value} is below it.`,
    };
  }
  if (param.max !== undefined && value > param.max) {
    return {
      error: `${parameter} on ${block.label} has a stated maximum of ${param.max}; ${value} is above it.`,
    };
  }

  if (param.min === undefined && param.max === undefined) {
    return {
      warning:
        `This preset states no range for ${parameter}, so the value was written as given. ` +
        'Ranges are only known when a controller is assigned to a parameter.',
    };
  }

  return {};
}

function describeBlock(block: BlockInfo) {
  return {
    id: `${block.dsp}/${block.slot}`,
    name: block.label,
    model: block.model,
    kind: block.typeLabel ?? block.role,
    enabled: block.enabled,
    path: block.path === undefined ? undefined : block.path === 0 ? 'A' : 'B',
    position: block.position,
  };
}

function describeParam(param: BlockInfo['parameters'][number]) {
  return {
    name: param.name,
    value: param.value,
    type: param.kind,
    ...(param.min !== undefined || param.max !== undefined
      ? { min: param.min, max: param.max, rangeKnownFrom: param.rangeSource }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

const inspectPreset: ToolDefinition = {
  name: 'inspect_preset',
  description:
    'Overview of the loaded preset: name, device, firmware, tempo, snapshots, and how many blocks ' +
    'it has. Call this first to orient yourself. It does not list parameters — use ' +
    'inspect_signal_chain and inspect_block for those.',
  parameters: schema({}, []),
  readOnly: true,
  execute: (_args, { session }) => {
    const s = session.preset.summary();

    return ok({
      name: s.name ?? '(unnamed)',
      device: s.deviceName ?? (s.device !== undefined ? `unrecognized device ${s.device}` : 'unknown'),
      firmware: s.firmware ?? 'unknown',
      tempo: s.tempo,
      blockCount: s.blocks.filter((b) => b.role === 'block').length,
      signalPaths: s.dsps.length,
      snapshots: s.snapshots.map((snap) => ({ index: snap.index, name: snap.name })),
      activeSnapshot: s.currentSnapshot,
      controllerAssignments: s.controllers.length,
      modified: session.isModified,
      sectionsBenderDoesNotModel: s.unmodelledSections,
    });
  },
};

const inspectSignalChain: ToolDefinition = {
  name: 'inspect_signal_chain',
  description:
    'The signal chain in order, from input to output. Each entry has an "id" to pass to other ' +
    'tools, the block name, what kind of block it is, and whether it is bypassed. Use this to ' +
    'decide which blocks are relevant before inspecting them individually.',
  parameters: schema({}, []),
  readOnly: true,
  execute: (_args, { session }) => {
    const blocks = session.preset.blocks();

    return ok({
      chain: blocks.filter((b) => b.role === 'block').map(describeBlock),
      cabinets: blocks.filter((b) => b.role === 'cab').map(describeBlock),
      io: blocks
        .filter((b) => b.role === 'input' || b.role === 'output')
        .map((b) => ({ ...describeBlock(b), role: b.role })),
    });
  },
};

const inspectBlock: ToolDefinition = {
  name: 'inspect_block',
  description:
    'Every parameter on one block, with its current value and type. Where the preset states a ' +
    'parameter range (which only happens when a controller is assigned to it) the range is ' +
    'included. Call this before changing anything, so you are working from real values rather ' +
    'than assumed ones.',
  parameters: schema({ block: BLOCK_ARG }),
  readOnly: true,
  execute: (args, { session }) => {
    const resolved = resolve(session, args.block as string);
    if (!resolved.ok) return resolved.result;

    const { block } = resolved;
    return ok({
      ...describeBlock(block),
      parameters: block.parameters.map(describeParam),
    });
  },
};

const comparePresets: ToolDefinition = {
  name: 'compare_presets',
  description:
    'Everything that differs between the preset as uploaded and its current state, plus the log ' +
    'of edits made so far. Use this to confirm a change landed as intended, or to check what you ' +
    'have already done before making more changes.',
  parameters: schema({}, []),
  readOnly: true,
  execute: (_args, { session }) => {
    const changes = session.changes();

    return ok({
      modified: session.isModified,
      differences: session.diff(),
      editLog: changes.edits.map((e) => ({
        step: e.sequence,
        tool: e.tool,
        summary: e.summary,
      })),
      warnings: changes.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
    });
  },
};

/* ------------------------------------------------------------------ */
/* Mutation                                                            */
/* ------------------------------------------------------------------ */

function writeParameter(
  session: ToneSession,
  tool: string,
  blockRef: string,
  parameter: string,
  compute: (current: number, block: BlockInfo) => number | { error: string },
  describeChange: (before: ParamValue, after: ParamValue, block: BlockInfo) => string,
): ToolResult<EditRecord | null> {
  const resolved = resolve(session, blockRef);
  if (!resolved.ok) return resolved.result;

  const block = resolved.block;
  const param = session.preset.findParameter(
    { dsp: block.dsp, slot: block.slot },
    parameter,
  );

  if (!param) {
    return fail(
      'unknown_parameter',
      `${block.label} has no parameter called "${parameter}".`,
      closestNames(parameter, block.parameters.map((p) => p.name)),
    );
  }

  if (param.kind !== 'number') {
    return fail(
      'invalid_type',
      `${param.name} on ${block.label} is ${param.kind}, not a number. ` +
        (param.kind === 'boolean'
          ? 'Use enable_block or disable_block if you meant to switch it.'
          : 'It cannot be set numerically.'),
    );
  }

  const next = compute(param.value as number, block);
  if (typeof next === 'object') return fail('out_of_range', next.error);

  if (!Number.isFinite(next)) {
    return fail('invalid_type', `The computed value for ${param.name} is not a finite number.`);
  }

  const range = checkRange(block, param.name, next);
  if (range.error) return fail('out_of_range', range.error);

  if (next === param.value) {
    return ok(null, [`${param.name} on ${block.label} is already ${next}; nothing changed.`]);
  }

  const result = session.transact(tool, (draft) => {
    const ref = { dsp: block.dsp, slot: block.slot };
    const before = draft.writeParameter(ref, param.name, next);
    // Snapshot-controlled parameters live in two places. Missing the mirror
    // means the hardware reverts the edit on the next snapshot recall.
    draft.mirrorParameterIntoActiveSnapshot(ref, param.name, next);

    return {
      tool,
      summary: describeChange(before, next, block),
      target: { dsp: block.dsp, slot: block.slot, label: block.label },
      parameter: param.name,
      before,
      after: next,
    };
  });

  if (!result.ok) return result;
  return { ...result, warnings: [...result.warnings, ...(range.warning ? [range.warning] : [])] };
}

const setParameter: ToolDefinition = {
  name: 'set_parameter',
  description:
    'Set one parameter on one block to an absolute value. Values are in the parameter\'s own ' +
    'units as shown by inspect_block — they are NOT normalized to 0-1. A frequency is in Hz, a ' +
    'threshold is in dB, a time is in seconds. Always inspect the block first so you know the ' +
    'unit and the current value. Rejected if the parameter does not exist, is not numeric, or ' +
    'falls outside a range the preset states.',
  parameters: schema({
    block: BLOCK_ARG,
    parameter: {
      type: 'string',
      description: 'Exact parameter name from inspect_block, for example "Drive" or "HighCut".',
    },
    value: { type: 'number', description: 'The new value, in the parameter\'s own units.' },
  }),
  readOnly: false,
  execute: (args, { session }) =>
    writeParameter(
      session,
      'set_parameter',
      args.block as string,
      args.parameter as string,
      () => args.value as number,
      (before, after, block) => `${block.label}: ${args.parameter} ${before} -> ${after}`,
    ),
};

const adjustParameter: ToolDefinition = {
  name: 'adjust_parameter',
  description:
    'Change one parameter by a relative amount rather than setting it absolutely. Use this when ' +
    'you want "a bit more" of something without needing to know the exact scale — for example ' +
    'amount 0.05 to nudge a 0-1 style control up slightly, or -500 to lower a cutoff by 500 Hz. ' +
    'Prefer this over set_parameter when the intent is directional, because it cannot accidentally ' +
    'jump a value to the wrong end of an unfamiliar scale.',
  parameters: schema({
    block: BLOCK_ARG,
    parameter: { type: 'string', description: 'Exact parameter name from inspect_block.' },
    amount: {
      type: 'number',
      description: 'Amount to add. Negative subtracts. In the parameter\'s own units.',
    },
  }),
  readOnly: false,
  execute: (args, { session }) =>
    writeParameter(
      session,
      'adjust_parameter',
      args.block as string,
      args.parameter as string,
      (current) => cleanFloat(current + (args.amount as number)),
      (before, after, block) =>
        `${block.label}: ${args.parameter} ${before} -> ${after} (${
          (args.amount as number) >= 0 ? '+' : ''
        }${args.amount})`,
    ),
};

/**
 * Strip IEEE-754 noise from a relative adjustment.
 *
 * `0.6 - 0.05` is `0.5499999999999999`, and that value was being written
 * straight into the user's preset -- a sixteen-decimal number replacing a value
 * the original file wrote as `0.6`. It is numerically fine and it looks broken,
 * both in the diff we show the user and in the file they open in HX Edit.
 *
 * Twelve significant digits is far beyond any control's real resolution while
 * still being wide enough for the large-magnitude parameters in this format
 * (`HighCut` runs to 20100 Hz), so it removes the artifact without rounding
 * away anything a model could legitimately have asked for.
 */
function cleanFloat(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number.parseFloat(value.toPrecision(12));
}

function setBypass(session: ToneSession, blockRef: string, enabled: boolean): ToolResult<EditRecord | null> {
  const resolved = resolve(session, blockRef);
  if (!resolved.ok) return resolved.result;

  const block = resolved.block;
  const tool = enabled ? 'enable_block' : 'disable_block';

  if (block.enabled === enabled) {
    return ok(null, [
      `${block.label} is already ${enabled ? 'enabled' : 'bypassed'}; nothing changed.`,
    ]);
  }

  return session.transact(tool, (draft) => {
    const before = draft.writeEnabled({ dsp: block.dsp, slot: block.slot }, enabled);

    return {
      tool,
      summary: `${block.label} ${enabled ? 'enabled' : 'bypassed'}`,
      target: { dsp: block.dsp, slot: block.slot, label: block.label },
      parameter: 'Bypass',
      before: before === undefined ? undefined : before ? 'on' : 'bypassed',
      after: enabled ? 'on' : 'bypassed',
    };
  });
}

const enableBlock: ToolDefinition = {
  name: 'enable_block',
  description:
    'Bring a bypassed block back into the signal path. Bypass state is stored in two places in a ' +
    'Helix preset and this writes both, so the change survives a snapshot recall on hardware.',
  parameters: schema({ block: BLOCK_ARG }),
  readOnly: false,
  execute: (args, { session }) => setBypass(session, args.block as string, true),
};

const disableBlock: ToolDefinition = {
  name: 'disable_block',
  description:
    'Bypass a block so it no longer affects the signal. The block and all its settings are kept, ' +
    'so this is reversible and non-destructive. Prefer bypassing over zeroing a block\'s ' +
    'parameters, because it preserves the user\'s settings.',
  parameters: schema({ block: BLOCK_ARG }),
  readOnly: false,
  execute: (args, { session }) => setBypass(session, args.block as string, false),
};

const undoLastChange: ToolDefinition = {
  name: 'undo_last_change',
  description:
    'Revert the most recent edit. Use this when you have inspected the result of a change and ' +
    'decided it was wrong. The user also has their own undo control, so prefer explaining a ' +
    'questionable change over silently undoing it.',
  parameters: schema({}, []),
  readOnly: false,
  execute: (_args, { session }) => {
    const result = session.undo();
    if (!result.ok) return result;

    return ok({ undone: result.data.summary, remainingEdits: session.edits.length });
  },
};

/* ------------------------------------------------------------------ */

export const TOOLS: ToolDefinition[] = [
  inspectPreset,
  inspectSignalChain,
  inspectBlock,
  comparePresets,
  setParameter,
  adjustParameter,
  enableBlock,
  disableBlock,
  undoLastChange,
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);
