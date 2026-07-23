import { describe, it, expect } from 'vitest';
import { buildInputVideoName, clampProgress, resolveExportDuration } from '../exportPipeline';

describe('clampProgress', () => {
  it('converts a fraction to an integer percentage', () => {
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.5)).toBe(50);
    expect(clampProgress(1)).toBe(100);
  });

  it('rounds to the nearest whole percent', () => {
    expect(clampProgress(0.123)).toBe(12);
    expect(clampProgress(0.126)).toBe(13);
  });

  it('clamps values above 1 to 100', () => {
    expect(clampProgress(1.4)).toBe(100);
  });

  it('clamps negative values to 0', () => {
    expect(clampProgress(-0.3)).toBe(0);
  });

  it('treats non-finite values as 0', () => {
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampProgress(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('resolveExportDuration', () => {
  it('prefers a finite positive project duration', () => {
    expect(resolveExportDuration(42, 100)).toBe(42);
  });

  it('falls back to the video duration when the project duration is unusable', () => {
    expect(resolveExportDuration(0, 30)).toBe(30);
    expect(resolveExportDuration(Number.NaN, 30)).toBe(30);
    expect(resolveExportDuration(-5, 30)).toBe(30);
  });

  it('rejects (returns null) when neither duration is authoritative', () => {
    // No usable length: the component must refuse to export rather than let
    // -shortest truncate the output to a guessed fallback.
    expect(resolveExportDuration(0, 0)).toBeNull();
    expect(resolveExportDuration(Number.NaN, Number.NaN)).toBeNull();
    expect(resolveExportDuration(-1, -2)).toBeNull();
  });

  it('rejects an unknown (Infinity) length instead of using it', () => {
    // Streamed/unknown-length media can report Infinity; that must not reach the
    // mixer or the encoder.
    expect(resolveExportDuration(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBeNull();
    expect(resolveExportDuration(Number.POSITIVE_INFINITY, 12)).toBe(12);
  });

  it('returns a finite positive number whenever it does not reject', () => {
    for (const [total, videoDuration] of [
      [Number.NaN, Number.POSITIVE_INFINITY],
      [15, 20],
      [0, 8],
    ] as const) {
      const result = resolveExportDuration(total, videoDuration);
      if (result !== null) {
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildInputVideoName', () => {
  it('preserves a normal file extension', () => {
    expect(buildInputVideoName('clip.mov')).toBe('input-video.mov');
    expect(buildInputVideoName('render.webm')).toBe('input-video.webm');
  });

  it('lowercases the extension', () => {
    expect(buildInputVideoName('CLIP.MP4')).toBe('input-video.mp4');
  });

  it('uses the final extension for multi-dot names', () => {
    expect(buildInputVideoName('archive.tar.gz')).toBe('input-video.gz');
  });

  it('defaults to .mp4 when there is no extension', () => {
    expect(buildInputVideoName('myclip')).toBe('input-video.mp4');
  });

  it('defaults to .mp4 for a trailing dot', () => {
    expect(buildInputVideoName('myclip.')).toBe('input-video.mp4');
  });

  it('defaults to .mp4 for an implausibly long extension', () => {
    expect(buildInputVideoName('data.longextension')).toBe('input-video.mp4');
  });

  it('defaults to .mp4 for an empty or missing name', () => {
    expect(buildInputVideoName('')).toBe('input-video.mp4');
    expect(buildInputVideoName(undefined as unknown as string)).toBe('input-video.mp4');
  });
});
