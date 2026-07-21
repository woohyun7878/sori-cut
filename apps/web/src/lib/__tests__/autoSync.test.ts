import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseAudioMetadata = vi.hoisted(() => vi.fn());
const closeAudioMetadata = vi.hoisted(() => vi.fn());

vi.mock('mediainfo.js', () => {
  return {
    default: vi.fn(async () => ({
      analyzeData: parseAudioMetadata,
      close: closeAudioMetadata,
    })),
  };
});
vi.mock('mediainfo.js/MediaInfoModule.wasm?url', () => ({ default: 'mock-mediainfo.wasm' }));

import {
  AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AutoSyncInputError,
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

function createMediaInfoResult(format: {
  container?: string;
  codec?: string;
  duration?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  hasVideo?: boolean;
}): object {
  const container = format.container?.toLowerCase() ?? '';
  const generalFormat =
    container === 'wave'
      ? 'Wave'
      : container === 'mpeg'
        ? 'MPEG Audio'
        : container.startsWith('adts/')
          ? 'ADTS'
          : container === 'flac'
            ? 'FLAC'
            : container === 'ogg'
              ? 'Ogg'
              : container.startsWith('m4a/')
                ? 'MPEG-4'
                : container === 'ebml/webm'
                  ? 'WebM'
                  : format.container;
  const codec = format.codec?.toLowerCase() ?? '';
  const audioFormat = codec.startsWith('mpeg ')
    ? 'MPEG Audio'
    : codec.includes('aac')
      ? 'AAC'
      : codec === 'vorbis i'
        ? 'Vorbis'
        : codec === 'a_opus'
          ? 'Opus'
          : format.codec;
  const track: object[] = [
    {
      '@type': 'General',
      Format: generalFormat,
      Duration: format.duration,
    },
    {
      '@type': 'Audio',
      Format: audioFormat,
      Format_Profile: container === 'mpeg' ? 'Layer 3' : undefined,
      Duration: format.duration,
      SamplingRate: format.sampleRate,
      Channels: format.numberOfChannels,
    },
  ];
  if (format.hasVideo) {
    track.push({ '@type': 'Video', Format: 'AVC' });
  }
  return { media: { '@ref': 'test-audio', track } };
}

function calculateOggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let offset = 0; offset < bytes.byteLength; offset++) {
    const value = offset >= 22 && offset < 26 ? 0 : bytes[offset];
    crc ^= value << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000_0000 ? (crc << 1) ^ 0x04c1_1db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function createOggPage(
  streamSerial: number,
  sequence: number,
  headerType: number,
  body: Uint8Array,
): Uint8Array {
  if (body.byteLength > 255) {
    throw new Error('Test Ogg pages support one lacing segment');
  }
  const page = new Uint8Array(28 + body.byteLength);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[5] = headerType;
  const view = new DataView(page.buffer);
  view.setUint32(14, streamSerial, true);
  view.setUint32(18, sequence, true);
  page[26] = 1;
  page[27] = body.byteLength;
  page.set(body, 28);
  view.setUint32(22, calculateOggCrc(page), true);
  return page;
}

function combineBytes(...arrays: Uint8Array[]): ArrayBuffer {
  const combined = new Uint8Array(arrays.reduce((total, array) => total + array.byteLength, 0));
  let offset = 0;
  for (const array of arrays) {
    combined.set(array, offset);
    offset += array.byteLength;
  }
  return combined.buffer;
}

function createSingleStreamOgg(streamSerial = 0x1234_5678): ArrayBuffer {
  return combineBytes(
    createOggPage(streamSerial, 0, 0x02, new TextEncoder().encode('OpusHead')),
    createOggPage(streamSerial, 1, 0x04, Uint8Array.of(1, 2, 3)),
  );
}

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

function createStreamResponse(options: {
  chunks?: Uint8Array[];
  cancel?: () => Promise<void>;
  pendingRead?: boolean;
  supportsByob?: boolean;
}): Response {
  const chunks = [...(options.chunks ?? [])];
  const defaultReader = {
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
  const byobReader = {
    read: vi.fn(async (view: Uint8Array) => {
      const chunk = chunks.shift();
      if (!chunk) {
        return { done: true as const, value: undefined };
      }
      const bytesRead = Math.min(view.byteLength, chunk.byteLength);
      view.set(chunk.subarray(0, bytesRead));
      if (bytesRead < chunk.byteLength) {
        chunks.unshift(chunk.subarray(bytesRead));
      }
      return { done: false as const, value: view.subarray(0, bytesRead) };
    }),
    cancel: vi.fn(options.cancel ?? (async () => {})),
    releaseLock: vi.fn(),
  };
  return {
    body: {
      getReader: (readerOptions?: { mode?: string }) => {
        if (readerOptions?.mode === 'byob') {
          if (!options.supportsByob) {
            throw new TypeError('Not a byte stream');
          }
          return byobReader;
        }
        return defaultReader;
      },
    },
    arrayBuffer: vi.fn(),
  } as unknown as Response;
}

function createGeneratedByobResponse(byteLength: number, cancel = vi.fn(async () => {})): Response {
  let remaining = byteLength;
  const reader = {
    read: vi.fn(async (view: Uint8Array) => {
      if (remaining === 0) {
        return { done: true as const, value: undefined };
      }
      const bytesRead = Math.min(view.byteLength, remaining);
      view.subarray(0, bytesRead).fill(1);
      remaining -= bytesRead;
      return { done: false as const, value: view.subarray(0, bytesRead) };
    }),
    cancel,
    releaseLock: vi.fn(),
  };
  return {
    body: {
      getReader: (readerOptions?: { mode?: string }) => {
        if (readerOptions?.mode !== 'byob') {
          throw new TypeError('Expected a BYOB reader');
        }
        return reader;
      },
      cancel,
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
  parseAudioMetadata.mockReset();
  closeAudioMetadata.mockReset();
  parseAudioMetadata.mockResolvedValue(
    createMediaInfoResult({
      container: 'MPEG',
      codec: 'MPEG 1 Layer III',
      duration: 5,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
    }),
  );
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
          stop: vi.fn(),
          disconnect: vi.fn(),
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
      const byteLength = isTarget ? TARGET_BYTES : REFERENCE_BYTES;
      return Object.assign(createGeneratedByobResponse(byteLength), {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(byteLength),
          'content-type': 'audio/mpeg',
        }),
      });
    }),
  );
});

