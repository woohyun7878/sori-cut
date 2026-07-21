import type { TimelineTrack } from '../store/useProjectStore';
import { AUTO_SYNC_MAX_LAG_SECONDS } from './autoSync';

export function createSyncTrackUpdate(
  track: TimelineTrack,
  requestedOffset: number,
): Pick<
  TimelineTrack,
  | 'startOffset'
  | 'sourceStartOffset'
  | 'duration'
  | 'syncOffset'
  | 'syncBaseSourceStartOffset'
  | 'syncBaseDuration'
> {
  if (!Number.isFinite(requestedOffset) || Math.abs(requestedOffset) > AUTO_SYNC_MAX_LAG_SECONDS) {
    throw new Error(
      `Sync offset must be between -${AUTO_SYNC_MAX_LAG_SECONDS} and +${AUTO_SYNC_MAX_LAG_SECONDS} seconds`,
    );
  }

  const baseSourceStartOffset = track.syncBaseSourceStartOffset ?? track.sourceStartOffset;
  const baseDuration = track.syncBaseDuration ?? track.duration;
  const unclampedTimelineStart = requestedOffset + baseSourceStartOffset;
  const sourceTrim = Math.max(0, -unclampedTimelineStart);
  const minimumRemainingDuration = Math.min(0.5, baseDuration);
  if (baseDuration - sourceTrim < minimumRemainingDuration) {
    throw new Error('Negative sync offset exceeds the available source duration');
  }

  return {
    startOffset: Math.max(0, unclampedTimelineStart),
    sourceStartOffset: baseSourceStartOffset + sourceTrim,
    duration: baseDuration - sourceTrim,
    syncOffset: requestedOffset,
    syncBaseSourceStartOffset: baseSourceStartOffset,
    syncBaseDuration: baseDuration,
  };
}
