import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  computeAutoSyncOffset,
  getUnknownLengthPayloadLimit,
  readResponseBuffer,
} from '../autoSync';
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_FRAME_SIZE,
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
  AUTO_SYNC_MAX_CORRELATION_TERMS,
  AUTO_SYNC_MAX_LAG_SAMPLES,
  crossCorrelate,
  getCorrelationDimensions,
  parseCorrelationRequest,
} from '../autoSyncCore';

const SAMPLE_RATE = AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
const REFERENCE_BYTES = 100;
const TARGET_BYTES = 200;
const MEBIBYTE = 1024 * 1024;

function frameAmplitude(frame: number): number {
  let hash = frame + 1;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return 0.08 + ((hash >>> 0) / 0x1_0000_0000) * 0.84;
}

function createPatternSignal(frameCount: number): Float32Array {
  const signal = new Float32Array(frameCount * AUTO_SYNC_FRAME_SIZE);
  for (let frame = 0; frame < frameCount; frame++) {
    const amplitude = frameAmplitude(frame);
    for (let i = 0; i < AUTO_SYNC_FRAME_SIZE; i++) {
      signal[frame * AUTO_SYNC_FRAME_SIZE + i] =
        amplitude * Math.sin((2 * Math.PI * 5 * i) / AUTO_SYNC_FRAME_SIZE);
    }
  }
  return signal;
}

function createAsymmetricPulseSignal(frameCount: number): Float32Array {
  const signal = new Float32Array(frameCount * AUTO_SYNC_FRAME_SIZE);
  const pulses = new Map([
    [12, 0.25],
    [41, 0.8],
    [96, 0.45],
    [173, 0.95],
    [219, 0.35],
  ]);
  for (const [frame, amplitude] of pulses) {
    for (let i = 0; i < AUTO_SYNC_FRAME_SIZE; i++) {
      signal[frame * AUTO_SYNC_FRAME_SIZE + i] =
        amplitude * Math.sin((2 * Math.PI * 5 * i) / AUTO_SYNC_FRAME_SIZE);
    }
  }
  return signal;
}

function delaySignal(
  source: Float32Array,
  delaySamples: number,
  scale = 1,
  dcOffset = 0,
): Float32Array {
  const target = new Float32Array(source.length);
  target.fill(dcOffset);
  for (let i = delaySamples; i < target.length; i++) {
    target[i] = source[i - delaySamples] * scale + dcOffset;
  }
  return target;
}

function advanceSignal(source: Float32Array, advanceSamples: number): Float32Array {
  const target = new Float32Array(source.length);
  for (let i = 0; i + advanceSamples < source.length; i++) {
    target[i] = source[i + advanceSamples];
  }
  return target;
}

function createMockMonoBuffer(data: Float32Array): AudioBuffer {
  return {
    numberOfChannels: 1,
    length: data.length,
    sampleRate: SAMPLE_RATE,
    duration: data.length / SAMPLE_RATE,
    getChannelData: () => data,
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function createWaveHeader(options: {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
}): ArrayBuffer {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  const blockAlign = (options.channels * options.bitsPerSample) / 8;
  const byteRate = options.sampleRate * blockAlign;
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + options.dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bitsPerSample, true);
  writeText(36, 'data');
  view.setUint32(40, options.dataBytes, true);
  return buffer;
}

function createStreamResponse(options: {
  chunks?: Uint8Array[];
  cancel?: () => Promise<void>;
  pendingRead?: boolean;
}): Response {
  const chunks = [...(options.chunks ?? [])];
  const reader = {
    read: vi.fn(() =>
      options.pendingRead
        ? new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})
        : Promise.resolve(
            chunks.length
              ? { done: false as const, value: chunks.shift()! }
              : { done: true as const, value: undefined },
          ),
    ),
    cancel: vi.fn(options.cancel ?? (async () => {})),
    releaseLock: vi.fn(),
  };
  return {
    body: {
      getReader: () => reader,
    },
    arrayBuffer: vi.fn(),
  } as unknown as Response;
}

