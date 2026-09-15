/**
 * Starter template loading.
 *
 * Templates are read from presets/user/templates at startup. That directory is
 * empty in the repository on purpose: a starter tone has to come from a preset
 * a real person made and owns, and anything generated from first principles
 * would be a plausible-looking arrangement of blocks nobody has ever heard.
 * Presenting that as a curated starting point would be a lie the user can only
 * detect by plugging in.
 *
 * So the loader is built and documented, and the list it returns is empty until
 * someone adds presets they own. The UI says so rather than hiding the gap.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TemplateMetadata {
  id: string;
  name: string;
  category: string;
  summary: string;
  bestFor?: string[];
  device?: number;
  owner?: string;
  notes?: string;
}

export interface Template extends TemplateMetadata {
  /** Raw .hlx contents. */
  preset: string;
}

function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..', 'presets/user/templates');
}

let cache: Template[] | null = null;

/**
 * Read every template from disk.
 *
 * A template that fails to load is skipped with a warning rather than taking
 * the server down, since a malformed file someone dropped in should not stop
 * the rest of the app from working.
 */
export function loadTemplates(dir: string = templatesDir()): Template[] {
  if (!existsSync(dir)) return [];

  const templates: Template[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith('.json')) continue;

    const id = entry.replace(/\.json$/i, '');
    const presetPath = join(dir, `${id}.hlx`);
    if (!existsSync(presetPath)) {
      process.stderr.write(`[templates] ${entry} has no matching ${id}.hlx; skipping\n`);
      continue;
    }

    try {
      const meta = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as TemplateMetadata;
      if (!meta.name || !meta.category || !meta.summary) {
        process.stderr.write(`[templates] ${entry} is missing name, category or summary; skipping\n`);
        continue;
      }
      templates.push({ ...meta, id, preset: readFileSync(presetPath, 'utf8') });
    } catch (error) {
      process.stderr.write(`[templates] ${entry} could not be read: ${String(error)}\n`);
    }
  }

  return templates.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** Template metadata for the UI. Excludes preset contents, which can be large. */
export function listTemplates(): TemplateMetadata[] {
  cache ??= loadTemplates();
  return cache.map(({ preset: _preset, ...meta }) => meta);
}

export function loadTemplate(id: string): Template | undefined {
  cache ??= loadTemplates();
  return cache.find((template) => template.id === id);
}

/** Drop the cache so a newly added template is picked up without a restart. */
export function refreshTemplates(): void {
  cache = null;
}
