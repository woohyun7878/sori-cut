import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeAutoSyncOffset } from '../autoSync';

// --- Mocks for Web Audio API ---

function createMockMonoBuffer(
  length: number,
  sampleRate: number,
  fillFn?: (i: number) => number,
): AudioBuffer {
  const data = new Float32Array(length);
  if (fillFn) {
    for (let i = 0; i < length; i++) {
      data[i] = fillFn(i);
    }
  }

  return {
    numberOfChannels: 1,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: () => data,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

// Use a pseudo-random chirp signal that has a unique correlation peak.
function testSignal(i: number) {
  // Linear chirp: frequency increases over time → aperiodic.
  const t = i / SAMPLE_RATE;
  return Math.sin(2 * Math.PI * (100 * t + 200 * t * t));
}

// Track calls to detect which URL was fetched.
let fetchedUrls: string[] = [];

const SAMPLE_RATE = 8000;
const SIGNAL_LENGTH = SAMPLE_RATE * 4; // 4 seconds
const DELAY_SAMPLES = SAMPLE_RATE * 2; // target delayed by 2 seconds

beforeEach(() => {
  fetchedUrls = [];

  // Use buffer size as a discriminator: reference = 100 bytes, target = 200 bytes.
  const REF_SIZE = 100;
  const TAR_SIZE = 200;

  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = SAMPLE_RATE;
      async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
        // Decide signal based on buffer size (preserved through .slice(0)).
        const signalFn = data.byteLength === TAR_SIZE
          ? (i: number) => (i >= DELAY_SAMPLES ? testSignal(i - DELAY_SAMPLES) : 0)
          : testSignal;
        return createMockMonoBuffer(SIGNAL_LENGTH, SAMPLE_RATE, signalFn);
      }
      async close() {}
    },
  );

  // OfflineAudioContext passes through the buffer set on its source.
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      private length: number;
      private rate: number;
      private connectedBuffer: AudioBuffer | null = null;

      constructor(_channels: number, length: number, sampleRate: number) {
        this.length = length;
        this.rate = sampleRate;
      }

      createBufferSource() {
        const self = this;
        return {
          _buffer: null as AudioBuffer | null,
          set buffer(b: AudioBuffer | null) {
            this._buffer = b;
            self.connectedBuffer = b;
          },
          get buffer() { return this._buffer; },
          connect: vi.fn(),
          start: vi.fn(),
        };
      }

      get destination() { return {}; }

      async startRendering(): Promise<AudioBuffer> {
        if (this.connectedBuffer) {
          const srcData = this.connectedBuffer.getChannelData(0);
          return createMockMonoBuffer(this.length, this.rate, (i) =>
            i < srcData.length ? srcData[i] : 0,
          );
        }
        return createMockMonoBuffer(this.length, this.rate);
      }
    },
  );

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      // Assign different buffer sizes so decodeAudioData can distinguish.
      const isTarget = url.includes('target') || url === 'blob:tar';
      const buf = new ArrayBuffer(isTarget ? TAR_SIZE : REF_SIZE);
      return {
        ok: true,
        arrayBuffer: async () => buf,
      };
    }),
  );
});

describe('computeAutoSyncOffset', () => {
  it('detects a positive time offset when the target is delayed', async () => {
    const result = await computeAutoSyncOffset(
      'blob:http://localhost/reference',
      'blob:http://localhost/target',
    );

    // The offset should be approximately 2 seconds (the delay we introduced).
    expect(result.offsetSeconds).toBeCloseTo(2, 0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('fetches both URLs', async () => {
    await computeAutoSyncOffset('blob:ref', 'blob:tar');
    expect(fetchedUrls).toContain('blob:ref');
    expect(fetchedUrls).toContain('blob:tar');
  });

  it('returns zero offset when signals are identical', async () => {
    // Force all OfflineAudioContext renders to return the same signal.
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        private length: number;
        private rate: number;
        constructor(_c: number, length: number, rate: number) {
          this.length = length;
          this.rate = rate;
        }
        createBufferSource() {
          return { buffer: null, connect: vi.fn(), start: vi.fn() };
        }
        get destination() { return {}; }
        async startRendering() {
          return createMockMonoBuffer(this.length, this.rate, testSignal);
        }
      },
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = SAMPLE_RATE;
        async decodeAudioData() {
          return createMockMonoBuffer(SIGNAL_LENGTH, SAMPLE_RATE, testSignal);
        }
        async close() {}
      },
    );

    const result = await computeAutoSyncOffset('blob:ref', 'blob:tar');
    expect(result.offsetSeconds).toBeCloseTo(0, 1);
  });

  it('throws when fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })),
    );

    await expect(computeAutoSyncOffset('bad-url', 'bad-url')).rejects.toThrow(/Failed to fetch/);
  });
});
