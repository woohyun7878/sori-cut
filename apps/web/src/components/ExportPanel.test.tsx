import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';

// Shared, mutable state for the FFmpeg mock. Declared via vi.hoisted so it can be
// referenced from the hoisted vi.mock factory below.
const h = vi.hoisted(() => ({
  execCount: 0,
  terminateCount: 0,
  loadCount: 0,
  deleted: [] as string[],
  failLoad: false,
  pendingExec: null as null | { resolve: (code: number) => void; reject: (reason?: unknown) => void },
}));

vi.mock('@ffmpeg/ffmpeg', () => {
  class FFmpeg {
    loaded = false;

    on() {
      // The component subscribes to 'progress'; nothing to record for these tests.
    }

    off() {
      // no-op
    }

    async load() {
      h.loadCount += 1;
      if (h.failLoad) {
        throw new Error('load failed');
      }
      this.loaded = true;
    }

    async writeFile() {
      // no-op virtual FS write
    }

    async readFile() {
      return new Uint8Array([1, 2, 3, 4]);
    }

    async deleteFile(name: string) {
      h.deleted.push(name);
    }

    exec() {
      h.execCount += 1;
      return new Promise<number>((resolve, reject) => {
        h.pendingExec = {
          resolve: (code: number) => {
            h.pendingExec = null;
            resolve(code);
          },
          reject: (reason?: unknown) => {
            h.pendingExec = null;
            reject(reason);
          },
        };
      });
    }

    terminate() {
      h.terminateCount += 1;
      // Real ffmpeg.wasm rejects the in-flight exec when the worker is killed.
      if (h.pendingExec) {
        h.pendingExec.reject(new Error('called FFmpeg.terminate()'));
      }
    }
  }

  return { FFmpeg };
});

vi.mock('@ffmpeg/util', () => ({
  fetchFile: vi.fn(async () => new Uint8Array([0, 1, 2])),
  toBlobURL: vi.fn(async (url: string) => `blob:${url}`),
}));

vi.mock('../lib/audioMixer', () => ({
  mixAudioTracks: vi.fn(async () => ({ length: 100, sampleRate: 44_100, numberOfChannels: 2 })),
  audioBufferToWavBlob: vi.fn(() => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })),
}));

interface MockVideo {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
}

interface StoreState {
  video: MockVideo | null;
  tracks: unknown[];
}

let storeState: StoreState;

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: StoreState) => unknown) => selector(storeState),
  calculateProjectDuration: (_tracks: unknown, video: { duration?: number } | null) =>
    video?.duration ?? 0,
}));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function makeVideo(overrides: Partial<MockVideo> = {}): MockVideo {
  return {
    id: 'video-1',
    name: 'clip.mp4',
    blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'video/mp4' }),
    url: 'blob:clip',
    duration: 30,
    ...overrides,
  };
}

function resolvePendingExec(code: number) {
  if (!h.pendingExec) {
    throw new Error('expected an in-flight FFmpeg.exec');
  }
  h.pendingExec.resolve(code);
}

beforeEach(() => {
  h.execCount = 0;
  h.terminateCount = 0;
  h.loadCount = 0;
  h.deleted = [];
  h.failLoad = false;
  h.pendingExec = null;

  storeState = { video: makeVideo(), tracks: [] };

  URL.createObjectURL = vi.fn(() => 'blob:export-output');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

function startExport() {
  fireEvent.click(screen.getByRole('button', { name: 'Start Export' }));
}

describe('ExportPanel export lifecycle', () => {
  it('runs an export to completion and surfaces a download', async () => {
    render(<ExportPanel />);

    startExport();

    await waitFor(() => expect(h.execCount).toBe(1));

    await act(async () => {
      resolvePendingExec(0);
    });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(screen.getByText('Export complete')).toBeInTheDocument();
    // Scratch files are cleaned up from the FFmpeg FS after a successful run.
    expect(h.deleted.length).toBeGreaterThan(0);
  });

  it('does not start a second pipeline while an export is already running', async () => {
    render(<ExportPanel />);

    const startButton = screen.getByRole('button', { name: 'Start Export' });

    // A rapid second click must not launch a parallel pipeline. Once the first
    // click starts an export the button is disabled, and the isExportingRef
    // guard covers the window before that disabled state is committed.
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    await waitFor(() => expect(h.execCount).toBe(1));

    expect(screen.getByRole('button', { name: 'Exporting...' })).toBeDisabled();

    // Give any erroneously-started second run a chance to reach exec.
    await Promise.resolve();
    expect(h.execCount).toBe(1);
  });

  it('cancels an in-flight export without reporting an error', async () => {
    render(<ExportPanel />);

    startExport();

    await waitFor(() => expect(h.execCount).toBe(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    await waitFor(() => expect(screen.getByText('Export canceled')).toBeInTheDocument());
    expect(h.terminateCount).toBe(1);
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();
    // The Start button is usable again after a cancel.
    expect(screen.getByRole('button', { name: 'Start Export' })).toBeEnabled();
  });

  it('terminates the FFmpeg worker if the panel unmounts mid-export', async () => {
    const { unmount } = render(<ExportPanel />);

    startExport();

    await waitFor(() => expect(h.execCount).toBe(1));

    await act(async () => {
      unmount();
    });

    expect(h.terminateCount).toBe(1);
  });

  it('reports a failure when FFmpeg exits non-zero and re-enables export', async () => {
    render(<ExportPanel />);

    startExport();

    await waitFor(() => expect(h.execCount).toBe(1));

    await act(async () => {
      resolvePendingExec(1);
    });

    await waitFor(() => expect(screen.getByText(/Export failed/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start Export' })).toBeEnabled();
    // A failed run still cleans up its scratch files.
    expect(h.deleted.length).toBeGreaterThan(0);
  });

  it('refuses to export when there is no video loaded', async () => {
    storeState = { video: null, tracks: [] };
    render(<ExportPanel />);

    startExport();

    await waitFor(() =>
      expect(screen.getByText('Upload a video before exporting.')).toBeInTheDocument(),
    );
    expect(h.execCount).toBe(0);
  });
});
