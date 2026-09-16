/**
 * Build the model catalogue from presets we own.
 *
 *   pnpm helix:catalogue                     # default sources
 *   pnpm helix:catalogue presets/user        # a specific tree
 *
 * Line 6 does not publish a model catalogue, and the proprietary one inside
 * HX Edit is not ours to copy. But every preset exported from a device carries
 * the facts we actually need -- which models exist, what their parameters are
 * called, and what ranges those parameters really have -- so the catalogue is
 * derived from presets rather than transcribed from anywhere.
 *
 * That has a useful property: it can only ever contain things a real device
 * produced. Coverage grows by exporting more presets, not by trusting a list.
 *
 * Ranges come from controller assignments, which are the only in-file source
 * of a parameter's true min and max. A parameter nobody ever assigned to a
 * controller has no recorded range, and the catalogue says so rather than
 * inventing one.
 *
 * Output is a generated TypeScript module rather than JSON: every consumer
 * (tsx, vitest, esbuild, Vite) handles it identically, with no JSON module
 * resolution differences between them.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HelixPreset } from '../src/model/preset.js';
import type { ParamKind } from '../src/model/types.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const OUTPUT = join(PACKAGE_ROOT, 'src/model/catalogue.generated.ts');
const NAMES_OUTPUT = join(PACKAGE_ROOT, 'src/model/model-names.generated.ts');
const OVERRIDES = join(PACKAGE_ROOT, 'data/model-names.json');

const DEFAULT_SOURCES = [
  'presets/user/templates',
  'presets/user/corpus',
  'presets/user/fixtures',
  'packages/helix/test/fixtures',
];

interface ParameterAccumulator {
  kind: Set<ParamKind>;
  occurrences: number;
  min?: number;
  max?: number;
  observedMin?: number;
  observedMax?: number;
  values: Set<string>;
}

interface ModelAccumulator {
  occurrences: number;
  devices: Set<string>;
  firmwares: Set<string>;
  types: Set<number>;
  roles: Set<string>;
  parameters: Map<string, ParameterAccumulator>;
}

/** Hand-maintained display names. Generated data never overwrites these. */
interface Overrides {
  [model: string]: { label?: string; basedOn?: string; category?: string };
}

function collectPresets(target: string): string[] {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.toLowerCase().endsWith('.hlx')) found.push(path);
    }
  };
  walk(target);

  return found.sort();
}

function accumulatorFor(models: Map<string, ModelAccumulator>, id: string): ModelAccumulator {
  let entry = models.get(id);
  if (!entry) {
    entry = {
      occurrences: 0,
      devices: new Set(),
      firmwares: new Set(),
      types: new Set(),
      roles: new Set(),
      parameters: new Map(),
    };
    models.set(id, entry);
  }
  return entry;
}

function ingest(
  models: Map<string, ModelAccumulator>,
  text: string,
  parse: (text: string) => HelixPreset,
): void {
  const preset = parse(text);
  const summary = preset.summary();

  // Controller assignments are keyed by block and parameter, so index them
  // once rather than scanning per parameter.
  const ranges = new Map<string, { min?: number; max?: number }>();
  for (const controller of summary.controllers) {
    ranges.set(`${controller.dsp}/${controller.slot}/${controller.parameter}`, {
      min: controller.min,
      max: controller.max,
    });
  }

  for (const block of preset.blocks()) {
    if (!block.model) continue;

    const entry = accumulatorFor(models, block.model);
    entry.occurrences += 1;
    entry.roles.add(block.role);
    if (summary.deviceName) entry.devices.add(summary.deviceName);
    if (summary.firmware) entry.firmwares.add(summary.firmware);
    if (block.type !== undefined) entry.types.add(block.type);

    for (const parameter of block.parameters) {
      let param = entry.parameters.get(parameter.name);
      if (!param) {
        param = { kind: new Set(), occurrences: 0, values: new Set() };
        entry.parameters.set(parameter.name, param);
      }

      param.kind.add(parameter.kind);
      param.occurrences += 1;

      const range = ranges.get(`${block.dsp}/${block.slot}/${parameter.name}`);
      const min = parameter.min ?? range?.min;
      const max = parameter.max ?? range?.max;
      if (min !== undefined) param.min = param.min === undefined ? min : Math.min(param.min, min);
      if (max !== undefined) param.max = param.max === undefined ? max : Math.max(param.max, max);

      if (typeof parameter.value === 'number') {
        param.observedMin =
          param.observedMin === undefined
            ? parameter.value
            : Math.min(param.observedMin, parameter.value);
        param.observedMax =
          param.observedMax === undefined
            ? parameter.value
            : Math.max(param.observedMax, parameter.value);
      } else if (param.values.size < 12) {
        param.values.add(String(parameter.value));
      }
    }
  }
}

function loadOverrides(): Overrides {
  if (!existsSync(OVERRIDES)) return {};
  try {
    const raw = JSON.parse(readFileSync(OVERRIDES, 'utf8')) as Overrides;
    // `$`-prefixed keys carry the file's own documentation, not model data.
    return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('$')));
  } catch (error) {
    console.error(`Ignoring ${OVERRIDES}: ${String(error)}`);
    return {};
  }
}

