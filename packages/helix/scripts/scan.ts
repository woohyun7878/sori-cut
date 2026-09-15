/**
 * Scan a directory of `.hlx` files and report what Bender makes of each one.
 *
 *   pnpm helix:scan presets/user/fixtures
 *
 * This is the first thing to run against a new batch of real presets. It
 * answers the only question that matters at intake: does Bender read this file
 * correctly, and can it write it back without changing a byte?
 *
 * Files that fail here are the most valuable input the project can receive.
 * Each one is a concrete gap in the parser rather than a hypothetical one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { HelixPreset, validatePreset, type ValidationIssue } from '../src/index.js';

interface ScanRow {
  file: string;
  status: 'ok' | 'warned' | 'failed';
  device: string;
  firmware: string;
  blocks: number;
  roundTrip: boolean;
  issues: ValidationIssue[];
  error?: string;
}

function scanFile(path: string, root: string): ScanRow {
  const file = relative(root, path) || path;
  const base: ScanRow = {
    file,
    status: 'failed',
    device: '-',
    firmware: '-',
    blocks: 0,
    roundTrip: false,
    issues: [],
  };

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    return { ...base, error: `unreadable: ${messageOf(error)}` };
  }

  let preset: HelixPreset;
  try {
    preset = HelixPreset.parse(source);
  } catch (error) {
    return { ...base, error: `parse failed: ${messageOf(error)}` };
  }

  let roundTrip = false;
  let roundTripError: string | undefined;
  try {
    roundTrip = preset.serialize() === source;
    if (!roundTrip) roundTripError = 'serialized output differs from the source bytes';
  } catch (error) {
    roundTripError = `serialize failed: ${messageOf(error)}`;
  }

  const result = validatePreset(preset);
  const summary = preset.summary();
  const failed = result.errors.length > 0 || !roundTrip;

  return {
    file,
    status: failed ? 'failed' : result.warnings.length > 0 ? 'warned' : 'ok',
    device: summary.deviceName ?? (summary.device !== undefined ? `id ${summary.device}` : '-'),
    firmware: summary.firmware ?? '-',
    blocks: summary.blocks.filter((b) => b.role === 'block').length,
    roundTrip,
    issues: [...result.errors, ...result.warnings],
    error: roundTripError,
  };
}

function collectPresets(target: string): string[] {
  if (statSync(target).isFile()) return [target];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.toLowerCase().endsWith('.hlx')) out.push(path);
    }
  };
  walk(target);

  return out.sort();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `pnpm --filter @bender/helix ...` runs the script with the cwd set to this
// package, so a path typed at the repository root would otherwise resolve to
// packages/helix/<path> and fail. pnpm records where the user actually stood in
// INIT_CWD, so prefer that and fall back to the real cwd when run directly.
function resolveFromCallerCwd(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function main(): void {
  const target = resolveFromCallerCwd(process.argv[2] ?? 'presets/user/fixtures');

  let files: string[];
  try {
    files = collectPresets(target);
  } catch (error) {
    console.error(`Cannot scan ${target}: ${messageOf(error)}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(`No .hlx files found under ${target}.`);
    console.log('Drop presets you own into presets/user/fixtures/ and run this again.');
    return;
  }

  const root = statSync(target).isFile() ? resolve(target, '..') : target;
  const rows = files.map((file) => scanFile(file, root));

  const symbol = { ok: 'ok  ', warned: 'warn', failed: 'FAIL' } as const;
  const width = Math.min(Math.max(...rows.map((r) => r.file.length)), 48);

  console.log('');
  for (const row of rows) {
    const name =
      row.file.length > width ? `...${row.file.slice(-(width - 3))}` : row.file.padEnd(width);
    const detail =
      row.status === 'failed' && row.error
        ? row.error
        : `${row.device}  fw ${row.firmware}  ${row.blocks} blocks`;

    console.log(`  ${symbol[row.status]}  ${name}  ${detail}`);

    for (const issue of row.issues) {
      console.log(`        ${issue.severity}: [${issue.code}] ${issue.message}`);
    }
  }

  const failed = rows.filter((r) => r.status === 'failed').length;
  const warned = rows.filter((r) => r.status === 'warned').length;

  console.log('');
  console.log(
    `  ${rows.length} preset(s): ${rows.length - failed - warned} clean, ` +
      `${warned} with warnings, ${failed} failed`,
  );
  console.log('');

  if (failed > 0) {
    console.log('  Failures are gaps in the parser, not bad presets.');
    console.log('  Turn each one into a regression case: see evals/README.md');
    console.log('');
    process.exit(1);
  }
}

main();
