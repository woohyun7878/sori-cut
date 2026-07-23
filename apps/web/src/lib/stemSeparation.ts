import { encodeWavBlob } from './stemSeparationUtils';

export interface StemResult {
  name: string;
  label: string;
  blob: Blob;
  url: string;
}

export interface SeparationOptions {
  /** URL to the ONNX separation model. Defaults to /models/stem-separator.onnx. */
  modelUrl?: string;
  /** AbortSignal to cancel the separation. The worker is terminated immediately. */
  signal?: AbortSignal;
  /**
   * Maximum time (ms) to wait for worker completion before aborting.
   * Default: 5 minutes. Set 0 for no timeout.
   */
  timeoutMs?: number;
}

/** Default path for the ONNX stem separation model. */
const DEFAULT_MODEL_URL = '/models/stem-separator.onnx';

/** Maximum audio duration in seconds that we'll accept to avoid OOM. */
const MAX_DURATION_SECONDS = 600; // 10 minutes

/** Maximum number of channels supported. */
const MAX_CHANNELS = 2;

/**
 * Separate an audio buffer into 4 stems (vocals, drums, bass, guitar)
 * using a source separation model running in a Web Worker with ONNX Runtime.
 *
 * Processing runs off the main thread for non-blocking inference.
 * Supports cancellation via AbortSignal and enforces resource bounds.
 *
 * @param audioBuffer - The audio buffer to separate
 * @param onProgress - Optional callback reporting progress 0-100
 * @param options - Optional configuration (model URL, signal, timeout)
 * @returns Array of 4 StemResult objects
 */
export async function separateStems(
  audioBuffer: AudioBuffer,
  onProgress?: (progress: number) => void,
  options?: SeparationOptions,
): Promise<StemResult[]> {
  const modelUrl = options?.modelUrl ?? DEFAULT_MODEL_URL;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? 300_000; // 5 min default

  // ── Pre-flight validation ──
  if (signal?.aborted) {
    throw new Error('Separation aborted before starting.');
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('Audio buffer is empty or invalid.');
  }

  if (audioBuffer.numberOfChannels > MAX_CHANNELS) {
    throw new Error(
      `Too many channels (${audioBuffer.numberOfChannels}). Maximum supported: ${MAX_CHANNELS}.`,
    );
  }

  if (audioBuffer.duration > MAX_DURATION_SECONDS) {
    throw new Error(
      `Audio is too long (${Math.round(audioBuffer.duration)}s). Maximum: ${MAX_DURATION_SECONDS}s.`,
    );
  }

  if (audioBuffer.sampleRate <= 0 || !Number.isFinite(audioBuffer.sampleRate)) {
    throw new Error(`Invalid sample rate: ${audioBuffer.sampleRate}.`);
  }

  onProgress?.(0);

  // Extract channel data from AudioBuffer
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch));
  }

  // Spawn Web Worker for non-blocking processing
  const worker = new Worker(
    new URL('./stemSeparation.worker.ts', import.meta.url),
    { type: 'module' },
  );

  try {
    const results = await new Promise<StemResult[]>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        worker.terminate();
        reject(new Error('Separation cancelled.'));
      };

      // Wire up abort signal
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Wire up timeout
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          worker.terminate();
          reject(new Error(`Separation timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }

      worker.onmessage = (event: MessageEvent) => {
        if (settled) return;
        const msg = event.data;

        switch (msg.type) {
          case 'progress':
            onProgress?.(msg.progress);
            break;

          case 'result': {
            cleanup();
            const stems: StemResult[] = [];

            try {
              for (const stem of msg.stems as Array<{
                name: string;
                label: string;
                channelData: Float32Array[];
              }>) {
                const blob = encodeWavBlob(stem.channelData, audioBuffer.sampleRate);
                const url = URL.createObjectURL(blob);
                stems.push({ name: stem.name, label: stem.label, blob, url });
              }
            } catch (buildError) {
              stems.forEach((created) => URL.revokeObjectURL(created.url));
              reject(
                buildError instanceof Error
                  ? buildError
                  : new Error('Failed to build stem results'),
              );
              break;
            }

            resolve(stems);
            break;
          }

          case 'error':
            cleanup();
            reject(new Error(msg.message ?? 'Unknown worker error'));
            break;
        }
      };

      worker.onerror = (err) => {
        if (settled) return;
        cleanup();
        reject(new Error(`Worker crashed: ${err.message || 'unknown error'}`));
      };

      // Send audio data to worker (transfer buffers for zero-copy)
      const transferable = channelData.map((ch) => ch.buffer);
      worker.postMessage(
        { type: 'separate', channelData, sampleRate: audioBuffer.sampleRate, modelUrl },
        transferable as unknown as Transferable[],
      );
    });

    return results;
  } finally {
    worker.terminate();
  }
}
