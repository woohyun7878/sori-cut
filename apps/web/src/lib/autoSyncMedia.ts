import {
  ADTS,
  AudioSampleSink,
  BufferSource,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  OGG,
  QTFF,
  WAVE,
  WEBM,
  type AudioSample,
  type InputFormat,
} from 'mediabunny';
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
} from './autoSyncCore';

const MEBIBYTE = 1024 * 1024;
export const DECODE_YIELD_FRAME_INTERVAL = 16_384;
const CONVERSION_CHUNK_SAMPLES = DECODE_YIELD_FRAME_INTERVAL;
const OGG_FIXED_HEADER_BYTES = 27;
const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53] as const;
const OGG_ALLOWED_HEADER_FLAGS = 0x07;
const OGG_CONTINUED_PACKET_FLAG = 0x01;
const OGG_BEGINNING_OF_STREAM_FLAG = 0x02;
const OGG_END_OF_STREAM_FLAG = 0x04;
const MAX_OGG_LOGICAL_STREAMS = 256;

export const AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT = 48 * MEBIBYTE;
export const AUTO_SYNC_MAX_ENCODED_PEAK_BYTES = 96 * MEBIBYTE;
export const AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT = 128 * MEBIBYTE;
export const AUTO_SYNC_BYOB_CHUNK_BYTES = 64 * 1024;

export const AUTO_SYNC_INPUT_FORMATS: InputFormat[] = [
  MP4,
  QTFF,
  MATROSKA,
  WEBM,
  ADTS,
  OGG,
  FLAC,
  MP3,
  WAVE,
];

export type AutoSyncMediaErrorCode =
  | 'content-length-mismatch'
  | 'decoded-limit'
  | 'encoded-limit'
  | 'invalid-metadata'
  | 'malformed-media'
  | 'missing-response-body'
  | 'no-audio-track'
  | 'unsupported-chained-ogg'
  | 'unproven-track-selection'
  | 'unknown-codec'
  | 'unknown-format';

export class AutoSyncMediaError extends Error {
  readonly code: AutoSyncMediaErrorCode;
  readonly originalCause?: unknown;

  constructor(code: AutoSyncMediaErrorCode, message: string, originalCause?: unknown) {
    super(message);
    this.name = 'AutoSyncMediaError';
    this.code = code;
    this.originalCause = originalCause;
  }
}

function abortError(): DOMException {
  return new DOMException('Auto-sync was cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

type ResponseBodyReader =
  | ReadableStreamBYOBReader
  | ReadableStreamDefaultReader<Uint8Array>;

function cancelReaderBestEffort(reader: ResponseBodyReader): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not replace the primary stream error.
  }
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(abortError());
  }

  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => {
      onAbort?.();
      finish(() => reject(abortError()));
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function checkedProduct(factors: readonly number[]): number | null {
  let product = 1;
  for (const factor of factors) {
    if (!Number.isSafeInteger(factor) || factor < 0 || product > Number.MAX_SAFE_INTEGER / factor) {
      return null;
    }
    product *= factor;
  }
  return product;
}

function decodedLimitError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'decoded-limit',
    `${label} audio exceeds the 128 MiB decoded-audio memory limit; ` +
      'use a shorter source with fewer channels or a lower sample rate',
  );
}

export function getUnknownLengthPayloadLimit(
  maximumBytes: number,
  peakBudgetBytes = maximumBytes * 2,
  retainedBytes = 0,
): number {
  const availableBytes = Math.max(0, peakBudgetBytes - retainedBytes);
  return Math.min(maximumBytes, Math.floor(availableBytes / 2));
}

