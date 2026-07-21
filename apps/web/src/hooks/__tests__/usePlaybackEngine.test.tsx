import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackError } from '../../lib/playbackEngine';
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
  onError: ((error: PlaybackError) => void) | null;
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
    onError: ((error: PlaybackError) => void) | null = null;
    onPlayhead: ((position: number) => void) | null = null;

    constructor() {
      playbackMocks.instances.push(this);
    }

    setCallbacks(
      onPlayhead: (position: number) => void,
      onEnd: () => void,
      onError: (error: PlaybackError) => void,
    ) {
      this.onPlayhead = onPlayhead;
      this.onEnd = onEnd;
      this.onError = onError;
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

  it('stops engine playback before clearing UI state after a live-sync failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    await waitFor(() => expect(engine.syncTracks).toHaveBeenCalledTimes(1));

    const syncError = new Error('unmute failed') as PlaybackError;
    engine.syncTracks.mockRejectedValueOnce(syncError);
    engine.pause.mockImplementationOnce(() => engine.onError?.(syncError));

    act(() => {
      useProjectStore.setState({ tracks: [{ ...track, volume: 0.5 }] });
    });

    await waitFor(() => expect(useProjectStore.getState().isPlaying).toBe(false));
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});
