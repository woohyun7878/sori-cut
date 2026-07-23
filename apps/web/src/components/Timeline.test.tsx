import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';

// Mock ClipWaveform to avoid fetch attempts on blob URLs in test environment
vi.mock('./ClipWaveform', () => ({
  ClipWaveform: () => null,
}));

// Stub pointer capture methods not available in jsdom
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = vi.fn();
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = vi.fn();
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
}

const storeState = {
  tracks: [] as Array<{
    id: string;
    name: string;
    type: string;
    sourceUrl: string;
    startOffset: number;
    duration: number;
    sourceStartOffset: number;
    muted: boolean;
    volume: number;
  }>,
  stems: [],
  video: null,
  playheadPosition: 0,
  isPlaying: false,
  selectedTrackId: null,
  addTrack: vi.fn(),
  setPlayheadPosition: vi.fn(),
  removeTrack: vi.fn(),
  setSelectedTrack: vi.fn(),
  splitTrackAtPosition: vi.fn(),
  trimTrack: vi.fn(),
  toggleTrackMute: vi.fn(),
  toggleStemSolo: vi.fn(),
  setTrackVolume: vi.fn(),
};

vi.mock('../store/useProjectStore', () => ({
  calculateProjectDuration: () => 10,
  useProjectStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

describe('Timeline controls', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    storeState.tracks = [];
  });

  it('toggles the magnetic snap indicator and updates zoom', () => {
    render(<Timeline />);

    const snap = screen.getByRole('button', { name: /Snap/ });
    expect(snap).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(snap);
    expect(snap).toHaveAttribute('aria-pressed', 'false');

    expect(screen.getByLabelText('Timeline zoom 64 pixels per second')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByLabelText('Timeline zoom 80 pixels per second')).toBeInTheDocument();
  });

  it('adds the selected track type from the compact toolbar', () => {
    render(<Timeline />);

    fireEvent.change(screen.getByRole('combobox', { name: 'New track type' }), {
      target: { value: 'recording' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Track' }));

    expect(storeState.addTrack).toHaveBeenCalledWith({ type: 'recording' });
  });
});

describe('Timeline trim gesture lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    storeState.tracks = [];
  });

  function renderWithTrack() {
    storeState.tracks = [
      {
        id: 'trk-1',
        name: 'Audio',
        type: 'audio',
        sourceUrl: 'blob:audio',
        startOffset: 2,
        duration: 8,
        sourceStartOffset: 2,
        muted: false,
        volume: 1,
      },
    ];
    const result = render(<Timeline />);
    return result;
  }

  function getTrimHandle(side: 'left' | 'right') {
    // The clip's aria-label includes "audio clip" — match that specifically
    const clip = screen.getByRole('button', { name: /audio clip/ });
    const handles = clip.querySelectorAll('[class*="cursor-col-resize"]');
    return side === 'left' ? handles[0] : handles[1];
  }

  it('click-without-drag does not call trimTrack (no undo pollution)', () => {
    renderWithTrack();
    const handle = getTrimHandle('left');

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    // Immediately release — no movement
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });

    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('pointercancel discards gesture without committing', () => {
    renderWithTrack();
    const handle = getTrimHandle('right');

    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 250 });
    // Cancel the gesture (e.g., browser intervention)
    fireEvent.pointerCancel(window, { pointerId: 2 });

    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('blur discards gesture without committing', () => {
    renderWithTrack();
    const handle = getTrimHandle('left');

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 180 });
    // Window loses focus
    fireEvent.blur(window);

    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('unmount discards gesture without committing', () => {
    const { unmount } = renderWithTrack();
    const handle = getTrimHandle('left');

    fireEvent.pointerDown(handle, { pointerId: 4, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 150 });
    // Component unmounts mid-drag
    unmount();

    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('commits on pointerup with material movement', () => {
    renderWithTrack();
    const handle = getTrimHandle('right');

    fireEvent.pointerDown(handle, { pointerId: 5, clientX: 200 });
    // Move significantly (64px/s zoom → 50px = ~0.78s)
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 150 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 150 });

    expect(storeState.trimTrack).toHaveBeenCalledTimes(1);
  });

  it('multiple finalizer events produce at most one commit', () => {
    renderWithTrack();
    const handle = getTrimHandle('left');

    fireEvent.pointerDown(handle, { pointerId: 6, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 250 });

    // Fire multiple finalizer events
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 250 });
    fireEvent.pointerCancel(window, { pointerId: 6 });
    fireEvent.blur(window);

    // Only one commit (from pointerup), rest are no-ops
    expect(storeState.trimTrack).toHaveBeenCalledTimes(1);
  });

  it('zero-delta pointerup (snap rounds to same position) does not commit', () => {
    // Disable snap to get a clean test — move 0 pixels exactly
    renderWithTrack();

    // Disable snap first
    fireEvent.click(screen.getByRole('button', { name: /Snap/ }));

    const handle = getTrimHandle('right');
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 400 });
    // pointerUp at SAME position — no movement at all, preview stays null
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 400 });

    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('discards when track is removed during drag', () => {
    const { rerender } = renderWithTrack();
    const handle = getTrimHandle('left');

    fireEvent.pointerDown(handle, { pointerId: 8, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 150 });

    // Track disappears (simulating removal)
    storeState.tracks = [];
    rerender(<Timeline />);

    // Gesture should have been cancelled
    // Trying to complete doesn't call trimTrack
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 150 });
    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });

  it('discards when source URL changes during drag (video replacement)', () => {
    const { rerender } = renderWithTrack();
    const handle = getTrimHandle('right');

    fireEvent.pointerDown(handle, { pointerId: 9, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 250 });

    // Source URL changes (video replaced with same track ID)
    storeState.tracks = [{ ...storeState.tracks[0], sourceUrl: 'blob:new-video' }];
    rerender(<Timeline />);

    // Gesture should have been cancelled
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 250 });
    expect(storeState.trimTrack).not.toHaveBeenCalled();
  });
});