async function readDeclaredByob(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number,
  peakBudgetBytes: number,
  retainedBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer | null> {
  let reader: ReadableStreamBYOBReader;
  try {
    reader = body.getReader({ mode: 'byob' });
  } catch {
    return null;
  }

  const scratchBytes = Math.min(
    AUTO_SYNC_BYOB_CHUNK_BYTES,
    Math.max(0, peakBudgetBytes - retainedBytes - declaredBytes),
  );
  if (scratchBytes < 1) {
    cancelReaderBestEffort(reader);
    throw new AutoSyncMediaError('encoded-limit', limitMessage);
  }

  const destination = new Uint8Array(declaredBytes);
  let scratch = new Uint8Array(scratchBytes);
  let totalBytes = 0;
  try {
    while (true) {
      const requestBytes = Math.min(scratch.byteLength, Math.max(1, declaredBytes - totalBytes));
      const request = scratch.subarray(0, requestBytes);
      const result = await raceWithAbort(reader.read(request), signal, () => {
        cancelReaderBestEffort(reader);
      });
      throwIfAborted(signal);
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        throw new AutoSyncMediaError(
          'content-length-mismatch',
          'Audio response returned an empty byte-stream view',
        );
      }

      if (
        result.value.byteLength > requestBytes ||
        totalBytes > declaredBytes - result.value.byteLength
      ) {
        throw new AutoSyncMediaError(
          'content-length-mismatch',
          'Audio response did not match its Content-Length',
        );
      }

      const previousOwnerBytes =
        result.value.buffer === scratch.buffer ? 0 : scratch.buffer.byteLength;
      const returnedOwnerBytes = result.value.buffer.byteLength;
      const availableOwnerBytes = peakBudgetBytes - retainedBytes - declaredBytes;
      if (
        previousOwnerBytes > availableOwnerBytes ||
        returnedOwnerBytes > availableOwnerBytes - previousOwnerBytes
      ) {
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }
      destination.set(result.value, totalBytes);
      totalBytes += result.value.byteLength;

      const scratchOffset = result.value.byteOffset;
      if (
        scratchOffset > result.value.buffer.byteLength ||
        scratchBytes > result.value.buffer.byteLength - scratchOffset
      ) {
        throw new AutoSyncMediaError(
          'content-length-mismatch',
          'Audio byte stream returned incompatible buffer ownership',
        );
      }
      scratch = new Uint8Array(result.value.buffer, scratchOffset, scratchBytes);
    }

    if (totalBytes !== declaredBytes) {
      throw new AutoSyncMediaError(
        'content-length-mismatch',
        'Audio response did not match its Content-Length',
      );
    }

    return destination.buffer;
  } catch (error) {
    cancelReaderBestEffort(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can retain the lock briefly after cancellation.
    }
  }
}

