import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';

function offsetToPercent(offset: number) {
  return 50 + (offset / 5) * 38;
}

export function SyncControls() {
  const video = useProjectStore((state) => state.video);
  const tracks = useProjectStore((state) => state.tracks);
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const syncTracks = useMemo(() => tracks.filter((track) => track.type !== 'video'), [tracks]);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
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
      setOffset(selectedTrack.startOffset);
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
      setMessage('먼저 영상을 업로드하세요. / Upload a video first.');
      return;
    }

    if (!selectedTrack?.sourceUrl) {
      setMessage('선택한 트랙에 오디오 소스가 없습니다. / The selected track has no audio source.');
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
      setMessage('미리보기 재생 중... / Preview playing...');

      if (offset >= 0) {
        await previewVideo.play();
        timers.push(
          window.setTimeout(() => {
            void previewAudio.play().catch(() => {
              setMessage('브라우저가 오디오 자동재생을 차단했습니다. / Browser blocked autoplay.');
            });
          }, offset * 1000),
        );
      } else {
        await previewAudio.play();
        timers.push(
          window.setTimeout(() => {
            void previewVideo.play().catch(() => {
              setMessage('브라우저가 비디오 자동재생을 차단했습니다. / Browser blocked autoplay.');
            });
          }, Math.abs(offset) * 1000),
        );
      }
    } catch (caughtError) {
      setMessage(
        caughtError instanceof Error
          ? `미리보기를 시작하지 못했습니다. / ${caughtError.message}`
          : '미리보기 재생 중 오류가 발생했습니다.',
      );
    }
  };

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4 md:rounded-3xl md:p-6">
      <div>
        <h2 className="text-xl font-semibold text-white md:text-2xl">싱크 조정 / Sync Controls</h2>
        <p className="mt-1 text-sm text-gray-400 md:mt-2">오디오와 비디오의 오프셋을 세밀하게 맞춰보세요 / Fine tune audio-video timing.</p>
      </div>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-gray-300">
          트랙 선택 / Target track
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
              <option value="">트랙 없음 / No tracks available</option>
            )}
          </select>
        </label>

        <label className="block text-sm text-gray-300">
          오프셋 슬라이더 / Offset slider ({offset.toFixed(2)}s)
          <input
            className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-full bg-gray-800 accent-brand-500"
            max={5}
            min={-5}
            step={0.01}
            type="range"
            value={offset}
            onChange={(event) => setOffset(Number(event.target.value))}
          />
        </label>

        <label className="block text-sm text-gray-300">
          정밀 입력 / Precise offset
          <input
            className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-white outline-none transition focus:border-brand-500"
            max={5}
            min={-5}
            step={0.01}
            type="number"
            value={offset}
            onChange={(event) => setOffset(Number(event.target.value))}
          />
        </label>

        <div className="rounded-2xl border border-gray-800 bg-gray-950/70 p-4">
          <p className="mb-3 text-sm font-medium text-white">정렬 시각화 / Visual alignment</p>
          <div className="relative h-20 overflow-hidden rounded-xl bg-gray-950">
            <div className="absolute inset-y-0 left-1/2 w-px bg-gray-700" />
            <div className="absolute left-[20%] top-5 h-4 w-[55%] rounded-full bg-blue-500/80">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-white">Video</span>
            </div>
            <div
              className="absolute top-11 h-4 w-[55%] rounded-full bg-brand-500/80 transition-all"
              style={{ left: `${offsetToPercent(offset)}%`, transform: 'translateX(-50%)' }}
            >
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-white">Audio</span>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <button
            className="touch-control rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={() => void handlePreview()}
          >
            미리보기 / Preview
          </button>
          <button
            className="touch-control rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-brand-400/60"
            type="button"
            onClick={() => setMessage('자동 싱크는 곧 제공됩니다. / Auto sync coming soon.')}
          >
            자동 싱크 / Auto Sync
          </button>
          <button
            className="touch-control rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            type="button"
            onClick={() => {
              if (!selectedTrack) {
                setMessage('적용할 트랙이 없습니다. / No track selected.');
                return;
              }

              updateTrack(selectedTrack.id, { startOffset: Math.max(0, offset) });
              setMessage('오프셋을 타임라인에 적용했습니다. / Offset applied to timeline.');
            }}
          >
            오프셋 적용 / Apply Offset
          </button>
        </div>

        {message ? (
          <div className="rounded-2xl border border-brand-500/30 bg-brand-500/10 p-4 text-sm text-brand-100">
            {message}
          </div>
        ) : null}
      </div>
    </section>
  );
}
