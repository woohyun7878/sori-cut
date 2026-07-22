import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  copyCalls: 0,
  inputs: [] as Array<{ formats: unknown[]; source: { buffer: ArrayBuffer } }>,
  iteratorReturnError: null as Error | null,
  iteratorReturns: 0,
  metadata: {
    canDecode: true,
    format: 'MP3',
    malformedAt: null as 'decode-check' | 'format' | 'iteration' | 'tracks' | null,
    hasVideo: false,
    pendingNext: false,
    primaryTrackIndex: 0,
    readable: true,
    track: true,
    trackCount: 1,
  },
  sampleSets: new Map<
    string,
    Array<{
      channels: Float32Array[];
      closeError?: Error;
      copyError?: Error;
      duration?: number;
      numberOfChannels?: number;
      numberOfFrames?: number;
      sampleRate: number;
      timestamp?: number;
    }>
  >(),
  samplesClosed: [] as number[],
  selectedTrackIndexes: [] as number[],
}));

vi.mock('mediabunny', () => {
  class BufferSource {
    constructor(readonly buffer: ArrayBuffer) {}
  }
  class InputAudioTrack {
    constructor(
      readonly inputBytes: number,
      readonly index: number,
      private readonly metadata: typeof mediaMock.metadata,
    ) {}

    async canDecode() {
      if (this.metadata.malformedAt === 'decode-check') {
        throw new Error('broken decoder config');
      }
      return this.metadata.canDecode;
    }
  }
  class Input {
    private readonly metadata = { ...mediaMock.metadata };
    private readonly tracks = this.metadata.track
      ? Array.from(
          { length: this.metadata.trackCount },
          (_, index) =>
            new InputAudioTrack(this.options.source.buffer.byteLength, index, this.metadata),
        )
      : [];

    constructor(readonly options: { formats: unknown[]; source: BufferSource }) {
      mediaMock.inputs.push(options);
    }

    async canRead() {
      if (this.metadata.malformedAt === 'format') {
        throw new Error('broken container');
      }
      return this.metadata.readable;
    }

    async getAudioTracks() {
      if (this.metadata.malformedAt === 'tracks') {
        throw new Error('broken track table');
      }
      return this.tracks;
    }

    async getPrimaryAudioTrack() {
      if (!this.metadata.track || this.metadata.primaryTrackIndex < 0) {
        return null;
      }
      return (
        this.tracks[this.metadata.primaryTrackIndex] ??
        new InputAudioTrack(
          this.options.source.buffer.byteLength,
          this.metadata.primaryTrackIndex,
          this.metadata,
        )
      );
    }

    dispose() {}
  }

  class AudioSampleSink {
    constructor(private readonly track: InputAudioTrack) {
      mediaMock.selectedTrackIndexes.push(track.index);
    }

    samples() {
      const sampleInits =
        mediaMock.sampleSets.get(`${this.track.inputBytes}:${this.track.index}`) ?? [];
      let index = 0;
      return {
        async next() {
          if (mediaMock.metadata.pendingNext) {
            return new Promise<IteratorResult<never>>(() => {});
          }
          if (mediaMock.metadata.malformedAt === 'iteration') {
            throw new Error('broken packet');
          }
          const init = sampleInits[index];
          if (!init) {
            return { done: true, value: undefined };
          }
          const sampleIndex = index++;
          const numberOfFrames = init.numberOfFrames ?? init.channels[0]?.length ?? 0;
          const numberOfChannels = init.numberOfChannels ?? init.channels.length;
          return {
            done: false,
            value: {
              duration: init.duration ?? numberOfFrames / init.sampleRate,
              numberOfChannels,
              numberOfFrames,
              sampleRate: init.sampleRate,
              timestamp: init.timestamp ?? 0,
              close() {
                mediaMock.samplesClosed.push(sampleIndex);
                if (init.closeError) {
                  throw init.closeError;
                }
              },
              copyTo(
                destination: Float32Array,
                options: {
                  format: string;
                  frameCount: number;
                  frameOffset: number;
                  planeIndex: number;
                },
              ) {
                mediaMock.copyCalls++;
                if (init.copyError) {
                  throw init.copyError;
                }
                if (options.format !== 'f32-planar') {
                  throw new Error('unexpected copy format');
                }
                const channel = init.channels[options.planeIndex];
                if (!channel) {
                  destination.fill(0);
                  return;
                }
                destination.set(
                  channel.subarray(options.frameOffset, options.frameOffset + options.frameCount),
                );
              },
            },
          };
        },
        async return() {
          mediaMock.iteratorReturns++;
          if (mediaMock.iteratorReturnError) {
            throw mediaMock.iteratorReturnError;
          }
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }

  const format = (name: string) => ({ name });
  return {
    ADTS: format('ADTS'),
    AudioSampleSink,
    BufferSource,
    FLAC: format('FLAC'),
    Input,
    InputAudioTrack,
    MATROSKA: format('Matroska'),
    MP3: format('MP3'),
    MP4: format('MP4'),
    OGG: format('Ogg'),
    QTFF: format('QuickTime'),
    WAVE: format('WAVE'),
    WEBM: format('WebM'),
  };
});

import {
  AUTO_SYNC_BYOB_CHUNK_BYTES,
  AUTO_SYNC_INPUT_FORMATS,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  computeAutoSyncOffset,
  getUnknownLengthPayloadLimit,
  readResponseBuffer,
  validateAutoSyncOggFraming,
} from '../autoSync';
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_FRAME_SIZE,
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
  AUTO_SYNC_MAX_CORRELATION_TERMS,
  AUTO_SYNC_MAX_DURATION_SECONDS,
  AUTO_SYNC_MAX_LAG_SAMPLES,
  crossCorrelate,
  getCorrelationDimensions,
  parseCorrelationRequest,
} from '../autoSyncCore';

const SAMPLE_RATE = AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
const MEBIBYTE = 1024 * 1024;
const REFERENCE_BYTES = 2;
const TARGET_BYTES = 3;

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

function setDecodedSignal(
  encodedBytes: number,
  channels: Float32Array[],
  sampleRate = SAMPLE_RATE,
  trackIndex = 0,
): void {
  mediaMock.sampleSets.set(`${encodedBytes}:${trackIndex}`, [{ channels, sampleRate }]);
}

function concatenateBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function createOggPage(options: {
  body?: Uint8Array;
  headerType: number;
  lacing?: number[];
  sequence: number;
  serial: number;
  version?: number;
}): Uint8Array {
  const body = options.body ?? Uint8Array.of(options.sequence);
  const lacing: number[] = options.lacing ? [...options.lacing] : [];
  if (!options.lacing) {
    let remaining = body.byteLength;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }

  const page = new Uint8Array(27 + lacing.length + body.byteLength);
  page.set([0x4f, 0x67, 0x67, 0x53]);
  page[4] = options.version ?? 0;
  page[5] = options.headerType;
  const view = new DataView(page.buffer);
  view.setUint32(14, options.serial, true);
  view.setUint32(18, options.sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(body, 27 + lacing.length);
  return page;
}

function isTransferableArrayBuffer(buffer: ArrayBufferLike): buffer is ArrayBuffer {
  return Object.prototype.toString.call(buffer) === '[object ArrayBuffer]';
}

interface StreamResponse extends Response {
  arrayBuffer: ReturnType<typeof vi.fn>;
  bodyCancel: ReturnType<typeof vi.fn>;
  byobReader: {
    cancel: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  reader: {
    cancel: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
}

function createStreamResponse(options: {
  body?: boolean;
  byobOwnership?: 'invalid' | 'valid';
  chunks?: Uint8Array[];
  contentLength?: number;
  pendingRead?: boolean;
  byobReadSizes?: number[];
  readerCancel?: () => Promise<void>;
  status?: number;
  supportsByob?: boolean;
}): StreamResponse {
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
    cancel: vi.fn(options.readerCancel ?? (async () => {})),
    releaseLock: vi.fn(),
  };
  const byobReader = {
    read: vi.fn((view: ArrayBufferView) => {
      options.byobReadSizes?.push(view.byteLength);
      if (chunks.length === 0) {
        if (isTransferableArrayBuffer(view.buffer)) {
          structuredClone(view.buffer, { transfer: [view.buffer] });
        }
        return Promise.resolve({
          done: true as const,
          value: undefined,
        });
      }

      const source = chunks[0];
      const bytesRead = Math.min(source.byteLength, view.byteLength);
      const requestOffset = view.byteOffset;
      new Uint8Array(view.buffer, view.byteOffset, bytesRead).set(source.subarray(0, bytesRead));
      if (bytesRead === source.byteLength) {
        chunks.shift();
      } else {
        chunks[0] = source.subarray(bytesRead);
      }
      if (!isTransferableArrayBuffer(view.buffer)) {
        throw new TypeError('Expected an ArrayBuffer-backed BYOB request');
      }
      const returnedOwner = structuredClone(view.buffer, {
        transfer: [view.buffer],
      });
      if (options.byobOwnership === 'invalid') {
        return Promise.resolve({
          done: false as const,
          value: new Uint8Array(returnedOwner.slice(requestOffset, requestOffset + bytesRead)),
        });
      }
      return Promise.resolve({
        done: false as const,
        value: new Uint8Array(returnedOwner, requestOffset, bytesRead),
      });
    }),
    cancel: vi.fn(options.readerCancel ?? (async () => {})),
    releaseLock: vi.fn(),
  };
  const bodyCancel = vi.fn(async () => {});
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      options.contentLength === undefined
        ? undefined
        : { 'content-length': String(options.contentLength) },
    ),
    body:
      options.body === false
        ? null
        : ({
            cancel: bodyCancel,
            getReader: (readerOptions?: { mode?: string }) => {
              if (readerOptions?.mode === 'byob') {
                if (!options.supportsByob) {
                  throw new TypeError('BYOB is not supported');
                }
                return byobReader;
              }
              return reader;
            },
          } as unknown as ReadableStream<Uint8Array>),
    arrayBuffer: vi.fn(),
    bodyCancel,
    byobReader,
    reader,
  } as unknown as StreamResponse;
}

let decodedReference: Float32Array;
let decodedTarget: Float32Array;
let fetchedUrls: string[];
let workerCreations: number;
let workerInputs: Array<{ reference: Float32Array; target: Float32Array }>;
let workerTerminations: number;

class MockAutoSyncWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  protected terminated = false;

  constructor() {
    workerCreations++;
  }

  postMessage(value: unknown) {
    if (this.terminated) {
      return;
    }
    const message = parseCorrelationRequest(value);
    workerInputs.push({
      reference: Float32Array.from(message.reference),
      target: Float32Array.from(message.target),
    });
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
  workerCreations = 0;
  workerInputs = [];
  workerTerminations = 0;
  mediaMock.inputs.length = 0;
  mediaMock.copyCalls = 0;
  mediaMock.iteratorReturnError = null;
  mediaMock.iteratorReturns = 0;
  mediaMock.sampleSets.clear();
  mediaMock.samplesClosed.length = 0;
  mediaMock.selectedTrackIndexes.length = 0;
  Object.assign(mediaMock.metadata, {
    canDecode: true,
    format: 'MP3',
    malformedAt: null,
    hasVideo: false,
    pendingNext: false,
    primaryTrackIndex: 0,
    readable: true,
    track: true,
    trackCount: 1,
  });
  decodedReference = createAsymmetricPulseSignal(250);
  decodedTarget = delaySignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);
  setDecodedSignal(REFERENCE_BYTES, [decodedReference]);
  setDecodedSignal(TARGET_BYTES, [decodedTarget]);

  vi.stubGlobal('Worker', MockAutoSyncWorker);
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        throw new Error('Web Audio must not be constructed');
      }
    },
  );
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      constructor() {
        throw new Error('Web Audio must not be constructed');
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      const isTarget = url.includes('target') || url === 'blob:tar';
      const bytes = new Uint8Array(isTarget ? TARGET_BYTES : REFERENCE_BYTES);
      return createStreamResponse({
        chunks: [bytes],
        contentLength: bytes.byteLength,
      });
    }),
  );
});

