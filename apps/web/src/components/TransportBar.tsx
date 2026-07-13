import { useEffect, useMemo, useRef } from 'react';
import { calculateProjectDuration, useProjectStore } from '../store/useProjectStore';

function formatTime(time: number) {
  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  const minutes = Math.floor(safeTime / 60);
  const seconds = Math.floor(safeTime % 60);
  const centiseconds = Math.floor((safeTime % 1) * 100);

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

export function TransportBar() {
  const tracks = useProjectStore((state) => state.tracks);
  const video = useProjectStore((state) => state.video);
  const playheadPosition = useProjectStore((state) => state.playheadPosition);
  const isPlaying = useProjectStore((state) => state.isPlaying);
  const loopEnabled = useProjectStore((state) => state.loopEnabled);
  const setPlayheadPosition = useProjectStore((state) => state.setPlayheadPosition);
  const setIsPlaying = useProjectStore((state) => state.setIsPlaying);
  const setLoopEnabled = useProjectStore((state) => state.setLoopEnabled);
  const stopPlayback = useProjectStore((state) => state.stopPlayback);

  const totalDuration = useMemo(() => calculateProjectDuration(tracks, video), [tracks, video]);
  const frameRef = useRef<number | null>(null);
  const playheadRef = useRef(playheadPosition);
  const durationRef = useRef(totalDuration);
  const loopRef = useRef(loopEnabled);

  useEffect(() => {
    playheadRef.current = playheadPosition;
  }, [playheadPosition]);

  useEffect(() => {
    durationRef.current = totalDuration;
  }, [totalDuration]);

  useEffect(() => {
    loopRef.current = loopEnabled;
  }, [loopEnabled]);

  useEffect(() => {
    if (!isPlaying) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      return undefined;
    }

    let previousTime = performance.now();

    const tick = (timestamp: number) => {
      const deltaSeconds = (timestamp - previousTime) / 1000;
      previousTime = timestamp;
      const duration = durationRef.current;
      const nextPosition = playheadRef.current + deltaSeconds;

      if (duration <= 0) {
        setIsPlaying(false);
        setPlayheadPosition(0);
        return;
      }

      if (nextPosition >= duration) {
        if (loopRef.current) {
          playheadRef.current = 0;
          setPlayheadPosition(0);
          frameRef.current = requestAnimationFrame(tick);
          return;
        }

        playheadRef.current = duration;
        setPlayheadPosition(duration);
        setIsPlaying(false);
        return;
      }

      playheadRef.current = nextPosition;
      setPlayheadPosition(nextPosition);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [isPlaying, setIsPlaying, setPlayheadPosition]);

  const progressPercent = totalDuration > 0 ? (playheadPosition / totalDuration) * 100 : 0;

  const seekBy = (delta: number) => {
    setPlayheadPosition(playheadPosition + delta);
  };

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4 md:rounded-3xl md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white md:text-2xl">재생 바 / Transport</h2>
          <p className="mt-1 text-sm text-gray-400 md:mt-2">재생, 시크, 루프를 한 번에 제어하세요 / Control playback and seeking.</p>
        </div>

        <div className="flex items-center gap-1.5 rounded-2xl border border-gray-800 bg-gray-950/70 p-1.5 md:gap-2 md:p-2">
          <button
            className="touch-control rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-xs font-semibold text-gray-200 transition-colors hover:border-brand-400/60 md:rounded-xl md:px-4 md:py-3 md:text-sm"
            type="button"
            onClick={() => seekBy(-5)}
          >
            -5s
          </button>
          <button
            className="touch-control rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-xs font-semibold text-gray-200 transition-colors hover:border-brand-400/60 md:rounded-xl md:px-4 md:py-3 md:text-sm"
            type="button"
            onClick={stopPlayback}
          >
            Stop
          </button>
          <button
            className="touch-control flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-base font-semibold text-white shadow-lg shadow-brand-900/50 transition-colors hover:bg-brand-700 md:h-16 md:w-16 md:text-lg"
            type="button"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button
            className="touch-control rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-xs font-semibold text-gray-200 transition-colors hover:border-brand-400/60 md:rounded-xl md:px-4 md:py-3 md:text-sm"
            type="button"
            onClick={() => seekBy(5)}
          >
            +5s
          </button>
          <button
            className={[
              'touch-control rounded-lg border px-3 py-2.5 text-xs font-semibold transition-colors md:rounded-xl md:px-4 md:py-3 md:text-sm',
              loopEnabled
                ? 'border-brand-400/60 bg-brand-500/20 text-brand-100'
                : 'border-gray-700 bg-gray-900 text-gray-200 hover:border-brand-400/60',
            ].join(' ')}
            type="button"
            onClick={() => setLoopEnabled(!loopEnabled)}
          >
            루프
          </button>
        </div>
      </div>

      <div className="mt-4 md:mt-6">
        <div className="mb-2 flex items-center justify-between text-xs md:mb-3 md:text-sm">
          <span className="font-mono text-brand-300">{formatTime(playheadPosition)}</span>
          <span className="font-mono text-gray-500">{formatTime(totalDuration)}</span>
        </div>

        <button
          className="touch-control relative block h-6 w-full overflow-hidden rounded-full border border-gray-800 bg-gray-950 md:h-4"
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const nextPosition = ((event.clientX - rect.left) / rect.width) * totalDuration;
            setPlayheadPosition(nextPosition);
          }}
        >
          <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-500 to-brand-400" style={{ width: `${progressPercent}%` }} />
        </button>
      </div>
    </section>
  );
}
