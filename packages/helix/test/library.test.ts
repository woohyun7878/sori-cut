/**
 * The shipped starter library, used as a compatibility corpus.
 *
 * `presets/user/templates/` holds real presets exported from hardware, copied
 * byte for byte and never passed through Bender's serializer. That makes them
 * the strongest evidence we have that the parser handles genuine device output
 * rather than output it produced itself, so they are worth running on every
 * commit: a parser change that breaks any of them breaks the product.
 *
 * These files also ship to users as starting points, which means a metadata
 * mistake here is a broken template in the UI, not just a bad test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HelixPreset } from '../src/index.js';

const LIBRARY_DIR = fileURLToPath(new URL('../../../presets/user/templates/', import.meta.url));

function libraryPresets(): string[] {
  return readdirSync(LIBRARY_DIR)
    .filter((name) => name.endsWith('.hlx'))
    .sort();
}

const presets = libraryPresets();

describe('shipped starter library', () => {
  it('is not empty', () => {
    // Guards against the whole suite silently passing with zero cases if the
    // directory is ever emptied or wrongly re-ignored by .gitignore.
    expect(presets.length).toBeGreaterThan(0);
  });

  it.each(presets)('%s round-trips byte for byte', (name) => {
    const source = readFileSync(join(LIBRARY_DIR, name), 'utf8');

    expect(HelixPreset.parse(source).serialize()).toBe(source);
  });

  it.each(presets)('%s parses into an inspectable chain', (name) => {
    const preset = HelixPreset.parse(readFileSync(join(LIBRARY_DIR, name), 'utf8'));
    const blocks = preset.blocks();

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.model).toBeTruthy();
    }
  });

  it.each(presets)('%s has metadata a user can be shown', (name) => {
    const id = name.replace(/\.hlx$/, '');
    const meta = JSON.parse(readFileSync(join(LIBRARY_DIR, `${id}.json`), 'utf8')) as {
      id: string;
      name: string;
      category: string;
      summary: string;
    };

    // id must match the filename or the server pairs the metadata with the
    // wrong preset, and the UI offers a tone that is not the one it describes.
    expect(meta.id).toBe(id);
    expect(meta.name.length).toBeGreaterThan(0);
    expect(meta.category.length).toBeGreaterThan(0);
    expect(meta.summary.length).toBeGreaterThan(0);
  });
});
