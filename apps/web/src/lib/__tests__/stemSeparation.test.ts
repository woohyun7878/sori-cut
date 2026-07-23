import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { separateStems } from '../stemSeparation';

// ─── Mock Worker helpers ───────────────────────────────────────────────────

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(msg: unknown) {
    if (this.terminated) return;
    const data = msg as { type: string; channelData: Float32Array[]; sampleRate: number };

    if (data.type === 'separate') {
      setTimeout(() => {
        if (this.terminated) return;
        this.onmessage?.({ data: { type: 'progress', progress: 0 } } as MessageEvent);
        this.onmessage?.({ data: { type: 'progress', progress: 50 } } as MessageEvent);
        this.onmessage?.({ data: { type: 'progress', progress: 100 } } as MessageEvent);

        const length = data.channelData[0]?.length ?? 4410;
        const stems = [
          { name: 'vocals', label: 'Vocals', channelData: [new Float32Array(length)] },
          { name: 'drums', label: 'Drums', channelData: [new Float32Array(length)] },
          { name: 'bass', label: 'Bass', channelData: [new Float32Array(length)] },
          { name: 'guitar', label: 'Guitar', channelData: [new Float32Array(length)] },
        ];
        this.onmessage?.({ data: { type: 'result', stems } } as MessageEvent);
      }, 0);
    }
  }

  terminate() {
    this.terminated = true;
  }
}

class MockWorkerError {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(msg: unknown) {
    const data = msg as { type: string };
    if (data.type === 'separate') {
      setTimeout(() => {
        this.onmessage?.({
          data: { type: 'error', message: 'Model inference failed' },
        } as MessageEvent);
      }, 0);
    }
  }

  terminate() {}
}

