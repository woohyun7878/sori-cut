/**
 * Dispatch layer between the model and the tools.
 *
 * Everything the model says arrives here untrusted: unknown tool names,
 * malformed argument JSON, arguments of the wrong shape. All of those are
 * turned into structured failures the model can read and correct, because a
 * thrown exception ends the turn without teaching it anything.
 */

import type { ToneSession } from './session.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';
import type { JsonSchema, ToolDefinition, ToolResult } from './types.js';
import { closestNames, validateArgs } from './validate-args.js';

export interface ToolCall {
  /** Provider-assigned id, echoed back so the model can match call to result. */
  id: string;
  name: string;
  /** Raw arguments. A JSON string from the provider, or an already-parsed object. */
  arguments: string | Record<string, unknown>;
}

export interface ToolCallOutcome {
  id: string;
  name: string;
  ok: boolean;
  /** Serialized result sent back to the model. */
  output: string;
  /** Structured result for logging and the UI. */
  result: ToolResult;
  durationMs: number;
}

export class ToolExecutor {
  constructor(private readonly session: ToneSession) {}

  get tools(): ToolDefinition[] {
    return TOOLS;
  }

  /** Tool definitions in the shape the Responses API expects. */
  toolSpecs(): { type: 'function'; name: string; description: string; parameters: JsonSchema }[] {
    return TOOLS.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  execute(call: ToolCall): ToolCallOutcome {
    const started = Date.now();
    const result = this.run(call);

    return {
      id: call.id,
      name: call.name,
      ok: result.ok,
      output: serializeForModel(result),
      result,
      durationMs: Date.now() - started,
    };
  }

  private run(call: ToolCall): ToolResult {
    const tool = TOOLS_BY_NAME.get(call.name);
    if (!tool) {
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'unknown_tool',
          message: `There is no tool called "${call.name}".`,
          suggestions: closestNames(call.name, TOOLS.map((t) => t.name)),
        },
      };
    }

    let raw: unknown;
    if (typeof call.arguments === 'string') {
      const trimmed = call.arguments.trim();
      try {
        raw = trimmed === '' ? {} : JSON.parse(trimmed);
      } catch {
        return {
          ok: false,
          warnings: [],
          error: {
            code: 'invalid_arguments',
            message: 'Arguments were not valid JSON. Send a JSON object.',
          },
        };
      }
    } else {
      raw = call.arguments ?? {};
    }

    const validated = validateArgs(tool.parameters, raw);
    if (!validated.ok) return { ok: false, warnings: [], error: validated.error };

    try {
      return tool.execute(validated.args, { session: this.session });
    } catch (error) {
      // A tool throwing is a bug in Bender, not a model mistake. Report it as
      // a failure rather than letting it abort the conversation.
      return {
        ok: false,
        warnings: [],
        error: {
          code: 'would_corrupt',
          message: `${call.name} failed unexpectedly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }
}

/**
 * Render a result as the text the model sees.
 *
 * Failures lead with the reason and then the alternatives, because that
 * ordering is what makes a model retry correctly instead of repeating itself.
 */
export function serializeForModel(result: ToolResult): string {
  if (!result.ok) {
    const parts = [`ERROR (${result.error.code}): ${result.error.message}`];
    if (result.error.suggestions?.length) {
      parts.push(`Did you mean: ${result.error.suggestions.join(', ')}`);
    }
    return parts.join('\n');
  }

  const parts: string[] = [];
  if (result.data === null) {
    parts.push('No change was needed.');
  } else {
    parts.push(JSON.stringify(result.data, null, 2));
  }
  if (result.warnings.length > 0) {
    parts.push(`Warnings:\n- ${result.warnings.join('\n- ')}`);
  }
  return parts.join('\n');
}
