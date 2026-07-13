import { Link } from 'react-router-dom';
import { DropZone } from '../components/DropZone';
import { RecordingStudio } from '../components/RecordingStudio';
import { StemSplitter } from '../components/StemSplitter';
import { SyncControls } from '../components/SyncControls';
import { Timeline } from '../components/Timeline';
import { TransportBar } from '../components/TransportBar';
import { VideoUpload } from '../components/VideoUpload';
import { WaveformPlayer } from '../components/WaveformPlayer';
import { usePlaybackEngine } from '../hooks/usePlaybackEngine';
import { useProjectStore } from '../store/useProjectStore';

export function Studio() {
  usePlaybackEngine();
  const originalAudio = useProjectStore((state) => state.originalAudio);

  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <Link to="/" className="text-xl font-bold">
          <span className="text-brand-400">소리</span>컷
        </Link>
        <div className="flex gap-4">
          <Link
            to="/export"
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            내보내기 Export
          </Link>
        </div>
      </nav>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-bold text-white">커버 크리에이터 스튜디오 / Creator Studio</h1>
            <p className="mt-2 text-gray-400">
              비디오 업로드, 스템 분리, 보컬 녹음, 싱크 조정, 타임라인 편집을 한 화면에서 빠르게 진행하세요.
              <span className="block text-gray-500">Upload, record, align, and prep your Korean cover short in one workflow.</span>
            </p>
          </div>

          <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
            <div className="space-y-6">
              <VideoUpload />
              <SyncControls />
            </div>

            <div className="space-y-6">
              <TransportBar />
              <Timeline />
            </div>
          </div>

          <section className="rounded-3xl border border-gray-800 bg-gray-950/70 p-6">
            <div className="mb-6 flex flex-col gap-2">
              <h2 className="text-2xl font-semibold text-white">오디오 준비 / Audio prep</h2>
              <p className="text-gray-400">
                원곡 오디오를 업로드하면 타임라인과 내보내기에 자동으로 연결됩니다.
              </p>
            </div>

            <DropZone />

            {originalAudio ? (
              <div className="mt-6">
                <WaveformPlayer audioUrl={originalAudio.url} label={`원본 오디오 / ${originalAudio.name}`} />
              </div>
            ) : null}
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <RecordingStudio />
            <StemSplitter />
          </div>
        </div>
      </main>
    </div>
  );
}
