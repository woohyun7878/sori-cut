/**
 * Serializes a JSON AST back to text, reproducing the source byte for byte
 * wherever nothing was modified.
 *
 * Every scalar node that still carries its `raw` source text is emitted
 * verbatim. Only nodes that were replaced by an edit are formatted, which is
 * what makes round-tripping safe despite the unresolved question of exactly
 * which float formatter the dominant Helix writer uses.
 */

import type { JsonNode } from './ast.js';
import { DEFAULT_STYLE, type JsonStyle } from './style.js';

export function stringifyJson(node: JsonNode, style: JsonStyle = DEFAULT_STYLE): string {
  const out: string[] = [];
  write(node, style, 0, out);
  if (style.trailingNewline) out.push(style.newline);
  return out.join('');
}

function write(node: JsonNode, style: JsonStyle, depth: number, out: string[]): void {
  switch (node.kind) {
    case 'object':
      writeObject(node.entries, style, depth, out);
      return;
    case 'array':
      writeArray(node.items, style, depth, out);
      return;
    case 'string':
      out.push(node.raw ?? encodeString(node.value));
      return;
    case 'number':
      out.push(node.raw ?? encodeNumber(node.value));
      return;
    case 'boolean':
      out.push(node.value ? 'true' : 'false');
      return;
    case 'null':
      out.push('null');
      return;
  }
}

function writeObject(
  entries: { key: string; keyRaw?: string; value: JsonNode }[],
  style: JsonStyle,
  depth: number,
  out: string[],
): void {
  if (entries.length === 0) {
    out.push('{}');
    return;
  }

  const inner = style.indent.repeat(depth + 1);
  const outer = style.indent.repeat(depth);

  out.push('{', style.newline);
  entries.forEach((entry, index) => {
    out.push(inner);
    out.push(entry.keyRaw ?? encodeString(entry.key));
    out.push(style.keySeparator);
    write(entry.value, style, depth + 1, out);
    if (index < entries.length - 1) out.push(',');
    out.push(style.newline);
  });
  out.push(outer, '}');
}

function writeArray(items: JsonNode[], style: JsonStyle, depth: number, out: string[]): void {
  if (items.length === 0) {
    out.push('[]');
    return;
  }

  const inner = style.indent.repeat(depth + 1);
  const outer = style.indent.repeat(depth);

  out.push('[', style.newline);
  items.forEach((item, index) => {
    out.push(inner);
    write(item, style, depth + 1, out);
    if (index < items.length - 1) out.push(',');
    out.push(style.newline);
  });
  out.push(outer, ']');
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/**
 * Encode a string for output.
 *
 * Forward slashes are left bare. HX Edit escapes them (`"1\/4 DLY"`), but a
 * string only reaches this function when Bender created or changed it, and an
 * unescaped slash is valid JSON that Helix accepts. Strings read from the file
 * keep their original escaping via `raw`.
 */
export function encodeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const escape = ESCAPES[char];
    if (escape !== undefined) {
      out += escape;
    } else if (char < ' ') {
      out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

/**
 * Encode a number Bender produced with no shape information available.
 *
 * Prefer `jsonNumberLike`, which preserves the integer/float shape of the
 * value being replaced. Helix writes `"@type" : 3` as a bare integer but
 * `"@tempo" : 120.0` with a trailing `.0`, and the distinction is a property
 * of the field rather than of the value.
 */
export function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot serialize non-finite number: ${value}`);
  }
  return String(value);
}
