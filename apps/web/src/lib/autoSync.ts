/**
 * Auto-sync: align a user's recording with a backing track using bounded,
 * normalized correlation in a Web Worker.
 */

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

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
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

export async function readResponseBuffer(
  response: Response,
  maximumBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
  declaredBytes?: number,
): Promise<ArrayBuffer> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) {
      throw new Error(limitMessage);
    }
    if (declaredBytes !== undefined && buffer.byteLength !== declaredBytes) {
      throw new Error('Audio response did not match its Content-Length');
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const preallocated = declaredBytes === undefined ? null : new Uint8Array(declaredBytes);
  const chunks: Uint8Array[] = [];
  const payloadLimit =
    preallocated === null ? getUnknownLengthPayloadLimit(maximumBytes) : maximumBytes;
  let totalBytes = 0;
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(), signal, () => {
        cancelReaderBestEffort(reader);
      });
      if (result.done) {
        break;
      }
      const nextTotal = totalBytes + result.value.byteLength;
      if (
        nextTotal > payloadLimit ||
        (preallocated !== null && nextTotal > preallocated.byteLength)
      ) {
        cancelReaderBestEffort(reader);
        throw new Error(limitMessage);
      }
      if (preallocated === null) {
        chunks.push(result.value.slice());
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

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function inspectWaveMemory(buffer: ArrayBuffer): {
  duration: number;
  decodedBytes: number;
} | null {
  if (buffer.byteLength < 12) {
    return null;
  }
  const view = new DataView(buffer);
  if (readFourCc(view, 0) !== 'RIFF' || readFourCc(view, 8) !== 'WAVE') {
    return null;
  }

  let sampleRate = 0;
  let channels = 0;
  let byteRate = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkType = readFourCc(view, offset);
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkType === 'fmt ' && chunkDataOffset + 16 <= buffer.byteLength) {
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      byteRate = view.getUint32(chunkDataOffset + 8, true);
    } else if (chunkType === 'data') {
      dataBytes = chunkBytes;
    }
    const nextOffset = chunkDataOffset + chunkBytes + (chunkBytes % 2);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
      break;
    }
    offset = nextOffset;
  }

  if (sampleRate <= 0 || channels <= 0 || byteRate <= 0 || dataBytes <= 0) {
    return null;
  }
  const duration = dataBytes / byteRate;
  return {
    duration,
    decodedBytes: Math.ceil(duration * sampleRate * channels * Float32Array.BYTES_PER_ELEMENT),
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
  const encodedLimitMessage =
    remainingEncodedBytes < AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT
      ? 'Auto-sync inputs exceed the combined 64 MB encoded-audio limit'
      : `${label} audio exceeds the 48 MB auto-sync encoded-file limit`;
  const readLimitMessage =
    declaredBytes === undefined
      ? `${label} audio without Content-Length exceeds its bounded streaming memory limit`
      : encodedLimitMessage;
  const arrayBuffer = await readResponseBuffer(
    response,
    maximumEncodedBytes,
    readLimitMessage,
    signal,
    declaredBytes,
  );
  throwIfAborted(signal);

  const waveMemory = inspectWaveMemory(arrayBuffer);
  if (waveMemory?.duration && waveMemory.duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }
  if (waveMemory?.decodedBytes && waveMemory.decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
    throw new Error(
      `${label} audio exceeds the 128 MB decoded-audio memory limit; ` +
        'use a compressed mono or stereo source',
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

  const rendered = await raceWithAbort(offlineContext.startRendering(), signal);
  throwIfAborted(signal);
  const samples = rendered.getChannelData(0);
  if (samples.length !== analysisLength) {
    throw new Error(`${label} audio produced an invalid auto-sync analysis buffer`);
  }

  return {
    samples: samples.slice(),
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
 * target; negative results advance it by trimming the source in-point.
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
