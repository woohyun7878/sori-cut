import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio } from './Studio';

const storeState = {
  originalAudio: null,
  stems: [],
  recordings: [],
  video: null,
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
vi.mock('../components/ProjectManager', () => ({ ProjectManager: () => <div>Project controls</div> }));
vi.mock('../components/UndoRedoButtons', () => ({ UndoRedoButtons: () => <div>History controls</div> }));
vi.mock('../components/VideoUpload', () => ({ VideoUpload: () => <div>Media uploader</div> }));
vi.mock('../components/DropZone', () => ({ DropZone: () => <div>Audio uploader</div> }));
vi.mock('../components/WaveformPlayer', () => ({ WaveformPlayer: () => <div>Waveform</div> }));
vi.mock('../components/StemSplitter', () => ({ StemSplitter: () => <div>Stem splitter</div> }));
vi.mock('../components/RecordingStudio', () => ({ RecordingStudio: () => <div>Recording studio</div> }));
vi.mock('../components/SyncControls', () => ({ SyncControls: () => <div>Sync controls</div> }));
vi.mock('../components/TransportBar', () => ({ TransportBar: () => <div>Transport controls</div> }));
vi.mock('../components/Timeline', () => ({ Timeline: () => <div>Timeline controls</div> }));
vi.mock('../components/Toast', () => ({ Toast: () => null }));
vi.mock('../components/ShortcutHelpModal', () => ({ ShortcutHelpModal: () => null }));

describe('Studio shell', () => {
  afterEach(cleanup);

  beforeEach(() => {
    storeState.originalAudio = null;
    storeState.stems = [];
    storeState.recordings = [];
    storeState.video = null;
    storeState.tracks = [];
    storeState.selectedTrackId = null;
  });

  it('renders the editor zones and defaults to the Media workspace', () => {
    render(<MemoryRouter><Studio /></MemoryRouter>);

    expect(screen.getByRole('banner', { name: 'Studio command bar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Studio tools' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Preview workspace' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Timeline editor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Media panel')).toBeInTheDocument();
    expect(screen.getByText('Media uploader')).toBeInTheDocument();
  });

  it('switches contextual content and exposes responsive drawers', () => {
    render(<MemoryRouter><Studio /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'Audio', pressed: false }));
    expect(screen.getByLabelText('Audio & Stems panel')).toHaveClass('is-open');
    expect(screen.getByText('Audio uploader')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync', pressed: false }));
    expect(screen.getByLabelText('Sync panel')).toHaveClass('is-open');
    expect(screen.getByText('Sync controls')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }));
    expect(screen.getByLabelText('Inspector')).toHaveClass('is-open');
  });
});
