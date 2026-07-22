/**
 * Auto-sync: align a user's recording with a backing track using bounded,
 * normalized correlation in a Web Worker.
 */

import {
  AudioSampleSink,
  BufferSource,
  Input,
  type AudioSample,
  type InputAudioTrack,
} from 'mediabunny';
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_FRAME_SIZE,
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
  AUTO_SYNC_MAX_DURATION_SECONDS,
  AUTO_SYNC_MAX_LAG_SAMPLES,
  AUTO_SYNC_MAX_LAG_SECONDS,
  AUTO_SYNC_MIN_DURATION_SECONDS,
  type CrossCorrelationResult,
} from './autoSyncCore';
import {
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AutoSyncMediaError,
  AUTO_SYNC_INPUT_FORMATS,
  readResponseBuffer,
} from './autoSyncMedia';

export {
  AUTO_SYNC_BYOB_CHUNK_BYTES,
  AUTO_SYNC_INPUT_FORMATS,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  AutoSyncMediaError,
  getUnknownLengthPayloadLimit,
  readResponseBuffer,
  type AutoSyncMediaErrorCode,
} from './autoSyncMedia';

export const AUTO_SYNC_MAX_ANALYSIS_BYTES =
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const DECODE_COPY_CHUNK_FRAMES = 16_384;
const DECODE_YIELD_INTERVAL_CHUNKS = 16;
const TIMELINE_FRAME_TOLERANCE = 0.5;
const MAX_OGG_LOGICAL_STREAMS = 256;
const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53] as const;

export interface AutoSyncResult {
  /** Signed target placement: positive delays it; negative advances its source in-point. */
  offsetSeconds: number;
  /** Normalized correlation confidence (0-1). */
  confidence: number;
}

export interface AutoSyncOptions {
  signal?: AbortSignal;
  workerTimeoutMs?: number;
}

interface DecodedAnalysis {
  samples: Float32Array;
}

