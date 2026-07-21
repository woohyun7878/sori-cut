import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncTrackUpdate } from '../lib/syncAlignment';
import type { TimelineTrack } from '../store/useProjectStore';
import { SyncControls } from './SyncControls';

const { computeAutoSyncOffsetMock } = vi.hoisted(() => ({
  computeAutoSyncOffsetMock: vi.fn(),
}));

vi.mock('../lib/autoSync', () => ({
  AUTO_SYNC_MAX_LAG_SECONDS: 10,
  computeAutoSyncOffset: computeAutoSyncOffsetMock,
}));

let track: TimelineTrack;
let storeState: {
  video: { url: string } | null;
  tracks: TimelineTrack[];
  updateTrack: ReturnType<typeof vi.fn>;
};

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

function makeTrack(overrides: Partial<TimelineTrack> = {}): TimelineTrack {
  return {
    id: 'audio-1',
    name: 'Voice',
    type: 'recording',
    sourceUrl: 'blob:voice',
    startOffset: 0,
    sourceStartOffset: 0,
    duration: 20,
    syncOffset: 0,
    muted: false,
    volume: 1,
    ...overrides,
  };
}

beforeEach(() => {
  track = makeTrack();
  storeState = {
    video: { url: 'blob:video' },
    tracks: [track],
    updateTrack: vi.fn((_id: string, updates: Partial<TimelineTrack>) => {
      Object.assign(track, updates);
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('createSyncTrackUpdate', () => {
  it('maps the +/-10 second boundaries to timeline delay or source trim', () => {
    expect(createSyncTrackUpdate(track, 10)).toMatchObject({
      startOffset: 10,
      sourceStartOffset: 0,
      duration: 20,
      syncOffset: 10,
    });
    expect(createSyncTrackUpdate(track, -10)).toMatchObject({
      startOffset: 0,
      sourceStartOffset: 10,
      duration: 10,
      syncOffset: -10,
    });
  });

  it('uses the persisted baseline so repeated applies never accumulate source trim', () => {
    const first = createSyncTrackUpdate(track, -4);
    const syncedTrack = { ...track, ...first };

    expect(createSyncTrackUpdate(syncedTrack, -4)).toEqual(first);
    expect(createSyncTrackUpdate(syncedTrack, -1)).toMatchObject({
      startOffset: 0,
      sourceStartOffset: 1,
      duration: 19,
      syncOffset: -1,
    });
    expect(createSyncTrackUpdate(syncedTrack, 3)).toMatchObject({
      startOffset: 3,
      sourceStartOffset: 0,
      duration: 20,
      syncOffset: 3,
    });
  });

  it('preserves post-sync trim and split displacement for same and new positive offsets', () => {
    const initiallySynced = { ...track, ...createSyncTrackUpdate(track, 3) };
    const trimmedAfterSync = {
      ...initiallySynced,
      startOffset: 5,
      sourceStartOffset: 2,
      duration: 18,
    };
    expect(createSyncTrackUpdate(trimmedAfterSync, 3)).toMatchObject({
      startOffset: 5,
      sourceStartOffset: 2,
      duration: 18,
      syncOffset: 3,
    });
    expect(createSyncTrackUpdate(trimmedAfterSync, 5)).toMatchObject({
      startOffset: 7,
      sourceStartOffset: 2,
      duration: 18,
      syncOffset: 5,
    });

    const splitAfterSync = {
      ...initiallySynced,
      startOffset: 8,
      sourceStartOffset: 5,
      duration: 7,
    };
    expect(createSyncTrackUpdate(splitAfterSync, 3)).toMatchObject({
      startOffset: 8,
      sourceStartOffset: 5,
      duration: 7,
      syncOffset: 3,
    });
    expect(createSyncTrackUpdate(splitAfterSync, 1)).toMatchObject({
      startOffset: 6,
      sourceStartOffset: 5,
      duration: 7,
      syncOffset: 1,
    });
  });

  it('preserves existing source trims and derived clip placement', () => {
    const trimmedTrack = makeTrack({
      startOffset: 2,
      sourceStartOffset: 2,
      syncOffset: 0,
      syncBaseSourceStartOffset: 2,
      syncBaseDuration: 20,
    });
    expect(createSyncTrackUpdate(trimmedTrack, -4)).toMatchObject({
      startOffset: 2,
      sourceStartOffset: 6,
      duration: 16,
      syncOffset: -4,
    });
    expect(createSyncTrackUpdate(trimmedTrack, 3)).toMatchObject({
      startOffset: 5,
      sourceStartOffset: 2,
      duration: 20,
      syncOffset: 3,
    });

    const splitTrack = makeTrack({
      startOffset: 6,
      sourceStartOffset: 4,
      duration: 6,
      syncOffset: 2,
      syncBaseSourceStartOffset: 4,
      syncBaseDuration: 6,
    });
    expect(createSyncTrackUpdate(splitTrack, 2)).toMatchObject({
      startOffset: 6,
      sourceStartOffset: 4,
      duration: 6,
      syncOffset: 2,
    });
  });

  it('rejects offsets outside the analyzer range or beyond available source media', () => {
    expect(() => createSyncTrackUpdate(track, 10.01)).toThrow('between -10 and +10');
    expect(() => createSyncTrackUpdate(makeTrack({ duration: 4 }), -4)).toThrow(
      'available source duration',
    );
  });

  it('preserves valid sub-0.5-second split clips when no source trim is needed', () => {
    expect(
      createSyncTrackUpdate(
        makeTrack({
          startOffset: 2,
          sourceStartOffset: 2,
          duration: 0.2,
          syncOffset: 0,
          syncBaseSourceStartOffset: 2,
          syncBaseDuration: 0.2,
        }),
        1,
      ),
    ).toMatchObject({
      startOffset: 3,
      sourceStartOffset: 2,
      duration: 0.2,
      syncOffset: 1,
    });
  });
});

describe('SyncControls', () => {
  it.each([
    {
      name: 'positive',
      offset: 6,
      expected: { startOffset: 6, sourceStartOffset: 0, duration: 20, syncOffset: 6 },
    },
    {
      name: 'negative',
      offset: -6,
      expected: { startOffset: 0, sourceStartOffset: 6, duration: 14, syncOffset: -6 },
    },
  ])('persists a $name auto-sync result exactly', async ({ offset, expected }) => {
    computeAutoSyncOffsetMock.mockResolvedValue({ offsetSeconds: offset, confidence: 0.9 });
    render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));

    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));

    await waitFor(() => {
      expect(storeState.updateTrack).toHaveBeenCalledWith(
        track.id,
        expect.objectContaining(expected),
      );
    });
    expect(screen.getByRole('status')).toHaveTextContent(`${offset.toFixed(2)}s offset`);
  });

  it('uses the same signed mapping for manual Apply Offset', async () => {
    render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));

    fireEvent.change(screen.getByLabelText('Precise offset'), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Offset' }));

    expect(storeState.updateTrack).toHaveBeenCalledWith(
      track.id,
      expect.objectContaining({
        startOffset: 0,
        sourceStartOffset: 3,
        duration: 17,
        syncOffset: -3,
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Offset applied to timeline.');
  });

  it('shows the full analyzer range without silently applying low-confidence suggestions', async () => {
    computeAutoSyncOffsetMock.mockResolvedValue({ offsetSeconds: -10, confidence: 0.05 });
    render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));

    expect(screen.getByLabelText('Precise offset')).toHaveAttribute('min', '-10');
    expect(screen.getByLabelText('Precise offset')).toHaveAttribute('max', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));

    await waitFor(() => expect(screen.getByLabelText('Precise offset')).toHaveValue(-10));
    expect(storeState.updateTrack).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('confidence is low');
  });

  it('applies analysis to fresh clip timing when the track is edited mid-analysis', async () => {
    let resolveAnalysis!: (result: { offsetSeconds: number; confidence: number }) => void;
    computeAutoSyncOffsetMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAnalysis = resolve;
      }),
    );
    const { rerender } = render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));
    await waitFor(() => expect(computeAutoSyncOffsetMock).toHaveBeenCalledOnce());

    track = makeTrack({
      startOffset: 2,
      sourceStartOffset: 2,
      duration: 18,
      syncOffset: 0,
      syncBaseSourceStartOffset: 2,
      syncBaseDuration: 18,
    });
    storeState.tracks = [track];
    rerender(<SyncControls />);
    resolveAnalysis({ offsetSeconds: -4, confidence: 0.9 });

    await waitFor(() => {
      expect(storeState.updateTrack).toHaveBeenCalledWith(
        track.id,
        expect.objectContaining({
          startOffset: 2,
          sourceStartOffset: 6,
          duration: 14,
          syncOffset: -4,
        }),
      );
    });
  });

  it('does not apply analysis when the reference video changes', async () => {
    let resolveAnalysis!: (result: { offsetSeconds: number; confidence: number }) => void;
    computeAutoSyncOffsetMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAnalysis = resolve;
      }),
    );
    const { rerender } = render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));
    await waitFor(() => expect(computeAutoSyncOffsetMock).toHaveBeenCalledOnce());

    storeState.video = { url: 'blob:replacement-video' };
    rerender(<SyncControls />);
    resolveAnalysis({ offsetSeconds: 2, confidence: 0.9 });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'The reference or target changed during auto-sync',
      );
    });
    expect(storeState.updateTrack).not.toHaveBeenCalled();
  });

  it('does not apply analysis when a stable target ID points to replacement media', async () => {
    let resolveAnalysis!: (result: { offsetSeconds: number; confidence: number }) => void;
    computeAutoSyncOffsetMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAnalysis = resolve;
      }),
    );
    const { rerender } = render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));
    await waitFor(() => expect(computeAutoSyncOffsetMock).toHaveBeenCalledOnce());

    track = makeTrack({ sourceUrl: 'blob:replacement-voice' });
    storeState.tracks = [track];
    rerender(<SyncControls />);
    resolveAnalysis({ offsetSeconds: 2, confidence: 0.9 });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'The reference or target changed during auto-sync',
      );
    });
    expect(storeState.updateTrack).not.toHaveBeenCalled();
  });

  it('does not apply analysis after the user selects another target', async () => {
    let resolveAnalysis!: (result: { offsetSeconds: number; confidence: number }) => void;
    computeAutoSyncOffsetMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAnalysis = resolve;
      }),
    );
    const secondTrack = makeTrack({
      id: 'audio-2',
      name: 'Harmony',
      sourceUrl: 'blob:harmony',
    });
    storeState.tracks = [track, secondTrack];
    render(<SyncControls />);
    await waitFor(() => expect(screen.getByLabelText('Target track')).toHaveValue(track.id));
    fireEvent.click(screen.getByRole('button', { name: 'Auto Sync' }));
    await waitFor(() => expect(computeAutoSyncOffsetMock).toHaveBeenCalledOnce());

    fireEvent.change(screen.getByLabelText('Target track'), {
      target: { value: secondTrack.id },
    });
    resolveAnalysis({ offsetSeconds: 2, confidence: 0.9 });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'The reference or target changed during auto-sync',
      );
    });
    expect(storeState.updateTrack).not.toHaveBeenCalled();
  });
});
