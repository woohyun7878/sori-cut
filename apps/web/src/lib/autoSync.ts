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
export const AUTO_SYNC_MAX_STREAMING_PEAK_BYTES = 64 * 1024 * 1024;
export const AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT = 128 * 1024 * 1024;
export const AUTO_SYNC_MAX_ANALYSIS_BYTES =
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES * Float32Array.BYTES_PER_ELEMENT * 2;
const AUTO_SYNC_BYOB_CHUNK_BYTES = 64 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const SUPPORTED_AUDIO_FORMAT_ERROR =
  'Auto-sync supports only PCM/float WAV and MPEG-1 Layer III MP3 with valid structure; ' +
  'convert AAC/M4A, Ogg, FLAC, or WebM audio before syncing';

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

interface CancellableReader {
  cancel(): Promise<void>;
}

function cancelReaderBestEffort(reader: CancellableReader): void {
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

export function getUnknownLengthPayloadLimit(
  maximumBytes: number,
  peakBudgetBytes = maximumBytes,
  retainedBytes = 0,
): number {
  const availableBytes = Math.max(0, peakBudgetBytes - retainedBytes);
  const scratchBytes = getByobScratchBytes(availableBytes);
  return Math.min(maximumBytes, Math.floor(Math.max(0, availableBytes - scratchBytes) / 2));
}

function getByobScratchBytes(availableBytes: number): number {
  if (availableBytes < 1) {
    return 0;
  }
  return Math.min(AUTO_SYNC_BYOB_CHUNK_BYTES, Math.max(1, Math.floor(availableBytes / 4)));
}

async function readDeclaredByobBuffer(
  reader: ReadableStreamBYOBReader,
  declaredBytes: number,
  peakBudgetBytes: number,
  retainedBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const scratchBytes = Math.min(
    AUTO_SYNC_BYOB_CHUNK_BYTES,
    Math.max(0, peakBudgetBytes - retainedBytes - declaredBytes),
  );
  if (scratchBytes < 1) {
    cancelReaderBestEffort(reader);
    throw new Error(limitMessage);
  }

  const destination = new Uint8Array(declaredBytes);
  let scratch = new Uint8Array(scratchBytes);
  let totalBytes = 0;
  try {
    while (true) {
      const requestBytes = Math.min(scratch.byteLength, Math.max(1, declaredBytes - totalBytes));
      const result = await raceWithAbort(
        reader.read(scratch.subarray(0, requestBytes)),
        signal,
        () => {
          cancelReaderBestEffort(reader);
        },
      );
      if (result.done) {
        break;
      }
      if (
        result.value.byteLength === 0 ||
        result.value.byteLength > requestBytes ||
        totalBytes + result.value.byteLength > declaredBytes
      ) {
        cancelReaderBestEffort(reader);
        throw new Error(limitMessage);
      }
      destination.set(result.value, totalBytes);
      totalBytes += result.value.byteLength;
      scratch = new Uint8Array(result.value.buffer as ArrayBuffer);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock briefly after cancellation.
    }
  }

  if (totalBytes !== declaredBytes) {
    throw new Error('Audio response did not match its Content-Length');
  }
  return destination.buffer;
}

async function readUnknownLengthByobBuffer(
  reader: ReadableStreamBYOBReader,
  maximumBytes: number,
  peakBudgetBytes: number,
  retainedBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const availableBytes = Math.max(0, peakBudgetBytes - retainedBytes);
  const scratchBytes = getByobScratchBytes(availableBytes);
  const payloadLimit = getUnknownLengthPayloadLimit(maximumBytes, peakBudgetBytes, retainedBytes);
  if (scratchBytes < 1 || payloadLimit < 1) {
    cancelReaderBestEffort(reader);
    throw new Error(limitMessage);
  }

  let scratch = new Uint8Array(scratchBytes);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await raceWithAbort(reader.read(scratch), signal, () => {
        cancelReaderBestEffort(reader);
      });
      if (result.done) {
        break;
      }
      if (
        result.value.byteLength === 0 ||
        result.value.byteLength > scratchBytes ||
        totalBytes + result.value.byteLength > payloadLimit
      ) {
        cancelReaderBestEffort(reader);
        throw new Error(limitMessage);
      }
      chunks.push(result.value.slice());
      totalBytes += result.value.byteLength;
      scratch = new Uint8Array(result.value.buffer as ArrayBuffer);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may retain the lock briefly after cancellation.
    }
  }

  const combined = new Uint8Array(totalBytes);
  let writeOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  return combined.buffer;
}

