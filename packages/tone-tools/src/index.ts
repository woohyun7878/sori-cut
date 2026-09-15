/**
 * @bender/tone-tools — the constrained editing layer between the model and a
 * Helix preset.
 *
 * The model never produces Helix JSON. It calls named operations with typed
 * arguments; this package validates them, applies them transactionally, and
 * records what changed. Structural safety lives here in code, not in prompt
 * instructions the model may or may not follow.
 */

export { ToneSession, type ParameterDiff } from './session.js';
export { ToolExecutor, serializeForModel, type ToolCall, type ToolCallOutcome } from './executor.js';
export { TOOLS, TOOLS_BY_NAME } from './tools.js';
export { validateArgs, closestNames } from './validate-args.js';
export type {
  ChangeSummary,
  EditRecord,
  JsonSchema,
  JsonSchemaProperty,
  ToolContext,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolResult,
} from './types.js';
