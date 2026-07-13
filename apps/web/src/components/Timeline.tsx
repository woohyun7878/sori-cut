import { Fragment, useMemo, useState } from 'react';
import { calculateProjectDuration, type TimelineTrack, type TrackType, useProjectStore } from '../store/useProjectStore';

const trackColors: Record<TrackType, string> = {
  audio: 'from-purple-500/90 to-fuchsia-400/90',
  video: 'from-blue-500/90 to-cyan-400/90',
  stem: 'from-green-500/90 to-emerald-400/90',
  recording: 'from-orange-500/90 to-amber-400/90',
};

const trackIcons: Record<TrackType, string> = {
  audio: '🎵',
  video: '🎬',
  stem: '🌿',
  recording: '🎙️',
};

function formatSeconds(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = Math.floor(safeSeconds % 60);

  return minutes > 0 ? `${minutes}:${String(remaining).padStart(2, '0')}` : `${remaining}s`;
}

function getMarkerStep(zoom: number) {
  if (zoom <= 40) {
    return 5;
  }

  if (zoom <= 80) {
    return 2;
  }

  return 1;
}

function TrackInspector({ track }: { track: TimelineTrack }) {
  const toggleTrackMute = useProjectStore((state) => state.toggleTrackMute);
  const setTrackVolume = useProjectStore((state) => state.setTrackVolume);
  const updateTrack = useProjectStore((state) => state.updateTrack);

  return (
    <div className="mt-3 space-y-2">
      <button
        className={[
          'w-full rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
          track.muted
            ? 'border-red-400/50 bg-red-500/20 text-red-200'
            : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-brand-400/60',
        ].join(' ')}
        type="button"
        onClick={() => toggleTrackMute(track.id)}
      >
        {track.muted ? '음소거 해제 / Unmute' : '음소거 / Mute'}
      </button>

      <label className="block text-xs text-gray-400">
        볼륨 / Volume
        <input
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-gray-800 accent-brand-500"
          max={1}
          min={0}
          step={0.01}
          type="range"
          value={track.volume}
          onChange={(event) => setTrackVolume(track.id, Number(event.target.value))}
        />
      </label>

      <label className="block text-xs text-gray-400">
        시작 위치 / Start offset
        <input
          className="mt-1 w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white outline-none transition focus:border-brand-500"
          min={0}
          step={0.01}
          type="number"
          value={track.startOffset}
          onChange={(event) => updateTrack(track.id, { startOffset: Number(event.target.value) })}
        />
      </label>
    </div>
  );
}

