/**
 * The owned preset collection, used as a compatibility corpus.
 *
 * `presets/user/templates/` holds the handful of starter tones the app offers,
 * and `presets/user/corpus/` holds the rest of the owned collection. Both are
 * real presets exported from hardware, copied byte for byte and never passed
 * through Bender's serializer. That makes them the strongest evidence we have
 * that the parser handles genuine device output rather than output it produced
 * itself, so all of them run on every commit regardless of which directory they
 * live in: a parser change that breaks any of them breaks the product.
 *
 * The templates additionally ship to users as starting points, which means a
 * metadata mistake there is a broken template in the UI, not just a bad test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HelixPreset } from '../src/index.js';

const PRESETS_DIR = fileURLToPath(new URL('../../../presets/user/', import.meta.url));
const COLLECTIONS = ['templates', 'corpus'] as const;

function read(collection: string, name: string): string {
  return readFileSync(join(PRESETS_DIR, collection, name), 'utf8');
}

function presetsIn(collection: string): string[] {
  return readdirSync(join(PRESETS_DIR, collection))
    .filter((name) => name.endsWith('.hlx'))
    .sort();
}

/** Every owned preset as `[collection, filename]`, for table-driven tests. */
const presets: [string, string][] = COLLECTIONS.flatMap((collection) =>
  presetsIn(collection).map((name): [string, string] => [collection, name]),
);

describe('owned preset collection', () => {
  it('is not empty', () => {
    // Guards against the whole suite silently passing with zero cases if a
    // directory is emptied or wrongly re-ignored by .gitignore.
    expect(presets.length).toBeGreaterThan(0);
  });

  it.each(presets)('%s/%s round-trips byte for byte', (collection, name) => {
    const source = read(collection, name);

    expect(HelixPreset.parse(source).serialize()).toBe(source);
  });

  it.each(presets)('%s/%s parses into an inspectable chain', (collection, name) => {
    const blocks = HelixPreset.parse(read(collection, name)).blocks();

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.model).toBeTruthy();
    }
  });

  it.each(presets)('%s/%s has metadata a user can be shown', (collection, name) => {
    const id = name.replace(/\.hlx$/, '');
    const meta = JSON.parse(read(collection, `${id}.json`)) as {
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

describe('starter templates', () => {
  const templates = presetsIn('templates');

  it('stays small enough to be a choice rather than a catalogue', () => {
    // The starter set exists to help someone who does not know what they want.
    // A long list is the problem it solves, so this fails loudly if the corpus
    // ever drains back into templates/.
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.length).toBeLessThanOrEqual(8);
  });

  it('offers at most one starting point per category', () => {
    const categories = templates.map((name) => {
      const meta = JSON.parse(read('templates', name.replace(/\.hlx$/, '.json'))) as {
        category: string;
      };
      return meta.category;
    });

    expect(categories).toHaveLength(new Set(categories).size);
  });
});
