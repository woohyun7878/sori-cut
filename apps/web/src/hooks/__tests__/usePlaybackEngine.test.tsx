import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../store/useProjectStore';
import { usePlaybackEngine } from '../usePlaybackEngine';

interface MockEngine {
  destroy: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  preloadTracks: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  setLoopEnabled: ReturnType<typeof vi.fn>;
  syncTracks: ReturnType<typeof vi.fn>;
  onEnd: (() => void) | null;
  onPlayhead: ((position: number) => void) | null;
}

const playbackMocks = vi.hoisted(() => ({
  instances: [] as MockEngine[],
}));

vi.mock('../../lib/playbackEngine', () => ({
  PlaybackEngine: class {
    destroy = vi.fn();
    pause = vi.fn();
    play = vi.fn(() => Promise.resolve());
    preloadTracks = vi.fn(() => Promise.resolve());
    seek = vi.fn(() => Promise.resolve());
    setLoopEnabled = vi.fn();
    syncTracks = vi.fn(() => Promise.resolve());
    onEnd: (() => void) | null = null;
    onPlayhead: ((position: number) => void) | null = null;

    constructor() {
      playbackMocks.instances.push(this);
    }

    setCallbacks(onPlayhead: (position: number) => void, onEnd: () => void) {
      this.onPlayhead = onPlayhead;
      this.onEnd = onEnd;
    }
  },
}));

function Harness() {
  usePlaybackEngine();
  return null;
}

