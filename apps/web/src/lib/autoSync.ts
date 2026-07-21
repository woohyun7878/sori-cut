/**
 * Auto-sync: align a user's recording with a backing track using bounded,
 * normalized correlation in a Web Worker.
 */

import {
  CouldNotDetermineFileTypeError,
  parseBuffer,
  UnsupportedFileTypeError,
  type IFormat,
} from 'music-metadata';

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

export const AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT = 48 * 1024 * 1024;
export const AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES = 64 * 1024 * 1024;
export const AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT = 128 * 1024 * 1024;
export const AUTO_SYNC_MAX_ANALYSIS_BYTES =
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 5_000;
const SUPPORTED_AUDIO_DESCRIPTION = 'MP3, AAC, FLAC, Ogg, M4A, WebM, or WAV';

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

export type AutoSyncInputErrorCode =
  'unsupported-format' | 'malformed-metadata' | 'decoded-memory-limit';

export class AutoSyncInputError extends Error {
  constructor(
    readonly code: AutoSyncInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutoSyncInputError';
  }
}

interface DecodedAnalysis {
  samples: Float32Array;
  encodedBytes: number;
}

function abortError(): DOMException {
  return new DOMException('Auto-sync was cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

async function probeAudioDuration(
  url: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  const audio = new Audio();
  audio.preload = 'metadata';

  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    };
    const succeed = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error(`${label} audio has no usable duration for auto-sync`));
        return;
      }
      resolve(duration);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleAbort = () => fail(abortError());
    const timeoutId = setTimeout(() => {
      fail(new Error(`Timed out while reading ${label} audio metadata`));
    }, METADATA_TIMEOUT_MS);

    audio.onloadedmetadata = succeed;
    audio.onerror = () => fail(new Error(`Could not read ${label} audio metadata`));
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    audio.src = url;
    audio.load();
  });
}

type ResponseBodyReader = ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;

function cancelReaderBestEffort(reader: ResponseBodyReader): void {
  try {
    // Cancellation is cleanup; it must never replace the primary abort/limit error.
    void reader.cancel().catch(() => undefined);
  } catch {
    // Some stream implementations throw synchronously from cancel().
  }
}

async function cancelResponseBodyBestEffort(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the HTTP/limit error that caused cancellation.
  }
}

export function getUnknownLengthPayloadLimit(maximumBytes: number): number {
  return Math.floor(maximumBytes / 2);
}

async function readDeclaredByob(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer | null> {
  let reader: ReadableStreamBYOBReader;
  try {
    reader = body.getReader({ mode: 'byob' });
  } catch {
    return null;
  }

  let storage = new Uint8Array(declaredBytes);
  let totalBytes = 0;
  try {
    while (totalBytes < declaredBytes) {
      const result = await raceWithAbort(reader.read(storage.subarray(totalBytes)), signal, () => {
        cancelReaderBestEffort(reader);
      });
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        throw new Error('Audio response returned an empty stream chunk');
      }

      const returnedBuffer = result.value.buffer;
      if (
        !(returnedBuffer instanceof ArrayBuffer) ||
        result.value.byteOffset !== totalBytes ||
        returnedBuffer.byteLength !== declaredBytes
      ) {
        throw new Error('Audio response returned an invalid byte stream');
      }
      storage = new Uint8Array(returnedBuffer);
      totalBytes += result.value.byteLength;
    }

    if (totalBytes !== declaredBytes) {
      throw new Error('Audio response did not match its Content-Length');
    }

    // Exact Content-Length has been filled directly; cancel instead of allocating
    // a sentinel read buffer solely to discover a non-conforming extra byte.
    cancelReaderBestEffort(reader);
    return storage.buffer;
  } catch (error) {
    cancelReaderBestEffort(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock briefly after cancellation.
    }
  }
}

