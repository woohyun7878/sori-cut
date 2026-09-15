/**
 * The Helix preset document.
 *
 * `HelixPreset` owns the parsed JSON AST and exposes typed reads and guarded
 * writes over it. The AST is the source of truth; the typed views are derived
 * on demand. Edits mutate the AST in place through narrow accessors, so
 * anything Bender does not model survives untouched.
 */

import {
  cloneNode,
  getMember,
  getPath,
  isNumber,
  isObject,
  isString,
  jsonNumberLike,
  keysOf,
  setMember,
  type JsonNode,
  type JsonObject,
} from '../json/ast.js';
import { parseJson } from '../json/parse.js';
import { stringifyJson } from '../json/stringify.js';
import { detectStyle, type JsonStyle } from '../json/style.js';
import {
  BLOCK_TYPE_LABELS,
  DEVICE_NAMES,
  decodeFirmwareVersion,
  labelForModel,
  normalizeParamName,
  slotRole,
  type BlockInfo,
  type BlockRef,
  type ControllerAssignment,
  type ParamInfo,
  type ParamValue,
  type PresetSummary,
  type SnapshotInfo,
} from './types.js';

/** Sections of `data.tone` that Bender understands. Everything else is preserved as-is. */
const MODELLED_TONE_SECTIONS = new Set(['global', 'controller']);

export class HelixPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelixPresetError';
  }
}

export class HelixPreset {
  private constructor(
    private readonly root: JsonNode,
    private readonly style: JsonStyle,
    /** Exact bytes this preset was parsed from, when it came from a file. */
    readonly source: string | undefined,
  ) {}

  /**
   * Parse a `.hlx` document.
   *
   * Accepts any JSON document. Presets that do not look like `L6Preset` are
   * still parsed, because refusing to open a file we could read is worse than
   * warning about it; call `validate()` to learn what is suspicious.
   */
  static parse(text: string): HelixPreset {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const root = parseJson(withoutBom);

    if (!isObject(root)) {
      throw new HelixPresetError('A Helix preset must be a JSON object');
    }

    return new HelixPreset(root, detectStyle(withoutBom), withoutBom);
  }

  /** Serialize back to `.hlx` text, reproducing untouched values byte for byte. */
  serialize(): string {
    return stringifyJson(this.root, this.style);
  }

  /** Deep copy. Undo and transactional edits rely on this being complete. */
  clone(): HelixPreset {
    return new HelixPreset(cloneNode(this.root), { ...this.style }, this.source);
  }

  /* -------------------------------------------------------------- */
  /* Raw access                                                      */
  /* -------------------------------------------------------------- */

  /** The root AST node. Prefer the typed accessors below. */
  get document(): JsonNode {
    return this.root;
  }

  private get data(): JsonNode | undefined {
    return getMember(this.root, 'data');
  }

  private get tone(): JsonNode | undefined {
    return getPath(this.root, 'data', 'tone');
  }

  /** DSP container keys present in `data.tone`, in source order. */
  dspKeys(): string[] {
    return keysOf(this.tone).filter((key) => /^dsp\d+$/.test(key));
  }

  /** Slot keys within a DSP container, in source order. */
  slotKeys(dsp: string): string[] {
    return keysOf(getMember(this.tone, dsp));
  }

  /** The raw AST object for a slot, or undefined if it does not exist. */
  slotNode(ref: BlockRef): JsonObject | undefined {
    const node = getPath(this.tone, ref.dsp, ref.slot);
    return isObject(node) ? node : undefined;
  }

  /* -------------------------------------------------------------- */
  /* Metadata                                                        */
  /* -------------------------------------------------------------- */

  get name(): string | undefined {
    const node = getPath(this.data, 'meta', 'name');
    return isString(node) ? node.value : undefined;
  }

  get schema(): string | undefined {
    const node = getMember(this.root, 'schema');
    return isString(node) ? node.value : undefined;
  }

  get version(): number | undefined {
    const node = getMember(this.root, 'version');
    return isNumber(node) ? node.value : undefined;
  }

  get device(): number | undefined {
    const node = getMember(this.data, 'device');
    return isNumber(node) ? node.value : undefined;
  }

  get deviceName(): string | undefined {
    const id = this.device;
    return id === undefined ? undefined : DEVICE_NAMES[id];
  }

  get firmware(): string | undefined {
    const node = getMember(this.data, 'device_version');
    return isNumber(node) ? decodeFirmwareVersion(node.value) : undefined;
  }

  get application(): string | undefined {
    const node = getPath(this.data, 'meta', 'application');
    return isString(node) ? node.value : undefined;
  }

