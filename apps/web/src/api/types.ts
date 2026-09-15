/**
 * Types mirroring the Bender backend HTTP contract.
 *
 * These are transcribed from apps/server/src/http/routes.ts (`presetView`,
 * `toolView`) and apps/server/src/agent/loop.ts (`ActivityEvent`). The server
 * is the source of truth; if a field is optional here it is because the server
 * can legitimately omit or null it.
 */

/** A scalar Helix parameter value. Helix values are NOT normalized to 0..1. */
export type ParamValue = number | boolean | string;

/** One slot in the signal chain. `id` doubles as the tool target. */
export interface ChainBlock {
  /** "dsp0/block1" — stable id, React key, and tool target. */
  id: string;
  label: string;
  model: string;
  /** "block" | "cab" | "input" | "output" | "split" | "join" | "unknown". */
  role: string;
  /**
   * Branch: 0 = A, 1 = B. Present on `role: "block"` entries; absent on routing
   * entries (cab, input, output — and even split/join carry no path). Filter to
   * blocks before reading it.
   */
  path?: number;
  /**
   * Index within the branch — NOT the array order and NOT derivable from id.
   * Present on blocks and on split/join, absent on cabs and I/O. Because a split
   * legitimately reports `position: 0`, sorting the raw array by position mixes
   * routing into the chain: filter to `role: "block"` first, then sort.
   */
  position?: number;
  enabled: boolean;
  /** Sibling cab slot key for an amp block, e.g. "cab0". */
  cab: string | null;
}

export interface SnapshotInfo {
  index: number;
  name: string | null;
}

/** One changed parameter, comparing the uploaded preset to its current state. */
export interface DiffEntry {
  dsp: string;
  slot: string;
  label: string;
  parameter: string;
  before: ParamValue | null;
  after: ParamValue | null;
}

/** One recorded edit in the audit trail. */
export interface EditEntry {
  sequence: number;
  tool: string;
  summary: string;
  target: { dsp: string; slot: string; label: string };
  parameter: string | null;
  before: ParamValue | null;
  after: ParamValue | null;
}

/** Everything the UI needs to render the current state of a preset. */
export interface PresetView {
  sessionId: string;
  filename: string;
  name: string | null;
  device: string | null;
  deviceId: number | null;
  firmware: string | null;
  tempo: number | null;
  chain: ChainBlock[];
  snapshots: SnapshotInfo[];
  activeSnapshot: number | null;
  modified: boolean;
  canUndo: boolean;
  canRedo: boolean;
  diff: DiffEntry[];
  edits: EditEntry[];
  /** Present on the create-session response. */
  warnings?: string[];
}

/** Per-tool outcome, as returned by the messages endpoint (`toolView`). */
export interface ToolCall {
  name: string;
  ok: boolean;
  durationMs: number;
  /** Error code when the call failed, else null. */
  error: string | null;
  warnings: string[];
}

/** One entry in the activity feed shown for a completed turn. */
export interface ActivityEvent {
  kind: 'model' | 'tool';
  name: string;
  ok: boolean;
  /** Human-readable summary for edits; undefined for inspections. */
  detail?: string;
  durationMs: number;
}

/** Response body of POST /api/sessions/:id/messages on success (200). */
export interface MessageResponse {
  reply: string;
  activity: ActivityEvent[];
  toolCalls: ToolCall[];
  truncated: boolean;
  latencyMs: number;
  modelRequestIds: string[];
  preset: PresetView;
}

/** Metadata for a starter template (preset contents excluded). */
export interface TemplateSummary {
  id: string;
  name: string;
  category: string;
  summary: string;
  bestFor?: string[];
  device?: number;
  owner?: string;
  notes?: string;
}
