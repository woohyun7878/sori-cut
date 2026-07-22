import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediaMock = vi.hoisted(() => ({
  inputs: [] as Array<{ formats: unknown[]; source: { buffer: ArrayBuffer } }>,
  metadata: {
    channels: 1,
    codec: 'mp3' as string | null,
    duration: 5,
    format: 'MP3',
    malformedAt: null as 'format' | 'metadata' | null,
    hasVideo: false,
    primaryTrackIndex: 0,
    readable: true,
    sampleRate: 8_000,
    track: true,
    tracks: null as
      | Array<{
          channels: number;
          codec: string | null;
          duration: number;
          malformedAt?: 'metadata';
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
    ).map((metadata) => this.createTrack(metadata));

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
        this.createTrack(this.metadata)
      );
    }

    async getVideoTracks() {
      return this.metadata.hasVideo ? [{}] : [];
    }

    private createTrack(metadata: {
      channels: number;
      codec: string | null;
      duration: number;
      malformedAt?: 'metadata' | 'format' | null;
      sampleRate: number;
    }) {
      return {
        getCodec: async () => metadata.codec,
        getSampleRate: async () => metadata.sampleRate,
        getNumberOfChannels: async () => metadata.channels,
        computeDuration: async () => {
          if (metadata.malformedAt === 'metadata') {
            throw new Error('broken packet table');
          }
          return metadata.duration;
        },
      };
    }

    dispose() {}
  }

  const format = (name: string) => ({ name });
  return {
    ADTS: format('ADTS'),
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
  AUTO_SYNC_INPUT_FORMATS,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  computeAutoSyncOffset,
  convertAudioBufferToMono,
  getUnknownLengthPayloadLimit,
  inspectEncodedAudioMemory,
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

function createAudioBuffer(channelData: Float32Array[], sampleRate = SAMPLE_RATE): AudioBuffer {
  const length = channelData[0]?.length ?? 0;
  return {
    numberOfChannels: channelData.length,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => channelData[channel],
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
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
  mediaMock.inputs.length = 0;
  Object.assign(mediaMock.metadata, {
    channels: 1,
    codec: 'mp3',
    duration: 5,
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

  vi.stubGlobal('Worker', MockAutoSyncWorker);
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
        return createAudioBuffer([
          data.byteLength === TARGET_BYTES ? decodedTarget : decodedReference,
        ]);
      }
      async close() {}
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

describe('inspectEncodedAudioMemory', () => {
  it.each([
    ['MP4 video reference', 'MP4', 'aac'],
    ['WebM video reference', 'WebM', 'opus'],
    ['MP3 audio', 'MP3', 'mp3'],
    ['M4A audio', 'MP4', 'aac'],
    ['Ogg audio', 'Ogg', 'vorbis'],
    ['FLAC audio', 'FLAC', 'flac'],
    ['WAV audio', 'WAVE', 'pcm-s16'],
  ])('reads complete authoritative metadata for %s', async (_name, format, codec) => {
    Object.assign(mediaMock.metadata, {
      channels: 2,
      codec,
      duration: 2.5,
      format,
      sampleRate: 48_000,
    });

    const result = await inspectEncodedAudioMemory(new ArrayBuffer(32), 'reference');

    expect(result).toMatchObject({
      channels: 2,
      codec,
      decodedBytes: 960_000,
      duration: 2.5,
      format,
      sampleRate: 48_000,
      trackCount: 1,
    });
    expect(mediaMock.inputs.at(-1)?.formats).toEqual(AUTO_SYNC_INPUT_FORMATS);
  });

  it('accepts video containers while summing every audio track allocation', async () => {
    Object.assign(mediaMock.metadata, {
      format: 'MP4',
      hasVideo: true,
      primaryTrackIndex: 1,
      tracks: [
        { channels: 1, codec: 'aac', duration: 2, sampleRate: 48_000 },
        { channels: 2, codec: 'aac', duration: 3, sampleRate: 44_100 },
      ],
    });

    const result = await inspectEncodedAudioMemory(new ArrayBuffer(32), 'reference');

    expect(result).toMatchObject({
      channels: 2,
      codec: 'aac',
      decodedBytes: 1_442_400,
      duration: 3,
      format: 'MP4',
      sampleRate: 44_100,
      trackCount: 2,
    });
  });

  it('rejects multi-track and chained-stream sums that exceed the decoded budget', async () => {
    const tracks = [
      { channels: 2, codec: 'opus', duration: 100, sampleRate: 96_000 },
      { channels: 2, codec: 'vorbis', duration: 100, sampleRate: 96_000 },
    ];
    Object.assign(mediaMock.metadata, {
      format: 'Ogg',
      tracks,
    });

    await expect(inspectEncodedAudioMemory(new ArrayBuffer(32), 'reference')).rejects.toMatchObject(
      { code: 'decoded-limit' },
    );
  });

  it('rejects when the primary browser-decoder selection is not among enumerated tracks', async () => {
    Object.assign(mediaMock.metadata, {
      primaryTrackIndex: 99,
      tracks: [{ channels: 2, codec: 'aac', duration: 2, sampleRate: 48_000 }],
    });

    await expect(inspectEncodedAudioMemory(new ArrayBuffer(32), 'reference')).rejects.toMatchObject(
      { code: 'unproven-track-selection' },
    );
  });

  it.each([
    ['no-audio-track', { track: false }],
    ['unknown-format', { readable: false }],
    ['malformed-media', { malformedAt: 'format' }],
    ['malformed-media', { malformedAt: 'metadata' }],
    ['unknown-codec', { codec: null }],
    ['invalid-metadata', { duration: 0 }],
    ['invalid-metadata', { duration: Number.POSITIVE_INFINITY }],
    ['invalid-metadata', { sampleRate: 0 }],
    ['invalid-metadata', { channels: 0 }],
  ])('returns typed %s errors for unusable media', async (code, metadata) => {
    Object.assign(mediaMock.metadata, metadata);

    await expect(inspectEncodedAudioMemory(new ArrayBuffer(8), 'target')).rejects.toMatchObject({
      code,
      name: 'AutoSyncMediaError',
    });
  });

  it('rejects overflow-safe decoded estimates beyond the existing budget', async () => {
    expect(AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT).toBe(128 * MEBIBYTE);
    Object.assign(mediaMock.metadata, {
      channels: Number.MAX_SAFE_INTEGER,
      duration: Number.MAX_VALUE,
      sampleRate: Number.MAX_SAFE_INTEGER,
    });

    await expect(inspectEncodedAudioMemory(new ArrayBuffer(8), 'target')).rejects.toMatchObject({
      code: 'decoded-limit',
    });
  });
});

describe('convertAudioBufferToMono', () => {
  it('averages channels directly at 8 kHz with deterministic dimensions', async () => {
    const decoded = createAudioBuffer([
      Float32Array.of(1, 0, -1, 0),
      Float32Array.of(-1, 1, 1, 0),
    ]);

    const result = await convertAudioBufferToMono(decoded, 'reference');

    expect([...result]).toEqual([0, 0.5, 0, 0]);
  });

  it('linearly resamples into the exact bounded output length', async () => {
    const decoded = createAudioBuffer(
      [Float32Array.of(0, 1, 2, 3), Float32Array.of(2, 3, 4, 5)],
      16_000,
    );

    const result = await convertAudioBufferToMono(decoded, 'reference');

    expect(result).toHaveLength(2);
    expect([...result]).toEqual([1, 3]);
  });

  it('observes abort between cooperative conversion chunks', async () => {
    const decoded = createAudioBuffer([new Float32Array(100_000)]);
    const controller = new AbortController();
    const pending = convertAudioBufferToMono(decoded, 'reference', controller.signal);
    setTimeout(() => controller.abort(), 0);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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
      tracks: [{ channels: 2, codec, duration: 5, sampleRate: SAMPLE_RATE }],
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
          return createAudioBuffer([
            data.byteLength === TARGET_BYTES ? decodedTarget : decodedReference,
          ]);
        }
        async close() {}
      },
    );

    await computeAutoSyncOffset('blob:ref', 'blob:tar');

    expect(fetchedUrls).toEqual(['blob:ref', 'blob:tar']);
    expect(maximumActiveDecodes).toBe(1);
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

  it('rejects oversized non-WAV decoded metadata before any decode call', async () => {
    Object.assign(mediaMock.metadata, {
      channels: 8,
      codec: 'opus',
      duration: 300,
      format: 'WebM',
      sampleRate: 192_000,
    });
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:webm', 'blob:target')).rejects.toMatchObject({
      code: 'decoded-limit',
    });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects a multi-track MP4 sum before decode even when each track fits alone', async () => {
    Object.assign(mediaMock.metadata, {
      format: 'MP4',
      hasVideo: true,
      tracks: [
        { channels: 2, codec: 'aac', duration: 100, sampleRate: 96_000 },
        { channels: 2, codec: 'aac', duration: 100, sampleRate: 96_000 },
      ],
    });
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    await expect(computeAutoSyncOffset('blob:mp4', 'blob:target')).rejects.toMatchObject({
      code: 'decoded-limit',
    });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('preserves decode and AbortError when decoder cleanup rejects', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          throw new Error('primary decode failure');
        }
        async close(): Promise<void> {
          throw new Error('close failed');
        }
      },
    );
    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'primary decode failure',
    );

    let closes = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData(): Promise<AudioBuffer> {
          return new Promise(() => {});
        }
        async close(): Promise<void> {
          closes++;
          throw new Error('close failed');
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
    expect(closes).toBe(1);
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
