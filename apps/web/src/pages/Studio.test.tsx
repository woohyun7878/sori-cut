import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Studio } from './Studio';

const storeState = {
  originalAudio: null,
  stems: [],
  recordings: [],
  video: null as
    | {
        id: string;
        name: string;
        blob: Blob;
        url: string;
        duration: number;
        width: number;
        height: number;
      }
    | null,
  tracks: [],
  selectedTrackId: null,
  playheadPosition: 0,
  isPlaying: false,
  setIsPlaying: vi.fn(),
  setPlayheadPosition: vi.fn(),
  updateTrack: vi.fn(),
  toggleTrackMute: vi.fn(),
};

function fireVideoSeekIntent(
  player: HTMLVideoElement,
  interaction: 'pointer' | 'touch' | 'keyboard',
) {
  if (interaction === 'pointer') {
    fireEvent.pointerDown(player);
  } else if (interaction === 'touch') {
    fireEvent.touchStart(player);
  } else {
    fireEvent.keyDown(player, { key: 'ArrowRight' });
  }
}

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
    vi.clearAllMocks();
    localStorage.clear();
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
    Object.defineProperty(player, 'ended', { configurable: true, value: true });
    fireEvent.seeking(player as HTMLVideoElement);
    vi.clearAllMocks();

    storeState.playheadPosition = 0;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.seeked(player as HTMLVideoElement);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(storeState.setIsPlaying).not.toHaveBeenCalledWith(false);
  });

  it('does not rewind project playback when video clamping emits seeked', () => {
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
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 2 });
    player.currentTime = 0;
    vi.clearAllMocks();

    storeState.playheadPosition = 5;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    expect(player.currentTime).toBe(2);
    fireEvent.seeking(player);
    fireEvent.seeked(player);

    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();

    player.currentTime = 1.25;
    fireEvent.seeked(player);
    expect(storeState.setPlayheadPosition).toHaveBeenCalledWith(1.25);
  });

  it('queues newer programmatic video targets until the prior seek completes', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 3,
      width: 1080,
      height: 1920,
    };
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
    player.currentTime = 0;
    vi.clearAllMocks();

    storeState.playheadPosition = 1;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    storeState.playheadPosition = 1.5;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(player.currentTime).toBe(1);
    fireEvent.seeking(player);
    fireEvent.seeked(player);
    expect(player.currentTime).toBe(1.5);
    fireEvent.seeking(player);
    fireEvent.seeked(player);
    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
  });

  it('clears a queued target when the newest target returns to the in-flight seek', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 3,
      width: 1080,
      height: 1920,
    };
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
    let currentTime = 0;
    const assignments: number[] = [];
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        assignments.push(value);
      },
    });
    vi.clearAllMocks();

    for (const target of [1, 1.5, 1]) {
      storeState.playheadPosition = target;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
    }

    expect(assignments).toEqual([1]);
    fireEvent.seeking(player);
    fireEvent.seeked(player);
    expect(assignments).toEqual([1]);
    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
  });

  it.each(['pointer', 'touch', 'keyboard'] as const)(
    'lets a new $interaction user seek bypass a retired programmatic target',
    (interaction) => {
      storeState.video = {
        id: 'video-1',
        name: 'preview.mp4',
        blob: new Blob(),
        url: 'blob:preview',
        duration: 3,
        width: 1080,
        height: 1920,
      };
      const view = render(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const player = document.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
      player.currentTime = 0;
      vi.clearAllMocks();

      storeState.playheadPosition = 1.5;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );

      fireVideoSeekIntent(player, interaction);
      player.currentTime = 0.5;
      fireEvent.seeking(player);
      fireEvent.seeked(player);
      expect(storeState.setPlayheadPosition).toHaveBeenCalledWith(0.5);

      fireVideoSeekIntent(player, interaction);
      player.currentTime = 1.5;
      fireEvent.seeking(player);
      fireEvent.seeked(player);
      expect(storeState.setPlayheadPosition).toHaveBeenLastCalledWith(1.5);
      expect(storeState.setPlayheadPosition).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['pointer', 'touch', 'keyboard'] as const)(
    'lets $interaction user intent own an active programmatic target',
    (interaction) => {
      storeState.video = {
        id: 'video-1',
        name: 'preview.mp4',
        blob: new Blob(),
        url: 'blob:preview',
        duration: 3,
        width: 1080,
        height: 1920,
      };
      const view = render(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const player = document.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
      player.currentTime = 0;
      vi.clearAllMocks();

      storeState.playheadPosition = 1.5;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      fireVideoSeekIntent(player, interaction);
      fireEvent.seeking(player);
      fireEvent.seeked(player);

      expect(storeState.setPlayheadPosition).toHaveBeenCalledTimes(1);
      expect(storeState.setPlayheadPosition).toHaveBeenCalledWith(1.5);
    },
  );

  it('ignores a late programmatic seek after a user overrides it', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 3,
      width: 1080,
      height: 1920,
    };
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
    player.currentTime = 0;
    vi.clearAllMocks();

    storeState.playheadPosition = 1.5;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    fireVideoSeekIntent(player, 'pointer');
    player.currentTime = 0.5;
    fireEvent.seeking(player);
    fireEvent.seeked(player);

    player.currentTime = 1.5;
    fireEvent.seeked(player);
    expect(storeState.setPlayheadPosition).toHaveBeenCalledTimes(1);
    expect(storeState.setPlayheadPosition).toHaveBeenCalledWith(0.5);
  });

  it.each(['pointer', 'keyboard'] as const)(
    'keeps duplicate tombstones until an explicit $interaction seek owns the target',
    (interaction) => {
      storeState.video = {
        id: 'video-1',
        name: 'preview.mp4',
        blob: new Blob(),
        url: 'blob:preview',
        duration: 3,
        width: 1080,
        height: 1920,
      };
      const view = render(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const player = document.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(player, 'duration', { configurable: true, value: 3 });
      player.currentTime = 0;
      vi.clearAllMocks();

      storeState.playheadPosition = 1.5;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      fireEvent.seeking(player);
      fireEvent.seeked(player);
      fireEvent.seeked(player);
      fireEvent.seeked(player);
      expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();

      fireVideoSeekIntent(player, interaction);
      fireEvent.seeking(player);
      fireEvent.seeked(player);
      expect(storeState.setPlayheadPosition).toHaveBeenCalledTimes(1);
      expect(storeState.setPlayheadPosition).toHaveBeenCalledWith(1.5);
    },
  );

  it('leaves an ended shorter video stopped when project playback resumes at its duration', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.playheadPosition = 2;
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 2 });
    Object.defineProperty(player, 'ended', { configurable: true, value: true });
    player.currentTime = 2;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => {
      player.currentTime = 0;
      fireEvent.seeked(player);
      return Promise.resolve();
    });
    vi.clearAllMocks();

    storeState.isPlaying = true;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(player.currentTime).toBe(2);
    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
  });

  it('does not start non-ended video when the project target is beyond its duration', () => {
    storeState.video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    storeState.playheadPosition = 5;
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    const player = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(player, 'duration', { configurable: true, value: 2 });
    Object.defineProperty(player, 'ended', { configurable: true, value: false });
    player.currentTime = 2;
    vi.clearAllMocks();

    storeState.isPlaying = true;
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
  });

  it.each([{ newDuration: 3 }, { newDuration: 2 }])(
    'resynchronizes a replacement with duration $newDuration and ignores the old seeked event',
    ({ newDuration }) => {
      storeState.video = {
        id: 'video-1',
        name: 'old-preview.mp4',
        blob: new Blob(),
        url: 'blob:old-preview',
        duration: 3,
        width: 1080,
        height: 1920,
      };
      storeState.isPlaying = true;
      const view = render(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const oldPlayer = document.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(oldPlayer, 'duration', { configurable: true, value: 3 });
      oldPlayer.currentTime = 0;
      vi.clearAllMocks();

      storeState.playheadPosition = 1.5;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      expect(oldPlayer.currentTime).toBe(1.5);

      storeState.video = {
        ...storeState.video,
        id: 'video-2',
        name: 'new-preview.mp4',
        url: 'blob:new-preview',
        duration: newDuration,
      };
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const newPlayer = document.querySelector('video') as HTMLVideoElement;

      expect(newPlayer).not.toBe(oldPlayer);
      expect(newPlayer.currentTime).toBe(1.5);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
      fireEvent.seeked(oldPlayer);
      expect(newPlayer.currentTime).toBe(1.5);
      expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();

      fireEvent.seeking(newPlayer);
      fireEvent.seeked(newPlayer);
      expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
    },
  );

  it('ignores a play rejection from the replaced video source', async () => {
    storeState.video = {
      id: 'video-1',
      name: 'old-preview.mp4',
      blob: new Blob(),
      url: 'blob:old-preview',
      duration: 3,
      width: 1080,
      height: 1920,
    };
    storeState.isPlaying = true;
    let rejectOldPlay: (reason?: unknown) => void = () => undefined;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOldPlay = reject;
        }),
    );
    const view = render(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );

    storeState.video = {
      ...storeState.video,
      id: 'video-2',
      name: 'new-preview.mp4',
      url: 'blob:new-preview',
    };
    view.rerender(
      <MemoryRouter>
        <Studio />
      </MemoryRouter>,
    );
    vi.clearAllMocks();

    await act(async () => {
      rejectOldPlay(new Error('Old source was replaced'));
      await Promise.resolve();
    });

    expect(storeState.setIsPlaying).not.toHaveBeenCalled();
  });

  it.each([
    { duration: 2, target: 1.995, hasInitialPendingSeek: true },
    { duration: 0.005, target: 0.004, hasInitialPendingSeek: false },
  ])(
    'repositions and resumes ended video at project target $target',
    ({ duration, target, hasInitialPendingSeek }) => {
      storeState.video = {
        id: 'video-1',
        name: 'preview.mp4',
        blob: new Blob(),
        url: 'blob:preview',
        duration,
        width: 1080,
        height: 1920,
      };
      storeState.isPlaying = true;
      storeState.playheadPosition = duration;
      const view = render(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );
      const player = document.querySelector('video') as HTMLVideoElement;
      Object.defineProperty(player, 'duration', { configurable: true, value: duration });
      Object.defineProperty(player, 'ended', { configurable: true, value: true });
      player.currentTime = duration;
      if (hasInitialPendingSeek) fireEvent.seeking(player);
      vi.clearAllMocks();

      storeState.playheadPosition = target;
      view.rerender(
        <MemoryRouter>
          <Studio />
        </MemoryRouter>,
      );

      if (hasInitialPendingSeek) {
        expect(player.currentTime).toBe(duration);
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        fireEvent.seeked(player);
      }
      expect(player.currentTime).toBe(target);
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
      fireEvent.seeking(player);
      fireEvent.seeked(player);
      expect(storeState.setPlayheadPosition).not.toHaveBeenCalled();
    },
  );
});