let decodedReference: Float32Array;
let decodedTarget: Float32Array;
let fetchedUrls: string[];
let workerTerminations: number;

class MockAutoSyncWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  protected terminated = false;

  postMessage(value: unknown) {
    if (this.terminated) {
      return;
    }
    const message = parseCorrelationRequest(value);
    setTimeout(() => {
      if (this.terminated) {
        return;
      }
      try {
        this.onmessage?.({
          data: {
            type: 'result',
            ...crossCorrelate(message.reference, message.target, message.maxLagSamples),
          },
        } as MessageEvent);
      } catch (error) {
        this.onmessage?.({
          data: {
            type: 'error',
            message: error instanceof Error ? error.message : 'Correlation failed',
          },
        } as MessageEvent);
      }
    }, 0);
  }

  terminate() {
    this.terminated = true;
    workerTerminations++;
  }
}

class MalformedResultWorker extends MockAutoSyncWorker {
  override postMessage() {
    setTimeout(() => {
      this.onmessage?.({
        data: { type: 'result', lagSamples: 1, confidence: 0.8 },
      } as MessageEvent);
    }, 0);
  }
}

class ErrorResultWorker extends MockAutoSyncWorker {
  override postMessage() {
    setTimeout(() => {
      this.onmessage?.({
        data: { type: 'error', message: 'Correlation failed' },
      } as MessageEvent);
    }, 0);
  }
}

class SilentWorker extends MockAutoSyncWorker {
  override postMessage() {}
}

beforeEach(() => {
  vi.useRealTimers();
  fetchedUrls = [];
  workerTerminations = 0;
  decodedReference = createAsymmetricPulseSignal(250);
  decodedTarget = delaySignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);

  vi.stubGlobal(
    'Audio',
    class {
      duration = 5;
      preload = '';
      src = '';
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;

      load() {
        if (this.src) {
          queueMicrotask(() => this.onloadedmetadata?.());
        }
      }

      removeAttribute(name: string) {
        if (name === 'src') {
          this.src = '';
        }
      }
    },
  );
  vi.stubGlobal('Worker', MockAutoSyncWorker);
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
        return createMockMonoBuffer(
          data.byteLength === TARGET_BYTES ? decodedTarget : decodedReference,
        );
      }
      async close() {}
    },
  );
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      private readonly length: number;
      private connectedBuffer: AudioBuffer | null = null;

      constructor(_channels: number, length: number, _sampleRate: number) {
        this.length = length;
      }

      createBufferSource() {
        const connectBuffer = (buffer: AudioBuffer | null) => {
          this.connectedBuffer = buffer;
        };
        return {
          value: null as AudioBuffer | null,
          set buffer(buffer: AudioBuffer | null) {
            this.value = buffer;
            connectBuffer(buffer);
          },
          get buffer() {
            return this.value;
          },
          connect: vi.fn(),
          start: vi.fn(),
        };
      }

      get destination() {
        return {};
      }

      async startRendering(): Promise<AudioBuffer> {
        const source = this.connectedBuffer?.getChannelData(0) ?? new Float32Array();
        return createMockMonoBuffer(source.slice(0, this.length));
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      const isTarget = url.includes('target') || url === 'blob:tar';
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(isTarget ? TARGET_BYTES : REFERENCE_BYTES),
      };
    }),
  );
});

