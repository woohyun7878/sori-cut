import { useMemo, useState } from 'react';
import { separateStems } from '../lib/stemSeparation';
import { useProjectStore, type Stem } from '../store/useProjectStore';
import { WaveformPlayer } from './WaveformPlayer';

function titleFromStemName(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function StemSplitter() {
  const originalAudio = useProjectStore((state) => state.originalAudio);
  const stems = useProjectStore((state) => state.stems);
  const setStems = useProjectStore((state) => state.setStems);
  const toggleStemMute = useProjectStore((state) => state.toggleStemMute);
  const toggleStemSolo = useProjectStore((state) => state.toggleStemSolo);
  const setStemVolume = useProjectStore((state) => state.setStemVolume);
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const splitHint = useMemo(() => {
    if (!originalAudio) {
      return '원본 오디오를 먼저 업로드하세요 / Upload an original audio file first.';
    }

    if (stems.length > 0) {
      return '스플릿이 완료되었습니다 / Stems are ready to mix.';
    }

    return 'Web Audio API 기반의 주파수 필터로 빠르게 스템을 추출합니다.';
  }, [originalAudio, stems.length]);

  const handleSplit = async () => {
    if (!originalAudio || isProcessing) {
      return;
    }

    setError(null);
    setIsProcessing(true);
    setProgress(0);

    const audioContext = new AudioContext();

    try {
      const arrayBuffer = await originalAudio.blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const stemResults = await separateStems(audioBuffer, setProgress);

      const projectStems: Stem[] = stemResults.map((stem) => ({
        id: crypto.randomUUID(),
        name: stem.name,
        label: stem.label,
        blob: stem.blob,
        url: stem.url,
        muted: false,
        volume: 1,
        solo: false,
      }));

      setStems(projectStems);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : '스템 분리에 실패했습니다 / Failed to split stems.',
      );
    } finally {
      setIsProcessing(false);
      await audioContext.close();
    }
  };

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900 p-4 md:rounded-3xl md:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white md:text-2xl">스템 분리 / Stem Splitter</h2>
          <p className="mt-2 text-sm text-gray-400">{splitHint}</p>
        </div>

        <button
          type="button"
          onClick={() => void handleSplit()}
          disabled={!originalAudio || isProcessing}
          className="touch-control rounded-xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand-900"
        >
          {isProcessing ? '분리 중... / Splitting...' : '스템 분리 시작 / Split Stems'}
        </button>
      </div>

      {isProcessing ? (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span>오프라인 렌더링 진행 중 / Offline rendering in progress</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {stems.length > 0 ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {stems.map((stem) => (
            <article key={stem.id} className="rounded-2xl border border-gray-800 bg-gray-950/60 p-4">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-white">{stem.label}</h3>
                  <p className="text-xs uppercase tracking-[0.2em] text-brand-400">{titleFromStemName(stem.name)}</p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleStemMute(stem.id)}
                    className={[
                      'touch-control rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                      stem.muted
                        ? 'border-red-400/50 bg-red-500/20 text-red-200'
                        : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-red-400/50',
                    ].join(' ')}
                  >
                    음소거 / Mute
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleStemSolo(stem.id)}
                    className={[
                      'touch-control rounded-lg border px-3 py-2 text-xs font-semibold transition-colors',
                      stem.solo
                        ? 'border-brand-400/50 bg-brand-500/20 text-brand-100'
                        : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-brand-400/50',
                    ].join(' ')}
                  >
                    솔로 / Solo
                  </button>
                </div>
              </div>

              <WaveformPlayer audioUrl={stem.url} label={`${stem.label} · ${titleFromStemName(stem.name)}`} />

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
                  <span>볼륨 / Volume</span>
                  <span>{Math.round(stem.volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(stem.volume * 100)}
                  onChange={(event) => setStemVolume(stem.id, Number(event.target.value) / 100)}
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-gray-800 accent-brand-500"
                />
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
