/**
 * Live Azure OpenAI smoke test.
 *
 * Runs one real tone request against the configured deployment, using the real
 * tools on a real preset, and prints the whole transcript. Unit tests use a
 * scripted provider precisely so they do not depend on the network; this is
 * the counterpart that proves the actual model path works.
 *
 *   pnpm --filter @bender/server smoke
 *
 * Exits non-zero if the model path fails or the resulting preset does not
 * survive a round trip.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HelixPreset } from '@bender/helix';
import { ToneSession, ToolExecutor } from '@bender/tone-tools';
import { ConfigError, describeAzure, loadConfig } from '../src/config.js';
import { AzureOpenAIProvider } from '../src/model/azure-openai.js';
import { ModelError } from '../src/model/provider.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { createLogger } from '../src/observability.js';

const REQUEST =
  process.argv[2] ??
  'My tapped notes are too transient and die too quickly. Give them more body and sustain without making the preset noisy.';

const FIXTURE = fileURLToPath(
  new URL('../../../packages/helix/test/fixtures/possum.hlx', import.meta.url),
);

function heading(text: string): void {
  process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n${'-'.repeat(text.length)}\n`);
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  heading('Configuration');
  process.stdout.write(`${describeAzure(config.azure)}\n`);

  const original = readFileSync(FIXTURE, 'utf8');
  const opened = ToneSession.open(original);
  if ('error' in opened) {
    process.stderr.write(`Fixture failed to open: ${opened.error.message}\n`);
    return 1;
  }

  const { session } = opened;
  heading('Preset');
  process.stdout.write(`${session.describe()}\n\n${session.describeChain()}\n`);

  heading('Request');
  process.stdout.write(`${REQUEST}\n`);

  const started = Date.now();
  let result;
  try {
    result = await runAgentTurn(
      new AzureOpenAIProvider(config.azure),
      {
        session,
        executor: new ToolExecutor(session),
        message: REQUEST,
        history: [],
      },
      { maxIterations: config.maxToolIterations, logger: createLogger('warn') },
    );
  } catch (error) {
    heading('FAILED');
    if (error instanceof ModelError) {
      process.stderr.write(`${error.kind}: ${error.message}\n`);
      if (error.hint) process.stderr.write(`\nHint: ${error.hint}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    return 1;
  }

  heading('Tool calls');
  if (result.toolCalls.length === 0) {
    process.stdout.write('(none - the model answered without inspecting or editing)\n');
  }
  for (const call of result.toolCalls) {
    const mark = call.ok ? '\x1b[32mok\x1b[0m' : '\x1b[31mfailed\x1b[0m';
    process.stdout.write(`  ${mark}  ${call.name} (${call.durationMs}ms)\n`);
    if (!call.ok && !call.result.ok) {
      process.stdout.write(`        ${call.result.error.message}\n`);
    }
  }

  heading("Bender's reply");
  process.stdout.write(`${result.reply}\n`);

  heading('Changes');
  const diff = session.diff();
  if (diff.length === 0) {
    process.stdout.write('(nothing changed)\n');
  }
  for (const change of diff) {
    process.stdout.write(
      `  ${change.dsp}/${change.slot} (${change.label}) ${change.parameter}: ` +
        `${String(change.before)} -> ${String(change.after)}\n`,
    );
  }

  heading('Round trip');
  const output = session.serialize();
  const reparsed = HelixPreset.parse(output);
  const stable = reparsed.serialize() === output;

  process.stdout.write(`  reparses identically: ${stable ? 'yes' : 'NO'}\n`);
  process.stdout.write(`  output differs from input: ${output !== original ? 'yes' : 'no'}\n`);

  heading('Metrics');
  process.stdout.write(`  model iterations: ${result.iterations}\n`);
  process.stdout.write(`  request ids: ${result.modelRequestIds.join(', ') || '(none)'}\n`);
  process.stdout.write(`  tokens: ${JSON.stringify(result.usage)}\n`);
  process.stdout.write(`  wall clock: ${Date.now() - started}ms\n`);

  if (!stable) {
    process.stderr.write('\nRound trip failed - the edited preset does not reserialize stably.\n');
    return 1;
  }

  process.stdout.write('\n\x1b[32mSmoke test passed.\x1b[0m\n');
  return 0;
}

process.exit(await main());
