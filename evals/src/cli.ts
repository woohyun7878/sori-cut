/**
 * Evaluation harness CLI.
 *
 *   pnpm eval                 every case that can run
 *   pnpm eval tapping-sustain one case
 *   pnpm eval --mock          replay canned transcripts; no network
 *   pnpm eval --record        keep the generated preset even when a case passes
 *   pnpm eval --verbose       show passing checks too
 *   pnpm eval --list          list cases without running anything
 *
 *   pnpm eval feedback tapping-sustain bad "thin and honky"
 *   pnpm eval feedback --list
 */

import { CaseError, loadCases, type EvalCase } from './case.js';
import {
  disagreements,
  findRun,
  FeedbackError,
  loadFeedback,
  parseVerdict,
  recordFeedback,
  FEEDBACK_FILE,
} from './feedback.js';
import { MockProvider } from './mock-provider.js';
import { printResult, printSummary, writeResults } from './report.js';
import { newRunId, runCase, type RunResult } from './run.js';
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
    // `pnpm run eval -- --mock` is the idiomatic npm form and forwards a bare
    // `--` through to us. Treat it as a separator rather than an error.
    if (arg === '--') continue;
    else if (arg === '--mock') args.mock = true;
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

/**
 * `pnpm eval feedback [target] <verdict> [note]`
 *
 * Handled before argument parsing because its arguments are prose, not flags.
 */
function feedbackCommand(argv: string[]): number {
  const args = argv.filter((arg) => arg !== '--');

  if (args[0] === '--list' || args[0] === undefined) {
    const entries = loadFeedback();
    if (entries.length === 0) {
      process.stdout.write(
        'No feedback recorded yet.\n\n' +
          '  pnpm eval feedback <case-or-run-id> good|bad|mixed "what you heard"\n',
      );
      return 0;
    }

    for (const entry of entries) {
      const edits = entry.edits.length === 1 ? '1 edit' : `${entry.edits.length} edits`;
      process.stdout.write(
        `  ${entry.verdict.padEnd(5)} ${entry.caseId}  \x1b[2m${entry.runId}, ${edits}\x1b[0m\n` +
          (entry.note ? `        ${entry.note}\n` : ''),
      );
    }

    const conflicted = disagreements();
    if (conflicted.length > 0) {
      process.stdout.write(
        `\n\x1b[33m${conflicted.length} run(s) where the checks and your ears disagreed:\x1b[0m ` +
          `${conflicted.map((entry) => entry.caseId).join(', ')}\n` +
          '\x1b[2mEither the case asserts the wrong thing or the checks are too strict.\x1b[0m\n',
      );
    }
    return 0;
  }

  try {
    // The target is optional: `feedback bad "..."` judges the most recent run,
    // which is what you want when you just played it.
    const looksLikeVerdict = (value: string | undefined): boolean =>
      value !== undefined && ['good', 'bad', 'mixed'].includes(value.toLowerCase());

    const [target, verdictArg, note] = looksLikeVerdict(args[0])
      ? [undefined, args[0], args[1]]
      : [args[0], args[1], args[2]];

    if (verdictArg === undefined) {
      process.stderr.write('Usage: pnpm eval feedback [case-or-run-id] good|bad|mixed ["note"]\n');
      return 2;
    }

    const { result } = findRun(target);
    const entry = recordFeedback(result, parseVerdict(verdictArg), note);

    process.stdout.write(
      `Recorded ${entry.verdict} for ${entry.caseId} (${entry.runId}), ` +
        `${entry.edits.length} edit(s).\n`,
    );
    if (entry.checksPassed && entry.verdict === 'bad') {
      process.stdout.write(
        '\x1b[33mThe checks passed but it sounded wrong — the case is asserting the wrong thing.\x1b[0m\n',
      );
    }
    process.stdout.write(`\x1b[2m${FEEDBACK_FILE}\x1b[0m\n`);
    return 0;
  } catch (error) {
    if (error instanceof FeedbackError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'feedback' || (argv[0] === '--' && argv[1] === 'feedback')) {
    return feedbackCommand(argv.slice(argv[0] === 'feedback' ? 1 : 2));
  }

  const args = parseArgs(argv);

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
  const runId = newRunId();

  for (const evalCase of cases) {
    if (evalCase.skip) {
      results.push({
        ...(await skeleton(evalCase, runId)),
        skipped: true,
        skipReason: evalCase.skipReason,
      });
      printResult(results[results.length - 1], args.verbose);
      continue;
    }

    const provider = await providerFor(evalCase, args.mock);
    if (typeof provider === 'string') {
      process.stdout.write(`\x1b[2mskip\x1b[0m  ${evalCase.id} — ${provider}\n`);
      results.push({ ...(await skeleton(evalCase, runId)), skipped: true, skipReason: provider });
      continue;
    }

    const result = await runCase(evalCase, {
      provider,
      runId,
      keepPreset: args.record,
      verbose: args.verbose,
    });
    results.push(result);
    printResult(result, args.verbose);
  }

  printSummary(results);

  // Written on every run, not just failures. Feedback attaches to a run id
  // after the preset has been played, which can be long after the run.
  const path = writeResults(results, args.mock ? 'mock' : 'live');
  process.stdout.write(`\n\x1b[2mResults: ${path}\x1b[0m\n`);
  if (results.some((r) => !r.skipped)) {
    process.stdout.write(
      `\x1b[2mPlayed it? pnpm eval feedback ${results.find((r) => !r.skipped)?.caseId ?? ''} good|bad|mixed "note"\x1b[0m\n`,
    );
  }

  return results.some((r) => !r.passed && !r.skipped) ? 1 : 0;
}

async function skeleton(evalCase: EvalCase, runId: string): Promise<RunResult> {
  return {
    caseId: evalCase.id,
    runId,
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
