import { describe, expect, it } from 'vitest';
import {
  buildToolActivity,
  collectWarnings,
  describeTool,
  prettifyDetail,
} from '../activity';
import type { ActivityEvent, ToolCall } from '../../api/types';

describe('describeTool', () => {
  it('maps known tool names to plain phrasing', () => {
    expect(describeTool('set_parameter')).toBe('Set a parameter');
    expect(describeTool('inspect_signal_chain')).toBe('Inspected the signal chain');
    expect(describeTool('disable_block')).toBe('Bypassed a block');
  });

  it('humanizes an unrecognized tool name', () => {
    expect(describeTool('frobnicate_thing')).toBe('Frobnicate thing');
  });
});

describe('prettifyDetail', () => {
  it('replaces the ASCII arrow with a typographic one', () => {
    expect(prettifyDetail('Amp Brit2204: Master 0.36 -> 0.48')).toBe(
      'Amp Brit2204: Master 0.36 → 0.48',
    );
  });
});

describe('buildToolActivity', () => {
  const activity: ActivityEvent[] = [
    { kind: 'model', name: 'reasoning', ok: true, detail: 'requested 1 tool call', durationMs: 10 },
    { kind: 'tool', name: 'inspect_signal_chain', ok: true, durationMs: 5 },
    {
      kind: 'tool',
      name: 'set_parameter',
      ok: true,
      detail: 'Amp Brit2204: Master 0.36 -> 0.48',
      durationMs: 7,
    },
    { kind: 'model', name: 'reasoning', ok: true, detail: 'composed a reply', durationMs: 9 },
  ];

  const toolCalls: ToolCall[] = [
    { name: 'inspect_signal_chain', ok: true, durationMs: 5, error: null, warnings: [] },
    {
      name: 'set_parameter',
      ok: true,
      durationMs: 7,
      error: null,
      warnings: ['This preset states no range for Master.'],
    },
  ];

  it('keeps only tool events and maps them to verbs with prettified detail', () => {
    const items = buildToolActivity(activity, toolCalls);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ verb: 'Inspected the signal chain', ok: true });
    expect(items[0]?.detail).toBeUndefined();
    expect(items[1]).toMatchObject({
      verb: 'Set a parameter',
      detail: 'Amp Brit2204: Master 0.36 → 0.48',
    });
    expect(items[1]?.warnings).toEqual(['This preset states no range for Master.']);
  });

  it('surfaces a failed tool call', () => {
    const failedActivity: ActivityEvent[] = [
      { kind: 'tool', name: 'set_parameter', ok: false, detail: 'Amp has no parameter "Foo".', durationMs: 3 },
    ];
    const failedCalls: ToolCall[] = [
      { name: 'set_parameter', ok: false, durationMs: 3, error: 'unknown_parameter', warnings: [] },
    ];

    const [item] = buildToolActivity(failedActivity, failedCalls);

    expect(item?.ok).toBe(false);
    expect(item?.detail).toBe('Amp has no parameter "Foo".');
  });
});

describe('collectWarnings', () => {
  it('collects and de-duplicates warnings across tool calls', () => {
    const calls: ToolCall[] = [
      { name: 'a', ok: true, durationMs: 1, error: null, warnings: ['w1', 'w2'] },
      { name: 'b', ok: true, durationMs: 1, error: null, warnings: ['w2', 'w3'] },
    ];

    expect(collectWarnings(calls)).toEqual(['w1', 'w2', 'w3']);
  });
});
