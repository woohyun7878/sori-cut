import { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface WaveformPlayerProps {
  audioUrl: string;
  label?: string;
}

function formatTime(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function WaveformPlayer({ audioUrl, label }: WaveformPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const timeDisplay = useMemo(
    () => `${formatTime(currentTime)} / ${formatTime(duration)}`,
    [currentTime, duration],
  );

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      waveColor: '#4c1d95',
      progressColor: '#8b5cf6',
      cursorColor: '#c4b5fd',
      height: 72,
      normalize: true,
      barWidth: 3,
      barGap: 2,
      barRadius: 9999,
      dragToSeek: true,
    });

    wavesurferRef.current = wavesurfer;
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsReady(false);

    wavesurfer.on('ready', () => {
      setDuration(wavesurfer.getDuration());
      setIsReady(true);
    });

    wavesurfer.on('timeupdate', (time) => {
      setCurrentTime(time);
    });

    wavesurfer.on('play', () => {
      setIsPlaying(true);
    });

    wavesurfer.on('pause', () => {
      setIsPlaying(false);
    });

    wavesurfer.on('finish', () => {
      setIsPlaying(false);
      setCurrentTime(wavesurfer.getDuration());
    });

    return () => {
      wavesurfer.destroy();
      wavesurferRef.current = null;
    };
  }, [audioUrl]);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 flex items-center justify-between gap-3 md:mb-3 md:gap-4">
        <div className="min-w-0 flex-1">
          {label ? <p className="truncate text-sm font-medium text-white">{label}</p> : null}
          <p className="text-xs text-gray-400">Waveform preview · 클릭해서 탐색 / Click to seek</p>
        </div>
        <button
          type="button"
          disabled={!isReady}
          onClick={() => void wavesurferRef.current?.playPause()}
          className="touch-control shrink-0 rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-900"
        >
          {isPlaying ? '일시정지' : '재생'}
        </button>
      </div>

      <div ref={containerRef} className="w-full overflow-hidden rounded-lg bg-gray-950 md:rounded-xl" />

      <div className="mt-2 flex items-center justify-between text-xs text-gray-400 md:mt-3">
        <span>{timeDisplay}</span>
        <span>{isReady ? '준비 완료 / Ready' : '파형 생성 중 / Loading waveform'}</span>
      </div>
    </div>
  );
}
