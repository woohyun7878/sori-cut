import { describe, expect, it } from 'vitest';
import { migrateStoredTimelineTrack } from '../projectStorage';
import type { TimelineTrack } from '../../store/useProjectStore';

function legacyTrack(startOffset: number, sourceStartOffset: number): TimelineTrack {
  return {
    id: 'legacy',
    name: 'Legacy',
    type: 'audio',
    sourceUrl: 'blob:legacy',
    startOffset,
    sourceStartOffset,
    duration: 10,
    muted: false,
    volume: 1,
  };
}

describe('migrateStoredTimelineTrack', () => {
  it.each([
    ['positive alignment', 3, 1, 2],
    ['negative alignment', 1, 3, -2],
    ['common trim', 2, 2, 0],
  ])('derives %s from timeline minus source placement', (_name, start, source, expected) => {
    expect(migrateStoredTimelineTrack(legacyTrack(start, source)).syncOffset).toBe(expected);
  });
});
