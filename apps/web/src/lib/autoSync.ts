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
const OGG_FIXED_HEADER_BYTES = 27;
const OGG_CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53] as const;
const OGG_HEADER_FLAG_MASK = 0x07;
const OGG_CONTINUED_PACKET = 0x01;
const OGG_BEGINNING_OF_STREAM = 0x02;
const OGG_END_OF_STREAM = 0x04;
const OGG_MAX_INITIAL_LOGICAL_STREAMS = 16;
const FRAME_ROUNDING_TOLERANCE = 0.25;

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

function malformedOggError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'malformed-media',
    `${label} Ogg framing is malformed or truncated`,
  );
}

function unsupportedChainedOggError(label: string): AutoSyncMediaError {
  return new AutoSyncMediaError(
    'unsupported-chained-ogg',
    `${label} uses chained Ogg logical streams, which auto-sync does not support; ` +
      'convert it to a single Ogg stream or another supported audio format',
  );
}

export function validateAutoSyncOggFraming(buffer: ArrayBuffer, label = 'input'): void {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.byteLength < OGG_CAPTURE_PATTERN.length ||
    OGG_CAPTURE_PATTERN.some((byte, index) => bytes[index] !== byte)
  ) {
    return;
  }

  const view = new DataView(buffer);
  const streams = new Map<
    number,
    { ended: boolean; lastSequence: number; packetContinues: boolean }
  >();
  let initialBosPhase = true;
  let offset = 0;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < OGG_FIXED_HEADER_BYTES) {
      throw malformedOggError(label);
    }
    for (let index = 0; index < OGG_CAPTURE_PATTERN.length; index++) {
      if (bytes[offset + index] !== OGG_CAPTURE_PATTERN[index]) {
        throw malformedOggError(label);
      }
    }

    const version = bytes[offset + 4];
    const headerType = bytes[offset + 5]!;
    if (version !== 0 || (headerType & ~OGG_HEADER_FLAG_MASK) !== 0) {
      throw malformedOggError(label);
    }

    const segmentCount = bytes[offset + 26]!;
    const lacingOffset = offset + OGG_FIXED_HEADER_BYTES;
    if (segmentCount > bytes.byteLength - lacingOffset) {
      throw malformedOggError(label);
    }
    let bodyBytes = 0;
    for (let index = 0; index < segmentCount; index++) {
      bodyBytes += bytes[lacingOffset + index]!;
    }
    const bodyOffset = lacingOffset + segmentCount;
    if (bodyBytes > bytes.byteLength - bodyOffset) {
      throw malformedOggError(label);
    }

    const serial = view.getUint32(offset + 14, true);
    const sequence = view.getUint32(offset + 18, true);
    const isBos = (headerType & OGG_BEGINNING_OF_STREAM) !== 0;
    const isEos = (headerType & OGG_END_OF_STREAM) !== 0;
    const isContinued = (headerType & OGG_CONTINUED_PACKET) !== 0;
    const stream = streams.get(serial);
    const packetContinues = segmentCount > 0 && bytes[lacingOffset + segmentCount - 1] === 255;

    if (!stream) {
      if (!isBos || isContinued || sequence !== 0) {
        throw malformedOggError(label);
      }
      if (!initialBosPhase) {
        throw unsupportedChainedOggError(label);
      }
      if (streams.size >= OGG_MAX_INITIAL_LOGICAL_STREAMS) {
        throw new AutoSyncMediaError(
          'malformed-media',
          `${label} Ogg input contains too many initial logical streams`,
        );
      }
      if (isEos && packetContinues) {
        throw malformedOggError(label);
      }
      streams.set(serial, {
        ended: isEos,
        lastSequence: sequence,
        packetContinues,
      });
    } else {
      if (isBos) {
        if (stream.ended) {
          throw unsupportedChainedOggError(label);
        }
        throw malformedOggError(label);
      }
      if (
        stream.ended ||
        sequence !== (stream.lastSequence + 1) >>> 0 ||
        isContinued !== stream.packetContinues ||
        (isContinued && segmentCount === 0) ||
        (isEos && packetContinues)
      ) {
        throw malformedOggError(label);
      }
      stream.lastSequence = sequence;
      stream.ended = isEos;
      stream.packetContinues = packetContinues;
    }

    if (!isBos || isEos) {
      initialBosPhase = false;
    }
    offset = bodyOffset + bodyBytes;
  }

  for (const stream of streams.values()) {
    if (!stream.ended || stream.packetContinues) {
      throw malformedOggError(label);
    }
  }
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

function checkedDecodedSampleBytes(sample: AudioSample, label: string): number {
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
    throw new AutoSyncMediaError(
      'invalid-metadata',
      `${label} media decoder returned invalid sample-rate, channel, frame, timestamp, or duration metadata`,
    );
  }

  const durationFrames = sample.duration * sample.sampleRate;
  const roundedDurationFrames = Math.round(durationFrames);
  if (
    !Number.isSafeInteger(roundedDurationFrames) ||
    Math.abs(durationFrames - roundedDurationFrames) > FRAME_ROUNDING_TOLERANCE ||
    roundedDurationFrames !== sample.numberOfFrames
  ) {
    throw new AutoSyncMediaError(
      'invalid-metadata',
      `${label} media decoder returned inconsistent audio sample duration`,
    );
  }

  if (
    numberOfFrames > Number.MAX_SAFE_INTEGER / numberOfChannels ||
    numberOfFrames * numberOfChannels > Number.MAX_SAFE_INTEGER / Float32Array.BYTES_PER_ELEMENT
  ) {
    throw decodedLimitError(label);
  }
  return numberOfFrames * numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function timestampToSourceFrame(sample: AudioSample, label: string): number {
  const sourceFrame = sample.timestamp * sample.sampleRate;
  const roundedSourceFrame = Math.round(sourceFrame);
  if (
    !Number.isSafeInteger(roundedSourceFrame) ||
    Math.abs(sourceFrame - roundedSourceFrame) > FRAME_ROUNDING_TOLERANCE
  ) {
    throw new AutoSyncMediaError(
      'invalid-metadata',
      `${label} media decoder returned an audio timestamp that cannot be placed on its sample timeline`,
    );
  }
  return roundedSourceFrame;
}