describe('readResponseBuffer', () => {
  it('preallocates and accepts the exact declared Content-Length boundary', async () => {
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
    });

    const buffer = await readResponseBuffer(response, 4, 'too large', undefined, 4);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('reserves assembly headroom for unknown-length responses at exact boundaries', async () => {
    expect(getUnknownLengthPayloadLimit(8)).toBe(4);
    const accepted = createStreamResponse({
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
    });
    await expect(readResponseBuffer(accepted, 8, 'too large', undefined)).resolves.toHaveProperty(
      'byteLength',
      4,
    );

    const rejected = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5)],
    });
    await expect(readResponseBuffer(rejected, 8, 'too large', undefined)).rejects.toThrow(
      'too large',
    );
  });

  it('preserves AbortError when stream cancellation rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    const response = createStreamResponse({ cancel, pendingRead: true });
    const controller = new AbortController();
    const pending = readResponseBuffer(response, 8, 'too large', controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('computeAutoSyncOffset', () => {
  it('advances a delayed target within the documented 20 ms tolerance', async () => {
    const result = await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(result.offsetSeconds).toBeCloseTo(-0.5, 5);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(workerTerminations).toBe(1);
  });

  it('delays an advanced target within the documented 20 ms tolerance', async () => {
    decodedTarget = advanceSignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);

    const result = await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(result.offsetSeconds).toBeCloseTo(0.5, 5);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('fetches and decodes audio sources sequentially', async () => {
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
          activeDecodes++;
          maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
          await Promise.resolve();
          activeDecodes--;
          return createMockMonoBuffer(
            data.byteLength === TARGET_BYTES ? decodedTarget : decodedReference,
          );
        }
        async close() {}
      },
    );

    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(fetchedUrls).toEqual(['blob:ref', 'blob:tar']);
    expect(maximumActiveDecodes).toBe(1);
  });

  it('reports actionable fetch and duration-limit errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    await expect(computeAutoSyncOffset('bad', 'bad')).rejects.toThrow(
      'Failed to fetch reference audio: HTTP 404',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(REFERENCE_BYTES),
      })),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          return {
            duration: 301,
            length: 1,
            sampleRate: SAMPLE_RATE,
          } as AudioBuffer;
        }
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'the limit is 5 minutes',
    );
  });

  it('cancels rejected and oversized responses without masking the primary error', async () => {
    const cancelRejected = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        body: { cancel: cancelRejected },
      })),
    );
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Failed to fetch reference audio: HTTP 503',
    );
    expect(cancelRejected).toHaveBeenCalledOnce();

    const cancelOversized = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(48 * MEBIBYTE + 1),
        }),
        body: { cancel: cancelOversized },
      })),
    );
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      '48 MB auto-sync encoded-file limit',
    );
    expect(cancelOversized).toHaveBeenCalledOnce();
  });

  it('rejects overlong compressed audio from metadata before fetching or decoding', async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'Audio',
      class {
        duration = 301;
        preload = '';
        src = '';
        onloadedmetadata: (() => void) | null = null;
        onerror: (() => void) | null = null;
        load() {
          if (this.src) {
            queueMicrotask(() => this.onloadedmetadata?.());
          }
        }
        removeAttribute() {
          this.src = '';
        }
      },
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:long', 'blob:target')).rejects.toThrow(
      'the limit is 5 minutes',
    );
    expect(fetchedUrls).toEqual([]);
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects malformed and explicit worker errors and always terminates', async () => {
    vi.stubGlobal('Worker', MalformedResultWorker);
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'invalid correlation result',
    );
    expect(workerTerminations).toBe(1);

    vi.stubGlobal('Worker', ErrorResultWorker);
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Correlation failed',
    );
    expect(workerTerminations).toBe(2);
  });

  it('times out, aborts, and terminates a worker that never responds', async () => {
    vi.stubGlobal('Worker', SilentWorker);
    await expect(
      computeAutoSyncOffset('blob:ref', 'blob:tar', { workerTimeoutMs: 5 }),
    ).rejects.toThrow('timed out after 5 ms');
    expect(workerTerminations).toBe(1);

    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerTerminations).toBe(2);
  });

  it('rejects promptly and closes decoder contexts when decoding is aborted', async () => {
    let decoderCloses = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData(): Promise<AudioBuffer> {
          return new Promise(() => {});
        }
        async close() {
          decoderCloses++;
        }
      },
    );
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoderCloses).toBe(1);
    expect(fetchedUrls).toEqual(['blob:ref']);
  });

  it('rejects before decoding a second input that exceeds the aggregate encoded budget', async () => {
    const firstBytes = 40 * MEBIBYTE;
    const secondBytes = 25 * MEBIBYTE;
    const firstArrayBuffer = vi.fn(async () => new ArrayBuffer(firstBytes));
    const secondArrayBuffer = vi.fn(async () => new ArrayBuffer(secondBytes));
    const cancelSecond = vi.fn(async () => {});
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        return request === 1
          ? {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-length': String(firstBytes) }),
              arrayBuffer: firstArrayBuffer,
            }
          : {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-length': String(secondBytes) }),
              body: { cancel: cancelSecond },
              arrayBuffer: secondArrayBuffer,
            };
      }),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'combined 64 MB encoded-audio limit',
    );
    expect(AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES).toBe(64 * MEBIBYTE);
    expect(firstArrayBuffer).toHaveBeenCalledOnce();
    expect(secondArrayBuffer).not.toHaveBeenCalled();
    expect(cancelSecond).toHaveBeenCalledOnce();
    expect(workerTerminations).toBe(0);
  });

  it('rejects pathological decoded audio before allocating an analysis render', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          return {
            duration: 2,
            length: AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT / 4 + 1,
            numberOfChannels: 1,
            sampleRate: SAMPLE_RATE,
          } as AudioBuffer;
        }
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      '128 MB decoded-audio memory limit',
    );
    expect(fetchedUrls).toEqual(['blob:ref']);
  });

  it('rejects pathological PCM from its header before decoding', async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );
    const wave = createWaveHeader({
      channels: 8,
      sampleRate: 192_000,
      bitsPerSample: 8,
      dataBytes: 40 * MEBIBYTE,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => wave,
      })),
    );

    await expect(computeAutoSyncOffset('blob:pcm', 'blob:target')).rejects.toThrow(
      '128 MB decoded-audio memory limit',
    );
    expect(decodeAudioData).not.toHaveBeenCalled();
  });
});