describe('readResponseBuffer', () => {
  it('accepts one 48 MiB declared chunk within the 96 MiB encoded peak', async () => {
    const chunk = new Uint8Array(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT);
    const response = createStreamResponse({
      chunks: [chunk],
      contentLength: chunk.byteLength,
    });

    await expect(
      readResponseBuffer(
        response,
        AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
        'too large',
        undefined,
        chunk.byteLength,
      ),
    ).resolves.toHaveProperty('byteLength', chunk.byteLength);
    expect(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT).toBe(48 * MEBIBYTE);
    expect(AUTO_SYNC_MAX_ENCODED_PEAK_BYTES).toBe(96 * MEBIBYTE);
  });

  it('caps declared BYOB scratch reads at 64 KiB', async () => {
    const byobReadSizes: number[] = [];
    const payload = new Uint8Array(AUTO_SYNC_BYOB_CHUNK_BYTES + 10);
    const response = createStreamResponse({
      byobReadSizes,
      chunks: [payload],
      contentLength: payload.byteLength,
      supportsByob: true,
    });

    await expect(
      readResponseBuffer(response, payload.byteLength, 'too large', undefined, payload.byteLength),
    ).resolves.toHaveProperty('byteLength', payload.byteLength);
    expect(Math.max(...byobReadSizes)).toBe(AUTO_SYNC_BYOB_CHUNK_BYTES);
  });

  it('caps unknown-length payloads at 48 MiB and rejects larger input', async () => {
    expect(getUnknownLengthPayloadLimit(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT)).toBe(
      AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
    );
    const accepted = createStreamResponse({
      chunks: [new Uint8Array(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT)],
    });
    await expect(
      readResponseBuffer(accepted, AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT, 'too large', undefined),
    ).resolves.toHaveProperty('byteLength', AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT);

    const rejected = createStreamResponse({
      chunks: [new Uint8Array(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT + 1)],
    });
    await expect(
      readResponseBuffer(rejected, AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT, 'too large', undefined),
    ).rejects.toMatchObject({ code: 'encoded-limit' });
    expect(rejected.reader.cancel).toHaveBeenCalled();
  });

  it('rejects a duplicate incoming chunk before allocating a declared destination', async () => {
    const response = createStreamResponse({
      chunks: [new Uint8Array(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT + 1)],
      contentLength: AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
    });

    await expect(
      readResponseBuffer(
        response,
        AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
        'too large',
        undefined,
        AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
      ),
    ).rejects.toMatchObject({ code: 'content-length-mismatch' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });

  it('accounts retained analysis bytes before fallback destination allocation', async () => {
    const response = createStreamResponse({
      chunks: [new Uint8Array(8)],
      contentLength: 8,
    });

    await expect(
      readResponseBuffer(response, 12, 'bounded peak', undefined, 8, 18, 4),
    ).rejects.toMatchObject({ code: 'encoded-limit' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });

  it('rechecks retained peak admission for later fallback chunks', async () => {
    const response = createStreamResponse({
      chunks: [new Uint8Array(2), new Uint8Array(8)],
      contentLength: 10,
    });

    await expect(
      readResponseBuffer(response, 12, 'bounded peak', undefined, 10, 20, 4),
    ).rejects.toMatchObject({ code: 'encoded-limit' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });

  it.each([
    ['declared', 3],
    ['unknown', undefined],
  ])(
    'copies the returned %s reader view using its exact offset and ownership',
    async (_name, declared) => {
      const owner = Uint8Array.of(99, 1, 2, 3, 99);
      const response = createStreamResponse({
        chunks: [owner.subarray(1, 4)],
        contentLength: declared,
      });

      const buffer = await readResponseBuffer(response, 3, 'too large', undefined, declared, 8);

      expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
      expect(buffer).not.toBe(owner.buffer);
    },
  );

  it.each([
    ['declared', 3],
    ['unknown', undefined],
  ])(
    'rejects a sliced %s reader view whose retained owner exceeds the peak',
    async (_name, declared) => {
      const owner = Uint8Array.of(99, 99, 1, 2, 3, 99, 99);
      const response = createStreamResponse({
        chunks: [owner.subarray(2, 5)],
        contentLength: declared,
      });

      await expect(
        readResponseBuffer(response, 3, 'bounded owner', undefined, declared, 6),
      ).rejects.toMatchObject({ code: 'encoded-limit' });
      expect(response.reader.cancel).toHaveBeenCalled();
    },
  );

  it('handles detached BYOB requests and returned views with different owners and offsets', async () => {
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1), Uint8Array.of(2, 3)],
      contentLength: 3,
      supportsByob: true,
    });

    const buffer = await readResponseBuffer(response, 3, 'too large', undefined, 3);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
    expect(response.byobReader.read).toHaveBeenCalledTimes(3);
    expect(response.byobReader.read.mock.results[0].value).toBeInstanceOf(Promise);
    expect(response.reader.read).not.toHaveBeenCalled();
  });

  it('uses a BYOB sentinel read to cancel an overdeclared stream', async () => {
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3)],
      contentLength: 2,
      supportsByob: true,
    });

    await expect(readResponseBuffer(response, 3, 'too large', undefined, 2)).rejects.toMatchObject({
      code: 'content-length-mismatch',
    });
    expect(response.byobReader.cancel).toHaveBeenCalled();
    expect(response.reader.read).not.toHaveBeenCalled();
  });

  it('cancels a short BYOB stream that ends before Content-Length', async () => {
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1, 2)],
      contentLength: 3,
      supportsByob: true,
    });

    await expect(readResponseBuffer(response, 3, 'too large', undefined, 3)).rejects.toMatchObject({
      code: 'content-length-mismatch',
    });
    expect(response.byobReader.cancel).toHaveBeenCalled();
  });

  it('rejects incompatible BYOB buffer ownership before using the returned view', async () => {
    const response = createStreamResponse({
      byobOwnership: 'invalid',
      chunks: [Uint8Array.of(1)],
      contentLength: 3,
      supportsByob: true,
    });

    await expect(readResponseBuffer(response, 3, 'too large', undefined, 3)).rejects.toMatchObject({
      code: 'content-length-mismatch',
      message: expect.stringContaining('buffer ownership'),
    });
    expect(response.byobReader.cancel).toHaveBeenCalled();
  });

  it('rejects a null response body instead of using arrayBuffer()', async () => {
    const response = createStreamResponse({ body: false });

    await expect(readResponseBuffer(response, 8, 'too large', undefined)).rejects.toMatchObject({
      code: 'missing-response-body',
    });
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['short', [Uint8Array.of(1, 2)], 3],
    ['long', [Uint8Array.of(1, 2, 3)], 2],
  ])('cancels a %s response that differs from Content-Length', async (_name, chunks, declared) => {
    const response = createStreamResponse({ chunks, contentLength: declared });

    await expect(
      readResponseBuffer(response, 8, 'too large', undefined, declared),
    ).rejects.toMatchObject({ code: 'content-length-mismatch' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });

  it('preserves AbortError when stream cancellation rejects', async () => {
    const response = createStreamResponse({
      pendingRead: true,
      readerCancel: async () => {
        throw new Error('cancel failed');
      },
    });
    const controller = new AbortController();
    const pending = readResponseBuffer(response, 8, 'too large', controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });
});

describe('validateAutoSyncOggFraming', () => {
  it('accepts a valid single logical stream', () => {
    const ogg = concatenateBytes(
      createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
      createOggPage({ headerType: 0x00, sequence: 1, serial: 11 }),
      createOggPage({ headerType: 0x04, sequence: 2, serial: 11 }),
    );

    expect(() => validateAutoSyncOggFraming(ogg.buffer, 'reference')).not.toThrow();
  });

  it('allows initially multiplexed streams and preserves Mediabunny primary selection', async () => {
    const ogg = concatenateBytes(
      createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
      createOggPage({ headerType: 0x02, sequence: 0, serial: 22 }),
      createOggPage({ headerType: 0x04, sequence: 1, serial: 11 }),
      createOggPage({ headerType: 0x04, sequence: 1, serial: 22 }),
    );
    Object.assign(mediaMock.metadata, { primaryTrackIndex: 1, trackCount: 2 });
    mediaMock.sampleSets.set(`${ogg.byteLength}:1`, [
      { channels: [decodedReference], sampleRate: SAMPLE_RATE },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createStreamResponse({
          chunks: [ogg],
          contentLength: ogg.byteLength,
        }),
      ),
    );

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(mediaMock.selectedTrackIndexes).toEqual([1, 1]);
  });

  it('rejects a sequential chained logical stream before decoding', async () => {
    const ogg = concatenateBytes(
      createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
      createOggPage({ headerType: 0x04, sequence: 1, serial: 11 }),
      createOggPage({ headerType: 0x02, sequence: 0, serial: 22 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createStreamResponse({
          chunks: [ogg],
          contentLength: ogg.byteLength,
        }),
      ),
    );

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'unsupported-chained-ogg',
      message: expect.stringContaining('chained Ogg logical streams'),
    });
    expect(mediaMock.inputs).toHaveLength(0);
  });

  it.each([
    [
      'truncated body',
      () => {
        const page = createOggPage({
          body: Uint8Array.of(1, 2, 3),
          headerType: 0x02,
          sequence: 0,
          serial: 11,
        });
        return page.slice(0, -1);
      },
    ],
    [
      'invalid version',
      () => createOggPage({ headerType: 0x02, sequence: 0, serial: 11, version: 1 }),
    ],
    [
      'broken sequence',
      () =>
        concatenateBytes(
          createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
          createOggPage({ headerType: 0x04, sequence: 2, serial: 11 }),
        ),
    ],
    [
      'corrupt later capture',
      () =>
        concatenateBytes(
          createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
          Uint8Array.of(0x4f, 0x67, 0x67, 0x00),
        ),
    ],
    [
      'unfinished logical stream',
      () => createOggPage({ headerType: 0x02, sequence: 0, serial: 11 }),
    ],
    [
      'empty continued page',
      () =>
        concatenateBytes(
          createOggPage({
            body: new Uint8Array(255),
            headerType: 0x02,
            lacing: [255],
            sequence: 0,
            serial: 11,
          }),
          createOggPage({
            body: new Uint8Array(0),
            headerType: 0x05,
            lacing: [],
            sequence: 1,
            serial: 11,
          }),
        ),
    ],
    [
      'too many initial logical streams',
      () =>
        concatenateBytes(
          ...Array.from({ length: 17 }, (_, index) =>
            createOggPage({
              headerType: 0x02,
              sequence: 0,
              serial: index + 1,
            }),
          ),
        ),
    ],
  ])('rejects %s framing before decode', (_name, createBytes) => {
    expect(() => validateAutoSyncOggFraming(createBytes().buffer, 'reference')).toThrow(
      expect.objectContaining({ code: 'malformed-media' }),
    );
  });

  it('does not treat OggS bytes inside a page payload as another page', () => {
    const payload = Uint8Array.of(1, 0x4f, 0x67, 0x67, 0x53, 2);
    const ogg = concatenateBytes(
      createOggPage({ body: payload, headerType: 0x02, sequence: 0, serial: 11 }),
      createOggPage({ headerType: 0x04, sequence: 1, serial: 11 }),
    );

    expect(() => validateAutoSyncOggFraming(ogg.buffer)).not.toThrow();
  });
});