class StreamingLinearResampler {
  private output: Float32Array | undefined;
  private outputFrames = 0;
  private previousSample = 0;
  private sourceFrames = 0;
  private sourceRate: number | undefined;

  get timelineFrames(): number {
    return this.sourceFrames;
  }

  setSourceRate(sampleRate: number, label: string): void {
    if (this.sourceRate === undefined) {
      this.sourceRate = sampleRate;
    } else if (sampleRate !== this.sourceRate) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} media decoder changed sample rate between audio samples`,
      );
    }
  }

  assertTimelineEnd(endFrame: number, label: string): void {
    if (
      this.sourceRate === undefined ||
      !Number.isSafeInteger(endFrame) ||
      endFrame < this.sourceFrames
    ) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} media decoder returned an invalid or non-monotonic audio timeline`,
      );
    }
    const outputFrames = Math.ceil((endFrame * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) / this.sourceRate);
    if (!Number.isSafeInteger(outputFrames) || outputFrames > AUTO_SYNC_MAX_ANALYSIS_SAMPLES) {
      throw durationLimitError(label, false);
    }
  }

  pushSilence(frameCount: number, label: string): void {
    this.pushConstant(frameCount, 0, label);
  }

  push(samples: Float32Array, label: string): void {
    if (this.sourceRate === undefined) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} media decoder returned PCM before a sample rate was established`,
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

  private pushConstant(frameCount: number, sample: number, label: string): void {
    if (
      this.sourceRate === undefined ||
      !Number.isSafeInteger(frameCount) ||
      frameCount < 0 ||
      frameCount > Number.MAX_SAFE_INTEGER - this.sourceFrames
    ) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} media decoder returned an invalid audio gap`,
      );
    }
    if (frameCount === 0) {
      return;
    }

    if (this.sourceFrames === 0) {
      this.write(sample, label);
      this.previousSample = sample;
      this.sourceFrames = 1;
      frameCount--;
    }
    if (frameCount === 0) {
      return;
    }

    const firstSourceIndex = this.sourceFrames;
    const finalSourceIndex = firstSourceIndex + frameCount - 1;
    let sourcePosition = (this.outputFrames * this.sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
    while (sourcePosition <= finalSourceIndex) {
      if (sourcePosition <= firstSourceIndex) {
        const fraction = sourcePosition - (firstSourceIndex - 1);
        this.write(this.previousSample + (sample - this.previousSample) * fraction, label);
      } else {
        this.write(sample, label);
      }
      sourcePosition = (this.outputFrames * this.sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
    }
    this.previousSample = sample;
    this.sourceFrames += frameCount;
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
  validateAutoSyncOggFraming(encodedBuffer, label);
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
    let chunksSinceYield = 0;
    let previousSampleStartFrame: number | undefined;

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
        const sampleBytes = checkedDecodedSampleBytes(sample, label);
        if (sampleBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT - decodedBytes) {
          throw decodedLimitError(label);
        }
        decodedBytes += sampleBytes;

        resampler.setSourceRate(sample.sampleRate, label);
        const sampleStartFrame = timestampToSourceFrame(sample, label);
        if (previousSampleStartFrame !== undefined && sampleStartFrame < previousSampleStartFrame) {
          throw new AutoSyncMediaError(
            'invalid-metadata',
            `${label} media decoder returned non-monotonic audio sample timestamps`,
          );
        }
        previousSampleStartFrame = sampleStartFrame;

        const sampleEndFrame = sampleStartFrame + sample.numberOfFrames;
        if (!Number.isSafeInteger(sampleEndFrame)) {
          throw new AutoSyncMediaError(
            'invalid-metadata',
            `${label} media decoder returned an audio sample outside the safe timeline range`,
          );
        }
        const frameOffset = Math.max(
          0,
          -sampleStartFrame,
          resampler.timelineFrames - sampleStartFrame,
        );
        const remainingFrames = sample.numberOfFrames - frameOffset;
        if (remainingFrames <= 0) {
          continue;
        }
        const effectiveStartFrame = sampleStartFrame + frameOffset;
        const gapFrames = effectiveStartFrame - resampler.timelineFrames;
        const effectiveEndFrame = effectiveStartFrame + remainingFrames;
        resampler.assertTimelineEnd(effectiveEndFrame, label);
        resampler.pushSilence(gapFrames, label);

        for (
          let copyOffset = frameOffset;
          copyOffset < sample.numberOfFrames;
          copyOffset += DECODE_COPY_CHUNK_FRAMES
        ) {
          throwIfAborted(signal);
          const frameCount = Math.min(DECODE_COPY_CHUNK_FRAMES, sample.numberOfFrames - copyOffset);
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
              frameOffset: copyOffset,
              frameCount,
            });
            for (let frame = 0; frame < frameCount; frame++) {
              monoScratch[frame] += planarScratch[frame];
            }
          }
          for (let frame = 0; frame < frameCount; frame++) {
            monoScratch[frame] /= sample.numberOfChannels;
          }
          resampler.push(monoScratch.subarray(0, frameCount), label);

          chunksSinceYield++;
          if (chunksSinceYield >= DECODE_YIELD_INTERVAL_CHUNKS) {
            chunksSinceYield = 0;
            await yieldForAbort();
            throwIfAborted(signal);
          }
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
