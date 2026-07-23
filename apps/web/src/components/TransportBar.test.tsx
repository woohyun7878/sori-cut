import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportBar } from './TransportBar';

type TransportState = {
  tracks: unknown[];
  video: unknown;
  playheadPosition: number;
  isPlaying: boolean;
  loopEnabled: boolean;
  setPlayheadPosition: ReturnType<typeof vi.fn>;
  setIsPlaying: ReturnType<typeof vi.fn>;
  setLoopEnabled: ReturnType<typeof vi.fn>;
  stopPlayback: ReturnType<typeof vi.fn>;
};

let storeState: TransportState;

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: TransportState) => unknown) => selector(storeState),
  calculateProjectDuration: () => 100,
}));

function makeState(overrides: Partial<TransportState> = {}): TransportState {
  return {
    tracks: [],
    video: null,
    playheadPosition: 10,
    isPlaying: false,
    loopEnabled: false,
    setPlayheadPosition: vi.fn(),
    setIsPlaying: vi.fn(),
    setLoopEnabled: vi.fn(),
    stopPlayback: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  storeState = makeState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TransportBar accessibility', () => {
  it('labels the transport toggle as Play when paused and toggles playback', () => {
    storeState = makeState({ isPlaying: false });
    render(<TransportBar />);

    const playButton = screen.getByRole('button', { name: 'Play' });
    expect(playButton).toBeInTheDocument();

    fireEvent.click(playButton);
    expect(storeState.setIsPlaying).toHaveBeenCalledWith(true);
  });

  it('labels the transport toggle as Pause when playing', () => {
    storeState = makeState({ isPlaying: true });
    render(<TransportBar />);

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
  });

  it('reflects loop state through aria-pressed', () => {
    storeState = makeState({ loopEnabled: false });
    const { rerender } = render(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'false');

    storeState = makeState({ loopEnabled: true });
    rerender(<TransportBar />);
    expect(screen.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the seek control an accessible name', () => {
    render(<TransportBar />);
    expect(screen.getByRole('button', { name: /seek/i })).toBeInTheDocument();
  });
});
