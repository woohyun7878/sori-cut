import {
  ADTS,
  FLAC,
  MATROSKA,
  MP3,
  MP4,
  OGG,
  QTFF,
  WAVE,
  WEBM,
  type InputFormat,
} from 'mediabunny';

const MEBIBYTE = 1024 * 1024;

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

type ResponseBodyReader = ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;

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
        (declaredBytes > peakBudgetBytes - retainedBytes ||
          ownerBytes > peakBudgetBytes - retainedBytes - declaredBytes)
      ) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }
      if (
        declaredBytes === undefined &&
        (totalBytes > peakBudgetBytes - retainedBytes ||
          ownerBytes > peakBudgetBytes - retainedBytes - totalBytes ||
          chunkBytes > peakBudgetBytes - retainedBytes - totalBytes - ownerBytes)
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
