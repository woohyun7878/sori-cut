/**
 * A strict JSON parser that records the exact source text of every scalar and
 * preserves object key order.
 *
 * This is deliberately not a wrapper around `JSON.parse`. We need the source
 * slice for every number and string so that serialization can reproduce them
 * byte for byte, and we need insertion-ordered entries because JavaScript
 * object property order hoists integer-like keys.
 */

import {
  type JsonArray,
  type JsonEntry,
  type JsonNode,
  type JsonObject,
} from './ast.js';

export class JsonParseError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, source: string, offset: number) {
    const upTo = source.slice(0, offset);
    const line = upTo.split('\n').length;
    const lastNewline = upTo.lastIndexOf('\n');
    const column = offset - lastNewline;
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'JsonParseError';
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** Matches a JSON number per RFC 8259, plus the exponent forms real writers emit. */
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export function parseJson(source: string): JsonNode {
  const parser = new Parser(source);
  parser.skipWhitespace();
  const node = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw new JsonParseError('Unexpected trailing content after JSON value', source, parser.pos);
  }
  return node;
}

class Parser {
  pos = 0;

  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  skipWhitespace(): void {
    while (this.pos < this.src.length && WHITESPACE.has(this.src[this.pos]!)) {
      this.pos++;
    }
  }

  private fail(message: string): never {
    throw new JsonParseError(message, this.src, this.pos);
  }

  private expect(char: string): void {
    if (this.src[this.pos] !== char) {
      const found = this.atEnd() ? 'end of input' : JSON.stringify(this.src[this.pos]);
      this.fail(`Expected ${JSON.stringify(char)} but found ${found}`);
    }
    this.pos++;
  }

  parseValue(): JsonNode {
    if (this.atEnd()) this.fail('Unexpected end of input');
    const char = this.src[this.pos]!;

    switch (char) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        this.parseLiteral('true');
        return { kind: 'boolean', value: true };
      case 'f':
        this.parseLiteral('false');
        return { kind: 'boolean', value: false };
      case 'n':
        this.parseLiteral('null');
        return { kind: 'null' };
      default:
        return this.parseNumber();
    }
  }

  private parseLiteral(literal: string): void {
    if (this.src.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return;
    }
    this.fail(`Expected ${literal}`);
  }

  private parseObject(): JsonObject {
    this.expect('{');
    const entries: JsonEntry[] = [];
    this.skipWhitespace();

    if (this.src[this.pos] === '}') {
      this.pos++;
      return { kind: 'object', entries };
    }

    for (;;) {
      this.skipWhitespace();
      if (this.src[this.pos] !== '"') this.fail('Expected a string key');
      const keyStart = this.pos;
      const keyNode = this.parseString();
      const keyRaw = this.src.slice(keyStart, this.pos);

      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      const value = this.parseValue();

      entries.push({ key: keyNode.value, keyRaw, value });

      this.skipWhitespace();
      const next = this.src[this.pos];
      if (next === ',') {
        this.pos++;
        continue;
      }
      if (next === '}') {
        this.pos++;
        return { kind: 'object', entries };
      }
      this.fail('Expected "," or "}" in object');
    }
  }

  private parseArray(): JsonArray {
    this.expect('[');
    const items: JsonNode[] = [];
    this.skipWhitespace();

    if (this.src[this.pos] === ']') {
      this.pos++;
      return { kind: 'array', items };
    }

    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();

      const next = this.src[this.pos];
      if (next === ',') {
        this.pos++;
        continue;
      }
      if (next === ']') {
        this.pos++;
        return { kind: 'array', items };
      }
      this.fail('Expected "," or "]" in array');
    }
  }

  private parseString(): { kind: 'string'; value: string; raw: string } {
    const start = this.pos;
    this.expect('"');
    let value = '';

    for (;;) {
      if (this.atEnd()) this.fail('Unterminated string');
      const char = this.src[this.pos]!;

      if (char === '"') {
        this.pos++;
        return { kind: 'string', value, raw: this.src.slice(start, this.pos) };
      }

      if (char === '\\') {
        this.pos++;
        if (this.atEnd()) this.fail('Unterminated escape sequence');
        const esc = this.src[this.pos]!;
        this.pos++;
        switch (esc) {
          case '"':
            value += '"';
            break;
          case '\\':
            value += '\\';
            break;
          // JSON permits an escaped forward slash. HX Edit emits it for note
          // divisions such as "1\/4 DLY"; neither JSON.stringify nor
          // json.dumps produces it, which is why raw text is preserved.
          case '/':
            value += '/';
            break;
          case 'b':
            value += '\b';
            break;
          case 'f':
            value += '\f';
            break;
          case 'n':
            value += '\n';
            break;
          case 'r':
            value += '\r';
            break;
          case 't':
            value += '\t';
            break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
            value += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.pos--;
            this.fail(`Invalid escape sequence \\${esc}`);
        }
        continue;
      }

      // Control characters must be escaped in strict JSON.
      if (char < ' ') this.fail('Unescaped control character in string');

      value += char;
      this.pos++;
    }
  }

  private parseNumber(): { kind: 'number'; value: number; raw: string } {
    const match = NUMBER_RE.exec(this.src.slice(this.pos));
    if (!match) this.fail('Invalid number');

    const raw = match[0];
    const value = Number(raw);
    if (!Number.isFinite(value)) this.fail(`Number out of range: ${raw}`);

    this.pos += raw.length;
    return { kind: 'number', value, raw };
  }
}
