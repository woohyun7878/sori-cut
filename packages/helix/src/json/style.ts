/**
 * Detects the byte-level formatting convention of a `.hlx` source file.
 *
 * At least three writer styles exist in the wild (see
 * docs/helix-format-notes.md):
 *
 *   A  ~89%  one space per indent level, `" : "` separator
 *   B         two spaces per indent level, `" : "` separator
 *   C         fully minified, `":"` separator
 *
 * Two files with the same firmware `build_sha` have been observed in both
 * style A and style B, so style cannot be derived from the preset's metadata.
 * It must be measured from the source text.
 */

export interface JsonStyle {
  /** Characters used for one indent level. Empty string means minified. */
  indent: string;
  /** Text between a key and its value, including surrounding spaces. */
  keySeparator: string;
  /** Text after a comma. Empty when minified. */
  itemSeparator: string;
  /** Line terminator. Empty when minified. */
  newline: string;
  /** Whether the document ended with a trailing newline. */
  trailingNewline: boolean;
}

/** The dominant style observed in real presets. Used only when nothing can be measured. */
export const DEFAULT_STYLE: JsonStyle = {
  indent: ' ',
  keySeparator: ' : ',
  itemSeparator: ',',
  newline: '\n',
  trailingNewline: false,
};

export const MINIFIED_STYLE: JsonStyle = {
  indent: '',
  keySeparator: ':',
  itemSeparator: ',',
  newline: '',
  trailingNewline: false,
};

/**
 * Measure the formatting style of a JSON source document.
 *
 * Indent width is measured from the first two nesting levels rather than
 * assumed, and the key separator is read from the first `"key" :` occurrence
 * outside of a string.
 */
export function detectStyle(source: string): JsonStyle {
  const newlineMatch = /\r\n|\n/.exec(source);
  if (!newlineMatch) {
    return {
      ...MINIFIED_STYLE,
      keySeparator: detectKeySeparator(source) ?? ':',
    };
  }

  const newline = newlineMatch[0];
  const lines = source.split(/\r\n|\n/);

  const indent = detectIndentUnit(lines) ?? DEFAULT_STYLE.indent;
  const keySeparator = detectKeySeparator(source) ?? DEFAULT_STYLE.keySeparator;

  return {
    indent,
    keySeparator,
    itemSeparator: ',',
    newline,
    trailingNewline: source.endsWith('\n'),
  };
}

/**
 * Infer one indent level from the smallest non-zero leading-whitespace run.
 *
 * Real presets nest deeply and consistently, so the minimum positive indent is
 * a reliable estimate of one level.
 */
function detectIndentUnit(lines: string[]): string | undefined {
  let smallest: string | undefined;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const leading = /^[ \t]*/.exec(line)![0];
    if (leading.length === 0) continue;
    if (smallest === undefined || leading.length < smallest.length) {
      smallest = leading;
    }
    if (smallest.length === 1) break;
  }

  return smallest;
}

/**
 * Read the separator between a key and its value from the first top-level-ish
 * occurrence, scanning outside of string literals.
 */
function detectKeySeparator(source: string): string | undefined {
  let inString = false;
  let escaped = false;
  let stringEnd = -1;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        stringEnd = i + 1;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === ':' && stringEnd !== -1) {
      const between = source.slice(stringEnd, i);
      // Only whitespace may separate a key from its colon.
      if (!/^[ \t]*$/.test(between)) continue;
      const after = /^[ \t]*/.exec(source.slice(i + 1))![0];
      return `${between}:${after}`;
    }

    if (char === ',' || char === '{' || char === '[') {
      stringEnd = -1;
    }
  }

  return undefined;
}
