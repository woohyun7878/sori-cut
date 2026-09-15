/**
 * The model/tool loop.
 *
 * These cover the behaviours that make the difference between a demo that
 * works and one that corrupts a preset or hangs: multi-turn tool calling,
 * the iteration ceiling, recovery from tool rejections, and what happens when
 * the model call itself fails.
 */

import { describe, expect, it, vi } from 'vitest';
import { ToneSession, ToolExecutor } from '@bender/tone-tools';
import { runAgentTurn } from '../src/agent/loop.js';
import { ModelError, type ModelMessage } from '../src/model/provider.js';
import { realPreset, ScriptedProvider, silentLogger } from './helpers.js';

function setup() {
  const opened = ToneSession.open(realPreset());
  if ('error' in opened) throw new Error(opened.error.message);

  return {
    session: opened.session,
    executor: new ToolExecutor(opened.session),
    history: [] as ModelMessage[],
  };
}

const options = { maxIterations: 12, logger: silentLogger(), sleep: async () => {} };

describe('a single turn', () => {
  it('returns the model reply when no tools are called', async () => {
    const provider = new ScriptedProvider([{ text: 'That preset already sounds right to me.' }]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'thoughts?' }, options);

    expect(result.reply).toBe('That preset already sounds right to me.');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
  });

  it('gives the model the preset state as instructions', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }]);
    const ctx = setup();

    await runAgentTurn(provider, { ...ctx, message: 'hi' }, options);

    const instructions = provider.requests[0].instructions;
    expect(instructions).toContain('Possum');
    expect(instructions).toContain('dsp0/block1');
  });

  it('offers every tool to the model', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }]);
    const ctx = setup();

    await runAgentTurn(provider, { ...ctx, message: 'hi' }, options);

    const names = provider.requests[0].tools.map((t) => t.name);
    expect(names).toContain('inspect_signal_chain');
    expect(names).toContain('set_parameter');
    expect(names).toContain('undo_last_change');
  });
});

describe('tool calling', () => {
  it('runs a tool and feeds the result back', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_signal_chain', arguments: {} }] },
      { text: 'There are three blocks.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'what is in here?' }, options);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].ok).toBe(true);
    expect(result.reply).toBe('There are three blocks.');

    // The second request must carry the call and its output, or the model is
    // reasoning about a tool result it never received.
    const second = provider.requests[1].messages;
    expect(second.some((m) => m.type === 'tool_call')).toBe(true);
    expect(second.some((m) => m.type === 'tool_result')).toBe(true);
  });

  it('actually changes the preset', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'set_parameter',
            arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.55 },
          },
        ],
      },
      { text: 'Brought the master up.' },
    ]);
    const ctx = setup();

    await runAgentTurn(provider, { ...ctx, message: 'more volume' }, options);

    expect(ctx.session.isModified).toBe(true);
    expect(ctx.session.preset.findParameter({ dsp: 'dsp0', slot: 'block1' }, 'Master')?.value).toBe(
      0.55,
    );
  });

  it('runs several tools in one turn', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'inspect_block', arguments: { block: 'dsp0/block1' } },
          { name: 'inspect_block', arguments: { block: 'dsp0/block0' } },
        ],
      },
      { text: 'Looked at both.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'look' }, options);

    expect(result.toolCalls).toHaveLength(2);
  });

  it('rebuilds instructions from the edited preset on each iteration', async () => {
    // Stale context is how a model ends up reasoning about a value it already
    // changed.
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'disable_block', arguments: { block: 'dsp0/block2' } },
        ],
      },
      { text: 'Bypassed it.' },
    ]);
    const ctx = setup();

    await runAgentTurn(provider, { ...ctx, message: 'turn off the volume pedal' }, options);

    expect(provider.requests[0].instructions).not.toContain('BYPASSED)\n  dsp0/block2');
    expect(provider.requests[1].instructions).toContain('BYPASSED');
  });
});

describe('recovering from bad tool calls', () => {
  it('reports a failure to the model instead of ending the turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'set_parameter', arguments: { block: 'nope', parameter: 'x', value: 1 } }] },
      { toolCalls: [{ name: 'inspect_signal_chain', arguments: {} }] },
      { text: 'Found the right block that time.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'louder' }, options);

    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.reply).toBe('Found the right block that time.');
    // The failure text has to reach the model or it cannot correct itself.
    const followUp = provider.requests[1].messages.find((m) => m.type === 'tool_result');
    expect(followUp && 'output' in followUp ? followUp.output : '').toContain('ERROR');
  });

  it('survives an unknown tool name', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'delete_everything', arguments: {} }] },
      { text: 'That is not something I can do.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'destroy it' }, options);

    expect(result.toolCalls[0].ok).toBe(false);
    expect(ctx.session.isModified).toBe(false);
  });

  it('survives malformed argument JSON', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_block', arguments: '{"block": ' }] },
      { text: 'Retrying.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'look' }, options);

    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.toolCalls[0].output).toContain('valid JSON');
  });
});

