import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mixAudioTracks, audioBufferToWavBlob } from '../audioMixer';

function createMockAudioBuffer(length = 4410, channels = 2, sampleRate = 44100): AudioBuffer {
  const channelArrays: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = Math.sin(i * 0.01) * 0.5;
    }
    channelArrays.push(data);
  }

  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => channelArrays[Math.min(channel, channels - 1)],
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

// 10-second decoded buffers give clips room for offset/duration assertions.
const DECODED_BUFFER_LENGTH = 441000;

class MockAudioContext {
  sampleRate = 44100;
  state = 'running';

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return createMockAudioBuffer(length, channels, sampleRate);
  }

  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    return createMockAudioBuffer(DECODED_BUFFER_LENGTH);
  }

  async close() {
    this.state = 'closed';
  }
}

interface MockBufferSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

const createdSources: MockBufferSource[] = [];

class MockOfflineAudioContext {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  destination = { connect: vi.fn() };

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createBufferSource(): MockBufferSource {
    const source: MockBufferSource = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    };
    createdSources.push(source);
    return source;
  }

  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() };
  }

  async startRendering(): Promise<AudioBuffer> {
    return createMockAudioBuffer(this.length, this.numberOfChannels, this.sampleRate);
  }
}

vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('mixAudioTracks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdSources.length = 0;
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
  });

  it('returns a silent buffer when all tracks are muted', async () => {
    const result = await mixAudioTracks(
      [{ url: 'blob:test', offset: 0, volume: 1, muted: true }],
      5,
    );
    expect(result.numberOfChannels).toBe(2);
    expect(result.duration).toBeGreaterThanOrEqual(0.5);
  });

  it('returns a silent buffer when no tracks are provided', async () => {
    const result = await mixAudioTracks([], 3);
    expect(result.numberOfChannels).toBe(2);
  });

  it('fetches audio for unmuted tracks', async () => {
    await mixAudioTracks(
      [{ url: 'blob:track-1', offset: 0, volume: 0.8, muted: false }],
      5,
    );
    expect(mockFetch).toHaveBeenCalledWith('blob:track-1');
  });

  it('does not fetch muted tracks', async () => {
    await mixAudioTracks(
      [{ url: 'blob:track-1', offset: 0, volume: 0.8, muted: true }],
      5,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles multiple active tracks', async () => {
    const result = await mixAudioTracks(
      [
        { url: 'blob:track-1', offset: 0, volume: 0.5, muted: false },
        { url: 'blob:track-2', offset: 1, volume: 0.7, muted: false },
      ],
      5,
    );
    expect(result).toBeDefined();
    expect(result.numberOfChannels).toBe(2);
  });

  it('throws when fetch fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(
      mixAudioTracks([{ url: 'blob:bad-url', offset: 0, volume: 1, muted: false }], 5),
    ).rejects.toThrow('Failed to fetch audio source: 404');
  });

  it('starts sources with (when, offset, duration) honoring sourceStartOffset', async () => {
    await mixAudioTracks(
      [
        {
          url: 'blob:track-1',
          offset: 2,
          volume: 0.8,
          muted: false,
          sourceStartOffset: 1.5,
          duration: 3,
        },
      ],
      10,
    );

    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].start).toHaveBeenCalledTimes(1);
    expect(createdSources[0].start).toHaveBeenCalledWith(2, 1.5, 3);
  });

  it('defaults sourceStartOffset to 0 and duration to the full source', async () => {
    await mixAudioTracks(
      [{ url: 'blob:track-1', offset: 0, volume: 1, muted: false }],
      5,
    );

    expect(createdSources).toHaveLength(1);
    // Decoded mock buffer is 10 seconds long.
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 0, 10);
  });

  it('caps the play duration to the audio available after the source in-point', async () => {
    await mixAudioTracks(
      [
        {
          url: 'blob:track-1',
          offset: 1,
          volume: 1,
          muted: false,
          sourceStartOffset: 8,
          duration: 5,
        },
      ],
      10,
    );

    expect(createdSources).toHaveLength(1);
    // Only 2 seconds of source audio remain after the 8s in-point.
    expect(createdSources[0].start).toHaveBeenCalledWith(1, 8, 2);
  });

  it('schedules one source per active track', async () => {
    await mixAudioTracks(
      [
        { url: 'blob:track-1', offset: 0, volume: 1, muted: false, sourceStartOffset: 0.5, duration: 2 },
        { url: 'blob:track-2', offset: 3, volume: 0.6, muted: false, sourceStartOffset: 4, duration: 1 },
        { url: 'blob:track-3', offset: 0, volume: 1, muted: true },
      ],
      10,
    );

    expect(createdSources).toHaveLength(2);
    expect(createdSources[0].start).toHaveBeenCalledWith(0, 0.5, 2);
    expect(createdSources[1].start).toHaveBeenCalledWith(3, 4, 1);
  });

  it('filters out tracks with empty url', async () => {
    const result = await mixAudioTracks(
      [{ url: '', offset: 0, volume: 1, muted: false }],
      3,
    );
    // Empty url tracks are filtered — treated as silent
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.numberOfChannels).toBe(2);
  });
});

describe('audioBufferToWavBlob', () => {
  it('returns a Blob with audio/wav type', () => {
    const buffer = createMockAudioBuffer();
    const blob = audioBufferToWavBlob(buffer);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
  });

  it('generates correct WAV header size', () => {
    const length = 100;
    const channels = 2;
    const buffer = createMockAudioBuffer(length, channels);
    const blob = audioBufferToWavBlob(buffer);
    // WAV: 44 byte header + length * channels * 2 bytes per sample
    const expectedSize = 44 + length * channels * 2;
    expect(blob.size).toBe(expectedSize);
  });

  it('handles mono audio', () => {
    const buffer = createMockAudioBuffer(100, 1);
    const blob = audioBufferToWavBlob(buffer);
    const expectedSize = 44 + 100 * 1 * 2;
    expect(blob.size).toBe(expectedSize);
  });
});
