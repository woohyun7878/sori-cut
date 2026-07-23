/**
 * Platform export presets for short-form vertical (9:16) video.
 *
 * Each preset captures the ideal delivery spec for a platform — resolution,
 * frame rate, a target video bitrate, and the maximum clip length the platform
 * recommends. The preset is mapped to FFmpeg arguments at export time and used
 * to warn creators when a project runs longer than a platform allows.
 */

export type ExportPresetId = 'instagram-reels' | 'youtube-shorts' | 'tiktok';

export interface ExportPreset {
  id: ExportPresetId;
  /** Human-readable platform name shown in the UI. */
  name: string;
  /** Output frame width in pixels. */
  width: number;
  /** Output frame height in pixels. */
  height: number;
  /** Target frame rate in frames per second. */
  fps: number;
  /** Target (max) video bitrate in kilobits per second. */
  videoBitrateKbps: number;
  /** Maximum recommended clip duration in seconds for this platform. */
  maxDurationSeconds: number;
}

export const exportPresets: ExportPreset[] = [
  {
    id: 'instagram-reels',
    name: 'Instagram Reels',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 8000,
    maxDurationSeconds: 90,
  },
  {
    id: 'youtube-shorts',
    name: 'YouTube Shorts',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 12000,
    maxDurationSeconds: 60,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 10000,
    maxDurationSeconds: 180,
  },
];

export const DEFAULT_EXPORT_PRESET_ID: ExportPresetId = 'instagram-reels';

export function getExportPreset(id: ExportPresetId): ExportPreset {
  const preset = exportPresets.find((option) => option.id === id);

  if (!preset) {
    throw new Error(`Unknown export preset: ${id}`);
  }

  return preset;
}

/**
 * Resolves a preset by id, falling back to the default preset when the id is
 * missing or unrecognised. Unlike {@link getExportPreset} this never throws, so
 * it is safe to call during render with a value that may have come from
 * persisted or otherwise untrusted state.
 */
export function resolveExportPreset(id: string | null | undefined): ExportPreset {
  return exportPresets.find((option) => option.id === id) ?? getExportPreset(DEFAULT_EXPORT_PRESET_ID);
}

export type ExportQuality = 'draft' | 'standard' | 'high';

export interface ExportQualityOption {
  id: ExportQuality;
  label: string;
  /** x264 Constant Rate Factor (lower = higher quality, larger file). */
  crf: number;
  /** x264 encoder speed preset. */
  encoderPreset: string;
}

export const exportQualityOptions: ExportQualityOption[] = [
  { id: 'draft', label: 'Draft (fast preview)', crf: 30, encoderPreset: 'veryfast' },
  { id: 'standard', label: 'Standard', crf: 24, encoderPreset: 'medium' },
  { id: 'high', label: 'High quality', crf: 19, encoderPreset: 'slow' },
];

export const DEFAULT_EXPORT_QUALITY: ExportQuality = 'standard';

export function getExportQuality(id: ExportQuality): ExportQualityOption {
  const quality = exportQualityOptions.find((option) => option.id === id);

  if (!quality) {
    throw new Error(`Unknown export quality: ${id}`);
  }

  return quality;
}

/**
 * Resolves a quality tier by id, falling back to the default tier when the id is
 * missing or unrecognised. Never throws, so it is safe to call during render.
 */
export function resolveExportQuality(id: string | null | undefined): ExportQualityOption {
  return exportQualityOptions.find((option) => option.id === id) ?? getExportQuality(DEFAULT_EXPORT_QUALITY);
}

/**
 * FFmpeg video filter that fits the source inside the preset canvas while
 * preserving aspect ratio, padding any letterbox area with black.
 */
export function buildScaleFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
}

export interface BuildFFmpegArgsOptions {
  preset: ExportPreset;
  /** Name of the video input written to the FFmpeg FS. */
  inputName: string;
  /** Name of the mixed audio input written to the FFmpeg FS. */
  audioName: string;
  /** Name of the muxed output file. */
  outputName: string;
  /** x264 CRF quality target. Defaults to standard quality. */
  crf?: number;
  /** x264 encoder speed preset. */
  encoderPreset?: string;
  /** AAC audio bitrate, e.g. '192k'. */
  audioBitrate?: string;
}

/**
 * Maps an export preset (plus quality knobs) to the FFmpeg argument list used
 * to render a platform-ready vertical video. The preset drives resolution,
 * frame rate, and the video bitrate ceiling; CRF provides the quality target
 * while `-maxrate`/`-bufsize` cap the bitrate to the platform's recommendation.
 */
export function buildExportFFmpegArgs(options: BuildFFmpegArgsOptions): string[] {
  const {
    preset,
    inputName,
    audioName,
    outputName,
    crf = getExportQuality(DEFAULT_EXPORT_QUALITY).crf,
    encoderPreset = getExportQuality(DEFAULT_EXPORT_QUALITY).encoderPreset,
    audioBitrate = '192k',
  } = options;

  const maxrate = `${preset.videoBitrateKbps}k`;
  const bufsize = `${preset.videoBitrateKbps * 2}k`;

  return [
    '-i',
    inputName,
    '-i',
    audioName,
    '-vf',
    buildScaleFilter(preset.width, preset.height),
    '-r',
    String(preset.fps),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    encoderPreset,
    '-crf',
    String(crf),
    '-maxrate',
    maxrate,
    '-bufsize',
    bufsize,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    '-movflags',
    '+faststart',
    '-shortest',
    outputName,
  ];
}

export interface DurationValidation {
  /** Whether the duration is within the preset's recommended maximum. */
  withinRecommendedMax: boolean;
  /** Seconds by which the duration exceeds the maximum (0 when within limit). */
  overageSeconds: number;
  /** The preset's recommended maximum, echoed for convenience. */
  maxDurationSeconds: number;
}

/**
 * Compares a project duration against a preset's recommended maximum. Invalid
 * durations (NaN, Infinity, negative) are treated as 0 so the UI never reports
 * a spurious overage.
 */
export function validateDuration(preset: ExportPreset, durationSeconds: number): DurationValidation {
  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const overageSeconds = Math.max(0, safeDuration - preset.maxDurationSeconds);

  return {
    withinRecommendedMax: overageSeconds === 0,
    overageSeconds,
    maxDurationSeconds: preset.maxDurationSeconds,
  };
}

/** Builds a download filename from the source name and the chosen preset. */
export function buildExportFileName(baseName: string, preset: ExportPreset): string {
  const stem = baseName.replace(/\.[^.]+$/, '').trim() || 'sori-cut-export';
  return `${stem}-${preset.id}.mp4`;
}

/** Formats a kbps bitrate for display, e.g. 8000 -> "8 Mbps", 800 -> "800 kbps". */
export function formatBitrate(kbps: number): string {
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    const rounded = Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1);
    return `${rounded} Mbps`;
  }

  return `${kbps} kbps`;
}
