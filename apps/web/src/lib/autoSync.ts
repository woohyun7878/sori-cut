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

export function assertAutoSyncInputBudget(
  label: string,
  bytes: number,
  consumedBytes: number,
): void {
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

interface EncodedAudioMetadata {
  channels: number;
  durationSeconds: number;
  format: 'mp3' | 'wav';
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(bytes[offset + index]);
  }
  return value;
}

function inspectWavMetadata(bytes: Uint8Array): EncodedAudioMetadata | null {
  if (
    bytes.length < 44 ||
    readAscii(bytes, 0, 4) !== 'RIFF' ||
    readAscii(bytes, 8, 4) !== 'WAVE'
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let channels = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let sampleRate = 0;
  let dataBytes = 0;
  let hasFormatChunk = false;
  let offset = 12;

  if (view.getUint32(4, true) + 8 !== bytes.length) {
    throw new Error('WAV RIFF size does not match the encoded input');
  }

  while (offset + 8 <= bytes.length) {
    const chunkType = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) {
      throw new Error('WAV metadata declares data beyond the encoded input');
    }

    if (chunkType === 'fmt ') {
      if (hasFormatChunk) {
        throw new Error('WAV audio contains duplicate format metadata');
      }
      hasFormatChunk = true;
      if (chunkSize < 16) {
        throw new Error('WAV format metadata is incomplete');
      }
      const format = view.getUint16(dataStart, true);
      if (format !== 1 && format !== 3) {
        throw new Error('Auto-sync safely supports only PCM or float WAV audio');
      }
      channels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      byteRate = view.getUint32(dataStart + 8, true);
      blockAlign = view.getUint16(dataStart + 12, true);
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (chunkType === 'data') {
      dataBytes += chunkSize;
    }

    offset = dataEnd + (chunkSize % 2);
  }

  if (!Number.isSafeInteger(channels) || channels <= 0 || channels > 32 || byteRate <= 0) {
    throw new Error('WAV channel or rate metadata is invalid');
  }
  const expectedBlockAlign = (channels * bitsPerSample) / 8;
  if (
    !Number.isSafeInteger(expectedBlockAlign) ||
    expectedBlockAlign <= 0 ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== sampleRate * blockAlign ||
    dataBytes % blockAlign !== 0
  ) {
    throw new Error('WAV rate and block metadata is inconsistent');
  }
  if (dataBytes <= 0) {
    throw new Error('WAV audio contains no sample data');
  }

  return { channels, durationSeconds: dataBytes / byteRate, format: 'wav' };
}

const MPEG_1_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG_2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_SAMPLE_RATES = [44_100, 48_000, 32_000];

function parseMp3Frame(
  bytes: Uint8Array,
  offset: number,
): { channels: number; frameLength: number; sampleRate: number; samples: number } | null {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    return null;
  }
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  ) {
    return null;
  }

  const versionScale = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 4;
  const sampleRate = MPEG_SAMPLE_RATES[sampleRateIndex] / versionScale;
  const bitrate =
    (versionBits === 3 ? MPEG_1_BITRATES[bitrateIndex] : MPEG_2_BITRATES[bitrateIndex]) * 1000;
  const padding = (bytes[offset + 2] >> 1) & 1;
  const samples = versionBits === 3 ? 1152 : 576;
  const frameLength = Math.floor(((versionBits === 3 ? 144 : 72) * bitrate) / sampleRate + padding);
  const channels = (bytes[offset + 3] >> 6) === 3 ? 1 : 2;

  return frameLength > 4 ? { channels, frameLength, sampleRate, samples } : null;
}

