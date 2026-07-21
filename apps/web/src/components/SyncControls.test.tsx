import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncControls } from './SyncControls';

const mocks = vi.hoisted(() => ({
  computeAutoSyncOffset: vi.fn(),
  updateTrack: vi.fn(),
}));

const selectedTrack = {
  id: 'track-1',
  name: 'Recording',
  type: 'recording' as const,
  sourceUrl: 'blob:track',
  startOffset: 0,
  duration: 30,
  sourceStartOffset: 1.5,
  syncOffset: 0,
  muted: false,
  volume: 1,
};

const video = {
  id: 'video',
  name: 'Video',
  blob: new Blob(),
  url: 'blob:video',
  duration: 30,
};

const storeState: {
  video: typeof video;
  tracks: (typeof selectedTrack)[];
  updateTrack: typeof mocks.updateTrack;
} = {
  video,
  tracks: [selectedTrack],
  updateTrack: mocks.updateTrack,
};

vi.mock('../lib/autoSync', () => ({
  computeAutoSyncOffset: mocks.computeAutoSyncOffset,
}));

vi.mock('../store/useProjectStore', () => {
  const useProjectStore = (selector: (state: typeof storeState) => unknown) =>
    selector(storeState);
  useProjectStore.getState = () => storeState;
  return { useProjectStore };
});

describe('SyncControls offset application', () => {
  beforeEach(() => {
    mocks.computeAutoSyncOffset.mockReset();
    mocks.updateTrack.mockReset();
    storeState.tracks = [selectedTrack];
  });

  afterEach(cleanup);

  it('uses the signed mapping for manual apply', () => {
    render(<SyncControls />);

    fireEvent.change(screen.getByLabelText('Precise offset'), {
      target: { value: '-2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Offset' }));

    expect(mocks.updateTrack).toHaveBeenCalledWith('track-1', {
      startOffset: 0,
      sourceStartOffset: 4,
      syncOffset: -2.5,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Applied -2.50s offset');
  });

  it('persists the exact high-confidence auto-sync suggestion', async () => {
    mocks.computeAutoSyncOffset.mockResolvedValue({
      offsetSeconds: 10,
      confidence: 0.93,
    });
    render(<SyncControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));

    await waitFor(() => {
      expect(mocks.updateTrack).toHaveBeenCalledWith('track-1', {
        startOffset: 10,
        sourceStartOffset: 1.5,
        syncOffset: 10,
      });
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Auto sync done: 10.00s offset (93% confidence)',
    );
  });

  it('preserves source trim changed while auto-sync is analyzing', async () => {
    let finishAnalysis!: (result: { offsetSeconds: number; confidence: number }) => void;
    mocks.computeAutoSyncOffset.mockReturnValue(
      new Promise((resolve) => {
        finishAnalysis = resolve;
      }),
    );
    render(<SyncControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));
    storeState.tracks = [{ ...selectedTrack, sourceStartOffset: 3 }];
    finishAnalysis({ offsetSeconds: -2, confidence: 0.9 });

    await waitFor(() => {
      expect(mocks.updateTrack).toHaveBeenCalledWith('track-1', {
        startOffset: 0,
        sourceStartOffset: 5,
        syncOffset: -2,
      });
    });
  });
});
