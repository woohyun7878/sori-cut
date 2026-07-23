import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';

/**
 * Deterministic lifecycle tests for the export run-generation model.
 *
 * The FFmpeg worker, `@ffmpeg/util` loaders and the audio mixer are replaced
 * with a stage-gated harness so a test can suspend an export at any awaitable
 * boundary (toBlobURL, load, mix, write, exec, read), then cancel/unmount/
 * restart and assert that a stale run never mutates React state, always
 * terminates its own instance, and never leaks an object URL.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

interface MockInstance {
  id: number;
  loaded: boolean;
  terminated: number;
  gates: Map<string, Deferred[]>;
  progress: ((payload: { progress: number }) => void) | null;
}

interface VideoLike {
  id: string;
  name: string;
  blob: Blob;
  url: string;
  duration: number;
}

const h = vi.hoisted(() => {
  function makeDeferred(): Deferred {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = () => res();
      reject = (reason?: unknown) => rej(reason ?? new Error('rejected'));
    });
    return { promise, resolve, reject };
  }

  const api = {
    makeDeferred,
    instances: [] as MockInstance[],
    globalGates: new Map<string, Deferred[]>(),
    hold: new Set<string>(),
    calls: [] as string[],
    createdUrls: [] as string[],
    createdOutputUrls: [] as string[],
    revokedUrls: [] as string[],
    execCount: 0,
    execExit: 0,
    lastArgs: null as string[] | null,
    coreUrlCounter: 0,
    outputUrlCounter: 0,
    terminateThrowsOnce: false,
    store: { video: null as VideoLike | null, tracks: [] as unknown[] },
    // Suspend a module-level (non-worker) stage — toBlobURL / mix. Terminating
    // the worker must NOT abort these, which is exactly why a canceled run can
    // resume here; tests drive them with releaseGlobal/rejectGlobal.
    globalStage: async (name: string) => {
      api.calls.push(name);
      if (!api.hold.has(name)) {
        return;
      }
      const deferred = makeDeferred();
      const queue = api.globalGates.get(name) ?? [];
      queue.push(deferred);
      api.globalGates.set(name, queue);
      await deferred.promise;
    },
  };

  return api;
});

vi.mock('@ffmpeg/ffmpeg', () => {
  class FFmpeg {
    loaded = false;
    private record: MockInstance;

    constructor() {
      this.record = {
        id: h.instances.length + 1,
        loaded: false,
        terminated: 0,
        gates: new Map(),
        progress: null,
      };
      h.instances.push(this.record);
    }

    on(event: string, handler: (payload: { progress: number }) => void) {
      if (event === 'progress') {
        this.record.progress = handler;
      }
    }

    off() {}

    // Suspend a worker-backed stage. Unlike globalStage these gates ARE rejected
    // by terminate(), modelling a killed worker rejecting its in-flight call.
    private async workerGate(name: string) {
      if (!h.hold.has(name)) {
        return;
      }
      const deferred = h.makeDeferred();
      const queue = this.record.gates.get(name) ?? [];
      queue.push(deferred);
      this.record.gates.set(name, queue);
      await deferred.promise;
    }

    async load() {
      h.calls.push('load');
      await this.workerGate('w:load');
      this.loaded = true;
      this.record.loaded = true;
    }

    async writeFile(name: string, _data?: unknown) {
      const stage = name === 'mixed-audio.wav' ? 'w:write:audio' : 'w:write:input';
      h.calls.push(stage);
      await this.workerGate(stage);
    }

    async exec(args: string[]) {
      h.lastArgs = args;
      h.execCount += 1;
      await this.workerGate('w:exec');
      return h.execExit;
    }

    async readFile(_name?: string) {
      await this.workerGate('w:read');
      return new Uint8Array([1, 2, 3, 4]);
    }

    async deleteFile(_name?: string) {}

    terminate() {
      this.record.terminated += 1;
      if (h.terminateThrowsOnce) {
        h.terminateThrowsOnce = false;
        throw new Error('terminate failed');
      }
      for (const [, queue] of this.record.gates) {
        while (queue.length > 0) {
          const deferred = queue.shift();
          deferred?.reject(new Error('called FFmpeg.terminate()'));
        }
      }
    }
  }

  return { FFmpeg };
});

vi.mock('@ffmpeg/util', () => ({
  fetchFile: vi.fn(async () => {
    await h.globalStage('fetchFile');
    return new Uint8Array([0, 1, 2]);
  }),
  toBlobURL: vi.fn(async (url: string) => {
    const which = url.endsWith('.wasm') ? 'wasm' : 'core';
    await h.globalStage(`toBlobURL:${which}`);
    const objectUrl = `blob:core-${which}-${(h.coreUrlCounter += 1)}`;
    h.createdUrls.push(objectUrl);
    return objectUrl;
  }),
}));

vi.mock('../lib/audioMixer', () => ({
  mixAudioTracks: vi.fn(async () => {
    await h.globalStage('mix');
    return { length: 100, sampleRate: 44100, numberOfChannels: 2 } as unknown as AudioBuffer;
  }),
  audioBufferToWavBlob: vi.fn(() => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })),
}));

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: typeof h.store) => unknown) => selector(h.store),
  calculateProjectDuration: (_tracks: unknown, video: VideoLike | null) => video?.duration ?? 0,
}));

function latestInstance(): MockInstance {
  const instance = h.instances[h.instances.length - 1];
  if (!instance) {
    throw new Error('no FFmpeg instance has been created yet');
  }
  return instance;
}

function pendingGlobal(name: string): number {
  return h.globalGates.get(name)?.length ?? 0;
}

function releaseGlobal(name: string) {
  const deferred = h.globalGates.get(name)?.shift();
  if (!deferred) {
    throw new Error(`no pending global stage: ${name}`);
  }
  deferred.resolve();
}

function rejectGlobal(name: string, error: Error) {
  const deferred = h.globalGates.get(name)?.shift();
  if (!deferred) {
    throw new Error(`no pending global stage: ${name}`);
  }
  deferred.reject(error);
}

function pendingWorker(instance: MockInstance, name: string): number {
  return instance.gates.get(name)?.length ?? 0;
}

function releaseWorker(instance: MockInstance, name: string) {
  const deferred = instance.gates.get(name)?.shift();
  if (!deferred) {
    throw new Error(`no pending worker stage: ${name}`);
  }
  deferred.resolve();
}

function clickStart() {
  fireEvent.click(screen.getByRole('button', { name: 'Start Export' }));
}

function clickCancel() {
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
}

async function startAndReach(opts: { hold: string; kind: 'global' | 'worker' }) {
  h.hold.add(opts.hold);
  const utils = render(<ExportPanel />);
  clickStart();
  if (opts.kind === 'global') {
    await waitFor(() => expect(pendingGlobal(opts.hold)).toBe(1));
  } else {
    await waitFor(() => expect(pendingWorker(latestInstance(), opts.hold)).toBe(1));
  }
  return utils;
}

beforeEach(() => {
  h.instances.length = 0;
  h.globalGates.clear();
  h.hold.clear();
  h.calls.length = 0;
  h.createdUrls.length = 0;
  h.createdOutputUrls.length = 0;
  h.revokedUrls.length = 0;
  h.execCount = 0;
  h.execExit = 0;
  h.lastArgs = null;
  h.coreUrlCounter = 0;
  h.outputUrlCounter = 0;
  h.terminateThrowsOnce = false;
  h.store.tracks = [];
  h.store.video = {
    id: 'v1',
    name: 'clip.mp4',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' }),
    url: 'blob:video',
    duration: 30,
  };

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:output-${(h.outputUrlCounter += 1)}`;
    h.createdOutputUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    h.revokedUrls.push(url);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExportPanel export lifecycle', () => {
  it('runs an export to completion and surfaces a download', async () => {
    h.hold.add('w:exec');
    render(<ExportPanel />);
    clickStart();
    await waitFor(() => expect(pendingWorker(latestInstance(), 'w:exec')).toBe(1));

    await act(async () => {
      releaseWorker(latestInstance(), 'w:exec');
    });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(screen.getByText('Export complete')).toBeInTheDocument();
    // Exactly one private instance, terminated once at run end (no reuse).
    expect(h.instances.length).toBe(1);
    expect(latestInstance().terminated).toBe(1);
    // The core + WASM blob URLs created by toBlobURL are revoked after load.
    expect(h.createdUrls.length).toBe(2);
    expect(h.revokedUrls).toEqual(expect.arrayContaining(h.createdUrls));
    // The published download URL is NOT revoked while it is being offered.
    expect(h.createdOutputUrls.length).toBe(1);
    expect(h.revokedUrls).not.toContain(h.createdOutputUrls[0]);
  });

  it('does not start a second pipeline while a run is active', async () => {
    h.hold.add('w:exec');
    render(<ExportPanel />);
    const button = screen.getByRole('button', { name: 'Start Export' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(h.execCount).toBe(1));
    expect(screen.getByRole('button', { name: 'Exporting...' })).toBeDisabled();
    expect(h.instances.length).toBe(1);
  });

  it('reports a failure when FFmpeg exits non-zero and re-enables export', async () => {
    h.hold.add('w:exec');
    h.execExit = 1;
    render(<ExportPanel />);
    clickStart();
    await waitFor(() => expect(pendingWorker(latestInstance(), 'w:exec')).toBe(1));

    await act(async () => {
      releaseWorker(latestInstance(), 'w:exec');
    });

    await waitFor(() => expect(screen.getByText(/Export failed/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start Export' })).toBeEnabled();
    expect(latestInstance().terminated).toBe(1);
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('refuses to export without a video and never creates a worker', async () => {
    h.store.video = null;
    render(<ExportPanel />);
    clickStart();

    await waitFor(() => expect(screen.getByText('Upload a video before exporting.')).toBeInTheDocument());
    expect(h.instances.length).toBe(0);
  });

  it('rejects export when the project has no authoritative duration', async () => {
    h.store.video = { ...h.store.video!, duration: 0 };
    render(<ExportPanel />);
    clickStart();

    await waitFor(() =>
      expect(screen.getByText(/Cannot export: the project has no known duration/)).toBeInTheDocument(),
    );
    // No worker spun up and the encode never ran, so -shortest cannot truncate.
    expect(h.instances.length).toBe(0);
    expect(h.execCount).toBe(0);
  });
});

describe('ExportPanel cancellation and unmount teardown', () => {
  const stages = [
    ['toBlobURL:wasm', 'global'],
    ['mix', 'global'],
    ['w:load', 'worker'],
    ['w:write:input', 'worker'],
    ['w:exec', 'worker'],
    ['w:read', 'worker'],
  ] as const;

  it.each(stages)('cancels cleanly while suspended at %s', async (stage, kind) => {
    await startAndReach({ hold: stage, kind });
    const instance = latestInstance();

    await act(async () => {
      clickCancel();
    });
    // A suspended non-worker stage resolves after cancel; the stale run must bail.
    if (kind === 'global') {
      await act(async () => {
        releaseGlobal(stage);
      });
    }

    await waitFor(() => expect(screen.getByText('Export canceled')).toBeInTheDocument());
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    expect(instance.terminated).toBeGreaterThanOrEqual(1);
    // Every core/WASM URL created so far is revoked — none leak on cancel.
    await waitFor(() => {
      expect(h.createdUrls.length).toBeGreaterThan(0);
      expect(h.revokedUrls).toEqual(expect.arrayContaining(h.createdUrls));
    });
  });

  it.each(stages)('terminates the worker when unmounted while suspended at %s', async (stage, kind) => {
    const utils = await startAndReach({ hold: stage, kind });
    const instance = latestInstance();

    await act(async () => {
      utils.unmount();
    });
    if (kind === 'global') {
      await act(async () => {
        releaseGlobal(stage);
      });
    }

    expect(instance.terminated).toBeGreaterThanOrEqual(1);
    // No state was published by the unmounted run.
    expect(h.createdOutputUrls.length).toBe(0);
    await waitFor(() => {
      expect(h.createdUrls.length).toBeGreaterThan(0);
      expect(h.revokedUrls).toEqual(expect.arrayContaining(h.createdUrls));
    });
  });
});

describe('ExportPanel stale-run isolation', () => {
  it('isolates a canceled run from an immediate restart (stale completion ordering)', async () => {
    h.hold.add('mix');
    render(<ExportPanel />);

    // Run A suspends at mix, then is canceled.
    clickStart();
    await waitFor(() => expect(pendingGlobal('mix')).toBe(1));
    const instanceA = latestInstance();
    await act(async () => {
      clickCancel();
    });

    // Run B starts immediately while A is still suspended at mix.
    await act(async () => {
      clickStart();
    });
    await waitFor(() => expect(h.instances.length).toBe(2));
    await waitFor(() => expect(pendingGlobal('mix')).toBe(2));
    const instanceB = latestInstance();
    expect(instanceB).not.toBe(instanceA);

    // Stale completion: A's mix resolves first (FIFO) and must not touch state.
    await act(async () => {
      releaseGlobal('mix');
    });
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();

    // B's mix resolves and B runs to a clean completion.
    await act(async () => {
      releaseGlobal('mix');
    });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();
    expect(instanceA.terminated).toBeGreaterThanOrEqual(1);
    expect(instanceB.terminated).toBe(1);
  });

  it('swallows a stale run rejection without disturbing the active run', async () => {
    h.hold.add('mix');
    render(<ExportPanel />);

    clickStart();
    await waitFor(() => expect(pendingGlobal('mix')).toBe(1));
    await act(async () => {
      clickCancel();
    });

    await act(async () => {
      clickStart();
    });
    await waitFor(() => expect(h.instances.length).toBe(2));
    await waitFor(() => expect(pendingGlobal('mix')).toBe(2));

    // Stale rejection: A's suspended mix rejects after B took over.
    await act(async () => {
      rejectGlobal('mix', new Error('stale mix failure'));
    });
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();

    // B is unaffected and completes cleanly.
    await act(async () => {
      releaseGlobal('mix');
    });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();
  });

  it('allows a new export after the previous run failed to terminate', async () => {
    h.hold.add('w:exec');
    render(<ExportPanel />);

    clickStart();
    await waitFor(() => expect(pendingWorker(latestInstance(), 'w:exec')).toBe(1));
    // The teardown terminate() throws, but must not block the download or guard.
    h.terminateThrowsOnce = true;
    await act(async () => {
      releaseWorker(latestInstance(), 'w:exec');
    });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(latestInstance().terminated).toBe(1);

    // A fresh export still works after the cleanup failure.
    h.hold.delete('w:exec');
    await act(async () => {
      clickStart();
    });
    await waitFor(() => expect(h.instances.length).toBe(2));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument());
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument();
  });
});
