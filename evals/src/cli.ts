/**
 * Evaluation harness CLI.
 *
 *   pnpm eval                 every case that can run
 *   pnpm eval tapping-sustain one case
 *   pnpm eval --mock          replay canned transcripts; no network
 *   pnpm eval --record        write full transcripts to evals/results
 *   pnpm eval --verbose       show passing checks too
 *   pnpm eval --list          list cases without running anything
 */

import { CaseError, loadCases, type EvalCase } from './case.js';
import { MockProvider } from './mock-provider.js';
import { printResult, printSummary, writeResults } from './report.js';
import { runCase, type RunResult } from './run.js';
import type { ModelProvider } from '../../apps/server/src/model/provider.js';

interface Args {
  ids: string[];
  mock: boolean;
  record: boolean;
  verbose: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], mock: false, record: false, verbose: false, list: false };

  for (const arg of argv) {
    if (arg === '--mock') args.mock = true;
    else if (arg === '--record') args.record = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
    else if (arg === '--list') args.list = true;
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(2);
    } else args.ids.push(arg);
  }

  return args;
}

/**
 * Build the provider for a case.
 *
 * Mock mode is per-case rather than global because a case without a canned
 * transcript cannot be mocked, and silently running it live would make a
 * "no network" run hit the network.
 */
async function providerFor(evalCase: EvalCase, mock: boolean): Promise<ModelProvider | string> {
  if (mock) {
    if (!evalCase.mock) return 'no mock transcript; run without --mock to use the live model';
    return new MockProvider(evalCase.mock);
  }

  const { loadConfig, ConfigError } = await import('../../apps/server/src/config.js');
  const { AzureOpenAIProvider } = await import('../../apps/server/src/model/azure-openai.js');

  try {
    return new AzureOpenAIProvider(loadConfig().azure);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let cases: EvalCase[];
  try {
    cases = loadCases();
  } catch (error) {
    process.stderr.write(`${error instanceof CaseError ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.ids.length > 0) {
    const selected = cases.filter((c) => args.ids.includes(c.id));
    const missing = args.ids.filter((id) => !cases.some((c) => c.id === id));

    if (missing.length > 0) {
      process.stderr.write(
        `No such case: ${missing.join(', ')}\nAvailable: ${cases.map((c) => c.id).join(', ') || '(none)'}\n`,
      );
      return 2;
    }
    // An explicitly named case runs even if it is marked skip, since naming it
    // is a deliberate act.
    cases = selected.map((c) => ({ ...c, skip: false }));
  }

  if (args.list) {
    for (const evalCase of cases) {
      const flags = [evalCase.skip ? 'skipped' : null, evalCase.mock ? 'mockable' : 'live-only']
        .filter(Boolean)
        .join(', ');
      process.stdout.write(`  ${evalCase.id}  (${flags})\n      ${evalCase.request}\n`);
    }
    return 0;
  }

  if (cases.length === 0) {
    process.stdout.write(
      'No evaluation cases found.\n\nAdd one to evals/cases/. See evals/README.md.\n',
    );
    return 0;
  }

  const results: RunResult[] = [];

  for (const evalCase of cases) {
    if (evalCase.skip) {
      results.push({
        caseId: evalCase.id,
        request: evalCase.request,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        fixture: evalCase.fixture,
        fixtureSha256: '',
        parser: { ok: false, warnings: [] },
        model: {
          provider: 'none',
          requestIds: [],
          iterations: 0,
          truncated: false,
          usage: {},
          latencyMs: 0,
        },
        transcript: [],
        diff: [],
        reply: '',
        output: { roundTripStable: false, differsFromInput: false },
        checks: [],
        passed: true,
        skipped: true,
        skipReason: evalCase.skipReason,
      });
      printResult(results[results.length - 1], args.verbose);
      continue;
    }

    const provider = await providerFor(evalCase, args.mock);
    if (typeof provider === 'string') {
      process.stdout.write(`\x1b[2mskip\x1b[0m  ${evalCase.id} — ${provider}\n`);
      results.push({ ...(await skeleton(evalCase)), skipped: true, skipReason: provider });
      continue;
    }

    const result = await runCase(evalCase, { provider, verbose: args.verbose });
    results.push(result);
    printResult(result, args.verbose);
  }

  printSummary(results);

  // Failures are always written, whether or not --record was passed. A failure
  // you cannot inspect afterwards is a failure you will have to reproduce.
  if (args.record || results.some((r) => !r.passed && !r.skipped)) {
    const path = writeResults(results, args.mock ? 'mock' : 'live');
    process.stdout.write(`\nResults written to ${path}\n`);
  }

  return results.some((r) => !r.passed && !r.skipped) ? 1 : 0;
}

async function skeleton(evalCase: EvalCase): Promise<RunResult> {
  return {
    caseId: evalCase.id,
    request: evalCase.request,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    fixture: evalCase.fixture,
    fixtureSha256: '',
    parser: { ok: false, warnings: [] },
    model: {
      provider: 'none',
      requestIds: [],
      iterations: 0,
      truncated: false,
      usage: {},
      latencyMs: 0,
    },
    transcript: [],
    diff: [],
    reply: '',
    output: { roundTripStable: false, differsFromInput: false },
    checks: [],
    passed: true,
  };
}

process.exit(await main());
