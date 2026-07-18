import { encodeWavBlob } from './stemSeparationUtils';

export interface StemResult {
  name: string;
  label: string;
  blob: Blob;
  url: string;
}

export interface SeparationOptions {
  /**
   * URL to the ONNX separation model.
   * Defaults to a bundled lightweight Demucs-style model served from /models/.
   */
  modelUrl?: string;
}

/** Default path for the ONNX stem separation model. */
const DEFAULT_MODEL_URL = '/models/stem-separator.onnx';

/**
 * Separate an audio buffer into 4 stems (vocals, drums, bass, guitar)
 * using an ML-based source separation model running in a Web Worker.
 *
 * Designed for Korean guitar cover creators who need to remove guitar
 * from an original track to play their own guitar over the backing.
 *
 * The processing runs off the main thread via a Web Worker with ONNX Runtime
 * for non-blocking inference.
 *
 * @param audioBuffer - The audio buffer to separate
 * @param onProgress - Optional callback reporting progress 0-100
 * @param options - Optional configuration (model URL, etc.)
 * @returns Array of 4 StemResult objects
 */
export async function separateStems(
  audioBuffer: AudioBuffer,
  onProgress?: (progress: number) => void,
  options?: SeparationOptions,
): Promise<StemResult[]> {
  const modelUrl = options?.modelUrl ?? DEFAULT_MODEL_URL;

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
      worker.onmessage = (event: MessageEvent) => {
        const msg = event.data;

        switch (msg.type) {
          case 'progress':
            onProgress?.(msg.progress);
            break;

          case 'result': {
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
              // A failure partway through must not orphan the URLs already created.
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
            reject(new Error(msg.message));
            break;
        }
      };

      worker.onerror = (err) => {
        reject(new Error(`Worker error: ${err.message}`));
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
