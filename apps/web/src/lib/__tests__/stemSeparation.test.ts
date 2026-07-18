import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { separateStems } from '../stemSeparation';

/**
 * Mock Worker that simulates the stem separation worker's message protocol.
 */
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  private terminated = false;

  postMessage(msg: unknown) {
    if (this.terminated) return;

    const data = msg as { type: string; channelData: Float32Array[]; sampleRate: number };

    if (data.type === 'separate') {
      // Simulate async worker processing
      setTimeout(() => {
        if (this.terminated) return;

        // Send progress updates
        this.onmessage?.({ data: { type: 'progress', progress: 0 } } as MessageEvent);
        this.onmessage?.({ data: { type: 'progress', progress: 50 } } as MessageEvent);
        this.onmessage?.({ data: { type: 'progress', progress: 100 } } as MessageEvent);

        // Build fake stem results
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

/**
 * MockWorker variant that simulates a worker error.
 */
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

// Mock the Worker constructor globally
vi.stubGlobal('Worker', MockWorker);

// Mock URL.createObjectURL without overwriting the URL constructor
const originalURL = globalThis.URL;
vi.stubGlobal('URL', class extends originalURL {
  static createObjectURL = () => 'blob:mock-stem-url';
  static revokeObjectURL = vi.fn();
});

function createMockAudioBuffer(length = 4410): AudioBuffer {
  const channelData = new Float32Array(length);
  for (let i = 0; i < channelData.length; i++) {
    channelData[i] = Math.sin(i * 0.1) * 0.5;
  }

  return {
    numberOfChannels: 1,
    length,
    sampleRate: 44100,
    duration: length / 44100,
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

  it('returns 4 stems', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    expect(stems).toHaveLength(4);
  });

  it('returns stems with correct names', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    const names = stems.map((s) => s.name);
    expect(names).toContain('vocals');
    expect(names).toContain('drums');
    expect(names).toContain('bass');
    expect(names).toContain('guitar');
  });

  it('returns stems with English labels', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    const labels = stems.map((s) => s.label);
    expect(labels).toContain('Vocals');
    expect(labels).toContain('Drums');
    expect(labels).toContain('Bass');
    expect(labels).toContain('Guitar');
  });

  it('each stem has a blob and url', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    for (const stem of stems) {
      expect(stem.blob).toBeInstanceOf(Blob);
      expect(stem.url).toBeTruthy();
    }
  });

  it('calls onProgress callback', async () => {
    const audioBuffer = createMockAudioBuffer();
    const onProgress = vi.fn();
    await separateStems(audioBuffer, onProgress);
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(0);
  });

  it('progress reaches 100', async () => {
    const audioBuffer = createMockAudioBuffer();
    const progressValues: number[] = [];
    await separateStems(audioBuffer, (p) => progressValues.push(p));
    expect(progressValues).toContain(100);
  });

  it('stems have wav blob type', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    for (const stem of stems) {
      expect(stem.blob.type).toBe('audio/wav');
    }
  });

  it('supports custom model URL via options', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer, undefined, {
      modelUrl: '/custom/model.onnx',
    });
    expect(stems).toHaveLength(4);
  });

  it('rejects when worker reports an error', async () => {
    vi.stubGlobal('Worker', MockWorkerError);
    const audioBuffer = createMockAudioBuffer();

    await expect(separateStems(audioBuffer)).rejects.toThrow('Model inference failed');
  });

  it('terminates worker after completion', async () => {
    const terminateSpy = vi.fn();
    class SpyWorker extends MockWorker {
      override terminate() {
        terminateSpy();
        super.terminate();
      }
    }
    vi.stubGlobal('Worker', SpyWorker);

    const audioBuffer = createMockAudioBuffer();
    await separateStems(audioBuffer);
    expect(terminateSpy).toHaveBeenCalledOnce();
  });
});