describe('crossCorrelate', () => {
  it('recovers positive and negative offsets to the nearest 20 ms frame', () => {
    const reference = createPatternSignal(400);
    const delay = 37 * AUTO_SYNC_FRAME_SIZE;

    const delayed = crossCorrelate(reference, delaySignal(reference, delay), delay * 2);
    const advanced = crossCorrelate(reference, advanceSignal(reference, delay), delay * 2);

    expect(Math.abs(delayed.lagSamples + delay)).toBeLessThanOrEqual(AUTO_SYNC_FRAME_SIZE);
    expect(Math.abs(advanced.lagSamples - delay)).toBeLessThanOrEqual(AUTO_SYNC_FRAME_SIZE);
    expect(delayed.confidence).toBeGreaterThan(0.9);
    expect(advanced.confidence).toBeGreaterThan(0.9);
  });

  it('is invariant to target amplitude scaling and DC offset', () => {
    const reference = createPatternSignal(300);
    const delay = 29 * AUTO_SYNC_FRAME_SIZE;
    const baseline = crossCorrelate(reference, delaySignal(reference, delay), delay * 2);
    const transformed = crossCorrelate(
      reference,
      delaySignal(reference, delay, 0.23, 0.4),
      delay * 2,
    );

    expect(transformed.lagSamples).toBe(baseline.lagSamples);
    expect(transformed.confidence).toBeCloseTo(baseline.confidence, 5);
  });

  it('normalizes unequal lengths over their actual overlap', () => {
    const reference = createPatternSignal(500);
    const excerptStart = 145 * AUTO_SYNC_FRAME_SIZE;
    const target = reference.slice(excerptStart, excerptStart + 180 * AUTO_SYNC_FRAME_SIZE);

    const result = crossCorrelate(reference, target, 200 * AUTO_SYNC_FRAME_SIZE);

    expect(result.lagSamples).toBe(excerptStart);
    expect(result.confidence).toBeCloseTo(1, 5);
  });

  it('returns zero confidence for silence, DC-only audio, and near-silence', () => {
    const active = createPatternSignal(100);
    const silent = new Float32Array(active.length);
    const dcOnly = new Float32Array(active.length).fill(0.4);
    const nearSilent = Float32Array.from(active, (sample) => sample * 1e-7);

    expect(crossCorrelate(silent, active, AUTO_SYNC_FRAME_SIZE)).toEqual({
      lagSamples: 0,
      confidence: 0,
    });
    expect(crossCorrelate(dcOnly, active, AUTO_SYNC_FRAME_SIZE)).toEqual({
      lagSamples: 0,
      confidence: 0,
    });
    expect(crossCorrelate(nearSilent, active, AUTO_SYNC_FRAME_SIZE)).toEqual({
      lagSamples: 0,
      confidence: 0,
    });
  });

  it('reports zero confidence for an ambiguous constant tone', () => {
    const tone = new Float32Array(SAMPLE_RATE * 2);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    }
    const delayed = delaySignal(tone, AUTO_SYNC_FRAME_SIZE);

    expect(crossCorrelate(tone, delayed, SAMPLE_RATE).confidence).toBeLessThan(0.15);
  });

  it('never returns a quantized lag beyond a sub-frame requested bound', () => {
    const reference = createPatternSignal(100);
    const target = delaySignal(reference, AUTO_SYNC_FRAME_SIZE);

    expect(crossCorrelate(reference, target, AUTO_SYNC_FRAME_SIZE - 1).lagSamples).toBe(0);
  });

  it('keeps maximum-duration work within the explicit operation budget', () => {
    const dimensions = getCorrelationDimensions(
      AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
      AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
      AUTO_SYNC_MAX_LAG_SAMPLES,
    );

    expect(dimensions.referenceEnvelopeSamples).toBe(15_000);
    expect(dimensions.maxLagEnvelopeSamples).toBe(500);
    expect(dimensions.candidateLags).toBe(1_001);
    expect(dimensions.maximumCorrelationTerms).toBe(AUTO_SYNC_MAX_CORRELATION_TERMS);
    expect(() =>
      getCorrelationDimensions(
        AUTO_SYNC_MAX_ANALYSIS_SAMPLES + 1,
        AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
        AUTO_SYNC_MAX_LAG_SAMPLES,
      ),
    ).toThrow('5-minute');
  });

  it('validates worker payload type, arrays, lengths, and lag bounds', () => {
    const signal = createPatternSignal(50);
    expect(
      parseCorrelationRequest({
        type: 'correlate',
        reference: signal,
        target: signal,
        maxLagSamples: AUTO_SYNC_FRAME_SIZE,
      }),
    ).toMatchObject({ type: 'correlate' });
    expect(() => parseCorrelationRequest({ type: 'unknown' })).toThrow(
      'Unsupported auto-sync worker message type',
    );
    expect(() =>
      parseCorrelationRequest({
        type: 'correlate',
        reference: [],
        target: signal,
        maxLagSamples: 0,
      }),
    ).toThrow('Float32Array');
    expect(() =>
      parseCorrelationRequest({
        type: 'correlate',
        reference: createPatternSignal(49),
        target: signal,
        maxLagSamples: 0,
      }),
    ).toThrow('at least 1 second');
    expect(() =>
      parseCorrelationRequest({
        type: 'correlate',
        reference: signal,
        target: signal,
        maxLagSamples: AUTO_SYNC_MAX_LAG_SAMPLES + 1,
      }),
    ).toThrow('cannot exceed 10 seconds');
  });
});
