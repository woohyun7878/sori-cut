import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockAudioSample {
  close: ReturnType<typeof vi.fn>;
  copyTo: ReturnType<typeof vi.fn>;
  duration: number;
  numberOfChannels: number;
  numberOfFrames: number;
  sampleRate: number;
  timestamp: number;
}

const mediaMock = vi.hoisted(() => ({
  activeIterators: 0,
  inputs: [] as Array<{ formats: unknown[]; source: { buffer: ArrayBuffer } }>,
  iteratorReturns: 0,
  iteratorReturnError: null as Error | null,
  iterators: [] as Array<{
    next: ReturnType<typeof vi.fn>;
    return: ReturnType<typeof vi.fn>;
  }>,
  maximumActiveIterators: 0,
  sampleFactory: null as null | ((buffer: ArrayBuffer) => MockAudioSample[]),
  selectedTrackIndexes: [] as number[],
  metadata: {
    canDecode: true,
    channels: 1,
    codec: 'mp3' as string | null,
    format: 'MP3',
    malformedAt: null as 'format' | 'decode' | null,
    hasVideo: false,
    primaryTrackIndex: 0,
    readable: true,
    sampleRate: 8_000,
    track: true,
    tracks: null as
      | Array<{
         canDecode?: boolean;
         channels: number;
         codec: string | null;
         sampleRate: number;
       }>
      | null,
  },
}));

