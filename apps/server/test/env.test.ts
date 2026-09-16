/**
 * Local env file loading.
 *
 * The behaviour that matters is precedence: a real environment variable must
 * win over any file, and `.env.local` must win over `.env`. Get that backwards
 * and a deployed host silently picks up a developer's cheap dev deployment, or
 * a local override stops working for reasons nobody can see.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../src/env.js';

let dir: string;
const touched = [
  'BENDER_TEST_ONLY_ENV',
  'BENDER_TEST_ONLY_LOCAL',
  'BENDER_TEST_BOTH',
  'BENDER_TEST_SHELL',
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bender-env-'));
  for (const key of touched) delete process.env[key];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of touched) delete process.env[key];
});

function write(file: string, contents: string): void {
  writeFileSync(join(dir, file), contents, 'utf8');
}

describe('loadEnvFiles', () => {
  it('does nothing when there is no env file', () => {
    expect(loadEnvFiles(dir)).toEqual([]);
  });

  it('loads .env', () => {
    write('.env', 'BENDER_TEST_ONLY_ENV=from-env\n');

    expect(loadEnvFiles(dir)).toEqual(['.env']);
    expect(process.env.BENDER_TEST_ONLY_ENV).toBe('from-env');
  });

  it('merges .env.local and .env, with .env.local winning', () => {
    write('.env', 'BENDER_TEST_BOTH=from-env\nBENDER_TEST_ONLY_ENV=from-env\n');
    write('.env.local', 'BENDER_TEST_BOTH=from-local\nBENDER_TEST_ONLY_LOCAL=from-local\n');

    expect(loadEnvFiles(dir)).toEqual(['.env.local', '.env']);
    expect(process.env.BENDER_TEST_BOTH).toBe('from-local');
    expect(process.env.BENDER_TEST_ONLY_LOCAL).toBe('from-local');
    expect(process.env.BENDER_TEST_ONLY_ENV).toBe('from-env');
  });

  it('never overrides a variable already set in the environment', () => {
    // This is what keeps a deployed host safe from a stray file: App Service
    // sets real environment variables, and they win.
    process.env.BENDER_TEST_SHELL = 'from-shell';
    write('.env', 'BENDER_TEST_SHELL=from-env\n');
    write('.env.local', 'BENDER_TEST_SHELL=from-local\n');

    loadEnvFiles(dir);

    expect(process.env.BENDER_TEST_SHELL).toBe('from-shell');
  });
});
