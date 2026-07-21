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
import { parseEncodedAudioMetadata } from './audioMetadata';

export const AUTO_SYNC_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const AUTO_SYNC_MAX_TOTAL_FILE_BYTES = 96 * 1024 * 1024;
export const AUTO_SYNC_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

export interface AutoSyncResult {
  /** Signed target placement: positive delays it; negative advances into its source. */
  offsetSeconds: number;
  /** Normalized correlation confidence (0-1). */
  confidence: number;
}

export interface AutoSyncOptions {
  signal?: AbortSignal;
  workerTimeoutMs?: number;
}

export type AutoSyncResourceLimitCode = 'individual-input' | 'aggregate-input' | 'decoded-audio';

export class AutoSyncResourceLimitError extends Error {
  readonly name = 'AutoSyncResourceLimitError';

  constructor(
    readonly code: AutoSyncResourceLimitCode,
    message: string,
  ) {
    super(message);
  }
}

interface DecodedInput {
  encodedBytes: number;
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

function assertInputBudget(label: string, bytes: number, consumedBytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`${label} audio reported an invalid file size`);
  }
  if (bytes > AUTO_SYNC_MAX_FILE_BYTES) {
    throw new AutoSyncResourceLimitError(
      'individual-input',
      `${label} audio exceeds the 64 MB auto-sync file limit. Use a shorter or more compressed file.`,
    );
  }
  if (consumedBytes + bytes > AUTO_SYNC_MAX_TOTAL_FILE_BYTES) {
    throw new AutoSyncResourceLimitError(
      'aggregate-input',
      'Combined auto-sync inputs exceed the 96 MB memory budget. Use shorter or more compressed files.',
    );
  }
}

function attachCleanupError(primaryError: unknown, cleanupError: unknown): void {
  if (
    (typeof primaryError === 'object' && primaryError !== null) ||
    typeof primaryError === 'function'
  ) {
    Object.defineProperty(primaryError, 'cleanupError', {
      configurable: true,
      value: cleanupError,
    });
  }
}

async function cancelResponseBodyPreservingError(
  response: Response,
  primaryError: unknown,
): Promise<void> {
  try {
    await response.body?.cancel(primaryError);
  } catch (cleanupError) {
    attachCleanupError(primaryError, cleanupError);
  }
}

async function decodeToMono(
  url: string,
  label: string,
  consumedBytes: number,
  signal: AbortSignal | undefined,
): Promise<DecodedInput> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`Failed to fetch ${label} audio: HTTP ${response.status}`);
    await cancelResponseBodyPreservingError(response, error);
    throw error;
  }
  const contentLength = response.headers?.get('content-length');
  let declaredBytes: number | undefined;
  if (contentLength !== null && contentLength !== undefined) {
    const parsedBytes = Number(contentLength);
    if (Number.isFinite(parsedBytes)) {
      try {
        assertInputBudget(label, parsedBytes, consumedBytes);
        declaredBytes = parsedBytes;
      } catch (error) {
        await cancelResponseBodyPreservingError(response, error);
        throw error;
      }
    }
  }

  const { decoded, encodedBytes } = await decodeResponseAudio(
    response,
    label,
    consumedBytes,
    signal,
    declaredBytes,
  );

  const decodedBytes = decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES) {
    throw new AutoSyncResourceLimitError(
      'decoded-audio',
      `${label} audio expands beyond the 64 MB decoded-audio budget. Use fewer channels or a shorter file.`,
    );
  }
  assertDuration(label, decoded.duration);
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
  let sourceReleased = false;
  const releaseSource = () => {
    if (!sourceReleased) {
      sourceReleased = true;
      source.buffer = null;
      source.disconnect();
    }
  };

  try {
    const rendered = await raceWithAbort(offlineContext.startRendering(), signal, releaseSource);
    throwIfAborted(signal);
    const samples = rendered.getChannelData(0);
    if (samples.length !== analysisLength) {
      throw new Error(`${label} audio produced an invalid auto-sync analysis buffer`);
    }

    return { encodedBytes, samples };
  } finally {
    releaseSource();
  }
}

