import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateProjectDuration,
  type TimelineTrack,
  type TrackType,
  useProjectStore,
} from '../store/useProjectStore';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { ClipWaveform } from './ClipWaveform';
import {
  formatTimelineTime,
  getMarkerStep,
  getTrackPalette,
  snapTimelineTime,
} from './timelineHelpers';

function TrackInspector({ track }: { track: TimelineTrack }) {
  const toggleTrackMute = useProjectStore((state) => state.toggleTrackMute);
  const stems = useProjectStore((state) => state.stems);
  const toggleStemSolo = useProjectStore((state) => state.toggleStemSolo);
  const setTrackVolume = useProjectStore((state) => state.setTrackVolume);
  const stemId = track.type === 'stem' && track.id.startsWith('stem-') ? track.id.slice(5) : null;
  const stem = stemId ? stems.find((item) => item.id === stemId) : null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        className={track.muted ? 'timeline-track-toggle is-active' : 'timeline-track-toggle'}
        type="button"
        title={
          track.type === 'video'
            ? track.muted
              ? 'Show video track'
              : 'Hide video track'
            : track.muted
              ? 'Unmute track'
              : 'Mute track'
        }
        aria-label={
          track.type === 'video'
            ? track.muted
              ? `Show ${track.name}`
              : `Hide ${track.name}`
            : track.muted
              ? `Unmute ${track.name}`
              : `Mute ${track.name}`
        }
        aria-pressed={track.muted}
        onClick={() => toggleTrackMute(track.id)}
      >
        {track.type === 'video' ? 'V' : 'M'}
      </button>
      {stem ? (
        <button
          className={stem.solo ? 'timeline-track-toggle is-solo' : 'timeline-track-toggle'}
          type="button"
          title={stem.solo ? 'Disable solo' : 'Solo stem'}
          aria-label={`${stem.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
          aria-pressed={stem.solo}
          onClick={() => toggleStemSolo(stem.id)}
        >
          S
        </button>
      ) : null}
      {track.type !== 'video' ? (
        <label className="timeline-volume" title={`${Math.round(track.volume * 100)}% volume`}>
          <span className="sr-only">{track.name} volume</span>
          <input
            aria-label={`${track.name} volume`}
            max={1}
            min={0}
            step={0.01}
            type="range"
            value={track.volume}
            onChange={(event) => setTrackVolume(track.id, Number(event.target.value))}
          />
        </label>
      ) : null}
    </div>
  );
}

interface TrimDragState {
  trackId: string;
  edge: 'left' | 'right';
  initialMouseX: number;
  initialOffset: number;
  initialDuration: number;
}

interface ContextMenuState {
  trackId: string;
  x: number;
  y: number;
}

function TimelineClip({
  track,
  zoom,
  isSelected,
  onSelect,
  onContextMenu,
  onTrimStart,
}: {
  track: TimelineTrack;
  zoom: number;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onTrimStart: (edge: 'left' | 'right', e: React.MouseEvent) => void;
}) {
  const clipWidth = Math.max(track.duration * zoom, 48);
  const clipHeight = 36;
  const palette = getTrackPalette(track);

  const clipLabel = [
    track.name,
    `${track.type} clip`,
    `starts at ${track.startOffset.toFixed(1)} seconds`,
    `${track.duration.toFixed(1)} seconds long`,
    track.muted ? 'muted' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      className={[
        'group absolute top-1/2 flex h-9 -translate-y-1/2 items-center justify-between overflow-hidden rounded-md border px-3 text-xs text-white transition-[border-color,box-shadow]',
        palette.clip,
        isSelected
          ? 'ring-2 ring-brand-400 ring-offset-1 ring-offset-gray-950 shadow-[0_0_12px_rgba(139,92,246,0.28)]'
          : 'hover:brightness-125',
      ].join(' ')}
      style={{
        left: track.startOffset * zoom,
        width: clipWidth,
        opacity: track.muted ? 0.45 : 1,
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={clipLabel}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
    >
      {/* Waveform visualization */}
      {track.sourceUrl && (
        <ClipWaveform
          sourceUrl={track.sourceUrl}
          sourceStartOffset={track.sourceStartOffset}
          duration={track.duration}
          width={clipWidth}
          height={clipHeight}
          color={palette.waveform}
        />
      )}

      {/* Left trim handle */}
      <div
        aria-hidden="true"
        className={[
          'absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize transition-colors',
          isSelected ? 'bg-white' : 'bg-white/20 group-hover:bg-white/70',
        ].join(' ')}
        onMouseDown={(e) => {
          e.stopPropagation();
          onTrimStart('left', e);
        }}
      />

      {/* Right trim handle */}
      <div
        aria-hidden="true"
        className={[
          'absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize transition-colors',
          isSelected ? 'bg-white' : 'bg-white/20 group-hover:bg-white/70',
        ].join(' ')}
        onMouseDown={(e) => {
          e.stopPropagation();
          onTrimStart('right', e);
        }}
      />

      <div className="pointer-events-none relative z-[5] min-w-0 flex-1 truncate">
        <p className="truncate font-semibold drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
          {track.name}
        </p>
      </div>
      <span className="pointer-events-none relative z-[5] ml-2 shrink-0 text-xs text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
        {formatTimelineTime(track.duration, true)}
      </span>
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
  const removeTrack = useProjectStore((state) => state.removeTrack);
  const selectedTrackId = useProjectStore((state) => state.selectedTrackId);
  const setSelectedTrack = useProjectStore((state) => state.setSelectedTrack);
  const splitTrackAtPosition = useProjectStore((state) => state.splitTrackAtPosition);
  const trimTrack = useProjectStore((state) => state.trimTrack);

  const [zoom, setZoom] = useState(64);
  const [newTrackType, setNewTrackType] = useState<TrackType>('audio');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(showDeleteConfirm !== null, deleteDialogRef, () => setShowDeleteConfirm(null));

  const totalDuration = useMemo(
    () => Math.max(calculateProjectDuration(tracks, video), 10),
    [tracks, video],
  );
  const timelineWidth = Math.max(totalDuration * zoom, 720);
  const markerStep = getMarkerStep(zoom);
  const markers = Array.from(
    { length: Math.ceil(totalDuration / markerStep) + 1 },
    (_, index) => index * markerStep,
  );

  // Handle trim drag
  const handleTrimMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!trimDrag) return;

      const deltaX = e.clientX - trimDrag.initialMouseX;
      const deltaTime = deltaX / zoom;

      if (trimDrag.edge === 'left') {
        const newOffset = snapTimelineTime(trimDrag.initialOffset + deltaTime, snapEnabled);
        const initialEnd = trimDrag.initialOffset + trimDrag.initialDuration;
        const newDuration = initialEnd - newOffset;
        if (newDuration >= 0.5) {
          trimTrack(trimDrag.trackId, newOffset, newDuration);
        }
      } else {
        const initialEnd = trimDrag.initialOffset + trimDrag.initialDuration;
        const newEnd = snapTimelineTime(initialEnd + deltaTime, snapEnabled);
        const newDuration = Math.max(0.5, newEnd - trimDrag.initialOffset);
        trimTrack(trimDrag.trackId, trimDrag.initialOffset, newDuration);
      }
    },
    [snapEnabled, trimDrag, zoom, trimTrack],
  );

  const handleTrimMouseUp = useCallback(() => {
    setTrimDrag(null);
  }, []);

  useEffect(() => {
    if (trimDrag) {
      window.addEventListener('mousemove', handleTrimMouseMove);
      window.addEventListener('mouseup', handleTrimMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleTrimMouseMove);
        window.removeEventListener('mouseup', handleTrimMouseUp);
      };
    }
  }, [trimDrag, handleTrimMouseMove, handleTrimMouseUp]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleSplitAtPlayhead = () => {
    if (!selectedTrackId) return;
    splitTrackAtPosition(selectedTrackId, playheadPosition);
  };

  const handleDeleteTrack = (trackId: string) => {
    setShowDeleteConfirm(trackId);
  };

  const confirmDelete = () => {
    if (showDeleteConfirm) {
      removeTrack(showDeleteConfirm);
      if (selectedTrackId === showDeleteConfirm) {
        setSelectedTrack(null);
      }
      setShowDeleteConfirm(null);
    }
  };

  return (
    <section className="timeline-editor">
      <div className="timeline-toolbar" aria-label="Timeline toolbar">
        <div className="flex min-w-0 items-center gap-1">
          <span
            className="timeline-timecode"
            aria-label={`Playhead ${formatTimelineTime(playheadPosition, true)}`}
          >
            {formatTimelineTime(playheadPosition, true)}
          </span>
          <span className="hidden text-[11px] text-muted sm:inline">
            / {formatTimelineTime(totalDuration, true)}
          </span>
          <span className="mx-1 h-4 w-px bg-editor-border" />
          <button
            className={snapEnabled ? 'timeline-tool-button is-active' : 'timeline-tool-button'}
            type="button"
            title="Magnetic snap indicator"
            aria-pressed={snapEnabled}
            onClick={() => setSnapEnabled((value) => !value)}
          >
            <span aria-hidden="true">⌁</span> Snap
          </button>
          <button
            className="timeline-tool-button"
            disabled={!selectedTrackId}
            title="Split selected clip at playhead"
            type="button"
            onClick={handleSplitAtPlayhead}
          >
            <span aria-hidden="true">✂</span> Split
          </button>
        </div>
        <div className="flex items-center gap-1">
          <select
            aria-label="New track type"
            className="timeline-track-select"
            value={newTrackType}
            onChange={(event) => setNewTrackType(event.target.value as TrackType)}
          >
            <option value="audio">Audio</option>
            <option value="stem">Stem</option>
            <option value="recording">Recording</option>
          </select>
          <button
            className="timeline-tool-button"
            type="button"
            onClick={() => addTrack({ type: newTrackType })}
          >
            + Track
          </button>
          <span className="mx-1 h-4 w-px bg-editor-border" />
          <div className="flex items-center" aria-label={`Timeline zoom ${zoom} pixels per second`}>
            <button
              className="timeline-zoom-button"
              aria-label="Zoom out"
              type="button"
              onClick={() => setZoom((value) => Math.max(24, value - 16))}
            >
              −
            </button>
            <span className="min-w-10 text-center text-[10px] tabular-nums text-muted">
              {Math.round((zoom / 64) * 100)}%
            </span>
            <button
              className="timeline-zoom-button"
              aria-label="Zoom in"
              type="button"
              onClick={() => setZoom((value) => Math.min(160, value + 16))}
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div ref={containerRef} className="timeline-scroll">
        <div
          className="timeline-grid"
          role="group"
          aria-label={`Timeline with ${tracks.length} track${tracks.length === 1 ? '' : 's'}`}
        >
          <div className="timeline-track-corner">
            <span>Tracks</span>
            <span>{tracks.length}</span>
          </div>
          <div className="relative border-b border-editor-border bg-surface">
            <div className="relative h-7" style={{ width: timelineWidth }}>
              {markers.map((marker) => (
                <div key={marker} className="absolute inset-y-0" style={{ left: marker * zoom }}>
                  <div className="h-full w-px bg-editor-border" />
                  <span className="absolute left-1.5 top-1 text-[10px] tabular-nums text-muted">
                    {formatTimelineTime(marker)}
                  </span>
                </div>
              ))}
              <button
                className="timeline-playhead ruler"
                style={{ left: playheadPosition * zoom }}
                type="button"
                aria-label={`Playhead at ${formatTimelineTime(playheadPosition, true)}`}
                onClick={(event) => event.stopPropagation()}
              />
              <button
                className="absolute inset-0 cursor-col-resize"
                type="button"
                aria-label="Move playhead"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const nextPosition = ((event.clientX - rect.left) / rect.width) * totalDuration;
                  setPlayheadPosition(snapTimelineTime(nextPosition, snapEnabled));
                }}
              />
            </div>
          </div>

          {tracks.map((track) => (
            <Fragment key={track.id}>
              <div
                className="timeline-track-header"
                role="group"
                aria-label={`${track.name} track controls`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={`h-7 w-1 shrink-0 rounded-full ${getTrackPalette(track).accent}`}
                    aria-hidden="true"
                  />
                  <span className="timeline-type-badge">
                    {track.type === 'recording' ? 'REC' : track.type.slice(0, 3).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-primary" title={track.name}>
                      {track.name}
                    </p>
                    <p className="text-[10px] tabular-nums text-muted">
                      {formatTimelineTime(track.duration, true)}
                    </p>
                  </div>
                </div>
                <TrackInspector track={track} />
              </div>

              <div
                className="relative border-b border-editor-border bg-canvas/70"
                role="group"
                aria-label={`${track.name} timeline lane`}
              >
                <div
                  className="relative h-12"
                  style={{ width: timelineWidth }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const nextPosition = ((event.clientX - rect.left) / rect.width) * totalDuration;
                    setPlayheadPosition(snapTimelineTime(nextPosition, snapEnabled));
                    setSelectedTrack(null);
                  }}
                >
                  {markers.map((marker) => (
                    <div
                      key={`${track.id}-${marker}`}
                      className="absolute inset-y-0"
                      style={{ left: marker * zoom }}
                    >
                      <div className="h-full w-px bg-editor-border/40" />
                    </div>
                  ))}

                  <TimelineClip
                    isSelected={selectedTrackId === track.id}
                    track={track}
                    zoom={zoom}
                    onContextMenu={(e) => {
                      setContextMenu({ trackId: track.id, x: e.clientX, y: e.clientY });
                    }}
                    onSelect={() => setSelectedTrack(track.id)}
                    onTrimStart={(edge, e) => {
                      setTrimDrag({
                        trackId: track.id,
                        edge,
                        initialMouseX: e.clientX,
                        initialOffset: track.startOffset,
                        initialDuration: track.duration,
                      });
                    }}
                  />

                  <div className="timeline-playhead" style={{ left: playheadPosition * zoom }} />
                </div>
              </div>
            </Fragment>
          ))}

          {tracks.length === 0 && (
            <div className="col-span-2 flex min-h-32 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm font-semibold text-gray-300">No tracks yet</p>
              <p className="max-w-sm text-xs text-gray-500">
                Import media from the Assets panel or add a track above to start arranging your
                edit.
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="timeline-footer">
        <span>
          {snapEnabled ? 'Snap active' : 'Free positioning'} · Select a clip for trim and split
          controls
        </span>
        <span className={isPlaying ? 'text-success' : ''}>{isPlaying ? 'Playing' : 'Ready'}</span>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-control border border-editor-border bg-surface-raised py-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label="Clip actions"
        >
          <button
            className="h-8 w-full px-3 text-left text-sm text-secondary hover:bg-hover hover:text-primary"
            type="button"
            role="menuitem"
            onClick={() => {
              splitTrackAtPosition(contextMenu.trackId, playheadPosition);
              setContextMenu(null);
            }}
          >
            Split at playhead
          </button>
          <button
            className="h-8 w-full px-3 text-left text-sm text-red-300 hover:bg-hover hover:text-red-200"
            type="button"
            role="menuitem"
            onClick={() => {
              handleDeleteTrack(contextMenu.trackId);
              setContextMenu(null);
            }}
          >
            Delete clip
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(null)}
        >
          <div
            ref={deleteDialogRef}
            className="w-full max-w-sm rounded-editor border border-editor-border bg-surface-raised p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-clip-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <p id="delete-clip-title" className="mb-4 text-sm font-medium text-primary">
              Delete this clip?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="h-8 rounded-control bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                type="button"
                onClick={confirmDelete}
              >
                Delete
              </button>
              <button
                className="h-8 rounded-control border border-editor-border px-3 text-sm text-secondary transition-colors hover:bg-hover hover:text-primary"
                type="button"
                onClick={() => setShowDeleteConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