export async function readResponseBuffer(
  response: Response,
  maximumBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
  declaredBytes?: number,
): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new Error('Audio response body is unavailable for bounded reading');
  }

  if (declaredBytes !== undefined) {
    if (declaredBytes > maximumBytes) {
      await cancelResponseBodyBestEffort(response);
      throw new Error(limitMessage);
    }
    const byobBuffer = await readDeclaredByob(response.body, declaredBytes, signal);
    if (byobBuffer !== null) {
      return byobBuffer;
    }
  }

  const reader = response.body.getReader();
  const preallocated = declaredBytes === undefined ? null : new Uint8Array(declaredBytes);
  const chunks: Uint8Array[] = [];
  const payloadLimit =
    preallocated === null ? getUnknownLengthPayloadLimit(maximumBytes) : maximumBytes;
  let totalBytes = 0;
  try {
    if (
      preallocated !== null &&
      preallocated.byteLength > getUnknownLengthPayloadLimit(maximumBytes)
    ) {
      cancelReaderBestEffort(reader);
      throw new Error(limitMessage);
    }
    while (true) {
      const result = await raceWithAbort(reader.read(), signal, () => {
        cancelReaderBestEffort(reader);
      });
      if (result.done) {
        break;
      }
      const nextTotal = totalBytes + result.value.byteLength;
      if (
        !Number.isSafeInteger(nextTotal) ||
        nextTotal > payloadLimit ||
        (preallocated !== null &&
          (nextTotal > preallocated.byteLength ||
            preallocated.byteLength + result.value.byteLength > maximumBytes))
      ) {
        cancelReaderBestEffort(reader);
        throw new Error(limitMessage);
      }
      if (preallocated === null) {
        chunks.push(result.value);
      } else {
        preallocated.set(result.value, totalBytes);
      }
      totalBytes = nextTotal;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock briefly after cancellation.
    }
  }

  if (preallocated !== null) {
    if (totalBytes !== preallocated.byteLength) {
      throw new Error('Audio response did not match its Content-Length');
    }
    return preallocated.buffer;
  }

  const combined = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return combined.buffer;
}

function isSupportedAudioFormat(format: IFormat): boolean {
  const container = format.container?.trim().toLowerCase() ?? '';
  const codec = format.codec?.trim().toLowerCase() ?? '';
  if (container === 'wave' || container === 'flac' || container === 'ogg') {
    return true;
  }
  if (container === 'mpeg') {
    return /^mpeg (?:1|2|2\.5) layer (?:3|iii)$/.test(codec);
  }
  if (container === 'adts/mpeg-2' || container === 'adts/mpeg-4') {
    return codec === 'aac';
  }
  if (container === 'ebml/webm') {
    return codec.includes('opus') || codec.includes('vorbis');
  }

  const mp4Brands = container.split('/');
  const hasMp4Brand = mp4Brands.some((brand) =>
    ['m4a', 'mp4', 'mp41', 'mp42', 'isom', 'iso2', 'dash'].includes(brand),
  );
  return hasMp4Brand && codec.includes('aac') && format.hasVideo !== true;
}

function calculateDecodedBytes(
  duration: number,
  sampleRate: number,
  channels: number,
): number | null {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(channels) ||
    channels <= 0
  ) {
    return null;
  }

  const bytesPerFrame = channels * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(bytesPerFrame) ||
    bytesPerFrame > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const sampleFrames = Math.ceil(duration * sampleRate);
  if (!Number.isSafeInteger(sampleFrames)) {
    return Number.POSITIVE_INFINITY;
  }
  if (sampleFrames > Math.floor(AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT / bytesPerFrame)) {
    return Number.POSITIVE_INFINITY;
  }
  return sampleFrames * bytesPerFrame;
}