async function decodeResponseAudio(
  response: Response,
  label: string,
  consumedBytes: number,
  signal: AbortSignal | undefined,
  declaredBytes: number | undefined,
): Promise<{ decoded: AudioBuffer; encodedBytes: number }> {
  const encoded = await readResponseWithinBudget(
    response,
    label,
    consumedBytes,
    signal,
    declaredBytes,
  );
  const encodedBytes = encoded.byteLength;
  throwIfAborted(signal);
  const metadata = parseEncodedAudioMetadata(encoded);
  assertDuration(label, metadata.durationSeconds);
  const preflightDecodedBytes =
    Math.ceil(metadata.durationSeconds * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) *
    metadata.channels *
    Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(preflightDecodedBytes) ||
    preflightDecodedBytes > AUTO_SYNC_MAX_DECODED_BYTES
  ) {
    throw new AutoSyncResourceLimitError(
      'decoded-audio',
      `${label} audio expands beyond the 64 MB decoded-audio budget. Use fewer channels or a shorter file.`,
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

  try {
    const decoded = await raceWithAbort(temporaryContext.decodeAudioData(encoded), signal, () => {
      void closeTemporaryContext();
    });
    return { decoded, encodedBytes };
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
}

async function readResponseWithinBudget(
  response: Response,
  label: string,
  consumedBytes: number,
  signal: AbortSignal | undefined,
  declaredBytes: number | undefined,
): Promise<ArrayBuffer> {
  if (!response.body) {
    if (declaredBytes !== undefined) {
      throw new Error(`${label} audio response cannot be safely streamed`);
    }
    const encoded = await response.arrayBuffer();
    assertInputBudget(label, encoded.byteLength, consumedBytes);
    return encoded;
  }

  const reader = response.body.getReader();
  if (declaredBytes !== undefined) {
    const encoded = new Uint8Array(declaredBytes);
    let totalBytes = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) {
          if (totalBytes !== declaredBytes) {
            throw new Error(`${label} audio response ended before its declared Content-Length`);
          }
          return encoded.buffer;
        }
        const nextTotal = totalBytes + value.byteLength;
        assertInputBudget(label, nextTotal, consumedBytes);
        if (nextTotal > declaredBytes) {
          throw new Error(`${label} audio response exceeded its declared Content-Length`);
        }
        encoded.set(value, totalBytes);
        totalBytes = nextTotal;
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch (cancelError) {
        attachCleanupError(error, cancelError);
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      assertInputBudget(label, totalBytes, consumedBytes);
      if (consumedBytes + totalBytes * 2 > AUTO_SYNC_MAX_TOTAL_FILE_BYTES) {
        throw new AutoSyncResourceLimitError(
          'aggregate-input',
          'Unknown-length auto-sync input exceeds the 96 MB peak memory budget. Use a smaller file or a server that provides Content-Length.',
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch (cancelError) {
      attachCleanupError(error, cancelError);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const encoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoded.buffer;
}

function assertDuration(label: string, duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${label} audio has no usable duration for auto-sync`);
  }
  if (duration < AUTO_SYNC_MIN_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  if (duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }
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
 * resolves lag to the nearest 20 ms envelope frame. Inputs are fetched and
 * decoded sequentially under individual and aggregate memory budgets.
 */
export async function computeAutoSyncOffset(
  referenceUrl: string,
  targetUrl: string,
  options: AutoSyncOptions = {},
): Promise<AutoSyncResult> {
  const referenceInput = await decodeToMono(referenceUrl, 'reference', 0, options.signal);
  const targetInput = await decodeToMono(
    targetUrl,
    'target',
    referenceInput.encodedBytes,
    options.signal,
  );
  const { lagSamples, confidence } = await correlateInWorker(
    referenceInput.samples,
    targetInput.samples,
    AUTO_SYNC_MAX_LAG_SAMPLES,
    options,
  );

  return {
    offsetSeconds: lagSamples / AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
    confidence,
  };
}

export { AUTO_SYNC_MAX_LAG_SECONDS };
