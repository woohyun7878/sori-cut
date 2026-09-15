/**
 * Shared test fixtures.
 *
 * The preset is the real MIT-licensed fixture from @bender/helix rather than
 * a hand-written stub, so these tests exercise the same quirks a real upload
 * would: minified formatting, an unsorted dsp order, and a snapshot that
 * mirrors block state.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../src/model/provider.js';
import { createLogger, type Logger } from '../src/observability.js';
import { loadConfig, type ServerConfig } from '../src/config.js';

export function realPreset(): string {
  return readFileSync(
    fileURLToPath(new URL('../../../packages/helix/test/fixtures/possum.hlx', import.meta.url)),
    'utf8',
  );
}

export const TEST_ENV = {
  AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
  AZURE_OPENAI_DEPLOYMENT: 'test-deployment',
  LOG_LEVEL: 'error',
};

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig(TEST_ENV as NodeJS.ProcessEnv), ...overrides };
}

/** Collects log lines so tests can assert on what was and was not written. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    logger: createLogger('debug', {}, (line) => lines.push(line)),
    lines,
  };
}

export function silentLogger(): Logger {
  return createLogger('error', {}, () => {});
}

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; arguments: string | Record<string, unknown> }[];
  /** Thrown instead of returning, to simulate a provider failure. */
  throws?: unknown;
}

/**
 * A provider that replays a fixed script.
 *
 * Every test that involves the loop uses this rather than Azure. Real model
 * output is not reproducible, and a test that depends on what a model felt
 * like doing that afternoon is not a test.
 */
export class ScriptedProvider implements ModelProvider {
  readonly description = 'scripted';
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });

    const turn = this.script[this.index] ?? { text: 'Nothing left to do.' };
    this.index += 1;

    if (turn.throws) throw turn.throws;

    return {
      id: `resp_${this.index}`,
      text: turn.text ?? '',
      toolCalls: (turn.toolCalls ?? []).map((call, i) => ({
        callId: `call_${this.index}_${i}`,
        name: call.name,
        arguments:
          typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
      })),
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      latencyMs: 1,
    };
  }

  get callCount(): number {
    return this.index;
  }
}