  get tempo(): number | undefined {
    const node = getPath(this.tone, 'global', '@tempo');
    return isNumber(node) ? node.value : undefined;
  }

  get currentSnapshot(): number | undefined {
    const node = getPath(this.tone, 'global', '@current_snapshot');
    return isNumber(node) ? node.value : undefined;
  }

  /* -------------------------------------------------------------- */
  /* Blocks                                                          */
  /* -------------------------------------------------------------- */

  /**
   * Every slot in every DSP, ordered by signal flow.
   *
   * Ordering uses `(@path, @position)`, which is unique within a DSP. The slot
   * key is deliberately not used for ordering: `block5` may carry
   * `@position: 6`, and deriving one from the other moves blocks around.
   */
  blocks(): BlockInfo[] {
    const out: BlockInfo[] = [];

    for (const dsp of this.dspKeys()) {
      const dspNode = getMember(this.tone, dsp);
      if (!isObject(dspNode)) continue;

      const inDsp: BlockInfo[] = [];
      for (const slot of keysOf(dspNode)) {
        const info = this.blockInfo({ dsp, slot });
        if (info) inDsp.push(info);
      }

      inDsp.sort(compareBySignalFlow);
      out.push(...inDsp);
    }

    return out;
  }

  /** Typed view of one slot, or undefined if the slot does not exist. */
  blockInfo(ref: BlockRef): BlockInfo | undefined {
    const node = this.slotNode(ref);
    if (!node) return undefined;

    const attributes: Record<string, ParamValue> = {};
    const parameters: ParamInfo[] = [];

    for (const entry of node.entries) {
      const scalar = scalarValue(entry.value);
      if (scalar === undefined) continue;

      if (entry.key.startsWith('@')) {
        attributes[entry.key] = scalar;
      } else {
        parameters.push({
          name: entry.key,
          value: scalar,
          kind: typeof scalar as ParamInfo['kind'],
        });
      }
    }

    this.applyControllerRanges(ref, parameters);

    const model = typeof attributes['@model'] === 'string' ? attributes['@model'] : undefined;
    const type = typeof attributes['@type'] === 'number' ? attributes['@type'] : undefined;

    return {
      ...ref,
      role: slotRole(ref.slot),
      model,
      label: labelForModel(model),
      enabled:
        typeof attributes['@enabled'] === 'boolean' ? attributes['@enabled'] : undefined,
      path: typeof attributes['@path'] === 'number' ? attributes['@path'] : undefined,
      position: typeof attributes['@position'] === 'number' ? attributes['@position'] : undefined,
      type,
      typeLabel: type === undefined ? undefined : BLOCK_TYPE_LABELS[type],
      cabSlot: typeof attributes['@cab'] === 'string' ? attributes['@cab'] : undefined,
      parameters,
      attributes,
    };
  }

  /**
   * Find a parameter by name, tolerating Line 6's own spelling drift.
   *
   * Returns the exact key present in the file, which is what a write must use.
   */
  findParameter(ref: BlockRef, name: string): ParamInfo | undefined {
    const info = this.blockInfo(ref);
    if (!info) return undefined;

    const exact = info.parameters.find((p) => p.name === name);
    if (exact) return exact;

    const wanted = normalizeParamName(name);
    return info.parameters.find((p) => normalizeParamName(p.name) === wanted);
  }

  /**
   * Resolve a slot from a loose reference.
   *
   * Accepts "dsp0/block3", "block3" (searched across DSPs), or a model name.
   * Returns undefined when the reference is ambiguous or unmatched, so callers
   * can reject rather than guess.
   */
  resolveBlock(reference: string): BlockRef | undefined {
    const trimmed = reference.trim();

    const qualified = /^(dsp\d+)[/.](.+)$/.exec(trimmed);
    if (qualified) {
      const ref = { dsp: qualified[1]!, slot: qualified[2]! };
      return this.slotNode(ref) ? ref : undefined;
    }

    const bySlot = this.blocks().filter((b) => b.slot === trimmed);
    if (bySlot.length === 1) return { dsp: bySlot[0]!.dsp, slot: bySlot[0]!.slot };

    const wanted = normalizeParamName(trimmed);
    const byModel = this.blocks().filter(
      (b) =>
        (b.model && normalizeParamName(b.model) === wanted) ||
        normalizeParamName(b.label) === wanted,
    );
    if (byModel.length === 1) return { dsp: byModel[0]!.dsp, slot: byModel[0]!.slot };

    return undefined;
  }