describe('readResponseBuffer', () => {
  it('preallocates and accepts the exact declared Content-Length boundary', async () => {
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
      supportsByob: true,
    });

    const buffer = await readResponseBuffer(response, 4, 'too large', undefined, 4);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a bodyless response instead of materializing it without a bound', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1024));
    const response = { body: null, arrayBuffer } as unknown as Response;

    await expect(readResponseBuffer(response, 8, 'too large', undefined)).rejects.toThrow(
      'unavailable for bounded reading',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('accounts for one full incoming fallback chunk beside declared storage', async () => {
    const rejected = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3, 4, 5, 6)],
    });
    await expect(readResponseBuffer(rejected, 11, 'too large', undefined, 6)).rejects.toThrow(
      'too large',
    );

    const accepted = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3, 4, 5, 6)],
    });
    await expect(
      readResponseBuffer(accepted, 12, 'too large', undefined, 6),
    ).resolves.toHaveProperty('byteLength', 6);
  });

  it('includes retained reference bytes in target fallback admission', async () => {
    const aggregateBudget = 12;
    const retainedReferenceBytes = 5;
    const target = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3, 4)],
    });

    await expect(
      readResponseBuffer(
        target,
        aggregateBudget - retainedReferenceBytes,
        'combined limit',
        undefined,
        4,
      ),
    ).rejects.toThrow('combined limit');
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
  it.each([
    ['WAV', 'WAVE', 'PCM'],
    ['MP3', 'MPEG', 'MPEG 1 Layer III'],
    ['AAC', 'ADTS/MPEG-4', 'AAC'],
    ['FLAC', 'FLAC', 'FLAC'],
    ['M4A', 'M4A/isom/mp42', 'MPEG-4/AAC'],
    ['WebM', 'EBML/webm', 'A_OPUS'],
  ])('accepts representative %s metadata before decoding', async (_name, container, codec) => {
    parseAudioMetadata.mockResolvedValue(
      createMediaInfoResult({
        container,
        codec,
        duration: 5,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
      }),
    );

    await expect(computeAutoSyncOffset('blob:reference', 'blob:target')).resolves.toEqual(
      expect.objectContaining({ confidence: expect.any(Number) }),
    );
  });

  it.each([
    ['MP4', 'MPEG-4', 'AAC'],
    ['MOV', 'QuickTime', 'AAC'],
    ['WebM', 'WebM', 'Opus'],
  ])(
    'accepts the audio track from a normal %s video reference',
    async (_name, container, codec) => {
      parseAudioMetadata.mockResolvedValue(
        createMediaInfoResult({
          container,
          codec,
          duration: 5,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 2,
          hasVideo: true,
        }),
      );

      await expect(computeAutoSyncOffset('blob:video-reference', 'blob:target')).resolves.toEqual(
        expect.objectContaining({ confidence: expect.any(Number) }),
      );
    },
  );

  it('accepts a structurally valid single-stream Ogg track', async () => {
    const ogg = createSingleStreamOgg();
    let request = 0;
    parseAudioMetadata
      .mockResolvedValueOnce(
        createMediaInfoResult({
          container: 'Ogg',
          codec: 'Vorbis I',
          duration: 5,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 2,
        }),
      )
      .mockResolvedValueOnce(
        createMediaInfoResult({
          container: 'MPEG',
          codec: 'MPEG 1 Layer III',
          duration: 5,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 1,
        }),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        const byteLength = request === 1 ? ogg.byteLength : TARGET_BYTES;
        const response =
          request === 1
            ? createStreamResponse({
                chunks: [new Uint8Array(ogg)],
                supportsByob: true,
              })
            : createGeneratedByobResponse(TARGET_BYTES);
        return Object.assign(response, {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(byteLength) }),
        });
      }),
    );

    await expect(computeAutoSyncOffset('blob:ogg-reference', 'blob:target')).resolves.toEqual(
      expect.objectContaining({ confidence: expect.any(Number) }),
    );
  });

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
      vi.fn(async () =>
        Object.assign(createGeneratedByobResponse(REFERENCE_BYTES), {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(REFERENCE_BYTES) }),
        }),
      ),
    );
    parseAudioMetadata.mockResolvedValue(
      createMediaInfoResult({
        container: 'MPEG',
        codec: 'MPEG 1 Layer III',
        duration: 301,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
      }),
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
    const cancelSecond = vi.fn(async () => {});
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        const response =
          request === 1
            ? createGeneratedByobResponse(firstBytes)
            : createGeneratedByobResponse(secondBytes, cancelSecond);
        return Object.assign(response, {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-length': String(request === 1 ? firstBytes : secondBytes),
          }),
        });
      }),
    );

    await expect(computeAutoSyncOffset('blob:ref', 'blob:tar')).rejects.toThrow(
      'combined 64 MB encoded-audio limit',
    );
    expect(AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES).toBe(64 * MEBIBYTE);
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

  it.each([
    ['MP3', 'MPEG', 'MPEG 1 Layer III', 2],
    ['ADTS channel_configuration 7', 'ADTS/MPEG-4', 'AAC', 8],
    ['FLAC', 'FLAC', 'FLAC', 8],
    ['M4A/AAC', 'M4A/isom/mp42', 'MPEG-4/AAC', 8],
    ['WebM Opus', 'EBML/webm', 'A_OPUS', 8],
  ])(
    'rejects oversized %s metadata before decoding',
    async (_name, container, codec, numberOfChannels) => {
      const decodeAudioData = vi.fn();
      vi.stubGlobal(
        'AudioContext',
        class {
          decodeAudioData = decodeAudioData;
          async close() {}
        },
      );
      parseAudioMetadata.mockResolvedValue(
        createMediaInfoResult({
          container,
          codec,
          duration: 300,
          sampleRate: 192_000,
          numberOfChannels,
        }),
      );

      const error = await computeAutoSyncOffset('blob:oversized', 'blob:target').catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AutoSyncInputError);
      expect(error).toMatchObject({ code: 'decoded-memory-limit' });
      expect(decodeAudioData).not.toHaveBeenCalled();
    },
  );

  it('rejects chained Ogg even when metadata reports only its first logical stream', async () => {
    const decodeAudioData = vi.fn();
    const chainedOgg = combineBytes(
      createOggPage(0x1111_1111, 0, 0x06, new TextEncoder().encode('OpusHead')),
      createOggPage(0x2222_2222, 0, 0x06, new TextEncoder().encode('OpusHead')),
    );
    parseAudioMetadata.mockResolvedValue({
      media: {
        '@ref': 'chained.ogg',
        track: [
          { '@type': 'General', Format: 'Ogg', Duration: 300 },
          {
            '@type': 'Audio',
            Format: 'Vorbis',
            Duration: 300,
            SamplingRate: 48_000,
            Channels: 2,
          },
        ],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Object.assign(
          createStreamResponse({
            chunks: [new Uint8Array(chainedOgg)],
            supportsByob: true,
          }),
          {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(chainedOgg.byteLength) }),
          },
        ),
      ),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    const error = await computeAutoSyncOffset('blob:chained-ogg', 'blob:target').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutoSyncInputError);
    expect(error).toMatchObject({ code: 'unsupported-format' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects Ogg with a corrupt page checksum before decoding', async () => {
    const decodeAudioData = vi.fn();
    const corruptOgg = new Uint8Array(createSingleStreamOgg());
    corruptOgg[corruptOgg.byteLength - 1] ^= 0xff;
    parseAudioMetadata.mockResolvedValue(
      createMediaInfoResult({
        container: 'Ogg',
        codec: 'Vorbis I',
        duration: 5,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Object.assign(
          createStreamResponse({
            chunks: [corruptOgg],
            supportsByob: true,
          }),
          {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(corruptOgg.byteLength) }),
          },
        ),
      ),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    const error = await computeAutoSyncOffset('blob:corrupt-ogg', 'blob:target').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutoSyncInputError);
    expect(error).toMatchObject({ code: 'malformed-metadata' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    [
      'continued flag on its beginning-of-stream page',
      combineBytes(
        createOggPage(0x1234_5678, 0, 0x03, new TextEncoder().encode('OpusHead')),
        createOggPage(0x1234_5678, 1, 0x04, Uint8Array.of(1)),
      ),
    ],
    [
      'missing continuation after an unfinished packet',
      combineBytes(
        createOggPage(0x1234_5678, 0, 0x02, new Uint8Array(255)),
        createOggPage(0x1234_5678, 1, 0x04, Uint8Array.of(1)),
      ),
    ],
  ])('rejects Ogg with %s before decoding', async (_name, malformedOgg) => {
    const decodeAudioData = vi.fn();
    parseAudioMetadata.mockResolvedValue(
      createMediaInfoResult({
        container: 'Ogg',
        codec: 'Vorbis I',
        duration: 5,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Object.assign(
          createStreamResponse({
            chunks: [new Uint8Array(malformedOgg)],
            supportsByob: true,
          }),
          {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(malformedOgg.byteLength) }),
          },
        ),
      ),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    const error = await computeAutoSyncOffset('blob:malformed-ogg', 'blob:target').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutoSyncInputError);
    expect(error).toMatchObject({ code: 'malformed-metadata' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects malformed WAV metadata before decoding', async () => {
    const decodeAudioData = vi.fn();
    parseAudioMetadata.mockRejectedValue(new Error('Invalid RIFF chunk size'));
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    const error = await computeAutoSyncOffset('blob:broken-wav', 'blob:target').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutoSyncInputError);
    expect(error).toMatchObject({ code: 'malformed-metadata' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    [
      'MP4 without authoritative AAC channel configuration',
      {
        container: 'M4A/isom/mp42',
        codec: 'MPEG-4/AAC',
        duration: 5,
        sampleRate: SAMPLE_RATE,
      },
    ],
    [
      'ADTS channel_configuration 0 without a resolved PCE',
      {
        container: 'ADTS/MPEG-4',
        codec: 'AAC',
        duration: 5,
        sampleRate: SAMPLE_RATE,
      },
    ],
    [
      'timesliced WebM without block-derived duration',
      {
        container: 'EBML/webm',
        codec: 'A_OPUS',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
      },
    ],
    [
      'FLAC with zero or unvalidated total samples',
      {
        container: 'FLAC',
        codec: 'FLAC',
        duration: 0,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
        numberOfSamples: 0,
      },
    ],
  ])('fails closed for %s before decoding', async (_name, format) => {
    const decodeAudioData = vi.fn();
    parseAudioMetadata.mockResolvedValue(createMediaInfoResult(format));
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );

    const error = await computeAutoSyncOffset('blob:uncertain', 'blob:target').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutoSyncInputError);
    expect(error).toMatchObject({ code: 'malformed-metadata' });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('does not start decoding when aborted during metadata inspection', async () => {
    const decodeAudioData = vi.fn();
    closeAudioMetadata.mockImplementation(() => {
      throw new Error('metadata close failed');
    });
    let resolveMetadata: ((metadata: unknown) => void) | undefined;
    parseAudioMetadata.mockReturnValue(
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
    );
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:reference', 'blob:target', {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(parseAudioMetadata).toHaveBeenCalledOnce());

    controller.abort();
    resolveMetadata?.(
      createMediaInfoResult({
        container: 'MPEG',
        codec: 'MPEG 1 Layer III',
        duration: 5,
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 2,
      }),
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(closeAudioMetadata).toHaveBeenCalledOnce();
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    ['AIFF', 'PCM'],
    ['WavPack', 'WavPack'],
    ['EBML/matroska', 'A_OPUS'],
  ])(
    'rejects unsupported parsed %s with a typed error before decoding',
    async (container, codec) => {
      const decodeAudioData = vi.fn();
      parseAudioMetadata.mockResolvedValue(
        createMediaInfoResult({
          container,
          codec,
          duration: 5,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 2,
        }),
      );
      vi.stubGlobal(
        'AudioContext',
        class {
          decodeAudioData = decodeAudioData;
          async close() {}
        },
      );

      const error = await computeAutoSyncOffset('blob:unknown', 'blob:target').catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AutoSyncInputError);
      expect(error).toMatchObject({ code: 'unsupported-format' });
      expect(decodeAudioData).not.toHaveBeenCalled();
    },
  );

  it('stops and disconnects an aborted render without masking cleanup failures', async () => {
    const stop = vi.fn(() => {
      throw new Error('stop failed');
    });
    const disconnect = vi.fn(() => {
      throw new Error('disconnect failed');
    });
    const close = vi.fn(async () => {
      throw new Error('close failed');
    });
    let sourceBuffer: AudioBuffer | null = null;
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        currentTime = 0;
        createBufferSource() {
          return {
            set buffer(value: AudioBuffer | null) {
              sourceBuffer = value;
            },
            get buffer() {
              return sourceBuffer;
            },
            connect: vi.fn(),
            start: vi.fn(),
            stop,
            disconnect,
          };
        }
        get destination() {
          return {};
        }
        startRendering(): Promise<AudioBuffer> {
          return new Promise(() => {});
        }
        close = close;
      },
    );
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:reference', 'blob:target', {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sourceBuffer).toBeNull();
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
