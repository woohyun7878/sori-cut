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

  const previousOffset = track.syncOffset ?? 0;
  const previousTimelineDelay = Math.max(0, previousOffset);
  const previousSourceTrim = Math.max(0, -previousOffset);
  const baseStartOffset = Math.max(0, track.startOffset - previousTimelineDelay);
  const baseSourceStartOffset = Math.max(0, track.sourceStartOffset - previousSourceTrim);
  const baseDuration = track.duration + previousSourceTrim;
  const nextTimelineDelay = Math.max(0, requestedOffset);
  const nextSourceTrim = Math.max(0, -requestedOffset);
  const minimumRemainingDuration = Math.min(0.5, baseDuration);
  if (baseDuration - nextSourceTrim < minimumRemainingDuration) {
    throw new Error('Negative sync offset exceeds the available source duration');
  }

  return {
    startOffset: baseStartOffset + nextTimelineDelay,
    sourceStartOffset: baseSourceStartOffset + nextSourceTrim,
    duration: baseDuration - nextSourceTrim,
    syncOffset: requestedOffset,
    syncBaseSourceStartOffset: baseSourceStartOffset,
    syncBaseDuration: baseDuration,
  };
}