export async function readResponseBuffer(
  response: Response,
  maximumBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
  declaredBytes?: number,
  peakBudgetBytes = maximumBytes * 2,
  retainedBytes = 0,
): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new AutoSyncMediaError(
      'missing-response-body',
      'Auto-sync requires a streaming response body to enforce its encoded-memory limit',
    );
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('maximumBytes must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(peakBudgetBytes) ||
    peakBudgetBytes < 0 ||
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    retainedBytes > peakBudgetBytes
  ) {
    throw new RangeError('encoded peak and retained bytes must be non-negative safe integers');
  }
  if (
    declaredBytes !== undefined &&
    (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maximumBytes)
  ) {
    throw new RangeError('declaredBytes must be within the configured encoded limit');
  }
  if (declaredBytes !== undefined) {
    const byobBuffer = await readDeclaredByob(
      response.body,
      declaredBytes,
      peakBudgetBytes,
      retainedBytes,
      limitMessage,
      signal,
    );
    if (byobBuffer !== null) {
      return byobBuffer;
    }
  }

  // Default readers are the correctness fallback; no fetch chunk-size guarantee is assumed.
  const reader = response.body.getReader();
  let destination: Uint8Array | null = null;
  const chunks: Uint8Array[] = [];
  const payloadLimit =
    declaredBytes === undefined
      ? getUnknownLengthPayloadLimit(maximumBytes, peakBudgetBytes, retainedBytes)
      : maximumBytes;
  let totalBytes = 0;

  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal, () => {
        cancelReaderBestEffort(reader);
      });
      throwIfAborted(signal);
      if (result.done) {
        if (declaredBytes !== undefined && totalBytes !== declaredBytes) {
          cancelReaderBestEffort(reader);
          throw new AutoSyncMediaError(
            'content-length-mismatch',
            'Audio response did not match its Content-Length',
          );
        }
        break;
      }

      const chunkBytes = result.value.byteLength;
      const ownerBytes = result.value.buffer.byteLength;
      if (totalBytes > Number.MAX_SAFE_INTEGER - chunkBytes) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }
      const nextTotal = totalBytes + chunkBytes;
      if (declaredBytes !== undefined && nextTotal > declaredBytes) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError(
          'content-length-mismatch',
          'Audio response did not match its Content-Length',
        );
      }
      if (nextTotal > payloadLimit) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }

      if (
        declaredBytes !== undefined &&
        (
          declaredBytes > peakBudgetBytes - retainedBytes ||
          ownerBytes > peakBudgetBytes - retainedBytes - declaredBytes
        )
      ) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }
      if (
        declaredBytes === undefined &&
        (
          totalBytes > peakBudgetBytes - retainedBytes ||
          ownerBytes > peakBudgetBytes - retainedBytes - totalBytes ||
          chunkBytes > peakBudgetBytes - retainedBytes - totalBytes - ownerBytes
        )
      ) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }
      if (declaredBytes !== undefined && destination === null) {
        destination = new Uint8Array(declaredBytes);
      }
      if (destination !== null) {
        destination.set(result.value, totalBytes);
      } else {
        chunks.push(Uint8Array.from(result.value));
      }
      totalBytes = nextTotal;
    }
  } catch (error) {
    cancelReaderBestEffort(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read can retain the lock briefly after cancellation.
    }
  }

  if (declaredBytes !== undefined) {
    if (destination === null) {
      return new ArrayBuffer(0);
    }
    if (!(destination.buffer instanceof ArrayBuffer)) {
      throw new Error('Auto-sync declared response storage has unsupported buffer ownership');
    }
    return destination.buffer;
  }

  throwIfAborted(signal);
  const combined = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return combined.buffer;
}

class MonoSampleAccumulator {
  private readonly chunks: Float32Array[] = [];
  private currentChunk: Float32Array | null = null;
  private currentChunkLength = 0;
  length = 0;

  constructor(private readonly label: string) {}

