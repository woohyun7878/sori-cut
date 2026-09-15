/**
 * Turning raw tool outcomes into an honest, human-readable activity feed.
 *
 * Bender's turn returns two aligned arrays: `activity` (with a human summary
 * for edits) and `toolCalls` (with per-call warnings). Neither exposes the
 * model's chain-of-thought or raw JSON — this maps tool names to plain phrasing
 * and prettifies the edit summaries, and it keeps failed calls visible.
 */

import type { ActivityEvent, ToolCall } from '../api/types';

/** Plain-language verb for each tool the model may call. */
const TOOL_VERBS: Record<string, string> = {
  inspect_preset: 'Read the preset overview',
  inspect_signal_chain: 'Inspected the signal chain',
  inspect_block: 'Inspected a block',
  compare_presets: 'Compared the changes so far',
  set_parameter: 'Set a parameter',
  adjust_parameter: 'Adjusted a parameter',
  enable_block: 'Enabled a block',
  disable_block: 'Bypassed a block',
  undo_last_change: 'Undid the last change',
};

export interface ToolActivityItem {
  key: string;
  ok: boolean;
  /** Plain-language description of the tool call. */
  verb: string;
  /** Concrete detail (edit summary, or error message on failure). */
  detail?: string;
  warnings: string[];
}

/** Humanize an unrecognized tool name, e.g. "set_parameter" -> "Set parameter". */
export function describeTool(name: string): string {
  const known = TOOL_VERBS[name];
  if (known) return known;
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Replace the model-facing ASCII arrow with a typographic one. */
export function prettifyDetail(detail: string): string {
  return detail.replace(/\s*->\s*/g, ' → ');
}

/**
 * Build the per-turn tool activity list.
 *
 * `activity` carries the summary text; `toolCalls` carries warnings. Both list
 * tool calls in the same order, so they zip by index.
 */
export function buildToolActivity(
  activity: ActivityEvent[],
  toolCalls: ToolCall[],
): ToolActivityItem[] {
  const toolEvents = activity.filter((event) => event.kind === 'tool');

  return toolEvents.map((event, index) => {
    const call = toolCalls[index];
    return {
      key: `${index}-${event.name}`,
      ok: event.ok,
      verb: describeTool(event.name),
      detail: event.detail ? prettifyDetail(event.detail) : undefined,
      warnings: call?.warnings ?? [],
    };
  });
}

/** Collect every warning across a turn's tool calls, de-duplicated. */
export function collectWarnings(toolCalls: ToolCall[]): string[] {
  const seen = new Set<string>();
  for (const call of toolCalls) {
    for (const warning of call.warnings) seen.add(warning);
  }
  return [...seen];
}
