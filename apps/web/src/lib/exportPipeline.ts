/**
 * Pure helpers for the FFmpeg-based export pipeline.
 *
 * These are deliberately free of React and FFmpeg imports so the export
 * component's reliability-critical logic (progress clamping, duration
 * sanitisation, scratch-file naming/cleanup) can be unit-tested deterministically.
 */

/** Lower bound for a usable export duration, matching the audio mixer's floor. */
export const MIN_EXPORT_DURATION_SECONDS = 0.5;

/**
 * Converts an FFmpeg progress fraction (nominally 0..1) into an integer
 * percentage clamped to [0, 100]. Non-finite, negative, or out-of-range values
 * are coerced so the UI never renders `NaN%` or a bar wider than 100%.
 */
export function clampProgress(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return 0;
  }

  const percent = Math.round(fraction * 100);

  return Math.min(100, Math.max(0, percent));
}

/**
 * Resolves a finite, positive export duration from the project/timeline
 * duration and the source video duration.
 *
 * Media metadata can be `0` (not yet loaded), `NaN`, or `Infinity` (streams of
 * unknown length). Passing such values straight to the mixer would allocate a
 * degenerate or enormous buffer. This prefers the first finite, positive
 * candidate and otherwise falls back to a small non-zero floor.
 */
export function resolveExportDuration(totalDuration: number, videoDuration: number): number {
  for (const candidate of [totalDuration, videoDuration]) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return MIN_EXPORT_DURATION_SECONDS;
}

/**
 * Builds the FFmpeg virtual-FS input filename for the source video, preserving a
 * sane file extension. Only a short alphanumeric extension is trusted; anything
 * else (missing, trailing dot, overly long, non-alphanumeric) falls back to
 * `.mp4` so FFmpeg always receives a demuxable name.
 */
export function buildInputVideoName(videoName: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(videoName ?? '');
  const extension = match ? `.${match[1].toLowerCase()}` : '.mp4';

  return `input-video${extension}`;
}

/**
 * Returns the de-duplicated, non-empty list of scratch files written to the
 * FFmpeg virtual FS during an export, so they can be cleaned up after success or
 * failure and never leak stale state into a subsequent run.
 */
export function getExportScratchFiles(inputName: string, audioName: string, outputName: string): string[] {
  return Array.from(new Set([inputName, audioName, outputName].filter((name) => name.length > 0)));
}
