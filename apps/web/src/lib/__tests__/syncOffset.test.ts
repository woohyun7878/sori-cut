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

  it('replaces rather than accumulates a repeated application', () => {
    const first = mapSignedSyncOffset(track({ sourceStartOffset: 1.25 }), -3);
    const second = mapSignedSyncOffset(first, -3);

    expect(second).toEqual(first);
    expect(mapSignedSyncOffset(first, 4)).toEqual({
      startOffset: 4,
      sourceStartOffset: 1.25,
      syncOffset: 4,
    });
  });

  it('clamps both boundaries to the analyzer range', () => {
    expect(mapSignedSyncOffset(track(), 100).syncOffset).toBe(SYNC_OFFSET_LIMIT_SECONDS);
    expect(mapSignedSyncOffset(track(), -100).syncOffset).toBe(-SYNC_OFFSET_LIMIT_SECONDS);
  });
});
