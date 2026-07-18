import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXPORT_PRESET_ID,
  DEFAULT_EXPORT_QUALITY,
  buildExportFFmpegArgs,
  buildExportFileName,
  buildScaleFilter,
  exportPresets,
  exportQualityOptions,
  formatBitrate,
  getExportPreset,
  getExportQuality,
  validateDuration,
  type ExportPreset,
} from '../exportPresets';

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('exportPresets definitions', () => {
  it('defines exactly the three supported platforms', () => {
    expect(exportPresets.map((preset) => preset.id)).toEqual([
      'instagram-reels',
      'youtube-shorts',
      'tiktok',
    ]);
  });

  it('exposes a human-readable name for each platform', () => {
    expect(exportPresets.map((preset) => preset.name)).toEqual([
      'Instagram Reels',
      'YouTube Shorts',
      'TikTok',
    ]);
  });

  it('renders every platform as 1080x1920 vertical at 30fps', () => {
    for (const preset of exportPresets) {
      expect(preset.width).toBe(1080);
      expect(preset.height).toBe(1920);
      expect(preset.fps).toBe(30);
    }
  });

  it('is 9:16 vertical for every preset', () => {
    for (const preset of exportPresets) {
      expect(preset.height / preset.width).toBeCloseTo(16 / 9, 5);
    }
  });

  it('carries a positive target video bitrate for each preset', () => {
    for (const preset of exportPresets) {
      expect(preset.videoBitrateKbps).toBeGreaterThan(0);
    }
  });

  it('uses the documented max recommended durations', () => {
    expect(getExportPreset('instagram-reels').maxDurationSeconds).toBe(90);
    expect(getExportPreset('youtube-shorts').maxDurationSeconds).toBe(60);
    expect(getExportPreset('tiktok').maxDurationSeconds).toBe(180);
  });

  it('has unique preset ids', () => {
    const ids = exportPresets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults to a preset that exists', () => {
    expect(exportPresets.some((preset) => preset.id === DEFAULT_EXPORT_PRESET_ID)).toBe(true);
  });
});

describe('getExportPreset', () => {
  it('returns the matching preset', () => {
    const preset = getExportPreset('tiktok');
    expect(preset.name).toBe('TikTok');
    expect(preset.maxDurationSeconds).toBe(180);
  });

  it('throws for an unknown preset id', () => {
    // @ts-expect-error deliberately passing an invalid id
    expect(() => getExportPreset('vimeo')).toThrow('Unknown export preset: vimeo');
  });
});

describe('export quality options', () => {
  it('exposes draft, standard, and high tiers', () => {
    expect(exportQualityOptions.map((option) => option.id)).toEqual(['draft', 'standard', 'high']);
  });

  it('orders quality tiers from lower to higher quality (descending CRF)', () => {
    const crfs = exportQualityOptions.map((option) => option.crf);
    expect(crfs).toEqual([...crfs].sort((a, b) => b - a));
  });

  it('returns the matching quality option', () => {
    expect(getExportQuality('high').crf).toBe(19);
    expect(getExportQuality('high').encoderPreset).toBe('slow');
  });

  it('throws for an unknown quality id', () => {
    // @ts-expect-error deliberately passing an invalid id
    expect(() => getExportQuality('ultra')).toThrow('Unknown export quality: ultra');
  });

  it('defaults to a quality tier that exists', () => {
    expect(exportQualityOptions.some((option) => option.id === DEFAULT_EXPORT_QUALITY)).toBe(true);
  });
});

describe('buildScaleFilter', () => {
  it('fits and pads the source into the target canvas', () => {
    expect(buildScaleFilter(1080, 1920)).toBe(
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
    );
  });
});

