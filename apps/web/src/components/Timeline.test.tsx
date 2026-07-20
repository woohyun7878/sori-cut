import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';

const storeState = {
  tracks: [],
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
  useProjectStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

describe('Timeline controls', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
