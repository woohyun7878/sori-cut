/**
 * Argument validation for tool calls.
 *
 * Models produce plausible-looking arguments that are subtly wrong: a string
 * where a number belongs, an extra field, a missing required one. Checking
 * here rather than trusting the model is the difference between a useful
 * error the model can correct and a `NaN` written into someone's preset.
 */

import type { JsonSchema, ToolError } from './types.js';

export type ValidatedArgs = Record<string, string | number | boolean>;

export function validateArgs(
  schema: JsonSchema,
  raw: unknown,
): { ok: true; args: ValidatedArgs } | { ok: false; error: ToolError } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      error: { code: 'invalid_arguments', message: 'Arguments must be a JSON object.' },
    };
  }

  const input = raw as Record<string, unknown>;
  const args: ValidatedArgs = {};

  for (const name of schema.required ?? []) {
    if (input[name] === undefined || input[name] === null) {
      return {
        ok: false,
        error: {
          code: 'invalid_arguments',
          message: `Missing required argument "${name}".`,
          suggestions: Object.keys(schema.properties),
        },
      };
    }
  }

  const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        code: 'invalid_arguments',
        message: `Unexpected argument(s): ${unknown.join(', ')}.`,
        suggestions: Object.keys(schema.properties),
      },
    };
  }

  for (const [name, spec] of Object.entries(schema.properties)) {
    const value = input[name];
    if (value === undefined || value === null) continue;

    switch (spec.type) {
      case 'number':
      case 'integer': {
        // Models frequently send numbers as strings. Accepting a clean numeric
        // string is pragmatic; accepting "loud" is not.
        const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof num !== 'number' || !Number.isFinite(num)) {
          return {
            ok: false,
            error: {
              code: 'invalid_type',
              message: `Argument "${name}" must be a number, got ${describe(value)}.`,
            },
          };
        }
        if (spec.type === 'integer' && !Number.isInteger(num)) {
          return {
            ok: false,
            error: {
              code: 'invalid_type',
              message: `Argument "${name}" must be a whole number, got ${num}.`,
            },
          };
        }
        if (spec.minimum !== undefined && num < spec.minimum) {
          return {
            ok: false,
            error: {
              code: 'out_of_range',
              message: `Argument "${name}" must be at least ${spec.minimum}, got ${num}.`,
            },
          };
        }
        if (spec.maximum !== undefined && num > spec.maximum) {
          return {
            ok: false,
            error: {
              code: 'out_of_range',
              message: `Argument "${name}" must be at most ${spec.maximum}, got ${num}.`,
            },
          };
        }
        args[name] = num;
        break;
      }

      case 'boolean': {
        if (typeof value === 'boolean') {
          args[name] = value;
        } else if (value === 'true' || value === 'false') {
          args[name] = value === 'true';
        } else {
          return {
            ok: false,
            error: {
              code: 'invalid_type',
              message: `Argument "${name}" must be true or false, got ${describe(value)}.`,
            },
          };
        }
        break;
      }

      case 'string': {
        if (typeof value !== 'string') {
          return {
            ok: false,
            error: {
              code: 'invalid_type',
              message: `Argument "${name}" must be a string, got ${describe(value)}.`,
            },
          };
        }
        if (spec.enum && !spec.enum.includes(value)) {
          return {
            ok: false,
            error: {
              code: 'invalid_arguments',
              message: `Argument "${name}" must be one of: ${spec.enum.join(', ')}.`,
              suggestions: spec.enum,
            },
          };
        }
        args[name] = value;
        break;
      }
    }
  }

  return { ok: true, args };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `${typeof value} (${JSON.stringify(value)})`;
}

/**
 * Rank candidate names by similarity to a wrong one.
 *
 * When a model asks for "Sustain" on a block that has "Decay", telling it the
 * closest real names turns a dead end into a correction it can act on in the
 * next tool call.
 */
export function closestNames(wanted: string, candidates: string[], limit = 5): string[] {
  const target = wanted.toLowerCase();

  return candidates
    .map((name) => ({ name, score: similarity(target, name.toLowerCase()) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** Cheap similarity: shared-prefix and substring bonuses over edit distance. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.9;

  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
}
