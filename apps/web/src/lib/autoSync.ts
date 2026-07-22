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
import {
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AutoSyncMediaError,
  decodeEncodedAudioToMono,
  readResponseBuffer,
} from './autoSyncMedia';

export {
  AUTO_SYNC_BYOB_CHUNK_BYTES,
  DECODE_YIELD_FRAME_INTERVAL,
  AUTO_SYNC_INPUT_FORMATS,
  AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT,
  AUTO_SYNC_MAX_ENCODED_PEAK_BYTES,
  AutoSyncMediaError,
  decodeEncodedAudioToMono,
  getUnknownLengthPayloadLimit,
  readResponseBuffer,
  type AutoSyncMediaErrorCode,
} from './autoSyncMedia';

export const AUTO_SYNC_MAX_ANALYSIS_BYTES =
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

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

async function cancelResponseBodyBestEffort(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the HTTP or resource-limit error.
  }
}

function durationLimitError(label: string, tooShort: boolean): Error {
  if (tooShort) {
    return new Error(
      `${label} audio is too short for auto-sync; at least ` +
        `${AUTO_SYNC_MIN_DURATION_SECONDS} second is required`,
    );
  }
  return new Error(
    `${label} audio is too long for auto-sync; the limit is ` +
      `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
  );
}

function assertUsableDuration(duration: number, label: string): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`${label} audio has no usable duration for auto-sync`);
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

  return decodeEncodedAudioToMono(encodedBuffer, label, signal);
}

async function decodeToMono(
  url: string,
  label: string,
  signal: AbortSignal | undefined,
  retainedAnalysisBytes: number,
): Promise<DecodedAnalysis> {
  const samples = await fetchAndDecodeAudio(url, label, signal, retainedAnalysisBytes);
  assertUsableDuration(samples.length / AUTO_SYNC_ANALYSIS_SAMPLE_RATE, label);

  return {
    samples,
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
