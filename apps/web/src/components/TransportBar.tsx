import { useMemo } from 'react';
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

  const progressPercent = totalDuration > 0 ? (playheadPosition / totalDuration) * 100 : 0;

  const seekBy = (delta: number) => {
    setPlayheadPosition(playheadPosition + delta);
  };

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">Transport</h2>
          <p className="mt-2 text-sm text-gray-400">Control playback and seeking.</p>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-gray-800 bg-gray-950/70 p-2">
          <button
            className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={() => seekBy(-5)}
          >
            -5s
          </button>
          <button
            className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={stopPlayback}
          >
            Stop
          </button>
          <button
            className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-600 text-lg font-semibold text-white shadow-lg shadow-brand-900/50 transition-colors hover:bg-brand-700"
            type="button"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button
            className="rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={() => seekBy(5)}
          >
            +5s
          </button>
          <button
            className={[
              'rounded-xl border px-4 py-3 text-sm font-semibold transition-colors',
              loopEnabled
                ? 'border-brand-400/60 bg-brand-500/20 text-brand-100'
                : 'border-gray-700 bg-gray-900 text-gray-200 hover:border-brand-400/60',
            ].join(' ')}
            type="button"
            onClick={() => setLoopEnabled(!loopEnabled)}
          >
            Loop
          </button>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="font-mono text-brand-300">{formatTime(playheadPosition)}</span>
          <span className="font-mono text-gray-500">{formatTime(totalDuration)}</span>
        </div>

        <button
          className="relative block h-4 w-full overflow-hidden rounded-full border border-gray-800 bg-gray-950"
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
