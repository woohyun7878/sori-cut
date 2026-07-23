import { describe, it, expect } from 'vitest';
import {
  MIN_EXPORT_DURATION_SECONDS,
  buildInputVideoName,
  clampProgress,
  getExportScratchFiles,
  resolveExportDuration,
} from '../exportPipeline';

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

  it('falls back to the floor when both durations are unusable', () => {
    expect(resolveExportDuration(0, 0)).toBe(MIN_EXPORT_DURATION_SECONDS);
    expect(resolveExportDuration(Number.NaN, Number.NaN)).toBe(MIN_EXPORT_DURATION_SECONDS);
  });

  it('never returns Infinity even when a source reports an unknown length', () => {
    // Streamed/unknown-length media can report Infinity; that must not reach the mixer.
    expect(resolveExportDuration(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(
      MIN_EXPORT_DURATION_SECONDS,
    );
    expect(resolveExportDuration(Number.POSITIVE_INFINITY, 12)).toBe(12);
  });

  it('always returns a finite positive number', () => {
    for (const [total, videoDuration] of [
      [0, 0],
      [Number.NaN, Number.POSITIVE_INFINITY],
      [-1, -2],
      [15, 20],
    ] as const) {
      const result = resolveExportDuration(total, videoDuration);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
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

describe('getExportScratchFiles', () => {
  it('returns the distinct set of files written to the FS', () => {
    expect(getExportScratchFiles('input-video.mp4', 'mixed-audio.wav', 'out.mp4')).toEqual([
      'input-video.mp4',
      'mixed-audio.wav',
      'out.mp4',
    ]);
  });

  it('drops empty names', () => {
    expect(getExportScratchFiles('input-video.mp4', '', 'out.mp4')).toEqual([
      'input-video.mp4',
      'out.mp4',
    ]);
  });

  it('de-duplicates repeated names', () => {
    expect(getExportScratchFiles('same.mp4', 'mixed-audio.wav', 'same.mp4')).toEqual([
      'same.mp4',
      'mixed-audio.wav',
    ]);
  });
});
