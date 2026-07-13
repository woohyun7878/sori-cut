import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { audioBufferToWavBlob, mixAudioTracks } from '../lib/audioMixer';
import { calculateProjectDuration, useProjectStore } from '../store/useProjectStore';

type Platform = 'Instagram Reels' | 'YouTube Shorts' | 'TikTok';
type Quality = 'draft' | 'standard' | 'high';

interface ExportStats {
  duration: number;
  fileSize: string;
}

const FFMPEG_CORE_VERSION = '0.12.6';
const platformOptions: Platform[] = ['Instagram Reels', 'YouTube Shorts', 'TikTok'];

const qualityOptions: Record<Quality, { crf: string; label: string; preset: string }> = {
  draft: { crf: '30', label: 'Draft (빠른 미리보기)', preset: 'veryfast' },
  standard: { crf: '24', label: 'Standard (표준)', preset: 'medium' },
  high: { crf: '19', label: 'High (고화질)', preset: 'slow' },
};

function formatDuration(duration: number) {
  const minutes = Math.floor(duration / 60);
  const seconds = Math.floor(duration % 60);
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

export function ExportPanel() {
  const video = useProjectStore((state) => state.video);
  const tracks = useProjectStore((state) => state.tracks);
  const totalDuration = useMemo(() => calculateProjectDuration(tracks, video), [tracks, video]);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [platform, setPlatform] = useState<Platform>('Instagram Reels');
  const [quality, setQuality] = useState<Quality>('standard');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState('sori-cut-export.mp4');
  const [stats, setStats] = useState<ExportStats | null>(null);

  useEffect(() => {
    return () => {
      if (downloadUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  const handleExport = async () => {
    if (!video) {
      setError('먼저 영상을 업로드하세요. / Upload a video before exporting.');
      return;
    }

    setIsExporting(true);
    setError(null);
    setProgress(0);
    setStatus('FFmpeg 로딩 중... / Loading FFmpeg...');

    try {
      const ffmpeg = ffmpegRef.current ?? new FFmpeg();

      if (!ffmpegRef.current) {
        ffmpeg.on('progress', ({ progress: nextProgress }) => {
          setProgress(Math.round(nextProgress * 100));
        });
        ffmpegRef.current = ffmpeg;
      }

      await loadFFmpeg(ffmpeg);

      setStatus('오디오 믹스 준비 중... / Preparing mixed audio...');
      const mixedAudio = await mixAudioTracks(
        tracks
          .filter((track) => track.type !== 'video')
          .map((track) => ({
            url: track.sourceUrl,
            offset: track.startOffset,
            volume: track.volume,
            muted: track.muted,
          })),
        totalDuration || video.duration,
      );
      const wavBlob = audioBufferToWavBlob(mixedAudio);
      const extension = video.name.includes('.') ? video.name.slice(video.name.lastIndexOf('.')) : '.mp4';
      const inputName = `input-video${extension}`;
      const outputName = `${video.name.replace(/\.[^.]+$/, '')}-${platform.toLowerCase().replace(/\s+/g, '-')}.mp4`;
      const qualityOption = qualityOptions[quality];

      setStatus('가상 파일 시스템에 입력 쓰는 중... / Writing files to FFmpeg FS...');
      await ffmpeg.writeFile(inputName, await fetchFile(video.blob));
      await ffmpeg.writeFile('mixed-audio.wav', await fetchFile(wavBlob));

      setStatus('인코딩 중... / Encoding export...');
      const exitCode = await ffmpeg.exec([
        '-i',
        inputName,
        '-i',
        'mixed-audio.wav',
        '-vf',
        'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        qualityOption.preset,
        '-crf',
        qualityOption.crf,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-shortest',
        outputName,
      ]);

      if (exitCode !== 0) {
        throw new Error('FFmpeg 명령이 실패했습니다.');
      }

      const output = await ffmpeg.readFile(outputName);

      if (!(output instanceof Uint8Array)) {
        throw new Error('내보내기 파일을 읽지 못했습니다.');
      }

      if (downloadUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(downloadUrl);
      }

      const blob = new Blob([new Uint8Array(output)], { type: 'video/mp4' });
      const nextDownloadUrl = URL.createObjectURL(blob);

      setDownloadUrl(nextDownloadUrl);
      setDownloadName(outputName);
      setStats({
        duration: totalDuration || video.duration,
        fileSize: formatFileSize(blob.size),
      });
      setProgress(100);
      setStatus('내보내기 완료 / Export complete');
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? `내보내기에 실패했습니다: ${caughtError.message}`
          : '내보내기 중 알 수 없는 오류가 발생했습니다.',
      );
      setStatus(null);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div>
        <h2 className="text-2xl font-semibold text-white">내보내기 패널 / Export Panel</h2>
        <p className="mt-2 text-sm text-gray-400">FFmpeg.wasm으로 세로형 숏폼 비디오를 렌더링합니다 / Render vertical short-form video with muxed audio.</p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="block text-sm text-gray-300">
          플랫폼 / Platform
          <select
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Platform)}
          >
            {platformOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm text-gray-300">
          품질 / Quality
          <select
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            value={quality}
            onChange={(event) => setQuality(event.target.value as Quality)}
          >
            {Object.entries(qualityOptions).map(([value, option]) => (
              <option key={value} value={value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
        <h3 className="text-sm font-semibold text-white">포맷 정보 / Format info</h3>
        <div className="mt-3 grid gap-3 text-sm text-gray-300 md:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Canvas</p>
            <p className="mt-2">9:16 · 1080 × 1920</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Codec</p>
            <p className="mt-2">H.264 + AAC</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.16em] text-gray-500">Duration</p>
            <p className="mt-2">{formatDuration(totalDuration || 0)}</p>
          </div>
        </div>
      </div>

      <button
        className="mt-6 w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-900"
        disabled={isExporting}
        type="button"
        onClick={() => void handleExport()}
      >
        {isExporting ? '내보내는 중... / Exporting...' : '내보내기 시작 / Start Export'}
      </button>

      {(isExporting || status) && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span>{status ?? '처리 중... / Processing...'}</span>
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
              <h3 className="text-sm font-semibold text-white">다운로드 준비 완료 / Ready to download</h3>
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
              다운로드 / Download
            </a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
