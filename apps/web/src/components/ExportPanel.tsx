import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { audioBufferToWavBlob, mixAudioTracks } from '../lib/audioMixer';
import {
  DEFAULT_EXPORT_PRESET_ID,
  DEFAULT_EXPORT_QUALITY,
  buildExportFFmpegArgs,
  buildExportFileName,
  exportPresets,
  exportQualityOptions,
  formatBitrate,
  resolveExportPreset,
  resolveExportQuality,
  validateDuration,
  type ExportPresetId,
  type ExportQuality,
} from '../lib/exportPresets';
import {
  buildInputVideoName,
  clampProgress,
  getExportScratchFiles,
  resolveExportDuration,
} from '../lib/exportPipeline';
import { calculateProjectDuration, useProjectStore } from '../store/useProjectStore';

interface ExportStats {
  duration: number;
  fileSize: string;
}

const FFMPEG_CORE_VERSION = '0.12.6';

function formatDuration(duration: number) {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadFFmpeg(ffmpeg: FFmpeg) {
  if (ffmpeg.loaded) {
    return;
  }

  const baseUrl = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;
  const coreURL = await toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm');

  await ffmpeg.load({ coreURL, wasmURL });
}

/** Best-effort removal of scratch files from the FFmpeg virtual FS. */
async function cleanupScratchFiles(ffmpeg: FFmpeg, files: string[]) {
  for (const file of files) {
    try {
      await ffmpeg.deleteFile(file);
    } catch {
      // The file may never have been written (early failure) or the worker may
      // already be torn down — either way there is nothing to recover.
    }
  }
}

export function ExportPanel() {
  const video = useProjectStore((state) => state.video);
  const tracks = useProjectStore((state) => state.tracks);
  const totalDuration = useMemo(() => calculateProjectDuration(tracks, video), [tracks, video]);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const isExportingRef = useRef(false);
  const isMountedRef = useRef(true);
  const canceledRef = useRef(false);
  const [presetId, setPresetId] = useState<ExportPresetId>(DEFAULT_EXPORT_PRESET_ID);
  const [quality, setQuality] = useState<ExportQuality>(DEFAULT_EXPORT_QUALITY);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState('sori-cut-export.mp4');
  const [stats, setStats] = useState<ExportStats | null>(null);

  const preset = resolveExportPreset(presetId);
  const qualityOption = resolveExportQuality(quality);
  const durationValidation = validateDuration(preset, totalDuration);

  useEffect(() => {
    return () => {
      if (downloadUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  // Tear down the FFmpeg web worker if the panel unmounts mid-export so we never
  // leak a running worker or fire state updates on an unmounted component.
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;

      if (ffmpegRef.current) {
        try {
          ffmpegRef.current.terminate();
        } catch {
          // Worker may already be gone; nothing else to do.
        }
        ffmpegRef.current = null;
      }
    };
  }, []);

  const handleCancel = () => {
    const ffmpeg = ffmpegRef.current;

    if (!ffmpeg || !isExportingRef.current) {
      return;
    }

    // Mark cancellation before terminating so the in-flight export's rejected
    // promise is not surfaced as an error.
    canceledRef.current = true;

    try {
      ffmpeg.terminate();
    } catch {
      // Ignore — the worker is being discarded regardless.
    }

    // A terminated instance cannot be reused; force a fresh load next run.
    ffmpegRef.current = null;
    isExportingRef.current = false;
    setIsExporting(false);
    setProgress(0);
    setError(null);
    setStatus('Export canceled');
  };

  const handleExport = async () => {
    // Hard guard against overlapping runs. The disabled button alone is not
    // enough: state updates are async, so rapid re-entry can slip through.
    if (isExportingRef.current) {
      return;
    }

    if (!video) {
      setError('Upload a video before exporting.');
      return;
    }

    isExportingRef.current = true;
    canceledRef.current = false;
    setIsExporting(true);
    setError(null);
    setProgress(0);
    setStatus('Loading FFmpeg...');

    const inputName = buildInputVideoName(video.name);
    const audioName = 'mixed-audio.wav';
    const outputName = buildExportFileName(video.name, preset);
    const scratchFiles = getExportScratchFiles(inputName, audioName, outputName);
    const exportDuration = resolveExportDuration(totalDuration, video.duration);
    let ffmpeg: FFmpeg | null = null;

    try {
      ffmpeg = ffmpegRef.current ?? new FFmpeg();

      if (ffmpegRef.current !== ffmpeg) {
        ffmpeg.on('progress', ({ progress: nextProgress }) => {
          if (isMountedRef.current) {
            setProgress(clampProgress(nextProgress));
          }
        });
        ffmpegRef.current = ffmpeg;
      }

      await loadFFmpeg(ffmpeg);

      setStatus('Preparing mixed audio...');
      const mixedAudio = await mixAudioTracks(
        tracks
          .filter((track) => track.type !== 'video')
          .map((track) => ({
            url: track.sourceUrl,
            offset: track.startOffset,
            volume: track.volume,
            muted: track.muted,
            sourceStartOffset: track.sourceStartOffset,
            duration: track.duration,
          })),
        exportDuration,
      );
      const wavBlob = audioBufferToWavBlob(mixedAudio);

      setStatus('Writing files to FFmpeg FS...');
      await ffmpeg.writeFile(inputName, await fetchFile(video.blob));
      await ffmpeg.writeFile(audioName, await fetchFile(wavBlob));

      setStatus('Encoding export...');
      const exitCode = await ffmpeg.exec(
        buildExportFFmpegArgs({
          preset,
          inputName,
          audioName,
          outputName,
          crf: qualityOption.crf,
          encoderPreset: qualityOption.encoderPreset,
        }),
      );

      if (exitCode !== 0) {
        throw new Error('FFmpeg command failed.');
      }

      const output = await ffmpeg.readFile(outputName);

      if (!(output instanceof Uint8Array)) {
        throw new Error('Could not read the exported file.');
      }

      const blob = new Blob([new Uint8Array(output)], { type: 'video/mp4' });
      const nextDownloadUrl = URL.createObjectURL(blob);

      await cleanupScratchFiles(ffmpeg, scratchFiles);

      // If the panel unmounted while encoding, drop the freshly created URL
      // instead of leaking it, and skip the (now invalid) state updates.
      if (!isMountedRef.current) {
        URL.revokeObjectURL(nextDownloadUrl);
        return;
      }

      if (downloadUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(downloadUrl);
      }

      setDownloadUrl(nextDownloadUrl);
      setDownloadName(outputName);
      setStats({
        duration: exportDuration,
        fileSize: formatFileSize(blob.size),
      });
      setProgress(100);
      setStatus('Export complete');
    } catch (caughtError) {
      // Cancellation rejects the in-flight promise; that is expected, not an error.
      if (!canceledRef.current) {
        if (ffmpeg) {
          await cleanupScratchFiles(ffmpeg, scratchFiles);
        }

        if (isMountedRef.current) {
          setError(
            caughtError instanceof Error
              ? `Export failed: ${caughtError.message}`
              : 'An unknown error occurred during export.',
          );
          setStatus(null);
          setProgress(0);
        }
      }
    } finally {
      isExportingRef.current = false;

      if (isMountedRef.current && !canceledRef.current) {
        setIsExporting(false);
      }
    }
  };

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div>
        <h2 className="text-2xl font-semibold text-white">Export Panel</h2>
        <p className="mt-2 text-sm text-gray-400">Render vertical short-form video with muxed audio via FFmpeg.wasm.</p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="block text-sm text-gray-300">
          Platform preset
          <select
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            value={presetId}
            onChange={(event) => setPresetId(event.target.value as ExportPresetId)}
          >
            {exportPresets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm text-gray-300">
          Quality
          <select
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            value={quality}
            onChange={(event) => setQuality(event.target.value as ExportQuality)}
          >
            {exportQualityOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Target spec · {preset.name}</h3>
          <span className="text-xs uppercase tracking-[0.16em] text-gray-500">H.264 + AAC</span>
        </div>
        <div className="mt-3 grid gap-3 text-sm text-gray-300 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Resolution</p>
            <p className="mt-2">
              {preset.width} × {preset.height} · 9:16
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Frame rate</p>
            <p className="mt-2">{preset.fps} fps</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Target bitrate</p>
            <p className="mt-2">{formatBitrate(preset.videoBitrateKbps)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Max length</p>
            <p className="mt-2">{formatDuration(preset.maxDurationSeconds)}</p>
          </div>
        </div>
        <div className="mt-3 border-t border-gray-800 pt-3 text-sm text-gray-400">
          Project duration:{' '}
          <span className={durationValidation.withinRecommendedMax ? 'text-gray-200' : 'text-amber-300'}>
            {formatDuration(totalDuration || 0)}
          </span>
        </div>
      </div>

      {!durationValidation.withinRecommendedMax ? (
        <div className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          This project is {formatDuration(totalDuration || 0)}, longer than {preset.name}&apos;s recommended maximum of{' '}
          {formatDuration(preset.maxDurationSeconds)}. You can still export, but {preset.name} may reject or trim the
          upload — consider trimming about {formatDuration(durationValidation.overageSeconds)}.
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          className="w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-900"
          disabled={isExporting}
          type="button"
          onClick={() => void handleExport()}
        >
          {isExporting ? 'Exporting...' : 'Start Export'}
        </button>

        {isExporting ? (
          <button
            className="w-full rounded-xl border border-gray-700 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-gray-500 hover:text-white sm:w-auto sm:whitespace-nowrap sm:px-6"
            type="button"
            onClick={handleCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {(isExporting || status) && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span>{status ?? 'Processing...'}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {error ? (
        <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {downloadUrl ? (
        <div className="mt-6 rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">Ready to download</h3>
              {stats ? (
                <p className="mt-2 text-sm text-gray-400">
                  {stats.fileSize} · {formatDuration(stats.duration)}
                </p>
              ) : null}
            </div>

            <a
              className="inline-flex items-center justify-center rounded-xl border border-brand-500/60 bg-brand-500/15 px-4 py-3 text-sm font-semibold text-brand-100 transition-colors hover:bg-brand-500/25"
              download={downloadName}
              href={downloadUrl}
            >
              Download
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
