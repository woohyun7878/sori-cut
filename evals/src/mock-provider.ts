/**
 * A provider that replays a canned transcript.
 *
 * Lets a case run as an ordinary regression test: no network, no cost, and
 * the same result every time. What it checks is the tool layer and the
 * invariants, not the model's judgement -- for that you need a live run.
 */

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../apps/server/src/model/provider.js';
import type { MockTurn } from './case.js';

export class MockProvider implements ModelProvider {
  readonly description = 'mock';
  private index = 0;

  constructor(private readonly turns: MockTurn[]) {}

  async respond(_request: ModelRequest): Promise<ModelResponse> {
    const turn = this.turns[this.index];
    this.index += 1;

    if (!turn) {
      // Running past the end of the script means the model asked for more
      // turns than the case anticipated. Ending cleanly is better than
      // throwing, since the checks will then report what actually differed.
      return {
        id: `mock_${this.index}`,
        text: '',
        toolCalls: [],
        usage: {},
        latencyMs: 0,
      };
    }

    return {
      id: `mock_${this.index}`,
      text: turn.text ?? '',
      toolCalls: (turn.toolCalls ?? []).map((call, i) => ({
        callId: `mock_call_${this.index}_${i}`,
        name: call.name,
        arguments:
          typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
      })),
      usage: {},
      latencyMs: 0,
    };
  }
}
