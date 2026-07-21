import { useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_SYNC_MAX_LAG_SECONDS, computeAutoSyncOffset } from '../lib/autoSync';
import { createSyncTrackUpdate } from '../lib/syncAlignment';
import { useProjectStore } from '../store/useProjectStore';

/** Below this normalized confidence, the auto-sync offset is likely unreliable. */
const LOW_CONFIDENCE_THRESHOLD = 0.1;

function offsetToPercent(offset: number) {
  return 50 + (offset / AUTO_SYNC_MAX_LAG_SECONDS) * 38;
}

export function SyncControls() {
  const video = useProjectStore((state) => state.video);
  const tracks = useProjectStore((state) => state.tracks);
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const syncTracks = useMemo(() => tracks.filter((track) => track.type !== 'video'), [tracks]);
  const tracksRef = useRef(tracks);
  const videoRef = useRef(video);
  tracksRef.current = tracks;
  videoRef.current = video;
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const selectedTrackIdRef = useRef(selectedTrackId);
  selectedTrackIdRef.current = selectedTrackId;
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!syncTracks.length) {
      setSelectedTrackId('');
      return;
    }

    if (!selectedTrackId || !syncTracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(syncTracks[0].id);
    }
  }, [selectedTrackId, syncTracks]);

  const selectedTrack = syncTracks.find((track) => track.id === selectedTrackId) ?? null;

  useEffect(() => {
    if (selectedTrack) {
      setOffset(selectedTrack.syncOffset ?? selectedTrack.startOffset);
    }
  }, [selectedTrack]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const stopPreview = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  const handlePreview = async () => {
    stopPreview();

    if (!video) {
      setMessage('Upload a video first.');
      return;
    }

    if (!selectedTrack?.sourceUrl) {
      setMessage('The selected track has no audio source.');
      return;
    }

    const previewVideo = document.createElement('video');
    const previewAudio = new Audio(selectedTrack.sourceUrl);
    const timers: number[] = [];

    previewVideo.src = video.url;
    previewVideo.preload = 'auto';
    previewVideo.muted = true;
    previewVideo.playsInline = true;
    previewAudio.preload = 'auto';
    previewAudio.volume = selectedTrack.muted ? 0 : selectedTrack.volume;

    cleanupRef.current = () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      previewAudio.pause();
      previewVideo.pause();
      previewAudio.currentTime = 0;
      previewVideo.currentTime = 0;
    };

    try {
      setMessage('Preview playing...');
      const previewUpdate = createSyncTrackUpdate(selectedTrack, offset);
      previewAudio.currentTime = previewUpdate.sourceStartOffset;

      if (previewUpdate.startOffset > 0) {
        await previewVideo.play();
        timers.push(
          window.setTimeout(() => {
            void previewAudio.play().catch(() => {
              setMessage('Browser blocked autoplay.');
            });
          }, previewUpdate.startOffset * 1000),
        );
      } else {
        await Promise.all([previewVideo.play(), previewAudio.play()]);
      }
    } catch (caughtError) {
      setMessage(
        caughtError instanceof Error
          ? `Could not start preview: ${caughtError.message}`
          : 'An error occurred during preview playback.',
      );
    }
  };

  return (
    <section className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
      <div>
        <h2 className="text-2xl font-semibold text-white">Sync Controls</h2>
        <p className="mt-2 text-sm text-gray-400">Fine-tune audio-video timing offset.</p>
      </div>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-gray-300">
          Target track
          <select
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            value={selectedTrackId}
            onChange={(event) => setSelectedTrackId(event.target.value)}
          >
            {syncTracks.length ? (
              syncTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                </option>
              ))
            ) : (
              <option value="">No tracks available</option>
            )}
          </select>
        </label>

        {!syncTracks.length ? (
          <p className="rounded-2xl border border-gray-800 bg-gray-950/70 p-4 text-sm text-gray-400">
            No audio tracks yet. Add an audio, stem, or recording track to sync it against your
            video.
          </p>
        ) : null}

        <label className="block text-sm text-gray-300">
          Offset slider ({offset.toFixed(2)}s)
          <input
            className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-gray-800 accent-brand-500"
            max={AUTO_SYNC_MAX_LAG_SECONDS}
            min={-AUTO_SYNC_MAX_LAG_SECONDS}
            step={0.01}
            type="range"
            value={offset}
            onChange={(event) => setOffset(Number(event.target.value))}
          />
        </label>

        <label className="block text-sm text-gray-300">
          Precise offset
          <input
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            max={AUTO_SYNC_MAX_LAG_SECONDS}
            min={-AUTO_SYNC_MAX_LAG_SECONDS}
            step={0.01}
            type="number"
            value={offset}
            onChange={(event) => setOffset(Number(event.target.value))}
          />
        </label>

        <div className="rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
          <p className="mb-3 text-sm font-medium text-white">Visual alignment</p>
          <div className="relative h-20 overflow-hidden rounded-xl bg-gray-950" aria-hidden="true">
            <div className="absolute inset-y-0 left-1/2 w-px bg-gray-700" />
            <div className="absolute left-[20%] top-5 h-4 w-[55%] rounded-full bg-blue-500/80">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-white">
                Video
              </span>
            </div>
            <div
              className="absolute top-11 h-4 w-[55%] rounded-full bg-brand-500/80 transition-all"
              style={{ left: `${offsetToPercent(offset)}%`, transform: 'translateX(-50%)' }}
            >
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-white">
                Audio
              </span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <button
            className="rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={() => void handlePreview()}
          >
            Preview
          </button>
          <button
            className="rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60 disabled:opacity-50"
            disabled={isSyncing}
            type="button"
            onClick={async () => {
              if (!video) {
                setMessage('Upload a video first.');
                return;
              }

              if (!selectedTrack?.sourceUrl) {
                setMessage('The selected track has no audio source.');
                return;
              }

              const referenceUrl = video.url;
              if (!referenceUrl) {
                setMessage('No reference audio found.');
                return;
              }

              setIsSyncing(true);
              setMessage('Analyzing for auto sync...');

              try {
                const result = await computeAutoSyncOffset(referenceUrl, selectedTrack.sourceUrl);
                const currentTrack =
                  tracksRef.current.find((track) => track.id === selectedTrack.id) ?? null;
                if (
                  !currentTrack ||
                  currentTrack.sourceUrl !== selectedTrack.sourceUrl ||
                  videoRef.current?.url !== referenceUrl ||
                  selectedTrackIdRef.current !== selectedTrack.id
                ) {
                  throw new Error(
                    'The reference or target changed during auto-sync; run it again.',
                  );
                }
                const computedOffset = result.offsetSeconds;
                const confidencePercent = Math.round(result.confidence * 100);

                // Surface the suggested offset on the slider so the user can review/preview it.
                setOffset(computedOffset);

                if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
                  // Low confidence: don't silently apply a likely-inaccurate offset — warn instead.
                  setMessage(
                    `⚠️ Auto sync confidence is low (${confidencePercent}%). The suggested ${computedOffset.toFixed(2)}s offset may be inaccurate — preview and adjust it manually before applying.`,
                  );
                } else {
                  updateTrack(currentTrack.id, createSyncTrackUpdate(currentTrack, computedOffset));
                  setMessage(
                    `Auto sync done: ${computedOffset.toFixed(2)}s offset (${confidencePercent}% confidence)`,
                  );
                }
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? `Auto sync failed: ${error.message}`
                    : 'An error occurred during auto sync.',
                );
              } finally {
                setIsSyncing(false);
              }
            }}
          >
            {isSyncing ? 'Syncing...' : 'Auto Sync'}
          </button>
          <button
            className="rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            type="button"
            onClick={() => {
              if (!selectedTrack) {
                setMessage('No track selected.');
                return;
              }

              try {
                updateTrack(selectedTrack.id, createSyncTrackUpdate(selectedTrack, offset));
                setMessage('Offset applied to timeline.');
              } catch (error) {
                setMessage(
                  error instanceof Error ? error.message : 'Could not apply the sync offset.',
                );
              }
            }}
          >
            Apply Offset
          </button>
        </div>

        <div role="status" aria-live="polite">
          {message ? (
            <div className="rounded-2xl border border-brand-500/30 bg-brand-500/10 p-4 text-sm text-brand-100">
              {message}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
