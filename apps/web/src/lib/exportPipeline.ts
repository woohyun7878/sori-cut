/**
 * Pure helpers for the FFmpeg-based export pipeline.
 *
 * These are deliberately free of React and FFmpeg imports so the export
 * component's reliability-critical logic (progress clamping, duration
 * validation, input-file naming) can be unit-tested deterministically.
 */

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
 * Resolves an authoritative, finite, positive export duration from the
 * project/timeline duration and the source video duration, or `null` when
 * neither is usable.
 *
 * Media metadata can be `0` (not yet loaded), `NaN`, or `Infinity` (streams of
 * unknown length). Silently substituting a small fallback would let `-shortest`
 * truncate the whole export to that bogus length, so callers must treat `null`
 * as "duration unknown" and refuse to export rather than guess.
 */
export function resolveExportDuration(
  totalDuration: number,
  videoDuration: number,
): number | null {
  for (const candidate of [totalDuration, videoDuration]) {
    if (Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }

  return null;
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
