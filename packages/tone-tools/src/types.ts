/**
 * Types for the constrained tool layer.
 *
 * The model never writes Helix JSON. It calls named operations with typed
 * arguments, and this layer decides whether each one is safe to apply. That
 * boundary is the whole point: a model that hallucinates a parameter name
 * gets a rejection with a list of real names, not a corrupted preset.
 */

import type { ParamValue, ValidationIssue } from '@bender/helix';

/** JSON Schema subset sufficient to describe tool arguments to the model. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

/**
 * A tool the model may call.
 *
 * `readOnly` matters for more than documentation: inspection tools can be
 * retried freely and never need an undo entry, while mutating tools must go
 * through the transaction log.
 */
export interface ToolDefinition<A = Record<string, unknown>, R = unknown> {
  name: string;
  /** Shown to the model. This is the model's only guide to when to call it. */
  description: string;
  parameters: JsonSchema;
  readOnly: boolean;
  execute: (args: A, context: ToolContext) => ToolResult<R>;
}

export interface ToolContext {
  session: import('./session.js').ToneSession;
}

/**
 * Outcome of a tool call.
 *
 * Failure is a normal, expected result rather than an exception. The model
 * needs to see *why* something was refused so it can correct itself, and a
 * thrown error would end the turn instead of teaching it anything.
 */
export type ToolResult<R = unknown> =
  | { ok: true; data: R; warnings: string[] }
  | { ok: false; error: ToolError; warnings: string[] };

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Concrete alternatives, when the failure is a bad name or value. */
  suggestions?: string[];
}

export type ToolErrorCode =
  /** No preset is loaded. */
  | 'no_preset'
  /** A block reference did not resolve to exactly one block. */
  | 'unknown_block'
  /** The named parameter does not exist on that block. */
  | 'unknown_parameter'
  /** The value has the wrong type for that parameter. */
  | 'invalid_type'
  /** The value falls outside a range the preset itself states. */
  | 'out_of_range'
  /** Arguments failed schema validation. */
  | 'invalid_arguments'
  /** The operation would leave the preset structurally invalid. */
  | 'would_corrupt'
  /** Nothing to undo. */
  | 'nothing_to_undo'
  /** The tool name is not registered. */
  | 'unknown_tool';

/** One recorded change to the preset. The audit trail is a list of these. */
export interface EditRecord {
  /** Monotonic index, starting at 1. */
  sequence: number;
  tool: string;
  /** Human-readable description of what changed. Shown in the diff UI. */
  summary: string;
  target: { dsp: string; slot: string; label: string };
  parameter?: string;
  before?: ParamValue;
  after?: ParamValue;
  at: string;
}

export interface ChangeSummary {
  edits: EditRecord[];
  /** Validation state of the preset as it currently stands. */
  issues: ValidationIssue[];
}