  push(value: number): void {
    if (!Number.isFinite(value)) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${this.label} audio decoder returned a non-finite sample`,
      );
    }
    if (this.length >= AUTO_SYNC_MAX_ANALYSIS_SAMPLES) {
      throw new Error(`${this.label} audio exceeds the bounded auto-sync sample budget`);
    }
    if (this.currentChunk === null || this.currentChunkLength === this.currentChunk.length) {
      this.currentChunk = new Float32Array(
        Math.min(CONVERSION_CHUNK_SAMPLES, AUTO_SYNC_MAX_ANALYSIS_SAMPLES - this.length),
      );
      this.currentChunkLength = 0;
      this.chunks.push(this.currentChunk);
    }
    this.currentChunk[this.currentChunkLength++] = value;
    this.length++;
  }

  finish(): Float32Array {
    const output = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      const copyLength = Math.min(chunk.length, this.length - offset);
      output.set(chunk.subarray(0, copyLength), offset);
      offset += copyLength;
    }
    return output;
  }
}

function closeSampleBestEffort(sample: AudioSample): void {
  try {
    sample.close();
  } catch {
    // Sample cleanup must not replace a decode, limit, or abort error.
  }
}

interface OggStreamState {
  ended: boolean;
  nextSequenceNumber: number;
  unfinishedPacket: boolean;
}

function malformedOggError(label: string, detail: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'malformed-media',
    `${label} media contains malformed or truncated Ogg framing: ${detail}`,
  );
}

function validateOggFraming(buffer: ArrayBuffer, label: string): void {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.byteLength < OGG_CAPTURE_PATTERN.length ||
    OGG_CAPTURE_PATTERN.some((byte, index) => bytes[index] !== byte)
  ) {
    return;
  }

  const view = new DataView(buffer);
  const streams = new Map<number, OggStreamState>();
  let offset = 0;
  let initialBosRegion = true;
  let sawEndOfStream = false;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < OGG_FIXED_HEADER_BYTES) {
      throw malformedOggError(label, 'truncated page header');
    }
    if (OGG_CAPTURE_PATTERN.some((byte, index) => bytes[offset + index] !== byte)) {
      throw malformedOggError(label, 'invalid page capture pattern');
    }
    if (bytes[offset + 4] !== 0) {
      throw malformedOggError(label, 'unsupported page version');
    }

    const headerFlags = bytes[offset + 5];
    if (
      headerFlags === undefined ||
      (headerFlags & ~OGG_ALLOWED_HEADER_FLAGS) !== 0
    ) {
      throw malformedOggError(label, 'invalid page header flags');
    }

    const pageSegments = bytes[offset + 26];
    if (pageSegments === undefined) {
      throw malformedOggError(label, 'truncated page header');
    }
    const lacingOffset = offset + OGG_FIXED_HEADER_BYTES;
    if (pageSegments > bytes.byteLength - lacingOffset) {
      throw malformedOggError(label, 'truncated page lacing table');
    }

    let bodyLength = 0;
    for (let index = 0; index < pageSegments; index++) {
      const segmentLength = bytes[lacingOffset + index];
      if (
        segmentLength === undefined ||
        bodyLength > Number.MAX_SAFE_INTEGER - segmentLength
      ) {
        throw malformedOggError(label, 'invalid page body length');
      }
      bodyLength += segmentLength;
    }
    const bodyOffset = lacingOffset + pageSegments;
    if (bodyLength > bytes.byteLength - bodyOffset) {
      throw malformedOggError(label, 'truncated page body');
    }
    const continuesPacket =
      pageSegments > 0 && bytes[lacingOffset + pageSegments - 1] === 255;

    const serialNumber = view.getUint32(offset + 14, true);
    const sequenceNumber = view.getUint32(offset + 18, true);
    const isContinued = (headerFlags & OGG_CONTINUED_PACKET_FLAG) !== 0;
    const isBos = (headerFlags & OGG_BEGINNING_OF_STREAM_FLAG) !== 0;
    const isEos = (headerFlags & OGG_END_OF_STREAM_FLAG) !== 0;
    if (isEos && continuesPacket) {
      throw malformedOggError(label, 'EOS page ends with an unfinished packet');
    }
    const stream = streams.get(serialNumber);

    if (stream === undefined) {
      if (!isBos) {
        throw malformedOggError(label, 'logical stream does not begin with a BOS page');
      }
      if (isContinued) {
        throw malformedOggError(label, 'BOS page cannot continue a prior packet');
      }
      if (!initialBosRegion || sawEndOfStream) {
        throw new AutoSyncMediaError(
          'unsupported-chained-ogg',
          `${label} media uses unsupported chained Ogg logical streams; remux it as a single Ogg stream`,
        );
      }
      if (sequenceNumber !== 0) {
        throw malformedOggError(label, 'invalid BOS page');
      }
      if (streams.size >= MAX_OGG_LOGICAL_STREAMS) {
        throw malformedOggError(label, 'too many logical streams');
      }
      streams.set(serialNumber, {
        ended: isEos,
        nextSequenceNumber: 1,
        unfinishedPacket: continuesPacket,
      });
    } else {
      if (isBos || stream.ended) {
        throw malformedOggError(label, 'invalid page after logical stream start or EOS');
      }
      if (sequenceNumber !== stream.nextSequenceNumber) {
        throw malformedOggError(label, 'logical stream page sequence regressed or skipped');
      }
      if (isContinued !== stream.unfinishedPacket) {
        throw malformedOggError(label, 'page continuation flag does not match prior lacing');
      }
      if (isContinued && pageSegments === 0) {
        // An empty page cannot carry the segment needed to continue or finish the packet.
        throw malformedOggError(label, 'continued page has no packet segments');
      }
      stream.nextSequenceNumber = (sequenceNumber + 1) >>> 0;
      stream.ended = isEos;
      stream.unfinishedPacket = continuesPacket;
    }

    if (!isBos) {
      initialBosRegion = false;
    }
    if (isEos) {
      sawEndOfStream = true;
    }
    offset = bodyOffset + bodyLength;
  }

  if (streams.size === 0 || [...streams.values()].some((stream) => !stream.ended)) {
    throw malformedOggError(label, 'logical stream is missing its EOS page');
  }
}

export async function decodeEncodedAudioToMono(
  buffer: ArrayBuffer,
  label = 'input',
  signal?: AbortSignal,
  maximumDecodedBytes = AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
): Promise<Float32Array> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(maximumDecodedBytes) || maximumDecodedBytes < 0) {
    throw new RangeError('maximumDecodedBytes must be a non-negative safe integer');
  }
  validateOggFraming(buffer, label);
  const input = new Input({
    source: new BufferSource(buffer),
    formats: AUTO_SYNC_INPUT_FORMATS,
  });
  const dispose = () => input.dispose();

  try {
    let canRead: boolean;
    try {
      canRead = await raceWithAbort(input.canRead(), signal, dispose);
    } catch (error) {
      throwIfAborted(signal);
      throw new AutoSyncMediaError(
        'malformed-media',
        `${label} media is malformed and its audio metadata could not be read`,
        error,
      );
    }
    if (!canRead) {
      throw new AutoSyncMediaError(
        'unknown-format',
        `${label} media format is not supported for auto-sync`,
      );
    }

    const [audioTracks, primaryTrack] = await raceWithAbort(
      Promise.all([input.getAudioTracks(), input.getPrimaryAudioTrack()]),
      signal,
      dispose,
    );
    if (audioTracks.length === 0) {
      throw new AutoSyncMediaError(
        'no-audio-track',
        `${label} media has no audio track to use for auto-sync`,
      );
    }
    const primaryTrackIndex = primaryTrack === null ? -1 : audioTracks.indexOf(primaryTrack);
    if (primaryTrackIndex < 0) {
      throw new AutoSyncMediaError(
        'unproven-track-selection',
        `${label} media primary audio-track selection is ambiguous`,
      );
    }
    const selectedTrack = audioTracks[primaryTrackIndex];
    if (!selectedTrack) {
      throw new AutoSyncMediaError(
        'unproven-track-selection',
        `${label} media primary audio-track selection is ambiguous`,
      );
    }

    let canDecode: boolean;
    try {
      canDecode = await raceWithAbort(selectedTrack.canDecode(), signal, dispose);
    } catch (error) {
      throwIfAborted(signal);
      throw new AutoSyncMediaError(
        'malformed-media',
        `${label} media audio codec could not be inspected`,
        error,
      );
    }
    if (!canDecode) {
      throw new AutoSyncMediaError(
        'unknown-codec',
        `${label} media primary audio track cannot be decoded by this browser`,
      );
    }

    const sink = new AudioSampleSink(selectedTrack);
    const iterator = sink.samples()[Symbol.asyncIterator]();
    let iteratorCompleted = false;
    let iteratorReturnPromise: Promise<IteratorResult<AudioSample, void>> | undefined;
    const returnIterator = () => {
      iteratorReturnPromise ??= iterator.return
        ? iterator.return()
        : Promise.resolve({ done: true as const, value: undefined });
      return iteratorReturnPromise;
    };
    const accumulator = new MonoSampleAccumulator(label);
    const channelScratch = new Float32Array(CONVERSION_CHUNK_SAMPLES);
    const monoScratch = new Float32Array(CONVERSION_CHUNK_SAMPLES);
    let decodedBytes = 0;
    let sourceChannels = 0;
    let sourceFrames = 0;
    let sourceRate = 0;
    let outputIndex = 0;
    let previousMono = 0;
    let previousTimestamp = -Infinity;
    let processedSourceFramesSinceYield = 0;

    const emitThroughSourceFrame = (currentMono: number, currentFrameIndex: number) => {
      if (currentFrameIndex === 0) {
        accumulator.push(currentMono);
        outputIndex = 1;
        previousMono = currentMono;
        return;
      }
      while ((outputIndex * sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE <= currentFrameIndex) {
        const sourcePosition =
          (outputIndex * sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
        const fraction = sourcePosition - (currentFrameIndex - 1);
        accumulator.push(previousMono + (currentMono - previousMono) * fraction);
        outputIndex++;
      }
      previousMono = currentMono;
    };
    const appendSilenceUntil = async (endFrameExclusive: number) => {
      const lastSilenceFrame = endFrameExclusive - 1;
      let emittedSinceYield = 0;
      while (
        (outputIndex * sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE <= lastSilenceFrame
      ) {
        throwIfAborted(signal);
        const sourcePosition =
          (outputIndex * sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
        const value =
          sourceFrames > 0 && sourcePosition < sourceFrames
            ? previousMono * (sourceFrames - sourcePosition)
            : 0;
        accumulator.push(value);
        outputIndex++;
        emittedSinceYield++;
        if (emittedSinceYield === CONVERSION_CHUNK_SAMPLES) {
          emittedSinceYield = 0;
          await yieldForAbort();
        }
      }
      previousMono = 0;
      sourceFrames = endFrameExclusive;
    };

    try {
      while (true) {
        throwIfAborted(signal);
        const result = await raceWithAbort(iterator.next(), signal, () => {
          void returnIterator().catch(() => undefined);
        });
        if (result.done) {
          iteratorCompleted = true;
          break;
        }

        const sample = result.value;
        try {
          throwIfAborted(signal);
          const { numberOfChannels, numberOfFrames, sampleRate, timestamp } = sample;
          if (
            !Number.isSafeInteger(sampleRate) ||
            sampleRate <= 0 ||
            !Number.isSafeInteger(numberOfChannels) ||
            numberOfChannels <= 0 ||
            !Number.isSafeInteger(numberOfFrames) ||
            numberOfFrames <= 0 ||
            !Number.isFinite(timestamp) ||
            timestamp < previousTimestamp ||
            !Number.isFinite(sample.duration) ||
            sample.duration <= 0 ||
            !Number.isFinite(timestamp + sample.duration)
          ) {
            throw new AutoSyncMediaError(
              'invalid-metadata',
              `${label} media decoder returned an invalid audio sample shape or timestamp`,
            );
          }
          if (sourceRate === 0) {
            sourceRate = sampleRate;
            sourceChannels = numberOfChannels;
            if (sourceRate > Number.MAX_SAFE_INTEGER / AUTO_SYNC_MAX_ANALYSIS_SAMPLES) {
              throw decodedLimitError(label);
            }
          } else if (sampleRate !== sourceRate || numberOfChannels !== sourceChannels) {
            throw new AutoSyncMediaError(
              'invalid-metadata',
              `${label} media changes sample rate or channel count within its primary audio track`,
            );
          }
          const sampleBytes = checkedProduct([
            numberOfFrames,
            numberOfChannels,
            Float32Array.BYTES_PER_ELEMENT,
          ]);
          if (
            sampleBytes === null ||
            decodedBytes > maximumDecodedBytes - sampleBytes
          ) {
            throw decodedLimitError(label);
          }
          decodedBytes += sampleBytes;
          previousTimestamp = timestamp;
          let firstPresentedFrame =
            timestamp < 0
              ? Math.min(numberOfFrames, Math.ceil(-timestamp * sampleRate))
              : 0;
          const rawStartFrame = Math.round(timestamp * sampleRate);
          if (!Number.isSafeInteger(rawStartFrame)) {
            throw new Error(`${label} audio exceeds the bounded auto-sync sample budget`);
          }
          let sampleStartFrame = rawStartFrame + firstPresentedFrame;
          if (!Number.isSafeInteger(sampleStartFrame) || sampleStartFrame < 0) {
            throw new AutoSyncMediaError(
              'invalid-metadata',
              `${label} media decoder returned an invalid audio sample timestamp`,
            );
          }
          if (sampleStartFrame > sourceFrames) {
            await appendSilenceUntil(sampleStartFrame);
          } else if (sampleStartFrame < sourceFrames) {
            const overlappingFrames = sourceFrames - sampleStartFrame;
            firstPresentedFrame = Math.min(
              numberOfFrames,
              firstPresentedFrame + overlappingFrames,
            );
            sampleStartFrame += overlappingFrames;
          }
          const presentedFrames = numberOfFrames - firstPresentedFrame;
          if (presentedFrames <= 0) {
            continue;
          }
          if (sourceFrames > Number.MAX_SAFE_INTEGER - presentedFrames) {
            throw decodedLimitError(label);
          }

          let frameOffset = firstPresentedFrame;
          while (frameOffset < numberOfFrames) {
            throwIfAborted(signal);
            const framesUntilYield =
              DECODE_YIELD_FRAME_INTERVAL - processedSourceFramesSinceYield;
            const frameCount = Math.min(
              CONVERSION_CHUNK_SAMPLES,
              framesUntilYield,
              numberOfFrames - frameOffset,
            );
            monoScratch.fill(0, 0, frameCount);
            for (let channel = 0; channel < numberOfChannels; channel++) {
              sample.copyTo(channelScratch, {
                planeIndex: channel,
                format: 'f32-planar',
                frameOffset,
                frameCount,
              });
              for (let frame = 0; frame < frameCount; frame++) {
                monoScratch[frame] += channelScratch[frame] / numberOfChannels;
              }
            }
            for (let frame = 0; frame < frameCount; frame++) {
              emitThroughSourceFrame(monoScratch[frame], sourceFrames);
              sourceFrames++;
            }
            frameOffset += frameCount;
            processedSourceFramesSinceYield += frameCount;
            if (processedSourceFramesSinceYield === DECODE_YIELD_FRAME_INTERVAL) {
              processedSourceFramesSinceYield = 0;
              await yieldForAbort();
              throwIfAborted(signal);
            }
          }
        } finally {
          closeSampleBestEffort(sample);
        }
      }

      if (sourceFrames <= 0 || sourceRate <= 0) {
        throw new AutoSyncMediaError(
          'invalid-metadata',
          `${label} media primary audio track contains no decodable samples`,
        );
      }
      const outputLength = Math.ceil(
        (sourceFrames * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) / sourceRate,
      );
      if (
        !Number.isSafeInteger(outputLength) ||
        outputLength <= 0 ||
        outputLength > AUTO_SYNC_MAX_ANALYSIS_SAMPLES
      ) {
        throw new Error(`${label} audio exceeds the bounded auto-sync sample budget`);
      }
      while (outputIndex < outputLength) {
        accumulator.push(previousMono);
        outputIndex++;
      }
      throwIfAborted(signal);
      return accumulator.finish();
    } finally {
      if (!iteratorCompleted) {
        await returnIterator().catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof AutoSyncMediaError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new AutoSyncMediaError(
      'malformed-media',
      `${label} media is malformed and could not be decoded for auto-sync`,
      error,
    );
  } finally {
    input.dispose();
  }
}

function yieldForAbort(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
