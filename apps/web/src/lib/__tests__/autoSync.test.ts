import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_STREAMING_PEAK_BYTES,
  computeAutoSyncOffset,
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
const MP3_FRAME_BYTES = 417;
const REFERENCE_BYTES = MP3_FRAME_BYTES * 2;
const TARGET_BYTES = MP3_FRAME_BYTES * 3;
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
  formatTag?: 1 | 3;
}): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + options.dataBytes);
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
  view.setUint16(20, options.formatTag ?? 1, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bitsPerSample, true);
  writeText(36, 'data');
  view.setUint32(40, options.dataBytes, true);
  return buffer;
}

function createExtendedFormatWave(formatBytes: 17 | 18, extensionSize = 0): ArrayBuffer {
  const source = new Uint8Array(
    createWaveHeader({
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 16,
      dataBytes: 100,
    }),
  );
  const extensionStorageBytes = formatBytes - 16 + (formatBytes % 2);
  const bytes = new Uint8Array(source.length + extensionStorageBytes);
  bytes.set(source.subarray(0, 36));
  bytes.set(source.subarray(36), 36 + extensionStorageBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, formatBytes, true);
  if (formatBytes === 18) {
    view.setUint16(36, extensionSize, true);
  }
  return bytes.buffer;
}

function createMp3Buffer(byteLength: number): ArrayBuffer {
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset + MP3_FRAME_BYTES <= byteLength; offset += MP3_FRAME_BYTES) {
    bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
  }
  return buffer;
}

function createId3Mp3Buffer(version: 3 | 4 = 4, footer = false): ArrayBuffer {
  const audioOffset = footer ? 20 : 10;
  const bytes = new Uint8Array(audioOffset + MP3_FRAME_BYTES * 2);
  const flags = footer ? 0x10 : 0;
  bytes.set([0x49, 0x44, 0x33, version, 0x00, flags, 0, 0, 0, 0]);
  if (footer) {
    bytes.set([0x33, 0x44, 0x49, version, 0x00, flags, 0, 0, 0, 0], 10);
  }
  bytes.set([0xff, 0xfb, 0x90, 0x64], audioOffset);
  bytes.set([0xff, 0xfb, 0x90, 0x64], audioOffset + MP3_FRAME_BYTES);
  return bytes.buffer;
}

function createDuplicateFormatWave(): ArrayBuffer {
  const source = new Uint8Array(
    createWaveHeader({
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 8,
      dataBytes: 100,
    }),
  );
  const bytes = new Uint8Array(source.length + 24);
  bytes.set(source.subarray(0, 36), 0);
  bytes.set(source.subarray(12, 36), 36);
  bytes.set(source.subarray(36), 60);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(52, 32_000, true);
  view.setUint16(56, 4, true);
  view.setUint16(58, 32, true);
  return bytes.buffer;
}

function createDuplicateDataWave(): ArrayBuffer {
  const source = new Uint8Array(
    createWaveHeader({
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 8,
      dataBytes: 100,
    }),
  );
  const bytes = new Uint8Array(source.length + 8);
  bytes.set(source);
  bytes.set([0x64, 0x61, 0x74, 0x61], source.length);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes.buffer;
}

function createDataBeforeFormatWave(): ArrayBuffer {
  const bytes = new Uint8Array(144);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'data');
  view.setUint32(16, 100, true);
  writeText(120, 'fmt ');
  view.setUint32(124, 16, true);
  view.setUint16(128, 1, true);
  view.setUint16(130, 1, true);
  view.setUint32(132, 8_000, true);
  view.setUint32(136, 8_000, true);
  view.setUint16(140, 1, true);
  view.setUint16(142, 8, true);
  return bytes.buffer;
}

function createAdtsBuffer(): ArrayBuffer {
  return Uint8Array.from([0xff, 0xf1, 0x0c, 0x80, 0, 0, 0]).buffer;
}

function createOggBuffer(codec: 'opus' | 'vorbis', channels = 2): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
  bytes[26] = 1;
  bytes[27] = 32;
  const packetOffset = 28;
  if (codec === 'opus') {
    bytes.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], packetOffset);
    bytes[packetOffset + 9] = channels;
  } else {
    bytes.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], packetOffset);
    bytes[packetOffset + 11] = channels;
    new DataView(bytes.buffer).setUint32(packetOffset + 12, 48_000, true);
  }
  return bytes.buffer;
}

