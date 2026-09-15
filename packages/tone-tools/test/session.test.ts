/**
 * Session semantics: transactions, undo/redo, and the guarantee that a
 * rejected edit is indistinguishable from one that never ran.
 */

import { describe, expect, it } from 'vitest';
import { HelixPreset } from '@bender/helix';
import { ToneSession } from '../src/session.js';
import { openSession, realPreset, SNAPSHOT_PRESET } from './helpers.js';

describe('opening a session', () => {
  it('opens a valid preset', () => {
    const result = ToneSession.open(realPreset());

    expect('session' in result).toBe(true);
  });

  it('refuses a file that is not JSON', () => {
    const result = ToneSession.open('this is not a preset');

    expect('error' in result).toBe(true);
    expect((result as { error: { message: string } }).error.message).toContain('could not be read');
  });

  it('refuses a preset that is already structurally broken', () => {
    // Editing an inherited problem would make Bender look like the cause of
    // damage it did not do.
    const broken = SNAPSHOT_PRESET.replace('"@position" : 1', '"@position" : 0');
    const result = ToneSession.open(broken);

    expect('error' in result).toBe(true);
    expect((result as { error: { message: string } }).error.message).toContain('duplicate-position');
  });

  it('accepts a preset whose only problems are warnings', () => {
    // An unfamiliar device is not a reason to refuse to help.
    const result = ToneSession.open(SNAPSHOT_PRESET.replace('2162689', '9999999'));

    expect('session' in result).toBe(true);
  });
});

