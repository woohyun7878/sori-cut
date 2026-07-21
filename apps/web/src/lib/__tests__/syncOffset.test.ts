import { describe, expect, it } from 'vitest';
import {
  mapSignedSyncOffset,
  SYNC_OFFSET_LIMIT_SECONDS,
  type SyncOffsetTrack,
} from '../syncOffset';

function track(overrides: Partial<SyncOffsetTrack> = {}): SyncOffsetTrack {
  return {
    sourceStartOffset: 0,
    startOffset: 0,
    syncOffset: 0,
    ...overrides,
  };
}

describe('mapSignedSyncOffset', () => {
  it('maps positive alignment to timeline delay and negative alignment to source advance', () => {
    expect(mapSignedSyncOffset(track(), 2.5)).toEqual({
      startOffset: 2.5,
      sourceStartOffset: 0,
      syncOffset: 2.5,
    });
    expect(mapSignedSyncOffset(track(), -2.5)).toEqual({
      startOffset: 0,
      sourceStartOffset: 2.5,
      syncOffset: -2.5,
    });
  });

  it('preserves pre-existing source trim', () => {
    expect(mapSignedSyncOffset(track({ sourceStartOffset: 1.75 }), -3)).toEqual({
      startOffset: 0,
      sourceStartOffset: 4.75,
      syncOffset: -3,
    });
  });

  it('replaces rather than accumulates a repeated source-advance application', () => {
    const first = mapSignedSyncOffset(track({ sourceStartOffset: 1.25 }), -3);
    const second = mapSignedSyncOffset(first, -3);

    expect(second).toEqual(first);
    expect(mapSignedSyncOffset(first, 4)).toEqual({
      startOffset: 4,
      sourceStartOffset: 1.25,
      syncOffset: 4,
    });
  });

  it('preserves a timeline trim made after positive sync for repeated and new values', () => {
    const first = mapSignedSyncOffset(track({ startOffset: 2 }), 3);
    const trimmed = { ...first, startOffset: 7 };

    expect(first.startOffset).toBe(5);
    expect(mapSignedSyncOffset(trimmed, 3)).toEqual(trimmed);
    expect(mapSignedSyncOffset(trimmed, 1)).toEqual({
      startOffset: 5,
      sourceStartOffset: 0,
      syncOffset: 1,
    });
  });

  it('preserves split-like timeline and source deltas across same and new sync values', () => {
    const first = mapSignedSyncOffset(
      track({ sourceStartOffset: 1, startOffset: 4 }),
      -2,
    );
    const splitTrack = {
      ...first,
      startOffset: first.startOffset + 5,
      sourceStartOffset: first.sourceStartOffset + 5,
    };

    expect(mapSignedSyncOffset(splitTrack, -2)).toEqual(splitTrack);
    expect(mapSignedSyncOffset(splitTrack, 3)).toEqual({
      startOffset: 12,
      sourceStartOffset: 6,
      syncOffset: 3,
    });
  });

  it('clamps both boundaries to the analyzer range', () => {
    expect(mapSignedSyncOffset(track(), 100).syncOffset).toBe(SYNC_OFFSET_LIMIT_SECONDS);
    expect(mapSignedSyncOffset(track(), -100).syncOffset).toBe(-SYNC_OFFSET_LIMIT_SECONDS);
  });
});
