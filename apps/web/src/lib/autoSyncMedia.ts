import {
  ADTS,
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
  type InputFormat,
} from 'mediabunny';
import {
  AUTO_SYNC_ANALYSIS_SAMPLE_RATE,
  AUTO_SYNC_MAX_ANALYSIS_SAMPLES,
} from './autoSyncCore';

const MEBIBYTE = 1024 * 1024;
const CONVERSION_CHUNK_SAMPLES = 16_384;

export const AUTO_SYNC_MAX_ENCODED_BYTES_PER_INPUT = 48 * MEBIBYTE;
export const AUTO_SYNC_MAX_ENCODED_PEAK_BYTES = 96 * MEBIBYTE;
export const AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT = 128 * MEBIBYTE;

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

export interface EncodedAudioMemory {
  channels: number;
  codec: string;
  decodedBytes: number;
  duration: number;
  format: string;
  sampleRate: number;
}

function abortError(): DOMException {
  return new DOMException('Auto-sync was cancelled', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
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

export function getUnknownLengthPayloadLimit(maximumBytes: number): number {
  // Unknown-length inputs now use the same truthful 48 MiB payload cap as declared inputs.
  return maximumBytes;
}

export async function readResponseBuffer(
  response: Response,
  maximumBytes: number,
  limitMessage: string,
  signal: AbortSignal | undefined,
  declaredBytes?: number,
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
    declaredBytes !== undefined &&
    (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maximumBytes)
  ) {
    throw new RangeError('declaredBytes must be within the configured encoded limit');
  }

  const reader = response.body.getReader();
  const destination = declaredBytes === undefined ? null : new Uint8Array(declaredBytes);
  const chunks: Uint8Array[] = [];
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
      if (nextTotal > maximumBytes) {
        cancelReaderBestEffort(reader);
        throw new AutoSyncMediaError('encoded-limit', limitMessage);
      }

      if (destination) {
        destination.set(result.value, totalBytes);
      } else {
        chunks.push(result.value);
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

  if (destination) {
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

export async function inspectEncodedAudioMemory(
  buffer: ArrayBuffer,
  label = 'input',
  signal?: AbortSignal,
): Promise<EncodedAudioMemory> {
  throwIfAborted(signal);
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

    const [format, track] = await raceWithAbort(
      Promise.all([input.getFormat(), input.getPrimaryAudioTrack()]),
      signal,
      dispose,
    );
    if (!track) {
      throw new AutoSyncMediaError(
        'no-audio-track',
        `${label} media has no audio track to use for auto-sync`,
      );
    }

    let codec: string | null;
    let sampleRate: number;
    let channels: number;
    let duration: number;
    try {
      [codec, sampleRate, channels, duration] = await raceWithAbort(
        Promise.all([
          track.getCodec(),
          track.getSampleRate(),
          track.getNumberOfChannels(),
          track.computeDuration(),
        ]),
        signal,
        dispose,
      );
    } catch (error) {
      throwIfAborted(signal);
      throw new AutoSyncMediaError(
        'malformed-media',
        `${label} media is malformed and its complete audio metadata could not be read`,
        error,
      );
    }

    if (!codec) {
      throw new AutoSyncMediaError(
        'unknown-codec',
        `${label} audio codec is not supported for auto-sync`,
      );
    }
    if (
      !Number.isSafeInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isSafeInteger(channels) ||
      channels <= 0 ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new AutoSyncMediaError(
        'invalid-metadata',
        `${label} audio has invalid duration, sample-rate, or channel metadata`,
      );
    }

    const decodedFrames = Math.ceil(duration * sampleRate);
    if (!Number.isSafeInteger(decodedFrames) || decodedFrames <= 0) {
      throw decodedLimitError(label);
    }
    const decodedBytes = checkedProduct([
      decodedFrames,
      channels,
      Float32Array.BYTES_PER_ELEMENT,
    ]);
    if (decodedBytes === null || decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
      throw decodedLimitError(label);
    }

    return {
      channels,
      codec,
      decodedBytes,
      duration,
      format: format.name,
      sampleRate,
    };
  } catch (error) {
    if (error instanceof AutoSyncMediaError) {
      throw error;
    }
    throwIfAborted(signal);
    throw new AutoSyncMediaError(
      'malformed-media',
      `${label} media is malformed and could not be inspected for auto-sync`,
      error,
    );
  } finally {
    input.dispose();
  }
}

function validateDecodedAudioBuffer(decoded: AudioBuffer, label: string): Float32Array[] {
  if (
    !Number.isSafeInteger(decoded.length) ||
    decoded.length <= 0 ||
    !Number.isSafeInteger(decoded.numberOfChannels) ||
    decoded.numberOfChannels <= 0 ||
    !Number.isFinite(decoded.sampleRate) ||
    decoded.sampleRate <= 0 ||
    !Number.isFinite(decoded.duration) ||
    decoded.duration <= 0
  ) {
    throw new Error(`${label} audio decoder returned an invalid buffer shape`);
  }

  const decodedBytes = checkedProduct([
    decoded.length,
    decoded.numberOfChannels,
    Float32Array.BYTES_PER_ELEMENT,
  ]);
  if (decodedBytes === null || decodedBytes > AUTO_SYNC_MAX_DECODED_BYTES_PER_INPUT) {
    throw decodedLimitError(label);
  }

  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const samples = decoded.getChannelData(channel);
    if (samples.length !== decoded.length) {
      throw new Error(`${label} audio decoder returned inconsistent channel data`);
    }
    channels.push(samples);
  }
  return channels;
}

function yieldForAbort(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function convertAudioBufferToMono(
  decoded: AudioBuffer,
  label: string,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const channels = validateDecodedAudioBuffer(decoded, label);
  const sourceRate = decoded.sampleRate;
  const outputLength =
    sourceRate === AUTO_SYNC_ANALYSIS_SAMPLE_RATE
      ? decoded.length
      : Math.ceil((decoded.length * AUTO_SYNC_ANALYSIS_SAMPLE_RATE) / sourceRate);
  if (
    !Number.isSafeInteger(outputLength) ||
    outputLength <= 0 ||
    outputLength > AUTO_SYNC_MAX_ANALYSIS_SAMPLES
  ) {
    throw new Error(`${label} audio exceeds the bounded auto-sync sample budget`);
  }

  const output = new Float32Array(outputLength);
  const direct = sourceRate === AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
  for (let chunkStart = 0; chunkStart < outputLength; chunkStart += CONVERSION_CHUNK_SAMPLES) {
    throwIfAborted(signal);
    const chunkEnd = Math.min(chunkStart + CONVERSION_CHUNK_SAMPLES, outputLength);
    for (let outputIndex = chunkStart; outputIndex < chunkEnd; outputIndex++) {
      if (direct) {
        let sum = 0;
        for (const channel of channels) {
          sum += channel[outputIndex];
        }
        output[outputIndex] = sum / channels.length;
        continue;
      }

      const sourcePosition = (outputIndex * sourceRate) / AUTO_SYNC_ANALYSIS_SAMPLE_RATE;
      const leftIndex = Math.min(Math.floor(sourcePosition), decoded.length - 1);
      const rightIndex = Math.min(leftIndex + 1, decoded.length - 1);
      const fraction = sourcePosition - leftIndex;
      let left = 0;
      let right = 0;
      for (const channel of channels) {
        left += channel[leftIndex];
        right += channel[rightIndex];
      }
      const leftMono = left / channels.length;
      const rightMono = right / channels.length;
      output[outputIndex] = leftMono + (rightMono - leftMono) * fraction;
    }

    if (chunkEnd < outputLength) {
      await yieldForAbort();
    }
  }
  throwIfAborted(signal);
  return output;
}