function abortError(): DOMException {
  return new DOMException('Auto-sync was cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
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

async function cancelResponseBodyBestEffort(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the HTTP or resource-limit error.
  }
}

function durationLimitError(label: string, tooShort: boolean): AutoSyncMediaError {
  if (tooShort) {
    return new AutoSyncMediaError(
      'invalid-metadata',
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  return new AutoSyncMediaError(
    'invalid-metadata',
    `${label} audio is too long for auto-sync; the limit is ` +
      `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
  );
}

function assertUsableDuration(duration: number, label: string): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AutoSyncMediaError(
      'invalid-metadata',
      `${label} audio has no usable duration for auto-sync`,
    );
  }
  if (duration < AUTO_SYNC_MIN_DURATION_SECONDS) {
    throw durationLimitError(label, true);
  }
  if (duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw durationLimitError(label, false);
  }
}

function parseContentLength(response: Response): number | undefined {
  const value = response.headers?.get('content-length');
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decodedLimitError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'decoded-limit',
    `${label} audio exceeds the 128 MiB decoded-audio memory limit; ` +
      'use a shorter source with fewer channels or a lower sample rate',
  );
}

function malformedMediaError(label: string, cause: unknown): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'malformed-media',
    `Could not decode ${label} media for auto-sync`,
    cause,
  );
}

function invalidSampleMetadataError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'invalid-metadata',
    `${label} media decoder returned invalid sample-rate, channel, frame, timestamp, or duration metadata`,
  );
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface CheckedSampleMetadata {
  decodedBytes: number;
  timestampFrame: number;
  timestampFramesExact: number;
}

function checkedSampleMetadata(sample: AudioSample, label: string): CheckedSampleMetadata {
  const { duration, numberOfChannels, numberOfFrames, sampleRate, timestamp } = sample;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(numberOfChannels) ||
    numberOfChannels <= 0 ||
    !Number.isSafeInteger(numberOfFrames) ||
    numberOfFrames <= 0 ||
    !Number.isFinite(timestamp) ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw invalidSampleMetadataError(label);
  }

  const timestampFramesExact = timestamp * sampleRate;
  const timestampFrame = Math.round(timestampFramesExact);
  const durationFrames = duration * sampleRate;
  const maximumTimelineFrames = sampleRate * AUTO_SYNC_MAX_DURATION_SECONDS;
  if (
    !Number.isFinite(timestampFramesExact) ||
    !Number.isSafeInteger(timestampFrame) ||
    Math.abs(timestampFramesExact - timestampFrame) > TIMELINE_FRAME_TOLERANCE ||
    !Number.isFinite(durationFrames) ||
    Math.abs(durationFrames - numberOfFrames) > TIMELINE_FRAME_TOLERANCE ||
    !Number.isSafeInteger(maximumTimelineFrames) ||
    numberOfFrames > Number.MAX_SAFE_INTEGER / numberOfChannels ||
    numberOfFrames * numberOfChannels > Number.MAX_SAFE_INTEGER / Float32Array.BYTES_PER_ELEMENT
  ) {
    throw invalidSampleMetadataError(label);
  }

  return {
    decodedBytes: numberOfFrames * numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
    timestampFrame,
    timestampFramesExact,
  };
}

function readOggUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function oggFramingError(label: string, detail: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'malformed-media',
    `${label} Ogg framing is truncated or corrupt: ${detail}`,
  );
}

function chainedOggError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'unsupported-chained-ogg',
    `${label} Ogg contains chained logical streams, which auto-sync does not support; ` +
      'remux it to a single Ogg stream',
  );
}

function startsWithOggCapturePattern(bytes: Uint8Array): boolean {
  return OGG_CAPTURE_PATTERN.every((value, index) => bytes[index] === value);
}

function validateOggFraming(encodedBuffer: ArrayBuffer, label: string): void {
  const bytes = new Uint8Array(encodedBuffer);
  if (!startsWithOggCapturePattern(bytes)) {
    return;
  }

  const streams = new Map<number, { ended: boolean; nextSequence: number }>();
  let offset = 0;
  let initialBosRegion = true;
  let anyStreamEnded = false;

  // Lacing is sufficient to walk framing safely; codecs, granules, duration, and CRC stay untouched.
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 27) {
      throw oggFramingError(label, 'incomplete page header');
    }
    if (!OGG_CAPTURE_PATTERN.every((value, index) => bytes[offset + index] === value)) {
      throw oggFramingError(label, 'missing page capture pattern');
    }
    if (bytes[offset + 4] !== 0) {
      throw oggFramingError(label, 'unsupported page version');
    }

    const flags = bytes[offset + 5]!;
    if ((flags & ~0x07) !== 0 || (flags & 0x03) === 0x03) {
      throw oggFramingError(label, 'invalid page header flags');
    }

    const serial = readOggUint32(bytes, offset + 14);
    const sequence = readOggUint32(bytes, offset + 18);
    const segmentCount = bytes[offset + 26]!;
    const lacingOffset = offset + 27;
    const bodyOffset = lacingOffset + segmentCount;
    if (bodyOffset > bytes.byteLength) {
      throw oggFramingError(label, 'incomplete lacing table');
    }

    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index++) {
      bodyLength += bytes[lacingOffset + index]!;
    }
    if (bodyLength > bytes.byteLength - bodyOffset) {
      throw oggFramingError(label, 'incomplete page body');
    }

    const isBos = (flags & 0x02) !== 0;
    const isEos = (flags & 0x04) !== 0;
    const stream = streams.get(serial);
    if (!stream) {
      if (!isBos) {
        throw oggFramingError(label, 'logical stream does not begin with a BOS page');
      }
      if (!initialBosRegion || anyStreamEnded) {
        throw chainedOggError(label);
      }
      if (sequence !== 0) {
        throw oggFramingError(label, 'BOS page sequence number is not zero');
      }
      if (streams.size >= MAX_OGG_LOGICAL_STREAMS) {
        throw oggFramingError(label, 'too many logical streams');
      }
      streams.set(serial, { ended: isEos, nextSequence: 1 });
    } else {
      if (isBos) {
        throw oggFramingError(label, 'logical stream repeats its BOS page');
      }
      if (stream.ended) {
        throw oggFramingError(label, 'logical stream continues after EOS');
      }
      if (sequence !== stream.nextSequence) {
        throw oggFramingError(label, 'non-contiguous page sequence number');
      }
      stream.nextSequence = (sequence + 1) >>> 0;
      stream.ended = isEos;
    }

    if (!isBos) {
      initialBosRegion = false;
    }
    if (isEos) {
      anyStreamEnded = true;
    }
    offset = bodyOffset + bodyLength;
  }
}

class StreamingLinearResampler {
  private output: Float32Array | undefined;
  private outputFrames = 0;
  private previousSample = 0;
  private sourceFrames = 0;
  private sourceRate: number | undefined;

  push(samples: Float32Array, sampleRate: number, label: string): void {
    if (this.sourceRate === undefined) {
      this.sourceRate = sampleRate;
    } else if (sampleRate !== this.sourceRate) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} media decoder changed sample rate between audio samples`,
      );
    }

    for (const sample of samples) {
      if (!Number.isFinite(sample)) {
        throw new AutoSyncMediaError(
          'invalid-metadata',
          `${label} media decoder returned a non-finite PCM sample`,
        );
      }
      if (this.sourceFrames === 0) {
        this.write(sample, label);
        this.previousSample = sample;
        this.sourceFrames = 1;
        continue;
      }

      const sourceIndex = this.sourceFrames;
      let sourcePosition = (this.outputFrames * this.sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
      while (sourcePosition <= sourceIndex) {
        const fraction = sourcePosition - (sourceIndex - 1);
        this.write(this.previousSample + (sample - this.previousSample) * fraction, label);
        sourcePosition = (this.outputFrames * this.sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
      }
      this.previousSample = sample;
      this.sourceFrames++;
    }
  }

  finish(label: string): Float32Array {
    if (this.sourceRate === undefined || this.sourceFrames === 0 || !this.output) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} audio has no usable duration for auto-sync`,
      );
    }

    const expectedOutputFrames = Math.ceil(
      (this.sourceFrames * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) / this.sourceRate,
    );
    if (
      !Number.isSafeInteger(expectedOutputFrames) ||
      expectedOutputFrames <= 0 ||
      expectedOutputFrames > AUTO_SYNC_MAX_ANALYSIS_SAMPLES
    ) {
      throw durationLimitError(label, false);
    }
    while (this.outputFrames < expectedOutputFrames) {
      this.write(this.previousSample, label);
    }

    assertUsableDuration(this.sourceFrames / this.sourceRate, label);
    return this.output.slice(0, this.outputFrames);
  }

  private write(sample: number, label: string): void {
    if (this.outputFrames >= AUTO_SYNC_MAX_ANALYSIS_SAMPLES) {
      throw durationLimitError(label, false);
    }
    this.output ??= new Float32Array(AUTO_SYNC_MAX_ANALYSIS_SAMPLES);
    this.output[this.outputFrames++] = sample;
  }
}

function yieldForAbort(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function selectPrimaryAudioTrack(
  input: Input,
  label: string,
  signal: AbortSignal | undefined,
): Promise<InputAudioTrack> {
  let canRead: boolean;
  try {
    canRead = await raceWithAbort(input.canRead(), signal, () => {
      try {
        input.dispose();
      } catch {
        // Cleanup must not replace AbortError.
      }
    });
  } catch (error) {
    throwIfAborted(signal);
    throw malformedMediaError(label, error);
  }
  if (!canRead) {
    throw new AutoSyncMediaError(
      'unknown-format',
      `${label} media format is not supported for auto-sync`,
    );
  }

  let tracks: InputAudioTrack[];
  let primaryTrack: InputAudioTrack | null;
  try {
    [tracks, primaryTrack] = await raceWithAbort(
      Promise.all([input.getAudioTracks(), input.getPrimaryAudioTrack()]),
      signal,
      () => {
        try {
          input.dispose();
        } catch {
          // Cleanup must not replace AbortError.
        }
      },
    );
  } catch (error) {
    throwIfAborted(signal);
    throw malformedMediaError(label, error);
  }
  if (tracks.length === 0 || primaryTrack === null) {
    throw new AutoSyncMediaError(
      'no-audio-track',
      `${label} media has no audio track to use for auto-sync`,
    );
  }
  if (!tracks.includes(primaryTrack)) {
    throw new AutoSyncMediaError(
      'unproven-track-selection',
      `${label} media primary audio-track selection is inconsistent`,
    );
  }

  let canDecode: boolean;
  try {
    canDecode = await raceWithAbort(primaryTrack.canDecode(), signal, () => {
      try {
        input.dispose();
      } catch {
        // Cleanup must not replace AbortError.
      }
    });
  } catch (error) {
    throwIfAborted(signal);
    throw malformedMediaError(label, error);
  }
  if (!canDecode) {
    throw new AutoSyncMediaError(
      'unknown-codec',
      `${label} media primary audio track cannot be decoded for auto-sync`,
    );
  }
  return primaryTrack;
}

async function closeSample(sample: AudioSample, primaryError: unknown): Promise<void> {
  try {
    sample.close();
  } catch (error) {
    if (primaryError === undefined) {
      throw error;
    }
  }
}

async function decodePrimaryTrackToMono(
  encodedBuffer: ArrayBuffer,
  label: string,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  validateOggFraming(encodedBuffer, label);
  const input = new Input({
    source: new BufferSource(encodedBuffer),
    formats: AUTO_SYNC_INPUT_FORMATS,
  });
  let iterator: AsyncGenerator<AudioSample, void, unknown> | undefined;
  let decoded: Float32Array | undefined;
  let primaryError: unknown;

  try {
    const primaryTrack = await selectPrimaryAudioTrack(input, label, signal);
    iterator = new AudioSampleSink(primaryTrack).samples();
    const resampler = new StreamingLinearResampler();
    let decodedBytes = 0;
    let planarScratch = new Float32Array(0);
    let monoScratch = new Float32Array(0);
    const silenceScratch = new Float32Array(DECODE_COPY_CHUNK_FRAMES);
    let chunksSinceYield = 0;
    let sourceChannels: number | undefined;
    let sourceRate: number | undefined;
    let timelineFrame = 0;
    let previousTimestampFramesExact: number | undefined;

    while (true) {
      throwIfAborted(signal);
      const result = await raceWithAbort(iterator.next(), signal, () => {
        try {
          input.dispose();
        } catch {
          // Cleanup must not replace AbortError.
        }
      });
      throwIfAborted(signal);
      if (result.done) {
        break;
      }

      const sample = result.value;
      let sampleError: unknown;
      try {
        const metadata = checkedSampleMetadata(sample, label);
        if (sourceRate === undefined) {
          sourceRate = sample.sampleRate;
          sourceChannels = sample.numberOfChannels;
        } else if (sample.sampleRate !== sourceRate || sample.numberOfChannels !== sourceChannels) {
          throw new AutoSyncMediaError(
            'invalid-metadata',
            `${label} media decoder changed sample rate or channel count between audio samples`,
          );
        }
        if (
          previousTimestampFramesExact !== undefined &&
          metadata.timestampFramesExact < previousTimestampFramesExact - TIMELINE_FRAME_TOLERANCE
        ) {
          throw new AutoSyncMediaError(
            'invalid-metadata',
            `${label} media decoder returned materially non-monotonic audio timestamps`,
          );
        }
        previousTimestampFramesExact = metadata.timestampFramesExact;

        const sampleEndFrame = metadata.timestampFrame + sample.numberOfFrames;
        if (!Number.isSafeInteger(sampleEndFrame)) {
          throw invalidSampleMetadataError(label);
        }
        if (sampleEndFrame > sourceRate * AUTO_SYNC_MAX_DURATION_SECONDS) {
          throw durationLimitError(label, false);
        }

        const preRollFrames =
          metadata.timestampFramesExact < 0
            ? Math.min(sample.numberOfFrames, Math.ceil(-metadata.timestampFramesExact))
            : 0;
        const placedStartFrame = metadata.timestampFrame + preRollFrames;
        const gapFrames = Math.max(0, placedStartFrame - timelineFrame);
        const gapBytes = gapFrames * Float32Array.BYTES_PER_ELEMENT;
        if (
          !Number.isSafeInteger(gapBytes) ||
          metadata.decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT - decodedBytes ||
          gapBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT - decodedBytes - metadata.decodedBytes
        ) {
          throw decodedLimitError(label);
        }
        decodedBytes += metadata.decodedBytes + gapBytes;

        let remainingGapFrames = gapFrames;
        while (remainingGapFrames > 0) {
          throwIfAborted(signal);
          const frameCount = Math.min(DECODE_COPY_CHUNK_FRAMES, remainingGapFrames);
          resampler.push(silenceScratch.subarray(0, frameCount), sourceRate, label);
          remainingGapFrames -= frameCount;
          chunksSinceYield++;
          if (chunksSinceYield >= DECODE_YIELD_INTERVAL_CHUNKS) {
            chunksSinceYield = 0;
            await yieldForAbort();
            throwIfAborted(signal);
          }
        }
        timelineFrame += gapFrames;

        const overlapFrames = Math.min(
          sample.numberOfFrames - preRollFrames,
          Math.max(0, timelineFrame - placedStartFrame),
        );
        const trimmedFrames = preRollFrames + overlapFrames;
        for (
          let frameOffset = trimmedFrames;
          frameOffset < sample.numberOfFrames;
          frameOffset += DECODE_COPY_CHUNK_FRAMES
        ) {
          throwIfAborted(signal);
          const frameCount = Math.min(
            DECODE_COPY_CHUNK_FRAMES,
            sample.numberOfFrames - frameOffset,
          );
          if (planarScratch.length < frameCount) {
            planarScratch = new Float32Array(frameCount);
            monoScratch = new Float32Array(frameCount);
          } else {
            monoScratch.fill(0, 0, frameCount);
          }

          for (let channel = 0; channel < sample.numberOfChannels; channel++) {
            sample.copyTo(planarScratch.subarray(0, frameCount), {
              planeIndex: channel,
              format: 'f32-planar',
              frameOffset,
              frameCount,
            });
            for (let frame = 0; frame < frameCount; frame++) {
              monoScratch[frame] += planarScratch[frame];
            }
          }
          for (let frame = 0; frame < frameCount; frame++) {
            monoScratch[frame] /= sample.numberOfChannels;
          }
          resampler.push(monoScratch.subarray(0, frameCount), sample.sampleRate, label);

          chunksSinceYield++;
          if (chunksSinceYield >= DECODE_YIELD_INTERVAL_CHUNKS) {
            chunksSinceYield = 0;
            await yieldForAbort();
            throwIfAborted(signal);
          }
        }
        if (trimmedFrames < sample.numberOfFrames) {
          timelineFrame = Math.max(timelineFrame, sampleEndFrame);
        }
      } catch (error) {
        sampleError = error;
        throw error;
      } finally {
        await closeSample(sample, sampleError);
      }
    }

    decoded = resampler.finish(label);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (iterator) {
    try {
      await iterator.return();
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    input.dispose();
  } catch (error) {
    cleanupError ??= error;
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof AutoSyncMediaError || isAbortError(primaryError)) {
      throw primaryError;
    }
    throw malformedMediaError(label, primaryError);
  }
  if (cleanupError !== undefined) {
    throw malformedMediaError(label, cleanupError);
  }
  if (!decoded) {
    throw malformedMediaError(label, new Error('Decoder produced no analysis result'));
  }
  return decoded;
}

async function fetchAndDecodeAudio(
  url: string,
  label: string,
  signal: AbortSignal | undefined,
  retainedAnalysisBytes: number,
): Promise<Float32Array> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`Failed to fetch ${label} audio: HTTP ${response.status}`);
    await cancelResponseBodyBestEffort(response);
    throw error;
  }

  const declaredBytes = parseContentLength(response);
  if (declaredBytes !== undefined && declaredBytes > AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT) {
    const error = new AutoSyncMediaError(
      'encoded-limit',
      `${label} media exceeds the 48 MiB auto-sync encoded-input limit`,
    );
    await cancelResponseBodyBestEffort(response);
    throw error;
  }

  // This encoded reference is scoped to this input and is gone before the next fetch begins.
  const encodedBuffer = await readResponseBuffer(
    response,
    AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
    `${label} media exceeds the 48 MiB auto-sync encoded-input limit`,
    signal,
    declaredBytes,
    AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
    retainedAnalysisBytes,
  );
  throwIfAborted(signal);
  return decodePrimaryTrackToMono(encodedBuffer, label, signal);
}

async function decodeToMono(
  url: string,
  label: string,
  signal: AbortSignal | undefined,
  retainedAnalysisBytes: number,
): Promise<DecodedAnalysis> {
  return {
    samples: await fetchAndDecodeAudio(url, label, signal, retainedAnalysisBytes),
  };
}

function parseWorkerResponse(value: unknown, maxLagSamples: number): CrossCorrelationResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Auto-sync worker returned a malformed response');
  }

  const message = value as Record<string, unknown>;
  if (message.type === 'error') {
    if (typeof message.message !== 'string' || message.message.trim() === '') {
      throw new Error('Auto-sync worker returned a malformed error');
    }
    throw new Error(message.message);
  }
  if (message.type !== 'result') {
    throw new Error('Auto-sync worker returned an unsupported response');
  }
  if (
    typeof message.lagSamples !== 'number' ||
    !Number.isSafeInteger(message.lagSamples) ||
    Math.abs(message.lagSamples) > maxLagSamples ||
    message.lagSamples % AUTO_SYNC_FRAME_SIZE !== 0 ||
    typeof message.confidence !== 'number' ||
    !Number.isFinite(message.confidence) ||
    message.confidence < 0 ||
    message.confidence > 1
  ) {
    throw new Error('Auto-sync worker returned an invalid correlation result');
  }

  return {
    lagSamples: message.lagSamples,
    confidence: message.confidence,
  };
}

function correlateInWorker(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
  options: AutoSyncOptions,
): Promise<CrossCorrelationResult> {
  const timeoutMs = options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Auto-sync worker timeout must be positive'));
  }

  const worker = new Worker(new URL('./autoSync.worker.ts', import.meta.url), {
    type: 'module',
  });

  return new Promise<CrossCorrelationResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const finish = () => {
      if (settled) {
        return false;
      }
      settled = true;
      cleanup();
      return true;
    };
    const succeed = (result: CrossCorrelationResult) => {
      if (finish()) {
        resolve(result);
      }
    };
    const fail = (error: Error) => {
      if (finish()) {
        reject(error);
      }
    };
    const onAbort = () => {
      fail(abortError());
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        succeed(parseWorkerResponse(event.data, maxLagSamples));
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Auto-sync worker failed'));
      }
    };
    worker.onerror = (event) => {
      fail(new Error(`Auto-sync worker error: ${event.message}`));
    };
    worker.onmessageerror = () => {
      fail(new Error('Auto-sync worker returned an unreadable response'));
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Auto-sync analysis timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      worker.postMessage({ type: 'correlate', reference, target, maxLagSamples }, [
        reference.buffer as ArrayBuffer,
        target.buffer as ArrayBuffer,
      ]);
    } catch (error) {
      fail(
        new Error(
          `Could not start auto-sync worker: ${
            error instanceof Error ? error.message : 'unknown worker error'
          }`,
        ),
      );
    }
  });
}

/**
 * Determine the timeline offset between a reference track and a target track.
 *
 * Analysis accepts up to five minutes per input, searches +/-10 seconds, and
 * resolves lag to the nearest 20 ms envelope frame. Positive results delay the
 * target; negative results advance it by trimming the source in-point.
 */
export async function computeAutoSyncOffset(
  referenceUrl: string,
  targetUrl: string,
  options: AutoSyncOptions = {},
): Promise<AutoSyncResult> {
  const reference = await decodeToMono(referenceUrl, 'reference', options.signal, 0);
  const target = await decodeToMono(
    targetUrl,
    'target',
    options.signal,
    reference.samples.byteLength,
  );
  if (reference.samples.byteLength + target.samples.byteLength > AUTO_SYNC_MAX_ANALYSIS_BYTES) {
    throw new Error('Auto-sync inputs exceed the combined analysis-memory limit');
  }
  const { lagSamples, confidence } = await correlateInWorker(
    reference.samples,
    target.samples,
    AUTO_SYNC_MAX_LAG_SAMPLES,
    options,
  );

  return {
    // Positive lag delays the target on the timeline; negative lag advances it.
    offsetSeconds: lagSamples / AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
    confidence,
  };
}

export { AUTO_SYNC_MAX_LAG_SECONDS };
