/**
 * Transactional editing session over a single preset.
 *
 * Every mutation follows the same shape:
 *
 *   clone the document -> apply the edit -> validate -> keep or discard
 *
 * The clone is what makes edits transactional. A change that would leave the
 * preset structurally invalid is discarded wholesale rather than partially
 * applied, so a rejected operation is indistinguishable from one that never
 * ran. This matters because a half-applied edit is exactly how a preset ends
 * up loading on hardware and sounding wrong.
 */

import {
  HelixPreset,
  formatValidation,
  validatePreset,
  type ParamValue,
  type ValidationIssue,
} from '@bender/helix';
import type { ChangeSummary, EditRecord, ToolError, ToolResult } from './types.js';

interface HistoryEntry {
  /** Document state *before* the edit that produced `record`. */
  snapshot: HelixPreset;
  record: EditRecord;
}

export class ToneSession {
  /** State as uploaded. Never mutated; `compare` and `reset` depend on it. */
  private readonly original: HelixPreset;

  private current: HelixPreset;

  private readonly history: HistoryEntry[] = [];

  /** Undone entries, newest first, so redo is possible. */
  private readonly undone: HistoryEntry[] = [];

  private sequence = 0;

  private constructor(preset: HelixPreset) {
    this.original = preset.clone();
    this.current = preset;
  }

  /**
   * Open a session on `.hlx` text.
   *
   * Presets with validation *errors* are rejected here rather than at edit
   * time. Editing an already-broken preset would make Bender look like the
   * cause of damage it merely inherited.
   */
  static open(text: string): { session: ToneSession } | { error: ToolError } {
    let preset: HelixPreset;
    try {
      preset = HelixPreset.parse(text);
    } catch (error) {
      return {
        error: {
          code: 'would_corrupt',
          message: `This file could not be read as a Helix preset: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }

    const result = validatePreset(preset);
    if (!result.ok) {
      return {
        error: {
          code: 'would_corrupt',
          message: `This preset has problems Bender will not edit around:\n${formatValidation({
            ...result,
            warnings: [],
          })}`,
        },
      };
    }

    return { session: new ToneSession(preset) };
  }

  /** Open a session without the validity precondition. Tests only. */
  static openUnchecked(preset: HelixPreset): ToneSession {
    return new ToneSession(preset);
  }

  get preset(): HelixPreset {
    return this.current;
  }

  get originalPreset(): HelixPreset {
    return this.original;
  }

  get edits(): EditRecord[] {
    return this.history.map((entry) => entry.record);
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** True when the current document differs from the uploaded one. */
  get isModified(): boolean {
    return this.history.length > 0;
  }

  /**
   * Apply a mutation transactionally.
   *
   * `mutate` runs against a throwaway clone and returns the record to log.
   * Returning `undefined` means the edit was a no-op and is not recorded, so
   * setting a parameter to the value it already holds does not clutter the
   * diff or the undo stack.
   */
  transact(
    tool: string,
    mutate: (draft: HelixPreset) => Omit<EditRecord, 'sequence' | 'at'> | undefined,
  ): ToolResult<EditRecord | null> {
    const draft = this.current.clone();

    let pending: Omit<EditRecord, 'sequence' | 'at'> | undefined;
    try {
      pending = mutate(draft);
    } catch (error) {
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'would_corrupt',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    if (!pending) return { ok: true, data: null, warnings: [] };

    const result = validatePreset(draft);
    if (!result.ok) {
      // Discard the draft entirely. `this.current` was never touched.
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'would_corrupt',
          message:
            `This change would leave the preset invalid, so it was not applied:\n` +
            formatValidation({ ...result, warnings: [] }),
        },
      };
    }

    const record: EditRecord = {
      ...pending,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
    };

    this.history.push({ snapshot: this.current, record });
    this.current = draft;
    // A new edit invalidates the redo branch, as in any editor.
    this.undone.length = 0;

    return {
      ok: true,
      data: record,
      warnings: result.warnings.map((w) => w.message),
    };
  }

  /** Revert the most recent edit. */
  undo(): ToolResult<EditRecord> {
    const entry = this.history.pop();
    if (!entry) {
      return {
        ok: false,
        warnings: [],
        error: { code: 'nothing_to_undo', message: 'There are no changes to undo.' },
      };
    }

    this.undone.unshift({ snapshot: this.current, record: entry.record });
    this.current = entry.snapshot;

    return { ok: true, data: entry.record, warnings: [] };
  }

  /** Reapply the most recently undone edit. */
  redo(): ToolResult<EditRecord> {
    const entry = this.undone.shift();
    if (!entry) {
      return {
        ok: false,
        warnings: [],
        error: { code: 'nothing_to_undo', message: 'There are no changes to redo.' },
      };
    }

    this.history.push({ snapshot: this.current, record: entry.record });
    this.current = entry.snapshot;

    return { ok: true, data: entry.record, warnings: [] };
  }

  /** Discard every edit and return to the uploaded preset. */
  reset(): void {
    this.current = this.original.clone();
    this.history.length = 0;
    this.undone.length = 0;
    this.sequence = 0;
  }

  changes(): ChangeSummary {
    return { edits: this.edits, issues: currentIssues(this.current) };
  }

  /** Serialize the current state for download. */
  serialize(): string {
    return this.current.serialize();
  }

  /**
   * Every parameter that differs from the uploaded preset.
   *
   * Computed by comparing documents rather than by replaying the edit log, so
   * it stays correct even if a tool changed something without recording it.
   * Disagreement between this and the audit trail is a bug worth surfacing.
   */
  diff(): ParameterDiff[] {
    const out: ParameterDiff[] = [];

    for (const after of this.current.blocks()) {
      const before = this.original.blockInfo({ dsp: after.dsp, slot: after.slot });
      if (!before) {
        out.push({
          dsp: after.dsp,
          slot: after.slot,
          label: after.label,
          parameter: '(block)',
          before: undefined,
          after: 'added',
        });
        continue;
      }

      if (before.enabled !== after.enabled) {
        out.push({
          dsp: after.dsp,
          slot: after.slot,
          label: after.label,
          parameter: 'Bypass',
          before: before.enabled === undefined ? undefined : before.enabled ? 'on' : 'bypassed',
          after: after.enabled ? 'on' : 'bypassed',
        });
      }

      for (const param of after.parameters) {
        const previous = before.parameters.find((p) => p.name === param.name);
        if (previous && previous.value !== param.value) {
          out.push({
            dsp: after.dsp,
            slot: after.slot,
            label: after.label,
            parameter: param.name,
            before: previous.value,
            after: param.value,
          });
        }
      }
    }

    return out;
  }
}

export interface ParameterDiff {
  dsp: string;
  slot: string;
  label: string;
  parameter: string;
  before: ParamValue | undefined;
  after: ParamValue;
}

function currentIssues(preset: HelixPreset): ValidationIssue[] {
  const result = validatePreset(preset);
  return [...result.errors, ...result.warnings];
}