describe('the iteration ceiling', () => {
  it('stops a model that never stops calling tools', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 30 }, () => ({
        toolCalls: [{ name: 'inspect_signal_chain', arguments: {} }],
      })),
    );
    const ctx = setup();

    const result = await runAgentTurn(
      provider,
      { ...ctx, message: 'loop forever' },
      { ...options, maxIterations: 4 },
    );

    expect(result.iterations).toBe(4);
    expect(result.truncated).toBe(true);
    expect(provider.callCount).toBe(4);
  });

  it('still says something useful when truncated', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({
        toolCalls: [
          { name: 'set_parameter', arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.5 } },
        ],
      })),
    );
    const ctx = setup();

    const result = await runAgentTurn(
      provider,
      { ...ctx, message: 'go' },
      { ...options, maxIterations: 2 },
    );

    expect(result.reply).toMatch(/ran out of steps/i);
  });
});

describe('model failures', () => {
  it('retries a retryable failure', async () => {
    const provider = new ScriptedProvider([
      { throws: new ModelError('rate_limit', 'slow down', { retryable: true }) },
      { text: 'Worked on the retry.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'hi' }, options);

    expect(result.reply).toBe('Worked on the retry.');
  });

  it('does not retry an auth failure', async () => {
    // Retrying a disabled authentication type wastes time and produces the
    // same error three times.
    const provider = new ScriptedProvider([
      { throws: new ModelError('auth', 'key auth disabled') },
      { text: 'should never be reached' },
    ]);
    const ctx = setup();

    await expect(runAgentTurn(provider, { ...ctx, message: 'hi' }, options)).rejects.toThrow(
      /key auth disabled/,
    );
    expect(provider.callCount).toBe(1);
  });

  it('gives up after the attempt limit', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }, () => ({
        throws: new ModelError('server', 'boom', { retryable: true }),
      })),
    );
    const ctx = setup();

    await expect(
      runAgentTurn(provider, { ...ctx, message: 'hi' }, { ...options, maxAttempts: 3 }),
    ).rejects.toThrow(/boom/);
    expect(provider.callCount).toBe(3);
  });

  it('backs off between retries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const provider = new ScriptedProvider([
      { throws: new ModelError('server', 'a', { retryable: true }) },
      { throws: new ModelError('server', 'b', { retryable: true }) },
      { text: 'third time' },
    ]);
    const ctx = setup();

    await runAgentTurn(provider, { ...ctx, message: 'hi' }, { ...options, sleep });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1][0]).toBeGreaterThan(sleep.mock.calls[0][0]);
  });

  it('leaves the preset untouched when the model fails mid-turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_signal_chain', arguments: {} }] },
      { throws: new ModelError('server', 'died', { retryable: false }) },
    ]);
    const ctx = setup();

    await expect(runAgentTurn(provider, { ...ctx, message: 'hi' }, options)).rejects.toThrow();
    expect(ctx.session.isModified).toBe(false);
  });
});

describe('when the model says nothing', () => {
  it('describes the edits it made', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { name: 'set_parameter', arguments: { block: 'dsp0/block1', parameter: 'Master', value: 0.5 } },
        ],
      },
      { text: '' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'louder' }, options);

    expect(result.reply).toMatch(/1 change/);
  });

  it('says so when it changed nothing', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_preset', arguments: {} }] },
      { text: '' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'look' }, options);

    expect(result.reply).toMatch(/did not change anything/);
  });
});

describe('conversation continuity', () => {
  it('carries history into the next turn', async () => {
    const ctx = setup();
    const first = new ScriptedProvider([{ text: 'Sure.' }]);
    await runAgentTurn(first, { ...ctx, message: 'first question' }, options);

    const second = new ScriptedProvider([{ text: 'Still here.' }]);
    await runAgentTurn(second, { ...ctx, message: 'second question' }, options);

    const messages = second.requests[0].messages;
    expect(messages.some((m) => m.type === 'message' && m.content === 'first question')).toBe(true);
    expect(messages.some((m) => m.type === 'message' && m.content === 'second question')).toBe(true);
  });
});

describe('observability', () => {
  it('reports request ids, timings and usage', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'inspect_preset', arguments: {} }] },
      { text: 'Done.' },
    ]);
    const ctx = setup();

    const result = await runAgentTurn(provider, { ...ctx, message: 'hi' }, options);

    expect(result.modelRequestIds).toHaveLength(2);
    expect(result.usage.totalTokens).toBe(240);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.activity.filter((a) => a.kind === 'tool')).toHaveLength(1);
    expect(result.activity.filter((a) => a.kind === 'model')).toHaveLength(2);
  });
});
