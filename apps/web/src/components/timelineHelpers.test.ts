import { describe, expect, it } from 'vitest';
import {
  computeTrimGeometry,
  formatTimelineTime,
  getMarkerStep,
  getTrackPalette,
  MIN_TRIM_DURATION,
  snapTimelineTime,
} from './timelineHelpers';

describe('timeline helpers', () => {
  it('assigns semantic stem colors from track names', () => {
    expect(getTrackPalette({ name: 'Lead Vocals', type: 'stem' }).waveform).toBe('#c4b5fd');
    expect(getTrackPalette({ name: 'Drums', type: 'stem' }).waveform).toBe('#60a5fa');
    expect(getTrackPalette({ name: 'Bass DI', type: 'stem' }).waveform).toBe('#5eead4');
    expect(getTrackPalette({ name: 'Other', type: 'stem' }).waveform).toBe('#fb923c');
    expect(getTrackPalette({ name: 'Guitar take', type: 'recording' }).waveform).toBe('#facc15');
  });

  it('uses readable ruler intervals at each zoom range', () => {
    expect(getMarkerStep(24)).toBe(5);
    expect(getMarkerStep(64)).toBe(2);
    expect(getMarkerStep(120)).toBe(1);
  });

  it('formats ruler and precise timecode values', () => {
    expect(formatTimelineTime(65.25)).toBe('01:05');
    expect(formatTimelineTime(65.25, true)).toBe('01:05.25');
    expect(formatTimelineTime(Number.NaN, true)).toBe('00:00.00');
  });

  it('snaps edit positions to quarter-second intervals when enabled', () => {
    expect(snapTimelineTime(1.13, true)).toBe(1.25);
    expect(snapTimelineTime(1.13, false)).toBe(1.13);
    expect(snapTimelineTime(-1, true)).toBe(0);
  });
});

