import type { TimelineTrack } from '../store/useProjectStore';
import { AUTO_SYNC_MAX_LAG_SECONDS } from './autoSyncCore';

export const SYNC_OFFSET_LIMIT_SECONDS = AUTO_SYNC_MAX_LAG_SECONDS;

export type SyncOffsetTrack = Pick<
  TimelineTrack,
  'sourceStartOffset' | 'startOffset' | 'syncOffset'
>;

export type SyncOffsetUpdate = Pick<
  TimelineTrack,
  'sourceStartOffset' | 'startOffset' | 'syncOffset'
>;

export function clampSyncOffset(offsetSeconds: number): number {
  if (!Number.isFinite(offsetSeconds)) {
    return 0;
  }
  return Math.max(
    -SYNC_OFFSET_LIMIT_SECONDS,
    Math.min(SYNC_OFFSET_LIMIT_SECONDS, offsetSeconds),
  );
}

/**
 * Replace the previous sync adjustment while retaining the source's user trim.
 * Positive alignment delays on the timeline; negative alignment advances the
 * source in-point. Removing the prior adjustment makes repeated apply idempotent.
 */
export function mapSignedSyncOffset(
  track: SyncOffsetTrack,
  offsetSeconds: number,
): SyncOffsetUpdate {
  const previousOffset = clampSyncOffset(track.syncOffset ?? track.startOffset);
  const baseSourceStart = Math.max(
    0,
    track.sourceStartOffset - Math.max(0, -previousOffset),
  );
  const baseTimelineStart = Math.max(0, track.startOffset - Math.max(0, previousOffset));
  const syncOffset = clampSyncOffset(offsetSeconds);

  return {
    startOffset: baseTimelineStart + Math.max(0, syncOffset),
    sourceStartOffset: baseSourceStart + Math.max(0, -syncOffset),
    syncOffset,
  };
}
