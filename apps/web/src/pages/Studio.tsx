import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useResizablePanels, type PanelSide } from '../hooks/useResizablePanels';
import { useProjectStore } from '../store/useProjectStore';
import { formatTimelineTime } from '../components/timelineHelpers';

type StudioTool = 'media' | 'audio' | 'record' | 'sync';

const studioTools: {
  id: StudioTool;
  label: string;
  icon: 'media' | 'audio' | 'record' | 'sync';
}[] = [
  { id: 'media', label: 'Media', icon: 'media' },
  { id: 'audio', label: 'Audio & Stems', icon: 'audio' },
  { id: 'record', label: 'Record', icon: 'record' },
  { id: 'sync', label: 'Sync', icon: 'sync' },
];

function Icon({ name, className = 'h-5 w-5' }: { name: string; className?: string }) {
  const paths: Record<string, React.ReactNode> = {
    media: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m8 13 2.5-2.5L15 15l2-2 3 3" />
        <circle cx="8" cy="9" r="1" />
      </>
    ),
    audio: (
      <>
        <path d="M9 18V5l10-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="16" cy="16" r="3" />
      </>
    ),
    record: (
      <>
        <circle cx="12" cy="9" r="4" />
        <path d="M5 9a7 7 0 0 0 14 0M12 16v5M9 21h6" />
      </>
    ),
    sync: (
      <>
        <path d="M20 7h-7a4 4 0 0 0-4 4v1" />
        <path d="m17 4 3 3-3 3M4 17h7a4 4 0 0 0 4-4v-1" />
        <path d="m7 20-3-3 3-3" />
      </>
    ),
    inspector: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="9" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="11" cy="18" r="2" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    'chevron-left': <path d="m15 18-6-6 6-6" />,
    'chevron-right': <path d="m9 18 6-6-6-6" />,
  };

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function PanelHeader({
  title,
  eyebrow,
  onClose,
  desktopSide,
  onCollapse,
}: {
  title: string;
  eyebrow: string;
  onClose?: () => void;
  desktopSide?: PanelSide;
  onCollapse?: () => void;
}) {
  return (
    <div className="studio-panel-header">
      <div>
        <p className="studio-eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <div className="flex items-center">
        {onCollapse && desktopSide ? (
          <button
            className="studio-icon-button studio-pane-collapse"
            type="button"
            onClick={onCollapse}
            aria-label={`Collapse ${desktopSide === 'left' ? 'asset' : 'inspector'} panel`}
            title={`Collapse ${desktopSide === 'left' ? 'asset' : 'inspector'} panel`}
          >
            <Icon name={desktopSide === 'left' ? 'chevron-left' : 'chevron-right'} />
          </button>
        ) : null}
        {onClose ? (
          <button
            className="studio-icon-button min-[1360px]:hidden"
            type="button"
            onClick={onClose}
            aria-label={`Close ${title} panel`}
          >
            <Icon name="close" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MediaPanel() {
  return (
    <div className="studio-panel-scroll">
      <VideoUpload compact showPreview={false} />
      <div className="studio-panel-section">
        <p className="studio-section-label">Media workflow</p>
        <p className="studio-muted-copy">
          Video is added to the timeline automatically and stays available in the preview workspace.
        </p>
      </div>
    </div>
  );
}

function AudioPanel() {
  const originalAudio = useProjectStore((state) => state.originalAudio);

  return (
    <div className="studio-panel-scroll studio-context">
      <div className="studio-panel-section">
        <p className="studio-section-label">Source audio</p>
        <DropZone />
        {originalAudio ? (
          <WaveformPlayer
            audioUrl={originalAudio.url}
            label={`Source audio / ${originalAudio.name}`}
          />
        ) : null}
      </div>
      <div className="studio-panel-section">
        <p className="studio-section-label">Stem separation</p>
        <StemSplitter />
      </div>
    </div>
  );
}

function RecordPanel() {
  return (
    <div className="studio-panel-scroll studio-context">
      <RecordingStudio />
    </div>
  );
}

function SyncSummary() {
  const video = useProjectStore((state) => state.video);
  const tracks = useProjectStore((state) => state.tracks);

  return (
    <div className="studio-panel-scroll">
      <div className="studio-panel-section">
        <p className="studio-section-label">Sync readiness</p>
        <div className="studio-status-row">
          <span>Reference video</span>
          <strong>{video ? 'Ready' : 'Needed'}</strong>
        </div>
        <div className="studio-status-row">
          <span>Audio tracks</span>
          <strong>{tracks.filter((track) => track.type !== 'video').length}</strong>
        </div>
        <p className="studio-muted-copy">
          Choose a target and fine-tune alignment in the inspector.
        </p>
      </div>
    </div>
  );
}

function PreviewWorkspace() {
  const video = useProjectStore((state) => state.video);
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncingVideoRef = useRef(false);
  const playheadPosition = useProjectStore((state) => state.playheadPosition);
  const isPlaying = useProjectStore((state) => state.isPlaying);
  const setIsPlaying = useProjectStore((state) => state.setIsPlaying);
  const setPlayheadPosition = useProjectStore((state) => state.setPlayheadPosition);
  const [safeAreaVisible, setSafeAreaVisible] = useState(true);
  const [previewZoom, setPreviewZoom] = useState(1);

  useEffect(() => {
    const player = videoRef.current;
    if (!player) return;

    const mediaDuration = Number.isFinite(player.duration)
      ? player.duration
      : (video?.duration ?? playheadPosition);
    const nextTime = Math.min(playheadPosition, mediaDuration);
    if (Math.abs(player.currentTime - nextTime) <= 0.35) {
      return;
    }

    const shouldResumeFromEnd = player.ended && isPlaying && nextTime < mediaDuration;
    syncingVideoRef.current = true;
    player.currentTime = nextTime;
    if (shouldResumeFromEnd) {
      void player.play().catch(() => setIsPlaying(false));
    }
  }, [isPlaying, playheadPosition, setIsPlaying, video?.duration]);

  useEffect(() => {
    const player = videoRef.current;
    if (!player) {
      return;
    }

    if (isPlaying) {
      void player.play().catch(() => setIsPlaying(false));
    } else {
      player.pause();
    }
  }, [isPlaying, setIsPlaying]);

  return (
    <section className="studio-preview" aria-label="Preview workspace">
      <div className="studio-preview-toolbar">
        <div className="flex items-center gap-2">
          <span className="font-mono text-primary">
            {formatTimelineTime(playheadPosition, true)}
          </span>
          <span className="studio-preview-format">9:16 · Portrait</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={safeAreaVisible ? 'studio-preview-tool is-active' : 'studio-preview-tool'}
            type="button"
            title="Toggle Reels, Shorts, and TikTok safe area"
            aria-pressed={safeAreaVisible}
            onClick={() => setSafeAreaVisible((visible) => !visible)}
          >
            Safe area
          </button>
          <button
            className="studio-preview-tool"
            type="button"
            title="Fit preview"
            onClick={() => setPreviewZoom(1)}
          >
            Fit
          </button>
          <select
            className="studio-preview-zoom"
            aria-label="Preview zoom"
            value={previewZoom}
            onChange={(event) => setPreviewZoom(Number(event.target.value))}
          >
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>
        </div>
      </div>
      <div className="studio-preview-stage">
        <div className="studio-device-frame" style={{ transform: `scale(${previewZoom})` }}>
          {video ? (
            <video
              ref={videoRef}
              className="h-full w-full bg-black object-contain"
              src={video.url}
              muted
              playsInline
              onPlay={() => setIsPlaying(true)}
              onPause={(event) => {
                if (!event.currentTarget.ended) setIsPlaying(false);
              }}
              onSeeked={(event) => {
                if (syncingVideoRef.current) {
                  syncingVideoRef.current = false;
                  return;
                }
                setPlayheadPosition(event.currentTarget.currentTime);
              }}
            />
          ) : (
            <div className="studio-preview-empty">
              <Icon name="media" className="h-8 w-8" />
              <strong>No video selected</strong>
              <span>Add media from the left panel</span>
            </div>
          )}
          {safeAreaVisible ? (
            <div className="studio-safe-area" aria-hidden="true">
              <span>Reels · Shorts · TikTok safe area</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="studio-transport">
        <TransportBar />
      </div>
    </section>
  );
}

function SelectionInspector() {
  const selectedTrackId = useProjectStore((state) => state.selectedTrackId);
  const tracks = useProjectStore((state) => state.tracks);
  const updateTrack = useProjectStore((state) => state.updateTrack);
  const toggleTrackMute = useProjectStore((state) => state.toggleTrackMute);
  const [activeTab, setActiveTab] = useState<'clip' | 'audio'>('clip');
  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? null,
    [selectedTrackId, tracks],
  );
  const effectiveTab = selectedTrack?.type === 'video' ? 'clip' : activeTab;

  if (!selectedTrack) {
    return (
      <div className="studio-inspector-empty">
        <Icon name="inspector" />
        <strong>Nothing selected</strong>
        <span>Select a timeline clip to inspect its settings.</span>
      </div>
    );
  }

  return (
    <div className="studio-panel-scroll">
      <div className="studio-inspector-tabs" role="tablist" aria-label="Inspector sections">
        <button
          role="tab"
          aria-selected={effectiveTab === 'clip'}
          className={effectiveTab === 'clip' ? 'is-active' : ''}
          onClick={() => setActiveTab('clip')}
        >
          Clip
        </button>
        {selectedTrack.type !== 'video' ? (
          <button
            role="tab"
            aria-selected={effectiveTab === 'audio'}
            className={effectiveTab === 'audio' ? 'is-active' : ''}
            onClick={() => setActiveTab('audio')}
          >
            Audio
          </button>
        ) : null}
      </div>
      {effectiveTab === 'clip' ? (
        <div className="studio-panel-section">
          <label className="studio-field">
            Name
            <input
              value={selectedTrack.name}
              onChange={(event) => updateTrack(selectedTrack.id, { name: event.target.value })}
            />
          </label>
          <div className="studio-property-grid">
            <span>Type</span>
            <strong>{selectedTrack.type}</strong>
            <span>Start</span>
            <strong>{formatTimelineTime(selectedTrack.startOffset, true)}</strong>
            <span>Duration</span>
            <strong>{formatTimelineTime(selectedTrack.duration, true)}</strong>
          </div>
        </div>
      ) : (
        <div className="studio-panel-section">
          <label className="studio-field">
            Volume <span>{Math.round(selectedTrack.volume * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={selectedTrack.volume}
              onChange={(event) =>
                updateTrack(selectedTrack.id, { volume: Number(event.target.value) })
              }
            />
          </label>
          <button
            className="studio-secondary-button w-full"
            type="button"
            onClick={() => toggleTrackMute(selectedTrack.id)}
          >
            {selectedTrack.muted ? 'Unmute track' : 'Mute track'}
          </button>
        </div>
      )}
    </div>
  );
}

export function Studio() {
  usePlaybackEngine();
  const panels = useResizablePanels();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  useAutoSave(setSaveStatus);
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<StudioTool>('media');
  const [toolDrawerOpen, setToolDrawerOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  useKeyboardShortcuts(openHelp);
  const originalAudio = useProjectStore((state) => state.originalAudio);
  const stems = useProjectStore((state) => state.stems);
  const recordings = useProjectStore((state) => state.recordings);
  const activeToolMeta = studioTools.find((tool) => tool.id === activeTool) ?? studioTools[0];

  const badges: Partial<Record<StudioTool, number>> = {
    audio: stems.length || (originalAudio ? 1 : 0),
    record: recordings.length,
  };

  const panelContent: Record<StudioTool, React.ReactNode> = {
    media: <MediaPanel />,
    audio: <AudioPanel />,
    record: <RecordPanel />,
    sync: <SyncSummary />,
  };

  return (
    <div className="studio-shell">
      <header className="studio-command-bar" aria-label="Studio command bar">
        <div className="studio-command-group min-w-0">
          <Link to="/studio" className="studio-logo" aria-label="Sori-cut studio">
            <span>소리</span>컷
          </Link>
          <div className="studio-command-divider" />
          <div className="hidden min-w-0 sm:block">
            <ProjectManager saveStatus={saveStatus} />
          </div>
          <div className="hidden md:block">
            <UndoRedoButtons />
          </div>
        </div>
        <div className="studio-command-group">
          <button
            className="studio-secondary-button min-[1360px]:hidden"
            type="button"
            onClick={() => setInspectorOpen(true)}
          >
            <Icon name="inspector" className="h-4 w-4" /> Inspector
          </button>
          <button
            onClick={() => setHelpOpen(true)}
            className="studio-icon-button"
            aria-label="Keyboard shortcuts"
            title="Shortcuts"
          >
            ?
          </button>
          <Link to="/export" className="studio-primary-button">
            Export
          </Link>
        </div>
      </header>

      <main className="studio-main">
        <div ref={panels.containerRef} className="studio-upper" style={panels.style}>
          <nav className="studio-tool-rail" aria-label="Studio tools">
            {studioTools.map((tool) => (
              <button
                key={tool.id}
                className={
                  activeTool === tool.id ? 'studio-tool-button is-active' : 'studio-tool-button'
                }
                type="button"
                aria-pressed={activeTool === tool.id}
                onClick={() => {
                  setActiveTool(tool.id);
                  setToolDrawerOpen(true);
                }}
              >
                <span className="relative">
                  <Icon name={tool.icon} />
                  {badges[tool.id] ? (
                    <span className="studio-tool-badge">{badges[tool.id]}</span>
                  ) : null}
                </span>
                <span>{tool.label === 'Audio & Stems' ? 'Audio' : tool.label}</span>
              </button>
            ))}
          </nav>

          {toolDrawerOpen || inspectorOpen ? (
            <button
              className="studio-drawer-scrim min-[1360px]:hidden"
              type="button"
              aria-label="Close open panel"
              onClick={() => {
                setToolDrawerOpen(false);
                setInspectorOpen(false);
              }}
            />
          ) : null}

          <aside
            className={[
              'studio-context-panel',
              toolDrawerOpen ? 'is-open' : '',
              panels.layout.left.collapsed ? 'is-collapsed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label={`${activeToolMeta.label} panel`}
          >
            <button
              className="studio-pane-expand"
              type="button"
              onClick={() => panels.setPanelCollapsed('left', false)}
              aria-label="Expand asset panel"
              title="Expand asset panel"
            >
              <Icon name="chevron-right" />
            </button>
            <div className="studio-pane-body">
              <PanelHeader
                title={activeToolMeta.label}
                eyebrow="Assets"
                onClose={() => setToolDrawerOpen(false)}
                desktopSide="left"
                onCollapse={() => panels.setPanelCollapsed('left', true)}
              />
              {panelContent[activeTool]}
            </div>
          </aside>

          {!panels.layout.left.collapsed ? (
            <div className="studio-splitter is-left" {...panels.getSeparatorProps('left')}>
              <span aria-hidden="true" />
            </div>
          ) : null}

          <PreviewWorkspace />

          {!panels.layout.right.collapsed ? (
            <div className="studio-splitter is-right" {...panels.getSeparatorProps('right')}>
              <span aria-hidden="true" />
            </div>
          ) : null}

          <aside
            className={[
              'studio-inspector',
              inspectorOpen ? 'is-open' : '',
              panels.layout.right.collapsed ? 'is-collapsed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label="Inspector"
          >
            <button
              className="studio-pane-expand"
              type="button"
              onClick={() => panels.setPanelCollapsed('right', false)}
              aria-label="Expand inspector panel"
              title="Expand inspector panel"
            >
              <Icon name="chevron-left" />
            </button>
            <div className="studio-pane-body">
              <PanelHeader
                title={activeTool === 'sync' ? 'Sync settings' : 'Inspector'}
                eyebrow="Edit"
                onClose={() => setInspectorOpen(false)}
                desktopSide="right"
                onCollapse={() => panels.setPanelCollapsed('right', true)}
              />
              <div className={activeTool === 'sync' ? 'studio-context studio-panel-scroll' : ''}>
                {activeTool === 'sync' ? <SyncControls /> : <SelectionInspector />}
              </div>
            </div>
          </aside>
        </div>

        <section className="studio-timeline-region" aria-label="Timeline editor">
          <div className="studio-timeline-title">
            <div>
              <span>Timeline</span>
              <small>Arrange and refine your edit</small>
            </div>
            <span className="studio-timeline-status">
              Auto-save {saveStatus === 'error' ? 'failed' : 'on'}
            </span>
          </div>
          <div className="studio-timeline-content">
            <Timeline />
          </div>
        </section>
      </main>

      <Toast />
      <ShortcutHelpModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
