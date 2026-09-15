/**
 * A JSON document model that preserves everything `JSON.parse` throws away.
 *
 * Helix `.hlx` files are plain JSON, but three different writers produce them
 * with three different formatting conventions, and the exact float formatter
 * used by the dominant writer could not be derived (see
 * docs/helix-format-notes.md). Values like `0.560`, `0.699999` and
 * `1.19209e-007` do not survive `JSON.parse` -> `JSON.stringify`.
 *
 * The fix is to never re-format a value we did not change. Every scalar node
 * carries the exact source text (`raw`) it was parsed from. The serializer
 * emits `raw` verbatim unless the node was explicitly replaced, which confines
 * formatting risk to the handful of values an edit actually touches.
 *
 * Object key order is preserved as an explicit entry list, because JavaScript
 * object property order hoists integer-like keys and would silently reorder
 * maps such as `irUuidTable` (keys "000".."127").
 */

export type JsonNode =
  | JsonObject
  | JsonArray
  | JsonString
  | JsonNumber
  | JsonBoolean
  | JsonNull;

export interface JsonEntry {
  /** Decoded key. */
  key: string;
  /** Exact source text of the key including quotes, or undefined if synthesized. */
  keyRaw?: string;
  value: JsonNode;
}

export interface JsonObject {
  kind: 'object';
  entries: JsonEntry[];
}

export interface JsonArray {
  kind: 'array';
  items: JsonNode[];
}

export interface JsonString {
  kind: 'string';
  value: string;
  /** Exact source text including quotes and original escaping. */
  raw?: string;
}

export interface JsonNumber {
  kind: 'number';
  value: number;
  /** Exact source text, e.g. "0.560" or "1.19209e-007". */
  raw?: string;
}

export interface JsonBoolean {
  kind: 'boolean';
  value: boolean;
}

export interface JsonNull {
  kind: 'null';
}

/* ------------------------------------------------------------------ */
/* Constructors                                                        */
/* ------------------------------------------------------------------ */

export function jsonString(value: string): JsonString {
  return { kind: 'string', value };
}

export function jsonNumber(value: number): JsonNumber {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot represent non-finite number in JSON: ${value}`);
  }
  return { kind: 'number', value };
}

export function jsonBoolean(value: boolean): JsonBoolean {
  return { kind: 'boolean', value };
}

/**
 * Build a number node that mimics the formatting shape of the node it replaces.
 *
 * Helix writes `"@type" : 3` as a bare integer but `"@tempo" : 120.0` with a
 * trailing `.0`, and which form a field uses is a property of the field rather
 * than of the value. Replacing `120.0` with `118` must therefore produce
 * `118.0`, not `118`, or the file stops looking like the writer produced it.
 *
 * Decimal places are matched to the template as well, so replacing `0.560`
 * yields `0.610` rather than `0.61`. Values that need more precision than the
 * template used are rendered at their natural precision instead of being
 * rounded, because losing precision is worse than looking inconsistent.
 */
export function jsonNumberLike(template: JsonNumber | undefined, value: number): JsonNumber {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot represent non-finite number in JSON: ${value}`);
  }

  const raw = template?.raw;
  if (raw === undefined || /[eE]/.test(raw)) {
    return { kind: 'number', value };
  }

  const dot = raw.indexOf('.');

  if (dot === -1) {
    // Template was an integer. Keep integers bare; a fractional replacement
    // must still be written accurately.
    return Number.isInteger(value)
      ? { kind: 'number', value, raw: String(value) }
      : { kind: 'number', value };
  }

  const decimals = raw.length - dot - 1;
  const fixed = value.toFixed(decimals);

  // Only adopt the template's precision when it round-trips to the same value.
  return Number(fixed) === value
    ? { kind: 'number', value, raw: fixed }
    : { kind: 'number', value };
}

export function jsonNull(): JsonNull {
  return { kind: 'null' };
}