async function inspectAudioMemory(
  buffer: ArrayBuffer,
  contentType: string | null,
  label: string,
): Promise<{
  duration: number;
  decodedBytes: number;
}> {
  let format: IFormat;
  try {
    const metadata = await parseBuffer(
      new Uint8Array(buffer),
      contentType?.split(';', 1)[0] || undefined,
      {
        duration: true,
        skipCovers: true,
      },
    );
    format = metadata.format;
  } catch (error) {
    if (
      error instanceof CouldNotDetermineFileTypeError ||
      error instanceof UnsupportedFileTypeError
    ) {
      throw new AutoSyncInputError(
        'unsupported-format',
        `${label} audio is not a supported ${SUPPORTED_AUDIO_DESCRIPTION} file`,
      );
    }
    throw new AutoSyncInputError(
      'malformed-metadata',
      `Could not read ${label} audio metadata; export it again as ${SUPPORTED_AUDIO_DESCRIPTION}`,
    );
  }

  if (!isSupportedAudioFormat(format)) {
    throw new AutoSyncInputError(
      'unsupported-format',
      `${label} audio is not a supported ${SUPPORTED_AUDIO_DESCRIPTION} file`,
    );
  }
  const { duration, sampleRate, numberOfChannels } = format;
  const decodedBytes =
    duration === undefined || sampleRate === undefined || numberOfChannels === undefined
      ? null
      : calculateDecodedBytes(duration, sampleRate, numberOfChannels);
  if (decodedBytes === null) {
    throw new AutoSyncInputError(
      'malformed-metadata',
      `${label} audio metadata is missing a valid duration, sample rate, or channel count; ` +
        `export it again as ${SUPPORTED_AUDIO_DESCRIPTION}`,
    );
  }
  if (decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
    throw new AutoSyncInputError(
      'decoded-memory-limit',
      `${label} audio exceeds the 128 MB decoded-audio memory limit; ` +
        'use a compressed mono or stereo source',
    );
  }

  return {
    duration: duration!,
    decodedBytes,
  };
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

async function decodeToMono(
  url: string,
  label: string,
  signal: AbortSignal | undefined,
  remainingEncodedBytes: number,
): Promise<DecodedAnalysis> {
  const metadataDuration = await probeAudioDuration(url, label, signal);
  if (metadataDuration < AUTO_SYNC_MIN_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  if (metadataDuration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`Failed to fetch ${label} audio: HTTP ${response.status}`);
    await cancelResponseBodyBestEffort(response);
    throw error;
  }

  const contentLength = response.headers?.get('content-length');
  const parsedContentLength = contentLength === null ? undefined : Number(contentLength);
  const declaredBytes =
    parsedContentLength !== undefined &&
    Number.isSafeInteger(parsedContentLength) &&
    parsedContentLength >= 0
      ? parsedContentLength
      : undefined;
  if (declaredBytes !== undefined) {
    if (declaredBytes > AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT) {
      const error = new Error(`${label} audio exceeds the 48 MB auto-sync encoded-file limit`);
      await cancelResponseBodyBestEffort(response);
      throw error;
    }
    if (declaredBytes > remainingEncodedBytes) {
      const error = new Error('Auto-sync inputs exceed the combined 64 MB encoded-audio limit');
      await cancelResponseBodyBestEffort(response);
      throw error;
    }
  }

  const maximumEncodedBytes = Math.min(
    AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
    remainingEncodedBytes,
  );
  const readLimitMessage =
    declaredBytes === undefined
      ? `${label} audio without Content-Length exceeds its bounded streaming memory limit`
      : `${label} audio cannot be buffered within the auto-sync encoded-memory limit ` +
        'in this browser';
  const arrayBuffer = await readResponseBuffer(
    response,
    maximumEncodedBytes,
    readLimitMessage,
    signal,
    declaredBytes,
  );
  throwIfAborted(signal);

  const audioMemory = await inspectAudioMemory(
    arrayBuffer,
    response.headers?.get('content-type') ?? null,
    label,
  );
  throwIfAborted(signal);
  if (audioMemory.duration < AUTO_SYNC_MIN_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  if (audioMemory.duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }

  const temporaryContext = new AudioContext({
    sampleRate: AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  });
  let closePromise: Promise<void> | undefined;
  const closeTemporaryContext = () => {
    closePromise ??= temporaryContext.close();
    return closePromise;
  };
  let decoded: AudioBuffer;
  try {
    decoded = await raceWithAbort(temporaryContext.decodeAudioData(arrayBuffer), signal, () => {
      void closeTemporaryContext();
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new Error(
      `Could not decode ${label} audio for auto-sync: ${
        error instanceof Error ? error.message : 'unsupported audio data'
      }`,
    );
  } finally {
    await closeTemporaryContext();
  }

  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new Error(`${label} audio has no usable duration for auto-sync`);
  }
  if (decoded.duration < AUTO_SYNC_MIN_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  if (decoded.duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }
  const decodedBytes = decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
    throw new Error(
      `${label} audio exceeds the 128 MB decoded-audio memory limit; ` +
        'use a compressed mono or stereo source',
    );
  }
  throwIfAborted(signal);

  const analysisLength = Math.ceil(decoded.duration * AUTO_SYNC_ANALYSIS_SAMPLE_RATE);
  if (
    !Number.isSafeInteger(analysisLength) ||
    analysisLength <= 0 ||
    analysisLength > AUTO_SYNC_MAX_ANALYSIS_SAMPLES
  ) {
    throw new Error(`${label} audio exceeds the bounded auto-sync sample budget`);
  }

  const offlineContext = new OfflineAudioContext(1, analysisLength, AUTO_SYNC_ANALYSIS_SAMPLE_RATE);
  const source = offlineContext.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineContext.destination);
  source.start(0);

  let renderCleanupStarted = false;
  const cleanupRenderBestEffort = () => {
    if (renderCleanupStarted) {
      return;
    }
    renderCleanupStarted = true;
    try {
      source.stop();
    } catch {
      // The source may already have ended or may reject a repeated stop.
    }
    try {
      source.disconnect();
    } catch {
      // Disconnection is best-effort cleanup.
    }
    try {
      source.buffer = null;
    } catch {
      // Some implementations expose a read-only buffer after rendering starts.
    }

    const context = offlineContext as OfflineAudioContext & {
      close?: () => Promise<void>;
      suspend?: (suspendTime: number) => Promise<void>;
    };
    try {
      if (typeof context.close === 'function') {
        void context.close().catch(() => undefined);
      } else if (typeof context.suspend === 'function') {
        const finalFrameTime = (analysisLength - 1) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
        const suspendTime = Math.min(
          finalFrameTime,
          context.currentTime + 128 / AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
        );
        if (suspendTime > context.currentTime) {
          void context.suspend(suspendTime).catch(() => undefined);
        }
      }
    } catch {
      // Cleanup must not replace an AbortError or render failure.
    }
  };

  let samples: Float32Array;
  try {
    const rendered = await raceWithAbort(
      offlineContext.startRendering(),
      signal,
      cleanupRenderBestEffort,
    );
    throwIfAborted(signal);
    const renderedSamples = rendered.getChannelData(0);
    if (renderedSamples.length !== analysisLength) {
      throw new Error(`${label} audio produced an invalid auto-sync analysis buffer`);
    }
    samples = renderedSamples.slice();
  } finally {
    cleanupRenderBestEffort();
  }

  return {
    samples,
    encodedBytes: arrayBuffer.byteLength,
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
 * target; negative results advance it by trimming the source in-point. The
 * 64 MiB encoded-memory budget conservatively carries the reference payload
 * into target loading; fallback streams reserve a second payload for the
 * incoming chunk or final assembly copy, while byte streams fill declared
 * Content-Length storage directly with BYOB reads.
 */
export async function computeAutoSyncOffset(
  referenceUrl: string,
  targetUrl: string,
  options: AutoSyncOptions = {},
): Promise<AutoSyncResult> {
  const reference = await decodeToMono(
    referenceUrl,
    'reference',
    options.signal,
    AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES,
  );
  const target = await decodeToMono(
    targetUrl,
    'target',
    options.signal,
    AUTO_SYNC_MAX_AGGREGATE_ENCODED_BYTES - reference.encodedBytes,
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