describe('incremental Mediabunny decoding', () => {
  it.each([
    ['MP4 video', 'MP4'],
    ['MOV video', 'QuickTime'],
    ['WebM video', 'WebM'],
    ['M4A audio', 'MP4'],
    ['AAC audio', 'ADTS'],
    ['Ogg audio', 'Ogg'],
    ['FLAC audio', 'FLAC'],
    ['MP3 audio', 'MP3'],
    ['WAV audio', 'WAVE'],
  ])('uses Mediabunny primary-track decoding for %s', async (_name, format) => {
    Object.assign(mediaMock.metadata, { format, hasVideo: format !== 'MP3' });

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).resolves.toEqual({
      confidence: expect.any(Number),
      offsetSeconds: expect.any(Number),
    });

    expect(mediaMock.inputs).toHaveLength(2);
    expect(mediaMock.inputs.every((input) => input.formats === AUTO_SYNC_INPUT_FORMATS)).toBe(true);
    expect(mediaMock.selectedTrackIndexes).toEqual([0, 0]);
    expect(mediaMock.samplesClosed).toEqual([0, 0]);
    expect(mediaMock.iteratorReturns).toBe(2);
  });

  it('selects only Mediabunny primary audio tracks deterministically', async () => {
    Object.assign(mediaMock.metadata, { primaryTrackIndex: 1, trackCount: 3 });
    setDecodedSignal(REFERENCE_BYTES, [decodedReference], SAMPLE_RATE, 1);
    setDecodedSignal(TARGET_BYTES, [decodedTarget], SAMPLE_RATE, 1);

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    expect(mediaMock.selectedTrackIndexes).toEqual([1, 1]);
  });

  it('keeps adjacent fractional-timestamp samples continuous while resampling', async () => {
    const sourceRate = 12_000;
    const left = Float32Array.from({ length: sourceRate }, (_, index) => index / sourceRate);
    const right = Float32Array.from({ length: sourceRate }, (_, index) => index / sourceRate / 2);
    const split = 5_000;
    const samples = [
      {
        channels: [left.subarray(0, split), right.subarray(0, split)],
        sampleRate: sourceRate,
        timestamp: 0,
      },
      {
        channels: [left.subarray(split), right.subarray(split)],
        sampleRate: sourceRate,
        timestamp: (split + 0.1) / sourceRate,
      },
    ];
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, samples);
    mediaMock.sampleSets.set(`${TARGET_BYTES}:0`, samples);

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    const output = workerInputs[0]!.reference;
    expect(output).toHaveLength(SAMPLE_RATE);
    expect(output[0]).toBe(0);
    expect(output[3_333]).toBeCloseTo((4_999.5 / sourceRate) * 0.75, 6);
    expect(output.at(-1)).toBeCloseTo((11_998.5 / sourceRate) * 0.75, 6);
    expect(mediaMock.samplesClosed).toEqual([0, 1, 0, 1]);
  });

  it('trims negative pre-roll before placing decoded PCM', async () => {
    const samples = [
      {
        channels: [
          Float32Array.from({ length: SAMPLE_RATE + SAMPLE_RATE / 2 }, (_, index) =>
            index < SAMPLE_RATE / 2 ? 1 : 0.25,
          ),
        ],
        sampleRate: SAMPLE_RATE,
        timestamp: -0.5,
      },
    ];
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, samples);
    mediaMock.sampleSets.set(`${TARGET_BYTES}:0`, samples);

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    const output = workerInputs[0]!.reference;
    expect(output).toHaveLength(SAMPLE_RATE);
    expect(output.every((sample) => sample === 0.25)).toBe(true);
  });

  it('inserts silence for a positive one-second presentation gap', async () => {
    const samples = [
      {
        channels: [new Float32Array(SAMPLE_RATE).fill(1)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0,
      },
      {
        channels: [new Float32Array(SAMPLE_RATE).fill(2)],
        sampleRate: SAMPLE_RATE,
        timestamp: 2,
      },
    ];
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, samples);
    mediaMock.sampleSets.set(`${TARGET_BYTES}:0`, samples);

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    const output = workerInputs[0]!.reference;
    expect(output).toHaveLength(SAMPLE_RATE * 3);
    expect(output.subarray(0, SAMPLE_RATE).every((sample) => sample === 1)).toBe(true);
    expect(output.subarray(SAMPLE_RATE, SAMPLE_RATE * 2).every((sample) => sample === 0)).toBe(
      true,
    );
    expect(output.subarray(SAMPLE_RATE * 2).every((sample) => sample === 2)).toBe(true);
  });

  it('trims overlapping leading frames instead of duplicating them', async () => {
    const samples = [
      {
        channels: [new Float32Array(SAMPLE_RATE).fill(1)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0,
      },
      {
        channels: [new Float32Array(SAMPLE_RATE).fill(2)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0.5,
      },
    ];
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, samples);
    mediaMock.sampleSets.set(`${TARGET_BYTES}:0`, samples);

    await computeAutoSyncOffset('blob:reference', 'blob:target');

    const output = workerInputs[0]!.reference;
    expect(output).toHaveLength(SAMPLE_RATE + SAMPLE_RATE / 2);
    expect(output.subarray(0, SAMPLE_RATE).every((sample) => sample === 1)).toBe(true);
    expect(output.subarray(SAMPLE_RATE).every((sample) => sample === 2)).toBe(true);
  });

  it('rejects a timestamp gap that would bypass the maximum timeline duration', async () => {
    const sample = {
      channels: [new Float32Array(SAMPLE_RATE)],
      sampleRate: SAMPLE_RATE,
      timestamp: AUTO_SYNC_MAX_DURATION_SECONDS,
    };
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [sample]);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'invalid-metadata',
      message: expect.stringContaining('too long'),
    });
    expect(mediaMock.copyCalls).toBe(0);
    expect(mediaMock.samplesClosed).toEqual([0]);
  });

  it('rejects non-monotonic timestamps and sample-rate changes', async () => {
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      {
        channels: [new Float32Array(SAMPLE_RATE)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0.5,
      },
      {
        channels: [new Float32Array(SAMPLE_RATE)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0.25,
      },
    ]);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'invalid-metadata',
      message: expect.stringContaining('non-monotonic'),
    });

    mediaMock.samplesClosed.length = 0;
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      {
        channels: [new Float32Array(SAMPLE_RATE)],
        sampleRate: SAMPLE_RATE,
        timestamp: 0,
      },
      {
        channels: [new Float32Array(SAMPLE_RATE * 2)],
        sampleRate: SAMPLE_RATE * 2,
        timestamp: 1,
      },
    ]);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'invalid-metadata',
      message: expect.stringContaining('changed sample rate'),
    });
  });

  it('rejects cumulative decoded bytes before copying the sample that crosses the budget', async () => {
    expect(AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT).toBe(128 * MEBIBYTE);
    const first = new Float32Array(SAMPLE_RATE);
    const remainingFrames =
      (AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT - first.byteLength) / Float32Array.BYTES_PER_ELEMENT;
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      { channels: [first], sampleRate: SAMPLE_RATE },
      {
        channels: [Float32Array.of(0)],
        duration: (remainingFrames + 1) / SAMPLE_RATE,
        numberOfFrames: remainingFrames + 1,
        sampleRate: SAMPLE_RATE,
        timestamp: 1,
      },
    ]);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'decoded-limit',
    });
    expect(mediaMock.copyCalls).toBe(1);
    expect(mediaMock.samplesClosed).toEqual([0, 1]);
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('closes the current sample and returns the iterator on copy errors', async () => {
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      {
        channels: [decodedReference],
        copyError: new Error('primary copy failure'),
        sampleRate: SAMPLE_RATE,
      },
    ]);
    mediaMock.iteratorReturnError = new Error('return cleanup failed');

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'malformed-media',
      originalCause: expect.objectContaining({ message: 'primary copy failure' }),
    });
    expect(mediaMock.samplesClosed).toEqual([0]);
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('closes a sample and returns the iterator when cooperative decode work is aborted', async () => {
    const controller = new AbortController();
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      { channels: [new Float32Array(300_000)], sampleRate: SAMPLE_RATE },
    ]);
    const pending = computeAutoSyncOffset('blob:reference', 'blob:target', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mediaMock.samplesClosed).toEqual([0]);
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('returns a pending iterator on abort and preserves AbortError over cleanup failure', async () => {
    Object.assign(mediaMock.metadata, { pendingNext: true });
    mediaMock.iteratorReturnError = new Error('return cleanup failed');
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:reference', 'blob:target', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mediaMock.selectedTrackIndexes).toEqual([0]));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it.each([
    ['no-audio-track', { track: false }],
    ['unknown-format', { readable: false }],
    ['malformed-media', { malformedAt: 'format' }],
    ['malformed-media', { malformedAt: 'tracks' }],
    ['malformed-media', { malformedAt: 'decode-check' }],
    ['malformed-media', { malformedAt: 'iteration' }],
    ['unknown-codec', { canDecode: false }],
  ])('returns typed %s errors for unusable media', async (code, metadata) => {
    Object.assign(mediaMock.metadata, metadata);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code,
      name: 'AutoSyncMediaError',
    });
  });

  it('rejects empty decoded audio', async () => {
    mediaMock.sampleSets.delete(`${REFERENCE_BYTES}:0`);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toThrow(
      'no usable duration',
    );
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it.each([
    ['sample rate', { sampleRate: 0 }],
    ['channels', { numberOfChannels: 0 }],
    ['frames', { numberOfFrames: 0 }],
    ['timestamp', { timestamp: Number.POSITIVE_INFINITY }],
    ['unplaceable timestamp', { timestamp: 0.5 / SAMPLE_RATE }],
    ['duration', { duration: Number.NaN }],
    ['inconsistent duration', { duration: 40_001 / SAMPLE_RATE }],
  ])('rejects malformed AudioSample %s metadata and closes it', async (_name, override) => {
    mediaMock.sampleSets.set(`${REFERENCE_BYTES}:0`, [
      {
        channels: [decodedReference],
        sampleRate: SAMPLE_RATE,
        ...override,
      },
    ]);

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).rejects.toMatchObject({
      code: 'invalid-metadata',
    });
    expect(mediaMock.copyCalls).toBe(0);
    expect(mediaMock.samplesClosed).toEqual([0]);
    expect(mediaMock.iteratorReturns).toBe(1);
  });
});

