import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SYNC_MAX_FILE_BYTES,
  AUTO_SYNC_MAX_TOTAL_FILE_BYTES,
  AutoSyncResourceLimitError,
  computeAutoSyncOffset,
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
  const amplitudes = new Map([
    [11, 0.28],
    [37, 0.92],
    [88, 0.41],
    [143, 0.73],
    [207, 0.19],
  ]);
  const signal = new Float32Array(frameCount * AUTO_SYNC_FRAME_SIZE);

  for (let frame = 0; frame < frameCount; frame++) {
    const amplitude = amplitudes.get(frame) ?? 0.015;
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

let decodedReference: Float32Array;
let decodedTarget: Float32Array;
let fetchedUrls: string[];
let analysisEvents: string[];
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
  analysisEvents = [];
  workerTerminations = 0;
  decodedReference = createAsymmetricPulseSignal(250);
  decodedTarget = delaySignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);

  vi.stubGlobal('Worker', MockAutoSyncWorker);
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
        analysisEvents.push(
          data.byteLength === TARGET_BYTES ? 'decode:target' : 'decode:reference',
        );
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
          disconnect: vi.fn(),
          start: vi.fn(),
        };
      }

      get destination() {
        return {};
      }

      async startRendering(): Promise<AudioBuffer> {
        analysisEvents.push('render');
        const source = this.connectedBuffer?.getChannelData(0) ?? new Float32Array();
        return createMockMonoBuffer(source.slice(0, this.length));
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      analysisEvents.push(`fetch:${url}`);
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

describe('computeAutoSyncOffset', () => {
  it('returns a negative placement for an asymmetrically pulsed target that is delayed', async () => {
    const result = await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(result.offsetSeconds).toBeCloseTo(-0.5, 5);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(workerTerminations).toBe(1);
  });

  it('returns a positive placement for an asymmetrically pulsed target that is advanced', async () => {
    decodedTarget = advanceSignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);

    const result = await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(result.offsetSeconds).toBeCloseTo(0.5, 5);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('fetches, decodes, and renders the two inputs sequentially', async () => {
    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(analysisEvents).toEqual([
      'fetch:blob:ref',
      'decode:reference',
      'render',
      'fetch:blob:tar',
      'decode:target',
      'render',
    ]);
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
            numberOfChannels: 1,
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

  it('rejects individual and aggregate encoded input budgets with typed errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(AUTO_SYNC_MAX_FILE_BYTES + 1),
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      name: 'AutoSyncResourceLimitError',
      code: 'individual-input',
      message: expect.stringContaining('shorter or more compressed'),
    } satisfies Partial<AutoSyncResourceLimitError>);

    const firstBytes = AUTO_SYNC_MAX_TOTAL_FILE_BYTES - AUTO_SYNC_MAX_FILE_BYTES + 1;
    const secondBytes = AUTO_SYNC_MAX_FILE_BYTES;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const isTarget = url === 'blob:tar';
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-length': String(isTarget ? secondBytes : firstBytes),
          }),
          arrayBuffer: async () =>
            ({ byteLength: isTarget ? secondBytes : firstBytes }) as ArrayBuffer,
        };
      }),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      name: 'AutoSyncResourceLimitError',
      code: 'aggregate-input',
      message: expect.stringContaining('Combined auto-sync inputs'),
    } satisfies Partial<AutoSyncResourceLimitError>);
  });

  it('accepts exact individual and aggregate boundaries through the declared-length path', async () => {
    const referenceBuffer = {
      byteLength: AUTO_SYNC_MAX_FILE_BYTES,
    } as ArrayBuffer;
    const targetBuffer = {
      byteLength: AUTO_SYNC_MAX_TOTAL_FILE_BYTES - AUTO_SYNC_MAX_FILE_BYTES,
    } as ArrayBuffer;
    const arrayBufferCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const isTarget = url === 'blob:tar';
        const encoded = isTarget ? targetBuffer : referenceBuffer;
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-length': String(encoded.byteLength),
          }),
          body: {
            getReader: () => {
              throw new Error('Declared-length responses must not retain streamed chunks');
            },
          },
          arrayBuffer: async () => {
            arrayBufferCalls.push(url);
            return encoded;
          },
        };
      }),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).resolves.toMatchObject({
      offsetSeconds: 0,
    });
    expect(arrayBufferCalls).toEqual(['blob:ref', 'blob:tar']);
  });

  it('conservatively rejects an unknown-length response before its final copy exceeds peak budget', async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { byteLength: AUTO_SYNC_MAX_TOTAL_FILE_BYTES / 2 + 1 },
              }),
            cancel,
            releaseLock,
          }),
        },
        arrayBuffer: vi.fn(),
      })),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      name: 'AutoSyncResourceLimitError',
      code: 'aggregate-input',
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('preserves AbortError when stream cancellation cleanup rejects', async () => {
    const controller = new AbortController();
    const cancelError = new Error('cancel failed');
    const cancel = vi.fn(async () => {
      throw cancelError;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              controller.abort();
              return { done: false, value: new Uint8Array(1) };
            }),
            cancel,
            releaseLock: vi.fn(),
          }),
        },
      })),
    );

    const error = await computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    }).catch((caughtError: unknown) => caughtError);

    expect(error).toMatchObject({
      name: 'AbortError',
      cleanupError: cancelError,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels non-OK and oversized declared responses without replacing primary errors', async () => {
    const nonOkCancel = vi.fn(async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        body: { cancel: nonOkCancel },
      })),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Failed to fetch reference audio: HTTP 503',
    );
    expect(nonOkCancel).toHaveBeenCalledOnce();

    const cancelError = new Error('cleanup failed');
    const oversizedCancel = vi.fn(async () => {
      throw cancelError;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(AUTO_SYNC_MAX_FILE_BYTES + 1),
        }),
        body: { cancel: oversizedCancel },
      })),
    );

    const error = await computeAutoSyncOffset('blob:ref', 'blob:tar').catch(
      (caughtError: unknown) => caughtError,
    );
    expect(error).toMatchObject({
      name: 'AutoSyncResourceLimitError',
      code: 'individual-input',
      cleanupError: cancelError,
    });
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it('does not fetch or decode the target after reference decoding fails', async () => {
    let decodeAttempts = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          decodeAttempts++;
          throw new Error('broken reference');
        }
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Could not decode reference audio',
    );
    expect(fetchedUrls).toEqual(['blob:ref']);
    expect(decodeAttempts).toBe(1);
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
