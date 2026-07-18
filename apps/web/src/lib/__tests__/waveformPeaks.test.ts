import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractPeaks } from '../waveformPeaks';

// --- Mocks for Web Audio API ---

function createMockAudioBuffer(
  length: number,
  channels = 1,
  sampleRate = 44100,
  fillFn: (i: number) => number = (i) => Math.sin(i * 0.05) * 0.5,
): AudioBuffer {
  const channelArrays: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = fillFn(i);
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

const mockDecodeAudioData = vi.fn();

class MockAudioContext {
  sampleRate = 44100;
  decodeAudioData = mockDecodeAudioData;
  async close() {}
}

vi.stubGlobal('AudioContext', MockAudioContext);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('extractPeaks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: 1 second of mono audio at 44.1kHz.
    mockDecodeAudioData.mockResolvedValue(createMockAudioBuffer(44100));
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
  });

  it('returns empty PeakData for an empty sourceUrl without fetching', async () => {
    const result = await extractPeaks('');

    expect(result.peaks).toBeInstanceOf(Float32Array);
    expect(result.peaks.length).toBe(0);
    expect(result.duration).toBe(0);
    expect(result.peaksPerSecond).toBe(100);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when the response is not ok (404)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    // Unique URL avoids the module-level success cache.
    await expect(extractPeaks(`blob:missing-${Math.random()}`)).rejects.toThrow(
      /Failed to fetch audio: 404/,
    );
    // decodeAudioData must never run on a failed fetch.
    expect(mockDecodeAudioData).not.toHaveBeenCalled();
  });

  it('decodes and returns normalized peak data on success', async () => {
    const url = `blob:success-${Math.random()}`;
    const result = await extractPeaks(url);

    expect(mockFetch).toHaveBeenCalledWith(url);
    expect(result.duration).toBeCloseTo(1, 5);
    expect(result.peaksPerSecond).toBe(100);
    // ceil(1s * 100 peaks/s) = 100 peaks.
    expect(result.peaks.length).toBe(100);

    // Peaks are normalized to [0, 1] with at least one peak reaching the max.
    let max = 0;
    for (const p of result.peaks) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      if (p > max) max = p;
    }
    expect(max).toBeCloseTo(1, 5);
  });

  it('caches results per URL and dedupes concurrent requests', async () => {
    const url = `blob:cached-${Math.random()}`;

    const [a, b] = await Promise.all([extractPeaks(url), extractPeaks(url)]);
    const c = await extractPeaks(url);

    // One fetch/decode despite three calls for the same URL.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDecodeAudioData).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});