function createCommonUnsupportedBuffer(format: 'flac' | 'm4a' | 'webm'): ArrayBuffer {
  const bytes = new Uint8Array(32);
  if (format === 'flac') {
    bytes.set([0x66, 0x4c, 0x61, 0x43]);
  } else if (format === 'm4a') {
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  } else {
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  }
  return bytes.buffer;
}

function createStreamResponse(options: {
  chunks?: Uint8Array[];
  cancel?: () => Promise<void>;
  pendingRead?: boolean;
  supportsByob?: boolean;
  byobReadSizes?: number[];
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
    read: vi.fn((view: Uint8Array) => {
      options.byobReadSizes?.push(view.byteLength);
      if (options.pendingRead) {
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
      }
      const chunk = chunks[0];
      if (!chunk) {
        return Promise.resolve({ done: true as const, value: new Uint8Array() });
      }
      const copiedBytes = Math.min(view.byteLength, chunk.byteLength);
      view.set(chunk.subarray(0, copiedBytes));
      if (copiedBytes === chunk.byteLength) {
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(copiedBytes);
      }
      return Promise.resolve({
        done: false as const,
        value: view.subarray(0, copiedBytes),
      });
    }),
    cancel: vi.fn(options.cancel ?? (async () => {})),
    releaseLock: vi.fn(),
  };
  return {
    body: {
      getReader: (readerOptions?: { mode?: string }) => {
        if (readerOptions?.mode === 'byob') {
          if (!options.supportsByob) {
            throw new TypeError('BYOB is not supported');
          }
          return byobReader;
        }
        return defaultReader;
      },
      cancel: vi.fn(options.cancel ?? (async () => {})),
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
        arrayBuffer: async () => createMp3Buffer(isTarget ? TARGET_BYTES : REFERENCE_BYTES),
      };
    }),
  );
});