export async function readResponseBuffer(
  response: Response,
  maximumBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
  declaredBytes?: number,
  peakBudgetBytes = maximumBytes,
  retainedBytes = 0,
): Promise<ArrayBuffer> {
  if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
    await cancelResponseBodyBestEffort(response);
    throw new Error(limitMessage);
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes || buffer.byteLength + retainedBytes > peakBudgetBytes) {
      throw new Error(limitMessage);
    }
    if (declaredBytes !== undefined && buffer.byteLength !== declaredBytes) {
      throw new Error('Audio response did not match its Content-Length');
    }
    return buffer;
  }

  let byobReader: ReadableStreamBYOBReader;
  try {
    byobReader = response.body.getReader({ mode: 'byob' });
  } catch {
    await cancelResponseBodyBestEffort(response);
    throw new Error(`${limitMessage}; this browser cannot provide bounded audio streaming`);
  }
  if (declaredBytes !== undefined) {
    return readDeclaredByobBuffer(
      byobReader,
      declaredBytes,
      peakBudgetBytes,
      retainedBytes,
      limitMessage,
      signal,
    );
  }
  return readUnknownLengthByobBuffer(
    byobReader,
    maximumBytes,
    peakBudgetBytes,
    retainedBytes,
    limitMessage,
    signal,
  );
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
  let blockAlign = 0;
  let bitsPerSample = 0;
  let formatTag = 0;
  let dataBytes = 0;
  let formatChunkCount = 0;
  let dataChunkCount = 0;
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd !== buffer.byteLength) {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkType = readFourCc(view, offset);
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkBytes;
    const paddedChunkEnd = chunkEnd + (chunkBytes % 2);
    if (!Number.isSafeInteger(paddedChunkEnd) || paddedChunkEnd > riffEnd) {
      return null;
    }
    if (chunkType === 'fmt ') {
      formatChunkCount++;
      if (
        formatChunkCount > 1 ||
        (chunkBytes !== 16 && chunkBytes !== 18) ||
        (chunkBytes === 18 && view.getUint16(chunkDataOffset + 16, true) !== 0)
      ) {
        return null;
      }
      formatTag = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      byteRate = view.getUint32(chunkDataOffset + 8, true);
      blockAlign = view.getUint16(chunkDataOffset + 12, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkType === 'data') {
      dataChunkCount++;
      if (dataChunkCount > 1 || formatChunkCount !== 1) {
        return null;
      }
      dataBytes = chunkBytes;
    }
    offset = paddedChunkEnd;
  }

  const expectedBlockAlign = channels * (bitsPerSample / 8);
  const supportedSampleWidth =
    (formatTag === 1 && [8, 16, 24, 32].includes(bitsPerSample)) ||
    (formatTag === 3 && [32, 64].includes(bitsPerSample));
  if (
    (formatTag !== 1 && formatTag !== 3) ||
    formatChunkCount !== 1 ||
    dataChunkCount !== 1 ||
    offset !== riffEnd ||
    !supportedSampleWidth ||
    sampleRate <= 0 ||
    channels <= 0 ||
    bitsPerSample <= 0 ||
    bitsPerSample % 8 !== 0 ||
    blockAlign !== expectedBlockAlign ||
    byteRate !== sampleRate * blockAlign ||
    dataBytes <= 0 ||
    dataBytes % blockAlign !== 0
  ) {
    return null;
  }
  const frameCount = dataBytes / blockAlign;
  const duration = frameCount / sampleRate;
  const decodedSampleRate = Math.max(sampleRate, AUTO_SYNC_ANALYSIS_SAMPLE_RATE);
  const decodedFrameCount = Math.ceil(duration * decodedSampleRate);
  return {
    duration,
    decodedBytes: decodedFrameCount * channels * Float32Array.BYTES_PER_ELEMENT,
  };
}

