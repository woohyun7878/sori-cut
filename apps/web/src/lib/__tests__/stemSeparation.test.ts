import { describe, it, expect, vi, beforeEach } from 'vitest';
import { separateStems } from '../stemSeparation';

// Mock OfflineAudioContext
class MockAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  connect = vi.fn();
  start = vi.fn();
}

class MockBiquadFilterNode {
  type = '';
  frequency = { value: 0 };
  connect = vi.fn();
}

class MockGainNode {
  gain = { value: 1 };
  connect = vi.fn();
}

function createMockAudioBuffer(): AudioBuffer {
  const channelData = new Float32Array(4410);
  for (let i = 0; i < channelData.length; i++) {
    channelData[i] = Math.sin(i * 0.1) * 0.5;
  }

  return {
    numberOfChannels: 1,
    length: 4410,
    sampleRate: 44100,
    duration: 0.1,
    getChannelData: () => channelData,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

class MockOfflineAudioContext {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  destination = {};

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createBufferSource() {
    return new MockAudioBufferSourceNode();
  }

  createBiquadFilter() {
    return new MockBiquadFilterNode();
  }

  createGain() {
    return new MockGainNode();
  }

  async startRendering(): Promise<AudioBuffer> {
    return createMockAudioBuffer();
  }
}

vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:mock-stem-url',
  revokeObjectURL: vi.fn(),
});

describe('separateStems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(onProgress).toHaveBeenCalledWith(100);
  });

  it('progress reaches 100 at the end', async () => {
    const audioBuffer = createMockAudioBuffer();
    const progressValues: number[] = [];
    await separateStems(audioBuffer, (p) => progressValues.push(p));
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });

  it('stems have wav blob type', async () => {
    const audioBuffer = createMockAudioBuffer();
    const stems = await separateStems(audioBuffer);
    for (const stem of stems) {
      expect(stem.blob.type).toBe('audio/wav');
    }
  });
});