describe('usePlaybackEngine', () => {
  beforeEach(() => {
    playbackMocks.instances.length = 0;
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    useProjectStore.getState().reset();
    vi.spyOn(performance, 'now').mockReturnValue(100);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not turn an engine-driven playhead update into a seek', async () => {
    useProjectStore.setState({
      tracks: [
        {
          id: 'track-1',
          name: 'Track 1',
          type: 'audio',
          sourceUrl: '',
          startOffset: 0,
          duration: 5,
          sourceStartOffset: 0,
          muted: false,
          volume: 1,
        },
      ],
    });
    render(<Harness />);
    const engine = playbackMocks.instances[0];

    act(() => {
      useProjectStore.getState().setIsPlaying(true);
    });
    await waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));

    act(() => {
      engine.onPlayhead?.(1.25);
    });
    await waitFor(() => expect(useProjectStore.getState().playheadPosition).toBe(1.25));

    expect(engine.seek).not.toHaveBeenCalled();
  });

  it('propagates every loop setting change to the engine', async () => {
    render(<Harness />);
    const engine = playbackMocks.instances[0];
    await waitFor(() => expect(engine.setLoopEnabled).toHaveBeenLastCalledWith(false));

    act(() => {
      useProjectStore.getState().setLoopEnabled(true);
    });
    await waitFor(() => expect(engine.setLoopEnabled).toHaveBeenLastCalledWith(true));

    act(() => {
      useProjectStore.getState().setLoopEnabled(false);
    });
    await waitFor(() => expect(engine.setLoopEnabled).toHaveBeenLastCalledWith(false));
    expect(engine.setLoopEnabled).toHaveBeenCalledTimes(3);
  });

  it('propagates loop changes to the existing engine while startup is pending', async () => {
    let resolveStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    render(<Harness />);
    const engine = playbackMocks.instances[0];
    engine.play.mockReturnValueOnce(startup);

    act(() => {
      useProjectStore.getState().setIsPlaying(true);
    });
    await waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));

    act(() => {
      useProjectStore.getState().setLoopEnabled(true);
    });
    await waitFor(() => expect(engine.setLoopEnabled).toHaveBeenLastCalledWith(true));

    expect(playbackMocks.instances).toHaveLength(1);
    resolveStartup();
    await startup;
  });

  it('commits the final playhead position when playback ends', async () => {
    useProjectStore.setState({
      tracks: [
        {
          id: 'track-1',
          name: 'Track 1',
          type: 'audio',
          sourceUrl: '',
          startOffset: 0,
          duration: 5,
          sourceStartOffset: 0,
          muted: false,
          volume: 1,
        },
      ],
      isPlaying: true,
    });
    render(<Harness />);
    const engine = playbackMocks.instances[0];

    act(() => {
      engine.onPlayhead?.(0);
      engine.onEnd?.();
    });

    await waitFor(() => expect(useProjectStore.getState().isPlaying).toBe(false));
    expect(useProjectStore.getState().playheadPosition).toBe(5);
  });

  it('synchronizes track mix changes without starting playback again', async () => {
    const track = {
      id: 'track-1',
      name: 'Track 1',
      type: 'audio' as const,
      sourceUrl: '',
      startOffset: 0,
      duration: 5,
      sourceStartOffset: 0,
      muted: false,
      volume: 1,
    };
    useProjectStore.setState({ tracks: [track], isPlaying: true });
    render(<Harness />);
    const engine = playbackMocks.instances[0];
    await waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));
    expect(engine.syncTracks).not.toHaveBeenCalled();

    act(() => {
      useProjectStore.getState().updateTrack('track-1', { name: 'Renamed' });
    });
    expect(engine.syncTracks).not.toHaveBeenCalled();

    act(() => {
      useProjectStore.setState({ tracks: [{ ...track, volume: 0.25 }] });
    });
    await waitFor(() =>
      expect(engine.syncTracks).toHaveBeenLastCalledWith([{ ...track, volume: 0.25 }], 5),
    );

    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['startOffset', { startOffset: 1 }, 6],
    ['sourceStartOffset', { sourceStartOffset: 1 }, 5],
    ['duration', { duration: 4 }, 4],
  ])(
    'synchronizes a live %s change without restarting playback',
    async (_field, update, expectedDuration) => {
      const track = {
        id: 'track-1',
        name: 'Track 1',
        type: 'audio' as const,
        sourceUrl: 'blob:track-1',
        startOffset: 0,
        duration: 5,
        sourceStartOffset: 0,
        muted: false,
        volume: 1,
      };
      useProjectStore.setState({ tracks: [track], isPlaying: true });
      render(<Harness />);
      const engine = playbackMocks.instances[0];
      await waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));

      const updatedTrack = { ...track, ...update };
      act(() => {
        useProjectStore.setState({ tracks: [updatedTrack] });
      });

      await waitFor(() =>
        expect(engine.syncTracks).toHaveBeenLastCalledWith([updatedTrack], expectedDuration),
      );
      expect(engine.play).toHaveBeenCalledTimes(1);
    },
  );

  it('synchronizes video-only project duration extensions and shortenings', async () => {
    const video = {
      id: 'video-1',
      name: 'preview.mp4',
      blob: new Blob(),
      url: 'blob:preview',
      duration: 2,
      width: 1080,
      height: 1920,
    };
    useProjectStore.setState({ tracks: [], video, isPlaying: true });
    render(<Harness />);
    const engine = playbackMocks.instances[0];
    await waitFor(() => expect(engine.play).toHaveBeenCalledWith([], 0, 2, false));

    act(() => {
      useProjectStore.setState({ video: { ...video, duration: 4 } });
    });
    await waitFor(() => expect(engine.syncTracks).toHaveBeenLastCalledWith([], 4));

    act(() => {
      useProjectStore.setState({ video: { ...video, duration: 1 } });
    });
    await waitFor(() => expect(engine.syncTracks).toHaveBeenLastCalledWith([], 1));
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it('pauses existing playback when a live mix update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const track = {
      id: 'track-1',
      name: 'Track 1',
      type: 'audio' as const,
      sourceUrl: 'blob:track-1',
      startOffset: 0,
      duration: 5,
      sourceStartOffset: 0,
      muted: false,
      volume: 1,
    };
    useProjectStore.setState({ tracks: [track] });
    render(<Harness />);
    const engine = playbackMocks.instances[0];

    act(() => {
      useProjectStore.getState().setIsPlaying(true);
    });
    await waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));
    engine.syncTracks.mockRejectedValueOnce(new Error('unmute failed'));

    act(() => {
      useProjectStore.getState().setTrackVolume('track-1', 0.5);
    });

    await waitFor(() => expect(useProjectStore.getState().isPlaying).toBe(false));
    expect(engine.pause).toHaveBeenCalledTimes(1);
  });
});