describe('readResponseBuffer', () => {
  it('uses bounded BYOB reads at the exact declared Content-Length boundary', async () => {
    const byobReadSizes: number[] = [];
    const response = createStreamResponse({
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
      supportsByob: true,
      byobReadSizes,
    });

    const buffer = await readResponseBuffer(response, 4, 'too large', undefined, 4, 8);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
    expect(Math.max(...byobReadSizes)).toBeLessThanOrEqual(4);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads a native byte stream without retaining its incoming chunk', async () => {
    const body = new ReadableStream({
      type: 'bytes',
      start(controller: ReadableByteStreamController) {
        controller.enqueue(Uint8Array.of(1, 2, 3, 4));
        controller.close();
      },
    });
    const response = {
      body,
      arrayBuffer: vi.fn(),
    } as unknown as Response;

    const buffer = await readResponseBuffer(response, 4, 'too large', undefined, 4, 8);

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
  });

  it('bounds one-chunk BYOB input plus preallocation and retained analysis memory', async () => {
    const byobReadSizes: number[] = [];
    const response = createStreamResponse({
      chunks: [Uint8Array.from({ length: 12 }, (_, index) => index)],
      supportsByob: true,
      byobReadSizes,
    });

    const buffer = await readResponseBuffer(response, 12, 'too large', undefined, 12, 18, 4);

    expect([...new Uint8Array(buffer)]).toEqual([...Array(12).keys()]);
    expect(Math.max(...byobReadSizes)).toBe(2);
  });

  it('rejects before reading when bounded BYOB streaming is unavailable', async () => {
    const cancel = vi.fn(async () => {});
    const response = createStreamResponse({
      chunks: [Uint8Array.from({ length: 8 })],
      cancel,
    });

    await expect(
      readResponseBuffer(response, 12, 'bounded peak', undefined, 8, 18, 4),
    ).rejects.toThrow('bounded peak');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reserves assembly headroom for unknown-length responses at exact boundaries', async () => {
    expect(getUnknownLengthPayloadLimit(8)).toBe(3);
    const accepted = createStreamResponse({
      chunks: [Uint8Array.of(1, 2), Uint8Array.of(3)],
      supportsByob: true,
    });
    await expect(readResponseBuffer(accepted, 8, 'too large', undefined)).resolves.toHaveProperty(
      'byteLength',
      3,
    );

    const rejected = createStreamResponse({
      chunks: [Uint8Array.of(1, 2, 3, 4)],
      supportsByob: true,
    });
    await expect(readResponseBuffer(rejected, 8, 'too large', undefined)).rejects.toThrow(
      'too large',
    );
  });

  it('preserves AbortError when stream cancellation rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    const response = createStreamResponse({ cancel, pendingRead: true, supportsByob: true });
    const controller = new AbortController();
    const pending = readResponseBuffer(response, 8, 'too large', controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('inspectEncodedAudioMemory', () => {
  it.each([
    ['mp3', createMp3Buffer(REFERENCE_BYTES)],
    ['mp3', createId3Mp3Buffer()],
    ['mp3', createId3Mp3Buffer(3)],
    ['mp3', createId3Mp3Buffer(4, true)],
    [
      'wav',
      createWaveHeader({
        channels: 2,
        sampleRate: 48_000,
        bitsPerSample: 16,
        dataBytes: 48_000,
      }),
    ],
    [
      'wav',
      createWaveHeader({
        channels: 2,
        sampleRate: 48_000,
        bitsPerSample: 32,
        dataBytes: 96_000,
        formatTag: 3,
      }),
    ],
    ['wav', createExtendedFormatWave(18)],
  ] as const)('safely estimates valid %s browser audio', (format, buffer) => {
    const result = inspectEncodedAudioMemory(buffer);

    expect(result.format).toBe(format);
    expect(result.decodedBytes).toBeGreaterThan(0);
    expect(result.decodedBytes).toBeLessThan(AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT);
  });

  it('accounts for WAV upsampling by the analysis decoder', () => {
    const buffer = createWaveHeader({
      channels: 1,
      sampleRate: 4_000,
      bitsPerSample: 16,
      dataBytes: 8_000,
    });

    expect(inspectEncodedAudioMemory(buffer).decodedBytes).toBe(
      8_000 * Float32Array.BYTES_PER_ELEMENT,
    );
  });

  it('rejects uninspectable formats', () => {
    const malformedWave = createWaveHeader({
      channels: 2,
      sampleRate: 48_000,
      bitsPerSample: 16,
      dataBytes: 100,
    }).slice(0, 44);
    const outsideRiff = createWaveHeader({
      channels: 2,
      sampleRate: 48_000,
      bitsPerSample: 16,
      dataBytes: 100,
    });
    new DataView(outsideRiff).setUint32(4, 4, true);
    const invalidFloat = createWaveHeader({
      channels: 2,
      sampleRate: 48_000,
      bitsPerSample: 8,
      dataBytes: 100,
      formatTag: 3,
    });
    const missingOddPadding = createWaveHeader({
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 8,
      dataBytes: 1,
    });
    const embeddedMp3 = new Uint8Array(1000);
    embeddedMp3.set([0x4f, 0x67, 0x67, 0x53]);
    embeddedMp3.set([0xff, 0xfb, 0x90, 0x64], 100);
    embeddedMp3.set([0xff, 0xfb, 0x90, 0x64], 517);
    const malformedId3 = new Uint8Array(1100);
    malformedId3.set([0x49, 0x44, 0x33, 0xff, 0xff, 0x00, 0, 0, 0, 0]);
    malformedId3.set([0xff, 0xfb, 0x90, 0x64], 10);
    malformedId3.set([0xff, 0xfb, 0x90, 0x64], 427);
    const extendedId3 = new Uint8Array(createId3Mp3Buffer());
    extendedId3[5] = 0x40;
    const badFooter = new Uint8Array(createId3Mp3Buffer(4, true));
    badFooter[10] = 0;
    const reservedEmphasis = new Uint8Array(createMp3Buffer(REFERENCE_BYTES));
    reservedEmphasis[3] = 0x66;
    reservedEmphasis[MP3_FRAME_BYTES + 3] = 0x66;
    for (const buffer of [
      new ArrayBuffer(100),
      createMp3Buffer(100),
      createAdtsBuffer(),
      createOggBuffer('opus'),
      createOggBuffer('vorbis'),
      createCommonUnsupportedBuffer('flac'),
      createCommonUnsupportedBuffer('m4a'),
      createCommonUnsupportedBuffer('webm'),
      malformedWave,
      outsideRiff,
      invalidFloat,
      createExtendedFormatWave(17),
      createExtendedFormatWave(18, 1),
      missingOddPadding,
      embeddedMp3.buffer,
      malformedId3.buffer,
      extendedId3.buffer,
      badFooter.buffer,
      reservedEmphasis.buffer,
      createDuplicateFormatWave(),
      createDuplicateDataWave(),
      createDataBeforeFormatWave(),
      createMp3Buffer(MP3_FRAME_BYTES * 2 + 1),
    ]) {
      expect(() => inspectEncodedAudioMemory(buffer)).toThrow(
        /safely inspect WAV|supports only PCM\/float WAV and MPEG-1 Layer III MP3/,
      );
    }
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
        arrayBuffer: async () => createMp3Buffer(REFERENCE_BYTES),
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

  it('preserves AbortError when decoder context cleanup rejects', async () => {
    let decoderCloses = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData(): Promise<AudioBuffer> {
          return new Promise(() => {});
        }
        async close() {
          decoderCloses++;
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
    expect(decoderCloses).toBe(1);
    expect(fetchedUrls).toEqual(['blob:ref']);
  });

  it('preserves an abort that arrives while decoder close is pending', async () => {
    let markCloseStarted!: () => void;
    let rejectClose!: (error: Error) => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(): Promise<AudioBuffer> {
          return createMockMonoBuffer(decodedReference);
        }
        close(): Promise<void> {
          markCloseStarted();
          return new Promise((_, reject) => {
            rejectClose = reject;
          });
        }
      },
    );
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    });
    await closeStarted;

    controller.abort();
    rejectClose(new Error('close failed'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchedUrls).toEqual(['blob:ref']);
  });

  it('releases the render source on abort without masking AbortError when cleanup throws', async () => {
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const stop = vi.fn(() => {
      throw new Error('stop failed');
    });
    const disconnect = vi.fn(() => {
      throw new Error('disconnect failed');
    });
    let retainedBuffer: AudioBuffer | null = null;
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        createBufferSource() {
          return {
            set buffer(buffer: AudioBuffer | null) {
              retainedBuffer = buffer;
            },
            get buffer() {
              return retainedBuffer;
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
          markRenderStarted();
          return new Promise(() => {});
        }
      },
    );
    const controller = new AbortController();
    const pending = computeAutoSyncOffset('blob:ref', 'blob:tar', {
      signal: controller.signal,
    });
    await renderStarted;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(stop).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(retainedBuffer).toBeNull();
    expect(fetchedUrls).toEqual(['blob:ref']);
  });

  it('releases reference encoded storage and bounds the target default-reader peak', async () => {
    const firstBytes = 40 * MEBIBYTE;
    const secondBytes = 40 * MEBIBYTE;
    const firstArrayBuffer = vi.fn(async () =>
      createWaveHeader({
        channels: 1,
        sampleRate: 96_000,
        bitsPerSample: 16,
        dataBytes: firstBytes - 44,
      }),
    );
    const secondArrayBuffer = vi.fn(async () => createMp3Buffer(secondBytes));
    const cancelSecond = vi.fn(async () => {});
    let request = 0;
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
          structuredClone(data, { transfer: [data] });
          return createMockMonoBuffer(decodedReference);
        }
        async close() {}
      },
    );
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
      '64 MB auto-sync streaming-memory limit',
    );
    expect(AUTO_SYNC_MAX_STREAMING_PEAK_BYTES).toBe(64 * MEBIBYTE);
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

  it('rejects overlong MP3 from its complete frame chain before decoding', async () => {
    const decodeAudioData = vi.fn();
    const overlongFrameCount = Math.floor((300 * 44_100) / 1152) + 1;
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => createMp3Buffer(overlongFrameCount * MP3_FRAME_BYTES),
      })),
    );

    await expect(computeAutoSyncOffset('blob:mp3', 'blob:target')).rejects.toThrow(
      'the limit is 5 minutes',
    );
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it.each([
    ['AAC', createAdtsBuffer()],
    ['Ogg Opus', createOggBuffer('opus')],
    ['FLAC', createCommonUnsupportedBuffer('flac')],
    ['M4A', createCommonUnsupportedBuffer('m4a')],
    ['WebM', createCommonUnsupportedBuffer('webm')],
    [
      'malformed WAV',
      createWaveHeader({
        channels: 2,
        sampleRate: 48_000,
        bitsPerSample: 16,
        dataBytes: 100,
      }).slice(0, 44),
    ],
  ])('rejects unsupported %s before decoding', async (_format, buffer) => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => buffer,
      })),
    );

    await expect(computeAutoSyncOffset('blob:unsupported', 'blob:target')).rejects.toThrow(
      'supports only PCM/float WAV and MPEG-1 Layer III MP3',
    );
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('rejects uninspectable formats before decoding', async () => {
    const decodeAudioData = vi.fn();
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        async close() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(100),
      })),
    );

    await expect(computeAutoSyncOffset('blob:unknown', 'blob:target')).rejects.toThrow(
      'supports only PCM/float WAV and MPEG-1 Layer III MP3',
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