function inspectMp3Metadata(bytes: Uint8Array): EncodedAudioMetadata | null {
  let searchStart = 0;
  if (bytes.length >= 10 && readAscii(bytes, 0, 3) === 'ID3') {
    searchStart =
      10 +
      ((bytes[6] & 0x7f) << 21) +
      ((bytes[7] & 0x7f) << 14) +
      ((bytes[8] & 0x7f) << 7) +
      (bytes[9] & 0x7f);
  }

  const firstFrame = parseMp3Frame(bytes, searchStart);
  if (
    !firstFrame ||
    !parseMp3Frame(bytes, searchStart + firstFrame.frameLength)
  ) {
    return null;
  }

  let channels = 0;
  let durationSeconds = 0;
  let frameCount = 0;
  let expectedSampleRate = 0;
  let offset = searchStart;
  while (offset + 4 <= bytes.length) {
    const frame = parseMp3Frame(bytes, offset);
    if (!frame || offset + frame.frameLength > bytes.length) {
      break;
    }
    expectedSampleRate ||= frame.sampleRate;
    if (frame.sampleRate !== expectedSampleRate) {
      throw new Error('MP3 frame sample rates are inconsistent');
    }
    channels = Math.max(channels, frame.channels);
    durationSeconds += frame.samples / frame.sampleRate;
    frameCount++;
    offset += frame.frameLength;
  }
  if (frameCount < 2 || durationSeconds <= 0) {
    throw new Error('MP3 frame metadata is incomplete');
  }
  const trailingBytes = bytes.length - offset;
  const hasId3v1 =
    trailingBytes === 128 && readAscii(bytes, offset, 3) === 'TAG';
  let hasOnlyPadding = true;
  for (let index = offset; index < bytes.length; index++) {
    if (bytes[index] !== 0) {
      hasOnlyPadding = false;
      break;
    }
  }
  if (trailingBytes > 0 && !hasId3v1 && !hasOnlyPadding) {
    throw new Error('MP3 contains uninspectable trailing data');
  }

  return { channels, durationSeconds, format: 'mp3' };
}

function inspectEncodedAudioMetadata(encoded: ArrayBuffer, label: string): EncodedAudioMetadata {
  const bytes = new Uint8Array(encoded);
  const metadata = inspectWavMetadata(bytes) ?? inspectMp3Metadata(bytes);
  if (!metadata) {
    throw new Error(
      `${label} audio format cannot be bounded safely before decoding. Auto-sync currently supports internally consistent PCM/float WAV and MP3 input only.`,
    );
  }
  if (
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    metadata.durationSeconds > AUTO_SYNC_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `${label} audio metadata exceeds the ${AUTO_SYNC_MAX_DURATION_SECONDS / 60}-minute auto-sync limit`,
    );
  }

  const predictedDecodedBytes =
    Math.ceil(metadata.durationSeconds * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) *
    metadata.channels *
    Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(predictedDecodedBytes) ||
    predictedDecodedBytes > AUTO_SYNC_MAX_DECODED_BYTES
  ) {
    throw new AutoSyncResourceLimitError(
      'decoded-audio',
      `${label} audio metadata predicts more than the 64 MB decoded-audio budget. Use fewer channels or a shorter file.`,
    );
  }

  return metadata;
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
        assertAutoSyncInputBudget(label, parsedBytes, consumedBytes);
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
  inspectEncodedAudioMetadata(encoded, label);

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
    const encoded = await response.arrayBuffer();
    assertAutoSyncInputBudget(label, encoded.byteLength, consumedBytes);
    if (declaredBytes !== undefined && encoded.byteLength !== declaredBytes) {
      throw new Error(
        `${label} audio length did not match its declared Content-Length`,
      );
    }
    return encoded;
  }

  const reader = response.body.getReader();
  if (declaredBytes !== undefined) {
    const encoded = new Uint8Array(declaredBytes);
    let offset = 0;

    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) {
          if (offset !== declaredBytes) {
            throw new Error(
              `${label} audio ended before its declared Content-Length`,
            );
          }
          return encoded.buffer;
        }
        if (value.byteLength > declaredBytes - offset) {
          throw new Error(
            `${label} audio exceeded its declared Content-Length`,
          );
        }
        offset += value.byteLength;
        assertAutoSyncInputBudget(label, offset, consumedBytes);
        encoded.set(value, offset - value.byteLength);
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
      assertAutoSyncInputBudget(label, totalBytes, consumedBytes);
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