/** Worker that never responds — for timeout testing. */
class MockWorkerHanging {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

// ─── Global mocks ───────────────────────────────────────────────────────────

const originalURL = globalThis.URL;
vi.stubGlobal('URL', class extends originalURL {
  static createObjectURL = () => 'blob:mock-stem-url';
  static revokeObjectURL = vi.fn();
});

vi.stubGlobal('Worker', MockWorker);

function createMockAudioBuffer(opts: { length?: number; channels?: number; sampleRate?: number; duration?: number } = {}): AudioBuffer {
  const length = opts.length ?? 4410;
  const channels = opts.channels ?? 1;
  const sampleRate = opts.sampleRate ?? 44100;
  const duration = opts.duration ?? length / sampleRate;
  const channelData = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    channelData[i] = Math.sin(i * 0.1) * 0.5;
  }

  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration,
    getChannelData: () => channelData,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

describe('separateStems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Happy-path tests ───

  it('returns 4 stems', async () => {
    const stems = await separateStems(createMockAudioBuffer());
    expect(stems).toHaveLength(4);
  });

  it('returns stems with correct names', async () => {
    const stems = await separateStems(createMockAudioBuffer());
    expect(stems.map(s => s.name)).toEqual(['vocals', 'drums', 'bass', 'guitar']);
  });

  it('returns stems with English labels', async () => {
    const stems = await separateStems(createMockAudioBuffer());
    expect(stems.map(s => s.label)).toEqual(['Vocals', 'Drums', 'Bass', 'Guitar']);
  });

  it('each stem has a blob and url', async () => {
    const stems = await separateStems(createMockAudioBuffer());
    for (const stem of stems) {
      expect(stem.blob).toBeInstanceOf(Blob);
      expect(stem.url).toBeTruthy();
    }
  });

  it('calls onProgress callback with 0 immediately', async () => {
    const onProgress = vi.fn();
    const p = separateStems(createMockAudioBuffer(), onProgress);
    expect(onProgress).toHaveBeenCalledWith(0);
    await p;
  });

  it('progress reaches 100', async () => {
    const values: number[] = [];
    await separateStems(createMockAudioBuffer(), (v) => values.push(v));
    expect(values).toContain(100);
  });

  it('stems have wav blob type', async () => {
    const stems = await separateStems(createMockAudioBuffer());
    for (const stem of stems) {
      expect(stem.blob.type).toBe('audio/wav');
    }
  });

  it('supports custom model URL via options', async () => {
    const stems = await separateStems(createMockAudioBuffer(), undefined, { modelUrl: '/custom/model.onnx' });
    expect(stems).toHaveLength(4);
  });

  // ─── Error handling ───

  it('rejects when worker reports an error', async () => {
    vi.stubGlobal('Worker', MockWorkerError);
    await expect(separateStems(createMockAudioBuffer())).rejects.toThrow('Model inference failed');
  });

  it('terminates worker after success', async () => {
    const terminateSpy = vi.fn();
    class SpyWorker extends MockWorker {
      override terminate() { terminateSpy(); super.terminate(); }
    }
    vi.stubGlobal('Worker', SpyWorker);
    await separateStems(createMockAudioBuffer());
    expect(terminateSpy).toHaveBeenCalledOnce();
  });

  it('terminates worker after error', async () => {
    const terminateSpy = vi.fn();
    class SpyWorkerErr extends MockWorkerError {
      override terminate() { terminateSpy(); super.terminate(); }
    }
    vi.stubGlobal('Worker', SpyWorkerErr);
    await expect(separateStems(createMockAudioBuffer())).rejects.toThrow();
    expect(terminateSpy).toHaveBeenCalledOnce();
  });

  it('revokes already-created URLs and rejects if building a stem fails partway', async () => {
    const savedURL = globalThis.URL;
    let created = 0;
    const revoked: string[] = [];

    vi.stubGlobal('URL', class extends originalURL {
      static createObjectURL = () => {
        created += 1;
        if (created === 3) throw new Error('createObjectURL failed');
        return `blob:mock-stem-${created}`;
      };
      static revokeObjectURL = (url: string) => { revoked.push(url); };
    });

    await expect(separateStems(createMockAudioBuffer())).rejects.toThrow('createObjectURL failed');
    expect(revoked).toEqual(['blob:mock-stem-1', 'blob:mock-stem-2']);
    vi.stubGlobal('URL', savedURL);
  });

  // ─── Input validation ───

  it('rejects empty audio buffer', async () => {
    const buf = createMockAudioBuffer({ length: 0 });
    await expect(separateStems(buf)).rejects.toThrow(/empty or invalid/i);
  });

  it('rejects too many channels', async () => {
    const buf = createMockAudioBuffer({ channels: 8 });
    await expect(separateStems(buf)).rejects.toThrow(/too many channels/i);
  });

  it('rejects audio longer than max duration', async () => {
    const buf = createMockAudioBuffer({ duration: 700, length: 44100 });
    await expect(separateStems(buf)).rejects.toThrow(/too long/i);
  });

  it('rejects invalid sample rate', async () => {
    const buf = createMockAudioBuffer({ sampleRate: -1, duration: 0.1 });
    await expect(separateStems(buf)).rejects.toThrow(/sample rate/i);
  });

  // ─── Cancellation ───

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      separateStems(createMockAudioBuffer(), undefined, { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
  });

  it('rejects and terminates worker when signal fires mid-processing', async () => {
    const terminateSpy = vi.fn();
    class SlowWorker extends MockWorker {
      override terminate() { terminateSpy(); super.terminate(); }
      override postMessage() { /* never respond */ }
    }
    vi.stubGlobal('Worker', SlowWorker);

    const controller = new AbortController();
    const p = separateStems(createMockAudioBuffer(), undefined, { signal: controller.signal });
    controller.abort();

    await expect(p).rejects.toThrow(/cancelled/i);
    expect(terminateSpy).toHaveBeenCalled();
  });

  // ─── Timeout ───

  it('rejects with timeout error when worker hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', MockWorkerHanging);
    const p = separateStems(createMockAudioBuffer(), undefined, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });

  it('does not timeout when timeoutMs is 0', async () => {
    const stems = await separateStems(createMockAudioBuffer(), undefined, { timeoutMs: 0 });
    expect(stems).toHaveLength(4);
  });
});
