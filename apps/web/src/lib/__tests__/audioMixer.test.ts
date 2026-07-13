import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mixAudioTracks, audioBufferToWavBlob } from '../audioMixer';

// Mock Web Audio API
class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }
}

class MockAudioContext {
  sampleRate = 44100;
  private _closed = false;

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }

  async decodeAudioData(data: ArrayBuffer): Promise<MockAudioBuffer> {
    // Return a buffer with 1 second of sine wave
    const buf = new MockAudioBuffer(2, 44100, 44100);
    for (let ch = 0; ch < 2; ch++) {
      const channelData = buf.getChannelData(ch);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = 0.5;
      }
    }
    return buf;
  }

  async close() {
    this._closed = true;
  }
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
  }));
});

describe('mixAudioTracks', () => {
  it('returns a silent buffer when all tracks are muted', async () => {
    const result = await mixAudioTracks(
      [
        { url: 'blob:http://localhost/a', offset: 0, volume: 1, muted: true },
        { url: 'blob:http://localhost/b', offset: 0, volume: 1, muted: true },
      ],
      5,
    );

    expect(result.numberOfChannels).toBe(2);
    // All samples should be 0 (silent)
    const data = result.getChannelData(0);
    const allZero = data.every((s) => s === 0);
    expect(allZero).toBe(true);
  });

  it('excludes muted tracks from mix', async () => {
    const result = await mixAudioTracks(
      [
        { url: 'blob:http://localhost/a', offset: 0, volume: 1, muted: false },
        { url: 'blob:http://localhost/b', offset: 0, volume: 1, muted: true },
      ],
      2,
    );

    // The decoded mock buffer fills 0.5 for all samples — active track should contribute
    const data = result.getChannelData(0);
    const hasNonZero = data.some((s) => s !== 0);
    expect(hasNonZero).toBe(true);
  });

  it('applies volume scaling to tracks', async () => {
    const fullVolume = await mixAudioTracks(
      [{ url: 'blob:http://localhost/a', offset: 0, volume: 1, muted: false }],
      2,
    );

    const halfVolume = await mixAudioTracks(
      [{ url: 'blob:http://localhost/a', offset: 0, volume: 0.5, muted: false }],
      2,
    );

    const fullData = fullVolume.getChannelData(0);
    const halfData = halfVolume.getChannelData(0);

    // Half volume should produce samples approximately half of full volume
    expect(halfData[0]).toBeCloseTo(fullData[0] * 0.5, 5);
  });

  it('applies offset positioning to tracks', async () => {
    const result = await mixAudioTracks(
      [{ url: 'blob:http://localhost/a', offset: 1, volume: 1, muted: false }],
      3,
    );

    const data = result.getChannelData(0);
    // First second (44100 samples) should be silent since offset is 1s
    expect(data[0]).toBe(0);
    expect(data[44099]).toBe(0);
    // After 1 second offset, audio data should appear
    expect(data[44100]).not.toBe(0);
  });
});

describe('audioBufferToWavBlob', () => {
  it('produces a valid WAV blob', () => {
    const buffer = new MockAudioBuffer(2, 100, 44100) as unknown as AudioBuffer;
    const blob = audioBufferToWavBlob(buffer);

    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 100 * 2 * 2); // header + samples * channels * bytesPerSample
  });
});