describe('computeTrimGeometry', () => {
  const base = {
    initialOffset: 2,
    initialDuration: 8,
    initialSourceStartOffset: 2,
    knownSourceEnd: 10, // 2 + 8
    snapEnabled: false,
  };

  describe('left trim', () => {
    it('moves left edge and adjusts sourceStartOffset (right edge stays fixed)', () => {
      const result = computeTrimGeometry({ ...base, edge: 'left', deltaTime: 1 });
      expect(result).not.toBeNull();
      // Right edge: initialOffset + initialDuration = 10
      expect(result!.offset).toBeCloseTo(3);
      expect(result!.duration).toBeCloseTo(7);
      expect(result!.sourceStartOffset).toBeCloseTo(3);
      // Right edge preserved
      expect(result!.offset + result!.duration).toBeCloseTo(10);
    });

    it('clamps sourceStartOffset >= 0 when dragged left past source start', () => {
      // offset=2, sourceStartOffset=2: max left expansion is 2 seconds
      const result = computeTrimGeometry({ ...base, edge: 'left', deltaTime: -5 });
      expect(result).not.toBeNull();
      expect(result!.sourceStartOffset).toBe(0);
      expect(result!.offset).toBe(0); // initialOffset - initialSourceStartOffset = 0
      expect(result!.duration).toBeCloseTo(10); // fixedEnd - 0 = 10
      // Right edge preserved
      expect(result!.offset + result!.duration).toBeCloseTo(10);
    });

    it('clamps offset >= 0 when timeline boundary is the binding constraint', () => {
      // offset=0.5, sourceStartOffset=3: source has room but timeline hits 0
      const result = computeTrimGeometry({
        ...base,
        initialOffset: 0.5,
        initialSourceStartOffset: 3,
        initialDuration: 5,
        knownSourceEnd: 8,
        edge: 'left',
        deltaTime: -5,
      });
      expect(result).not.toBeNull();
      expect(result!.offset).toBe(0);
      expect(result!.sourceStartOffset).toBe(2.5); // only 0.5s of source revealed
      // Right edge preserved: 0.5 + 5 = 5.5
      expect(result!.offset + result!.duration).toBeCloseTo(5.5);
    });

    it('returns null when duration would go below minimum', () => {
      // Push right almost to the end
      const result = computeTrimGeometry({ ...base, edge: 'left', deltaTime: 7.95 });
      expect(result).toBeNull();
    });

    it('preserves right edge at 10 when offset=2,dur=8 dragged left past zero', () => {
      // Reviewer test case: offset=2, duration=8, sourceStartOffset=2
      const result = computeTrimGeometry({
        edge: 'left',
        initialOffset: 2,
        initialDuration: 8,
        initialSourceStartOffset: 2,
        knownSourceEnd: 10,
        deltaTime: -10,
        snapEnabled: false,
      });
      expect(result).not.toBeNull();
      expect(result!.offset).toBe(0);
      expect(result!.sourceStartOffset).toBe(0);
      expect(result!.duration).toBe(10);
      // Right edge must remain 10 — never extend
      expect(result!.offset + result!.duration).toBe(10);
    });

    it('does not extend past knownSourceEnd on left trim', () => {
      // sourceStartOffset + duration must always <= knownSourceEnd
      const result = computeTrimGeometry({ ...base, edge: 'left', deltaTime: -1 });
      expect(result).not.toBeNull();
      expect(result!.sourceStartOffset + result!.duration).toBeLessThanOrEqual(base.knownSourceEnd);
    });

    it('snaps to grid when snapEnabled', () => {
      // deltaTime = -0.6 → raw offset = 2 - 0.6 = 1.4 → snaps to 1.5
      const result = computeTrimGeometry({ ...base, edge: 'left', deltaTime: -0.6, snapEnabled: true });
      expect(result).not.toBeNull();
      expect(result!.offset).toBe(1.5);
      expect(result!.duration).toBeCloseTo(8.5);
    });
  });

  describe('right trim', () => {
    it('extends duration within bounds', () => {
      // Can't extend past knownSourceEnd: maxDuration = 10 - 2 = 8 (the initial)
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: 0 });
      expect(result).not.toBeNull();
      expect(result!.offset).toBe(2);
      expect(result!.duration).toBe(8);
      expect(result!.sourceStartOffset).toBe(2);
    });

    it('shrinks duration on negative delta', () => {
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: -3 });
      expect(result).not.toBeNull();
      expect(result!.duration).toBeCloseTo(5);
      expect(result!.offset).toBe(2);
      expect(result!.sourceStartOffset).toBe(2);
    });

    it('clamps at minimum duration', () => {
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: -20 });
      expect(result).not.toBeNull();
      expect(result!.duration).toBe(MIN_TRIM_DURATION);
    });

    it('clamps at knownSourceEnd (cannot extend past source end)', () => {
      // Trying to extend by 5 seconds beyond initial end
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: 5 });
      expect(result).not.toBeNull();
      // maxDuration = knownSourceEnd - sourceStartOffset = 10 - 2 = 8 (unchanged)
      expect(result!.duration).toBe(8);
      expect(result!.sourceStartOffset + result!.duration).toBeLessThanOrEqual(base.knownSourceEnd);
    });

    it('snaps to grid and still clamps at source end', () => {
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: 5, snapEnabled: true });
      expect(result).not.toBeNull();
      // Even with snap, can't exceed max
      expect(result!.duration).toBe(8);
    });

    it('preserves sourceStartOffset on right trim', () => {
      const result = computeTrimGeometry({ ...base, edge: 'right', deltaTime: -2 });
      expect(result).not.toBeNull();
      expect(result!.sourceStartOffset).toBe(base.initialSourceStartOffset);
    });

    it('allows re-extension back toward sourceDuration when knownSourceEnd > current end', () => {
      // Scenario: track was trimmed from duration=10 to duration=5, knownSourceEnd=12 (sourceDuration)
      const result = computeTrimGeometry({
        edge: 'right',
        initialOffset: 2,
        initialDuration: 5,
        initialSourceStartOffset: 2,
        knownSourceEnd: 12, // sourceDuration allows re-extension
        deltaTime: 3,
        snapEnabled: false,
      });
      expect(result).not.toBeNull();
      expect(result!.duration).toBe(8); // 5 + 3 = 8, within sourceDuration bound (12 - 2 = 10 max)
    });

    it('does not clamp when knownSourceEnd is Infinity (unknown duration)', () => {
      const result = computeTrimGeometry({
        edge: 'right',
        initialOffset: 2,
        initialDuration: 5,
        initialSourceStartOffset: 2,
        knownSourceEnd: Infinity,
        deltaTime: 100,
        snapEnabled: false,
      });
      expect(result).not.toBeNull();
      expect(result!.duration).toBe(105); // No upper bound
    });
  });

  describe('non-finite input rejection', () => {
    const base = {
      edge: 'left' as const,
      initialOffset: 2,
      initialDuration: 8,
      initialSourceStartOffset: 2,
      knownSourceEnd: 10,
      deltaTime: 1,
      snapEnabled: false,
    };

    it('returns null for NaN deltaTime', () => {
      expect(computeTrimGeometry({ ...base, deltaTime: NaN })).toBeNull();
    });

    it('returns null for Infinity initialOffset', () => {
      expect(computeTrimGeometry({ ...base, initialOffset: Infinity })).toBeNull();
    });

    it('returns null for NaN initialDuration', () => {
      expect(computeTrimGeometry({ ...base, initialDuration: NaN })).toBeNull();
    });

    it('returns null for -Infinity initialSourceStartOffset', () => {
      expect(computeTrimGeometry({ ...base, initialSourceStartOffset: -Infinity })).toBeNull();
    });

    it('returns null for Infinity deltaTime', () => {
      expect(computeTrimGeometry({ ...base, deltaTime: Infinity })).toBeNull();
    });
  });

  describe('exact boundary cases', () => {
    it('0.25s boundary: preview geometry matches commit exactly (no silent expansion)', () => {
      // Result duration should be exactly what computeTrimGeometry returns — no 0.5 expansion
      const result = computeTrimGeometry({
        edge: 'right',
        initialOffset: 0,
        initialDuration: 5,
        initialSourceStartOffset: 0,
        knownSourceEnd: 10,
        deltaTime: -4.25, // leaves 0.75s — above min (0.5)
        snapEnabled: false,
      });
      expect(result).not.toBeNull();
      expect(result!.duration).toBe(0.75);
    });

    it('left trim with snap that hits grid exactly produces no-change geometry', () => {
      // initialOffset=2 (already on grid), deltaTime=0 → snapped offset=2, same as initial
      const result = computeTrimGeometry({
        edge: 'left',
        initialOffset: 2,
        initialDuration: 8,
        initialSourceStartOffset: 2,
        knownSourceEnd: 10,
        deltaTime: 0,
        snapEnabled: true,
      });
      // Duration unchanged
      expect(result).not.toBeNull();
      expect(result!.offset).toBe(2);
      expect(result!.duration).toBe(8);
    });
  });
});