export function Timeline() {
  const tracks = useProjectStore((state) => state.tracks);
  const video = useProjectStore((state) => state.video);
  const playheadPosition = useProjectStore((state) => state.playheadPosition);
  const isPlaying = useProjectStore((state) => state.isPlaying);
  const addTrack = useProjectStore((state) => state.addTrack);
  const setPlayheadPosition = useProjectStore((state) => state.setPlayheadPosition);
  const updateTrackOffset = useProjectStore((state) => state.updateTrackOffset);
  const [zoom, setZoom] = useState(64);
  const [newTrackType, setNewTrackType] = useState<TrackType>('audio');
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);

  const totalDuration = useMemo(() => Math.max(calculateProjectDuration(tracks, video), 10), [tracks, video]);
  const timelineWidth = Math.max(totalDuration * zoom, 720);
  const markerStep = getMarkerStep(zoom);
  const markers = Array.from({ length: Math.ceil(totalDuration / markerStep) + 1 }, (_, index) => index * markerStep);

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">타임라인 / Timeline</h2>
          <p className="mt-2 text-sm text-gray-400">클립 위치를 조정하고 플레이헤드를 이동하세요 / Position clips and adjust timing.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-xl border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-300">
            총 길이 / Total <span className="text-brand-300">{formatSeconds(totalDuration)}</span>
          </div>
          <div className="flex items-center rounded-xl border border-gray-800 bg-gray-950 p-1">
            <button
              className="rounded-lg px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-900"
              type="button"
              onClick={() => setZoom((value) => Math.max(24, value - 16))}
            >
              -
            </button>
            <span className="min-w-20 text-center text-xs text-gray-400">Zoom {zoom}px/s</span>
            <button
              className="rounded-lg px-3 py-2 text-sm text-gray-200 transition-colors hover:bg-gray-900"
              type="button"
              onClick={() => setZoom((value) => Math.min(160, value + 16))}
            >
              +
            </button>
          </div>
          <select
            className="rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition focus:border-brand-500"
            value={newTrackType}
            onChange={(event) => setNewTrackType(event.target.value as TrackType)}
          >
            <option value="audio">Audio</option>
            <option value="stem">Stem</option>
            <option value="recording">Recording</option>
          </select>
          <button
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            type="button"
            onClick={() => addTrack({ type: newTrackType })}
          >
            트랙 추가 / Add Track
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-3xl border border-gray-800 bg-gray-950/70">
        <div className="grid min-w-max grid-cols-[230px_minmax(720px,1fr)]">
          <div className="sticky left-0 z-30 border-b border-r border-gray-800 bg-gray-950 px-4 py-3 text-xs uppercase tracking-[0.24em] text-gray-500">
            Tracks
          </div>
          <div className="relative border-b border-gray-800 bg-gray-900/70">
            <div className="relative h-14" style={{ width: timelineWidth }}>
              {markers.map((marker) => (
                <div key={marker} className="absolute inset-y-0" style={{ left: marker * zoom }}>
                  <div className="h-full w-px bg-gray-800" />
                  <span className="absolute left-2 top-2 text-xs text-gray-500">{formatSeconds(marker)}</span>
                </div>
              ))}
              <button
                className="absolute inset-y-0 z-20 w-px bg-brand-400 shadow-[0_0_0_1px_rgba(167,139,250,0.2)]"
                style={{ left: playheadPosition * zoom }}
                type="button"
                onClick={(event) => event.stopPropagation()}
              />
              <button
                className="absolute inset-0"
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const nextPosition = ((event.clientX - rect.left) / rect.width) * totalDuration;
                  setPlayheadPosition(nextPosition);
                }}
              />
            </div>
          </div>

          {tracks.map((track) => (
            <Fragment key={track.id}>
              <div className="sticky left-0 z-20 border-b border-r border-gray-800 bg-gray-950 px-4 py-4">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{trackIcons[track.type]}</span>
                  <div>
                    <p className="text-sm font-semibold text-white">{track.name}</p>
                    <p className="text-xs text-gray-500">
                      {track.type.toUpperCase()} · {formatSeconds(track.duration)}
                    </p>
                  </div>
                </div>
                <TrackInspector track={track} />
              </div>

              <div className="relative border-b border-gray-800 bg-gray-950/40">
                <div
                  className="relative h-28"
                  style={{ width: timelineWidth }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const nextPosition = ((event.clientX - rect.left) / rect.width) * totalDuration;
                    setPlayheadPosition(nextPosition);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggingTrackId) {
                      return;
                    }

                    const rect = event.currentTarget.getBoundingClientRect();
                    const nextOffset = ((event.clientX - rect.left) / rect.width) * totalDuration;
                    updateTrackOffset(draggingTrackId, nextOffset);
                    setDraggingTrackId(null);
                  }}
                >
                  {markers.map((marker) => (
                    <div key={`${track.id}-${marker}`} className="absolute inset-y-0" style={{ left: marker * zoom }}>
                      <div className="h-full w-px bg-gray-900" />
                    </div>
                  ))}

                  <div
                    className={`absolute top-1/2 flex h-16 -translate-y-1/2 cursor-grab items-center justify-between overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-r px-4 text-sm text-white shadow-lg ${trackColors[track.type]}`}
                    draggable
                    style={{
                      left: track.startOffset * zoom,
                      width: Math.max(track.duration * zoom, 120),
                      opacity: track.muted ? 0.45 : 1,
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onDragEnd={() => setDraggingTrackId(null)}
                    onDragStart={() => setDraggingTrackId(track.id)}
                  >
                    <div>
                      <p className="font-medium">{track.name}</p>
                      <p className="text-xs text-white/75">{track.startOffset.toFixed(2)}s</p>
                    </div>
                    <span className="text-xs text-white/80">{track.duration.toFixed(2)}s</span>
                  </div>

                  <div
                    className="absolute inset-y-0 z-10 w-px bg-brand-400 shadow-[0_0_0_1px_rgba(167,139,250,0.2)]"
                    style={{ left: playheadPosition * zoom }}
                  />
                </div>
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
        <span>클릭해서 플레이헤드를 이동하고 드래그로 클립 위치를 바꾸세요.</span>
        <span>{isPlaying ? '재생 중 / Playing' : '정지 / Stopped'}</span>
      </div>
    </section>
  );
}