describe('computeAutoSyncOffset', () => {
  it('preserves signed offsets in both directions', async () => {
    const delayed = await computeAutoSyncOffset('blob:reference', 'blob:target');
    expect(delayed.offsetSeconds).toBeCloseTo(-0.5, 5);
    expect(delayed.confidence).toBeGreaterThan(0.9);

    decodedTarget = advanceSignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);
    setDecodedSignal(TARGET_BYTES, [decodedTarget]);
    const advanced = await computeAutoSyncOffset('blob:reference', 'blob:target');
    expect(advanced.offsetSeconds).toBeCloseTo(0.5, 5);
    expect(advanced.confidence).toBeGreaterThan(0.9);
  });

  it('fetches and incrementally decodes inputs sequentially without Web Audio', async () => {
    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(fetchedUrls).toEqual(['blob:ref', 'blob:tar']);
    expect(mediaMock.inputs.map((input) => input.source.buffer.byteLength)).toEqual([
      REFERENCE_BYTES,
      TARGET_BYTES,
    ]);
    expect(mediaMock.iteratorReturns).toBe(2);
  });

  it('cancels non-OK and oversized declared responses without masking primary errors', async () => {
    const rejected = createStreamResponse({ status: 503 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => rejected),
    );
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Failed to fetch reference audio: HTTP 503',
    );
    expect(rejected.bodyCancel).toHaveBeenCalledOnce();

    const oversized = createStreamResponse({
      contentLength: AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT + 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => oversized),
    );
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      code: 'encoded-limit',
      message: expect.stringContaining('48 MiB auto-sync encoded-input limit'),
    });
    expect(oversized.bodyCancel).toHaveBeenCalledOnce();
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
    await vi.waitFor(() => expect(workerCreations).toBe(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(workerTerminations).toBe(2);
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
