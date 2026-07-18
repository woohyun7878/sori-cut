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
}

const DEFAULT_MODEL_URL = '/models/stem-separator.onnx';

/**
 * Separate an audio buffer into 4 stems (vocals, drums, bass, guitar)
 * using ML-based source separation in a Web Worker with ONNX Runtime.
 *
 * Designed for guitar cover creators who need to remove guitar from
 * an original track to play their own guitar over the backing.
 *
 * Processing runs off the main thread via a Web Worker for non-blocking
 * inference. Falls back to spectral heuristic if the ONNX model is unavailable.
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
            const stems: StemResult[] = msg.stems.map(
              (stem: { name: string; label: string; channelData: Float32Array[] }) => {
                const blob = encodeWavBlob(stem.channelData, audioBuffer.sampleRate);
                const url = URL.createObjectURL(blob);
                return { name: stem.name, label: stem.label, blob, url };
              },
            );
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

      // Transfer audio buffers for zero-copy
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
