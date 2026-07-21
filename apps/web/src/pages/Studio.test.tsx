import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio } from './Studio';

const storeState = {
  originalAudio: null,
  stems: [],
  recordings: [],
  video: null as {
    id: string;
    name: string;
    blob: Blob;
    url: string;
    duration: number;
    width: number;
    height: number;
  } | null,
  tracks: [],
  selectedTrackId: null,
  playheadPosition: 0,
  isPlaying: false,
  setIsPlaying: vi.fn(),
  setPlayheadPosition: vi.fn(),
  updateTrack: vi.fn(),
  toggleTrackMute: vi.fn(),
};

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('../hooks/useAutoSave', () => ({ useAutoSave: vi.fn() }));
vi.mock('../hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock('../hooks/usePlaybackEngine', () => ({ usePlaybackEngine: vi.fn() }));
vi.mock('../components/ProjectManager', () => ({
  ProjectManager: () => <div>Project controls</div>,
}));
vi.mock('../components/UndoRedoButtons', () => ({
  UndoRedoButtons: () => <div>History controls</div>,
}));
vi.mock('../components/VideoUpload', () => ({ VideoUpload: () => <div>Media uploader</div> }));
vi.mock('../components/DropZone', () => ({ DropZone: () => <div>Audio uploader</div> }));
vi.mock('../components/WaveformPlayer', () => ({ WaveformPlayer: () => <div>Waveform</div> }));
vi.mock('../components/StemSplitter', () => ({ StemSplitter: () => <div>Stem splitter</div> }));
vi.mock('../components/RecordingStudio', () => ({
  RecordingStudio: () => <div>Recording studio</div>,
}));
vi.mock('../components/SyncControls', () => ({ SyncControls: () => <div>Sync controls</div> }));
vi.mock('../components/TransportBar', () => ({
  TransportBar: () => <div>Transport controls</div>,
}));
vi.mock('../components/Timeline', () => ({ Timeline: () => <div>Timeline controls</div> }));
vi.mock('../components/Toast', () => ({ Toast: () => null }));
vi.mock('../components/ShortcutHelpModal', () => ({ ShortcutHelpModal: () => null }));

describe('Studio shell', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    storeState.originalAudio = null;
    storeState.stems = [];
    storeState.recordings = [];
    storeState.video = null;
    storeState.tracks = [];
    storeState.selectedTrackId = null;
    storeState.playheadPosition = 0;
    storeState.isPlaying = false;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  it('renders the editor zones and defaults to the Media workspace', () => {
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(screen.getByRole('banner', { name: 'Studio command bar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Studio tools' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Preview workspace' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Timeline editor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Media panel')).toBeInTheDocument();
    expect(screen.getByText('Media uploader')).toBeInTheDocument();
  });

  it('switches contextual content and exposes responsive drawers', () => {
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Audio', pressed: false }));
    expect(screen.getByLabelText('Audio & Stems panel')).toHaveClass('is-open');
    expect(screen.getByText('Audio uploader')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync', pressed: false }));
    expect(screen.getByLabelText('Sync panel')).toHaveClass('is-open');
    expect(screen.getByText('Sync controls')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }));
    expect(screen.getByLabelText('Inspector')).toHaveClass('is-open');
  });

  it('toggles preview safe-area guides and changes preview zoom', () => {
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    const safeAreaToggle = screen.getByRole('button', { name: 'Safe area' });
    expect(safeAreaToggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(safeAreaToggle);
    expect(safeAreaToggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.change(screen.getByRole('combobox', { name: 'Preview zoom' }), {
      target: { value: '1.25' },
    });
    expect(
      screen
        .getByRole('region', { name: 'Preview workspace' })
        .querySelector('.studio-device-frame'),
    ).toHaveStyle({
      transform: 'scale(1.25)',
    });
  });

  it('exposes accessible desktop splitters and explicit pane collapse controls', () => {
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(screen.getByRole('separator', { name: 'Resize asset panel' })).toHaveAttribute(
      'aria-orientation',
      'vertical',
    );
    expect(screen.getByRole('separator', { name: 'Resize inspector panel' })).toHaveAttribute(
      'tabindex',
      '0',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse asset panel' }));
    expect(screen.getByLabelText('Media panel')).toHaveClass('is-collapsed');
    expect(screen.getByRole('button', { name: 'Expand asset panel' })).toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize asset panel' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand asset panel' }));
    expect(screen.getByLabelText('Media panel')).not.toHaveClass('is-collapsed');
    expect(screen.getByRole('separator', { name: 'Resize asset panel' })).toBeInTheDocument();
  });

  it('keeps responsive drawer content mounted when a desktop pane is persisted as collapsed', () => {
    localStorage.setItem(
      'sori-cut:workspace-layout:v1',
      JSON.stringify({
        version: 1,
        left: { width: 420, collapsed: true },
        right: { width: 360, collapsed: false },
      }),
    );

    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Audio', pressed: false }));
    expect(screen.getByLabelText('Audio & Stems panel')).toHaveClass('is-open');
    expect(screen.getByText('Audio uploader')).toBeInTheDocument();
  });

  it('keeps project playback running when a shorter video ends naturally', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video');
    expect(player).not.toBeNull();
    vi.clearAllMocks();
    Object.defineProperty(player, 'ended', { configurable: true, value: true });

    fireEvent.pause(player as HTMLVideoElement);

    expect(storeState.setIsPlaying).not.toHaveBeenCalled();
  });

  it('stops project playback when the user explicitly pauses video', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video');
    expect(player).not.toBeNull();
    vi.clearAllMocks();
    Object.defineProperty(player, 'ended', { configurable: true, value: false });

    fireEvent.pause(player as HTMLVideoElement);

    expect(storeState.setIsPlaying).toHaveBeenCalledWith(false);
  });

  it('restarts an ended shorter video when the project playhead loops', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    storeState.playheadPosition = 2;
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video');
    expect(player).not.toBeNull();
    Object.defineProperty(player, 'duration', { configurable: true, value: 2 });
    Object.defineProperty(player, 'ended', { configurable: true, value: true });
    let currentTime = 2;
    const setCurrentTime = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: setCurrentTime,
    });
    vi.clearAllMocks();

    storeState.playheadPosition = 3;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    expect(setCurrentTime).not.toHaveBeenCalled();

    storeState.playheadPosition = 0;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(setCurrentTime).toHaveBeenCalledWith(0);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(storeState.setIsPlaying).not.toHaveBeenCalledWith(false);
    fireEvent.seeked(player as HTMLVideoElement);
    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
  });

  it('restarts an ended video for a near-end project seek within drift tolerance', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    storeState.playheadPosition = 2;
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video');
    expect(player).not.toBeNull();
    Object.defineProperty(player, 'duration', { configurable: true, value: 2 });
    Object.defineProperty(player, 'ended', { configurable: true, value: true });
    let currentTime = 2;
    const setCurrentTime = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: setCurrentTime,
    });
    vi.clearAllMocks();

    storeState.playheadPosition = 1.8;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(setCurrentTime).toHaveBeenCalledWith(1.8);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('restarts an ended very short video when the project loops', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 0.2,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    storeState.playheadPosition = 0.2;
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video');
    expect(player).not.toBeNull();
    Object.defineProperty(player, 'duration', { configurable: true, value: 0.2 });
    Object.defineProperty(player, 'ended', { configurable: true, value: true });
    let currentTime = 0.2;
    const setCurrentTime = vi.fn((value: number) => {
      currentTime = value;
    });
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: setCurrentTime,
    });
    vi.clearAllMocks();

    storeState.playheadPosition = 0;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(setCurrentTime).toHaveBeenCalledWith(0);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });
});
