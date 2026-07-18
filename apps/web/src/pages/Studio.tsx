import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { DropZone } from '../components/DropZone';
import { ProjectManager } from '../components/ProjectManager';
import { RecordingStudio } from '../components/RecordingStudio';
import { ShortcutHelpModal } from '../components/ShortcutHelpModal';
import { StemSplitter } from '../components/StemSplitter';
import { SyncControls } from '../components/SyncControls';
import { Timeline } from '../components/Timeline';
import { Toast } from '../components/Toast';
import { TransportBar } from '../components/TransportBar';
import { UndoRedoButtons } from '../components/UndoRedoButtons';
import { VideoUpload } from '../components/VideoUpload';
import { WaveformPlayer } from '../components/WaveformPlayer';
import { useAutoSave, type SaveStatus } from '../hooks/useAutoSave';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePlaybackEngine } from '../hooks/usePlaybackEngine';
import { useProjectStore } from '../store/useProjectStore';

export function Studio() {
  usePlaybackEngine();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  useAutoSave(setSaveStatus);
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useKeyboardShortcuts(openHelp);
  const originalAudio = useProjectStore((state) => state.originalAudio);

  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-6">
          <Link to="/studio" className="text-xl font-bold">
            <span className="text-brand-400">소리</span>컷
          </Link>
          <ProjectManager saveStatus={saveStatus} />
          <UndoRedoButtons />
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setHelpOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Keyboard shortcuts"
            title="Shortcuts"
          >
            ?
          </button>
          <Link
            to="/export"
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            Export
          </Link>
        </div>
      </nav>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-bold text-white">Creator Studio</h1>
            <p className="mt-2 text-gray-400">
              Upload, record, align, and prep your cover short in one workflow.
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
              <h2 className="text-2xl font-semibold text-white">Audio Prep</h2>
              <p className="text-gray-400">
                Upload your source audio to automatically connect it to the timeline and export.
              </p>
            </div>

            <DropZone />

            {originalAudio ? (
              <div className="mt-6">
                <WaveformPlayer audioUrl={originalAudio.url} label={`Source audio / ${originalAudio.name}`} />
              </div>
            ) : null}
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <RecordingStudio />
            <StemSplitter />
          </div>
        </div>
      </main>
      <Toast />
      <ShortcutHelpModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
