/**
 * Round-trip tests.
 *
 * `parse(text).serialize() === text` is the guarantee the whole package exists
 * to provide. If these fail, nothing built on top of the parser can be trusted,
 * because every edit ships the serializer's output to a user's hardware.
 */

import { describe, expect, it } from 'vitest';
import { HelixPreset, detectStyle, parseJson, stringifyJson } from '../src/index.js';
import { MINIMAL_PRESET, presetFixtures, readFixture } from './helpers.js';

describe('byte-exact round trip', () => {
  it.each(presetFixtures())('reproduces %s byte for byte', (name) => {
    const source = readFixture(name);
    expect(HelixPreset.parse(source).serialize()).toBe(source);
  });

  it('reproduces the synthetic minimal preset byte for byte', () => {
    expect(HelixPreset.parse(MINIMAL_PRESET).serialize()).toBe(MINIMAL_PRESET);
  });

  it('is idempotent across repeated parse/serialize cycles', () => {
    const source = readFixture('possum.hlx');

    let current = source;
    for (let i = 0; i < 5; i++) {
      current = HelixPreset.parse(current).serialize();
    }

    expect(current).toBe(source);
  });

  it('round-trips a clone identically to the original', () => {
    const source = readFixture('hacklabs-template.hlx');
    const preset = HelixPreset.parse(source);

    expect(preset.clone().serialize()).toBe(source);
  });
});

describe('formatting preservation', () => {
  it('preserves float text that JSON.stringify would rewrite', () => {
    // These are the exact renderings that made a JSON.parse/JSON.stringify
    // round trip impossible: trailing zeros, near-miss decimals, and the
    // C-style three-digit exponent.
    const source = '{"a":0.560,"b":0.699999,"c":1.19209e-007,"d":120.0,"e":-48.0}';

    expect(stringifyJson(parseJson(source), detectStyle(source))).toBe(source);
  });

  it('preserves escaped forward slashes', () => {
    // HX Edit writes "1\/4 DLY". Re-encoding it as "1/4 DLY" is valid JSON and
    // the same string, but it is not the same bytes.
    const source = '{"name":"1\\/4 DLY"}';
    const parsed = parseJson(source);

    expect(stringifyJson(parsed, detectStyle(source))).toBe(source);
  });

  it('preserves integer-like key order that a JS object would reorder', () => {
    // Assigning these to a plain object hoists them into ascending numeric
    // order, silently rewriting irUuidTable.
    const source = '{"002":"c","000":"a","127":"z","001":"b"}';
    const parsed = parseJson(source);

    expect(stringifyJson(parsed, detectStyle(source))).toBe(source);
    expect(JSON.stringify(JSON.parse(source))).not.toBe(source);
  });

  it('preserves unknown structures verbatim', () => {
    // Bender models none of this. It must survive anyway.
    const source = readFixture('possum.hlx');
    const preset = HelixPreset.parse(source);

    expect(preset.summary().unmodelledSections).toContain('footswitch');
    expect(preset.serialize()).toContain('"@fs_ledcolor":525824');
  });
});

describe('style detection', () => {
  it('detects the dominant HX Edit style', () => {
    const style = detectStyle(readFixture('hacklabs-template.hlx'));

    expect(style.indent).toBe(' ');
    expect(style.keySeparator).toBe(' : ');
  });

  it('detects minified output', () => {
    const style = detectStyle(readFixture('possum.hlx'));

    expect(style.indent).toBe('');
    expect(style.keySeparator).toBe(':');
    expect(style.newline).toBe('');
  });

  it('detects a two-space indent', () => {
    const style = detectStyle('{\n  "a" : {\n    "b" : 1\n  }\n}');

    expect(style.indent).toBe('  ');
    expect(style.keySeparator).toBe(' : ');
  });

  it('does not hardcode a style per device or firmware', () => {
    // Two files from the same firmware have been observed in different styles,
    // so style must come from the bytes rather than from the preset metadata.
    const styleA = detectStyle(readFixture('hacklabs-template.hlx'));
    const styleC = detectStyle(readFixture('possum.hlx'));

    expect(styleA).not.toEqual(styleC);
  });
});

describe('malformed input', () => {
  it.each([
    ['empty input', ''],
    ['trailing content', '{"a":1} {"b":2}'],
    ['unterminated string', '{"a":"oops}'],
    ['trailing comma', '{"a":1,}'],
    ['single quotes', "{'a':1}"],
    ['unquoted key', '{a:1}'],
    ['truncated document', '{"data":{"tone":'],
  ])('rejects %s', (_label, input) => {
    expect(() => HelixPreset.parse(input)).toThrow();
  });

  it('rejects a JSON document that is not an object', () => {
    expect(() => HelixPreset.parse('[1,2,3]')).toThrow(/must be a JSON object/);
  });

  it('reports a line and column for a syntax error', () => {
    let caught: unknown;
    try {
      HelixPreset.parse('{\n "a" : 1,\n "b" : oops\n}');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/line 3/);
  });

  it('tolerates a byte order mark', () => {
    const preset = HelixPreset.parse(`\uFEFF${MINIMAL_PRESET}`);

    expect(preset.name).toBe('Test Preset');
  });
});