vi.mock('mediabunny', () => {
  class BufferSource {
    constructor(readonly buffer: ArrayBuffer) {}
  }
  class Input {
    private readonly metadata = { ...mediaMock.metadata };
    private readonly tracks = (
      this.metadata.track ? (this.metadata.tracks ?? [this.metadata]) : []
    ).map((metadata, index) => this.createTrack(metadata, index));

    constructor(readonly options: { formats: unknown[]; source: BufferSource }) {
      mediaMock.inputs.push(options);
    }

    async canRead() {
      if (this.metadata.malformedAt === 'format') {
        throw new Error('broken container');
      }
      return this.metadata.readable;
    }

    async getFormat() {
      return { name: this.metadata.format };
    }

    async getAudioTracks() {
      return this.tracks;
    }

    async getPrimaryAudioTrack() {
      if (!this.metadata.track || this.metadata.primaryTrackIndex < 0) {
        return null;
      }
      return (
        this.tracks[this.metadata.primaryTrackIndex] ??
        this.createTrack(this.metadata, this.metadata.primaryTrackIndex)
      );
    }

    async getVideoTracks() {
      return this.metadata.hasVideo ? [{}] : [];
    }

    private createTrack(metadata: {
      canDecode?: boolean;
      channels: number;
      codec: string | null;
      sampleRate: number;
    }, index: number) {
      return {
        canDecode: async () => metadata.canDecode ?? this.metadata.canDecode,
        index,
        source: this.options.source,
      };
    }

    dispose() {}
  }

  class AudioSampleSink {
    constructor(private readonly track: { index: number; source: BufferSource }) {
      mediaMock.selectedTrackIndexes.push(track.index);
    }

    samples() {
      const samples = mediaMock.sampleFactory?.(this.track.source.buffer) ?? [];
      let index = 0;
      let active = false;
      const finish = () => {
        if (active) {
          active = false;
          mediaMock.activeIterators--;
        }
      };
      const iterator = {
        next: vi.fn(async () => {
          if (!active) {
            active = true;
            mediaMock.activeIterators++;
            mediaMock.maximumActiveIterators = Math.max(
              mediaMock.maximumActiveIterators,
              mediaMock.activeIterators,
            );
          }
          if (mediaMock.metadata.malformedAt === 'decode') {
            finish();
            throw new Error('primary decode failure');
          }
          if (index >= samples.length) {
            finish();
            return { done: true as const, value: undefined };
          }
          return { done: false as const, value: samples[index++] };
        }),
        return: vi.fn(async () => {
          mediaMock.iteratorReturns++;
          finish();
          while (index < samples.length) {
            samples[index++].close();
          }
          if (mediaMock.iteratorReturnError) {
            throw mediaMock.iteratorReturnError;
          }
          return { done: true as const, value: undefined };
        }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      mediaMock.iterators.push(iterator);
      return iterator;
    }
  }

  const format = (name: string) => ({ name });
  return {
    ADTS: format('ADTS'),
    AudioSampleSink,
    BufferSource,
    FLAC: format('FLAC'),
    Input,
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
  DECODE_YIELD_FRAME_INTERVAL,
  AUTO_SYNC_INPUT_FORMATS,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  computeAutoSyncOffset,
  decodeEncodedAudioToMono,
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

function createMockAudioSample(
  channelData: Float32Array[],
  sampleRate = SAMPLE_RATE,
  timestamp = 0,
): MockAudioSample {
  const numberOfFrames = channelData[0]?.length ?? 0;
  return {
    close: vi.fn(),
    copyTo: vi.fn(
      (
        destination: Float32Array,
        options: {
          frameCount?: number;
          frameOffset?: number;
          planeIndex: number;
        },
      ) => {
        const frameOffset = options.frameOffset ?? 0;
        const frameCount = options.frameCount ?? numberOfFrames - frameOffset;
        destination.set(
          channelData[options.planeIndex].subarray(frameOffset, frameOffset + frameCount),
        );
      },
    ),
    duration: numberOfFrames / sampleRate,
    numberOfChannels: channelData.length,
    numberOfFrames,
    sampleRate,
    timestamp,
  };
}

interface OggPageOptions {
  body?: readonly number[];
  flags: number;
  sequence: number;
  serial: number;
  version?: number;
}

function createOggPage({
  body = [],
  flags,
  sequence,
  serial,
  version = 0,
}: OggPageOptions): Uint8Array {
  const lacingValues: number[] = [];
  let remaining = body.length;
  while (remaining >= 255) {
    lacingValues.push(255);
    remaining -= 255;
  }
  lacingValues.push(remaining);
  if (lacingValues.length > 255) {
    throw new Error('Test Ogg page body is too large');
  }

  const page = new Uint8Array(27 + lacingValues.length + body.length);
  page.set([0x4f, 0x67, 0x67, 0x53, version, flags]);
  const view = new DataView(page.buffer);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacingValues.length;
  page.set(lacingValues, 27);
  page.set(body, 27 + lacingValues.length);
  return page;
}

function createOggBuffer(...pages: Uint8Array[]): ArrayBuffer {
  const output = new Uint8Array(
    pages.reduce((totalBytes, page) => totalBytes + page.byteLength, 0),
  );
  let offset = 0;
  for (const page of pages) {
    output.set(page, offset);
    offset += page.byteLength;
  }
  return output.buffer;
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
      new Uint8Array(view.buffer, view.byteOffset, bytesRead).set(
        source.subarray(0, bytesRead),
      );
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
  workerTerminations = 0;
  mediaMock.activeIterators = 0;
  mediaMock.inputs.length = 0;
  mediaMock.iteratorReturns = 0;
  mediaMock.iteratorReturnError = null;
  mediaMock.iterators.length = 0;
  mediaMock.maximumActiveIterators = 0;
  mediaMock.selectedTrackIndexes.length = 0;
  Object.assign(mediaMock.metadata, {
    canDecode: true,
    channels: 1,
    codec: 'mp3',
    format: 'MP3',
    malformedAt: null,
    hasVideo: false,
    primaryTrackIndex: 0,
    readable: true,
    sampleRate: SAMPLE_RATE,
    track: true,
    tracks: null,
  });
  decodedReference = createAsymmetricPulseSignal(250);
  decodedTarget = delaySignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);
  mediaMock.sampleFactory = (buffer) => [
    createMockAudioSample([
      buffer.byteLength === TARGET_BYTES ? decodedTarget : decodedReference,
    ]),
  ];

  vi.stubGlobal('Worker', MockAutoSyncWorker);
  vi.stubGlobal('AudioContext', vi.fn(() => {
    throw new Error('Web Audio must not be constructed');
  }));
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
      readResponseBuffer(
        response,
        payload.byteLength,
        'too large',
        undefined,
        payload.byteLength,
      ),
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
      readResponseBuffer(
        accepted,
        AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
        'too large',
        undefined,
      ),
    ).resolves.toHaveProperty('byteLength', AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT);

    const rejected = createStreamResponse({
      chunks: [new Uint8Array(AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT + 1)],
    });
    await expect(
      readResponseBuffer(
        rejected,
        AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
        'too large',
        undefined,
      ),
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
  ])('copies the returned %s reader view using its exact offset and ownership', async (_name, declared) => {
    const owner = Uint8Array.of(99, 1, 2, 3, 99);
    const response = createStreamResponse({
      chunks: [owner.subarray(1, 4)],
      contentLength: declared,
    });

    const buffer = await readResponseBuffer(response, 3, 'too large', undefined, declared, 8);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
    expect(buffer).not.toBe(owner.buffer);
  });

  it.each([
    ['declared', 3],
    ['unknown', undefined],
  ])('rejects a sliced %s reader view whose retained owner exceeds the peak', async (_name, declared) => {
    const owner = Uint8Array.of(99, 99, 1, 2, 3, 99, 99);
    const response = createStreamResponse({
      chunks: [owner.subarray(2, 5)],
      contentLength: declared,
    });

    await expect(
      readResponseBuffer(response, 3, 'bounded owner', undefined, declared, 6),
    ).rejects.toMatchObject({ code: 'encoded-limit' });
    expect(response.reader.cancel).toHaveBeenCalled();
  });

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

describe('decodeEncodedAudioToMono', () => {
  it.each([
    ['MP4 video reference', 'MP4', 'aac'],
    ['MOV video reference', 'QuickTime', 'aac'],
    ['WebM video reference', 'WebM', 'opus'],
    ['MP3 audio', 'MP3', 'mp3'],
    ['M4A audio', 'MP4', 'aac'],
    ['AAC audio', 'ADTS', 'aac'],
    ['Ogg audio', 'Ogg', 'vorbis'],
    ['FLAC audio', 'FLAC', 'flac'],
    ['WAV audio', 'WAVE', 'pcm-s16'],
  ])('incrementally decodes %s through the selected track', async (_name, format, codec) => {
    Object.assign(mediaMock.metadata, {
      codec,
      format,
    });
    const sample = createMockAudioSample([
      Float32Array.of(1, 0, -1),
      Float32Array.of(-1, 1, 1),
    ]);
    mediaMock.sampleFactory = () => [sample];

    const result = await decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference');

    expect([...result]).toEqual([0, 0.5, 0]);
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mediaMock.inputs.at(-1)?.formats).toEqual(AUTO_SYNC_INPUT_FORMATS);
  });

  it('uses the deterministic primary track without decoding unrelated tracks', async () => {
    Object.assign(mediaMock.metadata, {
      format: 'MP4',
      hasVideo: true,
      primaryTrackIndex: 1,
      tracks: [
        { channels: 1, codec: 'aac', sampleRate: 48_000 },
        { channels: 2, codec: 'aac', sampleRate: 44_100 },
      ],
    });
    mediaMock.sampleFactory = () => [
      createMockAudioSample([Float32Array.of(1, 2, 3)]),
    ];

    await decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference');

    expect(mediaMock.selectedTrackIndexes).toEqual([1]);
  });

  it('accepts a normal single-stream Ogg without treating payload OggS bytes as pages', async () => {
    const sample = createMockAudioSample([Float32Array.of(1, 2, 3)]);
    mediaMock.sampleFactory = () => [sample];
    const buffer = createOggBuffer(
      createOggPage({ body: [1, 2], flags: 0x02, sequence: 0, serial: 11 }),
      createOggPage({
        body: [0, 0x4f, 0x67, 0x67, 0x53, 3],
        flags: 0x04,
        sequence: 1,
        serial: 11,
      }),
    );

    await expect(decodeEncodedAudioToMono(buffer, 'reference')).resolves.toEqual(
      Float32Array.of(1, 2, 3),
    );
    expect(mediaMock.inputs).toHaveLength(1);
    expect(mediaMock.selectedTrackIndexes).toEqual([0]);
  });

  it('allows initial multiplexed Ogg logical streams before media pages', async () => {
    mediaMock.sampleFactory = () => [
      createMockAudioSample([Float32Array.of(1, 2, 3)]),
    ];
    const buffer = createOggBuffer(
      createOggPage({ body: [1], flags: 0x02, sequence: 0, serial: 11 }),
      createOggPage({ body: [2], flags: 0x02, sequence: 0, serial: 22 }),
      createOggPage({ body: [3], flags: 0x04, sequence: 1, serial: 11 }),
      createOggPage({ body: [4], flags: 0x04, sequence: 1, serial: 22 }),
    );

    await expect(decodeEncodedAudioToMono(buffer, 'reference')).resolves.toBeInstanceOf(
      Float32Array,
    );
    expect(mediaMock.inputs).toHaveLength(1);
    expect(mediaMock.selectedTrackIndexes).toEqual([0]);
  });

  it.each([
    [
      'a sequential stream after EOS',
      createOggBuffer(
        createOggPage({ flags: 0x02, sequence: 0, serial: 11 }),
        createOggPage({ flags: 0x04, sequence: 1, serial: 11 }),
        createOggPage({ flags: 0x06, sequence: 0, serial: 22 }),
      ),
    ],
    [
      'a new BOS stream after media begins',
      createOggBuffer(
        createOggPage({ flags: 0x02, sequence: 0, serial: 11 }),
        createOggPage({ flags: 0, sequence: 1, serial: 11 }),
        createOggPage({ flags: 0x06, sequence: 0, serial: 22 }),
      ),
    ],
  ])('rejects unsupported chained Ogg for %s before decoder input', async (_name, buffer) => {
    await expect(decodeEncodedAudioToMono(buffer, 'target')).rejects.toMatchObject({
      code: 'unsupported-chained-ogg',
      message: expect.stringContaining('unsupported chained Ogg'),
    });
    expect(mediaMock.inputs).toEqual([]);
    expect(mediaMock.selectedTrackIndexes).toEqual([]);
  });

  it.each([
    [
      'version',
      createOggBuffer(
        createOggPage({ flags: 0x06, sequence: 0, serial: 11, version: 1 }),
      ),
    ],
    [
      'flags',
      createOggBuffer(createOggPage({ flags: 0x0e, sequence: 0, serial: 11 })),
    ],
    [
      'continued BOS flags',
      createOggBuffer(createOggPage({ flags: 0x03, sequence: 0, serial: 11 })),
    ],
    [
      'sequence regression',
      createOggBuffer(
        createOggPage({ flags: 0x02, sequence: 0, serial: 11 }),
        createOggPage({ flags: 0, sequence: 1, serial: 11 }),
        createOggPage({ flags: 0x04, sequence: 0, serial: 11 }),
      ),
    ],
    [
      'truncated header',
      createOggBuffer(
        createOggPage({ flags: 0x06, sequence: 0, serial: 11 }).slice(0, 10),
      ),
    ],
    [
      'truncated lacing table',
      createOggBuffer(
        createOggPage({ flags: 0x06, sequence: 0, serial: 11 }).slice(0, 27),
      ),
    ],
    [
      'truncated body',
      createOggBuffer(
        createOggPage({
          body: [1, 2, 3],
          flags: 0x06,
          sequence: 0,
          serial: 11,
        }).slice(0, -1),
      ),
    ],
    [
      'logical stream bound',
      createOggBuffer(
        ...Array.from({ length: 257 }, (_, serial) =>
          createOggPage({ flags: 0x02, sequence: 0, serial }),
        ),
      ),
    ],
  ])('rejects malformed Ogg %s before decoder input', async (_name, buffer) => {
    await expect(decodeEncodedAudioToMono(buffer, 'target')).rejects.toMatchObject({
      code: 'malformed-media',
      message: expect.stringContaining('malformed or truncated Ogg framing'),
    });
    expect(mediaMock.inputs).toEqual([]);
    expect(mediaMock.selectedTrackIndexes).toEqual([]);
  });

  it('preserves linear resampling across incremental sample boundaries', async () => {
    const samples = [
      createMockAudioSample(
        [Float32Array.of(0, 1), Float32Array.of(2, 3)],
        16_000,
        0,
      ),
      createMockAudioSample(
        [Float32Array.of(2, 3), Float32Array.of(4, 5)],
        16_000,
        2 / 16_000,
      ),
    ];
    mediaMock.sampleFactory = () => samples;

    const result = await decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference');

    expect([...result]).toEqual([1, 3]);
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
  });

  it('trims valid negative decoder preroll before producing analysis samples', async () => {
    const sample = createMockAudioSample(
      [Float32Array.of(1, 2, 3, 4)],
      SAMPLE_RATE,
      -2 / SAMPLE_RATE,
    );
    mediaMock.sampleFactory = () => [sample];

    const result = await decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference');

    expect([...result]).toEqual([3, 4]);
    expect(sample.close).toHaveBeenCalledOnce();
  });

  it('preserves timestamp gaps with silence and trims overlapping frames', async () => {
    const samples = [
      createMockAudioSample([Float32Array.of(1, 2)], SAMPLE_RATE, 0),
      createMockAudioSample([Float32Array.of(3, 4)], SAMPLE_RATE, 4 / SAMPLE_RATE),
      createMockAudioSample([Float32Array.of(5, 6, 7)], SAMPLE_RATE, 5 / SAMPLE_RATE),
    ];
    mediaMock.sampleFactory = () => samples;

    const result = await decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference');

    expect([...result]).toEqual([1, 2, 0, 0, 3, 4, 6, 7]);
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
  });

  it('rejects incompatible midstream shapes and closes samples before returning the iterator', async () => {
    const first = createMockAudioSample([Float32Array.of(1, 2)], 8_000, 0);
    const second = createMockAudioSample([Float32Array.of(3, 4)], 16_000, 2 / 8_000);
    mediaMock.sampleFactory = () => [first, second];

    await expect(
      decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference'),
    ).rejects.toMatchObject({ code: 'invalid-metadata' });
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('rejects ambiguous primary selection before constructing a decoder', async () => {
    Object.assign(mediaMock.metadata, {
      primaryTrackIndex: 99,
      tracks: [{ channels: 2, codec: 'aac', sampleRate: 48_000 }],
    });

    await expect(
      decodeEncodedAudioToMono(new ArrayBuffer(32), 'reference'),
    ).rejects.toMatchObject({ code: 'unproven-track-selection' });
    expect(mediaMock.selectedTrackIndexes).toEqual([]);
  });

  it.each([
    ['no-audio-track', { track: false }],
    ['unknown-format', { readable: false }],
    ['malformed-media', { malformedAt: 'format' }],
    ['unknown-codec', { canDecode: false }],
  ])('returns typed %s errors for unusable media', async (code, metadata) => {
    Object.assign(mediaMock.metadata, metadata);

    await expect(decodeEncodedAudioToMono(new ArrayBuffer(8), 'target')).rejects.toMatchObject({
      code,
      name: 'AutoSyncMediaError',
    });
  });

  it.each([
    ['sample rate', { sampleRate: 0 }],
    ['channel count', { numberOfChannels: 0 }],
    ['frame count', { numberOfFrames: 0 }],
    ['timestamp', { timestamp: Number.NaN }],
  ])('rejects invalid emitted %s and closes the sample', async (_name, shape) => {
    const sample = Object.assign(
      createMockAudioSample([Float32Array.of(1)]),
      shape,
    );
    mediaMock.sampleFactory = () => [sample];

    await expect(
      decodeEncodedAudioToMono(new ArrayBuffer(8), 'target'),
    ).rejects.toMatchObject({ code: 'invalid-metadata' });
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('bounds cumulative decoded bytes from chained or extra output before copying more', async () => {
    expect(AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT).toBe(128 * MEBIBYTE);
    Object.assign(mediaMock.metadata, { format: 'Ogg' });
    const samples = Array.from({ length: 5 }, (_, index) =>
      createMockAudioSample(
        [Float32Array.of(index)],
        SAMPLE_RATE,
        index / SAMPLE_RATE,
      ));
    mediaMock.sampleFactory = () => samples;

    await expect(
      decodeEncodedAudioToMono(new ArrayBuffer(8), 'target', undefined, 16),
    ).rejects.toMatchObject({ code: 'decoded-limit' });
    expect(samples[0].copyTo).toHaveBeenCalled();
    expect(samples[3].copyTo).toHaveBeenCalled();
    expect(samples[4].copyTo).not.toHaveBeenCalled();
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('closes the active sample and returns the iterator on cooperative abort', async () => {
    const activeSample = createMockAudioSample([new Float32Array(100_000)]);
    const prefetchedSample = createMockAudioSample([Float32Array.of(1)]);
    mediaMock.sampleFactory = () => [activeSample, prefetchedSample];
    const controller = new AbortController();
    const pending = decodeEncodedAudioToMono(
      new ArrayBuffer(8),
      'reference',
      controller.signal,
    );
    setTimeout(() => controller.abort(), 0);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(activeSample.close).toHaveBeenCalledOnce();
    expect(prefetchedSample.close).toHaveBeenCalledOnce();
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('yields by cumulative processed source frames instead of once per sample', async () => {
    const framesPerSample = 1_024;
    const samples = Array.from({ length: 100 }, (_, index) =>
      createMockAudioSample(
        [new Float32Array(framesPerSample)],
        SAMPLE_RATE,
        (index * framesPerSample) / SAMPLE_RATE,
      ));
    mediaMock.sampleFactory = () => samples;
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    await decodeEncodedAudioToMono(new ArrayBuffer(8), 'reference');
    const yieldCount = timerSpy.mock.calls.length;
    timerSpy.mockRestore();

    expect(yieldCount).toBe(6);
    expect(samples.every((sample) => sample.close.mock.calls.length === 1)).toBe(true);
  });

  it('performs bounded immediate yields for one sample spanning multiple intervals', async () => {
    const frameCount = DECODE_YIELD_FRAME_INTERVAL * 2 + 1_024;
    mediaMock.sampleFactory = () => [
      createMockAudioSample([new Float32Array(frameCount)]),
    ];
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');

    await decodeEncodedAudioToMono(new ArrayBuffer(8), 'reference');
    const yieldCount = timerSpy.mock.calls.length;
    timerSpy.mockRestore();

    expect(yieldCount).toBe(2);
  });

  it('detects abort synchronously between samples', async () => {
    const controller = new AbortController();
    const first = createMockAudioSample([new Float32Array(1_024)]);
    const second = createMockAudioSample(
      [new Float32Array(1_024)],
      SAMPLE_RATE,
      1_024 / SAMPLE_RATE,
    );
    first.close.mockImplementation(() => controller.abort());
    mediaMock.sampleFactory = () => [first, second];

    await expect(
      decodeEncodedAudioToMono(new ArrayBuffer(8), 'reference', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.copyTo).toHaveBeenCalled();
    expect(second.copyTo).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(mediaMock.iteratorReturns).toBe(1);
  });

  it('detects abort at a cumulative frame yield', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sample = createMockAudioSample([
      new Float32Array(DECODE_YIELD_FRAME_INTERVAL),
    ]);
    mediaMock.sampleFactory = () => [sample];
    const pending = decodeEncodedAudioToMono(
      new ArrayBuffer(8),
      'reference',
      controller.signal,
    );
    const abortExpectation = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });

    for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await vi.runOnlyPendingTimersAsync();

    await abortExpectation;
    expect(sample.close).toHaveBeenCalledOnce();
    expect(mediaMock.iteratorReturns).toBe(1);
    vi.useRealTimers();
  });
});

describe('computeAutoSyncOffset', () => {
  it.each([
    ['MP4', 'aac'],
    ['QuickTime', 'aac'],
    ['WebM', 'opus'],
  ])('accepts a normal %s video reference with usable audio', async (format, codec) => {
    Object.assign(mediaMock.metadata, {
      codec,
      format,
      hasVideo: true,
      tracks: [{ channels: 2, codec, sampleRate: SAMPLE_RATE }],
    });

    await expect(
      computeAutoSyncOffset('blob:video-reference', 'blob:target'),
    ).resolves.toMatchObject({
      confidence: expect.any(Number),
      offsetSeconds: expect.any(Number),
    });
  });

  it('preserves signed offsets in both directions', async () => {
    const delayed = await computeAutoSyncOffset('blob:reference', 'blob:target');
    expect(delayed.offsetSeconds).toBeCloseTo(-0.5, 5);
    expect(delayed.confidence).toBeGreaterThan(0.9);

    decodedTarget = advanceSignal(decodedReference, 25 * AUTO_SYNC_FRAME_SIZE);
    const advanced = await computeAutoSyncOffset('blob:reference', 'blob:target');
    expect(advanced.offsetSeconds).toBeCloseTo(0.5, 5);
    expect(advanced.confidence).toBeGreaterThan(0.9);
  });

  it('fetches and decodes inputs sequentially after releasing encoded references', async () => {
    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(fetchedUrls).toEqual(['blob:ref', 'blob:tar']);
    expect(mediaMock.maximumActiveIterators).toBe(1);
  });

  it('cancels non-OK and oversized declared responses without masking primary errors', async () => {
    const rejected = createStreamResponse({ status: 503 });
    vi.stubGlobal('fetch', vi.fn(async () => rejected));
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'Failed to fetch reference audio: HTTP 503',
    );
    expect(rejected.bodyCancel).toHaveBeenCalledOnce();

    const oversized = createStreamResponse({
      contentLength: AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT + 1,
    });
    vi.stubGlobal('fetch', vi.fn(async () => oversized));
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      code: 'encoded-limit',
      message: expect.stringContaining('48 MiB auto-sync encoded-input limit'),
    });
    expect(oversized.bodyCancel).toHaveBeenCalledOnce();
  });

  it('never constructs Web Audio contexts', async () => {
    const audioContext = vi.fn(() => {
      throw new Error('Web Audio must not be constructed');
    });
    vi.stubGlobal('AudioContext', audioContext);

    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(audioContext).not.toHaveBeenCalled();
  });

  it('preserves decode and AbortError when iterator cleanup rejects', async () => {
    Object.assign(mediaMock.metadata, { malformedAt: 'decode' });
    mediaMock.iteratorReturnError = new Error('iterator cleanup failed');
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toMatchObject({
      code: 'malformed-media',
      originalCause: expect.objectContaining({ message: 'primary decode failure' }),
    });

    Object.assign(mediaMock.metadata, { malformedAt: null });
    mediaMock.iteratorReturnError = new Error('iterator cleanup failed');
    mediaMock.sampleFactory = () => [
      createMockAudioSample([new Float32Array(100_000)]),
    ];
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mediaMock.iteratorReturns).toBeGreaterThanOrEqual(2);
    expect(fetchedUrls.at(-1)).toBe('blob:ref');
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
