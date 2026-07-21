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
    onPlayhead: ((position: number) => void) | null = null;

    constructor() {
      playbackMocks.instances.push(this);
    }

    setCallbacks(onPlayhead: (position: number) => void) {
      this.onPlayhead = onPlayhead;
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
          sourceUrl: 'blob:track-1',
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
});
