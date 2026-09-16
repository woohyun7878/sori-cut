/**
 * Local environment files.
 *
 * The README has always said to copy `.env.example` to `.env`, but nothing
 * read it: there is no dotenv dependency and tsx does not load env files on
 * its own, so every "why is AZURE_OPENAI_ENDPOINT not set" was a documented
 * step that quietly did nothing.
 *
 * Node has loaded `.env` files natively since 20.12, so this is a wrapper
 * around `process.loadEnvFile` rather than a dependency.
 *
 * Two files, in this order:
 *
 *   .env.local   personal overrides -- the cheap dev deployment, a different
 *                resource, a scratch model. Not committed, and not shared.
 *   .env         the shared local defaults.
 *
 * The first definition of a variable wins, which is what makes `.env.local` an
 * override rather than an addition. Real environment variables beat both, so a
 * deployed host is never affected by a file that happens to be lying around.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['.env.local', '.env'] as const;

/** The server package root, whether running from `src/` or a bundled `dist/`. */
function defaultDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Load the env files that exist, and report which ones were used.
 *
 * Missing files are normal -- production has none -- so they are skipped
 * silently. An unreadable one is reported and skipped: a malformed `.env`
 * should not stop a server whose real configuration comes from the host.
 */
export function loadEnvFiles(dir: string = defaultDir()): string[] {
  if (typeof process.loadEnvFile !== 'function') {
    process.stderr.write(
      `[env] Node ${process.version} cannot read .env files (needs 20.12+). ` +
        'Set the variables in your shell instead.\n',
    );
    return [];
  }

  const loaded: string[] = [];

  for (const file of FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;

    try {
      process.loadEnvFile(path);
      loaded.push(file);
    } catch (error) {
      process.stderr.write(`[env] ${file} could not be read: ${String(error)}\n`);
    }
  }

  return loaded;
}