export interface EncodedAudioMemory {
  format: 'wav' | 'mp3';
  duration: number;
  decodedBytes: number;
}

function inspectMpegAudio(buffer: ArrayBuffer): EncodedAudioMemory | null {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const majorVersion = bytes[3];
    const revision = bytes[4];
    const flags = bytes[5];
    const allowedFlags = majorVersion === 3 ? 0xe0 : majorVersion === 4 ? 0xf0 : 0;
    if (
      allowedFlags === 0 ||
      revision === 0xff ||
      (flags & ~allowedFlags) !== 0 ||
      (flags & 0x40) !== 0 ||
      (majorVersion !== 4 && (flags & 0x10) !== 0)
    ) {
      return null;
    }
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => (value & 0x80) !== 0)) {
      return null;
    }
    const tagBytes =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    const footerBytes = (bytes[5] & 0x10) !== 0 ? 10 : 0;
    const footerOffset = 10 + tagBytes;
    offset = footerOffset + footerBytes;
    if (offset > bytes.length) {
      return null;
    }
    if (
      footerBytes > 0 &&
      (bytes[footerOffset] !== 0x33 ||
        bytes[footerOffset + 1] !== 0x44 ||
        bytes[footerOffset + 2] !== 0x49 ||
        bytes[footerOffset + 3] !== majorVersion ||
        bytes[footerOffset + 4] !== revision ||
        bytes[footerOffset + 5] !== flags ||
        ![6, 7, 8, 9].every((index) => bytes[footerOffset + index] === bytes[index]))
    ) {
      return null;
    }
  }

  const sampleRates = [44_100, 48_000, 32_000];
  const layerThreeBitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const parseFrame = (
    frameOffset: number,
  ): { channels: number; frameBytes: number; sampleRate: number } | null => {
    if (
      frameOffset + 4 > bytes.length ||
      bytes[frameOffset] !== 0xff ||
      (bytes[frameOffset + 1] & 0xe0) !== 0xe0
    ) {
      return null;
    }
    const version = (bytes[frameOffset + 1] >> 3) & 0x03;
    const layer = (bytes[frameOffset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[frameOffset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[frameOffset + 2] >> 2) & 0x03;
    if (
      version !== 3 ||
      layer !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 0x0f ||
      sampleRateIndex === 3 ||
      (bytes[frameOffset + 3] & 0x03) === 0x02
    ) {
      return null;
    }
    const sampleRate = sampleRates[sampleRateIndex];
    const bitrate = layerThreeBitrates[bitrateIndex];
    const padding = (bytes[frameOffset + 2] >> 1) & 0x01;
    const frameBytes = Math.floor((144_000 * bitrate) / sampleRate) + padding;
    if (frameBytes <= 4 || frameOffset + frameBytes > bytes.length) {
      return null;
    }
    return {
      channels: bytes[frameOffset + 3] >> 6 === 3 ? 1 : 2,
      frameBytes,
      sampleRate,
    };
  };

  let channels = 0;
  let frameCount = 0;
  let sampleRate = 0;
  while (offset < bytes.length) {
    if (
      bytes.length - offset === 128 &&
      bytes[offset] === 0x54 &&
      bytes[offset + 1] === 0x41 &&
      bytes[offset + 2] === 0x47
    ) {
      offset = bytes.length;
      break;
    }
    const frame = parseFrame(offset);
    if (
      !frame ||
      (frameCount > 0 && (frame.sampleRate !== sampleRate || frame.channels !== channels))
    ) {
      return null;
    }
    sampleRate = frame.sampleRate;
    channels = frame.channels;
    frameCount++;
    offset += frame.frameBytes;
  }
  if (frameCount < 2 || offset !== bytes.length) {
    return null;
  }
  const sampleFrames = frameCount * 1152;
  return {
    format: 'mp3',
    duration: sampleFrames / sampleRate,
    decodedBytes: sampleFrames * channels * Float32Array.BYTES_PER_ELEMENT,
  };
}

export function inspectEncodedAudioMemory(buffer: ArrayBuffer): EncodedAudioMemory {
  const bytes = new Uint8Array(buffer);
  const wave = inspectWaveMemory(buffer);
  if (wave) {
    return { format: 'wav', ...wave };
  }
  if (
    bytes.length >= 12 &&
    readFourCc(new DataView(buffer), 0) === 'RIFF' &&
    readFourCc(new DataView(buffer), 8) === 'WAVE'
  ) {
    throw new Error(SUPPORTED_AUDIO_FORMAT_ERROR);
  }

  const mp3 = inspectMpegAudio(buffer);
  if (mp3) {
    return mp3;
  }
  throw new Error(SUPPORTED_AUDIO_FORMAT_ERROR);
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
  retainedAnalysisBytes: number,
): Promise<DecodedAnalysis> {
  throwIfAborted(signal);
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
  }

  const maximumEncodedBytes = AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT;
  const readLimitMessage =
    declaredBytes === undefined
      ? `${label} audio without Content-Length exceeds its bounded streaming-memory limit`
      : `${label} audio exceeds the 64 MB auto-sync streaming-memory limit`;
  const arrayBuffer = await readResponseBuffer(
    response,
    maximumEncodedBytes,
    readLimitMessage,
    signal,
    declaredBytes,
    AUTO_SYNC_MAX_STREAMING_PEAK_BYTES,
    retainedAnalysisBytes,
  );
  throwIfAborted(signal);

  const encodedMemory = inspectEncodedAudioMemory(arrayBuffer);
  if (encodedMemory.duration > AUTO_SYNC_MAX_DURATION_SECONDS) {
    throw new Error(
      `${label} audio is too long for auto-sync; the limit is ` +
        `${AUTO_SYNC_MAX_DURATION_SECONDS / 60} minutes`,
    );
  }
  if (encodedMemory.decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
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
  let decoded: AudioBuffer | undefined;
  let primaryDecodeError: Error | undefined;
  try {
    decoded = await raceWithAbort(temporaryContext.decodeAudioData(arrayBuffer), signal, () => {
      void closeTemporaryContext().catch(() => undefined);
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      primaryDecodeError = error;
    } else {
      primaryDecodeError = new Error(
        `Could not decode ${label} audio for auto-sync: ${
          error instanceof Error ? error.message : 'unsupported audio data'
        }`,
      );
    }
  }
  let closeFailed = false;
  let closeError: unknown;
  try {
    await raceWithAbort(closeTemporaryContext(), signal);
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (primaryDecodeError) {
    throw primaryDecodeError;
  }
  throwIfAborted(signal);
  if (closeFailed) {
    throw closeError;
  }
  if (!decoded) {
    throw new Error(`Could not decode ${label} audio for auto-sync`);
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

  const cleanupSource = () => {
    try {
      source.stop();
    } catch {
      // The source may already have ended or been stopped.
    }
    try {
      source.disconnect();
    } catch {
      // Disconnect is best-effort cleanup and must not replace the primary error.
    }
    try {
      source.buffer = null;
    } catch {
      // Some browser implementations expose a read-only buffer after start().
    }
  };
  let rendered: AudioBuffer;
  try {
    rendered = await raceWithAbort(offlineContext.startRendering(), signal, cleanupSource);
  } finally {
    cleanupSource();
  }
  throwIfAborted(signal);
  const samples = rendered.getChannelData(0);
  if (samples.length !== analysisLength) {
    throw new Error(`${label} audio produced an invalid auto-sync analysis buffer`);
  }

  return {
    samples: samples.slice(),
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