export function jsonObject(entries: JsonEntry[] = []): JsonObject {
  return { kind: 'object', entries };
}

export function jsonArray(items: JsonNode[] = []): JsonArray {
  return { kind: 'array', items };
}

/* ------------------------------------------------------------------ */
/* Accessors                                                           */
/* ------------------------------------------------------------------ */

export function isObject(node: JsonNode | undefined): node is JsonObject {
  return node?.kind === 'object';
}

export function isArray(node: JsonNode | undefined): node is JsonArray {
  return node?.kind === 'array';
}

export function isNumber(node: JsonNode | undefined): node is JsonNumber {
  return node?.kind === 'number';
}

export function isString(node: JsonNode | undefined): node is JsonString {
  return node?.kind === 'string';
}

export function isBoolean(node: JsonNode | undefined): node is JsonBoolean {
  return node?.kind === 'boolean';
}

/** Look up a key in an object node. Returns undefined for non-objects. */
export function getMember(node: JsonNode | undefined, key: string): JsonNode | undefined {
  if (!isObject(node)) return undefined;
  for (const entry of node.entries) {
    if (entry.key === key) return entry.value;
  }
  return undefined;
}

/** Follow a chain of keys, e.g. getPath(doc, 'data', 'tone', 'dsp0'). */
export function getPath(node: JsonNode | undefined, ...keys: string[]): JsonNode | undefined {
  let current = node;
  for (const key of keys) {
    current = getMember(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

/** Keys of an object node, in source order. */
export function keysOf(node: JsonNode | undefined): string[] {
  if (!isObject(node)) return [];
  return node.entries.map((e) => e.key);
}

export function hasMember(node: JsonNode | undefined, key: string): boolean {
  return getMember(node, key) !== undefined;
}

/**
 * Set a key on an object node.
 *
 * An existing key keeps its position and its original key spelling, so writing
 * a value never reorders the document or changes how the key was escaped.
 */
export function setMember(node: JsonObject, key: string, value: JsonNode): void {
  for (const entry of node.entries) {
    if (entry.key === key) {
      entry.value = value;
      return;
    }
  }
  node.entries.push({ key, value });
}

export function deleteMember(node: JsonObject, key: string): boolean {
  const index = node.entries.findIndex((e) => e.key === key);
  if (index === -1) return false;
  node.entries.splice(index, 1);
  return true;
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

/** Convert a node to a plain JavaScript value. Loses raw text and key order. */
export function toPlain(node: JsonNode): unknown {
  switch (node.kind) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) out[entry.key] = toPlain(entry.value);
      return out;
    }
    case 'array':
      return node.items.map(toPlain);
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
  }
}

/** Build a node from a plain JavaScript value. The result has no raw text. */
export function fromPlain(value: unknown): JsonNode {
  if (value === null || value === undefined) return jsonNull();
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'number') return jsonNumber(value);
  if (typeof value === 'boolean') return jsonBoolean(value);
  if (Array.isArray(value)) return jsonArray(value.map(fromPlain));
  if (typeof value === 'object') {
    return jsonObject(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
        key,
        value: fromPlain(v),
      })),
    );
  }
  throw new TypeError(`Cannot convert value of type ${typeof value} to JSON`);
}

/** Deep clone, preserving raw text and key order. */
export function cloneNode(node: JsonNode): JsonNode {
  switch (node.kind) {
    case 'object':
      return {
        kind: 'object',
        entries: node.entries.map((e) => ({
          key: e.key,
          keyRaw: e.keyRaw,
          value: cloneNode(e.value),
        })),
      };
    case 'array':
      return { kind: 'array', items: node.items.map(cloneNode) };
    case 'string':
      return { kind: 'string', value: node.value, raw: node.raw };
    case 'number':
      return { kind: 'number', value: node.value, raw: node.raw };
    case 'boolean':
      return { kind: 'boolean', value: node.value };
    case 'null':
      return { kind: 'null' };
  }
}