describe('buildExportFFmpegArgs', () => {
  const preset = getExportPreset('youtube-shorts');
  const baseOptions = {
    preset,
    inputName: 'input-video.mp4',
    audioName: 'mixed-audio.wav',
    outputName: 'out.mp4',
  };

  it('places both inputs and the output in the argument list', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    expect(args.slice(0, 4)).toEqual(['-i', 'input-video.mp4', '-i', 'mixed-audio.wav']);
    expect(args[args.length - 1]).toBe('out.mp4');
  });

  it('applies the preset resolution via the scale filter', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    expect(argValue(args, '-vf')).toBe(buildScaleFilter(preset.width, preset.height));
  });

  it('applies the preset frame rate', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    expect(argValue(args, '-r')).toBe('30');
  });

  it('caps the bitrate to the preset target with a 2x buffer', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    expect(argValue(args, '-maxrate')).toBe('12000k');
    expect(argValue(args, '-bufsize')).toBe('24000k');
  });

  it('maps different presets to their own bitrate ceiling', () => {
    const reels = buildExportFFmpegArgs({ ...baseOptions, preset: getExportPreset('instagram-reels') });
    const tiktok = buildExportFFmpegArgs({ ...baseOptions, preset: getExportPreset('tiktok') });
    expect(argValue(reels, '-maxrate')).toBe('8000k');
    expect(argValue(tiktok, '-maxrate')).toBe('10000k');
  });

  it('encodes H.264 video and AAC audio with faststart and shortest', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    expect(argValue(args, '-c:v')).toBe('libx264');
    expect(argValue(args, '-c:a')).toBe('aac');
    expect(argValue(args, '-pix_fmt')).toBe('yuv420p');
    expect(argValue(args, '-movflags')).toBe('+faststart');
    expect(args).toContain('-shortest');
  });

  it('defaults CRF and encoder preset to the standard quality tier', () => {
    const args = buildExportFFmpegArgs(baseOptions);
    const standard = getExportQuality('standard');
    expect(argValue(args, '-crf')).toBe(String(standard.crf));
    expect(argValue(args, '-preset')).toBe(standard.encoderPreset);
  });

  it('honors an explicit CRF and encoder preset', () => {
    const high = getExportQuality('high');
    const args = buildExportFFmpegArgs({
      ...baseOptions,
      crf: high.crf,
      encoderPreset: high.encoderPreset,
    });
    expect(argValue(args, '-crf')).toBe('19');
    expect(argValue(args, '-preset')).toBe('slow');
  });

  it('honors an explicit audio bitrate', () => {
    const args = buildExportFFmpegArgs({ ...baseOptions, audioBitrate: '256k' });
    expect(argValue(args, '-b:a')).toBe('256k');
  });
});

describe('validateDuration', () => {
  const preset: ExportPreset = getExportPreset('youtube-shorts'); // 60s max

  it('accepts a duration within the recommended maximum', () => {
    const result = validateDuration(preset, 45);
    expect(result.withinRecommendedMax).toBe(true);
    expect(result.overageSeconds).toBe(0);
    expect(result.maxDurationSeconds).toBe(60);
  });

  it('accepts a duration exactly at the maximum', () => {
    const result = validateDuration(preset, 60);
    expect(result.withinRecommendedMax).toBe(true);
    expect(result.overageSeconds).toBe(0);
  });

  it('flags a duration over the maximum and reports the overage', () => {
    const result = validateDuration(preset, 75);
    expect(result.withinRecommendedMax).toBe(false);
    expect(result.overageSeconds).toBe(15);
  });

  it('treats invalid or negative durations as zero', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
      const result = validateDuration(preset, value);
      expect(result.withinRecommendedMax).toBe(true);
      expect(result.overageSeconds).toBe(0);
    }
  });

  it('uses each preset own limit', () => {
    // TikTok allows 3 minutes, so 120s is fine there but over for Shorts.
    expect(validateDuration(getExportPreset('tiktok'), 120).withinRecommendedMax).toBe(true);
    expect(validateDuration(getExportPreset('youtube-shorts'), 120).withinRecommendedMax).toBe(false);
  });
});

describe('buildExportFileName', () => {
  const preset = getExportPreset('instagram-reels');

  it('replaces the extension and appends the preset id', () => {
    expect(buildExportFileName('my-clip.mov', preset)).toBe('my-clip-instagram-reels.mp4');
  });

  it('handles names without an extension', () => {
    expect(buildExportFileName('my-clip', preset)).toBe('my-clip-instagram-reels.mp4');
  });

  it('falls back to a default stem for empty names', () => {
    expect(buildExportFileName('', preset)).toBe('sori-cut-export-instagram-reels.mp4');
  });
});

describe('formatBitrate', () => {
  it('formats whole-megabit rates', () => {
    expect(formatBitrate(8000)).toBe('8 Mbps');
    expect(formatBitrate(12000)).toBe('12 Mbps');
  });

  it('formats fractional megabit rates to one decimal', () => {
    expect(formatBitrate(1500)).toBe('1.5 Mbps');
  });

  it('formats sub-megabit rates in kbps', () => {
    expect(formatBitrate(800)).toBe('800 kbps');
  });
});
