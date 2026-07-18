import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeAutoSyncOffset } from '../autoSync';
import { crossCorrelate } from '../autoSyncCore';

// --- Mock Worker for the auto-sync cross-correlation ---
//
// The real `computeAutoSyncOffset` offloads `crossCorrelate` to a Web Worker.
// jsdom has no Worker, so we stub the global with a mock that runs the real
// pure `crossCorrelate` synchronously (following the stemSeparation.worker
// test pattern). This keeps the end-to-end behavior identical while the heavy
// math itself is also covered directly in the `crossCorrelate` suite below.
class MockAutoSyncWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;

  postMessage(msg: unknown) {
    if (this.terminated) return;

    const data = msg as {
      type: string;
      reference: Float32Array;
      target: Float32Array;
      maxLagSamples: number;
    };

    if (data.type === 'correlate') {
      setTimeout(() => {
        if (this.terminated) return;
        try {
          const { lagSamples, confidence } = crossCorrelate(
            data.reference,
            data.target,
            data.maxLagSamples,
          );
          this.onmessage?.({ data: { type: 'result', lagSamples, confidence } } as MessageEvent);
        } catch (err) {
          this.onmessage?.({
            data: { type: 'error', message: err instanceof Error ? err.message : 'error' },
          } as MessageEvent);
        }
      }, 0);
    }
  }

  terminate() {
    this.terminated = true;
  }
}

/** Worker variant that always reports an error, to cover the rejection path. */
class MockAutoSyncWorkerError {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(msg: unknown) {
    const data = msg as { type: string };
    if (data.type === 'correlate') {
      setTimeout(() => {
        this.onmessage?.({
          data: { type: 'error', message: 'Correlation failed' },
        } as MessageEvent);
      }, 0);
    }
  }

  terminate() {}
}

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

  // Auto-sync offloads cross-correlation to a Web Worker; stub it globally.
  vi.stubGlobal('Worker', MockAutoSyncWorker);

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

  it('rejects when the correlation worker reports an error', async () => {
    vi.stubGlobal('Worker', MockAutoSyncWorkerError);

    await expect(
      computeAutoSyncOffset('blob:http://localhost/reference', 'blob:http://localhost/target'),
    ).rejects.toThrow('Correlation failed');
  });
});

describe('crossCorrelate', () => {
  const SR = 8000;

  it('finds the correct lag when the target is a delayed copy of the reference', () => {
    const len = SR; // 1 second
    const delay = 400; // samples
    const reference = new Float32Array(len);
    const target = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = Math.sin(2 * Math.PI * (50 * (i / SR) + 30 * (i / SR) ** 2));
      reference[i] = v;
      target[i] = i >= delay ? reference[i - delay] : 0;
    }

    const { lagSamples, confidence } = crossCorrelate(reference, target, SR);

    // The reference leads the target by `delay` samples, which corresponds to a
    // best lag of -delay under this convention (offsetSeconds = -lag / rate > 0).
    expect(lagSamples).toBe(-delay);
    expect(confidence).toBeGreaterThan(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('returns lag 0 and full confidence for identical signals', () => {
    const len = 2000;
    const signal = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      signal[i] = Math.sin(i * 0.13);
    }

    const { lagSamples, confidence } = crossCorrelate(signal, signal.slice(), 200);

    expect(lagSamples).toBe(0);
    expect(confidence).toBeCloseTo(1, 5);
  });

  it('returns zero confidence when a signal has no energy', () => {
    const silent = new Float32Array(1000);
    const active = new Float32Array(1000).fill(0.5);

    expect(crossCorrelate(silent, active, 100)).toEqual({ lagSamples: 0, confidence: 0 });
    expect(crossCorrelate(active, silent, 100)).toEqual({ lagSamples: 0, confidence: 0 });
  });

  it('never searches beyond the requested maximum lag', () => {
    const reference = new Float32Array(500).fill(1);
    const target = new Float32Array(500).fill(1);

    const maxLag = 10;
    const { lagSamples } = crossCorrelate(reference, target, maxLag);

    expect(Math.abs(lagSamples)).toBeLessThanOrEqual(maxLag);
  });
});