  /* -------------------------------------------------------------- */
  /* Snapshots and controllers                                       */
  /* -------------------------------------------------------------- */

  snapshots(): SnapshotInfo[] {
    const out: SnapshotInfo[] = [];

    for (const key of keysOf(this.tone)) {
      const match = /^snapshot(\d+)$/.exec(key);
      if (!match) continue;

      const node = getMember(this.tone, key);
      const nameNode = getMember(node, '@name');
      const validNode = getMember(node, '@valid');
      const tempoNode = getMember(node, '@tempo');

      out.push({
        slot: key,
        index: Number(match[1]),
        name: isString(nameNode) ? nameNode.value : undefined,
        // Absence of @valid is treated as valid; Helix omits it on some writers.
        valid: validNode?.kind === 'boolean' ? validNode.value : true,
        tempo: isNumber(tempoNode) ? tempoNode.value : undefined,
      });
    }

    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * Controller assignments from `data.tone.controller`.
   *
   * These are valuable beyond routing: an assignment records the parameter's
   * true display-unit `@min` and `@max`, which is the only in-file source of
   * real parameter ranges.
   */
  controllers(): ControllerAssignment[] {
    const out: ControllerAssignment[] = [];
    const root = getMember(this.tone, 'controller');
    if (!isObject(root)) return out;

    for (const dspEntry of root.entries) {
      if (!isObject(dspEntry.value)) continue;

      for (const slotEntry of dspEntry.value.entries) {
        if (!isObject(slotEntry.value)) continue;

        for (const paramEntry of slotEntry.value.entries) {
          const assignment = paramEntry.value;
          if (!isObject(assignment)) continue;

          const controller = getMember(assignment, '@controller');
          if (!isNumber(controller)) continue;

          const min = getMember(assignment, '@min');
          const max = getMember(assignment, '@max');

          out.push({
            dsp: dspEntry.key,
            slot: slotEntry.key,
            parameter: paramEntry.key,
            controller: controller.value,
            min: isNumber(min) ? min.value : undefined,
            max: isNumber(max) ? max.value : undefined,
          });
        }
      }
    }

    return out;
  }

  private applyControllerRanges(ref: BlockRef, parameters: ParamInfo[]): void {
    for (const assignment of this.controllers()) {
      if (assignment.dsp !== ref.dsp || assignment.slot !== ref.slot) continue;

      const wanted = normalizeParamName(assignment.parameter);
      const param = parameters.find((p) => normalizeParamName(p.name) === wanted);
      if (!param) continue;

      if (assignment.min !== undefined) param.min = assignment.min;
      if (assignment.max !== undefined) param.max = assignment.max;
      if (assignment.min !== undefined || assignment.max !== undefined) {
        param.rangeSource = 'controller';
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Guarded writes                                                  */
  /* -------------------------------------------------------------- */

  /**
   * Write a parameter value on a block.
   *
   * Writes through the existing key so the document is never reordered, and
   * mimics the numeric shape of the value being replaced. Returns the previous
   * value. Throws when the slot or key does not exist; callers must validate
   * first rather than relying on a silent no-op.
   */
  writeParameter(ref: BlockRef, name: string, value: ParamValue): ParamValue {
    const node = this.slotNode(ref);
    if (!node) {
      throw new HelixPresetError(`No such slot: ${ref.dsp}/${ref.slot}`);
    }

    const entry = findEntry(node, name);
    if (!entry) {
      throw new HelixPresetError(
        `Block ${ref.dsp}/${ref.slot} has no parameter named "${name}"`,
      );
    }

    const previous = scalarValue(entry.value);
    if (previous === undefined) {
      throw new HelixPresetError(
        `Parameter "${entry.key}" on ${ref.dsp}/${ref.slot} is not a scalar value`,
      );
    }

    entry.value = makeScalar(value, entry.value);
    return previous;
  }

  /**
   * Set a block's bypass state, mirroring it into the active snapshot.
   *
   * Snapshot bypass is stored twice: on the block as `@enabled`, and in
   * `snapshotN.blocks[dsp][slot]`. The block mirrors the active snapshot.
   * Writing only one of the two is silently reverted by the hardware on the
   * next snapshot recall, so both are written together.
   */
  writeEnabled(ref: BlockRef, enabled: boolean): boolean | undefined {
    const node = this.slotNode(ref);
    if (!node) {
      throw new HelixPresetError(`No such slot: ${ref.dsp}/${ref.slot}`);
    }

    const existing = getMember(node, '@enabled');
    const previous = existing?.kind === 'boolean' ? existing.value : undefined;

    setMember(node, '@enabled', { kind: 'boolean', value: enabled });
    this.mirrorBypassIntoActiveSnapshot(ref, enabled);

    return previous;
  }

  private mirrorBypassIntoActiveSnapshot(ref: BlockRef, enabled: boolean): void {
    const index = this.currentSnapshot;
    if (index === undefined) return;

    const snapshot = getMember(this.tone, `snapshot${index}`);
    const blocks = getMember(snapshot, 'blocks');
    const dspBlocks = getMember(blocks, ref.dsp);
    if (!isObject(dspBlocks)) return;

    // Only mirror where an entry already exists. Creating one would assert
    // that this block participates in snapshot bypass, which we cannot know.
    if (findEntry(dspBlocks, ref.slot)) {
      setMember(dspBlocks, ref.slot, { kind: 'boolean', value: enabled });
    }
  }

  /**
   * Mirror a parameter value into the active snapshot's controller table.
   *
   * Only applies when the parameter is already snapshot-controlled. Returns
   * true when a mirror write happened.
   */
  mirrorParameterIntoActiveSnapshot(ref: BlockRef, name: string, value: ParamValue): boolean {
    const index = this.currentSnapshot;
    if (index === undefined || typeof value !== 'number') return false;

    const snapshot = getMember(this.tone, `snapshot${index}`);
    const controllers = getMember(snapshot, 'controllers');
    const dspNode = getMember(controllers, ref.dsp);
    const slotNode = getMember(dspNode, ref.slot);
    if (!isObject(slotNode)) return false;

    const wanted = normalizeParamName(name);
    const entry = slotNode.entries.find((e) => normalizeParamName(e.key) === wanted);
    if (!entry || !isObject(entry.value)) return false;

    const valueEntry = findEntry(entry.value, '@value');
    if (!valueEntry) return false;

    valueEntry.value = makeScalar(value, valueEntry.value);
    return true;
  }

  /* -------------------------------------------------------------- */
  /* Summary                                                         */
  /* -------------------------------------------------------------- */

  summary(): PresetSummary {
    const topology: Record<string, string | number> = {};
    const global = getMember(this.tone, 'global');

    if (isObject(global)) {
      for (const entry of global.entries) {
        const match = /^@topology(\d+)$/.exec(entry.key);
        if (!match) continue;
        if (isString(entry.value) || isNumber(entry.value)) {
          topology[`dsp${match[1]}`] = entry.value.value;
        }
      }
    }

    const unmodelled = keysOf(this.tone).filter(
      (key) =>
        !/^dsp\d+$/.test(key) && !/^snapshot\d+$/.test(key) && !MODELLED_TONE_SECTIONS.has(key),
    );

    return {
      name: this.name,
      device: this.device,
      deviceName: this.deviceName,
      firmware: this.firmware,
      schema: this.schema,
      version: this.version,
      application: this.application,
      tempo: this.tempo,
      dsps: this.dspKeys(),
      blocks: this.blocks(),
      snapshots: this.snapshots(),
      currentSnapshot: this.currentSnapshot,
      controllers: this.controllers(),
      topology,
      unmodelledSections: unmodelled,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function compareBySignalFlow(a: BlockInfo, b: BlockInfo): number {
  const pathA = a.path ?? 0;
  const pathB = b.path ?? 0;
  if (pathA !== pathB) return pathA - pathB;

  // Slots without a position (cabs, inputs, outputs) sort after positioned
  // blocks rather than being forced to position 0.
  const posA = a.position ?? Number.MAX_SAFE_INTEGER;
  const posB = b.position ?? Number.MAX_SAFE_INTEGER;
  if (posA !== posB) return posA - posB;

  return a.slot.localeCompare(b.slot);
}

function scalarValue(node: JsonNode): ParamValue | undefined {
  if (node.kind === 'number' || node.kind === 'boolean' || node.kind === 'string') {
    return node.value;
  }
  return undefined;
}

function makeScalar(value: ParamValue, template: JsonNode): JsonNode {
  if (typeof value === 'number') {
    return jsonNumberLike(isNumber(template) ? template : undefined, value);
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  return { kind: 'string', value };
}

/** Find an entry by exact key, falling back to normalized matching. */
function findEntry(node: JsonObject, key: string) {
  const exact = node.entries.find((e) => e.key === key);
  if (exact) return exact;

  const wanted = normalizeParamName(key);
  return node.entries.find((e) => !e.key.startsWith('@') && normalizeParamName(e.key) === wanted);
}