describe('transactions', () => {
  it('commits a valid change', () => {
    const session = openSession(SNAPSHOT_PRESET);

    const result = session.transact('test', (draft) => {
      const before = draft.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master', 0.5);
      return {
        tool: 'test',
        summary: 'Master up',
        target: { dsp: 'dsp0', slot: 'block0', label: 'Amp' },
        parameter: 'Master',
        before,
        after: 0.5,
      };
    });

    expect(result.ok).toBe(true);
    expect(session.preset.findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master')?.value).toBe(0.5);
  });

  it('rolls back completely when validation fails', () => {
    const session = openSession(SNAPSHOT_PRESET);
    const before = session.serialize();

    const result = session.transact('test', (draft) => {
      // Two blocks in one chain position: structurally impossible.
      draft.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Level', 0.9);
      const blockOne = draft.slotNode({ dsp: 'dsp0', slot: 'block1' })!;
      for (const entry of blockOne.entries) {
        if (entry.key === '@position') entry.value = { kind: 'number', value: 0 };
      }
      return {
        tool: 'test',
        summary: 'collides',
        target: { dsp: 'dsp0', slot: 'block1', label: 'Comp' },
      };
    });

    expect(result.ok).toBe(false);
    expect(session.serialize()).toBe(before);
    expect(session.edits).toHaveLength(0);
  });

  it('turns a throwing mutation into a failure, not a crash', () => {
    const session = openSession(SNAPSHOT_PRESET);
    const before = session.serialize();

    const result = session.transact('test', (draft) => {
      draft.writeParameter({ dsp: 'dsp0', slot: 'nope' }, 'Drive', 0.5);
      return undefined;
    });

    expect(result.ok).toBe(false);
    expect(session.serialize()).toBe(before);
  });

  it('records nothing when a mutation reports no change', () => {
    const session = openSession(SNAPSHOT_PRESET);

    const result = session.transact('test', () => undefined);

    expect(result.ok).toBe(true);
    expect(session.edits).toHaveLength(0);
    expect(session.isModified).toBe(false);
  });

  it('numbers edits monotonically', () => {
    const session = openSession(SNAPSHOT_PRESET);
    const write = (value: number) =>
      session.transact('test', (draft) => ({
        tool: 'test',
        summary: `Master ${value}`,
        target: { dsp: 'dsp0', slot: 'block0', label: 'Amp' },
        parameter: 'Master',
        before: draft.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master', value),
        after: value,
      }));

    write(0.4);
    write(0.5);
    write(0.6);

    expect(session.edits.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});

describe('undo and redo', () => {
  function sessionWithEdits() {
    const session = openSession(SNAPSHOT_PRESET);
    const write = (value: number) =>
      session.transact('test', (draft) => ({
        tool: 'test',
        summary: `Master -> ${value}`,
        target: { dsp: 'dsp0', slot: 'block0', label: 'Amp' },
        parameter: 'Master',
        before: draft.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master', value),
        after: value,
      }));

    write(0.4);
    write(0.5);
    return session;
  }

  it('restores the exact previous bytes', () => {
    const session = sessionWithEdits();
    session.undo();

    expect(session.preset.findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master')?.value).toBe(0.4);
  });

  it('restores the original bytes after undoing everything', () => {
    const session = sessionWithEdits();
    session.undo();
    session.undo();

    expect(session.serialize()).toBe(SNAPSHOT_PRESET);
    expect(session.isModified).toBe(false);
  });

  it('redoes an undone edit', () => {
    const session = sessionWithEdits();
    session.undo();

    expect(session.canRedo).toBe(true);
    session.redo();

    expect(session.preset.findParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master')?.value).toBe(0.5);
  });

  it('discards the redo branch when a new edit is made', () => {
    const session = sessionWithEdits();
    session.undo();

    session.transact('test', (draft) => ({
      tool: 'test',
      summary: 'divergent',
      target: { dsp: 'dsp0', slot: 'block0', label: 'Amp' },
      parameter: 'Master',
      before: draft.writeParameter({ dsp: 'dsp0', slot: 'block0' }, 'Master', 0.9),
      after: 0.9,
    }));

    expect(session.canRedo).toBe(false);
  });

  it('reports nothing to undo on an untouched session', () => {
    const session = openSession(SNAPSHOT_PRESET);

    expect(session.canUndo).toBe(false);
    expect(session.undo().ok).toBe(false);
  });

  it('resets to the uploaded preset', () => {
    const session = sessionWithEdits();
    session.reset();

    expect(session.serialize()).toBe(SNAPSHOT_PRESET);
    expect(session.edits).toEqual([]);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
  });
});

describe('the original preset is never mutated', () => {
  it('keeps the uploaded bytes available after many edits', () => {
    const session = openSession();
    const original = realPreset();

    for (const value of [0.1, 0.2, 0.3, 0.4]) {
      session.transact('test', (draft) => ({
        tool: 'test',
        summary: `Drive ${value}`,
        target: { dsp: 'dsp0', slot: 'block1', label: 'Amp' },
        parameter: 'Drive',
        before: draft.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive', value),
        after: value,
      }));
    }

    expect(session.originalPreset.serialize()).toBe(original);
    expect(session.serialize()).not.toBe(original);
  });
});

describe('round-trip safety end to end', () => {
  it('produces a downloadable preset that reparses identically', () => {
    const session = openSession();
    session.transact('test', (draft) => ({
      tool: 'test',
      summary: 'Drive up',
      target: { dsp: 'dsp0', slot: 'block1', label: 'Amp' },
      parameter: 'Drive',
      before: draft.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive', 0.8),
      after: 0.8,
    }));

    const downloaded = session.serialize();
    expect(HelixPreset.parse(downloaded).serialize()).toBe(downloaded);
  });

  it('changes only the intended bytes', () => {
    const session = openSession();
    const before = realPreset();

    session.transact('test', (draft) => ({
      tool: 'test',
      summary: 'Drive up',
      target: { dsp: 'dsp0', slot: 'block1', label: 'Amp' },
      parameter: 'Drive',
      before: draft.writeParameter({ dsp: 'dsp0', slot: 'block1' }, 'Drive', 0.8),
      after: 0.8,
    }));

    // The new value is written as 0.80, not 0.8, because the value it replaced
    // had two decimals. Substituting the original back must reproduce the file
    // exactly, which proves nothing else moved.
    const after = session.serialize();
    expect(after).toContain('"Drive":0.80');
    expect(after.replace('"Drive":0.80', '"Drive":0.62')).toBe(before);
  });
});
