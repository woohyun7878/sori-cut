import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { DropZone } from '../components/DropZone';
import { ProjectManager } from '../components/ProjectManager';
import { RecordingStudio } from '../components/RecordingStudio';
import { ShortcutHelpModal } from '../components/ShortcutHelpModal';
import { StemSplitter } from '../components/StemSplitter';
import { StudioDialog } from '../components/StudioDialog';
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

type DialogPanel = 'audio' | 'recording' | 'stems' | null;

const toolbarButtons: { id: DialogPanel & string; icon: string; label: string }[] = [
  { id: 'audio', icon: '🎵', label: 'Audio Prep' },
  { id: 'recording', icon: '🎙️', label: 'Record' },
  { id: 'stems', icon: '🎛️', label: 'Stems' },
];

export function Studio() {
  usePlaybackEngine();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  useAutoSave(setSaveStatus);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeDialog, setActiveDialog] = useState<DialogPanel>(null);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useKeyboardShortcuts(openHelp);
  const originalAudio = useProjectStore((state) => state.originalAudio);
  const stems = useProjectStore((state) => state.stems);
  const recordings = useProjectStore((state) => state.recordings);

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-white overflow-hidden">
      {/* Top nav */}
      <nav className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-gray-800 lg:px-6">
        <div className="flex items-center gap-4 lg:gap-6">
          <Link to="/" className="text-xl font-bold">
            <span className="text-brand-400">소리</span>컷
          </Link>
          <ProjectManager saveStatus={saveStatus} />
          <UndoRedoButtons />
        </div>
        <div className="flex items-center gap-2 lg:gap-3">
          {/* Toolbar buttons to open dialog panels */}
          {toolbarButtons.map((btn) => {
            const isActive = activeDialog === btn.id;
            let badge: number | null = null;
            if (btn.id === 'audio' && originalAudio) badge = 1;
            if (btn.id === 'stems' && stems.length > 0) badge = stems.length;
            if (btn.id === 'recording' && recordings.length > 0) badge = recordings.length;

            return (
              <button
                key={btn.id}
                onClick={() => setActiveDialog(isActive ? null : btn.id)}
                className={[
                  'relative flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-600/20 text-brand-300 border border-brand-500/40'
                    : 'border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white',
                ].join(' ')}
                title={btn.label}
              >
                <span className="text-base">{btn.icon}</span>
                <span className="hidden sm:inline">{btn.label}</span>
                {badge !== null && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}

          <div className="mx-1 h-6 w-px bg-gray-800" />

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

      {/* Main content — single screen, no scroll */}
      <main className="flex-1 overflow-hidden px-4 py-4 lg:px-6 lg:py-5">
        <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-4">
          <div className="grid flex-1 gap-4 overflow-hidden xl:grid-cols-[360px_minmax(0,1fr)]">
            {/* Left column */}
            <div className="flex flex-col gap-4 overflow-y-auto">
              <VideoUpload />
              <SyncControls />
            </div>

            {/* Right column */}
            <div className="flex flex-col gap-4 overflow-hidden">
              <TransportBar />
              <div className="flex-1 overflow-hidden">
                <Timeline />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Dialog panels */}
      <StudioDialog
        isOpen={activeDialog === 'audio'}
        onClose={() => setActiveDialog(null)}
        title="Audio Prep"
        icon="🎵"
      >
        <p className="mb-6 text-gray-400">
          Upload your source audio to automatically connect it to the timeline and export.
        </p>
        <DropZone />
        {originalAudio ? (
          <div className="mt-6">
            <WaveformPlayer audioUrl={originalAudio.url} label={`Source audio / ${originalAudio.name}`} />
          </div>
        ) : null}
      </StudioDialog>

      <StudioDialog
        isOpen={activeDialog === 'recording'}
        onClose={() => setActiveDialog(null)}
        title="Recording Studio"
        icon="🎙️"
      >
        <RecordingStudio />
      </StudioDialog>

      <StudioDialog
        isOpen={activeDialog === 'stems'}
        onClose={() => setActiveDialog(null)}
        title="Stem Splitter"
        icon="🎛️"
      >
        <StemSplitter />
      </StudioDialog>

      <Toast />
      <ShortcutHelpModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
