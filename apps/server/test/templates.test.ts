/**
 * Tests for the starter-template loader.
 *
 * The endpoint is covered in api.test.ts, but only to the extent that it
 * returns an array. The interesting behaviour is what happens to malformed
 * input, and that matters more than it looks: this loader's whole job is to
 * read files a human dropped into presets/user/templates by hand. Getting one
 * of them wrong is the expected case, not the exceptional one, and a single bad
 * file must never stop the others from loading or take the server down.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadTemplates } from '../src/templates.js';

// Declared via the helper's return type rather than a hand-written one:
// process.stderr.write is overloaded, and spelling that signature out by hand
// does not match what vi.spyOn actually infers.
function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

let dir: string;
let stderr: ReturnType<typeof silenceStderr>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bender-templates-'));
  // The loader reports skipped files on stderr. Silence it so a passing run
  // does not look like a failing one.
  stderr = silenceStderr();
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function writeTemplate(id: string, meta: unknown, preset = '{"schema":"L6Preset"}'): void {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(meta));
  writeFileSync(join(dir, `${id}.hlx`), preset);
}

const VALID = { name: 'Modern Rhythm', category: 'Rhythm', summary: 'Tight high-gain rhythm.' };

describe('loadTemplates', () => {
  it('returns nothing when the directory does not exist', () => {
    expect(loadTemplates(join(dir, 'nope'))).toEqual([]);
  });

  it('returns nothing when the directory is empty', () => {
    // The shipped state of the repository. An empty list is correct here --
    // inventing a starter preset would mean shipping a tone nobody has heard.
    expect(loadTemplates(dir)).toEqual([]);
  });

  it('loads a well-formed template with its preset contents', () => {
    writeTemplate('modern-rhythm', VALID, '{"schema":"L6Preset","version":6}');

    const [template] = loadTemplates(dir);

    expect(template).toMatchObject({ id: 'modern-rhythm', ...VALID });
    expect(template.preset).toBe('{"schema":"L6Preset","version":6}');
  });

  it('skips metadata with no matching .hlx rather than loading a template with no preset', () => {
    writeFileSync(join(dir, 'orphan.json'), JSON.stringify(VALID));

    expect(loadTemplates(dir)).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no matching orphan.hlx'));
  });

  it.each([
    ['name', { category: 'Lead', summary: 'x' }],
    ['category', { name: 'Lead', summary: 'x' }],
    ['summary', { name: 'Lead', category: 'Lead' }],
  ])('skips a template missing %s', (_field, meta) => {
    writeTemplate('incomplete', meta);
    expect(loadTemplates(dir)).toEqual([]);
  });

  it('survives malformed JSON instead of throwing', () => {
    writeFileSync(join(dir, 'broken.json'), '{ this is not json');
    writeFileSync(join(dir, 'broken.hlx'), '{}');

    expect(() => loadTemplates(dir)).not.toThrow();
    expect(loadTemplates(dir)).toEqual([]);
  });

  it('still loads good templates when a bad one sits beside them', () => {
    writeTemplate('good', VALID);
    writeFileSync(join(dir, 'bad.json'), '{ broken');
    writeFileSync(join(dir, 'bad.hlx'), '{}');

    expect(loadTemplates(dir).map((t) => t.id)).toEqual(['good']);
  });

  it('ignores .hlx files with no metadata beside them', () => {
    // Dropping a bare preset in is the most likely mistake someone will make.
    // It should be quietly ignored, not half-loaded with invented metadata.
    writeFileSync(join(dir, 'bare.hlx'), '{}');

    expect(loadTemplates(dir)).toEqual([]);
  });

  it('sorts by category then name so the UI order is stable', () => {
    writeTemplate('b-clean', { name: 'Blackface', category: 'Clean', summary: 's' });
    writeTemplate('a-lead', { name: 'Soaring', category: 'Lead', summary: 's' });
    writeTemplate('c-clean', { name: 'Chime', category: 'Clean', summary: 's' });

    expect(loadTemplates(dir).map((t) => `${t.category}/${t.name}`)).toEqual([
      'Clean/Blackface',
      'Clean/Chime',
      'Lead/Soaring',
    ]);
  });

  it('preserves optional metadata fields', () => {
    writeTemplate('full', { ...VALID, bestFor: ['drop C'], owner: 'M. Jo', device: 2162689 });

    expect(loadTemplates(dir)[0]).toMatchObject({
      bestFor: ['drop C'],
      owner: 'M. Jo',
      device: 2162689,
    });
  });
});