function serialize(models: Map<string, ModelAccumulator>, overrides: Overrides, files: number) {
  const entries = [...models.entries()].sort(([a], [b]) => a.localeCompare(b));

  const catalogue = entries.map(([id, model]) => {
    const parameters = [...model.parameters.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, param]) => ({
        name,
        kind: [...param.kind].sort().join('|'),
        occurrences: param.occurrences,
        ...(param.min !== undefined ? { min: param.min } : {}),
        ...(param.max !== undefined ? { max: param.max } : {}),
        ...(param.observedMin !== undefined ? { observedMin: param.observedMin } : {}),
        ...(param.observedMax !== undefined ? { observedMax: param.observedMax } : {}),
        ...(param.values.size > 0 ? { values: [...param.values].sort() } : {}),
      }));

    const override = overrides[id] ?? {};

    return {
      id,
      ...(override.label ? { label: override.label } : {}),
      ...(override.basedOn ? { basedOn: override.basedOn } : {}),
      ...(override.category ? { category: override.category } : {}),
      occurrences: model.occurrences,
      devices: [...model.devices].sort(),
      firmwares: [...model.firmwares].sort(),
      types: [...model.types].sort((a, b) => a - b),
      parameters,
    };
  });

  const rangesKnown = catalogue.reduce(
    (sum, model) => sum + model.parameters.filter((p) => 'min' in p).length,
    0,
  );
  const paramCount = catalogue.reduce((sum, model) => sum + model.parameters.length, 0);

  return {
    source: {
      presets: files,
      models: catalogue.length,
      parameters: paramCount,
      parametersWithRange: rangesKnown,
      named: catalogue.filter((m) => m.label).length,
    },
    catalogue,
  };
}

/**
 * The parser this script imports reads the generated names module, so on a
 * clean checkout -- or after someone deletes it -- the generator cannot start
 * without first putting something there. Write an empty one and let the real
 * run overwrite it.
 */
function ensureNamesStub(): void {
  if (existsSync(NAMES_OUTPUT)) return;
  writeNames([]);
}

function writeNames(entries: readonly { id: string; label?: string; basedOn?: string; category?: string }[]): void {
  const names = Object.fromEntries(
    entries
      .filter((model) => model.label || model.basedOn || model.category)
      .map((model) => [
        model.id,
        {
          ...(model.label ? { label: model.label } : {}),
          ...(model.basedOn ? { basedOn: model.basedOn } : {}),
          ...(model.category ? { category: model.category } : {}),
        },
      ]),
  );

  writeFileSync(
    NAMES_OUTPUT,
    [
      '/**',
      ' * Generated by `pnpm helix:catalogue`. Do not edit by hand.',
      ' *',
      ' * Curated display names only, from data/model-names.json. Kept separate from',
      ' * the full catalogue so the UI can name a block without bundling every',
      ' * parameter of every model.',
      ' *',
      ` * ${Object.keys(names).length} model(s) named.`,
      ' */',
      '',
      'export interface ModelName {',
      '  label?: string;',
      '  basedOn?: string;',
      '  category?: string;',
      '}',
      '',
      `export const MODEL_NAMES: Readonly<Record<string, ModelName>> = ${JSON.stringify(names, null, 2)};`,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main(): Promise<void> {
  ensureNamesStub();
  const { HelixPreset } = await import('../src/model/preset.js');

  const targets = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SOURCES).map(
    (path) => resolve(REPO_ROOT, path),
  );

  const files = targets.flatMap(collectPresets);
  if (files.length === 0) {
    console.error('No .hlx files found. Nothing to build a catalogue from.');
    process.exit(1);
  }

  const models = new Map<string, ModelAccumulator>();
  let failed = 0;

  for (const file of files) {
    try {
      ingest(models, readFileSync(file, 'utf8'), (text) => HelixPreset.parse(text));
    } catch (error) {
      failed += 1;
      console.error(`  skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { source, catalogue } = serialize(models, loadOverrides(), files.length - failed);

  const banner = [
    '/**',
    ' * Generated by `pnpm helix:catalogue`. Do not edit by hand.',
    ' *',
    ' * Derived from presets we own, so every entry is something a real device',
    ' * produced. Display names come from data/model-names.json, which is the only',
    ' * hand-maintained part -- an identifier alone cannot tell you where `4x12`',
    ' * ends and `1960` begins.',
    ' *',
    ` * ${source.presets} preset(s), ${source.models} model(s), ${source.parameters} parameter(s),`,
    ` * ${source.parametersWithRange} with a known range, ${source.named} with a curated name.`,
    ' */',
    '',
    "import type { CatalogueEntry } from './catalogue.js';",
    '',
  ].join('\n');

  const body = [
    `export const CATALOGUE_SOURCE = ${JSON.stringify(source, null, 2)} as const;`,
    '',
    `export const CATALOGUE: readonly CatalogueEntry[] = ${JSON.stringify(catalogue, null, 2)};`,
    '',
  ].join('\n');

  writeFileSync(OUTPUT, `${banner}\n${body}`, 'utf8');
  writeNames(catalogue);

  console.log(`Read ${source.presets} preset(s)${failed > 0 ? `, ${failed} unreadable` : ''}.`);
  console.log(
    `Wrote ${source.models} models, ${source.parameters} parameters ` +
      `(${source.parametersWithRange} with a real range, ${source.named} named).`,
  );
  for (const path of [OUTPUT, NAMES_OUTPUT]) {
    console.log(`  ${path.replace(`${REPO_ROOT}\\`, '').replace(`${REPO_ROOT}/`, '')}`);
  }
}

await main();
