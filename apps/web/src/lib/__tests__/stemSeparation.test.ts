import { describe, it, expect, vi, beforeEach } from 'vitest';
import { separateStems } from '../stemSeparation';

// Mock Web Audio API
class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private channels: Float32Array[];

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.channels = Array.from(
      { length: options.numberOfChannels },
      () => new Float32Array(options.length),
    );
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }
}

class MockAudioNode {
  connect() {
    return this;
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = { value: 0 };
}

class MockGainNode extends MockAudioNode {
  gain = { value: 1 };
}

class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  start() {}
}

class MockAudioDestinationNode extends MockAudioNode {}

class MockOfflineAudioContext {
  destination = new MockAudioDestinationNode();
  private _buffer: MockAudioBuffer;

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this._buffer = new MockAudioBuffer({ numberOfChannels, length, sampleRate });
    // Fill with some test data
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = this._buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = Math.sin(i * 0.1) * 0.5;
      }
    }
  }

  createBufferSource(): MockAudioBufferSourceNode {
    return new MockAudioBufferSourceNode();
  }

  createBiquadFilter(): MockBiquadFilterNode {
    return new MockBiquadFilterNode();
  }

  createGain(): MockGainNode {
    return new MockGainNode();
  }

  async startRendering(): Promise<MockAudioBuffer> {
    return this._buffer;
  }
}

beforeEach(() => {
  vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:http://localhost/mock-stem',
    revokeObjectURL: () => {},
  });
});

describe('separateStems', () => {
  function createTestAudioBuffer(): AudioBuffer {
    return new MockAudioBuffer({
      numberOfChannels: 2,
      length: 44100,
      sampleRate: 44100,
    }) as unknown as AudioBuffer;
  }

  it('returns 4 stems with correct names and labels', async () => {
    const buffer = createTestAudioBuffer();
    const stems = await separateStems(buffer);

    expect(stems).toHaveLength(4);
    expect(stems[0].name).toBe('vocals');
    expect(stems[0].label).toBe('보컬');
    expect(stems[1].name).toBe('drums');
    expect(stems[1].label).toBe('드럼');
    expect(stems[2].name).toBe('bass');
    expect(stems[2].label).toBe('베이스');
    expect(stems[3].name).toBe('guitar');
    expect(stems[3].label).toBe('기타/기타');
  });

  it('calls progress callback with increasing values', async () => {
    const buffer = createTestAudioBuffer();
    const progressValues: number[] = [];

    await separateStems(buffer, (progress) => {
      progressValues.push(progress);
    });

    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[0]).toBe(0);
    expect(progressValues[progressValues.length - 1]).toBe(100);
    // Verify values are non-decreasing
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
  });

  it('produces valid WAV blobs with correct size', async () => {
    const buffer = createTestAudioBuffer();
    const stems = await separateStems(buffer);

    for (const stem of stems) {
      expect(stem.blob).toBeInstanceOf(Blob);
      expect(stem.blob.type).toBe('audio/wav');
      // WAV header (44 bytes) + data (samples * channels * bytesPerSample)
      // 44100 samples * 2 channels * 2 bytes = 176400 + 44 = 176444
      expect(stem.blob.size).toBe(44 + 44100 * 2 * 2);
    }
  });
});
